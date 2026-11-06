/**
 * 会话的写操作：新建、重命名、归档/取消归档、删除。
 * 都要求目标会话没有实例持有，并在会话锁内落盘，避免与运行中的实例双写事件序列。
 * 例外是重命名：标题属于元数据，会话被持有（TUI/serve 在跑）时交给持有者落盘。
 */

import { createUlid } from "../../utils/ulid.js";
import { removeSessionArtifacts } from "../../events/session-cleanup.js";
import { resolveCwdInput } from "../../utils/runtime-paths.js";
import { abbreviatePath } from "../../format/path.js";
import { shortSessionId } from "../../utils/session-id.js";
import { getSocketPath, removeSocketFile } from "../../control/paths.js";
import { PeerConnectError, PeerConnection } from "../../control/client.js";
import { probeOwnership } from "../../control/registry.js";
import { cleanTitle, isDirectory, usageError, SessionCliError } from "./args.js";
import type { ArchiveCommand, DeleteCommand, NewCommand, RenameCommand } from "./args.js";
import { eventLog, readSessionMeta, resolveSessionId, withSessionLockFree } from "./store.js";
import { CWD_COLUMNS } from "./view.js";

export async function runNew(command: NewCommand, write: (text: string) => void): Promise<void> {
    const cwd = command.cwd ? resolveCwdInput(command.cwd, process.cwd()) : process.cwd();
    if (!isDirectory(cwd)) throw usageError(`cwd 不是已存在的目录：${cwd}`);
    const title = command.title ? cleanTitle(command.title) : undefined;

    const sessionId = createUlid();
    await eventLog.append(sessionId, "session_created", { cwd, origin: "user" });
    if (title) await eventLog.append(sessionId, "session_renamed", { title });

    if (command.json) {
        write(`${JSON.stringify({ sessionId, cwd, title: title ?? null }, null, 2)}\n`);
        return;
    }
    write(`已创建会话 ${sessionId}（${abbreviatePath(cwd, process.env.HOME, CWD_COLUMNS)}）${title ? `「${title}」` : ""}\n`);
}

export async function runRename(command: RenameCommand, write: (text: string) => void): Promise<void> {
    const sessionId = await resolveSessionId(command.id);
    const title = cleanTitle(command.title);
    const applied = await renameSession(sessionId, title);
    if (command.json) {
        write(`${JSON.stringify({ sessionId, action: "rename", title: applied }, null, 2)}\n`);
        return;
    }
    write(`已重命名 ${shortSessionId(sessionId)} → ${applied}\n`);
}

/**
 * 落盘新标题：没人持有时直接写事件日志；被实例持有时交给持有者改。
 * 跨进程直接写会与正在跑的回合双写同一份日志，所以运行时只能走控制通道。
 * 返回真正生效的标题（持有者按同一上限截断）。
 */
async function renameSession(sessionId: string, title: string): Promise<string> {
    const ownership = await probeOwnership(sessionId);
    if (ownership.state === "free") {
        try {
            await withSessionLockFree(sessionId, async () => {
                await eventLog.append(sessionId, "session_renamed", { title });
            });
            return title;
        } catch (error) {
            // 探测到写入之间被实例认领并开跑：这种情况本来就该交给持有者，不必报 held
            if (!(error instanceof SessionCliError) || error.code !== "held") throw error;
            // 同码有两个来源：真被持有（assertSessionFree，带 holderPid）与取锁失败（锁竞争 / 日志半写）。
            // 后者没人可投递，投过去只会变成误导性的"不可达/进程刚退出"。
            if (isHeldByInstance(error.details)) return await renameViaHolder(sessionId, title);
            throw new SessionCliError(
                "failed",
                "会话正在被写入（会话锁竞争或日志半写），请稍后重试",
                1,
                // 原始锁错误里有持有 PID / "日志半写" 之类的线索，排查时不能只剩笼统文案
                { sessionId, title, reason: error.message, holderPid: error.details.holderPid ?? null },
            );
        }
    }
    return await renameViaHolder(sessionId, title);
}

/** assertSessionFree 抛的 held 带 holderPid 键；取锁竞争抛的 held 只有 sessionId。 */
function isHeldByInstance(details: unknown): boolean {
    return typeof details === "object" && details !== null && "holderPid" in details;
}

async function renameViaHolder(sessionId: string, title: string): Promise<string> {
    const connection = new PeerConnection({
        socketPath: getSocketPath(sessionId),
        onResult: () => undefined,
    });
    try {
        const reply = await connection.rename(title);
        if (reply.type !== "rename_result") {
            throw new SessionCliError("bad_reply", `会话 ${shortSessionId(sessionId)} 返回了非预期应答`, 1, { sessionId, title });
        }
        if (!reply.ok) throw renameFailure(sessionId, title, reply.error);
        return reply.title ?? title;
    } catch (error) {
        // 旧版本持有者会忽略未知帧，只能给结构化不可达错误，不能裸抛连接异常
        if (error instanceof PeerConnectError) {
            throw new SessionCliError(
                "unreachable",
                `会话 ${shortSessionId(sessionId)} 不可达或不支持运行时改标题（进程可能刚退出）`,
                1,
                { sessionId, title },
            );
        }
        throw error;
    } finally {
        connection.close();
    }
}

/** 持有者拒绝改名：`busy:` 前缀是宿主对「有别的操作占着」的约定标记，翻成可读文案与独立错误码。 */
function renameFailure(sessionId: string, title: string, error: string | undefined): SessionCliError {
    const message = error ?? "重命名失败";
    if (message.startsWith("busy: ")) {
        return new SessionCliError("busy", "会话正在处理其他操作（清空 / 压缩 / 投递 / 取消 / 清理），稍后重试", 1, {
            sessionId,
            title,
        });
    }
    return new SessionCliError("rename_failed", message, 1, { sessionId, title });
}

export async function runArchive(command: ArchiveCommand, write: (text: string) => void): Promise<void> {
    const sessionId = await resolveSessionId(command.id);
    await withSessionLockFree(sessionId, async () => {
        await eventLog.append(
            sessionId,
            command.kind === "archive" ? "session_archived" : "session_unarchived",
            {},
        );
    });
    if (command.json) {
        write(`${JSON.stringify({ sessionId, action: command.kind, archived: command.kind === "archive" }, null, 2)}\n`);
        return;
    }
    write(`${command.kind === "archive" ? "已归档" : "已取消归档"} ${shortSessionId(sessionId)}\n`);
}

export async function runDelete(command: DeleteCommand, write: (text: string) => void): Promise<void> {
    const sessionId = await resolveSessionId(command.id);
    const meta = await readSessionMeta(sessionId);
    const turns = meta?.summary.messageCount ?? 0;
    await withSessionLockFree(sessionId, async () => {
        // 锁留给 release 收尾，否则会在临界区中途删掉自己的互斥文件
        await removeSessionArtifacts(sessionId, { skipLock: true });
        // 删 socket 前再确认一次无监听者：这段窗口里别人可能刚好 bind 上来
        if ((await probeOwnership(sessionId)).state === "free") removeSocketFile(sessionId);
    });
    if (command.json) {
        write(`${JSON.stringify({ sessionId, action: "delete", deleted: true, turns }, null, 2)}\n`);
        return;
    }
    write(`已删除 ${shortSessionId(sessionId)}（${turns} 轮）\n`);
}
