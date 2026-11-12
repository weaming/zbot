/**
 * 模型面板：provider → 模型（含手输）→ 思考强度 → 是否设为默认，全程键盘完成。
 * 强度列表取**目标模型**的档位（与命令行同一份 `effortChoicesFor`）。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { ModelPanel } from "./model-panel.js";
import { useConfig } from "../../tests/unit/test-config.js";

const ENTER = "\r";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const BACKSPACE = "\x7f";

const PROVIDERS = [
    { name: "deepseek", protocol: "chat_completions" as const, models: ["deepseek-chat"] },
    { name: "openai", protocol: "responses" as const, models: ["gpt-5"] },
];

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

function makePanel(current?: {
    provider: string;
    protocol: "chat_completions" | "responses";
    model: string;
    reasoningEffort?: string;
}) {
    const completed: Array<{ selection: any; makeDefault: boolean }> = [];
    const panel = new ModelPanel({
        providers: PROVIDERS,
        options: OPTIONS,
        ...(current ? { current } : {}),
        visibleRows: 12,
        close: () => undefined,
        complete: (selection, makeDefault) => { completed.push({ selection, makeDefault }); },
    });
    return { panel, completed };
}

function screen(panel: ModelPanel): string {
    return stripTerminalSequences(panel.render(80).join("\n"));
}

/** 先回到列表顶部，再逐行下移到文本匹配的那一行。 */
function moveTo(panel: ModelPanel, text: string): void {
    for (let index = 0; index < 16; index += 1) panel.handleInput(UP);
    for (let index = 0; index < 16; index += 1) {
        if (screen(panel).includes(`❯ ${text}`)) return;
        panel.handleInput(DOWN);
    }
    throw new Error(`找不到选项：${text}\n${screen(panel)}`);
}

describe("ModelPanel", () => {
    test("四步菜单：provider → 模型 → 强度 → 是否设为默认", () => {
        const { panel, completed } = makePanel();

        expect(screen(panel)).toContain("1/4 选择 provider");
        panel.handleInput(ENTER); // deepseek
        expect(screen(panel)).toContain("2/4 选择模型");
        moveTo(panel, "deepseek-chat");
        panel.handleInput(ENTER);
        expect(screen(panel)).toContain("3/4 选择思考强度");

        moveTo(panel, "high");
        panel.handleInput(ENTER);
        expect(screen(panel)).toContain("4/4 设为默认模型？");
        moveTo(panel, "是（同时设为默认模型）");
        panel.handleInput(ENTER);

        expect(completed).toEqual([{
            selection: {
                provider: "deepseek",
                protocol: "chat_completions",
                model: "deepseek-chat",
                reasoningEffort: "high",
            },
            makeDefault: true,
        }]);
    });

    test("强度列表来自目标模型：切到 openai 时没有 max、有 medium", () => {
        const { panel } = makePanel();
        panel.handleInput(ENTER); // deepseek
        moveTo(panel, "deepseek-chat");
        panel.handleInput(ENTER);
        expect(screen(panel)).toContain("max");
        panel.handleInput(BACKSPACE); // 回模型步
        panel.handleInput(BACKSPACE); // 回 provider 步
        moveTo(panel, "openai");
        panel.handleInput(ENTER);
        moveTo(panel, "gpt-5");
        panel.handleInput(ENTER);

        const effortScreen = screen(panel);
        expect(effortScreen).toContain("medium");
        expect(effortScreen).not.toContain("max");
    });

    test("默认高亮当前档位；目标不支持时落到 auto", () => {
        // deepseek 支持 max
        const supported = makePanel({
            provider: "deepseek",
            protocol: "chat_completions",
            model: "deepseek-chat",
            reasoningEffort: "max",
        });
        supported.panel.handleInput(ENTER);
        moveTo(supported.panel, "deepseek-chat");
        supported.panel.handleInput(ENTER);
        expect(screen(supported.panel)).toContain("❯ max");

        // openai 不支持 max → 默认高亮 auto
        const fallback = makePanel({
            provider: "openai",
            protocol: "responses",
            model: "gpt-5",
            reasoningEffort: "max",
        });
        fallback.panel.handleInput(DOWN); // 当前 provider 已是第一项，↓ 到 openai
        fallback.panel.handleInput(ENTER);
        moveTo(fallback.panel, "gpt-5");
        fallback.panel.handleInput(ENTER);
        expect(screen(fallback.panel)).toContain("❯ auto");
    });

    test("当前档位大小写不敏感：HIGH 归一化到 high，而不是落到 none", () => {
        const completed: Array<{ selection: any }> = [];
        const panel = new ModelPanel({
            providers: PROVIDERS,
            options: OPTIONS,
            current: {
                provider: "openai",
                protocol: "responses",
                model: "gpt-5",
                reasoningEffort: "HIGH",
            },
            visibleRows: 12,
            close: () => undefined,
            complete: selection => { completed.push({ selection }); },
        });
        panel.handleInput(ENTER);
        moveTo(panel, "gpt-5");
        panel.handleInput(ENTER);
        expect(screen(panel)).toContain("❯ high");
        panel.handleInput(ENTER);
        panel.handleInput(ENTER);
        expect(completed.at(-1)?.selection.reasoningEffort).toBe("high");
    });

    test("手输模型：临时模型跳过「设为默认」这一步", () => {
        const { panel, completed } = makePanel();
        panel.handleInput(ENTER); // deepseek
        moveTo(panel, "自定义模型…");
        panel.handleInput(ENTER);
        expect(screen(panel)).toContain("2/4 手输模型");

        for (const char of "deepseek-v9") panel.handleInput(char);
        expect(screen(panel)).toContain("deepseek-v9");
        panel.handleInput(ENTER);
        expect(screen(panel)).toContain("3/4 选择思考强度");

        moveTo(panel, "high");
        panel.handleInput(ENTER);

        expect(completed).toEqual([{
            selection: {
                provider: "deepseek",
                protocol: "chat_completions",
                model: "deepseek-v9",
                reasoningEffort: "high",
            },
            makeDefault: false,
        }]);
    });

    test("手输里 Backspace 删字符而不是返回", () => {
        const { panel } = makePanel();
        panel.handleInput(ENTER);
        moveTo(panel, "自定义模型…");
        panel.handleInput(ENTER);
        for (const char of "abc") panel.handleInput(char);
        panel.handleInput(BACKSPACE);
        expect(screen(panel)).toContain("2/4 手输模型");
        expect(screen(panel)).toContain("ab█");
    });

    test("Backspace 逐级返回；Esc 关闭", () => {
        let closed = 0;
        const panel = new ModelPanel({
            providers: PROVIDERS,
            options: OPTIONS,
            visibleRows: 12,
            close: () => { closed += 1; },
            complete: () => undefined,
        });
        panel.handleInput(ENTER);
        expect(screen(panel)).toContain("2/4 选择模型");
        panel.handleInput(ENTER);
        expect(screen(panel)).toContain("3/4 选择思考强度");
        panel.handleInput(BACKSPACE);
        expect(screen(panel)).toContain("2/4 选择模型");
        panel.handleInput(BACKSPACE);
        expect(screen(panel)).toContain("1/4 选择 provider");
        panel.handleInput("\x1b");
        expect(closed).toBe(1);
    });
});
