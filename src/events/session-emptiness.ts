/**
 * 「空会话」判定：日志里只有创建与 MCP 选中集事件，从未产生过任何内容。
 *
 * 用途是清理自动新建但一直没用的会话（TUI 退出 / 关闭会话时）。这里用**白名单**：
 * 只有下面两种事件算「没有内容」，其余任何事件（含以后新增的类型）都按「有内容」保留。
 * 这样 /cwd、/model、/clear（会落 session_cleared）、改标题、会话间投递、损坏行、
 * 读不懂的行首都不会被误删。
 */

import type { AgentEventType } from "./agent-events.js";
import type { EventLog } from "./event-log.js";

/** 只有「新建会话」与「建会话时写的 MCP 选中集」算没有内容；新增事件类型默认按有内容处理。 */
export const EMPTY_SESSION_EVENT_TYPES: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
    "session_created",
    "lazy_mcp_changed",
]);

/** 会话是否从未产生过内容；读不出日志时返回 false（保守，不当作空会话）。 */
export async function isEmptySession(eventLog: EventLog, sessionId: string): Promise<boolean> {
    try {
        return !await eventLog.hasEventNotIn(sessionId, EMPTY_SESSION_EVENT_TYPES);
    } catch {
        return false;
    }
}
