/**
 * 真实分词器（DeepSeek V4 tokenizer.json）计数：精度对齐、缓存与回退。
 *
 * preload（tests/unit/env-isolation.ts）默认 `runtime.tokenizer: false`，
 * 本文件用带 tokenizer 开关的临时配置走真实分词路径。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultTestConfig, useConfig } from "./test-config.js";

/** 每个用例前装上「真分词开启」的配置，用例内可再改装。 */
let restoreConfig: (() => void) | undefined;

const {
    countTextTokens,
    countMessagesTokens,
    countTurnsTokens,
    loadTokenizer,
    supportsRealTokenizer,
} = await import("../../src/utils/tokenizer.js");
const { estimateTextTokens } = await import("../../src/utils/token-estimator.js");
const { createEmptySession } = await import("../../src/events/session-replay.js");
const { appendCompletedTurn } = await import("../../src/utils/conversation-history.js");

beforeEach(() => {
    restoreConfig?.();
    restoreConfig = useConfig(defaultTestConfig({ runtime: { tokenizer: true, memoryUserId: 0 } })).restore;
});

afterEach(() => {
    restoreConfig?.();
    restoreConfig = undefined;
});

describe("真实分词器计数", () => {
    test("词表可加载，计数与官方绑定一致", async () => {
        expect(await loadTokenizer()).not.toBeNull();
        // 同一句在 HF 官方 Python 绑定（tokenizers.Tokenizer.from_file）里也是 21
        expect(await countTextTokens("上下文压缩的触发判定必须准确，否则请求会超过模型窗口并返回 400 错误。"))
            .toBe(21);
    });

    test("启发式在 JSON / 工具结果上低估，真分词纠正", async () => {
        const json = '{"count": 12, "items": [{"id": "01J8Z", "title": "重构 session 模块", "score": 0.87}, {"id": "01J9A", "title": "写测试", "score": 0.51}]}';

        expect(await countTextTokens(json)).toBe(61);
        // 低估方向正是「估算没到阈值、真实请求捅穿窗口」的那类内容
        expect(estimateTextTokens(json)).toBeLessThan(61);
    });

    test("回合计数包含 failed 回合，且按消息 id 复用结果", async () => {
        const session = createEmptySession("sess-tokenizer-turns");
        appendCompletedTurn(session, ["问题"], [{ role: "assistant", content: "回答" }], true);
        appendCompletedTurn(session, ["失败的问题"], [{ role: "assistant", content: "失败的回答" }], false);
        session.turns[1]!.status = "failed";

        const counted = await countTurnsTokens(session.turns);
        // 第二次走缓存，值不变
        expect(await countTurnsTokens(session.turns)).toBe(counted);
        expect(counted).toBeGreaterThan(0);
        const first = await countTurnsTokens([session.turns[0]!]);
        const failed = await countTurnsTokens([session.turns[1]!]);
        expect(failed).toBeGreaterThan(0);
        expect(counted).toBe(first + failed);
    });

    test("非 DeepSeek 模型回退启发式（各家 tokenizer 不同）", async () => {
        expect(supportsRealTokenizer("deepseek-chat")).toBe(true);
        expect(supportsRealTokenizer("gemini-2.5-pro")).toBe(false);

        const text = "上下文压缩的触发判定";
        expect(await countTextTokens(text, "gemini-2.5-pro")).toBe(estimateTextTokens(text));
    });

    test("runtime.tokenizer=false 时整体回退启发式", async () => {
        restoreConfig?.();
        restoreConfig = useConfig(defaultTestConfig({
            runtime: { tokenizer: false, memoryUserId: 0 },
        })).restore;
        const text = "上下文压缩的触发判定";
        expect(await countTextTokens(text)).toBe(estimateTextTokens(text));
    });

    test("assistant 的 reasoning_content 与工具结果里的图片都计入消息总量", async () => {
        const plain = await countMessagesTokens([{ role: "assistant", content: "回答" }]);
        const withReasoning = await countMessagesTokens([{
            role: "assistant",
            content: "回答",
            // 思维链随 assistant 消息上行，上游按输入计费；漏算会让压缩判定严重低估
            reasoning_content: "先把问题拆成三步，再逐步核对每个条件是否成立。",
        } as any]);
        expect(withReasoning).toBeGreaterThan(plain);

        const textOnly = await countMessagesTokens([{ role: "tool", tool_call_id: "call-1", content: "截图已保存" }]);
        const withImage = await countMessagesTokens([{
            role: "tool",
            tool_call_id: "call-1",
            content: "截图已保存",
            imageContent: [{ type: "image_url", image_url: { url: "shot.png" } }],
        } as any]);
        // 图片无法本地分词，按固定档位估值
        expect(withImage - textOnly).toBe(1_100);
    });

    test("user 消息里的图片（内容数组）同样计入，不因不是字符串而漏算", async () => {
        const textOnly = await countMessagesTokens([{ role: "user", content: "看这张图" }]);
        const withImage = await countMessagesTokens([{
            role: "user",
            content: [
                { type: "text", text: "看这张图" },
                { type: "image_url", image_url: { url: "shot.png" } },
            ],
        } as any]);

        expect(withImage - textOnly).toBe(1_100);
    });
});
