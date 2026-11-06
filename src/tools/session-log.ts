/**
 * 任务会话的工具日志落盘。
 *
 * TUI 把 console 整体重定向到 `sessions/log/<sessionId>.log`，所以那边本来就有日志；
 * web 是长驻进程、并可能同时跑多个任务，全局重定向会把 A 任务的日志写进 B 会话的文件。
 * 这里改成"按任务上下文拿 sessionId，直接追加"，天然并发安全。
 *
 * 只写工具事件这一类关键行，不替代 web 自己的 stdout 日志（console 照常输出）。
 * 不在任务上下文（TUI、交互式会话）里调用时直接返回，避免和 TUI 的重定向重复写。
 */

import fs from "node:fs";
import path from "node:path";
import { getJobContext } from "./job-context.js";
import { getSessionLogFile } from "../utils/state-paths.js";

function stamp(): string {
    return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Hong_Kong" }).replace("T", " ");
}

/** 把一行工具日志追加到当前任务会话的日志文件；无任务上下文时什么也不做。 */
export function appendSessionToolLog(line: string): void {
    const sessionId = getJobContext()?.sessionId;
    if (!sessionId) return;
    const file = getSessionLogFile(sessionId);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `[${stamp()}] ${line}\n`, "utf8");
    } catch {
        // 日志写失败不该影响工具执行（磁盘满、目录被删）
    }
}
