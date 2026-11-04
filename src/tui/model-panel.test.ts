/**
 * 模型面板：协议 → 模型 → 思考强度 → 是否设为默认，全程键盘完成模型+强度配置。
 * 强度列表取**目标模型**的档位（与命令行同一份 `effortChoicesFor`）。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { ModelPanel } from "./model-panel.js";

const ENTER = "\r";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const BACKSPACE = "\x7f";

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

function makePanel(current?: { protocol: "chat_completions" | "responses"; model: string; reasoningEffort?: string }) {
    const completed: Array<{ selection: any; makeDefault: boolean }> = [];
    const panel = new ModelPanel({
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
    test("四步菜单：协议 → 模型 → 强度 → 是否设为默认", () => {
        const { panel, completed } = makePanel();

        expect(screen(panel)).toContain("1/4 选择协议");
        panel.handleInput(ENTER); // Chat Completions
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
            selection: { protocol: "chat_completions", model: "deepseek-chat", reasoningEffort: "high" },
            makeDefault: true,
        }]);
    });

    test("强度列表来自目标模型：切到 responses 时没有 max、有 medium", () => {
        const { panel } = makePanel();
        panel.handleInput(ENTER); // Chat Completions
        moveTo(panel, "deepseek-chat");
        panel.handleInput(ENTER);
        expect(screen(panel)).toContain("max");
        panel.handleInput(BACKSPACE); // 回模型步
        panel.handleInput(BACKSPACE); // 回协议步
        moveTo(panel, "Responses API");
        panel.handleInput(ENTER);
        moveTo(panel, "gpt-5");
        panel.handleInput(ENTER);

        const effortScreen = screen(panel);
        expect(effortScreen).toContain("medium");
        expect(effortScreen).not.toContain("max");
    });

    test("默认高亮当前档位；目标不支持时落到 auto", () => {
        // deepseek 支持 max
        const supported = makePanel({ protocol: "chat_completions", model: "deepseek-chat", reasoningEffort: "max" });
        supported.panel.handleInput(ENTER);
        moveTo(supported.panel, "deepseek-chat");
        supported.panel.handleInput(ENTER);
        expect(screen(supported.panel)).toContain("❯ max");

        // responses 不支持 max → 默认高亮 auto
        const fallback = makePanel({ protocol: "responses", model: "gpt-5", reasoningEffort: "max" });
        fallback.panel.handleInput(DOWN); // Responses API（当前协议已在第一项，↓ 到第二项）
        fallback.panel.handleInput(ENTER);
        moveTo(fallback.panel, "gpt-5");
        fallback.panel.handleInput(ENTER);
        expect(screen(fallback.panel)).toContain("❯ auto");
    });

    test("当前档位大小写不敏感：HIGH 归一化到 high，而不是落到 none", () => {
        const completed: Array<{ selection: any }> = [];
        const panel = new ModelPanel({
            options: OPTIONS,
            current: { protocol: "responses", model: "gpt-5", reasoningEffort: "HIGH" } as any,
            visibleRows: 12,
            close: () => undefined,
            complete: selection => { completed.push({ selection }); },
        });
        panel.handleInput(DOWN); // Responses
        panel.handleInput(ENTER);
        moveTo(panel, "gpt-5");
        panel.handleInput(ENTER);
        expect(screen(panel)).toContain("❯ high");
        panel.handleInput(ENTER);
        panel.handleInput(ENTER);
        expect(completed.at(-1)?.selection.reasoningEffort).toBe("high");
    });

    test("Backspace 逐级返回；Esc 关闭", () => {
        let closed = 0;
        const panel = new ModelPanel({
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
        expect(screen(panel)).toContain("1/4 选择协议");
        panel.handleInput("\x1b");
        expect(closed).toBe(1);
    });
});
