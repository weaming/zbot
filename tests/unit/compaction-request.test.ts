import { describe, expect, test } from "bun:test";
import { runCompactionRequest } from "../../src/services/compaction-request.js";
import type { ChatMessage } from "../../src/types/session.js";

const bodyTooLarge = Object.assign(
    new Error("413 Failed to buffer the request body: length limit exceeded"),
    { status: 413 },
);

describe("runCompactionRequest", () => {
    test("正常压缩只请求一次，保留原响应", async () => {
        const history: ChatMessage[] = [{ role: "user", content: "历史" }];
        const response = { content: "摘要", messages: [], toolCalls: 0 };
        let requests = 0;
        expect(await runCompactionRequest({
            history,
            run: async input => {
                expect(input).toBe(history);
                requests++;
                return response;
            },
        })).toBe(response);
        expect(requests).toBe(1);
    });

    test("413 按 UTF-8 字节平衡拆分，每段原文恰好摘要一次，再合并摘要", async () => {
        const history: ChatMessage[] = [
            { role: "user", content: "中文".repeat(100) },
            { role: "assistant", content: "a".repeat(200) },
            { role: "user", content: "b".repeat(200) },
            { role: "assistant", content: "c".repeat(200) },
        ];
        const requests: ChatMessage[][] = [];
        const response = await runCompactionRequest({
            history,
            run: async input => {
                requests.push(input);
                if (input === history) throw bodyTooLarge;
                return { content: `摘要 ${requests.length}` };
            },
        });
        expect(response.content).toBe("摘要 4");
        expect(requests[1]).toEqual(history.slice(0, 1));
        expect(requests[2]).toEqual(history.slice(1));
        expect(requests[3]?.map(message => message.content).join()).toContain("摘要 2");
        expect(requests[3]?.map(message => message.content).join()).toContain("摘要 3");
        expect(history).toHaveLength(4);
    });

    test("不会在工具调用和并行工具结果之间切分", async () => {
        const history: ChatMessage[] = [
            { role: "user", content: "任务" },
            { role: "assistant", content: null, tool_calls: [{ id: "a" }, { id: "b" }] },
            { role: "tool", tool_call_id: "a", content: "a".repeat(1000) },
            { role: "tool", tool_call_id: "b", content: "b".repeat(1000) },
            { role: "assistant", content: "完成" },
        ];
        const parts: ChatMessage[][] = [];
        await runCompactionRequest({
            history,
            run: async input => {
                if (input === history) throw bodyTooLarge;
                parts.push(input);
                return { content: "摘要" };
            },
        });
        expect(parts[0]?.slice(1)).toEqual(history.slice(1, 4));
        expect(parts[1]).toEqual(history.slice(4));
    });

    test("无法拆分的消息组明确报错，不丢弃数据或无限重试", async () => {
        let requests = 0;
        await expect(runCompactionRequest({
            history: [
                { role: "assistant", content: null, tool_calls: [{ id: "a" }] },
                { role: "tool", tool_call_id: "a", content: "超大结果" },
            ],
            run: async () => { requests++; throw bodyTooLarge; },
        })).rejects.toThrow("无法继续安全拆分");
        expect(requests).toBe(1);
    });

    test("非 413 及空摘要不重试", async () => {
        for (const content of [undefined, "   "]) {
            let requests = 0;
            await expect(runCompactionRequest({
                history: [{ role: "user", content: "第一段" }, { role: "user", content: "第二段" }],
                run: async () => {
                    requests++;
                    if (content === undefined) throw new Error("400 prompt is too long");
                    return { content };
                },
            })).rejects.toThrow(content === undefined ? "prompt is too long" : "结果为空");
            expect(requests).toBe(1);
        }
    });

    test("分段失败不交付部分摘要", async () => {
        let requests = 0;
        await expect(runCompactionRequest({
            history: [{ role: "user", content: "第一段" }, { role: "user", content: "第二段" }],
            run: async () => {
                requests++;
                if (requests === 1) throw bodyTooLarge;
                if (requests === 2) return { content: "第一段摘要" };
                throw new Error("network failure");
            },
        })).rejects.toThrow("network failure");
        expect(requests).toBe(3);
    });

    test("收到分段摘要时取消，不再请求或合并", async () => {
        const controller = new AbortController();
        let requests = 0;
        await expect(runCompactionRequest({
            history: [{ role: "user", content: "第一段" }, { role: "user", content: "第二段" }],
            signal: controller.signal,
            run: async () => {
                requests++;
                if (requests === 1) throw bodyTooLarge;
                controller.abort();
                return { content: "不应交付" };
            },
        })).rejects.toHaveProperty("name", "AbortError");
        expect(requests).toBe(2);
    });

    test("摘要不缩小时总请求数有界", async () => {
        let requests = 0;
        await expect(runCompactionRequest({
            history: [{ role: "user", content: "第一段" }, { role: "user", content: "第二段" }],
            run: async input => {
                requests++;
                if (input.length > 1) throw bodyTooLarge;
                return { content: "不缩小的摘要".repeat(100) };
            },
        })).rejects.toThrow("无法继续安全拆分");
        expect(requests).toBeLessThanOrEqual(32);
    });
});
