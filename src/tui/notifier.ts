/**
 * 终端通知模块
 * 优先采用标准 OSC 777 / OSC 9 转义序列，由终端模拟器（如 Ghostty、WezTerm、iTerm2 等）代理呈现原生系统通知。
 */

import { getTuiConfig } from "../config/index.js";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

export interface TerminalNotificationOptions {
    title?: string;
    body: string;
    /** 是否强制输出（无视 isTTY 检查，供单测或管道环境使用） */
    force?: boolean;
}

/** 过滤控制字符、分号、反斜杠及换行，确保终端转义协议安全解析。 */
export function sanitizeNotificationText(text: string): string {
    const stripped = stripTerminalSequences(text);
    return stripped
        .replace(/[\r\n]+/g, " ")
        .replace(/[;\\]/g, " ")
        .replace(/[\x00-\x1f\x7f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * 向终端标准输出发送 OSC 777 与 OSC 9 通知序列。
 * Ghostty / WezTerm / foot 原生识别 OSC 777；iTerm2 / Terminal.app 识别 OSC 9。
 */
export function sendTerminalNotification(options: TerminalNotificationOptions): void {
    if (!options.force && !process.stdout.isTTY) return;
    if (getTuiConfig().disableNotifications) return;

    const rawTitle = options.title ?? "zbot";
    const title = sanitizeNotificationText(rawTitle);
    const body = sanitizeNotificationText(options.body);

    if (!body && !title) return;

    // OSC 777: \x1b]777;notify;<title>;<body>\x07
    const osc777 = `\x1b]777;notify;${title};${body}\x07`;
    // OSC 9: \x1b]9;<title>: <body>\x07
    const osc9 = `\x1b]9;${title ? `${title}: ` : ""}${body}\x07`;

    process.stdout.write(`${osc777}${osc9}`);
}

/**
 * 回合结束通知判定与触发逻辑：
 * 1. 若执行报错：立即通知；
 * 2. 若在后台会话完成：立即通知；
 * 3. 若在前台但耗时 >= 3 秒：通知（以便切到其他应用的用户知晓）；
 * 4. 其余快速回合（<3s）不触发，避免高频打扰。
 */
export function notifyTurnResult(params: {
    sessionId: string;
    sessionName?: string;
    text?: string;
    durationMs: number;
    isBackground: boolean;
    isError?: boolean;
    force?: boolean;
}): void {
    const { sessionName, text, durationMs, isBackground, isError, force } = params;

    // 耗时 < 3s 且在前台且无错误的微小操作不打扰
    if (!isError && !isBackground && durationMs < 3000 && !force) {
        return;
    }

    const title = isError
        ? `zbot · ${sessionName || "执行异常"}`
        : `zbot · ${sessionName || "回复完成"}`;

    let body = "";
    if (isError) {
        body = text || "执行发生异常";
    } else {
        body = text ? text.slice(0, 120) : "任务已执行完毕";
    }

    sendTerminalNotification({ title, body, force });
}
