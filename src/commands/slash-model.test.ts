/**
 * `/model` 共享解析：目标模型的档位校验、归一化与强度保留规则。
 * TUI 与 session send 都只经由这里，契约在这里锁死。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { effortChoicesFor, resolveModelUse } from "./slash-model.js";

const OPTIONS = [
    { protocol: "chat_completions" as const, model: "deepseek-chat" },
    { protocol: "responses" as const, model: "gpt-5" },
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
    saved = {
        OPENAI_CHAT_MODEL: process.env.OPENAI_CHAT_MODEL,
        OPENAI_CHAT_BASE_URL: process.env.OPENAI_CHAT_BASE_URL,
        OPENAI_RESPONSES_MODEL: process.env.OPENAI_RESPONSES_MODEL,
        OPENAI_RESPONSES_BASE_URL: process.env.OPENAI_RESPONSES_BASE_URL,
        OPENAI_CHAT_EFFORTS: process.env.OPENAI_CHAT_EFFORTS,
        OPENAI_RESPONSES_EFFORTS: process.env.OPENAI_RESPONSES_EFFORTS,
    };
    process.env.OPENAI_CHAT_MODEL = "deepseek-chat";
    process.env.OPENAI_CHAT_BASE_URL = "https://api.deepseek.com/v1";
    process.env.OPENAI_RESPONSES_MODEL = "gpt-5";
    process.env.OPENAI_RESPONSES_BASE_URL = "https://api.openai.com/v1";
    delete process.env.OPENAI_CHAT_EFFORTS;
    delete process.env.OPENAI_RESPONSES_EFFORTS;
});

afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe("resolveModelUse", () => {
    test("两套档位确实不同：目标模型的取值按目标配置判定", () => {
        expect(effortChoicesFor("chat_completions", "deepseek-chat")).toContain("max");
        expect(effortChoicesFor("chat_completions", "deepseek-chat")).not.toContain("medium");
        expect(effortChoicesFor("responses", "gpt-5")).toContain("medium");
        expect(effortChoicesFor("responses", "gpt-5")).not.toContain("max");
    });

    test("按目标模型校验并归一化强度", () => {
        const ok = resolveModelUse(OPTIONS, "responses", "gpt-5", "MEDIUM", "max");
        expect(ok).toEqual({
            ok: true,
            selection: { protocol: "responses", model: "gpt-5", reasoningEffort: "medium" },
        });

        // 目标模型没有 max：即便当前模型支持也必须拒绝
        const bad = resolveModelUse(OPTIONS, "responses", "gpt-5", "max", "max");
        expect(bad.ok).toBe(false);
        if (!bad.ok) expect(bad.error).toContain("未知思考强度");
    });

    test("省略强度：可保留则保留，目标不支持则回落 auto", () => {
        expect(resolveModelUse(OPTIONS, "responses", "gpt-5", undefined, "high")).toEqual({
            ok: true,
            selection: { protocol: "responses", model: "gpt-5", reasoningEffort: "high" },
        });
        expect(resolveModelUse(OPTIONS, "responses", "gpt-5", undefined, "max")).toEqual({
            ok: true,
            selection: { protocol: "responses", model: "gpt-5", reasoningEffort: "auto" },
        });
    });

    test("组合不在可切换列表里时给出明确错误", () => {
        const result = resolveModelUse(OPTIONS, "responses", "not-configured", undefined, "high");
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("不可用的模型组合");
    });
});
