import {
    AUTOCOMPACT_BUFFER_TOKENS,
    AUTOCOMPACT_PERCENTAGE,
    CONTEXT_WINDOW_TOKENS,
    RESERVED_OUTPUT_TOKENS,
    RETAINED_TAIL_TOKENS,
} from "../config.js";
import type { ChatMessage, ConversationTurn, Session, StoredChatMessage } from "../types/session.js";
import { getSessionContextHistoryWithIds } from "./conversation-history.js";
import { estimateMessageTokens } from "./token-estimator.js";
import { countMessagesTokens, countTurnsTokens } from "./tokenizer.js";

export { estimateMessageTokens, estimateTextTokens } from "./token-estimator.js";

/**
 * 主力模型最新（latest）与次新（2nd latest）上下文窗口映射（Token 数）
 * 数据与 ai-models 榜单实时对齐
 */
const KNOWN_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
    // 1. Google Gemini (Latest: 3.7; 2nd: 3.6 / 3.5)
    "gemini-3.7-flash": 1_048_576,
    "gemini-3.7-pro": 1_048_576,
    "gemini-3.6-flash": 1_048_576,
    "gemini-3.6-pro": 1_048_576,
    "gemini-3.5-flash": 1_048_576,

    // 2. DeepSeek (Latest: V4 Flash/Pro; 2nd: V4-0731/0813 / V3 / R1)
    "deepseek-v4-flash": 1_310_720,
    "deepseek-v4-pro": 1_048_576,
    "deepseek-v4": 1_048_576,
    "deepseek-chat": 64_000,
    "deepseek-reasoner": 64_000,

    // 3. OpenAI / Codex (Latest: GPT-5.6 Sol/Terra/Luna; 2nd: GPT-5.5 / 5.4 / o3 / o1)
    "gpt-5.6-sol": 1_050_000,
    "gpt-5.6-terra": 1_050_000,
    "gpt-5.6-luna": 1_050_000,
    "gpt-5.5": 1_050_000,
    "gpt-5.4": 1_050_000,
    "gpt-5.4-mini": 400_000,
    "gpt-5.4-nano": 400_000,
    "o3": 200_000,
    "o3-mini": 200_000,
    "o1": 200_000,

    // 4. Anthropic Claude (Latest: Sonnet 5 / Opus 5 / Fable 5; 2nd: Opus 4.8 / Sonnet 4.6 / 3.7)
    "claude-sonnet-5": 1_000_000,
    "claude-opus-5": 1_000_000,
    "claude-fable-5": 1_000_000,
    "claude-opus-4.8": 1_000_000,
    "claude-opus-4.7": 1_000_000,
    "claude-sonnet-4.6": 1_000_000,
    "claude-sonnet-4.5": 1_000_000,
    "claude-3-7-sonnet": 200_000,
    "claude-3.7-sonnet": 200_000,

    // 5. Qwen (Latest: Qwen 3.8 Max/27B/A95B; 2nd: Qwen 3.7 Max/Plus / 3.6 / 2.5)
    "qwen3.8-max": 1_000_000,
    "qwen3.8-27b": 1_000_000,
    "qwen3.8-2.4t-a95b": 1_048_576,
    "qwen3.7-max": 1_000_000,
    "qwen3.7-plus": 1_000_000,
    "qwen3.6-plus": 1_000_000,
    "qwen3.6-27b": 262_144,
    "qwen-2.5-coder": 128_000,

    // 6. GLM / Z.ai (Latest: GLM-5.3 / 5.3 Flash; 2nd: GLM-5.2 / 5.1)
    "glm-5.3-flash": 1_310_720,
    "glm-5.3": 1_310_720,
    "glm-5.2": 1_048_576,
    "glm-5.1": 204_800,

    // 7. MiniMax (Latest: M3; 2nd: M2.7)
    "minimax-m3": 1_048_576,
    "minimax-m2.7": 204_800,

    // 8. Moonshot Kimi (Latest: K3; 2nd: K2.7 Code / K2.6)
    "kimi-k3": 1_048_576,
    "kimi-k2.7-code": 262_144,
    "kimi-k2.6": 262_144,

    // 9. xAI Grok (Latest: Grok 4.6; 2nd: Grok 4.5)
    "grok-4.6": 500_000,
    "grok-4.5": 500_000,
};

/** 将 Token 数量格式化为紧凑字符串（< 1k 保持数字，>= 1k 显示 k，>= 1M 显示 M） */
export function formatCompactTokens(count: number): string {
    if (!Number.isFinite(count) || count === 0) return "0";
    const abs = Math.abs(count);
    const sign = count < 0 ? "-" : "";

    if (abs >= 1_000_000) {
        const val = abs / 1_000_000;
        const formatted = val >= 10 ? val.toFixed(1) : val.toFixed(2);
        return `${sign}${formatted.replace(/\.?0+$/, "")}M`;
    }
    if (abs >= 1_000) {
        const val = abs / 1_000;
        const formatted = val.toFixed(1);
        return `${sign}${formatted.replace(/\.?0+$/, "")}k`;
    }
    return `${sign}${abs}`;
}

/** 估算一组 turns 的总 Token 数（同步启发式，仅作回退；精确值用 countTurnsTokens）。 */
export function estimateTurnsTokens(turns: ConversationTurn[]): number {
    let total = 0;
    for (const turn of turns) {
        for (const msg of turn.messages) {
            total += estimateMessageTokens(msg);
        }
    }
    return total;
}

/** 根据模型名获取模型的上下文窗口上限（Tokens） */
export function getContextWindowForModel(model?: string): number {
    if (process.env.CONTEXT_WINDOW_TOKENS) {
        const envParsed = parseInt(process.env.CONTEXT_WINDOW_TOKENS, 10);
        if (!isNaN(envParsed) && envParsed > 0) return envParsed;
    }

    if (model) {
        const normalized = model.toLowerCase();
        for (const [key, size] of Object.entries(KNOWN_MODEL_CONTEXT_WINDOWS)) {
            if (normalized.includes(key.toLowerCase())) {
                return size;
            }
        }
    }

    return CONTEXT_WINDOW_TOKENS;
}

/** 获取有效上下文窗口大小（扣除预留的生成输出 Buffer） */
export function getEffectiveContextWindowSize(model?: string): number {
    const total = getContextWindowForModel(model);
    return Math.max(1_000, total - RESERVED_OUTPUT_TOKENS);
}

/**
 * 获取自动压缩触发阈值（Tokens）。
 * 对标 Claude Code / Codex 实践：采用百分比（默认 80%）与安全缓冲双重约束取较小值，
 * 兼顾小窗口模型的缓存利用率与超大窗口模型的响应速度/注意力集中度。
 */
export function getAutoCompactThreshold(model?: string): number {
    const effectiveWindow = getEffectiveContextWindowSize(model);
    const pct = Number.isFinite(AUTOCOMPACT_PERCENTAGE) && AUTOCOMPACT_PERCENTAGE > 0 && AUTOCOMPACT_PERCENTAGE <= 1
        ? AUTOCOMPACT_PERCENTAGE
        : 0.80;
    const percentageThreshold = Math.floor(effectiveWindow * pct);
    const bufferThreshold = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS;
    return Math.max(1_000, Math.min(percentageThreshold, bufferThreshold));
}

/** 会话当前会发给 LLM 的 token 总数（真实分词器，异步）。 */
export async function countSessionContextTokens(
    session: Pick<
        Session,
        "turns" | "compactedContext" | "compactedThroughTurnId" | "compactedKeepFromMessageId" | "contextEpochId"
    >,
    options: { systemPromptTokens?: number; model?: string } = {},
): Promise<number> {
    const history = getSessionContextHistoryWithIds(session);
    const total = options.systemPromptTokens ?? 0;
    return total + (await countMessagesTokens(history, options.model));
}

/**
 * 判定当前会话是否需要触发自动压缩。
 *
 * 两个来源互相隔离、取较大值，任一超阈值都必须压缩：
 * - lastPromptTokens：provider 上报的真实输入规模（含 system prompt 与工具定义），只由 provider 数据写入；
 * - 本地估算：持久历史 + systemPromptTokens，供没有 provider 数值（新会话/刚重放）时兜底。
 * 任一来源单独都不够：回合内请求级压缩会让 provider 值变小，而本地估算拿不到工具定义。
 */
export async function shouldAutoCompact(
    session: Pick<
        Session,
        "turns" | "compactedContext" | "compactedThroughTurnId" | "compactedKeepFromMessageId" | "contextEpochId"
    >,
    options: {
        model?: string;
        /** 系统提示的估算 token（判定要算上它，否则低估真实请求量）。 */
        systemPromptTokens?: number;
        /** provider 上报的真实输入 token（回合峰值，含 system prompt 与工具定义）。 */
        lastPromptTokens?: number;
    } = {},
): Promise<boolean> {
    const estimatedTokens = await countSessionContextTokens(session, {
        systemPromptTokens: options.systemPromptTokens,
        model: options.model,
    });
    const currentTokens = Math.max(options.lastPromptTokens ?? 0, estimatedTokens);
    const threshold = getAutoCompactThreshold(options.model);
    return currentTokens >= threshold;
}

/** 压缩切分结果：待压缩回合（保持 turn 分组）+ 保留段起始消息 id。 */
export interface CompactionSplit {
    /** 待压缩的回合；消息级退化时首个元素是该 turn 的头部消息。 */
    turnsToCompact: ConversationTurn[];
    /** 保留段起始消息 id；undefined 表示没有保留段（整段进摘要）。 */
    keepFromMessageId?: string;
}

/**
 * 切分待压缩回合与保留段：**优先保留完整 turn**，从尾部往前累加到 retainedTailTokens 为止；
 * 只有尾部单个 turn 自己就超出预算，或 turn 边界上切不出待压缩内容时，才退到该 turn 内部
 * 按消息细切（切点回退到 user/assistant 消息，保证 assistant(tool_calls) 与它的 tool 结果不分家）。
 */
export async function splitTurnsForCompaction(
    turns: ConversationTurn[],
    options: { retainedTailTokens?: number; model?: string } = {},
): Promise<CompactionSplit> {
    const candidates = turns;
    if (candidates.length === 0) return { turnsToCompact: [] };

    const tailLimit = options.retainedTailTokens ?? RETAINED_TAIL_TOKENS;
    const last = candidates.length - 1;

    // 显式传入 0 表示不保留尾部：整段候选历史都折叠进摘要。
    // 不能让它继续走 splitWithinTurn，否则「>= 0」会意外留下最后一条消息。
    if (tailLimit <= 0) {
        return { turnsToCompact: candidates };
    }

    // 尾部单个 turn 就超过保留预算：整轮保留等于白留一大坨，改在它内部细切
    if ((await countTurnsTokens([candidates[last]!], options.model)) > tailLimit) {
        return splitWithinTurn(candidates, last, tailLimit, options.model);
    }

    let keepFromIndex = candidates.length;
    let tailTokens = 0;
    for (let index = last; index >= 0; index--) {
        tailTokens += await countTurnsTokens([candidates[index]!], options.model);
        keepFromIndex = index;
        if (tailTokens >= tailLimit) break;
    }
    // 所有 turn 加起来都在保留量内：turn 边界上切不出待压缩内容，退到最后一个 turn 内部细切
    if (keepFromIndex === 0) return splitWithinTurn(candidates, last, tailLimit, options.model);

    return {
        turnsToCompact: candidates.slice(0, keepFromIndex),
        ...(candidates[keepFromIndex]!.messages[0]
            ? { keepFromMessageId: candidates[keepFromIndex]!.messages[0]!.id }
            : {}),
    };
}

/** 在单个 turn 内部按消息从尾部往前切。 */
async function splitWithinTurn(
    candidates: ConversationTurn[],
    turnIndex: number,
    tailLimit: number,
    model?: string,
): Promise<CompactionSplit> {
    const turn = candidates[turnIndex]!;
    const messages = turn.messages;
    const before = candidates.slice(0, turnIndex);

    let cut = messages.length;
    let tailTokens = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
        tailTokens += await countMessagesTokens([messages[index]!], model);
        cut = index;
        if (tailTokens >= tailLimit) break;
    }
    cut = cleanBoundary(messages, cut);
    // 该 turn 整体都在保留量内：只压它的头部，留下最后一条消息
    if (cut === 0 && before.length > 0 && messages.length > 1) {
        cut = cleanBoundary(messages, messages.length - 1);
    }

    return {
        turnsToCompact: cut > 0 ? [...before, { ...turn, messages: messages.slice(0, cut) }] : before,
        ...(messages[cut] ? { keepFromMessageId: messages[cut]!.id } : {}),
    };
}

/** 切点回退到最近的 user/assistant 消息：tool 结果必须与它的 tool call 留在同一侧。 */
function cleanBoundary(messages: StoredChatMessage[], cut: number): number {
    let index = cut;
    while (index > 0 && messages[index]!.role === "tool") index -= 1;
    return index;
}

/**
 * 把一组消息裁到预算内：保留最新尾部，被丢弃的头部用一条省略提示代替。
 *
 * 压缩请求本身也是上游请求：历史已经捅穿窗口时，若原样发送只会再吃一个 400，
 * 于是那次「自救压缩」也会失败。裁剪只用于压缩请求的输入，不改变会话历史。
 */
export async function fitMessagesToBudget(
    messages: ChatMessage[],
    options: { budgetTokens: number; model?: string },
): Promise<ChatMessage[]> {
    const total = await countMessagesTokens(messages, options.model);
    if (total <= options.budgetTokens) return messages;

    let cut = messages.length;
    let tailTokens = 0;
    for (let index = messages.length - 1; index >= 0; index--) {
        const tokens = await countMessagesTokens([messages[index]!], options.model);
        // 预算内塞不下的消息不再纳入；最新一条无论多大都保留，否则裁剪没有意义
        if (tailTokens + tokens > options.budgetTokens && cut < messages.length) break;
        tailTokens += tokens;
        cut = index;
    }
    // 切点不能落在 tool 结果上：它的 assistant(tool_calls) 必须一起留下
    while (cut > 0 && messages[cut]!.role === "tool") cut -= 1;
    if (cut === 0) return messages;

    const omitted = cut;
    return [
        {
            role: "user",
            content: `[上文有 ${omitted} 条消息因超出模型窗口未随本次请求发送，请基于后续内容总结]`,
        },
        ...messages.slice(cut),
    ];
}
