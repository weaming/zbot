import { describe, expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { padColumns } from "../format/text.js";
import { ShortcutPanel } from "./shortcut-panel.js";
import { SHORTCUT_GROUPS } from "../commands/shortcuts.js";

const ESCAPE = "\x1b";
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const CTRL_SLASH = "\x1b[47;5u";
const CTRL_UNDERSCORE = "\x1f";
const F1 = "\x1bOP";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const PAGE_DOWN = "\x1b[6~";
const WHEEL_DOWN = "\x1b[<65;10;5M";
const WHEEL_UP = "\x1b[<64;10;5M";

/** 面板总行数：分组标题 + 条目 + 分组间空行。 */
const TOTAL_ROWS = SHORTCUT_GROUPS.reduce((sum, group) => sum + group.entries.length + 1, 0)
    + SHORTCUT_GROUPS.length - 1;

function makePanel(visibleRows = 5): { panel: ShortcutPanel; calls: string[] } {
    const calls: string[] = [];
    const panel = new ShortcutPanel({ visibleRows, close: () => calls.push("close") });
    return { panel, calls };
}

function renderText(panel: ShortcutPanel, width = 70): string {
    return panel.render(width).map(stripTerminalSequences).join("\n");
}

describe("快捷键面板", () => {
    test("渲染分组标题、条目与滚动范围", () => {
        const { panel } = makePanel();
        const output = renderText(panel);

        expect(output).toContain(`⌨ 快捷键 · 1-5/${TOTAL_ROWS}`);
        expect(output).toContain("▌主界面 · 会话");
        expect(output).toContain("⌘P / ⌃P");
        expect(output).toContain("会话面板");
        expect(output).toContain("Esc 关闭");
    });

    test("↑↓ 与 j/k 滚动一行", () => {
        const { panel } = makePanel();

        panel.handleInput(DOWN);
        expect(renderText(panel)).toContain(`⌨ 快捷键 · 2-6/${TOTAL_ROWS}`);

        panel.handleInput("j");
        expect(renderText(panel)).toContain(`⌨ 快捷键 · 3-7/${TOTAL_ROWS}`);

        panel.handleInput("k");
        panel.handleInput(UP);
        expect(renderText(panel)).toContain(`⌨ 快捷键 · 1-5/${TOTAL_ROWS}`);
    });

    test("顶部继续上滚保持不变", () => {
        const { panel } = makePanel();

        panel.handleInput(UP);
        panel.handleInput(WHEEL_UP);
        expect(renderText(panel)).toContain(`⌨ 快捷键 · 1-5/${TOTAL_ROWS}`);
    });

    test("⌃D / ⌃U 与 PgDn / PgUp 翻页", () => {
        const { panel } = makePanel();

        panel.handleInput(CTRL_D);
        expect(renderText(panel)).toContain(`⌨ 快捷键 · 6-10/${TOTAL_ROWS}`);

        panel.handleInput(PAGE_DOWN);
        expect(renderText(panel)).toContain(`⌨ 快捷键 · 11-15/${TOTAL_ROWS}`);

        panel.handleInput(CTRL_D);
        panel.handleInput(PAGE_DOWN);
        expect(renderText(panel)).toContain(`⌨ 快捷键 · 21-25/${TOTAL_ROWS}`);
    });

    test("底部翻页停在最后一行", () => {
        const { panel } = makePanel();

        for (let index = 0; index < 20; index += 1) panel.handleInput(PAGE_DOWN);
        expect(renderText(panel)).toContain(`⌨ 快捷键 · ${TOTAL_ROWS - 4}-${TOTAL_ROWS}/${TOTAL_ROWS}`);
    });

    test("鼠标滚轮滚动三行", () => {
        const { panel } = makePanel();

        panel.handleInput(WHEEL_DOWN);
        expect(renderText(panel)).toContain(`⌨ 快捷键 · 4-8/${TOTAL_ROWS}`);

        panel.handleInput(WHEEL_UP);
        expect(renderText(panel)).toContain(`⌨ 快捷键 · 1-5/${TOTAL_ROWS}`);
    });

    test("Esc / Ctrl+C / Ctrl+/ / F1 关闭面板", () => {
        const { panel, calls } = makePanel();

        panel.handleInput(ESCAPE);
        panel.handleInput(CTRL_C);
        panel.handleInput(CTRL_SLASH);
        panel.handleInput(F1);

        expect(calls).toEqual(["close", "close", "close", "close"]);
    });

    test("legacy 的 0x1f（Ctrl+/ 与 Ctrl+- 同码）不关闭面板，避免遮蔽编辑器撤销", () => {
        const { panel, calls } = makePanel();

        panel.handleInput(CTRL_UNDERSCORE);
        expect(calls).toEqual([]);
    });

    test("窄宽度下每行不超宽且以省略号收尾", () => {
        const { panel } = makePanel(TOTAL_ROWS);
        const lines = panel.render(40);

        expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
        expect(stripTerminalSequences(lines.join("\n"))).toContain("…");
    });

    test("未识别按键不改变滚动位置", () => {
        const { panel } = makePanel();

        panel.handleInput("\x07");
        expect(renderText(panel)).toContain(`⌨ 快捷键 · 1-5/${TOTAL_ROWS}`);
    });

    test("快捷键表覆盖所有分组，组内键位不重复", () => {
        expect(SHORTCUT_GROUPS.length).toBeGreaterThanOrEqual(5);
        for (const group of SHORTCUT_GROUPS) {
            expect(group.title.length).toBeGreaterThan(0);
            expect(group.entries.length).toBeGreaterThan(0);
            const keys = group.entries.map((entry) => entry.keys);
            expect(new Set(keys).size).toBe(keys.length);
            for (const entry of group.entries) {
                expect(entry.keys.trim().length).toBeGreaterThan(0);
                expect(entry.desc.trim().length).toBeGreaterThan(0);
            }
        }
        expect(SHORTCUT_GROUPS.flatMap((group) => group.entries).length).toBeGreaterThanOrEqual(30);
    });

    test("不收录被视口抢走的键位（Home / End、⌃↑ / ⌃↓）", () => {
        const all = SHORTCUT_GROUPS.flatMap((group) => group.entries);
        expect(all.some((entry) => entry.keys.includes("Home"))).toBe(false);
        expect(all.some((entry) => entry.keys.includes("⌃↑") || entry.keys.includes("⌃↓"))).toBe(false);
    });
});

describe("面板文本对齐", () => {
    test("padColumns 按可见列宽补齐（中文占两列）", () => {
        expect(padColumns("⌃R", 6)).toBe("⌃R    ");
        expect(padColumns("会话", 6)).toBe("会话  ");
        expect(padColumns("⌃⇧R", 3)).toBe("⌃⇧R");
    });
});
