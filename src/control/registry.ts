/**
 * 会话归属注册表：本实例持有的 socket + 对外的归属探测。
 *
 * 归属判定只有三个事实来源，全部来自 socket 文件本身：
 * - bind 成功 → 本实例持有
 * - connect 成功 → 有人持有（握手可拿到 pid/title/busy）
 * - connect 失败 → 无人持有（stale，可安全清理）
 */

import fs from "fs";
import { randomUUID } from "node:crypto";
import { PeerConnectError, requestOnce } from "./client.js";
import { getSocketPath, listSocketSessionIds } from "./paths.js";
import type { PeerOwnerInfo } from "./protocol.js";
import { cleanupStaleObserveSockets } from "../observe/cleanup.js";

/** 归属探测与释放协商的默认超时。 */
const DEFAULT_PROBE_TIMEOUT_MS = 500;

/** 本进程实例标识：同一进程内所有会话共用，跨进程必然不同。 */
export const PROCESS_INSTANCE_ID = randomUUID();

interface BoundSocket {
    sessionId: string;
    socketPath: string;
    /** bind 时的 inode：释放前比对，避免误删别人重建的 socket。 */
    ino: number;
}

/** 本实例持有的 socket（进程级状态，进程退出即无意义）。 */
const bound = new Map<string, BoundSocket>();

export function registerBound(sessionId: string, socketPath: string, ino: number): void {
    bound.set(sessionId, { sessionId, socketPath, ino });
}

export function isLocallyBound(sessionId: string): boolean {
    return bound.has(sessionId);
}

export function locallyBoundSessionIds(): string[] {
    return [...bound.keys()];
}

/**
 * 释放 socket 文件：先比对 inode，只有仍是自己 bind 的那个才 unlink。
 * 别人可能已经 unlink 并重建了同名 socket，按路径删会删掉别人的活连接。
 */
export function releaseSocketFile(sessionId: string): void {
    const entry = bound.get(sessionId);
    if (!entry) return;
    bound.delete(sessionId);

    try {
        const stat = fs.statSync(entry.socketPath);
        if (stat.ino !== entry.ino) return;
        fs.unlinkSync(entry.socketPath);
    } catch {
        // 文件已不存在：视为已清理
    }
}

/** 只清本地表、不碰文件；服务端已自行关闭并清理时使用。 */
export function forgetBound(sessionId: string): void {
    bound.delete(sessionId);
}

export type PeerOwnership =
    | { state: "mine" }
    | { state: "other"; info?: PeerOwnerInfo }
    | { state: "free" };

/**
 * 探测单个会话的归属。
 * connect 失败 → free（无监听者，残留文件可清理）；
 * connect 成功但 who 无应答 → other 且无 info（保守视为被持有，绝不清理）。
 */
export async function probeOwnership(
    sessionId: string,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<PeerOwnership> {
    if (isLocallyBound(sessionId)) return { state: "mine" };

    let reply;
    try {
        reply = await requestOnce(getSocketPath(sessionId), { type: "who", id: `who-${sessionId}` }, timeoutMs);
    } catch (error) {
        if (error instanceof PeerConnectError && error.code === "connect") return { state: "free" };
        return { state: "other" };
    }

    if (reply.type === "who") return { state: "other", info: reply.info };
    return { state: "other" };
}

/** 并行探测多个会话的归属（面板打开时用，超时短、互不阻塞）。 */
export async function listOwnership(
    sessionIds: string[],
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<Map<string, PeerOwnership>> {
    const entries = await Promise.all(
        sessionIds.map(async (sessionId) => [sessionId, await probeOwnership(sessionId, timeoutMs)] as const),
    );
    return new Map(entries);
}

/**
 * 清理无监听者的残留 socket（unix socket 文件不会随进程退出消失）。
 * 只清理 connect 确认失败的；连上了但没应答的一律保留。
 */
export async function cleanupStaleSockets(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<string[]> {
    const removed: string[] = [];
    for (const sessionId of listSocketSessionIds()) {
        if (isLocallyBound(sessionId)) continue;

        const ownership = await probeOwnership(sessionId, timeoutMs);
        if (ownership.state !== "free") continue;

        try {
            fs.unlinkSync(getSocketPath(sessionId));
            removed.push(sessionId);
        } catch {
            // 已被别的实例清理
        }
    }
    // 观察 socket 不表达归属：它按「连不连得上」单独回收，绝不参与上面的归属判定。
    // TUI 被抓包 kill、或会话正被切换时，控制 socket 会被清而观察文件留在原地，这里补上。
    removed.push(...(await cleanupStaleObserveSockets(timeoutMs)));
    return removed;
}

/** 归属的展示文案（tab 条 / 会话面板 / session_status 共用，避免三处不一致）。 */
export function describeOwnership(sessionId: string, ownership: PeerOwnership): string {
    if (ownership.state === "mine") return "本实例";
    if (ownership.state === "free") return "未认领";
    const info = ownership.info;
    if (!info) return "其他实例（无应答）";
    return `PID ${info.pid}${info.busy ? " · 忙" : " · 空闲"}`;
}
