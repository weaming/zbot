/** 后台任务摘要的纯文本渲染：TUI 命令与会话间命令共用。 */

import type { BackgroundTaskSummary } from "../tools/background-tasks.js";

/** /ps 与 /tasks 列表最多展示的任务数。 */
export const MAX_SHOWN_BACKGROUND_TASKS = 16;
/** 任务命令/输出单行预览列宽。 */
export const MAX_TASK_TEXT_COLUMNS = 72;

const STATUS_LABELS: Record<BackgroundTaskSummary["status"], string> = {
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    stopped: "已终止",
    timed_out: "超时",
};

export function formatBackgroundTaskDetails(task: BackgroundTaskSummary): string {
    const lines = [`后台任务 ${task.id} · ${STATUS_LABELS[task.status]}`, `命令：${task.command}`];
    if (task.exitCode !== undefined && task.exitCode !== null) lines.push(`退出码：${task.exitCode}`);
    if (task.stdout) lines.push(`stdout：\n${task.stdout}`);
    if (task.stderr) lines.push(`stderr：\n${task.stderr}`);
    if (task.outputTruncated) lines.push("（输出过长，已截断）");
    return lines.join("\n");
}

/** 已运行时长（分钟精度，超过 1 小时带小时）。 */
export function formatElapsed(startedAt: string): string {
    const started = Date.parse(startedAt);
    if (!Number.isFinite(started)) return "";
    const seconds = Math.max(0, Math.floor((Date.now() - started) / 1_000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}
