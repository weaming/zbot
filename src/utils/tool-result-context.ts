import {
    TOOL_RESULT_SUMMARY_HEAD_TOKENS,
    TOOL_RESULT_SUMMARY_TAIL_TOKENS,
    TOOL_RESULT_SUMMARY_THRESHOLD_TOKENS,
} from '../config.js';
import type { ChatMessage } from '../types/session.js';
import { estimateTextTokens } from './token-estimator.js';

/** 投影省略标记前缀，用于幂等检测（已投影内容不重复投影）。 */
const PROJECTION_BANNER_PREFIX = '[工具结果已截取';

/**
 * 投影结果缓存：消息内容落盘后不可变，同一条工具结果会被反复投影
 * （每回合的压缩判定 + 回合内每次请求前的 prepareRequest）。
 * 大结果的头尾二分是 O(n log n) 的字符串切片，重复计算会随历史线性叠加。
 * 键为消息 id（StoredChatMessage 的消息级唯一标识），有界 FIFO。
 */
const PROJECTION_CACHE_MAX_ENTRIES = 2000;
const projectedContentCache = new Map<string, string>();

/** 缓存键带内容长度：同一条消息的原文与截取版长度不同，内容变了也不会命中旧值。 */
function projectionCacheKey(id: string, content: string): string {
    return `${id}|${content.length}`;
}

function rememberProjection(key: string, content: string): void {
    if (projectedContentCache.has(key)) {
        // 命中即刷新到队尾，长会话持续访问的条目不会被顺序写入淘汰
        projectedContentCache.delete(key);
    } else if (projectedContentCache.size >= PROJECTION_CACHE_MAX_ENTRIES) {
        const oldest = projectedContentCache.keys().next().value;
        if (oldest !== undefined) projectedContentCache.delete(oldest);
    }
    projectedContentCache.set(key, content);
}

export interface ToolResultProjectionOptions {
    thresholdTokens?: number;
    headTokens?: number;
    tailTokens?: number;
}

function getPositiveLimit(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function getMaxCharacterCount(characters: string[], tokenLimit: number): number {
    if (tokenLimit <= 0 || characters.length === 0) return 0;

    let lower = 0;
    let upper = characters.length;
    while (lower < upper) {
        const middle = Math.ceil((lower + upper) / 2);
        const candidate = characters.slice(0, middle).join('');
        if (estimateTextTokens(candidate) <= tokenLimit) {
            lower = middle;
        } else {
            upper = middle - 1;
        }
    }
    return lower;
}

/**
 * 剥离工具消息的本地元数据（contextPolicy / durationMs / isError / name），只留上行需要的字段。
 *
 * 这些字段都不属于 OpenAI 官方 ChatCompletionToolMessageParam（只有 content/role/tool_call_id），
 * 官方端点会以 Unrecognized request argument 拒绝多余字段；tool_call_id 已足以关联调用。
 */
function stripToolLocalMetadata(message: ChatMessage): ChatMessage {
    if (message.role !== 'tool') return message;
    if (
        message.contextPolicy === undefined
        && message.durationMs === undefined
        && message.isError === undefined
        && message.name === undefined
    ) {
        return message;
    }
    const {
        contextPolicy: _contextPolicy,
        durationMs: _durationMs,
        isError: _isError,
        name: _name,
        ...apiMessage
    } = message;
    return apiMessage as ChatMessage;
}

/** 仅对超大工具结果做稳定的头尾投影，不改变原始消息。 */
export function projectToolMessageForPrompt(
    message: ChatMessage,
    options: ToolResultProjectionOptions = {},
): ChatMessage {
    if (message.role !== 'tool' || message.contextPolicy?.mode === 'full') {
        return stripToolLocalMetadata(message);
    }
    // 已投影过的内容不再重复投影（防御 threshold < head+tail 等极端配置下的嵌套省略）
    if (message.content.startsWith(PROJECTION_BANNER_PREFIX)) {
        return stripToolLocalMetadata(message);
    }

    const messageId = (message as { id?: string }).id;
    // 只有默认档位可复用缓存：自定义阈值会产出不同结果
    const cacheable = messageId !== undefined && Object.keys(options).length === 0;
    const cacheKey = cacheable ? projectionCacheKey(messageId, message.content) : undefined;
    const cached = cacheKey ? projectedContentCache.get(cacheKey) : undefined;
    if (cached !== undefined) {
        rememberProjection(cacheKey!, cached);
        return { ...stripToolLocalMetadata(message), content: cached } as ChatMessage;
    }

    const content = projectToolContent(message, options);
    // 未截取的结果不占缓存：既不省算力，又让长驻进程长期持有原文
    if (content === message.content) return stripToolLocalMetadata(message);
    if (cacheKey) rememberProjection(cacheKey, content);
    return { ...stripToolLocalMetadata(message), content } as ChatMessage;
}

/** 头尾截取；内容未超阈值（或头尾已覆盖全部）时返回原文。 */
function projectToolContent(message: ChatMessage & { role: 'tool' }, options: ToolResultProjectionOptions): string {
    const content = message.content;
    const originalTokens = estimateTextTokens(message.content);
    const thresholdTokens = getPositiveLimit(options.thresholdTokens, TOOL_RESULT_SUMMARY_THRESHOLD_TOKENS);
    if (originalTokens <= thresholdTokens) {
        return content;
    }

    const headTokens = getPositiveLimit(options.headTokens, TOOL_RESULT_SUMMARY_HEAD_TOKENS);
    const tailTokens = getPositiveLimit(options.tailTokens, TOOL_RESULT_SUMMARY_TAIL_TOKENS);
    const characters = Array.from(message.content);
    const headLength = getMaxCharacterCount(characters, headTokens);
    const tailLength = getMaxCharacterCount([...characters].reverse(), tailTokens);
    // 头尾已覆盖全部内容时无需截取，直接返回原文
    if (headLength + tailLength >= characters.length) {
        return content;
    }
    const tailStart = Math.max(headLength, characters.length - tailLength);
    const head = characters.slice(0, headLength).join('');
    const tail = characters.slice(tailStart).join('');
    const omittedTokens = Math.max(originalTokens - estimateTextTokens(head) - estimateTextTokens(tail), 0);
    return [
        `[工具结果已截取：原始约 ${originalTokens} tokens，省略约 ${omittedTokens} tokens]`,
        head,
        tailStart > headLength ? '...（中间内容已省略）...' : '',
        tailStart > headLength ? tail : '',
    ].filter(Boolean).join('\n');
}

/** 将模型请求中的工具消息统一投影，保留原始数组不变。 */
export function projectChatMessagesForPrompt(
    messages: readonly ChatMessage[],
    options: ToolResultProjectionOptions = {},
): ChatMessage[] {
    return messages.map((message) => projectToolMessageForPrompt(message, options));
}
