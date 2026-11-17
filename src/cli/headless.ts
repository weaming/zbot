/** 无终端界面的宿主生命周期：协议前端共用初始化、信号与资源收尾。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureHostEnvironment, redirectLogsToFile } from "../host/runtime-context.js";
import type { SessionHost } from "../host/session-host-types.js";

export function parseHeadlessArgs(argv: string[], command: string): { cwd: string } {
    let cwd = process.cwd();
    for (let index = 0; index < argv.length; index++) {
        if (argv[index] !== "--cwd" || !argv[index + 1] || argv[index + 1]!.startsWith("--")) {
            throw new Error(`用法：zbot ${command} [--cwd <目录>]`);
        }
        const value = argv[++index]!;
        const expanded = value === "~" ? os.homedir()
            : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
        cwd = path.resolve(expanded);
    }
    if (!fs.statSync(cwd).isDirectory()) throw new Error(`工作目录不是目录: ${cwd}`);
    return { cwd };
}

export interface HeadlessContext {
    host: SessionHost;
    cwd: string;
    signal: AbortSignal;
    onClosing: () => void;
}

export async function runHeadless(
    cwd: string,
    serve: (context: HeadlessContext) => Promise<void>,
): Promise<void> {
    configureHostEnvironment({ stateDir: process.env.ZBOT_STATE_DIR, startupCwd: cwd });
    const restoreConsole = redirectLogsToFile();
    const controller = new AbortController();
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const armExit = (): void => {
        forceTimer ??= setTimeout(() => {
            process.stderr.write("协议宿主收尾超时\n");
            process.exit(1);
        }, 8000);
        forceTimer.unref();
    };
    const onSignal = (): void => { armExit(); controller.abort(); };
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    for (const signal of signals) process.on(signal, onSignal);
    let host: SessionHost | undefined;
    let closeMcp: (() => Promise<void>) | undefined;
    try {
        const { LocalSessionHost, initializeSessionHostRuntime } = await import("../host/session-host.js");
        const { closeAllMcpClients } = await import("../mcp/client-manager.js");
        closeMcp = closeAllMcpClients;
        const { getConfig } = await import("../config/index.js");
        getConfig();
        const runtimeReady = initializeSessionHostRuntime({ watchSkills: false });
        host = new LocalSessionHost(runtimeReady, { startupCwd: cwd });
        await runtimeReady;
        await serve({ host, cwd, signal: controller.signal, onClosing: armExit });
    } finally {
        armExit();
        try { await host?.close(); }
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
