/**
 * 会话 Tab 条：单行、等宽、溢出窗口化渲染。
 * 纯函数实现便于单测；宽度按显示列计算，中文标题不会被截半个字。
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { truncatePlain } from "../format/text.js";
import { originPrefix } from "../format/session-origin.js";
import { DEFAULT_SPINNER, sessionMarker } from "./session-marker.js";
import { SESSION_NEW_URL, SESSION_PANEL_URL, wrapAppLink, wrapTabLink } from "./slash-commands.js";
import type { SessionOrigin } from "../types/session.js";

/** 单个 tab 的最大列宽：调大则一行放得更少，等宽与美观不受影响。 */
export const TAB_WIDTH_CAP = 20;
/** 单个 tab 的最小列宽，低于此值不再显示更多 tab。 */
const TAB_WIDTH_MIN = 10;
/** 左右溢出指示器（‹N / N›）各预留的列宽。 */
const OVERFLOW_WIDTH = 4;
/** 右侧新建会话按钮（与 Ctrl+N 等效，点击打开新会话）。 */
const ADD_BUTTON = " [+]";
/** 单个 tab 内的固定开销：前导空格 + 序号 + 空格 + 标记 + 标题前空格 + 结尾空格。 */
const TAB_FIXED_WIDTH = 6;

export interface SessionBarTab {
    sessionId: string;
    /** 会话来源：`job`（任务会话）在标题前加 ⚑ 标记。 */
    origin?: SessionOrigin;
    title?: string;
    messageCount: number;
    busy: boolean;
    active: boolean;
    /** 会话挂着未作答的提问：标记显示 `?`（优先级高于运行中）。 */
    question?: boolean;
}

export interface SessionBarStyles {
    active: (text: string) => string;
    inactive: (text: string) => string;
    overflow: (text: string) => string;
    add: (text: string) => string;
}

export interface SessionBarLayout {
    /** 可见 tab 数（0 表示宽度不足，只渲染新建按钮）。 */
    count: number;
    /** 每个可见 tab 的等宽列宽。 */
    tabWidth: number;
}

export interface SessionBarResult extends SessionBarLayout {
    /** 单行渲染结果（含 ANSI 与 OSC 8 链接）。 */
    line: string;
    /** 可见 tab 的会话 id，顺序即 Ctrl+1..9 的顺序。 */
    visibleIds: string[];
    /** 左侧 / 右侧被折叠的会话数。 */
    hiddenLeft: number;
    hiddenRight: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function padTo(text: string, width: number, side: "left" | "right"): string {
    const pad = " ".repeat(Math.max(0, width - visibleWidth(text)));
    return side === "right" ? text + pad : pad + text;
}

/** 按显示列截断纯文本：口径与 format/text 的 truncatePlain 一致（不插 ANSI 复位，免得破坏 tab 背景色）。 */
function truncateTabLabel(text: string, maxWidth: number): string {
    if (maxWidth <= 0) return "";
    return truncatePlain(text, maxWidth);
}

/** 计算可见 tab 数与等宽列宽：先按上限估可见数，需要溢出指示时再扣掉两侧预留。 */
export function layoutSessionBar(tabCount: number, width: number): SessionBarLayout {
    const avail = Math.max(0, Math.floor(width) - visibleWidth(ADD_BUTTON));
    if (tabCount <= 0 || avail < TAB_WIDTH_MIN) {
        return { count: 0, tabWidth: Math.max(1, avail) };
    }

    let count = clamp(Math.floor(avail / TAB_WIDTH_CAP), 1, tabCount);
    let budget = avail;
    if (count < tabCount) {
        budget = Math.max(0, budget - OVERFLOW_WIDTH * 2);
    }
    count = clamp(Math.floor(budget / TAB_WIDTH_CAP), 1, tabCount);
    count = Math.min(count, Math.max(1, Math.floor(budget / TAB_WIDTH_MIN)));

    return { count, tabWidth: clamp(Math.floor(budget / count), 1, TAB_WIDTH_CAP) };
}

/** 渲染单个等宽 tab：序号 + 标记 + 标题（按列截断）+ 消息数，剩余补空格。 */
export function renderSessionTab(tab: SessionBarTab, tabWidth: number, spinner: string, index = 1): string {
    const marker = sessionMarker(tab, spinner);
    // 序号对应 ⌃1..9（只覆盖可见前 9 个），其余用 · 占位，避免误导快捷键
    const label = index >= 1 && index <= 9 ? String(index) : "·";
    let count = tab.messageCount > 0 ? `(${tab.messageCount})` : "";
    let titleWidth = tabWidth - TAB_FIXED_WIDTH - visibleWidth(count);
    if (titleWidth < 4 && count) {
        // 空间不足时先舍弃消息数，保证标题可读。
        count = "";
        titleWidth = tabWidth - TAB_FIXED_WIDTH;
    }
    const title = truncateTabLabel(`${originPrefix(tab.origin)}${tab.title ?? ""}`, titleWidth);
    const text = ` ${label} ${marker} ${title}${count} `;
    return padTo(text, tabWidth, "right");
}

/** 构建整条会话栏：以当前会话为中心开窗，两侧用 ‹N / N› 表示折叠数量。 */
export function buildSessionBar(
    tabs: SessionBarTab[],
    width: number,
    styles: SessionBarStyles,
    spinner = DEFAULT_SPINNER,
): SessionBarResult {
    const { count, tabWidth } = layoutSessionBar(tabs.length, width);
    const addText = wrapAppLink(styles.add(ADD_BUTTON), SESSION_NEW_URL);
    if (count === 0) {
        return { line: addText, visibleIds: [], count: 0, tabWidth, hiddenLeft: 0, hiddenRight: 0 };
    }

    const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.active));
    const start = clamp(activeIndex - Math.floor((count - 1) / 2), 0, Math.max(0, tabs.length - count));
    const visible = tabs.slice(start, start + count);
    const hiddenLeft = start;
    const hiddenRight = tabs.length - start - count;

    const parts: string[] = [];
    if (hiddenLeft > 0) {
        const text = styles.overflow(padTo(`‹${hiddenLeft}`, OVERFLOW_WIDTH, "right"));
        parts.push(wrapAppLink(text, SESSION_PANEL_URL));
    }
    for (const [offset, tab] of visible.entries()) {
        const painted = renderSessionTab(tab, tabWidth, spinner, offset + 1);
        parts.push(wrapTabLink(tab.active ? styles.active(painted) : styles.inactive(painted), tab.sessionId));
    }
    if (hiddenRight > 0) {
        const text = styles.overflow(padTo(`${hiddenRight}›`, OVERFLOW_WIDTH, "left"));
        parts.push(wrapAppLink(text, SESSION_PANEL_URL));
    }
    parts.push(addText);

    return {
        line: parts.join(""),
        visibleIds: visible.map((tab) => tab.sessionId),
        count,
        tabWidth,
        hiddenLeft,
        hiddenRight,
    };
}
