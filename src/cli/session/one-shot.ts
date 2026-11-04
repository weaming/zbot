/**
 * 一次性宿主：`session run` 与 `send` 无持有者时的本地接管共用。
 * 它补齐 dotenv、宿主环境与运行时（不挂技能监听），命令或回合结束后立即关闭。
 */

import path from "node:path";
import { resolveCwdInput } from "../../utils/runtime-paths.js";
import { shortSessionId } from "../../utils/session-id.js";
import { SessionCliError, cleanTitle, isDirectory, usageError } from "./args.js";
import type { RunCommand, SendCommand } from "./args.js";
import type { LocalSendHost, SessionCliIO } from "./io.js";
import { readSessionMeta } from "./store.js";

async function createOneShotHost(startupCwd: string): Promise<LocalSendHost> {
    // 必须在 configureHostEnvironment 之前取：它会把 ZBOT_STATE_DIR 改成 ~/.zbot
    const stateDir = process.env.ZBOT_STATE_DIR;
    const [{ LocalSessionHost, initializeSessionHostRuntime }, mcp, runtimeContext] = await Promise.all([
        import("../../host/session-host.js"),
        import("../../mcp/client-manager.js"),
        import("../../host/runtime-context.js"),
    ]);
    // session 子命令在 dotenv/宿主环境初始化之前分流；这里要真跑模型，补齐
    const dotenv = (await import("dotenv")).default;
    const envFile = process.env.ZBOT_ENV_FILE || path.join(process.env.HOME ?? "", ".zbot", "env");
    dotenv.config({ path: envFile, quiet: true });
    // 保留调用方的状态目录：runSend 已经用它在原来那套会话库里解析过 sessionId
    runtimeContext.configureHostEnvironment({
        ...(stateDir ? { stateDir } : {}),
        startupCwd,
    });

    // MCP/技能初始化日志写文件，避免污染 stdout 的结果与 --json
    const restoreConsole = runtimeContext.redirectLogsToFile();
    let openRuntime!: () => void;
    let failRuntime!: (error: unknown) => void;
    const runtimeGate = new Promise<void>((resolve, reject) => {
        openRuntime = resolve;
        failRuntime = reject;
    });
    // 初始化失败时 gate 会被 reject；没人接的话 Bun 会打出崩溃报告
    void runtimeGate.catch(() => undefined);
    const host = new LocalSessionHost(runtimeGate, { startupCwd });
    const runtimeReady = initializeSessionHostRuntime({ watchSkills: false });
    runtimeReady.then(openRuntime, failRuntime);
    void runtimeReady.catch(() => undefined);
    await runtimeReady;

    return {
        createSessionForCli: (cwd, init) => host.createSession(cwd, init),
        claimSession: (sessionId, options) => host.claimSession(sessionId, options),
        executePeerCommandLocally: (sessionId, text) => host.executePeerCommandLocally(sessionId, text),
        sendMessage: (sessionId, text) => host.sendMessage(sessionId, text),
        subscribeEvents: listener => host.subscribeEvents(listener as any),
        abortSession: sessionId => host.abortSession(sessionId),
        close: async () => {
            await host.close().catch((error: unknown) => {
                console.error("⚠️ [session] 关闭一次性宿主失败:", error);
            });
            await mcp.closeAllMcpClients().catch((error: unknown) => {
                console.error("⚠️ [session] 关闭 MCP 客户端失败:", error);
            });
            restoreConsole();
        },
    };
}

/**
 * 无持有者时的本地接管：命令直接执行（含归档/关闭/删除的收尾），普通文本跑一轮模型。
 * 与投递路径共用解析与执行器；`--queue`/`--expires` 无意义（没有竞争者）。
 */

/**
 * 无持有者时的本地接管：命令直接执行（含归档/关闭/删除的收尾），普通文本跑一轮模型。
 * 与投递路径共用解析与执行器；`--queue`/`--expires` 无意义（没有竞争者）。
 */
export async function runSendLocally(
    command: SendCommand,
    sessionId: string,
    text: string,
    write: (text: string) => void,
    io: SessionCliIO,
): Promise<void> {
    const { runHostTurn } = await import("../session-turn.js");
    // 一次性宿主的启动目录用会话自己的 cwd（工具的相对路径基准不会跑到调用方目录）
    const meta = await readSessionMeta(sessionId).catch(() => null);
    const startupCwd = meta?.summary.cwd ?? process.cwd();
    const host = await (io.createLocalSendHost ?? createOneShotHost)(startupCwd);
    try {
        const claim = await host.claimSession(sessionId, { noNegotiate: true });
        if (!claim.ok) {
            throw new SessionCliError(
                "no_holder",
                `会话 ${shortSessionId(sessionId)} 没有运行中的实例持有，临时接管也失败：${claim.message ?? claim.reason ?? "未知原因"}`,
                1,
                { sessionId, delivered: false },
            );
        }

        const plan = await host.executePeerCommandLocally(sessionId, text);
        if (plan.kind === "prompt") {
            // 与投递路径一致：/review 的附加说明拼在固定指令之后
            await runHostTurn({ host, sessionId, prompt: plan.prompt, json: command.json, write });
            return;
        }

        if (!plan.ok) {
            await plan.finish();
            throw new SessionCliError(
                plan.stopReason === "invalid_command" ? plan.stopReason : "peer_failed",
                plan.output,
                1,
                { sessionId, executedLocally: true, stopReason: plan.stopReason, delivered: false },
            );
        }
        // 收尾（归档/关闭/删除）先做：失败要报错，不能先打印成功
        await plan.finish();
        if (command.json) {
            write(`${JSON.stringify({
                sessionId,
                executedLocally: true,
                delivered: true,
                ok: true,
                stopReason: plan.stopReason,
                text: plan.output,
            }, null, 2)}\n`);
        } else {
            write(`${plan.output}\n`);
        }
    } finally {
        await host.close();
    }
}

/**
 * `session run`：新建 → 认领 → 执行一轮 → 释放。
 * 认领在建会话之后立刻完成（socket bind 原子），避免 new + send 之间被别的实例插手。
 */
export async function runSessionTask(
    command: RunCommand,
    write: (text: string) => void,
    readStdinText: () => Promise<string>,
    io: SessionCliIO = {},
): Promise<void> {
    const text = command.text || (await readStdinText()).trim();
    if (!text) throw usageError("run 需要任务正文");
    const cwd = command.cwd ? resolveCwdInput(command.cwd, process.cwd()) : process.cwd();
    if (!isDirectory(cwd)) throw usageError(`cwd 不是已存在的目录：${cwd}`);
    const title = command.title ? cleanTitle(command.title) : undefined;

    const { runHostTurn } = await import("../session-turn.js");
    const host = await (io.createLocalSendHost ?? createOneShotHost)(cwd);
    try {
        const { sessionId } = await host.createSessionForCli(cwd, { origin: "user", ...(title ? { title } : {}) });
        const claim = await host.claimSession(sessionId, { noNegotiate: true });
        if (!claim.ok) {
            throw new SessionCliError(
                "claim_failed",
                `已创建会话 ${sessionId}，但认领失败：${claim.message ?? claim.reason ?? "未知原因"}`,
                1,
                { sessionId },
            );
        }
        await runHostTurn({ host, sessionId, prompt: text, json: command.json, write });
    } finally {
        await host.close();
    }
}

