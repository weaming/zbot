/**
 * 会话命令行：让其他 AI 或用户直接增删查改 ~/.zbot/sessions 下的会话。
 *
 * 与 TUI 并存时的安全边界：
 * - 读操作（list / show）只读事件日志，任何时刻可执行；
 * - 写操作（new / rename / archive / unarchive / delete）要求目标会话未被任何实例持有
 *   （控制 socket 无监听者），并在会话锁内落盘，避免与运行中的 TUI 双写事件序列；
 * - send 通过控制 socket 投递给运行中的 TUI 或后台实例；没有持有者时拒绝执行。
 *
 * 输出默认人类可读，`--json` 给结构化数据（供其他 AI 解析）。
 * 解析、查询、写操作与投递分别在 `session/` 下的模块里，这里只做路由。
 */

import { SESSION_CLI_USAGE } from "./help.js";
import { SessionCliError, isSessionCliInvocation, parseSessionArgs } from "./session/args.js";
import { readSessionStdin } from "./session/io.js";
import type { SessionCliIO } from "./session/io.js";
import { runArchive, runDelete, runNew, runRename } from "./session/mutate.js";
import { runQueue, runSend } from "./session/send.js";
import { runList, runShow } from "./session/view.js";
import { runWait } from "./session/wait.js";

export { SessionCliError, isSessionCliInvocation, parseSessionArgs };
export type {
    ArchiveCommand,
    DeleteCommand,
    ListCommand,
    NewCommand,
    QueueCommand,
    RenameCommand,
    RunCommand,
    SendCommand,
    SessionCommand,
    ShowCommand,
    WaitCommand,
} from "./session/args.js";
export type { SessionCliIO } from "./session/io.js";
export { resolveSessionIdFrom } from "./session/store.js";
export { formatTable } from "./session/view.js";
export type { SessionListRow } from "./session/view.js";

/** 入口：按解析出来的命令分派到对应模块。 */
export async function runSessionCli(argv: string[], io: SessionCliIO = {}): Promise<void> {
    const command = parseSessionArgs(argv);
    const write = io.write ?? ((text: string) => { process.stdout.write(text); });
    switch (command.kind) {
        case "help":
            write(`${SESSION_CLI_USAGE}\n`);
            return;
        case "list":
            return runList(command, write);
        case "show":
            return runShow(command, write);
        case "new":
            return runNew(command, write);
        case "rename":
            return runRename(command, write);
        case "archive":
        case "unarchive":
            return runArchive(command, write);
        case "delete":
            return runDelete(command, write);
        case "send":
            return runSend(command, write, io.readStdin ?? readSessionStdin, io);
        case "queue":
            return runQueue(command, write);
        case "wait":
            return runWait(command, write);
        case "run":
            throw new SessionCliError(
                "tui_or_backend_required",
                "session run 不会在 CLI 进程里直接运行模型。请启动 TUI 后使用 `session send`，或通过 `zbot serve` 提交后台任务。",
            );
    }
}
