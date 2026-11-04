/**
 * 会话的写操作：新建、重命名、归档/取消归档、删除。
 * 都要求目标会话没有实例持有，并在会话锁内落盘，避免与运行中的实例双写事件序列。
 */

import { createUlid } from "../../utils/ulid.js";
import { removeSessionArtifacts } from "../../events/session-cleanup.js";
import { resolveCwdInput } from "../../utils/runtime-paths.js";
import { abbreviatePath } from "../../format/path.js";
import { shortSessionId } from "../../utils/session-id.js";
import { removeSocketFile } from "../../control/paths.js";
import { probeOwnership } from "../../control/registry.js";
import { cleanTitle, isDirectory, usageError } from "./args.js";
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
    await withSessionLockFree(sessionId, async () => {
        await eventLog.append(sessionId, "session_renamed", { title });
    });
    if (command.json) {
        write(`${JSON.stringify({ sessionId, action: "rename", title }, null, 2)}\n`);
        return;
    }
    write(`已重命名 ${shortSessionId(sessionId)} → ${title}\n`);
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

