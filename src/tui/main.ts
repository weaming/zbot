/**
 * TUI 入口：在当前宿主机进程内启动 agent，并连接 mcp-hub。
 */

import dotenv from "dotenv";
import os from "os";
import path from "path";
import { configureHostEnvironment, getStartupCwd, redirectLogsToFile } from "../host/runtime-context.js";
import { officialDeepSeekCostYuan } from "../pricing/deepseek.js";
import { isPrintCliInvocation } from "../cli/print.js";
import { isSessionCliInvocation } from "../cli/session.js";
import { printCliHelp } from "../cli/help.js";
import type { ChatApp } from "./app.js";

const DEFAULT_ENV_FILE = path.join(os.homedir(), ".zbot", "env");

function resolveEnvFile(value: string): string {
    if (value === "~") return os.homedir();
    if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
    return value;
}

const envFile = resolveEnvFile(process.env.ZBOT_ENV_FILE || DEFAULT_ENV_FILE);
const cliArgs = process.argv.slice(2);
const isSessionCli = isSessionCliInvocation(cliArgs);
/**
 * 帮助分支：必须在 dotenv 与 configureHostEnvironment 之前 ——
 * 打印用法不该初始化宿主环境，更不能落回 TUI 把终端交给聊天界面。
 */
const isHelpCli = printCliHelp(cliArgs);
/**
 * serve 分流用字面量判断而非常量导入：常量导入会把 cli/serve → server/http → host
 * 整条静态模块图拉进 TUI 进程，TUI 静态依赖里就会多出 HTTP 前端。
 */
const isServeCli = cliArgs[0] === "serve";

/**
 * 会话 CRUD 分支：必须在 dotenv 与 configureHostEnvironment 之前分流 ——
 * 后者会把 ZBOT_STATE_DIR 固定到 ~/.zbot、改写 TUI_CWD 并重定向日志。
 *
 * 收尾只设 exitCode、不调 process.exit：stdout 接管道时写入是异步的，
 * 提前退出会把 `--json`/`--full` 的大段输出截断在 64KiB，`| jq` 直接解析失败。
 */
if (isHelpCli) {
    // 用法已输出，不进入任何宿主分支
} else if (isSessionCli) {
    try {
        const { runSessionCli } = await import("../cli/session.js");
        await runSessionCli(cliArgs.slice(1));
    } catch (error: any) {
        const message = error?.message ?? String(error);
        process.exitCode = typeof error?.exitCode === "number" ? error.exitCode : 1;
        if (cliArgs.includes("--json")) {
            // 结构化错误也走 stdout，调用方不必解析本地化文案
            process.stdout.write(`${JSON.stringify({
                error: {
                    ...(error?.details ?? {}),
                    code: error?.code ?? "failed",
                    message,
                },
            })}\n`);
        } else {
            process.stderr.write(`${message}\n`);
        }
    }
} else if (isServeCli) {
    // 长驻宿主分支：与 TUI 并列，初始化同一套宿主环境后交给 serve 入口，不再进入 TUI。
    dotenv.config({ path: envFile, quiet: true });
    configureHostEnvironment();
    try {
        const { runServe } = await import("../cli/serve.js");
        await runServe(cliArgs);
    } catch (error: any) {
        process.stderr.write(`${error?.message ?? error}\n`);
        process.exitCode = 1;
    }
} else {
    // quiet：不向终端输出 "injected env" 提示，避免启动前污染主 buffer。
    dotenv.config({ path: envFile, quiet: true });
    configureHostEnvironment();
}

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const SIGNAL_EXIT_CODES = {
    SIGINT: 130,
    SIGTERM: 143,
    SIGHUP: 129,
} as const;
const SHUTDOWN_GRACE_PERIOD_MS = 8_000;

/**
 * TUI 全局异常护栏：把 uncaughtException / unhandledRejection 打到 tui.log，
 * 进程不主动退出（用户仍可用 ⌃D 退出）。这些通常是 MCP 重连、定时器回调、
 * 异步工具执行的边界错误，吞掉不会让 TUI 状态机更糟。
 */
function installGlobalErrorGuards(): void {
    process.on("uncaughtException", (err) => {
        console.error("[TUI] uncaughtException:", err?.stack ?? err);
    });
    process.on("unhandledRejection", (reason) => {
        console.error("[TUI] unhandledRejection:", reason);
    });
}

function installShutdownSignalHandlers(app: ChatApp): () => void {
    let shutdownStarted = false;
    let shutdownExitCode = 0;

    const handlers = SHUTDOWN_SIGNALS.map((signal) => {
        const handler = (): void => {
            if (shutdownStarted) {
                app.forceShutdown(shutdownExitCode);
                return;
            }

            shutdownStarted = true;
            shutdownExitCode = SIGNAL_EXIT_CODES[signal];
            const forceTimer = setTimeout(() => app.forceShutdown(shutdownExitCode), SHUTDOWN_GRACE_PERIOD_MS);
            forceTimer.unref();
            void app.shutdown(shutdownExitCode)
                .catch((error) => {
                    console.error(`[TUI] ${signal} 优雅退出失败:`, error);
                    app.forceShutdown(shutdownExitCode);
                })
                .finally(() => clearTimeout(forceTimer));
        };
        process.on(signal, handler);
        return { signal, handler };
    });

    return () => {
        for (const { signal, handler } of handlers) {
            process.removeListener(signal, handler);
        }
    };
}

async function startChatApp(): Promise<void> {
    // 尽早重定向 console：import 阶段（如 ToolLRU 加载日志、MCP 初始化）的输出
    // 也会写入 TUI 日志文件，而不是污染进入 alternate screen 前的主 buffer。
    const restoreConsole = redirectLogsToFile();
    let started = false;
    try {
        const [{ ChatApp }, { LocalSessionHost, initializeSessionHostRuntime }, { ChatStore }, chatRuntime] = await Promise.all([
            import("./app.js"),
            import("../host/session-host.js"),
            import("./store.js"),
            import("../services/chat-runtime.js"),
        ]);
        const runtimeReady = initializeSessionHostRuntime();
        void runtimeReady.catch(() => undefined);
        const providerError = chatRuntime.validateChatApiSettings(chatRuntime.getChatApiSettings());
        const startupMessage = providerError
            ? `⚠️ LLM provider 配置无效：${providerError}\n请检查配置文件：${envFile}`
            : undefined;
        const chatStore = new ChatStore({
            costFor: (usage, atMs) => officialDeepSeekCostYuan(usage, atMs, chatRuntime.getChatApiSettings()),
        });
        const app = new ChatApp(new LocalSessionHost(runtimeReady, { startupCwd: getStartupCwd() }), chatStore);
        // 启动期阻断（provider 配置无效）由 app 统一维护 herdr 状态，避免后续同步把 blocked 覆盖成 idle
        if (providerError) app.setHerdrBlocked(providerError);
        const removeSignalHandlers = installShutdownSignalHandlers(app);
        try {
            await app.init(startupMessage);
            await runtimeReady;
        } catch (error) {
            removeSignalHandlers();
            throw error;
        }
        started = true;
    } finally {
        if (!started) restoreConsole();
    }
}

async function main(): Promise<void> {
    if (isPrintCliInvocation(cliArgs)) {
        try {
            const { runPrintCli } = await import("../cli/print.js");
            await runPrintCli(cliArgs);
        } catch (error: any) {
            process.stderr.write(`${error?.message ?? error}\n`);
            process.exitCode = error?.name === "AbortError"
                ? (process.exitCode === 143 ? 143 : 130)
                : (process.exitCode === 143 ? 143 : 1);
        }
        return;
    }

    installGlobalErrorGuards();
    if (cliArgs[0] === "mcp") {
        try {
            const { runMcpCli } = await import("../mcp/cli.js");
            await runMcpCli(cliArgs.slice(1));
        } catch (error: any) {
            process.stderr.write(`❌ ${error?.message ?? error}\n`);
            process.exitCode = 1;
        }
        return;
    }

    // 启动失败（如 mcp-hub 偶发抖动）做一次重试，避免用户手动重启 TUI。
    try {
        await startChatApp();
    } catch (error: any) {
        console.error(`❌ TUI 启动失败: ${error?.message ?? error}，5s 后重试一次...`);
        await new Promise(resolve => setTimeout(resolve, 5_000));
        await startChatApp();
    }
}

// 末尾启动：模块级常量（SHUTDOWN_SIGNALS 等）此时已初始化，main() 不会在 TDZ 里跑。
// serve 分支自己跑完生命周期（长驻到收到终止信号），不能再落回 TUI 的 main()。
if (!isHelpCli && !isSessionCli && !isServeCli) {
    main().catch((error) => {
        console.error(`💥 TUI main() rejected: ${error?.message ?? error}`);
        process.exit(1);
    });
}
