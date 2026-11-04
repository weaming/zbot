/** TUI 命令与纯文本工具：slash 命令表、会话快捷键、单行截断。 */

import { Key } from "@earendil-works/pi-tui";
import type { SlashCommand } from "@earendil-works/pi-tui";
import { isKnownSlashCommand, SLASH_COMMAND_SPECS } from "../commands/slash-command.js";

export { REVIEW_PROMPT } from "../commands/slash-command.js";
export { buildHelpText, buildSkillsHelpText } from "../commands/slash-help.js";

export const SLASH_COMMANDS: SlashCommand[] = SLASH_COMMAND_SPECS.map(({ name, description }) => ({
    name,
    description,
}));



export const SESSION_SHORTCUTS = [
    Key.ctrl("1"),
    Key.ctrl("2"),
    Key.ctrl("3"),
    Key.ctrl("4"),
    Key.ctrl("5"),
    Key.ctrl("6"),
    Key.ctrl("7"),
    Key.ctrl("8"),
    Key.ctrl("9"),
];

export const TAB_LINK_PREFIX = "zbot://session/";
/** 会话面板与新建会话的点击目标（由 TUI 内部处理，不交给系统浏览器）。 */
export const SESSION_PANEL_URL = "zbot://sessions";
export const SESSION_NEW_URL = "zbot://new";
export const SHORTCUT_PANEL_URL = "zbot://keys";

/** Ctrl+C / Ctrl+D 防误退确认窗口（ms）：窗口内再按一次退出键才真正退出。 */
export const EXIT_CONFIRM_MS = 2_000;

/** 把多行文本折叠为单行预览并按可见宽度截断，保留 ANSI 序列外的换行/控制字符。 */
export function truncateInline(text: string, maxColumns: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat.length <= maxColumns) return flat;
    return `${flat.slice(0, Math.max(0, maxColumns - 1))}…`;
}

/** 把文本包装成 OSC 8 超链接，点击后由 TUI 的 openUrl 回调处理。 */
export function wrapAppLink(text: string, url: string): string {
    return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/** 将会话 Tab 包装成由 TUI 处理的 OSC 8 超链接。 */
export function wrapTabLink(text: string, sessionId: string): string {
    return wrapAppLink(text, `${TAB_LINK_PREFIX}${encodeURIComponent(sessionId)}`);
}

export function isValidSlashCommand(text: string): boolean {
    return isKnownSlashCommand(text);
}
