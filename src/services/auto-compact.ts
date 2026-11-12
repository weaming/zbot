import type { ChatMessage, ConversationTurn, Session } from "../types/session.js";
import { getSessionContextHistory, replaceWithCompactedContext } from "../utils/conversation-history.js";
import {
    countSessionContextTokens,
    fitMessagesToBudget,
    getAutoCompactThreshold,
    getContextWindowForModel,
    getEffectiveContextWindowSize,
    shouldAutoCompact,
    splitTurnsForCompaction,
} from "../utils/token-budget.js";
import { getRuntimeConfig } from "../config/index.js";
import { countMessagesTokens, countTextTokens, countTurnsTokens } from "../utils/tokenizer.js";
import { buildCompactPrompt } from "../utils/compaction-prompt.js";
import { projectChatMessagesForPrompt } from "../utils/tool-result-context.js";
import { isAbortError } from "../tools/chat-orchestrator.js";
import { emptyUsage, mergeUsage } from "../events/ui-events.js";
import type { UsageInfo } from "../types/chat.js";
import type { ChatModelSelection } from "../types/chat-model.js";
import { buildSystemPrompt, runChatQuery } from "./chat-runtime.js";
import { getDefaultMemoryUserId, normalizeMemoryUserId } from "../utils/runtime-paths.js";

/**
 * 快速跳过压缩判定的安全水位：provider 上报的真实输入低于阈值这个比例时直接放行，
 * 不再对全量历史做真实分词（纯 JS 精确计数在几十万字时单次数百毫秒，
 * 而回合内每轮工具调用后都要判定一次）。
 *
 * 只信 provider 值：本地启发式对 JSON / base64 / emoji 类工具输出的低估可达 1.3~3 倍，
 * 拿它做跳过判据会把「已过阈值」判成「远未到」。缺 provider 值（新会话首轮、刚重放）
 * 时照旧走精确计数，此时只多付一次。20%~30% 余量留给本轮新增的工具结果。
 */
const FAST_SKIP_RATIO = 0.7;

/** 是否可跳过精确分词：仅当 provider 上报的真实输入离阈值足够远。 */
function canSkipPreciseCount(model: string | undefined, lastPromptTokens?: number): boolean {
    if (!lastPromptTokens || lastPromptTokens <= 0) return false;
    return lastPromptTokens < getAutoCompactThreshold(model) * FAST_SKIP_RATIO;
}

export interface AutoCompactOptions {
    model?: string;
    /** 工具定义占用的 token：压缩请求仍带工具声明（保缓存前缀），预算里必须先扣掉。 */
    toolsTokens?: number;
    userId: number;
    sessionId?: string;
    modelSelection?: ChatModelSelection;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    onUsage?: (usage: UsageInfo) => void;
    persistCompactedEvent?: (payload: {
        compactedContext: string;
        keepFromMessageId?: string;
        keepFromPosition?: { turnIndex: number; messageIndex: number };
        usage?: UsageInfo;
    }) => Promise<void>;
}

export interface AutoCompactResult {
    wasCompacted: boolean;
    preTokens?: number;
    postTokens?: number;
    threshold?: number;
    usage?: UsageInfo;
}

interface ActiveTurnCompactOptions {
    model?: string;
    systemPrompt: string;
    /** 工具定义占用的 token（随请求上行，不在历史里）：从窗口预算里扣掉。 */
    toolsTokens?: number;
    userId: number;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    /** 压缩成功后回调：把摘要落成事件，避免重启后回滚到压缩前的历史。 */
    onCompacted?: (compactedContext: string) => Promise<void>;
    sessionId?: string;
    modelSelection?: ChatModelSelection;
    contextEpochId?: string;
    lastPromptTokens?: number;
    providerMaxTokens?: number;
    onUsage?: (usage: UsageInfo) => void;
    onFailure?: () => void;
}

/** 工具循环中压缩仅用于后续请求的临时上下文，完整消息由编排器另行保留。 */
export async function compactActiveTurnMessagesIfNeeded(
    messages: any[],
    options: ActiveTurnCompactOptions,
): Promise<any[] | undefined> {
    if (options.providerMaxTokens === undefined) {
        // 上一轮 provider 上报的真实输入离阈值还远时无需再数一遍（工具结果这类内容启发式会低估，
        // 所以不用启发式做跳过判据）。
        if (canSkipPreciseCount(options.model, options.lastPromptTokens)) return undefined;
        const currentTokens = await countMessagesTokens(projectChatMessagesForPrompt(messages), options.model);
        const threshold = getAutoCompactThreshold(options.model);
        const checkTokens = Math.max(options.lastPromptTokens ?? 0, currentTokens);
        if (checkTokens < threshold) return undefined;
    }

    options.onProgress?.("🗜️ 当前任务上下文达到上限，正在压缩本轮进展...");

    // 压缩请求自己也是上游请求：历史已超窗时原样发送只会再吃一个 400，先裁到预算内
    const promptBudget = Math.max(
        1_000,
        (options.providerMaxTokens ?? getContextWindowForModel(options.model))
            - getRuntimeConfig().reservedOutputTokens
            - (options.toolsTokens ?? 0),
    );
    const history = await fitMessagesToBudget(
        messages.filter(message => message.role !== "system"),
        { budgetTokens: promptBudget, model: options.model },
    );
    try {
        const response = await runChatQuery({
            query: buildCompactPrompt("重点保留当前任务目标、已完成步骤、工具结果中的关键事实，以及下一步行动。"),
            systemPrompt: options.systemPrompt,
            userId: options.userId,
            history,
            sessionId: options.sessionId,
            modelSelection: options.modelSelection,
            contextEpochId: options.contextEpochId,
            initialRequestKind: "context_compaction",
            disableToolCalls: true,
            stream: true,
            signal: options.signal,
            onProgress: options.onProgress,
            onEvent: event => {
                if (event.type === "usage") options.onUsage?.(event.usage);
            },
        });
        if (options.signal?.aborted) throw new DOMException("User terminated the request", "AbortError");
        const compactedContext = response.content.trim();
        if (!compactedContext) throw new Error("本轮自动压缩结果为空");
        await options.onCompacted?.(compactedContext);

        return [
            ...messages.filter(message => message.role === "system"),
            {
                role: "user",
                content: `<active_turn_summary>\n${compactedContext}\n</active_turn_summary>`,
            },
            {
                role: "assistant",
                content: "已确认上述当前任务进展，将从现有状态继续执行。",
            },
            {
                role: "user",
                content: "请继续完成当前任务；需要时继续调用工具，完成后给出最终答复。",
            },
        ];
    } catch (error: any) {
        if (isAbortError(error)) throw error;
        options.onFailure?.();
        const reason = error instanceof Error ? error.message : String(error);
        console.error("❌ [ActiveTurnCompact] Failed:", reason);
        throw new Error(`本轮上下文压缩失败，已停止请求以避免继续发送超长上下文：${reason}`);
    }
}

/**
 * 待压缩候选取自上次压缩点之后：那里也是上次保留段的起点，
 * 所以保留段会在下一次压缩时被一起吸收，不会一直堆在窗口里。
 */
function compactionCandidates(session: Session): ConversationTurn[] {
    const through = session.compactedThroughTurnId
        ? session.turns.findIndex(turn => turn.id === session.compactedThroughTurnId)
        : -1;
    return session.turns.slice(through + 1);
}

/** 保留段起点所在 turn 的前一个 turn：写入 compactedThroughTurnId，作为下次压缩的起点。 */
function turnBeforeKeepFrom(session: Session, keepFromMessageId: string): string | undefined {
    const index = session.turns.findIndex(turn =>
        turn.messages.some(message => message.id === keepFromMessageId),
    );
    return index > 0 ? session.turns[index - 1]!.id : undefined;
}

/**
 * 手动 /compact 的切分：默认整段折叠；候选历史超过窗口预算时，
 * 把「装不下的尾部」原样保留，而不是在压缩请求里丢掉最老的内容。
 * 下次请求 = 摘要 + 保留段 + 新输入，内容一点不丢。
 */
export async function planManualCompaction(
    session: Session,
    options: { model?: string; systemPromptTokens?: number; toolsTokens?: number } = {},
): Promise<{ turnsToCompact: ConversationTurn[]; keepFromMessageId?: string }> {
    const candidates = compactionCandidates(session);
    const budget = Math.max(
        1_000,
        getEffectiveContextWindowSize(options.model)
            - (options.systemPromptTokens ?? 0)
            - (options.toolsTokens ?? 0),
    );
    const candidateTokens = await countTurnsTokens(candidates, options.model);
    return splitTurnsForCompaction(candidates, {
        model: options.model,
        retainedTailTokens: Math.max(0, candidateTokens - budget),
    });
}

/** 压缩请求的输入历史：已有摘要前缀 + 指定回合（保留原 turn 分组与工具结果投影规则）。 */
export function buildCompactionHistory(session: Session, turns: ConversationTurn[]): ChatMessage[] {
    const tempSession: Session = {
        ...session,
        turns,
        compactedContext: session.compactedContext,
        compactedThroughTurnId: undefined,
        compactedKeepFromMessageId: undefined,
    };
    return getSessionContextHistory(tempSession);
}

/**
 * 压缩请求最终发送的历史：裁到窗口预算内（手动 /compact、自动压缩共用同一口径）。
 *
 * 压缩请求自身也是上游请求。历史已经撞穿窗口时，原样发送只会再吃一个 400，
 * 这次「自救压缩」也会失败；被裁掉的头部本来就属于摘要要吸收的范围。
 */
export function prepareCompactionHistory(
    history: ChatMessage[],
    options: { model?: string; systemPromptTokens?: number; toolsTokens?: number; budgetTokens?: number } = {},
): Promise<ChatMessage[]> {
    const budget = options.budgetTokens
        ?? getEffectiveContextWindowSize(options.model)
            - (options.systemPromptTokens ?? 0)
            - (options.toolsTokens ?? 0);
    return fitMessagesToBudget(history, { budgetTokens: budget, model: options.model });
}

/** 写回压缩结果：摘要 + 保留段边界（turn 级字段供旧数据与重放兜底）。 */
export function applyCompaction(
    session: Session,
    compactedContext: string,
    options: { keepFromMessageId?: string | undefined; instruction?: string | undefined } = {},
): void {
    const { keepFromMessageId, instruction } = options;
    const compactedThroughTurnId = keepFromMessageId
        ? turnBeforeKeepFrom(session, keepFromMessageId)
        : session.turns.at(-1)?.id;
    replaceWithCompactedContext(session, compactedContext, {
        ...(instruction ? { instruction } : {}),
        ...(compactedThroughTurnId ? { compactedThroughTurnId } : {}),
        ...(keepFromMessageId ? { keepFromMessageId } : {}),
    });
}

/** 将内存消息 id 转为可跨重启重放的回合位置。 */
export function findCompactionKeepFromPosition(
    session: Session,
    keepFromMessageId?: string,
): { turnIndex: number; messageIndex: number } | undefined {
    if (!keepFromMessageId) return undefined;
    for (const [turnIndex, turn] of session.turns.entries()) {
        const messageIndex = turn.messages.findIndex(message => message.id === keepFromMessageId);
        if (messageIndex >= 0) return { turnIndex, messageIndex };
    }
    throw new Error(`压缩保留消息不存在: ${keepFromMessageId}`);
}

/**
 * 检查会话是否达到 Token 压缩阈值，并在需要时自动执行压缩。
 * 压缩把上次压缩点之后的全部回合折叠成一段摘要：压缩后的上下文从总结开始，
 * 不再附带被压缩范围内的尾部历史（只保留压缩之后新产生的回合）。
 */
export async function autoCompactIfNeeded(
    session: Session,
    options: AutoCompactOptions = { userId: getDefaultMemoryUserId() },
): Promise<AutoCompactResult> {
    const userId = normalizeMemoryUserId(options.userId);
    // 判定要带上系统提示的占用：只有历史估算会低估真实请求量，漏判就直接涨到 provider 400
    const systemPrompt = buildSystemPrompt(session.cwd);

    // 上一回合 provider 上报的真实输入离阈值还远时直接放行：精确计数要对整段历史分词，
    // 长会话单次数百毫秒。
    if (canSkipPreciseCount(options.model, session.lastPromptTokens)) {
        return { wasCompacted: false };
    }

    const systemPromptTokens = await countTextTokens(systemPrompt, options.model);
    if (!(await shouldAutoCompact(session, {
        model: options.model,
        // 工具定义随请求上行，和系统提示一样属于固定开销
        systemPromptTokens: systemPromptTokens + (options.toolsTokens ?? 0),
        lastPromptTokens: session.lastPromptTokens,
    }))) {
        return { wasCompacted: false };
    }

    const preTokens = session.lastPromptTokens ?? (await countSessionContextTokens(session, { model: options.model }));
    const threshold = getAutoCompactThreshold(options.model);

    // 候选历史本身超过窗口预算时，先把压缩范围往前收：多出来的部分作为保留段原样留下，
    // 这样压缩请求一次装得下，也没有任何内容被丢弃（下次请求 = 摘要 + 保留段 + 新输入）
    const candidates = compactionCandidates(session);
    const candidateBudget = Math.max(
        1_000,
        getEffectiveContextWindowSize(options.model) - systemPromptTokens - (options.toolsTokens ?? 0),
    );
    const candidateTokens = await countTurnsTokens(candidates, options.model);
    const configuredTailTokens = getRuntimeConfig().retainTailTokens;
    const retainedTailTokens = candidateTokens > candidateBudget
        ? Math.max(configuredTailTokens, candidateTokens - candidateBudget)
        : configuredTailTokens;

    // 待压缩回合 + 保留段（优先保留完整 turn，尾部单轮超预算才消息级细切）
    const { turnsToCompact, keepFromMessageId } = await splitTurnsForCompaction(candidates, {
        model: options.model,
        retainedTailTokens,
    });

    if (turnsToCompact.length === 0) {
        return { wasCompacted: false };
    }

    options.onProgress?.("🗜️ 上下文 Token 达到上限，正在自动压缩历史...");

    let usage = emptyUsage();
    try {
        // 同理：待压缩历史可能自己就超过窗口，压缩请求必须先裁到可用预算内
        const history = await prepareCompactionHistory(buildCompactionHistory(session, turnsToCompact), {
            model: options.model,
            systemPromptTokens,
            toolsTokens: options.toolsTokens ?? 0,
        });
        const response = await runChatQuery({
            query: buildCompactPrompt(),
            systemPrompt,
            history,
            userId,
            sessionId: session.sessionId,
            modelSelection: session.modelSelection,
            contextEpochId: session.contextEpochId,
            initialRequestKind: "context_compaction",
            disableToolCalls: true,
            stream: true,
            signal: options.signal,
            onEvent: event => {
                if (event.type !== "usage") return;
                usage = mergeUsage(usage, event.usage);
                options.onUsage?.(event.usage);
            },
        });

        if (options.signal?.aborted) throw new DOMException("User terminated the request", "AbortError");
        const compactedContext = response.content.trim();
        if (!compactedContext) throw new Error("自动压缩结果为空");

        const keepFromPosition = findCompactionKeepFromPosition(session, keepFromMessageId);
        const compactedSession = { ...session };
        applyCompaction(compactedSession, compactedContext, { keepFromMessageId });
        const postTokens = await countSessionContextTokens(compactedSession, { model: options.model });
        if (options.signal?.aborted) throw new DOMException("User terminated the request", "AbortError");

        if (options.persistCompactedEvent) {
            await options.persistCompactedEvent({
                compactedContext,
                ...(keepFromMessageId ? { keepFromMessageId } : {}),
                ...(keepFromPosition ? { keepFromPosition } : {}),
                ...(usage.requestCount ? { usage } : {}),
            });
        }
        Object.assign(session, compactedSession);

        return {
            wasCompacted: true,
            preTokens,
            postTokens,
            threshold,
            usage: usage.requestCount ? usage : undefined,
        };
    } catch (error: any) {
        if (isAbortError(error)) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        console.error("❌ [AutoCompact] Failed:", reason);
        throw new Error(`会话上下文压缩失败，已停止请求以避免继续发送超长上下文：${reason}`);
    }
}
