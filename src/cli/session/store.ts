/**
 * `zbot session` 的存储与并发入口：共享的事件日志句柄、会话摘要读取、
 * id 补全（前缀/后缀唯一匹配），以及写操作前的「无实例持有 + 会话锁」守卫。
 */

import fs from "node:fs";
import path from "node:path";
import { EventLog } from "../../events/event-log.js";
import { listSavedSessionIds } from "../../events/session-files.js";
import { SessionReplay } from "../../events/session-replay.js";
import { SessionDigestReader } from "../../host/summary.js";
import { acquireSessionLock } from "../../utils/session-lock.js";
import { getSessionsDir } from "../../utils/runtime-paths.js";
import { isUlid, sanitizeSessionId, shortSessionId } from "../../utils/session-id.js";
import { probeOwnership } from "../../control/registry.js";
import type { SessionSummary } from "../../host/session-host-types.js";
import { SessionCliError } from "./args.js";


export const eventLog = new EventLog();
export const replay = new SessionReplay(eventLog);
/** 会话摘要缓存：`list` 会遍历全部会话，逐份全量解析事件日志是这里最贵的一步。 */
const digests = new SessionDigestReader(eventLog);

/** 会话摘要 + 真实创建时间（取首条事件 ts；Session.createdAt 是重放时刻，不能代表创建时间）。 */
export async function readSessionMeta(
    sessionId: string,
): Promise<{ summary: SessionSummary; createdAt?: string } | null> {
    return digests.read(sessionId);
}

/** 事件日志文件的 mtime：日志损坏时唯一的"更新时间"来源。 */
export function eventFileMtime(sessionId: string): string | undefined {
    try {
        const file = path.join(getSessionsDir("events"), `${sanitizeSessionId(sessionId)}.jsonl`);
        return fs.statSync(file).mtime.toISOString();
    } catch {
        return undefined;
    }
}

/** 把用户输入的 id 补全：优先精确匹配，其次唯一前缀，再次唯一后缀（工具里惯用末几位）。 */
export function resolveSessionIdFrom(input: string, savedIds: string[]): string {
    const trimmed = input.trim();
    if (!trimmed) throw new SessionCliError("usage", "需要会话 id");
    if (savedIds.includes(trimmed)) return trimmed;

    const prefix = savedIds.filter(sessionId => sessionId.startsWith(trimmed));
    const suffix = savedIds.filter(sessionId => sessionId.endsWith(trimmed));

    // 前缀与后缀各命中一个但指向不同会话时同样算歧义，不能悄悄取前缀
    const candidates = [...new Set([...prefix, ...suffix])];
    if (candidates.length > 1) {
        throw new SessionCliError(
            "ambiguous",
            `会话 ${trimmed} 匹配到多个候选：${candidates.map(shortSessionId).join(" ")}，请写更长的 id`,
            1,
            { candidates },
        );
    }
    if (candidates.length === 1) return candidates[0]!;
    throw new SessionCliError("not_found", `会话不存在：${trimmed}`, 1, { input: trimmed });
}

export async function resolveSessionId(input: string): Promise<string> {
    return resolveSessionIdFrom(input, listSavedSessionIds());
}

/**
 * send 的目标解析：另一实例刚派生、还没落任何事件的会话不在磁盘上，
 * 只要给的是完整 ULID 就按原样交给控制通道判定可达性（与 session_send 工具一致）。
 */
export async function resolveSendTarget(input: string): Promise<string> {
    const trimmed = input.trim();
    try {
        return await resolveSessionId(trimmed);
    } catch (error) {
        if (isUlid(trimmed)) return trimmed;
        throw error;
    }
}


// ── 守卫与工具 ────────────────────────────────────────────────

/** 写操作前确认没有实例持有该会话：持有者的内存状态不会跟着事件日志走，双写会让 seq 分叉。 */
async function assertSessionFree(sessionId: string): Promise<void> {
    const ownership = await probeOwnership(sessionId);
    if (ownership.state === "free") return;
    const info = ownership.state === "other" ? ownership.info : undefined;
    throw new SessionCliError(
        "held",
        `会话 ${shortSessionId(sessionId)} 正被其他实例持有${info ? `（pid ${info.pid}${info.busy ? "，执行中" : ""}）` : ""}`
        + "，请在那个实例里操作，或先 /close 释放后再试",
        1,
        { sessionId, holderPid: info?.pid ?? null, busy: info?.busy ?? null },
    );
}

export async function withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const lock = await acquireSessionLock(sessionId).catch((error: any) => {
        const message = error?.message ?? String(error);
        // 只有"别的实例在跑/在写"才是 held；权限、文件系统等异常保持 failed
        const code = /其他实例|竞争|正在写入|holder/i.test(message) ? "held" : "failed";
        throw new SessionCliError(code, message, 1, { sessionId });
    });
    try {
        return await run();
    } finally {
        await lock.release();
    }
}

/**
 * 写操作的标准姿势：**先廉价探测一次**（拿到"被持有"的友好错误，不必先碰锁），
 * **再取锁，锁内重新探测**作为权威判定 —— 否则第一次探测为 free 与真正 append 之间的
 * 窗口里被别的实例 claim 并开跑，两侧会各自从旧 lastSeq +1，把 seq 写分叉。
 */
export async function withSessionLockFree<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    await assertSessionFree(sessionId);
    return withSessionLock(sessionId, async () => {
        await assertSessionFree(sessionId);
        return run();
    });
}

