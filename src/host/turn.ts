/**
 * turn 执行与上下文压缩：加锁 → 共享骨架执行（services/run-turn）→ 快照与用量收尾。
 * 宿主能力（事件日志、内存会话、锁、通知）通过 TurnHost 注入，便于脱离 TUI 单测。
 */

import { runTurnCore } from "../services/run-turn.js";
import { readMcpSelection, runWithMcpSelectionSnapshot } from "../tools/session-mcp-selection.js";
import {
    buildConversationHistory,
    getChatApiSettings,
    buildSystemPrompt,
    getToolDefinitionsTokens,
    runChatQuery,
} from "../services/chat-runtime.js";
import { buildCompactPrompt } from "../utils/compaction-prompt.js";
import {
    applyCompaction,
    autoCompactIfNeeded,
    buildCompactionHistory,
    findCompactionKeepFromPosition,
    planManualCompaction,
    prepareCompactionHistory,
} from "../services/auto-compact.js";
import { acquireSessionLock, type SessionLockHandle } from "../utils/session-lock.js";
import { getDefaultMemoryUserId } from "../utils/runtime-paths.js";
import { emptyUsage, mergeUsage, type UIEvent } from "../events/ui-events.js";
import type { EventLog } from "../events/event-log.js";
import type { SessionReplay } from "../events/session-replay.js";
import type { UsageInfo } from "../types/chat.js";
import type { Session } from "../types/session.js";
import type { ActiveSession, TurnSpec } from "./session-host-types.js";
import { toUserContent, type UserMessageInput } from "../types/image.js";
import { repairEmptyAssistantHistory } from "../utils/conversation-history-repair.js";
import { countTextTokens } from "../utils/tokenizer.js";

/** turn 执行所需的宿主能力。 */
export interface TurnHost {
    eventLog: EventLog;
    replay: SessionReplay;
    activeSessions: Map<string, ActiveSession>;
    /** 分配请求 id（单调递增）。 */
    allocateRequestId(): number;
    notify(requestId: number, sessionId: string, event: UIEvent): void;
    requireActiveSession(sessionId: string): Promise<Session>;
    updateActiveSeq(sessionId: string, seq: number): void;
    accumulateInstanceUsage(sessionId: string, usage: UsageInfo): void;
    finishAndPersist(session: Session): Promise<void>;
    persistPendingModelSelection?(sessionId: string, session: Session): Promise<void>;
    releaseSessionLockSafely(lock: SessionLockHandle | undefined): Promise<void>;
    beginSessionOperation(sessionId: string): void;
    endSessionOperation(sessionId: string): void;
}

/** 单个 turn：加锁 → 共享骨架执行 → 快照与用量收尾。 */
export async function runSessionTurn(
    host: TurnHost,
    sessionId: string,
    spec: TurnSpec,
    options: { alreadyReserved?: boolean } = {},
): Promise<{ aborted?: boolean; contextTrimmed?: boolean }> {
    // 会话间投递在回 ack 前就已抢到互斥（见 LocalSessionHost.acceptPeerMessage），
    // 这条路径不能再抢一次，否则自己把自己判成 busy。
    if (!options.alreadyReserved) host.beginSessionOperation(sessionId);
    const { turnId } = spec;
    const userMessages: UserMessageInput[] = spec.userMessages.map(message => ({
        text: message.text,
        images: message.images,
    }));

    const abortController = new AbortController();
    const requestId = host.allocateRequestId();
    let turnUsage = emptyUsage();
    let session: Session | undefined;
    let lock: SessionLockHandle | undefined;

    try {
        lock = await acquireSessionLock(sessionId);
        session = await host.requireActiveSession(sessionId);
        await host.persistPendingModelSelection?.(sessionId, session);
        host.activeSessions.set(sessionId, {
            session,
            lastSeq: host.activeSessions.get(sessionId)?.lastSeq ?? 0,
            abortController,
        });
        const activeSession = session;

        // 本回合的工具集快照：MCP 选中集在回合中途被改（/mcp 或网页）也不影响这一回合。
        // 同一份快照会写进 turn_commit，事后能回答"这一回合到底带没带某个 MCP"。
        const mcpSnapshot = readMcpSelection(sessionId);
        const outcome = await runWithMcpSelectionSnapshot(
            mcpSnapshot,
            () => runTurnCore({
            session: activeSession,
            turnId,
            userMessages,
            query: spec.query,
            queryContent: userMessages.at(-1) ? toUserContent(userMessages.at(-1)!) : undefined,
            systemPrompt: buildSystemPrompt(activeSession.cwd),
            model: getChatApiSettings(activeSession.modelSelection).model,
            buildHistory: () =>
                buildConversationHistory(activeSession, userMessages, { skipToolCallIds: spec.skipToolCallIds }),
            signal: abortController.signal,
            userId: getDefaultMemoryUserId(),
            cwd: activeSession.cwd,
            // 回合内 cwd 工具改过目录后，后续工具调用立即用新基准
            resolveCwd: () => host.activeSessions.get(sessionId)?.session.cwd,
            skipUserQuery: spec.skipUserQuery,
            pendingToolCalls: spec.pendingToolCalls,
            initialRequestKind: spec.initialRequestKind,
            consumePendingMessages: spec.consumePendingMessages,
            autoCompactActiveTurn: !spec.skipUserQuery,
            compactOnProviderOverflow: Boolean(spec.skipUserQuery),
        }, {
            persistUserMessages: async (texts, tid) => {
                if ((await host.eventLog.lastSeq(sessionId)) === 0) {
                    const created = await host.eventLog.append(sessionId, "session_created", { cwd: activeSession.cwd });
                    host.updateActiveSeq(sessionId, created.seq);
                }
                for (const [index, input] of texts.entries()) {
                    const userInput = typeof input === "string" ? { text: input } : input;
                    // 首条驱动消息带上入站 msgId：命令行按 msgId 等待本回合终态
                    const msgId = index === 0 ? spec.peerMsgId : undefined;
                    const appended = await host.eventLog.append(sessionId, "user_message", {
                        text: userInput.text,
                        ...(userInput.images?.length ? { images: userInput.images } : {}),
                        turnId: tid,
                        trigger: spec.userMessages[index]?.trigger ?? "user",
                        ...(msgId ? { msgId } : {}),
                    });
                    host.updateActiveSeq(sessionId, appended.seq);
                }
            },
            persistPendingMessage: async (input, tid) => {
                const userInput = typeof input === "string" ? { text: input } : input;
                const appended = await host.eventLog.append(sessionId, "user_message", {
                    text: userInput.text,
                    ...(userInput.images?.length ? { images: userInput.images } : {}),
                    turnId: tid,
                    trigger: "pending",
                });
                host.updateActiveSeq(sessionId, appended.seq);
            },
            persistTurnMessage: async (message, tid) => {
                // audioContent 是内联 base64，事件日志按整会话保留（归档前不清理），落事件前剔除。
                // 这里构造副本不影响调用方的对象身份去重：去重比较的是传进本函数的原对象。
                const { audioContent: _audioContent, ...stored } = message as typeof message & { audioContent?: unknown };
                const appended = await host.eventLog.append(sessionId, "turn_message", { turnId: tid, message: stored });
                host.updateActiveSeq(sessionId, appended.seq);
                return appended.seq;
            },
            persistStreamDelta: async (delta, tid, requestIndex) => {
                // 流式片段只进 pending 缓冲（不占主日志 seq、不逐条落盘），回合定稿后剔除。
                // 片段不推进 seq：seq 是会话状态时间轴，不能被逐 token 数据抬高
                await host.eventLog.appendStreamDelta(sessionId, tid, requestIndex, delta);
            },
            persistSteerUpdate: async (update, tid) => {
                const appended = await host.eventLog.append(sessionId, "steer_update", { turnId: tid, ...update });
                host.updateActiveSeq(sessionId, appended.seq);
                return appended.seq;
            },
            onTurnCompact: async (compactedContext, tid) => {
                // 摘要已经取代本回合此前的全部消息（含更早的回合）：
                // 落事件让重放同样丢弃这些 turn_message，否则重启后上下文又回涨到压缩前。
                const appended = await host.eventLog.append(sessionId, "context_compacted", {
                    compactedContext,
                    scope: "turn",
                    turnId: tid,
                });
                host.updateActiveSeq(sessionId, appended.seq);
                // 内存侧与重放同口径：摘要取代本回合此前的全部消息，边界之外只剩后续新消息
                applyCompaction(activeSession, compactedContext);
            },
            persistSegmentStart: async payload => {
                const appended = await host.eventLog.append(sessionId, "turn_segment_start", payload);
                host.updateActiveSeq(sessionId, appended.seq);
                return appended.seq;
            },
            persistTurn: async payload => {
                await host.replay.appendAgentEvent(activeSession, "turn_commit", {
                    ...payload,
                    ...(spec.peerMsgId ? { msgId: spec.peerMsgId } : {}),
                    ...(mcpSnapshot ? { mcpServers: mcpSnapshot } : {}),
                }, false);
                // 回合已定稿：内容以 turn_message 为准，流式片段可以丢弃
                await host.eventLog.dropStream(sessionId, payload.turnId);
                host.updateActiveSeq(sessionId, await host.eventLog.lastSeq(sessionId, { forceRefresh: true }));
            },
            // 续跑不做预压缩：压缩会把待补的 assistant(tool_calls) 前缀摘要掉，工具结果会悬空
            autoCompact: spec.skipUserQuery ? undefined : async () => {
                const result = await autoCompactIfNeeded(activeSession, {
                    model: getChatApiSettings(activeSession.modelSelection).model,
                    toolsTokens: await getToolDefinitionsTokens({
                        sessionId,
                        model: getChatApiSettings(activeSession.modelSelection).model,
                        ...(activeSession.modelSelection ? { modelSelection: activeSession.modelSelection } : {}),
                    }),
                    userId: getDefaultMemoryUserId(),
                    sessionId,
                    signal: abortController.signal,
                    onProgress: message => host.notify(requestId, sessionId, { type: "progress", message }),
                    onUsage: usage => host.notify(requestId, sessionId, { type: "usage", usage }),
                    persistCompactedEvent: async ({ compactedContext, keepFromMessageId, keepFromPosition, usage }) => {
                        const event = await host.eventLog.append(sessionId, "context_compacted", {
                            compactedContext,
                            ...(keepFromMessageId ? { keepFromMessageId } : {}),
                            ...(keepFromPosition ? { keepFromPosition } : {}),
                            usage,
                        });
                        host.updateActiveSeq(sessionId, event.seq);
                    },
                });
                return result.wasCompacted ? undefined : result.usage;
            },
            onEvent: event => {
                // 会话间交付需要捕获本回合的收尾输出（结果回传）；不改变事件流本身
                spec.onEvent?.(event);
                host.notify(requestId, sessionId, event);
            },
            }));

        turnUsage = outcome.usage;
        if (outcome.hasInvalidAssistantHistory) {
            const event = await host.eventLog.append(sessionId, "assistant_history_repaired", {});
            host.updateActiveSeq(sessionId, event.seq);
            repairEmptyAssistantHistory(activeSession);
            await host.replay.writeSnapshotIfDue(sessionId, activeSession);
        }
        if (outcome.aborted) return { aborted: true };
        if (outcome.error) {
            throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
        }
        return {};
    } finally {
        try {
            if (session) {
                host.accumulateInstanceUsage(sessionId, turnUsage);
                await host.finishAndPersist(session);
            } else {
                const active = host.activeSessions.get(sessionId);
                if (active) delete active.abortController;
            }
        } finally {
            try {
                await host.releaseSessionLockSafely(lock);
            } finally {
                host.endSessionOperation(sessionId);
            }
        }
    }
}

export interface CompactSessionOptions {
    /**
     * 调用方已持有会话互斥（会话间投递在回 ack 前就已占住，见 acceptPeerMessage）：
     * 压缩只借用该互斥，既不重新抢，也不替调用方释放。
     */
    alreadyReserved?: boolean;
}

/** 手动压缩会话上下文：写入 context_compacted 事件并同步内存会话。 */
export async function compactSessionContext(
    host: TurnHost,
    sessionId: string,
    instruction?: string,
    options: CompactSessionOptions = {},
): Promise<void> {
    const reservedByCaller = options.alreadyReserved === true;
    if (!reservedByCaller) host.beginSessionOperation(sessionId);
    let lock: SessionLockHandle | undefined;
    const abortController = new AbortController();
    const requestId = host.allocateRequestId();
    let usage = emptyUsage();
    let session: Session | undefined;

    try {
        lock = await acquireSessionLock(sessionId);
        session = await host.requireActiveSession(sessionId);
        const model = getChatApiSettings(session.modelSelection).model;
        const systemPrompt = buildSystemPrompt(session.cwd);
        const systemPromptTokens = await countTextTokens(systemPrompt, model);
        const toolsTokens = await getToolDefinitionsTokens({
            sessionId,
            model,
            ...(session.modelSelection ? { modelSelection: session.modelSelection } : {}),
        });
        // 默认整段折叠；历史超窗时把装不下的尾部原样留下，不在压缩请求里丢最老的内容
        const { turnsToCompact, keepFromMessageId } = await planManualCompaction(session, {
            model,
            systemPromptTokens,
            toolsTokens,
        });
        if (turnsToCompact.length === 0) throw new Error("当前没有可压缩的对话历史");
        // 压缩请求自己也是上游请求：历史已超窗时原样发送只会再吃一个 400，
        // 先裁到「窗口 - 系统提示 - 工具定义」的预算内（工具保留，缓存前缀不能换）
        const history = await prepareCompactionHistory(buildCompactionHistory(session, turnsToCompact), {
            model,
            systemPromptTokens,
            toolsTokens,
        });

        host.activeSessions.set(sessionId, {
            session,
            lastSeq: host.activeSessions.get(sessionId)?.lastSeq ?? 0,
            abortController,
        });
        host.notify(requestId, sessionId, { type: "progress", message: "🗜️ 正在压缩会话上下文..." });
        const response = await runChatQuery({
            query: buildCompactPrompt(instruction),
            systemPrompt,
            history,
            sessionId,
            modelSelection: session.modelSelection,
            cwd: session.cwd,
            resolveCwd: () => host.activeSessions.get(sessionId)?.session.cwd,
            contextEpochId: session.contextEpochId,
            userId: getDefaultMemoryUserId(),
            initialRequestKind: "context_compaction",
            // 纯生成请求：不下发工具定义（十几万 token 的 schema 会白占窗口）
            disableToolCalls: true,
            stream: true,
            signal: abortController.signal,
            onProgress: message => host.notify(requestId, sessionId, { type: "progress", message }),
            onEvent: event => {
                if (event.type === "usage") usage = mergeUsage(usage, event.usage);
                host.notify(requestId, sessionId, event);
            },
        });
        if (abortController.signal.aborted) throw new DOMException("User terminated the request", "AbortError");
        const compactedContext = response.content.trim();
        if (!compactedContext) throw new Error("压缩结果为空");
        const keepFromPosition = findCompactionKeepFromPosition(session, keepFromMessageId);
        const event = await host.eventLog.append(sessionId, "context_compacted", {
            compactedContext,
            instruction,
            ...(keepFromMessageId ? { keepFromMessageId } : {}),
            ...(keepFromPosition ? { keepFromPosition } : {}),
            usage: usage.requestCount ? usage : undefined,
        });
        applyCompaction(session, compactedContext, { instruction, keepFromMessageId });
        host.updateActiveSeq(sessionId, event.seq);
    } catch (error) {
        if (session && usage.requestCount) {
            try {
                await host.replay.appendAgentEvent(session, "usage_recorded", { usage }, false);
            } catch (persistError) {
                console.error("❌ [host] 压缩 usage 持久化失败:", persistError);
            }
        }
        throw error;
    } finally {
        host.notify(requestId, sessionId, { type: "progress", message: "" });
        try {
            if (session) {
                host.accumulateInstanceUsage(sessionId, usage);
                await host.finishAndPersist(session);
            } else {
                const active = host.activeSessions.get(sessionId);
                if (active) delete active.abortController;
            }
        } finally {
            try {
                await host.releaseSessionLockSafely(lock);
            } finally {
                if (!reservedByCaller) host.endSessionOperation(sessionId);
            }
        }
    }
}
