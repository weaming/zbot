/**
 * 会话重放：从事件日志重放重建 Session 状态（快照 + 增量）。
 * 未闭合或失败回合可从流式检查点恢复尚未定稿的助手消息。
 * 事件是事实源，状态是其投影——重放路径与增量路径产出同一状态。
 */

import fs from "fs";
import path from "path";
import { getSessionsDir, getStartupToolCwd, getToolCwd } from "../utils/runtime-paths.js";
import { createUlid } from "../utils/ulid.js";
import { appendCompletedTurn, appendInterruptedTurn, appendStandaloneTurn, replaceWithCompactedContext } from "../utils/conversation-history.js";
import { repairEmptyAssistantHistory } from "../utils/conversation-history-repair.js";
import type { ChatMessage, Session, SessionOrigin } from "../types/session.js";
import type { AgentEvent, AgentEventPayloads } from "./agent-events.js";
import type { UsageInfo } from "../types/chat.js";
import type { UserMessageInput } from "../types/image.js";
import { StreamRecovery } from "../utils/stream-recovery.js";
import { type EventLog } from "./event-log.js";
import { sanitizeSessionId } from "../utils/session-id.js";

/** 每 N 个事件写一次快照，避免日志无限增长时全量重放。 */
const SNAPSHOT_INTERVAL = 100;

/** 快照头读取窗口（写前判断 lastSeq 用）：JSON 前 256 字节足以覆盖 lastSeq 字段。 */
const SNAPSHOT_HEAD_BYTES = 256;

/** snapshotSeq 内存缓存的会话上限，避免长驻进程无界增长。 */
const SNAPSHOT_STATE_MAX_ENTRIES = 512;

/**
 * 只有回合闭合的事件才允许落快照：turn 进行中（user_message 已落盘、turn_commit 未落盘）
 * 写快照，会让该用户消息永远落在快照边界之前，重放时被排除、上下文丢失。
 */
const SNAPSHOT_SAFE_EVENT_TYPES = new Set<AgentEvent["type"]>([
    "session_created",
    "turn_commit",
    "assistant_history_repaired",
    "standalone_turn",
    // 会话间消息不参与 Session 投影，落在快照边界上也不会丢上下文。
    "peer_message",
    "peer_result",
    "session_renamed",
    // cwd 变更只是元信息，落在快照边界上也不会丢上下文。
    "session_cwd_changed",
    "session_archived",
    "session_unarchived",
    // /clear 只留一条事实，不改变 Session 投影，落在快照边界上安全
    "session_cleared",
    // lazy MCP 启用集只是下发口径，落在快照边界上也不会丢上下文。
    "lazy_mcp_changed",
]);

interface EventSnapshot {
    lastSeq: number;
    ts: string;
    session: Session;
}

/** 未闭合回合的增量现场：用户消息 + 已定稿消息。 */
interface PendingTurn {
    userMessages: UserMessageInput[];
    messages: ChatMessage[];
    stream: StreamRecovery;
}

export interface ReplayResult {
    session: Session;
    lastSeq: number;
}

export class SessionReplay {
    /** 已落盘快照的 seq：避免每次判断都读快照文件。 */
    private readonly snapshotSeq = new Map<string, number>();

    private rememberSnapshotSeq(sessionId: string, seq: number): void {
        if (!this.snapshotSeq.has(sessionId) && this.snapshotSeq.size >= SNAPSHOT_STATE_MAX_ENTRIES) {
            const oldest = this.snapshotSeq.keys().next().value;
            if (oldest !== undefined) this.snapshotSeq.delete(oldest);
        }
        this.snapshotSeq.set(sessionId, seq);
    }

    constructor(private readonly eventLog: EventLog) {}

    private snapshotFilePath(sessionId: string): string {
        return path.join(getSessionsDir("events"), `${sanitizeSessionId(sessionId)}.snapshot.json`);
    }

    /**
     * 重放到目标 seq（缺省最新）。返回重建的 Session 与最后 seq。
     * 快照未覆盖的部分（或 upToSeq 早于快照）从日志全量/增量重放。
     */
    async replayTo(sessionId: string, upToSeq?: number): Promise<ReplayResult> {
        const snapshot = await this.readSnapshot(sessionId);
        const snapshotUsable =
            snapshot !== null && (upToSeq === undefined || upToSeq >= snapshot.lastSeq);
        if (snapshotUsable && snapshot) this.rememberSnapshotSeq(sessionId, snapshot.lastSeq);

        const fromSeq = snapshotUsable ? snapshot.lastSeq + 1 : 1;
        const events = await this.eventLog.read(sessionId, fromSeq, undefined);
        const targetEvents = upToSeq !== undefined
            ? events.filter(event => event.seq <= upToSeq)
            : events;

        const session = snapshotUsable && snapshot
            ? { ...pickSessionFields(snapshot.session), cwd: snapshot.session.cwd ?? getStartupToolCwd() }
            : createEmptySession(sessionId);

        // turn_message 让回合进行中的完整消息即时落盘；重放时按 turnId 归组，
        // turn_commit 出现则取该回合已落盘消息作为终态；所有未闭合回合都保留。
        const pendingTurns = new Map<string, PendingTurn>();
        for (const event of targetEvents) {
            if (event.type === "user_message") {
                const { text, images, turnId, trigger } = event.payload;
                getPendingTurn(pendingTurns, turnId).userMessages.push({ text, images, trigger });
                continue;
            }
            if (event.type === "turn_message") {
                const pending = getPendingTurn(pendingTurns, event.payload.turnId);
                pending.messages.push(event.payload.message);
                if (event.payload.message.role === "assistant") pending.stream.clear();
                continue;
            }
            if (event.type === "turn_stream_delta") {
                const { turnId, requestIndex, delta } = event.payload;
                getPendingTurn(pendingTurns, turnId).stream.push(requestIndex, delta);
                continue;
            }
            if (event.type === "turn_commit") {
                const key = event.payload.turnId;
                // 更早的未闭合回合也完整物化，避免异常中断后的工具与文本现场丢失。
                for (const [pendingKey, pending] of pendingTurns) {
                    if (pendingKey === key) continue;
                    const messages = pendingMessages(pending);
                    if (pending.userMessages.length > 0 || messages.length > 0) {
                        appendInterruptedTurn(session, pending.userMessages, messages, "interrupted");
                    }
                }
                const pending = pendingTurns.get(key);
                const messages = pending ? pendingMessages(pending) : [];
                const pendingUserMessages = pending?.userMessages;
                pendingTurns.clear();
                applyCommit(session, event, messages, pendingUserMessages);
                continue;
            }
            if (event.type === "context_compacted" && event.payload.scope === "turn") {
                // 回合内压缩：摘要已取代本回合此前产生的全部消息，
                // 这些 turn_message 不能再物化，否则重启后上下文回到压缩前
                applyEvent(session, event);
                const pending = pendingTurns.get(event.payload.turnId ?? "");
                if (pending) {
                    pending.messages.length = 0;
                    pending.stream.clear();
                }
                continue;
            }
            applyEvent(session, event);
        }
        materializePendingTurns(session, pendingTurns);

        const lastSeq = targetEvents.length > 0
            ? targetEvents[targetEvents.length - 1].seq
            : (snapshotUsable && snapshot ? snapshot.lastSeq : 0);
        return { session, lastSeq };
    }

    /**
     * 追加领域事件并维护快照：首事件自动补 session_created，
     * turn_commit 的用户消息先落 user_message。
     * writeUserMessages=false 时跳过 user_message（调用方已在请求前落盘，避免重复）。
     */
    async appendAgentEvent(
        session: Session,
        type: 'turn_commit' | 'context_compacted' | 'standalone_turn' | 'usage_recorded',
        payload: AgentEventPayloads[typeof type],
        writeUserMessages = true,
    ): Promise<void> {
        if ((await this.eventLog.lastSeq(session.sessionId)) === 0) {
            await this.eventLog.append(session.sessionId, "session_created", {
                cwd: session.cwd,
                ...(session.origin ? { origin: session.origin } : {}),
            });
        }
        if (writeUserMessages) {
            const { userMessages = [], turnId } = payload as { userMessages?: Array<string | UserMessageInput>; turnId: string };
            for (const input of userMessages) {
                const message = typeof input === "string" ? { text: input } : input;
                await this.eventLog.append(session.sessionId, "user_message", {
                    text: message.text,
                    ...(message.images?.length ? { images: message.images } : {}),
                    turnId,
                    trigger: message.trigger ?? "user",
                });
            }
        }
        await this.eventLog.append(session.sessionId, type, payload as any);
        if (type === "turn_commit" || type === "usage_recorded") {
            rememberPromptTokens(session, (payload as { usage?: UsageInfo }).usage);
        }
        await this.writeSnapshotIfDue(session.sessionId, session);
    }

    /**
     * 距上次快照超过 SNAPSHOT_INTERVAL 个事件、且日志尾巴是「快照安全事件」时落盘当前状态。
     *
     * 判据用「距上次快照的增量」而不是「seq 是否整除间隔」：整除只有在事件数恰好命中时
     * 才成立，长回合会产生大量 turn_message，长会话往往一直落在非整除位置，导致永远没有快照、
     * 每次重放都从日志开头扫起。
     */
    async writeSnapshotIfDue(sessionId: string, session: Session): Promise<void> {
        const lastSeq = await this.eventLog.lastSeq(sessionId);
        if (lastSeq === 0) return;
        if (lastSeq - (await this.lastSnapshotSeq(sessionId)) < SNAPSHOT_INTERVAL) return;
        const tail = await this.eventLog.read(sessionId, lastSeq, 1);
        // 读不到尾巴（半行/并发截断）时不能当成安全边界：否则会在回合中途落快照，
        // 让本回合的用户消息落在边界之前、重放时丢失
        if (!tail[0] || !SNAPSHOT_SAFE_EVENT_TYPES.has(tail[0].type)) return;

        const snapshot: EventSnapshot = {
            lastSeq,
            ts: new Date().toISOString(),
            session: pickSessionFields(session),
        };
        const filePath = this.snapshotFilePath(sessionId);
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        const tempPath = `${filePath}.${process.pid}.${createUlid()}.tmp`;
        try {
            await fs.promises.writeFile(tempPath, JSON.stringify(snapshot, null, 2), "utf8");
            await fs.promises.rename(tempPath, filePath);
            this.rememberSnapshotSeq(sessionId, lastSeq);
        } finally {
            await fs.promises.rm(tempPath, { force: true });
        }
    }

    /** 上次快照覆盖到的 seq（没有快照时为 0）。 */
    private async lastSnapshotSeq(sessionId: string): Promise<number> {
        // 其他实例可能写过更新的快照：以磁盘为准，避免本实例用更旧的状态覆盖它
        const cached = this.snapshotSeq.get(sessionId) ?? 0;
        const seq = Math.max(cached, await this.readSnapshotLastSeq(sessionId));
        this.rememberSnapshotSeq(sessionId, seq);
        return seq;
    }

    /** 只读快照文件头取 lastSeq：写快照前判断用，不必解析整个快照。 */
    private async readSnapshotLastSeq(sessionId: string): Promise<number> {
        let handle: fs.promises.FileHandle;
        try {
            handle = await fs.promises.open(this.snapshotFilePath(sessionId), "r");
        } catch (error: any) {
            if (error?.code === "ENOENT") return 0;
            throw error;
        }
        try {
            const buffer = Buffer.allocUnsafe(SNAPSHOT_HEAD_BYTES);
            const { bytesRead } = await handle.read(buffer, 0, SNAPSHOT_HEAD_BYTES, 0);
            const match = /"lastSeq"\s*:\s*(\d+)/.exec(buffer.subarray(0, bytesRead).toString("utf8"));
            return match ? Number(match[1]) : 0;
        } finally {
            await handle.close();
        }
    }

    /** 请求前落盘 user_message（首事件自动补 session_created），返回事件 seq。 */
    async appendUserMessage(
        session: Session,
        text: string,
        turnId: string,
        trigger: "user" | "pending" | "peer" = "user",
        images?: UserMessageInput["images"],
    ): Promise<number> {
        if ((await this.eventLog.lastSeq(session.sessionId)) === 0) {
            await this.eventLog.append(session.sessionId, "session_created", { cwd: session.cwd });
        }
        const event = await this.eventLog.append(session.sessionId, "user_message", {
            text,
            ...(images?.length ? { images } : {}),
            turnId,
            trigger,
        });
        return event.seq;
    }

    /** 段边界落盘（turn_segment_start），返回事件 seq。 */
    async appendSegmentStart(sessionId: string, payload: AgentEventPayloads["turn_segment_start"]): Promise<number> {
        const event = await this.eventLog.append(sessionId, "turn_segment_start", payload);
        return event.seq;
    }

    /** 删除会话快照（截断/回滚后快照过期，重放改为全量）。 */
    async deleteSnapshot(sessionId: string): Promise<void> {
        this.snapshotSeq.delete(sessionId);
        try {
            await fs.promises.unlink(this.snapshotFilePath(sessionId));
        } catch (error: any) {
            if (error?.code !== "ENOENT") throw error;
        }
    }

    private async readSnapshot(sessionId: string): Promise<EventSnapshot | null> {
        try {
            const text = await fs.promises.readFile(this.snapshotFilePath(sessionId), "utf8");
            return JSON.parse(text) as EventSnapshot;
        } catch (error: any) {
            if (error?.code === "ENOENT") return null;
            if (error instanceof SyntaxError) {
                console.warn(`[SessionReplay] 忽略损坏快照 (session=${sessionId})`);
                return null;
            }
            throw error;
        }
    }
}

function getPendingTurn(pendingTurns: Map<string, PendingTurn>, turnId: string): PendingTurn {
    let unit = pendingTurns.get(turnId);
    if (!unit) {
        unit = { userMessages: [], messages: [], stream: new StreamRecovery() };
        pendingTurns.set(turnId, unit);
    }
    return unit;
}

/** 依事件出现顺序物化所有未闭合回合。 */
function materializePendingTurns(session: Session, pendingTurns: Map<string, PendingTurn>): void {
    for (const unit of pendingTurns.values()) {
        const messages = pendingMessages(unit);
        if (unit.userMessages.length === 0 && messages.length === 0) continue;
        appendInterruptedTurn(session, unit.userMessages, messages, "interrupted");
    }
    pendingTurns.clear();
}

function pendingMessages(unit: PendingTurn): ChatMessage[] {
    const partial = unit.stream.message();
    return partial ? [...unit.messages, partial] : unit.messages;
}

/** turn_commit 投影：消息取自已落盘的 turn_message（终态不再重复内容）。 */
function applyCommit(
    session: Session,
    event: Extract<AgentEvent, { type: "turn_commit" }>,
    messages: ChatMessage[],
    pendingUserMessages?: UserMessageInput[],
): void {
    const { userMessages: committedUserMessages, interrupted, stopReason, usage } = event.payload;
    const userMessages = pendingUserMessages?.length
        ? pendingUserMessages.filter(input => input.trigger !== "pending" || !messages.some(message =>
            message.role === "user" && getUserMessageText(message) === input.text,
        ))
        : committedUserMessages;
    if (interrupted) {
        appendInterruptedTurn(session, userMessages, messages, "interrupted");
    } else if (stopReason === "error") {
        appendInterruptedTurn(session, userMessages, messages, "failed");
    } else {
        appendCompletedTurn(session, userMessages, messages, true);
    }
    rememberPromptTokens(session, usage);
}

function getUserMessageText(message: ChatMessage): string | undefined {
    if (message.role !== "user") return undefined;
    if (typeof message.content === "string") return message.content;
    return message.content.find(block => block.type === "text")?.text;
}

/**
 * 从 cwd 相关事件里取出目录：session_created 与 session_cwd_changed。
 * 旧事件可能没有 cwd 字段，此时返回 undefined，由调用方统一回退到启动目录。
 */
export function eventCwd(event: AgentEvent): string | undefined {
    if (event.type === "session_created" || event.type === "session_cwd_changed") {
        return event.payload.cwd || undefined;
    }
    return undefined;
}

/** 事件投影：context_compacted / standalone_turn 等驱动状态变化，其余事件仅作展示记录。 */
function applyEvent(session: Session, event: AgentEvent): void {
    switch (event.type) {
        case "session_created":
            if (event.payload.origin) session.origin = event.payload.origin;
            // 事件为事实源；旧事件无 cwd 字段时归一到启动目录（不能继承当前选中会话的 cwd）
            session.cwd = eventCwd(event) ?? getStartupToolCwd();
            break;
        case "session_cwd_changed":
            // 事件为事实源；旧事件无 cwd 字段时归一到启动目录（不能继承当前选中会话的 cwd）
            session.cwd = eventCwd(event) ?? getStartupToolCwd();
            break;
        case "context_compacted":
            const position = event.payload.keepFromPosition;
            const positionedMessageId = position
                ? session.turns[position.turnIndex]?.messages[position.messageIndex]?.id
                : undefined;
            const recordedMessageId = event.payload.keepFromMessageId;
            const existingMessageId = recordedMessageId && session.turns.some(turn =>
                turn.messages.some(message => message.id === recordedMessageId),
            ) ? recordedMessageId : undefined;
            replaceWithCompactedContext(session, event.payload.compactedContext, {
                ...(event.payload.instruction ? { instruction: event.payload.instruction } : {}),
                ...((positionedMessageId ?? existingMessageId)
                    ? { keepFromMessageId: positionedMessageId ?? existingMessageId }
                    : {}),
            });
            break;
        case "standalone_turn":
            appendStandaloneTurn(session, event.payload.messages);
            break;
        case "assistant_history_repaired":
            repairEmptyAssistantHistory(session);
            break;
        case "usage_recorded":
            rememberPromptTokens(session, event.payload.usage);
            break;
        case "session_renamed":
            session.title = event.payload.title;
            break;
        case "model_selected":
            session.modelSelection = event.payload;
            break;
        case "lazy_mcp_changed":
            session.lazyMcpServers = [...event.payload.servers];
            break;
        default:
            break;
    }
}

/** 记录最近一次 provider 输入 token，供下一次自动压缩使用。 */
function rememberPromptTokens(session: Session, usage?: UsageInfo): void {
    const promptTokens = usage?.latestPromptTokens ?? usage?.promptTokens;
    if (promptTokens && promptTokens > 0) {
        session.lastPromptTokens = promptTokens;
    }
}

/** 新会话工厂：cwd 默认当前工具目录。 */
export function createEmptySession(sessionId: string, cwd = getToolCwd(), origin?: SessionOrigin): Session {
    const timestamp = new Date().toISOString();
    return {
        sessionId,
        ...(origin ? { origin } : {}),
        cwd,
        contextEpochId: createUlid(),
        turns: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        contextState: {
            startedAt: timestamp,
            reason: "session_start",
            sourceUserTurnCount: 0,
            retainedUserTurnCount: 0,
        },
        totalUserTurnCount: 0,
        hardTrimCount: 0,
        compactCount: 0,
    };
}

/**
 * 快照字段白名单：只有会话事实可以落盘。
 * system prompt 与工具定义都只在请求期构造，既不缓存也不写快照，
 * 重启后必定按当前技能/记忆/MCP 状态重建；旧版本快照里的缓存字段在读入时被丢弃。
 */
const SNAPSHOT_SESSION_FIELDS = [
    "sessionId",
    "cwd",
    "title",
    "contextEpochId",
    "turns",
    "compactedContext",
    "compactedThroughTurnId",
    "compactedKeepFromMessageId",
    "contextState",
    "totalUserTurnCount",
    "hardTrimCount",
    "compactCount",
    "lastPromptTokens",
    "createdAt",
    "updatedAt",
    "archivedAt",
    "modelSelection",
    "lazyMcpServers",
] as const;

/** 读写快照共用的字段投影：未列入白名单的键一律不落盘、也不恢复。 */
function pickSessionFields(source: Session | Record<string, unknown>): Session {
    const projected: Record<string, unknown> = {};
    for (const field of SNAPSHOT_SESSION_FIELDS) {
        const value = (source as Record<string, unknown>)[field];
        if (value !== undefined) projected[field] = value;
    }
    return projected as unknown as Session;
}
