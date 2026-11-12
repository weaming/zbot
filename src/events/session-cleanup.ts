/**
 * 归档会话的磁盘回收：已归档、且超过保留期的会话，整份目录一起删除。
 *
 * 只删已归档的会话 —— 未归档的会话用户随时可能继续，不参与清理。
 * 保留期默认 14 天，config.yaml 的 runtime.archiveRetentionDays 可覆盖；<= 0 表示不清理。
 */

import fs from "fs";
import path from "path";
import { getSessionsDir } from "../utils/runtime-paths.js";
import { getResponsesBaselineFile } from "../utils/state-paths.js";
import { clearCurrentSessionPointerIf } from "../utils/session-pointer.js";
import { sanitizeSessionId } from "../utils/session-id.js";
import { isInjectedContext, type AgentEvent } from "./agent-events.js";
import { getRuntimeConfig } from "../config/index.js";

/** 保留期默认值：归档后超过这么多天即删除。 */
export const DEFAULT_ARCHIVE_RETENTION_DAYS = 14;

/**
 * 单个会话在 sessions/ 下占用的全部落点（子目录 + 文件），与 deleteSession 的清理
 * 范围一致；新增会话级落盘时必须同步这里，否则清理会漏文件。
 */
export function sessionArtifactPaths(sessionId: string): string[] {
    const safeId = sanitizeSessionId(sessionId);
    return [
        getSessionsDir("events", `${safeId}.jsonl`),
        getSessionsDir("events", `${safeId}.snapshot.json`),
        getSessionsDir("events", `${safeId}.stream.jsonl`),
        getSessionsDir("http", `${safeId}.jsonl`),
        getSessionsDir("log", `${safeId}.log`),
        getSessionsDir("todos", `${safeId}.json`),
        getSessionsDir("chat", `${safeId}.json`),
        getResponsesBaselineFile(sessionId),
        getSessionsDir("locks", `${safeId}.lock`),
        getSessionsDir("assets", safeId),
    ];
}

/**
 * 删除一个会话的全部落点（缺项跳过）。
 * `skipAssets` 用于只清会话记录、不扫大目录；`skipLock` 给"自己正持有该会话锁"的调用方用，
 * 否则会在临界区中途删掉自己的锁文件，让第三方抢进来。
 */
export async function removeSessionArtifacts(
    sessionId: string,
    options: { skipAssets?: boolean; skipLock?: boolean } = {},
): Promise<void> {
    const assetsDir = getSessionsDir("assets", sanitizeSessionId(sessionId));
    const lockFile = getSessionsDir("locks", `${sanitizeSessionId(sessionId)}.lock`);
    for (const target of sessionArtifactPaths(sessionId)) {
        if (options.skipAssets && target === assetsDir) continue;
        if (options.skipLock && target === lockFile) continue;
        // assets 是目录，其余是文件；force 让缺失项直接跳过
        await fs.promises.rm(target, { recursive: true, force: true });
    }
    // 当前会话指针可能正指向它：删除后 CLI 无 id 的 show/wait 不该再落到不存在的会话
    await clearCurrentSessionPointerIf(sessionId);
}

/** 保留天数：取自配置（runtime.archiveRetentionDays），非法值回退默认值。 */
export function resolveRetentionDays(days = getRuntimeConfig().archiveRetentionDays): number {
    return Number.isFinite(days) ? Math.floor(days) : DEFAULT_ARCHIVE_RETENTION_DAYS;
}

/** 会话在事件流里的归档态与计时起点。 */
interface ArchiveMark {
    sessionId: string;
    /** 末态是否归档。 */
    archived: boolean;
    /** 过期判定的计时起点：仍归档为归档时刻，否则为落盘时间。 */
    activeAt: number;
}



/**
 * 从事件流判定会话的归档态与最近活动时间。
 *
 * 只看最后一个**非注入**事件：归档后群里仍会不断落下自动注入的上下文事件，
 * 它们不代表用户回来用过这个会话，不能因此让归档失效（否则归档会话永远清不掉）。
 * 归档后若真的继续对话或取消归档，末条有效事件就不是 session_archived，计时自然重置。
 */
function readArchiveMark(sessionId: string, events: AgentEvent[], fileMtimeMs: number): ArchiveMark {
    const last = lastMeaningfulEvent(events);
    const archived = last?.type === "session_archived";
    const at = last ? Date.parse(last.ts) : Number.NaN;
    const archiveAt = Number.isFinite(at) ? at : fileMtimeMs;
    return { sessionId, archived, activeAt: archived ? archiveAt : fileMtimeMs };
}

/** 最后一个不是自动注入的事件（即真实的用户/模型活动）。 */
function lastMeaningfulEvent(events: AgentEvent[]): AgentEvent | undefined {
    for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index] as AgentEvent;
        if (!isInjectedContext(event)) return event;
    }
    return undefined;
}

export interface CleanupResult {
    /** 被删除的会话 id。 */
    removed: string[];
    /** 删除失败（含权限问题）的会话 id 与原因。 */
    failed: Array<{ sessionId: string; error: string }>;
    retentionDays: number;
}

/**
 * 删除超过保留期的已归档会话：会话自身的 events/http/log/todos/chat/lock/assets 全部移除。
 *
 * 只删归档态已被判定过期的会话；`now` 可注入以便测试。
 */
export async function cleanupArchivedSessions(
    options: {
        now?: Date;
        retentionDays?: number;
        /** 正在使用的会话（进程内活跃），永不删除。 */
        protectedIds?: Iterable<string>;
        /** 跳过图片资产目录（大目录，rm 慢）；只清会话记录时用。 */
        skipAssets?: boolean;
        /** 每删成一个会话就回调，供调用方丢弃该会话的进程内缓存。 */
        onRemoved?: (sessionIds: string[]) => void;
    } = {},
): Promise<CleanupResult> {
    const retentionDays = options.retentionDays ?? resolveRetentionDays();
    const now = options.now ?? new Date();
    const protectedIds = new Set(options.protectedIds ?? []);
    const skipAssets = options.skipAssets ?? false;
    const onRemoved = options.onRemoved;
    if (retentionDays <= 0) return { removed: [], failed: [], retentionDays };

    const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    const eventsDir = getSessionsDir("events");
    let fileNames: string[];
    try {
        fileNames = await fs.promises.readdir(eventsDir);
    } catch (error: any) {
        if (error?.code === "ENOENT") return { removed: [], failed: [], retentionDays };
        throw error;
    }

    const removed: string[] = [];
    const failed: Array<{ sessionId: string; error: string }> = [];

    for (const fileName of fileNames) {
        // 流式片段旁路文件不是独立会话，跳过免得白读
        if (!fileName.endsWith(".jsonl") || fileName.endsWith(".stream.jsonl")) continue;
        const sessionId = fileName.slice(0, -".jsonl".length);
        if (protectedIds.has(sessionId)) continue;

        const filePath = path.join(eventsDir, fileName);
        try {
            const stat = await fs.promises.stat(filePath);
            // 不能用 mtime 粗筛：归档会话群里仍有自动注入事件落盘，mtime 会一直新鲜，
            // 粗筛会把它们整批跳过（归档态与时间只能从事件内容判定）。
            const events = await readEvents(filePath);
            const mark = readArchiveMark(sessionId, events, stat.mtimeMs);
            if (!mark.archived || mark.activeAt > cutoff) continue;

            await removeSessionArtifacts(sessionId, { skipAssets });
            removed.push(sessionId);
            // 立即通知：调用方随后列会话时，不能再用缓存把这一个又读回来
            onRemoved?.([sessionId]);
        } catch (error: any) {
            failed.push({ sessionId, error: error?.message ?? String(error) });
        }
    }

    if (removed.length > 0 || failed.length > 0) {
        const note = `归档会话保留 ${retentionDays} 天：清理 ${removed.length} 个`;
        if (failed.length > 0) console.warn(`🧹 [cleanup] ${note}，失败 ${failed.length} 个`);
        else console.log(`🧹 [cleanup] ${note}`);
    }
    return { removed, failed, retentionDays };
}

async function readEvents(filePath: string): Promise<AgentEvent[]> {
    const text = await fs.promises.readFile(filePath, "utf8");
    const events: AgentEvent[] = [];
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
            events.push(JSON.parse(line) as AgentEvent);
        } catch {
            // 损坏行跳过，不影响其余事件的判定
        }
    }
    return events;
}
