import {
    TOOL_RESULT_SUMMARY_HEAD_TOKENS,
    TOOL_RESULT_SUMMARY_TAIL_TOKENS,
    TOOL_RESULT_SUMMARY_THRESHOLD_TOKENS,
} from '../config.js';
import type { ChatMessage } from '../types/session.js';
import { estimateTextTokens } from './token-estimator.js';

/** 投影省略标记前缀，用于幂等检测（已投影内容不重复投影）。 */
const PROJECTION_BANNER_PREFIX = '[工具结果已截取';

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

    const originalTokens = estimateTextTokens(message.content);
    const thresholdTokens = getPositiveLimit(options.thresholdTokens, TOOL_RESULT_SUMMARY_THRESHOLD_TOKENS);
    if (originalTokens <= thresholdTokens) {
        return stripToolLocalMetadata(message);
    }

    const headTokens = getPositiveLimit(options.headTokens, TOOL_RESULT_SUMMARY_HEAD_TOKENS);
    const tailTokens = getPositiveLimit(options.tailTokens, TOOL_RESULT_SUMMARY_TAIL_TOKENS);
    const characters = Array.from(message.content);
    const headLength = getMaxCharacterCount(characters, headTokens);
    const tailLength = getMaxCharacterCount([...characters].reverse(), tailTokens);
    // 头尾已覆盖全部内容时无需截取，直接返回原文
    if (headLength + tailLength >= characters.length) {
        return stripToolLocalMetadata(message);
    }
    const tailStart = Math.max(headLength, characters.length - tailLength);
    const head = characters.slice(0, headLength).join('');
    const tail = characters.slice(tailStart).join('');
    const omittedTokens = Math.max(originalTokens - estimateTextTokens(head) - estimateTextTokens(tail), 0);
    const content = [
        `[工具结果已截取：原始约 ${originalTokens} tokens，省略约 ${omittedTokens} tokens]`,
        head,
        tailStart > headLength ? '...（中间内容已省略）...' : '',
        tailStart > headLength ? tail : '',
    ].filter(Boolean).join('\n');

    return { ...stripToolLocalMetadata(message), content } as ChatMessage;
}

/** 将模型请求中的工具消息统一投影，保留原始数组不变。 */
export function projectChatMessagesForPrompt(
    messages: readonly ChatMessage[],
    options: ToolResultProjectionOptions = {},
): ChatMessage[] {
    return messages.map((message) => projectToolMessageForPrompt(message, options));
}
