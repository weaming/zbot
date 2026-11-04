/**
 * 快捷键面板：Ctrl+/ 或 F1 打开，只读展示全部快捷键。
 * 内容无操作项，故不做行选中——↑↓ / jk 滚动一行，PgUp / PgDn / Ctrl+U / Ctrl+D 翻页，
 * 鼠标滚轮同样翻动；Esc / Ctrl+C / Ctrl+/ / F1 关闭。面板打开时独占键盘输入。
 */

import { Key, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { PanelBody } from "./panel-body.js";
import { handlePanelScroll } from "./panel-scroll.js";
import { padColumns, truncatePlain } from "../format/text.js";
import { SHORTCUT_GROUPS } from "../commands/shortcuts.js";
import { theme } from "./theme.js";

/** 键位列宽度（按最长键位 + 2 列间隔取整，保证描述列左对齐）。 */
const KEY_COLUMN = 13;
/** 条目缩进（分组标题不缩进，形成层级）。 */
const ENTRY_INDENT = "  ";

type Row =
    | { kind: "group"; title: string }
    | { kind: "entry"; keys: string; desc: string }
    | { kind: "gap" };

/** 把分组表拍平为可滚动行序列，分组之间插入空行分隔。 */
function flattenRows(): Row[] {
    const rows: Row[] = [];
    for (const group of SHORTCUT_GROUPS) {
        if (rows.length > 0) rows.push({ kind: "gap" });
        rows.push({ kind: "group", title: group.title });
        for (const entry of group.entries) {
            rows.push({ kind: "entry", keys: entry.keys, desc: entry.desc });
        }
    }
    return rows;
}

export interface ShortcutPanelOptions {
    /** 一次最多显示的内容行数（由终端高度推算，超出滚动）。 */
    visibleRows: number;
    close(): void;
}

export class ShortcutPanel implements Component {
    private readonly root = new PanelBody();
    private readonly header = new Text("", 1, 0);
    private readonly footer = new Text("", 1, 0);
    private readonly rows = flattenRows();
    private scrollTop = 0;

    constructor(private readonly options: ShortcutPanelOptions) {}

    /** 独占键盘输入；未识别的按键被忽略，避免误落到输入框。 */
    handleInput(data: string): void {
        if (
            matchesKey(data, Key.escape)
            || matchesKey(data, Key.ctrl("c"))
            || matchesKey(data, Key.f1)
            || matchesKey(data, Key.ctrl("/"))
        ) {
            this.options.close();
            return;
        }
        handlePanelScroll(data, {
            pageSize: this.options.visibleRows,
            scrollBy: (delta) => this.scrollBy(delta),
        });
    }

    render(width: number): string[] {
        this.rebuild(width);
        return this.root.render(width);
    }

    invalidate(): void {
        this.root.invalidate();
    }

    private scrollBy(delta: number): void {
        const maxTop = Math.max(0, this.rows.length - this.options.visibleRows);
        const next = Math.max(0, Math.min(this.scrollTop + delta, maxTop));
        if (next === this.scrollTop) return;
        this.scrollTop = next;
        this.root.invalidate();
    }

    private rebuild(width: number): void {
        const windowSize = Math.max(1, Math.min(this.options.visibleRows, this.rows.length));
        const maxTop = Math.max(0, this.rows.length - windowSize);
        this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxTop));
        const visible = this.rows.slice(this.scrollTop, this.scrollTop + windowSize);

        const lines = visible.map((row) => {
            if (row.kind === "gap") return new Spacer(1);
            if (row.kind === "group") return new Text(theme.statusWarn(`▌${row.title}`), 1, 0);
            return new Text(this.renderEntry(row, width), 1, 0);
        });

        const range = this.rows.length > windowSize
            ? ` · ${this.scrollTop + 1}-${this.scrollTop + visible.length}/${this.rows.length}`
            : "";
        this.header.setText(theme.statusWarn(`⌨ 快捷键${range}`));
        this.footer.setText(theme.dim("↑↓ 滚动 · ⌃U / ⌃D 翻页 · 滚轮 · Esc 关闭"));
        this.root.setChildren([this.header, ...lines, this.footer]);
        this.root.invalidate();
    }

    /** 单行快捷键：`  ⌘P          会话面板（…）`；Text 左右各 1 列内边距，宽度预算先扣掉。 */
    private renderEntry(row: { keys: string; desc: string }, width: number): string {
        const keys = padColumns(truncatePlain(row.keys, KEY_COLUMN), KEY_COLUMN);
        const descBudget = Math.max(4, width - 2 - ENTRY_INDENT.length - KEY_COLUMN);
        return `${ENTRY_INDENT}${theme.commandText(keys)}${truncatePlain(row.desc, descBudget)}`;
    }
}
