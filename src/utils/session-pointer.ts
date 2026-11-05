/**
 * 当前会话指针：TUI 最近一次进入的会话，供命令行「无 id 的 show / wait」与列表标注使用。
 *
 * 多个 TUI 实例共用一份指针（最后切换者胜出）：它只是「最近一次进入」的便捷入口，
 * 不参与归属判定——真实归属仍由控制 socket 表达，指针过期不会误导写操作。
 */

import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "./runtime-paths.js";

export interface CurrentSessionPointer {
    sessionId: string;
    /** 写入者进程与终端：解释「是谁把它设成当前」，进程可能早已退出。 */
    pid: number;
    tty?: string;
    updatedAt: string;
}

/** 指针文件放在 state root（~/.zbot/current-session.json），与会话目录同级便于排查。 */
export function getCurrentSessionFile(): string {
    return getStateDir("current-session.json");
}

/** 读指针；文件缺失/损坏/字段不合法时返回 undefined，绝不让 CLI 因此失败。 */
export function readCurrentSessionPointer(): CurrentSessionPointer | undefined {
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(getCurrentSessionFile(), "utf8"));
    } catch {
        return undefined;
    }
    const value = raw as Partial<CurrentSessionPointer> | null;
    if (!value || typeof value.sessionId !== "string" || !value.sessionId.trim()) return undefined;
    return {
        sessionId: value.sessionId,
        pid: Number.isInteger(value.pid) ? Number(value.pid) : 0,
        ...(typeof value.tty === "string" && value.tty ? { tty: value.tty } : {}),
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    };
}

/** 会话被删除时清掉指向它的指针；已经指向别的会话时不动（别的实例可能刚切走）。 */
export async function clearCurrentSessionPointerIf(sessionId: string): Promise<void> {
    const pointer = readCurrentSessionPointer();
    if (!pointer || pointer.sessionId !== sessionId) return;
    await fs.promises.rm(getCurrentSessionFile(), { force: true }).catch(() => undefined);
}

/** 记下当前会话：先写临时文件再 rename，避免并发读拿到半份 JSON。 */
export async function writeCurrentSessionPointer(sessionId: string): Promise<void> {
    const file = getCurrentSessionFile();
    const pointer: CurrentSessionPointer = {
        sessionId,
        pid: process.pid,
        ...(process.env.TTY ? { tty: process.env.TTY } : {}),
        updatedAt: new Date().toISOString(),
    };
    const temp = path.join(path.dirname(file), `.current-session.${process.pid}.tmp`);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    try {
        await fs.promises.writeFile(temp, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
        await fs.promises.rename(temp, file);
    } finally {
        await fs.promises.rm(temp, { force: true });
    }
}
