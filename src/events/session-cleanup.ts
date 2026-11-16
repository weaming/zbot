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
        replaySnapshotPath(sessionId),
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

/** 会话的重放快照文件：只是缓存（删掉后下次打开全量重放），归档后就不必再留。 */
function replaySnapshotPath(sessionId: string): string {
    return getSessionsDir("events", `${sanitizeSessionId(sessionId)}.snapshot.json`);
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
function readArchiveMark(sessionId: string, last: AgentEvent | undefined, fileMtimeMs: number): ArchiveMark {
    const archived = last?.type === "session_archived";
    const at = last ? Date.parse(last.ts) : Number.NaN;
    const archiveAt = Number.isFinite(at) ? at : fileMtimeMs;
    return { sessionId, archived, activeAt: archived ? archiveAt : fileMtimeMs };
}

/** 尾部扫描的初始窗口与上限：归档判定只需要最后一条有效事件。 */
const TAIL_WINDOW_BYTES = 64 * 1024;
const TAIL_WINDOW_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 从文件尾找最后一个**非注入**事件（真实的用户/模型活动）。
 *
 * 早前这里把整个日志读进来逐行 JSON.parse：154 个会话、200 MB 日志意味着每次
 * TUI 启动都要解析全部事件（其中还有 60 MB 级的单条工具输出）。归档判定只关心
 * 最后一条有效事件，窗口从 64 KB 起按 ×4 放大、封顶 8 MB 就够。
 * 窗口内实在找不到（尾部全是注入事件，或最后一条是超长行）时返回 undefined ——
 * 按未归档处理，宁可不删。
 */
async function readLastMeaningfulEvent(filePath: string): Promise<AgentEvent | undefined> {
    const size = (await fs.promises.stat(filePath)).size;
    let win = Math.min(size, TAIL_WINDOW_BYTES);
    const handle = await fs.promises.open(filePath, "r");
    try {
        while (true) {
            const from = Math.max(0, size - win);
            const length = size - from;
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, from);
            const lines = buffer.toString("utf8").split("\n");
            // 窗口起点不在行首时首段是半行，丢弃。
            const start = from === 0 ? 0 : 1;
            for (let index = lines.length - 1; index >= start; index--) {
                const line = lines[index]!;
                if (!line.trim()) continue;
                const event = parseEvent(line);
                if (!event || isInjectedContext(event)) continue;
                return event;
            }
            if (from === 0 || win >= TAIL_WINDOW_MAX_BYTES) return undefined;
            win = Math.min(size, TAIL_WINDOW_MAX_BYTES, win * 4);
        }
    } finally {
        await handle.close();
    }
}

function parseEvent(line: string): AgentEvent | undefined {
    try {
        return JSON.parse(line) as AgentEvent;
    } catch {
        return undefined;
    }
}

export interface CleanupResult {
    /** 被删除的会话 id。 */
    removed: string[];
    /** 删除失败（含权限问题）的会话 id 与原因。 */
    failed: Array<{ sessionId: string; error: string }>;
    retentionDays: number;
    /** 归档仍留存的会话：被删掉的重放快照数量与回收字节数（快照可重建）。 */
    snapshotsDropped: number;
    snapshotBytes: number;
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
    const emptyResult = { removed: [], failed: [], retentionDays, snapshotsDropped: 0, snapshotBytes: 0 };
    if (retentionDays <= 0) return emptyResult;

    const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    const eventsDir = getSessionsDir("events");
    let fileNames: string[];
    try {
        fileNames = await fs.promises.readdir(eventsDir);
    } catch (error: any) {
        if (error?.code === "ENOENT") return emptyResult;
        throw error;
    }

    const removed: string[] = [];
    const failed: Array<{ sessionId: string; error: string }> = [];
    let snapshotsDropped = 0;
    let snapshotBytes = 0;

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
            const mark = readArchiveMark(sessionId, await readLastMeaningfulEvent(filePath), stat.mtimeMs);
            if (!mark.archived) continue;
            if (mark.activeAt > cutoff) {
                // 归档但未过期：会话本身留着，重放快照没必要留（随时可重建，且有会话日志那么大）
                const dropped = await dropSnapshot(sessionId);
                if (dropped > 0) {
                    snapshotsDropped += 1;
                    snapshotBytes += dropped;
                }
                continue;
            }

            await removeSessionArtifacts(sessionId, { skipAssets });
            removed.push(sessionId);
            // 立即通知：调用方随后列会话时，不能再用缓存把这一个又读回来
            onRemoved?.([sessionId]);
        } catch (error: any) {
            failed.push({ sessionId, error: error?.message ?? String(error) });
        }
    }

    if (removed.length > 0 || failed.length > 0 || snapshotsDropped > 0) {
        const note = `归档会话保留 ${retentionDays} 天：清理 ${removed.length} 个`;
        const snapshotNote = snapshotsDropped > 0
            ? `，另删 ${snapshotsDropped} 份重放快照（${(snapshotBytes / 1e6).toFixed(1)}MB）`
            : "";
        if (failed.length > 0) console.warn(`🧹 [cleanup] ${note}，失败 ${failed.length} 个`);
        else console.log(`🧹 [cleanup] ${note}${snapshotNote}`);
    }
    return { removed, failed, retentionDays, snapshotsDropped, snapshotBytes };
}

/** 删掉归档会话的重放快照，返回回收的字节数（没有则 0）。 */
async function dropSnapshot(sessionId: string): Promise<number> {
    const filePath = replaySnapshotPath(sessionId);
    let size = 0;
    try {
        size = (await fs.promises.stat(filePath)).size;
    } catch {
        return 0;
    }
    await fs.promises.rm(filePath, { force: true });
    return size;
}
