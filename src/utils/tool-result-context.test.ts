import { describe, expect, it } from "bun:test";
import {
    projectChatMessagesForPrompt,
    projectToolMessageForPrompt,
    type ToolResultProjectionOptions,
} from "./tool-result-context.js";
import type { ChatMessage, ToolResultPolicy } from "../types/session.js";

const tinyOptions: ToolResultProjectionOptions = {
    thresholdTokens: 10,
    headTokens: 5,
    tailTokens: 5,
};

function toolMessage(content: string, contextPolicy?: ToolResultPolicy): ChatMessage {
    return {
        role: "tool",
        tool_call_id: "call-1",
        content,
        ...(contextPolicy ? { contextPolicy } : {}),
    };
}

describe("projectToolMessageForPrompt", () => {
    it("小工具结果原样保留并剥离 contextPolicy", () => {
        const message = toolMessage("short", { mode: "adaptive" });
        const projected = projectToolMessageForPrompt(message, tinyOptions);

        expect(projected.content).toBe("short");
        expect(projected).not.toHaveProperty("contextPolicy");
    });

    it("超大工具结果按头尾投影并标记省略量", () => {
        const content = "abcdefghijklmnopqrstuvwxyz".repeat(10);
        const projected = projectToolMessageForPrompt(toolMessage(content), tinyOptions);

        expect(projected.content).toContain("[工具结果已截取");
        expect(projected.content).toContain("...（中间内容已省略）...");
        expect(projected.content.length).toBeLessThan(content.length);
        expect(projected.content.startsWith("[工具结果已截取")).toBe(true);
        expect(projected.content.endsWith("xyz")).toBe(true);
    });

    it("mode=full 的工具结果完整保留且剥离 contextPolicy", () => {
        const content = "abcdefghijklmnopqrstuvwxyz".repeat(10);
        const projected = projectToolMessageForPrompt(
            toolMessage(content, { mode: "full" }),
            tinyOptions,
        );

        expect(projected.content).toBe(content);
        expect(projected.content).not.toContain("[工具结果已截取");
        expect(projected).not.toHaveProperty("contextPolicy");
    });

    it("durationMs / isError 是本地渲染元数据，投影时连同 contextPolicy 一起剥离", () => {
        const withDuration: ChatMessage = {
            ...toolMessage("short", { mode: "adaptive" }),
            durationMs: 1234,
            isError: true,
        };
        const projectedAdaptive = projectToolMessageForPrompt(withDuration, tinyOptions);
        expect(projectedAdaptive).not.toHaveProperty("durationMs");
        // isError 不是官方 tool 消息字段，不剥离会被端点拒绝
        expect(projectedAdaptive).not.toHaveProperty("isError");

        // mode=full 的早返回分支同样要剥离
        const fullMessage: ChatMessage = {
            ...toolMessage("x".repeat(200), { mode: "full" }),
            durationMs: 9,
        };
        const projectedFull = projectToolMessageForPrompt(fullMessage, tinyOptions);
        expect(projectedFull).not.toHaveProperty("durationMs");
        expect(projectedFull).not.toHaveProperty("contextPolicy");

        // 两个字段都没有时原样返回同一个对象引用，避免每条消息都新分配
        const plain = toolMessage("short");
        expect(projectToolMessageForPrompt(plain, tinyOptions)).toBe(plain);
    });

    it("非 tool 消息原样返回", () => {
        const message: ChatMessage = { role: "user", content: "hello" };
        expect(projectToolMessageForPrompt(message, tinyOptions)).toBe(message);
    });

    it("头尾覆盖全部内容时直接返回原文（P2-1 回归：不丢尾、无矛盾 banner）", () => {
        const content = "a".repeat(20);
        const overlappingOptions: ToolResultProjectionOptions = {
            thresholdTokens: 4,
            headTokens: 4,
            tailTokens: 4,
        };

        const projected = projectToolMessageForPrompt(toolMessage(content), overlappingOptions);

        expect(projected.content).toBe(content);
        expect(projected.content).not.toContain("[工具结果已截取");
        expect(projected).not.toHaveProperty("contextPolicy");
    });

    it("已投影内容不重复投影（嵌套省略防御）", () => {
        const content = "a".repeat(200);
        const once = projectToolMessageForPrompt(toolMessage(content), tinyOptions);
        const twice = projectToolMessageForPrompt(
            toolMessage(once.content, { mode: "adaptive" }),
            tinyOptions,
        );

        expect(once.content).toContain("[工具结果已截取");
        expect(twice.content).toBe(once.content);
    });
});

describe("projectChatMessagesForPrompt", () => {
    it("批量投影且不修改原始数组", () => {
        const messages = [
            { role: "user" as const, content: "hi" },
            toolMessage("x".repeat(100), { mode: "adaptive" }),
            toolMessage("full-content", { mode: "full" }),
        ];

        const projected = projectChatMessagesForPrompt(messages, tinyOptions);

        expect(projected[0]).toBe(messages[0]);
        expect(projected[1].content).not.toBe(messages[1].content);
        expect(projected[2].content).toBe(messages[2].content);
        expect(messages[1].content).toBe("x".repeat(100));
        expect(messages[2].content).toBe("full-content");
    });
});
