/**
 * `/model` 共享解析：目标模型的档位校验、归一化与强度保留规则。
 * TUI 与 session send 都只经由这里，契约在这里锁死。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { effortChoicesFor, resolveModelUse } from "./slash-model.js";
import { useConfig } from "../../tests/unit/test-config.js";

const OPTIONS = [
    { provider: "deepseek", protocol: "chat_completions" as const, model: "deepseek-chat" },
    { provider: "openai", protocol: "responses" as const, model: "gpt-5" },
];

let restore: () => void;

beforeEach(() => {
    restore = useConfig({
        providers: {
            deepseek: {
                protocol: "chat_completions",
                baseUrl: "https://api.deepseek.com/v1",
                apiKey: "k",
                models: ["deepseek-chat"],
            },
            openai: {
                protocol: "responses",
                baseUrl: "https://api.openai.com/v1",
                apiKey: "k",
                models: ["gpt-5"],
            },
        },
        defaults: { provider: "deepseek", model: "deepseek-chat" },
        runtime: { tokenizer: false },
    }).restore;
});

afterEach(() => restore());

describe("resolveModelUse", () => {
    test("两套档位确实不同：目标模型的取值按目标配置判定", () => {
        expect(effortChoicesFor("deepseek", "deepseek-chat")).toContain("max");
        expect(effortChoicesFor("deepseek", "deepseek-chat")).not.toContain("medium");
        expect(effortChoicesFor("openai", "gpt-5")).toContain("medium");
        expect(effortChoicesFor("openai", "gpt-5")).not.toContain("max");
    });

    test("按目标模型校验并归一化强度", () => {
        const ok = resolveModelUse(OPTIONS, "openai", "gpt-5", "MEDIUM", "max");
        expect(ok).toEqual({
            ok: true,
            selection: { provider: "openai", protocol: "responses", model: "gpt-5", reasoningEffort: "medium" },
        });

        // 目标模型没有 max：即便当前模型支持也必须拒绝
        const bad = resolveModelUse(OPTIONS, "openai", "gpt-5", "max", "max");
        expect(bad.ok).toBe(false);
        if (!bad.ok) expect(bad.error).toContain("未知思考强度");
    });

    test("省略强度：可保留则保留，目标不支持则回落 auto", () => {
        expect(resolveModelUse(OPTIONS, "openai", "gpt-5", undefined, "high")).toEqual({
            ok: true,
            selection: { provider: "openai", protocol: "responses", model: "gpt-5", reasoningEffort: "high" },
        });
        expect(resolveModelUse(OPTIONS, "openai", "gpt-5", undefined, "max")).toEqual({
            ok: true,
            selection: { provider: "openai", protocol: "responses", model: "gpt-5", reasoningEffort: "auto" },
        });
    });

    test("model 不在配置里也能用：临时模型只认 provider 与模型名", () => {
        const result = resolveModelUse(OPTIONS, "openai", "gpt-6-preview", undefined, "high");
        expect(result).toEqual({
            ok: true,
            selection: { provider: "openai", protocol: "responses", model: "gpt-6-preview", reasoningEffort: "high" },
        });
    });

    test("provider 不存在或缺模型时给出明确错误", () => {
        const unknown = resolveModelUse(OPTIONS, "nope", "gpt-5", undefined, "high");
        expect(unknown.ok).toBe(false);
        if (!unknown.ok) expect(unknown.error).toContain("没有这个 provider");

        const noModel = resolveModelUse(OPTIONS, "openai", "  ", undefined, "high");
        expect(noModel.ok).toBe(false);
        if (!noModel.ok) expect(noModel.error).toContain("缺少模型");
    });
});
