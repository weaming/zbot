import { describe, expect, test } from "bun:test";
import { isResponsesStoreEnabled, isResponsesWebSocketEnabled, protocolStatusLabel } from "./responses-transport.js";

describe("Responses WebSocket 开关", () => {
    test("未配置时按模型名启发式：gpt 系走 WS，其余走 HTTP", () => {
        expect(isResponsesWebSocketEnabled(undefined, "gpt-5")).toBe(true);
        expect(isResponsesWebSocketEnabled(undefined, "openai/gpt-5")).toBe(true);
        expect(isResponsesWebSocketEnabled(undefined, "deepseek-v4")).toBe(false);
        expect(isResponsesStoreEnabled(undefined)).toBe(false);
    });

    test("显式配置优先", () => {
        expect(isResponsesWebSocketEnabled(false, "gpt-5")).toBe(false);
        expect(isResponsesWebSocketEnabled(true, "deepseek-v4")).toBe(true);
        expect(isResponsesStoreEnabled(true)).toBe(true);
        expect(isResponsesStoreEnabled(false)).toBe(false);
    });

    test("状态栏按协议和开关显示传输方式", () => {
        expect(protocolStatusLabel("responses", "deepseek-v4", true)).toBe("Responses in WS");
        expect(protocolStatusLabel("responses", "gpt-5", false)).toBe("Responses");
        expect(protocolStatusLabel("responses", "gpt-5")).toBe("Responses in WS");
        expect(protocolStatusLabel("chat_completions")).toBe("Chat");
    });
});
