/** 独立 stdio 宿主装配；stdout 专用于 JSONL，日志在运行时初始化前接管。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureHostEnvironment, redirectLogsToFile } from "../host/runtime-context.js";
import type { SessionRuntimeCapabilities } from "../control/runtime.js";
import type { StdioHost } from "./stdio-protocol.js";
import { runStdioProtocol } from "./stdio-protocol.js";

/** 解析宿主工作目录，不接受模型或外部会话参数。 */
export function parseStdioArgs(argv: string[]): { cwd: string } {
    let cwd = process.cwd();
    for (let index = 0; index < argv.length; index++) {
        if (argv[index] !== "--cwd" || !argv[index + 1] || argv[index + 1]!.startsWith("--")) {
            throw new Error("用法：zbot stdio [--cwd <目录>]");
        }
        const value = argv[++index]!;
        const expanded = value === "~" ? os.homedir()
            : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
        cwd = path.resolve(expanded);
    }
    if (!fs.statSync(cwd).isDirectory()) throw new Error(`工作目录不是目录: ${cwd}`);
    return { cwd };
}

/** 无交互界面时明确取消提问，同时通知客户端展示状态。 */
export function createStdioCapabilities(
    notify: (method: string, params: unknown) => void,
    ownsSession: (id: string) => boolean,
): SessionRuntimeCapabilities {
    return {
        ownsSession,
        askUser: async request => {
            // 当前协议无回答入口：明确取消，不批准任何待确认行为。
            notify("session/status", { state: "question_cancelled", requestId: request.requestId });
            return { cancelled: true };
        },
    };
}

export async function runStdio(argv: string[]): Promise<void> {
    const { cwd } = parseStdioArgs(argv);
    configureHostEnvironment({ stateDir: process.env.ZBOT_STATE_DIR, startupCwd: cwd });
    const restoreConsole = redirectLogsToFile();
    const controller = new AbortController();
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const armExit = (): void => {
        forceTimer ??= setTimeout(() => {
            process.stderr.write("stdio 宿主收尾超时\n");
            process.exit(1);
        }, 8000);
        forceTimer.unref();
    };
    const onSignal = (): void => { armExit(); controller.abort(); };
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    for (const signal of signals) process.on(signal, onSignal);
    let host: StdioHost | undefined;
    let closeMcp: (() => Promise<void>) | undefined;
    let hasProtocolStarted = false;
    try {
        const { registerSessionRuntime } = await import("../control/runtime.js");
        const { LocalSessionHost, initializeSessionHostRuntime } = await import("../host/session-host.js");
        const { closeAllMcpClients } = await import("../mcp/client-manager.js");
        closeMcp = closeAllMcpClients;
        const { getConfig } = await import("../config/index.js");
        getConfig();
        const runtimeReady = initializeSessionHostRuntime({ watchSkills: false });
        host = new LocalSessionHost(runtimeReady, { startupCwd: cwd });
        await runtimeReady;
        hasProtocolStarted = true;
        await runStdioProtocol({
            host, cwd, input: process.stdin, output: process.stdout, signal: controller.signal,
            onClosing: armExit,
            readHistory: async (sessionId, limit) => {
                // 只有恢复会话才需要存储，按需加载，不让 stdio 启动多背一层 CLI 依赖。
                const { eventLog } = await import("./session/store.js");
                const last = await eventLog.lastSeq(sessionId);
                if (last <= 0) return [];
                const events = await eventLog.readBefore(sessionId, last + 1, limit);
                return events.map(event => ({ type: event.type, seq: event.seq, ts: event.ts, payload: event.payload }));
            },
            registerRuntime: (notify, ownsSession) => registerSessionRuntime(createStdioCapabilities(notify, ownsSession)),
        });
    } finally {
        armExit();
        try { if (!hasProtocolStarted) await host?.close(); }
        finally {
            try { await closeMcp?.(); }
            finally {
                restoreConsole();
                if (forceTimer) clearTimeout(forceTimer);
                for (const signal of signals) process.off(signal, onSignal);
            }
        }
    }
}
