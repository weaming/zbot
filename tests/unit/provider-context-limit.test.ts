/**
 * 上游超窗口径识别：不同 provider 的 400 文案不同，
 * 漏识别会让「越窗后压缩重试」完全失效，回合直接以 400 结束。
 */

import { describe, expect, test } from "bun:test";
import { getPromptTooLongLimit, isInvalidAssistantMessageError, isRequestBodyTooLargeError } from "../../src/utils/provider-context-limit.js";

const deepseekOverflow = new Error(
    "LLM provider 请求失败（HTTP 400）：400 This model's maximum context length is 1048576 tokens. "
    + "However, you requested 1064363 tokens (1064363 in the messages, 0 in the completion). "
    + "Please reduce the length of the messages or completion.",
);

describe("getPromptTooLongLimit", () => {
    test("413 字节限制与 token 超窗独立识别，显式状态码优先", () => {
        expect(isRequestBodyTooLargeError(Object.assign(new Error("request too large"), { status: 413 }))).toBe(true);
        expect(isRequestBodyTooLargeError(new Error("413 Failed to buffer the request body: length limit exceeded"))).toBe(true);
        expect(isRequestBodyTooLargeError("LLM provider 请求失败（HTTP 413）：length limit exceeded")).toBe(true);
        expect(isRequestBodyTooLargeError(Object.assign(new Error("413 upstream text"), { status: 500 }))).toBe(false);
        expect(isRequestBodyTooLargeError(new Error("4130 tokens"))).toBe(false);
        expect(isRequestBodyTooLargeError(deepseekOverflow)).toBe(false);
        expect(getPromptTooLongLimit(new Error("413 request too large"))).toBeUndefined();
    });

    test("OpenAI / DeepSeek 文案返回模型窗口上限", () => {
        expect(getPromptTooLongLimit(deepseekOverflow)).toBe(1_048_576);
    });

    test("Anthropic 文案返回窗口上限", () => {
        const error = Object.assign(new Error("prompt is too long: 208,310 tokens > 200,000 maximum"), { status: 400 });
        expect(getPromptTooLongLimit(error)).toBe(200_000);
    });

    test("请求量未超上限或不是 400 时不算越窗", () => {
        expect(getPromptTooLongLimit(
            new Error("400 maximum context length is 1048576 tokens. However, you requested 1000 tokens"),
        )).toBeUndefined();
        expect(getPromptTooLongLimit(
            new Error("500 maximum context length is 1048576 tokens. However, you requested 1064363 tokens"),
        )).toBeUndefined();
        expect(getPromptTooLongLimit(new Error("network timeout"))).toBeUndefined();
    });

    test("空 assistant 消息的 400 仍走各自的识别分支", () => {
        expect(isInvalidAssistantMessageError(
            new Error("400 Invalid assistant message: content or tool_calls must be set"),
        )).toBe(true);
        expect(isInvalidAssistantMessageError(deepseekOverflow)).toBe(false);
    });
});
