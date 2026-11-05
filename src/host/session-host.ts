/**
 * 会话宿主（进程内实现）：管理会话、调用工具并转发事件。
 *
 * 与前端无关：不 import tui/ 或 server/，前端只经 SessionHost 契约与事件回调接入。
 *
 * 拆分后的职责：
 * - session-host-types.ts 公共接口（SessionHost / SessionSummary / InstanceNetworkStats）与内部数据结构
 * - summary.ts            会话摘要与实例用量聚合（纯函数）
 * - turn.ts               turn 执行与上下文压缩（宿主能力经 TurnHost 注入）
 *
 * 本文件只负责：会话容器与生命周期、锁与并发保护、对外门面。
 */

import path from "node:path";
import { buildSystemPrompt, closeChatSessionTransport, deleteResponsesBaseline, steerChatSession } from "../services/chat-runtime.js";
import { createEmptySession, eventCwd, SessionReplay } from "../events/session-replay.js";
import { isEmptySession } from "../events/session-emptiness.js";
import { EventLog } from "../events/event-log.js";
import { removeSessionArtifacts } from "../events/session-cleanup.js";
import { listSavedSessionIds } from "../events/session-files.js";
import { appendInputHistory, loadInputHistory } from "./input-history.js";
import { getStartupToolCwd } from "../utils/runtime-paths.js";
import { planResume } from "../services/resume-plan.js";
import { clearMcpSelection, updateMcpSelection } from "../tools/session-mcp-selection.js";
import {
    describeClaimFailure,
    formatInboundPrompt,
    MAX_SPAWNED_SESSIONS,
    SessionControl,
    type ClaimResult,
    type SessionControlHost,
} from "../control/channel.js";
import { registerSessionRuntime, type PeerResultRecord } from "../control/runtime.js";
import type { PeerAcceptOutcome, PeerMessage, PeerResult } from "../control/protocol.js";
import type { PeerOwnership } from "../control/registry.js";
import { sortSessions } from "../utils/session-order.js";
import { createUlid } from "../utils/ulid.js";
import { getShanghaiISOString } from "../utils/time.js";
import { acquireSessionLock, isSessionLockedByOtherSync, type SessionLockHandle } from "../utils/session-lock.js";
import { mergeUsage, type UIEvent } from "../events/ui-events.js";
import type { UsageInfo } from "../types/chat.js";
import type { AgentEvent, AgentEventPayloads } from "../events/agent-events.js";
import { MAX_SESSION_TITLE_LENGTH, type Session } from "../types/session.js";
import type { ChatModelSelection } from "../types/chat-model.js";
import { aggregateInstanceUsage, SessionDigestReader } from "./summary.js";
import { compactSessionContext, runSessionTurn, type TurnHost } from "./turn.js";
import { PeerInbox, type PeerDropReason } from "./peer-inbox.js";
import {
    executePeerCommand,
    isPeerCommandAllowedOnArchived,
    type PeerCommandHost,
    type PeerDeferredAction,
} from "./peer-command.js";
import type {
    ActiveSession,
    InstanceNetworkStats,
    SessionReleaseCause,
    SessionHost,
    SessionHostOptions,
    SessionCreateInit,
    SessionSummary,
    TurnSpec,
    TurnUserMessage,
} from "./session-host-types.js";
import {
    SessionArchivedError,
    SessionBusyError,
    SessionNotFoundError,
} from "./session-host-types.js";
import { toUserContent, type UserMessageInput } from "../types/image.js";
import { buildReviewPrompt, parseSlashCommand, type SlashCommandParse } from "../commands/slash-command.js";
import { backgroundTaskManager } from "../tools/background-tasks.js";
import { deleteSessionImageAssets } from "../utils/image-assets.js";

export type { InstanceNetworkStats, SessionHost, SessionSummary } from "./session-host-types.js";
export { summarizeEvents } from "./summary.js";

/** 退出时等待进行中的 turn 落盘的上限，超时后放弃等待直接退出。 */
const CLOSE_FLUSH_TIMEOUT_MS = 3_000;
/** 取消会话后等待模型/工具回合完成中止收尾的上限。 */
const CANCEL_TURN_TIMEOUT_MS = 30_000;
/** 回查会话间结果时扫描的日志尾部窗口：结果事件稀疏，多读一点免得漏。 */
const PEER_RESULT_SCAN_EVENTS = 2_000;
/** 初始化 TUI 所需的技能和 MCP 连接。 */
export async function initializeSessionHostRuntime(
    options: { watchSkills?: boolean } = {},
): Promise<void> {
    const { skillRegistry } = await import("../skills/skill-registry.js");
    await skillRegistry.init({ watch: options.watchSkills !== false });

    const { initMcpClients } = await import("../mcp/client-manager.js");
    await initMcpClients({ mode: "tui" });
}

interface RuntimeReloadResult {
    skillCount: number;
    mcpServerCount: number;
    mcpToolCount: number;
}

export class LocalSessionHost implements SessionHost {
    // TUI 会话数据直接使用 sessions/ 根目录。
    private readonly eventLog = new EventLog();
    private readonly replay = new SessionReplay(this.eventLog);
    /** 会话摘要缓存：列表页与 peer 查询避免逐份全量解析事件日志。 */
    private readonly digests = new SessionDigestReader(this.eventLog);
    private readonly activeSessions = new Map<string, ActiveSession>();
    private readonly pendingModelSelections = new Map<string, ChatModelSelection>();
    private readonly sessionOperations = new Set<string>();
    /** 正在做「空会话」删除的会话：读盘判空期间也要让 release/新投递看到「忙」。 */
    private readonly deletingSessions = new Set<string>();
    /** 本进程内各会话真实网络请求的用量聚合（退出时展示）。 */
    private readonly instanceUsage = new Map<string, UsageInfo>();
    /** 进行中的 turn（sendMessage 全流程），退出时用于等待中断落盘。 */
    private readonly inflightTurns = new Set<Promise<unknown>>();
    /** 按会话索引的 turn，用于取消后等待收尾与释放锁。 */
    private readonly turnsBySession = new Map<string, Set<Promise<unknown>>>();
    /** 正在取消的会话：阻止回合收尾回调立即再启动新 turn。 */
    private readonly cancellingSessions = new Set<string>();
    /** 已进入退出流程：不再接受新的驱动回合（结果留在队列里即可）。 */
    private isClosing = false;
    /**
     * 入站投递状态机：排队（FIFO/有界）、msgId 幂等、过期与终态结果缓存都在里面。
     * 这里只按它的决策做副作用（落盘、回传、抢互斥、跑回合）。
     */
    private readonly peerInbox = new PeerInbox();
    /** 运行时能力注册的注销函数：close() 时按身份注销，避免留下指向已退出宿主的引用。 */
    private readonly unregisterRuntime: () => void;
    private nextRequestId = 1;
    /**
     * 宿主启动目录：新建会话（未显式给 cwd）时的默认基准。
     * 由调用方注入，宿主不读 TUI 的全局启动态。
     */
    private readonly startupCwd: string;
    /** turn 执行器所需的宿主能力，随实例生命周期固定。 */
    private readonly turnHost: TurnHost = {
        eventLog: this.eventLog,
        replay: this.replay,
        activeSessions: this.activeSessions,
        allocateRequestId: () => this.nextRequestId++,
        notify: (requestId, sessionId, event) => this.notify(requestId, sessionId, event),
        requireActiveSession: sessionId => this.requireActiveSession(sessionId),
        updateActiveSeq: (sessionId, seq) => this.updateActiveSeq(sessionId, seq),
        accumulateInstanceUsage: (sessionId, usage) => this.accumulateInstanceUsage(sessionId, usage),
        finishAndPersist: session => this.finishAndPersist(session),
        persistPendingModelSelection: (sessionId, session) => this.persistPendingModelSelection(sessionId, session),
        releaseSessionLockSafely: lock => this.releaseSessionLockSafely(lock),
        beginSessionOperation: sessionId => this.beginSessionOperation(sessionId),
        endSessionOperation: sessionId => this.endSessionOperation(sessionId),
    };

    onEvent?: (requestId: number, sessionId: string, event: UIEvent) => void;
    /** 回合结束回调：宿主据此放行排队的用户输入（见 SessionHost.onTurnFinished）。 */
    onTurnFinished?: (sessionId: string) => void;
    /** 会话持有被释放（/close 主动关闭 / 被其他实例拿走）时的回调（见 SessionHost.onSessionReleased）。 */
    onSessionReleased?: (sessionId: string, cause: SessionReleaseCause) => void;
    /** 模型派生新子会话时的回调（见 SessionHost.onSessionSpawned）。 */
    onSessionSpawned?: (sessionId: string, title?: string) => void;
    /** 会话工作目录被改写（cwd 工具 / /cwd）时回调宿主：状态栏与工具基准要跟着换。 */
    onSessionCwdChanged?: (sessionId: string, cwd: string) => void;
    /** 已归档会话恢复并被本实例认领后回调宿主。 */
    onSessionWoken?: (sessionId: string) => void;

    /**
     * 会话间控制通道：归属（本进程 bind socket）、消息投递、结果回传。
     * 归属完全由 socket 文件表达，没有租约、心跳与 sidecar 元数据。
     */
    private readonly control: SessionControl;

    constructor(
        private readonly runtimeReady: Promise<void> = Promise.resolve(),
        options: SessionHostOptions = {},
    ) {
        this.startupCwd = options.startupCwd ?? process.cwd();
        const host: SessionControlHost = {
            title: (sessionId) => this.activeSessions.get(sessionId)?.session.title,
            isBusy: (sessionId) => this.isSessionBusy(sessionId),
            createSession: (cwd, init) => this.createSession(cwd, init),
            sessionCwd: (sessionId) => this.getSessionCwd(sessionId),
            onSessionSpawned: (sessionId, title) => this.onSessionSpawned?.(sessionId, title),
            archiveSpawnedSession: async (sessionId, automatic) => {
                await this.closeSession(sessionId);
                this.releaseSession(sessionId, { cause: automatic ? "auto" : "tool" });
            },
            cancelSpawnedSession: (sessionId, close) => this.cancelSpawnedSession(sessionId, close),
            accept: (message) => this.acceptPeerMessage(message),
            cancelQueued: (sessionId, msgId) => this.cancelQueuedPeerMessage(sessionId, msgId),
            queueState: (sessionId) => this.peerInbox.snapshot(sessionId),
            onOutbound: (from, message) => {
                void this.recordPeerMessage(from, message, "out").catch((error) => {
                    console.error("⚠️ [host] 会话间消息落盘失败:", error);
                });
            },
            onResult: (requester, message, result, resultOptions) => {
                void this.recordPeerResult(requester, {
                    msgId: message.id,
                    peerId: message.to,
                    ok: result.ok,
                    ...(resultOptions?.late ? { late: true } : {}),
                    text: result.text,
                    stopReason: result.stopReason,
                    createdAt: getShanghaiISOString(),
                })
                    .catch((error) => {
                        console.error("⚠️ [host] 会话间结果落盘失败:", error);
                    })
                    // 结果落盘后再继续一轮，避免新回合的 user 消息插到结果卡之前
                    .finally(() => this.driveQueuedResults(requester));
            },
            onLost: (requester, msgIds, target) => this.notifyPeerLost(requester, msgIds, target),
            onReleased: (sessionId) => this.unloadSession(sessionId),
        };
        this.control = new SessionControl(host);
        // 会话运行时能力按实例注册：引擎按 sessionId 解析到这一个是它负责的会话，
        // 多宿主同进程时不互相覆盖；close() 时按身份注销。必须在任何请求前就位。
        this.unregisterRuntime = registerSessionRuntime({
            // 会话间工具由"正在跑回合的宿主"处理：活跃会话与已认领会话都算自己的
            ownsSession: sessionId => this.activeSessions.has(sessionId) || this.control.isClaimed(sessionId),
            control: this.control,
            setSessionCwd: (sessionId, cwd) => this.setSessionCwd(sessionId, cwd),
            directory: {
                list: async (options = {}) => {
                    const sessions = await this.listSessions();
                    return sessions
                        .filter(session => options?.includeArchived || !session.archived)
                        .map(session => ({
                            sessionId: session.sessionId,
                            ...(session.title ? { title: session.title } : {}),
                            ...(session.archived ? { archived: true } : {}),
                        }));
                },
                wake: sessionId => this.wakeArchivedSession(sessionId),
            },
            recentPeerResults: (sessionId, limit) => this.recentPeerResults(sessionId, limit),
        });
    }

    // ── 会话间消息 ──────────────────────────────────────────────

    /** 落盘一条会话间消息（时间线事实源；出入站各一条）。 */
    async appendPeerMessage(sessionId: string, payload: AgentEventPayloads["peer_message"]): Promise<void> {
        await this.appendAgentEvent(sessionId, "peer_message", payload);
    }

    /** 落盘一条会话间结果（时间线事实源）。 */
    async appendPeerResult(sessionId: string, payload: AgentEventPayloads["peer_result"]): Promise<void> {
        await this.appendAgentEvent(sessionId, "peer_result", payload);
    }

    /** 时间线事实源事件的统一落盘入口：首事件自动补 session_created。 */
    private async appendAgentEvent<T extends "peer_message" | "peer_result">(
        sessionId: string,
        type: T,
        payload: AgentEventPayloads[T],
    ): Promise<void> {
        if ((await this.eventLog.lastSeq(sessionId)) === 0) {
            const cwd = this.activeSessions.get(sessionId)?.session.cwd ?? this.startupCwd;
            const created = await this.eventLog.append(sessionId, "session_created", { cwd });
            this.updateActiveSeq(sessionId, created.seq);
        }
        const event = await this.eventLog.append(sessionId, type, payload);
        this.updateActiveSeq(sessionId, event.seq);
    }

    /** 进程级通道：工具（session_send / session_status）与 UI 共用。 */
    get sessionControl(): SessionControl {
        return this.control;
    }

    async claimSession(sessionId: string, options: { noNegotiate?: boolean } = {}): Promise<ClaimResult> {
        return this.control.claim(sessionId, options);
    }

    /** 唤醒已归档会话并由当前实例认领，以便后续 session_send 继续工作。 */
    private async wakeArchivedSession(sessionId: string): Promise<void> {
        const digest = await this.digests.read(sessionId);
        if (!digest) throw new Error(`会话不存在：${sessionId}`);
        const summary = digest.summary;
        if (!summary.archived) throw new Error("目标会话未归档；直接使用 session_send 即可");
        if (this.isSessionBusy(sessionId)) throw new Error("目标会话正在执行，暂不能唤醒");
        if (!this.control.beginSessionWake(sessionId)) throw new Error("目标会话正在切换状态，请稍后重试");

        const wasClaimed = this.control.isClaimed(sessionId);
        const wasManaged = this.control.isSpawnedSession(sessionId);
        let didClaim = false;
        let didAdopt = false;
        try {
            const claim = await this.claimSession(sessionId);
            if (!claim.ok) throw new Error(describeClaimFailure(claim));
            didClaim = !wasClaimed;
            if (!this.control.adoptSpawnedSession(sessionId)) {
                throw new Error(`本实例管理的子会话已达上限（${MAX_SPAWNED_SESSIONS} 个）`);
            }
            didAdopt = !wasManaged;

            await this.unarchiveSession(sessionId);
            this.onSessionWoken?.(sessionId);
        } catch (error) {
            if (didAdopt) this.control.forgetSpawnedSession(sessionId);
            if (didClaim) this.releaseSession(sessionId, { cause: "tool" });
            throw error;
        } finally {
            this.control.endSessionWake(sessionId);
        }
    }

    releaseSession(sessionId: string, options: { cause?: SessionReleaseCause } = {}): void {
        this.dropAllQueuedPeerMessages(sessionId);
        this.peerInbox.forgetResults(sessionId);
        this.control.release(sessionId);
        this.unloadSession(sessionId, options.cause ?? "peer");
    }

    isSessionClaimed(sessionId: string): boolean {
        return this.control.isClaimed(sessionId);
    }

    claimedSessionIds(): string[] {
        return this.control.claimedSessionIds;
    }

    probeSession(sessionId: string): Promise<PeerOwnership> {
        return this.control.probe(sessionId);
    }

    listSessionOwnership(sessionIds: string[]): Promise<Map<string, PeerOwnership>> {
        return this.control.listOwnership(sessionIds);
    }

    takePeerResults(sessionId: string): string[] {
        return this.control.takeResults(sessionId);
    }

    /** 本实例在该会话上的待交付计数：等待别人回传 + 已就绪待附加。 */
    peerPendingStats(sessionId: string): { awaiting: number; queued: number } {
        return {
            awaiting: this.control.awaitingResults(sessionId),
            queued: this.control.queuedResults(sessionId),
        };
    }

    /** ⌃B：把本会话正在前台等待的会话间结果放入后台，结果到达后自动继续。 */
    detachPeerWaits(sessionId: string): number {
        return this.control.detachWaits(sessionId);
    }

    /**
     * 受理一条入站消息：先原子占住会话互斥，抢不到时按 queueIfBusy 入队或回 busy。
     * 排队消息在回合结束后由 drainPeerQueue 依次执行；msgId 幂等，重复投递不会重复执行。
     */
    private async acceptPeerMessage(message: PeerMessage): Promise<PeerAcceptOutcome> {
        const sessionId = message.to;
        const decision = this.peerInbox.begin(message);
        if (decision.kind === "queued") return { status: "queued", position: decision.position };
        if (decision.kind === "accepted") return { status: "accepted" };
        if (decision.kind === "replay") {
            // 客户端重试用同一 msgId：把上次结果重推一份，不重复执行
            try {
                this.control.completeInbound(sessionId, message, decision.result);
            } catch (error) {
                console.error("⚠️ [host] 重推已完成消息结果失败:", error);
            }
            return { status: "accepted" };
        }

        try {
            this.beginSessionOperation(sessionId);
        } catch {
            if (message.queueIfBusy !== true) {
                this.peerInbox.rollback(message);
                return { status: "busy" };
            }
            return this.enqueuePeerMessage(sessionId, message);
        }

        try {
            // 归档会话不写时间线：往 session_archived 之后追加任何事件都会把它悄悄"解除归档"。
            // 能不能执行由 runPeerTurn 按命令矩阵判定（只读/生命周期命令放行，其余回明确失败）。
            if (!await this.isSessionArchived(sessionId)) {
                // 先确保会话已进内存（标题、cwd 与后续回合都依赖它），再落盘时间线
                await this.requireActiveSession(sessionId);
                await this.recordPeerMessage(sessionId, message, "in");
            }
        } catch (error) {
            this.peerInbox.rollback(message);
            this.endSessionOperation(sessionId);
            throw error;
        }

        this.trackTurn(sessionId, this.runPeerTurn(sessionId, message));
        return { status: "accepted" };
    }

    /** 忙时入队：先同步入队（占住位次），再落盘；落盘失败回滚，避免并发投递互相覆盖。 */
    private async enqueuePeerMessage(sessionId: string, message: PeerMessage): Promise<PeerAcceptOutcome> {
        const enqueued = this.peerInbox.enqueue(message, getShanghaiISOString());
        if (enqueued === "full") return { status: "full" };

        try {
            await this.requireActiveSession(sessionId);
            await this.recordPeerMessage(sessionId, message, "in", {
                queued: true,
                ...(message.expiresAt ? { expiresAt: message.expiresAt } : {}),
            });
        } catch (error) {
            this.peerInbox.rollback(message);
            throw error;
        }

        return { status: "queued", position: enqueued.position };
    }

    /** 回合结束后尝试执行队首：FIFO、过期即丢弃并回传结果。 */
    private drainPeerQueue(sessionId: string): void {
        if (this.isClosing || !this.peerInbox.head(sessionId)) return;

        void (async () => {
            while (!this.isClosing && !this.isSessionBusy(sessionId)) {
                const head = this.peerInbox.head(sessionId);
                if (!head) break;
                if (this.peerInbox.isExpired(head.message)) {
                    this.peerInbox.shift(sessionId);
                    this.settleDroppedMessage(sessionId, head.message, "expired");
                    continue;
                }

                try {
                    this.beginSessionOperation(sessionId);
                } catch {
                    // 竞态：又被占用，留在队首等下一轮
                    break;
                }
                // 抢到互斥才算真的开始执行：先出队，再标执行中（幂等状态从 queued 转 accepted）
                this.peerInbox.shift(sessionId);
                this.peerInbox.markRunning(head.message);
                this.trackTurn(sessionId, this.runPeerTurn(sessionId, head.message));
            }
        })().catch((error) => {
            console.error("⚠️ [host] 排队消息执行失败:", error);
        });
    }

    /** 出队丢弃（过期/取消）：结果由状态机生成并入幂等窗口，这里只负责回传。 */
    private settleDroppedMessage(sessionId: string, message: PeerMessage, reason: PeerDropReason): void {
        const result = this.peerInbox.drop(message, reason);
        try {
            this.control.completeInbound(sessionId, message, result);
        } catch (error) {
            console.error("⚠️ [host] 排队消息丢弃结果回传失败:", error);
        }
    }

    /** 会话不再可执行时，把队列里的消息统一按 cancelled 收尾（必须在摘 socket 之前调用）。 */
    private dropAllQueuedPeerMessages(sessionId: string): void {
        for (const entry of this.peerInbox.takeAll(sessionId)) {
            this.settleDroppedMessage(sessionId, entry.message, "cancelled");
        }
    }

    /** 撤销排队中的消息；已在执行返回 running。 */
    private cancelQueuedPeerMessage(
        sessionId: string,
        msgId: string,
    ): { ok: true } | { ok: false; reason: "not_found" | "running" } {
        const cancelled = this.peerInbox.cancel(sessionId, msgId);
        if (!cancelled.ok) return cancelled;
        this.settleDroppedMessage(sessionId, cancelled.message, "cancelled");
        return { ok: true };
    }

    /** 跑一轮"对方交付的"回合，并把最终输出作为结果回传。 */
    private async runPeerTurn(sessionId: string, message: PeerMessage): Promise<void> {
        const peerTitle = this.activeSessions.get(message.from)?.session.title;
        let prompt = formatInboundPrompt(message, peerTitle);
        let content = "";
        let stopReason = "stop";
        let failure: string | undefined;
        let deferred: PeerDeferredAction | undefined;

        // 模型回合由 runSessionTurn 自己释放互斥；命令分支与异常路径需要这里兜底
        let handedOff = false;
        try {
            // 未知 /xxx 与前导空格按纯文本交给模型；已识别命令一律执行（参数非法则明确报错）
            const parsed = parseSlashCommand(message.text);
            // 归档会话只接受只读/生命周期命令（不要求可写会话视图），其余回明确失败
            if (await this.isSessionArchived(sessionId)
                && !(parsed.kind === "command" && isPeerCommandAllowedOnArchived(parsed))) {
                const target = parsed.kind === "command" || parsed.kind === "invalid" ? parsed.name : "普通消息";
                this.completePeerTurn(sessionId, message, {
                    content: "",
                    stopReason: "archived",
                    failure: `会话已归档（${sessionId}），先 /unarchive 再执行 ${target}`,
                });
                return;
            }
            if (parsed.kind === "command" || parsed.kind === "invalid") {
                if (parsed.kind === "invalid") {
                    this.completePeerTurn(sessionId, message, {
                        content: "",
                        stopReason: "invalid_command",
                        failure: parsed.message,
                    });
                    return;
                }
                const command = await this.resolvePeerSlashCommand(sessionId, parsed);
                if (command.kind === "output") {
                    this.completePeerTurn(sessionId, message, { content: command.output, stopReason: "command" });
                    // 生命周期命令要等结果送达再拆链路（见 runDeferredPeerAction）
                    deferred = command.deferred;
                    // 命令自己跑过一轮（/continue）时，互斥已由那一轮释放，别再删一次
                    if (command.ranTurn) handedOff = true;
                    return;
                }
                if (command.kind === "prompt") prompt = command.prompt;
            }

            const spec: TurnSpec = {
                turnId: createUlid(),
                userMessages: [{ text: prompt, trigger: "peer" }],
                query: prompt,
                initialRequestKind: "peer_request",
                // 终态事件带上入站 msgId：`session wait --msg=` 不必靠 seq 猜回合归属
                peerMsgId: message.id,
                onEvent: (event) => {
                    if (event.type === "message_end") {
                        content = event.content;
                        stopReason = event.stopReason;
                    } else if (event.type === "aborted") {
                        stopReason = event.stopReason ?? "interrupted";
                    } else if (event.type === "error") {
                        failure = event.message;
                    }
                },
            };

            try {
                await this.runtimeReady;
                // runtimeReady 之后才交给 runSessionTurn；它内部 finally 负责释放
                handedOff = true;
                const outcome = await runSessionTurn(this.turnHost, sessionId, spec, { alreadyReserved: true });
                if (outcome.aborted && stopReason === "stop") stopReason = "aborted";
            } catch (error: any) {
                failure = error?.message ?? String(error);
                if (stopReason === "stop") stopReason = "error";
            } finally {
                this.completePeerTurn(sessionId, message, { content, stopReason, ...(failure ? { failure } : {}) });
            }
        } catch (error: any) {
            // 命令执行/解析抛错：回传错误，绝不让回合悬空（否则会话会永久 busy）
            this.completePeerTurn(sessionId, message, {
                content: "",
                stopReason: "error",
                failure: error?.message ?? String(error),
            });
        } finally {
            // 只有没交给 runSessionTurn 的路径才释放，避免删掉期间别的入口刚抢到的互斥
            if (!handedOff) this.endSessionOperation(sessionId);
            // 结果已经送达且互斥已归还：这时候归档/关闭/删除才不会掐断回传
            if (deferred) void this.runDeferredPeerAction(sessionId, deferred).catch(() => undefined);
        }
    }

    /** 会话间命令的落点：prompt 转模型指令，host 交宿主执行器。 */
    private async resolvePeerSlashCommand(
        sessionId: string,
        parsed: Extract<SlashCommandParse, { kind: "command" }>,
    ): Promise<
        { kind: "output"; output: string; deferred?: PeerDeferredAction; ranTurn?: boolean }
        | { kind: "prompt"; prompt: string }
    > {
        if (parsed.spec.peer === "prompt") {
            return { kind: "prompt", prompt: buildReviewPrompt(parsed.args[0]) };
        }
        const result = await executePeerCommand(this.peerCommandHost, sessionId, parsed);
        return {
            kind: "output",
            output: result.output,
            ...(result.deferred ? { deferred: result.deferred } : {}),
            ...(result.ranTurn ? { ranTurn: true } : {}),
        };
    }

    /**
     * 结果送达后再执行归档/关闭/删除：它们会拆掉会话视图与 socket，
     * 先拆就等于把刚写出的结果连同回传链路一起扔掉。
     */
    private async runDeferredPeerAction(sessionId: string, action: PeerDeferredAction): Promise<void> {
        // 会话要走了：排队中的投递先按 cancelled 收尾，调用方拿到终态而不是静静消失
        this.dropAllQueuedPeerMessages(sessionId);
        try {
            if (action === "archive") {
                await this.closeSession(sessionId);
                this.releaseSession(sessionId, { cause: "archive" });
            } else if (action === "delete") {
                await this.deleteSession(sessionId);
                this.releaseSession(sessionId, { cause: "delete" });
            } else {
                this.releaseSession(sessionId, { cause: "peer" });
            }
        } catch (error) {
            console.error(`⚠️ [host] 会话间 ${action} 收尾失败:`, error);
            throw error;
        }
    }

    /** 落定一条会话间回合结果（命令与模型回合共用）。 */
    private completePeerTurn(
        sessionId: string,
        message: PeerMessage,
        outcome: { content: string; stopReason: string; failure?: string },
    ): void {
        const result: PeerResult = {
            msgId: message.id,
            ok: outcome.failure === undefined,
            // 失败时把原因一并放进 text：结果落盘与 CLI 等待都靠它展示，不能只留在内存
            text: outcome.content || outcome.failure || "",
            stopReason: outcome.stopReason,
            ...(outcome.failure ? { error: outcome.failure } : {}),
        };
        // 先记终态再回传：重试同一 msgId 时能重推结果，且不会重复执行
        this.peerInbox.rememberResult(message, result);
        try {
            this.control.completeInbound(sessionId, message, result);
        } catch (error) {
            console.error("⚠️ [host] 会话间结果回传失败:", error);
        }
    }

    /** 落盘一条会话间消息并推给 UI：时间线在重启后也能还原。 */
    private async recordPeerMessage(
        sessionId: string,
        message: PeerMessage,
        direction: "in" | "out",
        options: { queued?: boolean; expiresAt?: string } = {},
    ): Promise<void> {
        const peerId = direction === "in" ? message.from : message.to;
        const peerTitle = this.activeSessions.get(peerId)?.session.title;
        const payload: AgentEventPayloads["peer_message"] = {
            msgId: message.id,
            direction,
            peerId,
            ...(peerTitle ? { peerTitle } : {}),
            text: message.text,
            ...(message.expectResult ? { expectResult: true } : {}),
            ...(message.replyTo ? { replyTo: message.replyTo } : {}),
            ...(options.queued ? { queued: true } : {}),
            ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
            createdAt: message.createdAt,
        };

        await this.appendPeerMessage(sessionId, payload);
        this.notify(this.nextRequestId++, sessionId, { type: "peer_message", ...payload });
    }

    /** 落盘一条结果并推给 UI：结果也是可复盘的事实，不能只留在内存。 */
    private async recordPeerResult(requester: string, payload: AgentEventPayloads["peer_result"]): Promise<void> {
        await this.appendAgentEvent(requester, "peer_result", payload);
        this.notify(this.nextRequestId++, requester, {
            type: "peer_result",
            msgId: payload.msgId,
            peerId: payload.peerId,
            ok: payload.ok,
            ...(payload.lost ? { lost: true } : {}),
            ...(payload.late ? { late: true } : {}),
            text: payload.text,
            ...(payload.stopReason ? { stopReason: payload.stopReason } : {}),
        });
    }

    private notifyPeerLost(requester: string, msgIds: string[], target: string): void {
        for (const msgId of msgIds) {
            void this.recordPeerResult(requester, {
                msgId,
                peerId: target,
                ok: false,
                lost: true,
                text: `等待会话 ${target} 的结果失败：对方未在期限内回传（进程可能已退出）`,
                createdAt: getShanghaiISOString(),
            }).catch((error) => {
                console.error("⚠️ [host] 会话间结果落盘失败:", error);
            });
        }
    }

    /** 会话被释放（被其他实例拿走 / 本实例主动关闭）：中止本地残留请求并清出内存，宿主负责同步 UI。 */
    private unloadSession(sessionId: string, cause: SessionReleaseCause = "peer"): void {
        const active = this.activeSessions.get(sessionId);
        active?.abortController?.abort();
        closeChatSessionTransport(sessionId);
        this.activeSessions.delete(sessionId);
        this.pendingModelSelections.delete(sessionId);
        clearMcpSelection(sessionId);
        try {
            this.onSessionReleased?.(sessionId, cause);
        } catch {
            // 宿主回调异常不影响归属释放
        }
    }

    async createSession(cwd?: string, init?: SessionCreateInit): Promise<{ sessionId: string }> {
        const sessionId = createUlid();
        // 缺省 cwd 固定为宿主启动目录；会话 cwd 会随后续切换变化，不能作为新建会话默认值。
        const session = createEmptySession(sessionId, cwd ?? this.startupCwd, init?.origin);
        this.activeSessions.set(sessionId, { session, lastSeq: 0 });
        // MCP 选中集必须在会话交出去之前写好：先建后设会留下一个"工具还不全"的窗口，
        // 无人的任务会话可能正好在这个窗口里发出第一轮请求。
        if (init?.selectedServers !== undefined) {
            await this.setSessionLazyMcpServers(sessionId, init.selectedServers);
        }
        // 标题在这里固化：前端回调只负责展示，无 UI 宿主（peer /new、serve）也不会丢标题
        if (init?.title?.trim()) await this.renameSession(sessionId, init.title);
        return { sessionId };
    }

    async listSessions(): Promise<SessionSummary[]> {
        const ids = this.listSavedSessionIds();
        for (const sessionId of this.activeSessions.keys()) ids.add(sessionId);
        const sessions: SessionSummary[] = [];
        for (const sessionId of ids) {
            const digest = await this.digests.read(sessionId);
            if (digest) sessions.push(digest.summary);
        }
        return sortSessions(sessions);
    }

    /** 磁盘上已落盘的会话 id。 */
    listSavedSessionIds(): Set<string> {
        return new Set(listSavedSessionIds());
    }

    /** 本进程内存里正在使用的会话 id。 */
    listActiveSessionIds(): string[] {
        return [...this.activeSessions.keys()];
    }

    async readSessionEvents(sessionId: string): Promise<AgentEvent[]> {
        return this.eventLog.read(sessionId);
    }

    async readSessionEventsSince(sessionId: string, after: number): Promise<AgentEvent[]> {
        // persistedOnly：对外只承诺带唯一 seq 的持久化事实，pending 流片段 seq 全等于末尾，不能作游标
        return this.eventLog.read(sessionId, after + 1, undefined, { persistedOnly: true });
    }

    async readSessionEventsBefore(sessionId: string, beforeSeq: number, count: number): Promise<AgentEvent[]> {
        return this.eventLog.readBefore(sessionId, beforeSeq, count);
    }

    /** 会话是否处于归档态：只读尾部一条事件，比列一遍全部会话便宜得多。 */
    async isSessionArchived(sessionId: string): Promise<boolean> {
        const diskSeq = await this.eventLog.lastSeq(sessionId, { forceRefresh: true });
        if (diskSeq === 0) return false;
        const tail = await this.eventLog.read(sessionId, diskSeq, 1);
        return tail[0]?.type === "session_archived";
    }

    subscribeEvents(listener: (sessionId: string, event: AgentEvent | null) => void): () => void {
        return this.eventLog.subscribe(listener);
    }

    /** 丢弃某会话的缓存事件（清理后调用，避免用旧缓存把它又列出来）。 */
    forgetSession(sessionId: string): void {
        this.eventLog.forget(sessionId);
        this.digests.clear(sessionId);
    }

    /** 会话最近收到的会话间结果（供 session_status 回查）：只扫日志尾部窗口。 */
    private async recentPeerResults(sessionId: string, limit: number): Promise<PeerResultRecord[]> {
        const lastSeq = await this.eventLog.lastSeq(sessionId, { forceRefresh: true });
        if (lastSeq === 0) return [];

        const fromSeq = Math.max(1, lastSeq - PEER_RESULT_SCAN_EVENTS + 1);
        const events = await this.eventLog.read(sessionId, fromSeq);
        const results: PeerResultRecord[] = [];
        for (const event of events) {
            if (event.type !== "peer_result") continue;
            results.push({
                peerId: event.payload.peerId,
                ...(event.payload.peerTitle ? { peerTitle: event.payload.peerTitle } : {}),
                ok: event.payload.ok,
                ...(event.payload.lost ? { lost: true } : {}),
                ...(event.payload.late ? { late: true } : {}),
                text: event.payload.text,
                ...(event.payload.stopReason ? { stopReason: event.payload.stopReason } : {}),
                createdAt: event.payload.createdAt,
            });
        }
        return results.slice(-limit);
    }

    async getSessionCwd(sessionId: string): Promise<string> {
        const active = this.activeSessions.get(sessionId);
        if (active) return active.session.cwd;

        // 恢复会话：当前目录由 session_created 与后续 session_cwd_changed 决定（判定与重放共用 eventCwd）。
        // cwd 变更可能落在日志任意位置（改完目录又聊了很久），倒序扫描全量才能取到最后一条；
        // 恢复会话本来就要读整份日志，这里的重复读取不引入额外量级。
        const events = await this.eventLog.read(sessionId);
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const cwd = eventCwd(events[index]);
            if (cwd) return cwd;
        }
        // 旧事件没有 cwd：回退启动目录，不能继承当前选中会话的目录
        return getStartupToolCwd();
    }

    /**
     * 改写会话工作目录：落盘 session_cwd_changed，更新内存 session 并通知宿主。
     * 空会话先补 session_created，否则重放时它会把新的 cwd 覆盖回去。
     *
     * 不加 beginSessionOperation / 会话锁：cwd 工具正是在回合中调用（abortController 已挂上），
     * 那两把锁会把它判成"有请求处理中"直接失败；事件写入本身由 eventLog 的按会话串行保证。
     */
    async setSessionCwd(sessionId: string, cwd: string): Promise<void> {
        const resolved = path.resolve(cwd);
        const session = await this.requireActiveSession(sessionId);
        if (session.cwd === resolved) return;

        if ((await this.eventLog.lastSeq(sessionId, { forceRefresh: true })) === 0) {
            const created = await this.eventLog.append(sessionId, "session_created", { cwd: resolved });
            this.updateActiveSeq(sessionId, created.seq);
        }

        const event = await this.eventLog.append(sessionId, "session_cwd_changed", { cwd: resolved });
        session.cwd = resolved;
        this.updateActiveSeq(sessionId, event.seq);
        this.onSessionCwdChanged?.(sessionId, resolved);
    }

    /** 清空会话（截断事件日志重建）；alreadyReserved：会话间命令已持有互斥。 */
    async clearSession(sessionId: string, options: { alreadyReserved?: boolean } = {}): Promise<void> {
        if (options.alreadyReserved !== true) this.beginSessionOperation(sessionId);
        let lock: SessionLockHandle | undefined;
        try {
            lock = await acquireSessionLock(sessionId);
            const session = await this.requireActiveSession(sessionId);
            if ((await this.eventLog.lastSeq(sessionId, { forceRefresh: true })) === 0) {
                throw new Error(`会话不存在: ${sessionId}`);
            }
            await this.eventLog.truncate(sessionId, 0);
            await this.replay.deleteSnapshot(sessionId);
            await deleteSessionImageAssets(sessionId);
            closeChatSessionTransport(sessionId);
            await deleteResponsesBaseline(sessionId);
            // 用会话自己的 cwd：远程 /clear 不该把目标会话的工作目录改成持有者/CLI 的目录
            await this.eventLog.append(sessionId, "session_created", { cwd: session.cwd });
            if (session.modelSelection) {
                await this.eventLog.append(sessionId, "model_selected", session.modelSelection);
            }
            // 清空历史 ≠ 从未用过：留一条事实，退出/关闭时空会话清理不会误删
            await this.eventLog.append(sessionId, "session_cleared", {});
            const replayed = await this.replay.replayTo(sessionId);
            this.activeSessions.set(sessionId, { session: replayed.session, lastSeq: replayed.lastSeq });
        } finally {
            try {
                await this.releaseSessionLockSafely(lock);
            } finally {
                if (options.alreadyReserved !== true) this.endSessionOperation(sessionId);
            }
        }
    }

    async renameSession(sessionId: string, title: string): Promise<void> {
        const cleanTitle = title.trim().slice(0, MAX_SESSION_TITLE_LENGTH);
        if (!cleanTitle) return;

        this.beginSessionOperation(sessionId);
        let lock: SessionLockHandle | undefined;
        try {
            lock = await acquireSessionLock(sessionId);
            const active = this.activeSessions.get(sessionId);
            if (active) active.session.title = cleanTitle;

            let lastSeq = await this.eventLog.lastSeq(sessionId, { forceRefresh: true });
            if (lastSeq === 0) {
                // 空临时会话未落盘：先补 session_created（cwd 取绑定目录），让改名后的会话可持久化
                const created = await this.eventLog.append(sessionId, "session_created", {
                    cwd: active?.session.cwd ?? getStartupToolCwd(),
                });
                lastSeq = created.seq;
            }
            const renamed = await this.eventLog.append(sessionId, "session_renamed", { title: cleanTitle });
            this.updateActiveSeq(sessionId, renamed.seq);
        } finally {
            try {
                await this.releaseSessionLockSafely(lock);
            } finally {
                this.endSessionOperation(sessionId);
            }
        }
    }

    /** 当前会话的模型选择：待落盘（本回合设置、下一回合生效）优先于已落盘值。 */
    async getSessionModelSelection(sessionId: string): Promise<ChatModelSelection | undefined> {
        const pending = this.pendingModelSelections.get(sessionId);
        if (pending) return pending;
        return (await this.requireActiveSession(sessionId)).modelSelection;
    }

    /** 本会话临时启用的 lazy MCP server（无记录时为空数组）。 */
    async getSessionLazyMcpServers(sessionId: string): Promise<string[]> {
        const session = await this.requireActiveSession(sessionId);
        return [...(session.lazyMcpServers ?? [])];
    }

    /**
     * 读会话的 MCP 选中集，不要求会话可写：已归档的会话也要能查（界面要在归档态下展示它）。
     * 与 getSessionLazyMcpServers 的区别只在"归档也能读"，不更新内存缓存。
     */
    async readSessionLazyMcpServers(sessionId: string): Promise<string[]> {
        const diskSeq = await this.eventLog.lastSeq(sessionId, { forceRefresh: true });
        const active = this.activeSessions.get(sessionId);
        if (active && active.lastSeq >= diskSeq) return [...(active.session.lazyMcpServers ?? [])];
        if (diskSeq === 0) throw new SessionNotFoundError(sessionId);
        const replayed = await this.replay.replayTo(sessionId);
        return [...(replayed.session.lazyMcpServers ?? [])];
    }

    /**
     * 覆盖本会话的 lazy MCP 启用集：落盘 lazy_mcp_changed，并同步内存缓存。
     * 换工具集合等于换请求前缀，所以跟改名一样走会话锁：回合进行中不许改，也不会
     * 和被别的实例删除/归档的会话打架（deleteSession 同样要求空闲）。
     */
    async setSessionLazyMcpServers(
        sessionId: string,
        servers: string[],
        options: { alreadyReserved?: boolean } = {},
    ): Promise<void> {
        if (options.alreadyReserved !== true) this.beginSessionOperation(sessionId);
        let lock: SessionLockHandle | undefined;
        try {
            lock = await acquireSessionLock(sessionId);
            const session = await this.requireActiveSession(sessionId);
            const next = [...new Set(servers.map(name => name.trim()).filter(Boolean))].sort();
            const current = session.lazyMcpServers ?? [];
            if (current.length === next.length && current.every((name, index) => name === next[index])) return;

            if ((await this.eventLog.lastSeq(sessionId, { forceRefresh: true })) === 0) {
                const created = await this.eventLog.append(sessionId, "session_created", { cwd: session.cwd });
                this.updateActiveSeq(sessionId, created.seq);
            }
            const event = await this.eventLog.append(sessionId, "lazy_mcp_changed", { servers: next });
            session.lazyMcpServers = next;
            this.updateActiveSeq(sessionId, event.seq);
            updateMcpSelection(sessionId, next);
        } finally {
            try {
                await this.releaseSessionLockSafely(lock);
            } finally {
                if (options.alreadyReserved !== true) this.endSessionOperation(sessionId);
            }
        }
    }

    async setSessionModelSelection(sessionId: string, selection: ChatModelSelection): Promise<void> {
        await this.requireActiveSession(sessionId);
        this.pendingModelSelections.set(sessionId, selection);
    }

    /**
     * 立即落盘模型/强度选择（会话间命令与一次性宿主用）。
     * `setSessionModelSelection` 只是"下一回合生效"的内存等待区，宿主进程退出就丢了，
     * 所以远程 /model 必须当场写事件。
     */
    async setSessionModelSelectionNow(
        sessionId: string,
        selection: ChatModelSelection,
        options: { alreadyReserved?: boolean } = {},
    ): Promise<void> {
        if (options.alreadyReserved !== true) this.beginSessionOperation(sessionId);
        let lock: SessionLockHandle | undefined;
        try {
            lock = await acquireSessionLock(sessionId);
            const session = await this.requireActiveSession(sessionId);
            this.pendingModelSelections.set(sessionId, selection);
            await this.persistPendingModelSelection(sessionId, session);
        } finally {
            try {
                await this.releaseSessionLockSafely(lock);
            } finally {
                if (options.alreadyReserved !== true) this.endSessionOperation(sessionId);
            }
        }
    }

    private async persistPendingModelSelection(sessionId: string, session: Session): Promise<void> {
        const selection = this.pendingModelSelections.get(sessionId);
        if (!selection) return;

        const lastSeq = await this.eventLog.lastSeq(sessionId, { forceRefresh: true });
        if (lastSeq === 0) {
            const created = await this.eventLog.append(sessionId, "session_created", { cwd: session.cwd });
            this.updateActiveSeq(sessionId, created.seq);
        }
        const event = await this.eventLog.append(sessionId, "model_selected", selection);
        session.modelSelection = selection;
        this.pendingModelSelections.delete(sessionId);
        this.updateActiveSeq(sessionId, event.seq);
    }

    async deleteSession(sessionId: string): Promise<void> {
        this.beginSessionOperation(sessionId);
        let lock: SessionLockHandle | undefined;
        try {
            lock = await acquireSessionLock(sessionId);
            await this.eventLog.delete(sessionId);
            await this.replay.deleteSnapshot(sessionId);
            closeChatSessionTransport(sessionId);
            this.activeSessions.delete(sessionId);
            await removeSessionArtifacts(sessionId, { skipLock: true });
        } finally {
            try {
                await this.releaseSessionLockSafely(lock);
            } finally {
                this.endSessionOperation(sessionId);
            }
        }
    }

    /**
     * 空会话的唯一删除入口：归属/忙闲/内容三项复查都通过才删。
     *
     * 判空要读盘，这段等待里不能让别的实例通过 release 协商接管（否则刚接管就被删）：
     * 用 deletingSessions 同时挡住 isSessionBusy 与 beginSessionOperation。
     * 读盘结束立刻摘标记，紧接的 deleteSession 会同步 beginSessionOperation 重新置忙。
     */
    async deleteSessionIfEmpty(sessionId: string): Promise<boolean> {
        if (!this.control.isClaimed(sessionId)) return false;
        if (this.isSessionBusy(sessionId)) return false;

        this.deletingSessions.add(sessionId);
        let empty: boolean;
        try {
            empty = await isEmptySession(this.eventLog, sessionId);
        } finally {
            this.deletingSessions.delete(sessionId);
        }
        if (!empty) return false;

        await this.deleteSession(sessionId);
        return true;
    }

    isSessionBusy(sessionId: string): boolean {
        if (this.sessionOperations.has(sessionId)
            || this.deletingSessions.has(sessionId)
            || this.activeSessions.get(sessionId)?.abortController !== undefined) {
            return true;
        }
        return isSessionLockedByOtherSync(sessionId);
    }

    /** 当前会话是否被其他实例（进程）持有排他锁，本实例无法中止其请求。 */
    isSessionLockedByOther(sessionId: string): boolean {
        return isSessionLockedByOtherSync(sessionId);
    }

    async getSystemPrompt(sessionId: string): Promise<string> {
        const diskSeq = await this.eventLog.lastSeq(sessionId, { forceRefresh: true });
        const active = this.activeSessions.get(sessionId);
        if (active && active.lastSeq >= diskSeq) {
            return buildSystemPrompt(active.session.cwd);
        }

        if (diskSeq === 0) {
            if (active) return buildSystemPrompt(active.session.cwd);
            throw new Error(`会话不存在: ${sessionId}`);
        }

        const replayed = await this.replay.replayTo(sessionId);
        this.activeSessions.set(sessionId, {
            session: replayed.session,
            lastSeq: replayed.lastSeq,
            abortController: active?.abortController,
        });
        return buildSystemPrompt(replayed.session.cwd);
    }

    async closeSession(sessionId: string): Promise<void> {
        this.beginSessionOperation(sessionId);
        let lock: SessionLockHandle | undefined;
        try {
            lock = await acquireSessionLock(sessionId);
            this.dropAllQueuedPeerMessages(sessionId);
            this.peerInbox.forgetResults(sessionId);
            if ((await this.eventLog.lastSeq(sessionId, { forceRefresh: true })) > 0) {
                await this.eventLog.append(sessionId, "session_archived", {});
            }
            this.activeSessions.delete(sessionId);
        } finally {
            try {
                await this.releaseSessionLockSafely(lock);
            } finally {
                this.endSessionOperation(sessionId);
            }
        }
    }

    async unarchiveSession(sessionId: string, options: { alreadyReserved?: boolean } = {}): Promise<void> {
        if (options.alreadyReserved !== true) this.beginSessionOperation(sessionId);
        let lock: SessionLockHandle | undefined;
        try {
            lock = await acquireSessionLock(sessionId);
            if ((await this.eventLog.lastSeq(sessionId, { forceRefresh: true })) === 0) {
                throw new Error(`会话不存在: ${sessionId}`);
            }
            await this.eventLog.append(sessionId, "session_unarchived", {});
            // 丢弃内存缓存，下次访问按新事件序列重放重建。
            this.activeSessions.delete(sessionId);
        } finally {
            try {
                await this.releaseSessionLockSafely(lock);
            } finally {
                if (options.alreadyReserved !== true) this.endSessionOperation(sessionId);
            }
        }
    }

    async sendMessage(
        sessionId: string,
        text: string,
        options?: {
            consumePendingMessages?: () => Array<string | UserMessageInput> | undefined;
            displayText?: string;
            images?: import("../types/image.js").ImageAssetRef[];
        },
    ): Promise<{ aborted?: boolean; contextTrimmed?: boolean }> {
        if (!text.trim()) throw new Error("text 必填");
        // displayText 未传或为空串时退回 text，避免落一条空用户消息
        const current: TurnUserMessage = {
            text: options?.displayText || text,
            images: options?.images,
        };
        return this.trackTurn(sessionId, this.runTurn(sessionId, {
            turnId: createUlid(),
            // 等待中的会话间结果在前（下一次 HTTP 请求时附加），本轮驱动消息在后
            userMessages: [...this.pendingPeerUserMessages(sessionId), current],
            query: text,
            consumePendingMessages: options?.consumePendingMessages,
        }));
    }

    /**
     * 续跑：按续跑点补跑缺失的工具调用或直接发下一次请求。不插入任何用户消息，
     * 上游请求与中断前保持一致；没有可续跑点时直接返回原因。
     */
    async resumeSession(
        sessionId: string,
        options?: {
            consumePendingMessages?: () => Array<string | UserMessageInput> | undefined;
            /** 会话间命令已持有会话互斥（同 runSessionTurn 的 alreadyReserved）。 */
            alreadyReserved?: boolean;
        },
    ): Promise<{ resumed: boolean; reason?: string; aborted?: boolean }> {
        const session = await this.requireActiveSession(sessionId);
        const plan = planResume(session);
        if (!plan.canResume) return { resumed: false, reason: plan.reason };

        const result = await this.trackTurn(sessionId, this.runTurn(sessionId, {
            turnId: createUlid(),
            userMessages: [],
            query: "",
            skipUserQuery: true,
            pendingToolCalls: plan.toolCalls,
            skipToolCallIds: new Set(plan.toolCalls.map(call => call.id)),
            initialRequestKind: "turn_resume",
            consumePendingMessages: options?.consumePendingMessages,
        }, options?.alreadyReserved === true));
        return { resumed: true, aborted: result.aborted };
    }

    async abortSession(sessionId: string): Promise<boolean> {
        const active = this.activeSessions.get(sessionId);
        if (!active?.abortController) return false;
        active.abortController.abort();
        return true;
    }

    steerResponse(sessionId: string, input: string, onAccepted?: () => void): Promise<boolean> {
        if (!this.isSessionBusy(sessionId)) return Promise.resolve(false);
        return steerChatSession(sessionId, input, onAccepted);
    }

    private async cancelSpawnedSession(sessionId: string, closeAfterCancel: boolean): Promise<boolean> {
        if (this.cancellingSessions.has(sessionId)) return false;
        this.cancellingSessions.add(sessionId);
        let didCancel = false;
        let turnSettled = false;

        try {
            if (!await this.abortSession(sessionId)) return false;
            didCancel = true;
            await this.waitForSessionTurns(sessionId);
            turnSettled = true;

            if (closeAfterCancel) {
                // 同一事件循环内清标记并调用 closeSession；它同步占锁后才会让出执行权。
                this.cancellingSessions.delete(sessionId);
                await this.closeSession(sessionId);
                this.releaseSession(sessionId, { cause: "tool" });
                return true;
            }

            return true;
        } finally {
            this.cancellingSessions.delete(sessionId);
            if (!closeAfterCancel && didCancel && turnSettled) {
                this.onTurnFinished?.(sessionId);
                this.driveQueuedResults(sessionId);
                // 取消也是一种回合结束：队首消息要能接着执行
                this.drainPeerQueue(sessionId);
            }
        }
    }

    private async waitForSessionTurns(sessionId: string): Promise<void> {
        const deadline = Date.now() + CANCEL_TURN_TIMEOUT_MS;
        while (true) {
            const turns = [...(this.turnsBySession.get(sessionId) ?? [])];
            if (turns.length === 0) return;

            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) throw new Error("等待取消收尾超时；会话仍保持打开");

            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    Promise.allSettled(turns),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(() => reject(new Error("等待取消收尾超时；会话仍保持打开")), remainingMs);
                    }),
                ]);
            } finally {
                if (timer) clearTimeout(timer);
            }
        }
    }

    /** 取走等待附加的会话间结果，作为本轮请求前置的 user 消息。 */
    private pendingPeerUserMessages(sessionId: string): TurnUserMessage[] {
        return this.control.takeResults(sessionId).map(text => ({ text, trigger: "peer" as const }));
    }

    /**
     * 有待附加的会话间结果就继续一轮：结果到达时与回合结束时都调用，
     * 忙（或别的实例在跑）就先不动，结果原样留在队列里等下一次。
     * 结果文本作为本轮 user 消息（trigger=peer，不渲染成用户气泡），最后一条即本轮 query。
     */
    private driveQueuedResults(sessionId: string): void {
        if (this.isClosing) return;
        if (this.cancellingSessions.has(sessionId)) return;
        if (!this.activeSessions.has(sessionId)) return;
        if (this.control.queuedResults(sessionId) === 0) return;
        // 别的实例正在跑：不要取走结果，等它收尾或用户下次说话时再附加
        if (this.isSessionLockedByOther(sessionId)) return;
        // 先占住互斥再取结果：抢不到时结果必须原样留在队列里
        try {
            this.beginSessionOperation(sessionId);
        } catch {
            return;
        }

        const results = this.control.takeResults(sessionId);
        if (results.length === 0) {
            this.endSessionOperation(sessionId);
            return;
        }

        const spec: TurnSpec = {
            turnId: createUlid(),
            userMessages: results.map(text => ({ text, trigger: "peer" as const })),
            query: results[results.length - 1]!,
            initialRequestKind: "peer_request",
        };
        void this.trackTurn(sessionId, this.runtimeReady.then(() => runSessionTurn(this.turnHost, sessionId, spec, { alreadyReserved: true })))
            .catch((error) => {
                console.error("⚠️ [host] 会话间结果驱动失败:", error);
            });
    }

    /** 统计本实例内真实发起过网络请求的会话用量（退出时展示用）。 */
    getInstanceNetworkStats(): InstanceNetworkStats {
        return aggregateInstanceUsage(this.instanceUsage.values());
    }

    async compactSession(
        sessionId: string,
        instruction?: string,
        options: { alreadyReserved?: boolean } = {},
    ): Promise<void> {
        await compactSessionContext(this.turnHost, sessionId, instruction, options);
    }

    /**
     * 本地一次性执行一条会话间命令（`session send` 遇到无持有者时由本进程接管）。
     * 与投递路径共用解析与执行器，区别只是没有回传链路：结果为返回值，
     * 生命周期收尾（archive/close/delete）由调用方在输出之后 `finish()` 触发。
     */
    async executePeerCommandLocally(
        sessionId: string,
        text: string,
    ): Promise<
        | { kind: "command"; ok: boolean; output: string; stopReason: string; finish: () => Promise<void> }
        | { kind: "prompt"; prompt: string }
    > {
        const parsed = parseSlashCommand(text);
        if (parsed.kind === "text") return { kind: "prompt", prompt: text };
        if (parsed.kind === "invalid") {
            return {
                kind: "command",
                ok: false,
                output: parsed.message,
                stopReason: "invalid_command",
                finish: async () => undefined,
            };
        }

        if (await this.isSessionArchived(sessionId) && !isPeerCommandAllowedOnArchived(parsed)) {
            return {
                kind: "command",
                ok: false,
                output: `会话已归档（${sessionId}），先 /unarchive 再执行 ${parsed.name}`,
                stopReason: "archived",
                finish: async () => undefined,
            };
        }

        // /review 这类命令转成模型指令（与投递路径同一口径），由调用方跑一轮
        if (parsed.spec.peer === "prompt") {
            return { kind: "prompt", prompt: buildReviewPrompt(parsed.args[0]) };
        }

        // 命令在执行器里按"调用方已持有互斥"处理，这里自己占一次
        this.beginSessionOperation(sessionId);
        let result: { output: string; deferred?: PeerDeferredAction; ranTurn?: boolean };
        try {
            result = await executePeerCommand(this.peerCommandHost, sessionId, parsed);
        } catch (error: any) {
            this.endSessionOperation(sessionId);
            return {
                kind: "command",
                ok: false,
                output: error?.message ?? String(error),
                stopReason: "error",
                finish: async () => undefined,
            };
        }
        // 命令自己跑过一轮（/continue）时互斥已被那一轮释放，别再删一次
        if (!result.ranTurn) this.endSessionOperation(sessionId);

        const deferred = result.deferred;
        return {
            kind: "command",
            ok: true,
            output: result.output,
            stopReason: "command",
            finish: async () => {
                if (deferred) await this.runDeferredPeerAction(sessionId, deferred);
            },
        };
    }

    /**
     * 会话间 /new：派生一个子会话并立即认领（与 session_spawn 同一套记账：
     * 数量上限、TUI 会话条通知、自动回收清单）。
     */
    private async spawnPeerSession(
        parentSessionId: string,
        title?: string,
    ): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
        return this.control.spawnSession(parentSessionId, title);
    }

    /** 会话间命令执行器所需的宿主能力：全部指向真实业务方法，不复制任何 UI 逻辑。 */
    private readonly peerCommandHost: PeerCommandHost = {
        listSessions: () => this.listSessions(),
        listSessionOwnership: ids => this.listSessionOwnership(ids),
        claimedSessionIds: () => this.claimedSessionIds(),
        isSessionBusy: sessionId => this.isSessionBusy(sessionId),
        getSessionCwd: sessionId => this.getSessionCwd(sessionId),
        setSessionCwd: (sessionId, cwd) => this.setSessionCwd(sessionId, cwd),
        getSystemPrompt: sessionId => this.getSystemPrompt(sessionId),
        getSessionModelSelection: sessionId => this.getSessionModelSelection(sessionId),
        setSessionModelSelection: (sessionId, selection, options) =>
            this.setSessionModelSelectionNow(sessionId, selection, options),
        getSessionLazyMcpServers: sessionId => this.getSessionLazyMcpServers(sessionId),
        setSessionLazyMcpServers: (sessionId, servers, options) => this.setSessionLazyMcpServers(sessionId, servers, options),
        compactSession: (sessionId, instruction, options) => this.compactSession(sessionId, instruction, options),
        resumeSession: (sessionId, options) => this.resumeSession(sessionId, options),
        clearSession: (sessionId, options) => this.clearSession(sessionId, options),
        unarchiveSession: (sessionId, options) => this.unarchiveSession(sessionId, options),
        reloadRuntime: () => this.reloadRuntime(),
        spawnPeerSession: (parentSessionId, title) => this.spawnPeerSession(parentSessionId, title),
    };

    loadInputHistory(sessionId: string): string[] {
        return loadInputHistory(sessionId);
    }

    async appendInputHistory(sessionId: string, text: string, ts?: string): Promise<void> {
        await appendInputHistory(sessionId, text, ts);
    }

    /**
     * 中止所有进行中的请求并等待其落盘：abort 后 runTurn 的 catch 分支会
     * 物化 interrupted turn（含已产生的工具段），否则进程退出会丢掉本轮上下文。
     */
    async close(): Promise<void> {
        this.isClosing = true;
        for (const active of this.activeSessions.values()) {
            active.abortController?.abort();
        }
        for (const sessionId of this.activeSessions.keys()) closeChatSessionTransport(sessionId);
        backgroundTaskManager.stopAll();
        // skillRegistry 是进程级单例，宿主代表进程生命周期：退出前把监听摘掉
        const { skillRegistry } = await import("../skills/skill-registry.js");
        await skillRegistry.close();
        // 排队消息在宿主退出时按 cancelled 收尾：必须在关 socket 之前回传
        for (const sessionId of this.peerInbox.sessionIds()) this.dropAllQueuedPeerMessages(sessionId);
        this.peerInbox.clear();
        // 释放全部 socket 与连接：让等待接管的实例能立刻认领
        this.control.close();
        // 注销本实例的运行时能力：关闭后不该再有工具解析到这个宿主
        this.unregisterRuntime();
        if (this.inflightTurns.size === 0) return;
        const inflight = Promise.allSettled([...this.inflightTurns]);
        const timeout = new Promise<void>(resolve => {
            setTimeout(resolve, CLOSE_FLUSH_TIMEOUT_MS);
        });
        await Promise.race([inflight, timeout]);
    }

    /** 重读磁盘技能和 MCP 工具：system prompt 与工具定义都在每次请求现构建，无需清理缓存。 */
    async reloadRuntime(): Promise<RuntimeReloadResult> {
        const [{ skillRegistry }, mcp] = await Promise.all([
            import("../skills/skill-registry.js"),
            import("../mcp/client-manager.js"),
        ]);

        await Promise.all([
            skillRegistry.reload(),
            mcp.reloadMcpClients({ mode: "tui" }),
        ]);

        const statuses = mcp.getMcpServersStatus();
        return {
            skillCount: skillRegistry.getAllSkillMetas().length,
            mcpServerCount: statuses.length,
            mcpToolCount: statuses.reduce((sum, status) => sum + status.toolNames.length, 0),
        };
    }

    private async runTurn(
        sessionId: string,
        spec: TurnSpec,
        alreadyReserved = false,
    ): Promise<{ aborted?: boolean; contextTrimmed?: boolean }> {
        await this.runtimeReady;
        if (this.isClosing) throw new Error("宿主已关闭，无法开始回合");
        return runSessionTurn(this.turnHost, sessionId, spec, alreadyReserved ? { alreadyReserved: true } : {});
    }

    private async trackTurn<T>(sessionId: string, turn: Promise<T>): Promise<T> {
        this.inflightTurns.add(turn);
        const turns = this.turnsBySession.get(sessionId) ?? new Set<Promise<unknown>>();
        turns.add(turn);
        this.turnsBySession.set(sessionId, turns);
        try {
            return await turn;
        } finally {
            this.inflightTurns.delete(turn);
            turns.delete(turn);
            if (turns.size === 0) this.turnsBySession.delete(sessionId);
            // 回合结束后通知宿主：群消息驱动等非用户回合也要放行排队的输入
            if (!this.cancellingSessions.has(sessionId)) {
                try {
                    this.onTurnFinished?.(sessionId);
                } catch {
                    // 宿主回调异常不影响回合结果
                }
                // 回合执行期间到达、当时没能驱动的结果，在这里补一次
                this.driveQueuedResults(sessionId);
                // 排队投递：队首在会话空闲后依次执行
                this.drainPeerQueue(sessionId);
            }
        }
    }

    private async requireActiveSession(sessionId: string): Promise<Session> {
        const diskSeq = await this.eventLog.lastSeq(sessionId, { forceRefresh: true });
        const active = this.activeSessions.get(sessionId);

        // 内存缓存未落后磁盘 seq，直接复用
        if (active && active.lastSeq >= diskSeq) {
            updateMcpSelection(sessionId, active.session.lazyMcpServers ?? []);
            return active.session;
        }

        if (diskSeq === 0) {
            if (active) {
                updateMcpSelection(sessionId, active.session.lazyMcpServers ?? []);
                return active.session;
            }
            throw new SessionNotFoundError(sessionId);
        }

        const tail = await this.eventLog.read(sessionId, diskSeq, 1);
        if (tail[0]?.type === "session_archived") {
            throw new SessionArchivedError(sessionId);
        }

        // 磁盘有新事件（如被其他实例推进），增量/全量重放更新内存缓存
        const replayed = await this.replay.replayTo(sessionId);
        this.activeSessions.set(sessionId, {
            session: replayed.session,
            lastSeq: replayed.lastSeq,
            abortController: active?.abortController,
        });
        updateMcpSelection(sessionId, replayed.session.lazyMcpServers ?? []);
        return replayed.session;
    }

    private updateActiveSeq(sessionId: string, seq: number): void {
        const active = this.activeSessions.get(sessionId);
        if (active && seq > active.lastSeq) {
            active.lastSeq = seq;
        }
    }

    private beginSessionOperation(sessionId: string): void {
        if (this.cancellingSessions.has(sessionId)) {
            throw new SessionBusyError("会话正在取消，请稍后重试");
        }
        if (this.deletingSessions.has(sessionId)) {
            throw new SessionBusyError("会话正在清理，请稍后重试");
        }
        if (this.sessionOperations.has(sessionId) || this.activeSessions.get(sessionId)?.abortController !== undefined) {
            throw new SessionBusyError("有请求处理中，请先中止当前请求");
        }
        this.sessionOperations.add(sessionId);
    }

    private endSessionOperation(sessionId: string): void {
        this.sessionOperations.delete(sessionId);
    }

    private accumulateInstanceUsage(sessionId: string, usage: UsageInfo): void {
        if (!usage.requestCount) return;
        const prev = this.instanceUsage.get(sessionId);
        this.instanceUsage.set(sessionId, prev ? mergeUsage(prev, usage) : usage);
    }

    private async releaseSessionLockSafely(lock: SessionLockHandle | undefined): Promise<void> {
        if (!lock) return;
        try {
            await lock.release();
        } catch (error) {
            console.error(`⚠️ [host] 释放会话锁失败 (${lock.sessionId}):`, error);
        }
    }

    private async finishAndPersist(session: Session): Promise<void> {
        const active = this.activeSessions.get(session.sessionId);
        if (active) delete active.abortController;
        await this.replay.writeSnapshotIfDue(session.sessionId, session);
    }

    private notify(requestId: number, sessionId: string, event: UIEvent): void {
        this.onEvent?.(requestId, sessionId, event);
    }
}
