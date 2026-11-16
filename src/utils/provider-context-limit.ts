/**
 * 各家超窗文案不一致，匹配时分别取「请求量」与「窗口上限」两个分组：
 * - Anthropic：`prompt is too long: 208310 tokens > 200000 maximum`
 * - OpenAI/DeepSeek：`This model's maximum context length is 1048576 tokens. However, you requested 1064363 tokens`
 */
const PROMPT_TOO_LONG_PATTERNS: Array<{
    pattern: RegExp;
    requestedGroup: number;
    maximumGroup: number;
}> = [
    {
        pattern: /prompt is too long:\s*([\d,]+)\s*tokens\s*>\s*([\d,]+)\s*maximum/i,
        requestedGroup: 1,
        maximumGroup: 2,
    },
    {
        pattern: /maximum context length is ([\d,]+) tokens[\s\S]*?you requested ([\d,]+) tokens/i,
        requestedGroup: 2,
        maximumGroup: 1,
    },
];

/** 请求体字节限制独立于模型 token 窗口，不能按 token 超窗文案判断。 */
export function isRequestBodyTooLargeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const status = typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status?: unknown }).status)
        : undefined;
    return Number.isFinite(status)
        ? status === 413
        : /(?:^\s*413\b|\bHTTP\s+413\b)/i.test(message);
}

/** 识别 provider 明确返回的 HTTP 400 输入超窗错误，并读取实际窗口上限。 */
export function getPromptTooLongLimit(error: unknown): number | undefined {
    const message = error instanceof Error ? error.message : String(error);
    const explicitStatus = typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status?: unknown }).status)
        : undefined;
    const isBadRequest = Number.isFinite(explicitStatus)
        ? explicitStatus === 400
        : /(?:^\s*400\b|\bHTTP\s+400\b)/i.test(message);
    if (!isBadRequest) return undefined;

    for (const { pattern, requestedGroup, maximumGroup } of PROMPT_TOO_LONG_PATTERNS) {
        const match = message.match(pattern);
        if (!match) continue;
        const requested = Number(match[requestedGroup]!.replaceAll(",", ""));
        const maximum = Number(match[maximumGroup]!.replaceAll(",", ""));
        if (!Number.isSafeInteger(requested) || !Number.isSafeInteger(maximum) || maximum <= 0) return undefined;
        return requested > maximum ? maximum : undefined;
    }
    return undefined;
}

/** 仅识别上游明确拒绝空 assistant 消息的 HTTP 400。 */
export function isInvalidAssistantMessageError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const status = typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status?: unknown }).status)
        : undefined;
    const isBadRequest = Number.isFinite(status)
        ? status === 400
        : /(?:^\s*400\b|\bHTTP\s+400\b)/i.test(message);
    return isBadRequest && /Invalid assistant message:\s*content or tool_calls must be set/i.test(message);
}
