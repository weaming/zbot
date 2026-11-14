import { describe, expect, test } from "bun:test";
import { isResponsesStoreEnabled, isResponsesWebSocketEnabled, protocolStatusLabel } from "./responses-transport.js";

describe("Responses WebSocket 开关", () => {
    test("未配置时一律走 HTTP", () => {
        expect(isResponsesWebSocketEnabled(undefined)).toBe(false);
        expect(isResponsesStoreEnabled(undefined)).toBe(false);
    });

    test("显式配置才开启 WS", () => {
        expect(isResponsesWebSocketEnabled(false)).toBe(false);
        expect(isResponsesWebSocketEnabled(true)).toBe(true);
        expect(isResponsesStoreEnabled(true)).toBe(true);
        expect(isResponsesStoreEnabled(false)).toBe(false);
    });

    test("状态栏按协议和开关显示传输方式", () => {
        expect(protocolStatusLabel("responses", true)).toBe("Responses in WS");
        expect(protocolStatusLabel("responses", false)).toBe("Responses");
        expect(protocolStatusLabel("responses")).toBe("Responses");
        expect(protocolStatusLabel("chat_completions")).toBe("Chat");
    });
});
