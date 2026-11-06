/**
 * 进程状态文件路径（state root 即 ~/.zbot）：
 *  - 输入历史 `input-history.json`（全局，条目按 sessionId 区分）
 *  - 会话草稿 `sessions/session-drafts.json`（与事件/交换日志同域）
 *  - 日志按 session 分离到 `sessions/log/<sessionId>.log`（与事件日志同域），
 *    启动阶段写 `startup.log`
 *
 * 宿主（host）与 web 共用这些文件，所以这里不叫 tui-*；只留在 TUI 侧的
 * 诊断文件（滚轮日志）标注在各自函数上。
 */

import os from "os";
import path from "path";
import { createHash } from "node:crypto";

function resolveStateRoot(stateRoot?: string): string {
    return stateRoot
        ? path.resolve(stateRoot)
        : process.env.ZBOT_STATE_DIR
            ? path.resolve(process.env.ZBOT_STATE_DIR)
            : path.join(os.homedir(), ".zbot");
}

/** 启动阶段（session 未知）的进程日志。 */
export function getStartupLogFile(stateRoot?: string): string {
    return path.join(resolveStateRoot(stateRoot), "startup.log");
}

/** 单个会话的进程日志：sessions/log/ 下，删除会话时一起清理。 */
export function getSessionLogFile(sessionId: string): string {
    return path.join(resolveStateRoot(), "sessions", "log", `${sessionId}.log`);
}

export function getResponsesBaselineFile(sessionId: string): string {
    const name = createHash("sha256").update(sessionId).digest("hex");
    return path.join(resolveStateRoot(), "sessions", "responses", `${name}.json`);
}

export function getInputHistoryFile(stateRoot?: string): string {
    return path.join(resolveStateRoot(stateRoot), "input-history.json");
}

/** 会话级输入草稿：落 sessions/ 下，切会话 / 重启后输入框内容不丢失。 */
export function getDraftsFile(stateRoot?: string): string {
    return path.join(resolveStateRoot(stateRoot), "sessions", "session-drafts.json");
}

/** 默认模型选择：所有未单独设置模型的会话共用。 */
export function getModelPreferencesFile(stateRoot?: string): string {
    return path.join(resolveStateRoot(stateRoot), "model-preferences.json");
}

/** 滚轮诊断日志（仅 TUI 使用）：独立文件，便于直接 cat 复制（定位"面板外滚动仍滚面板"用）。 */
export function getWheelLogFile(stateRoot?: string): string {
    return path.join(resolveStateRoot(stateRoot), "logs", "tui-wheel.log");
}
