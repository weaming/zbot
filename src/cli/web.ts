/**
 * web 入口：无 UI 的长驻宿主，把会话能力暴露成 HTTP + SSE。
 *
 * 与 TUI 并列：两者各自在进程内组装同一个 host，互不依赖、互不要求对方运行。
 * 这里只做装配（参数、令牌、生命周期），接口语义全部在 web/ 与 host/。
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { initializeSessionHostRuntime, LocalSessionHost } from "../host/session-host.js";
import { JobRunner } from "../jobs/runner.js";
import { JobStore } from "../jobs/store.js";
import { pushLiveEnd, pushLiveText, pushLiveThinking } from "../web/live-stream.js";
import { startHttpServer, type HttpServerHandle } from "../web/http-server.js";
import { joinInputs, takeInputs } from "../web/pending-inputs.js";
import { setJobCommentWriter } from "../tools/job-context.js";
import { expandHomePath, getStateDir, setStartupToolCwd } from "../utils/runtime-paths.js";
import { discardPendingInput } from "../utils/tty-input.js";
import { createUlid } from "../utils/ulid.js";

const DEFAULT_PORT = 8787;
const DEFAULT_BIND = "127.0.0.1";
const TOKEN_BYTES = 24;
/** 默认并发：两个任务同时跑够用，再多会互相抢 provider 速率与机器资源。 */
const DEFAULT_MAX_CONCURRENT = 2;

/** 收尾超时：MCP stdio 句柄或残留定时器可能让进程挂住，超时后强制退出。 */
const SHUTDOWN_FORCE_EXIT_MS = 8_000;

/** web 生命周期里需要收尾的资源，按依赖顺序排列。 */
interface WebResources {
    server: HttpServerHandle;
    runner: JobRunner;
    host: LocalSessionHost;
    store: JobStore;
}

export interface WebArgs {
    port: number;
    bind: string;
    cwd: string;
    token?: string;
}

export function parseWebArgs(argv: string[]): WebArgs {
    // 与 tui/main.ts 的分流字面量保持一致：改一处必须改另一处
    if (argv[0] !== "web") throw new Error("parseWebArgs 需要以 web 作为首个参数");

    const args: WebArgs = {
        port: DEFAULT_PORT,
        bind: DEFAULT_BIND,
        cwd: process.cwd(),
    };

    for (let index = 1; index < argv.length; index += 1) {
        const value = argv[index + 1];
        switch (argv[index]) {
            case "--port": {
                if (!value) throw new Error("--port 需要端口号");
                const port = Number.parseInt(value, 10);
                if (!Number.isFinite(port) || port < 0 || port > 65535) throw new Error("--port 必须在 0-65535 之间");
                args.port = port;
                index += 1;
                break;
            }
            case "--bind":
                if (!value) throw new Error("--bind 需要地址");
                args.bind = value;
                index += 1;
                break;
            case "--cwd":
                if (!value) throw new Error("--cwd 需要路径");
                args.cwd = path.resolve(expandHomePath(value));
                index += 1;
                break;
            case "--token":
                if (!value) throw new Error("--token 需要令牌");
                args.token = value;
                index += 1;
                break;
            default:
                throw new Error(`未知参数：${argv[index]}`);
        }
    }

    return args;
}

/**
 * 改名前的状态目录（`~/.zbot/serve`）不再读写，但旧令牌与任务库还在里面：
 * 启动时提示一次，免得浏览器拿着旧令牌一直 401、旧任务历史看起来凭空消失。
 */
function warnLegacyStateDir(): void {
    const legacyDir = getStateDir("serve");
    if (!fs.existsSync(legacyDir)) return;
    process.stderr.write(
        `提示：检测到旧状态目录 ${legacyDir}（改名前的令牌与任务库），当前已改用 ${getStateDir("web")}。`
        + "需要旧任务历史就把其中的 db/jobs.sqlite 手工挪过去；不需要就直接删掉该目录，这行提示也会消失。"
        + "令牌会重新生成，页面需重新粘贴。\n",
    );
}

/** 令牌文件：与其它宿主状态同目录，首次启动自动生成，便于本机客户端反复使用。 */
function webTokenFile(): string {
    return getStateDir("web", "token");
}

/**
 * 令牌优先级：命令行 > 环境变量 > 本地文件 > 新生成。
 * 自动生成后落盘（0600），避免每次重启都要求客户端换令牌。
 */
export function resolveWebToken(explicit?: string): string {
    const fromArg = explicit?.trim();
    if (fromArg) return fromArg;

    const fromEnv = process.env.ZBOT_WEB_TOKEN?.trim();
    if (fromEnv) return fromEnv;

    const file = webTokenFile();
    try {
        const saved = fs.readFileSync(file, "utf8").trim();
        if (saved) return saved;
    } catch {
        // 首次启动：下面生成
    }

    const token = randomBytes(TOKEN_BYTES).toString("hex");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    return token;
}

/** 让已写入 stdout/stderr 的内容先刷出去（写入回调触发即表示已交给内核），再结束进程。 */
async function flushStdio(): Promise<void> {
    await Promise.all([
        new Promise<void>(resolve => process.stdout.write("", () => resolve())),
        new Promise<void>(resolve => process.stderr.write("", () => resolve())),
    ]);
}

async function shutdown(
    resources: WebResources,
    reason: string,
    exitCode = 0,
): Promise<void> {
    process.stderr.write(`zbot web 正在停止（${reason}）…\n`);
    const forceExit = setTimeout(() => {
        process.stderr.write("zbot web 收尾超时，强制退出\n");
        process.exit(1);
    }, SHUTDOWN_FORCE_EXIT_MS);
    forceExit.unref();

    try {
        try {
            // 顺序：先断连接（SSE 订阅者不能在下游销毁后还收到回调）→
            // 再停调度（中止在跑的回合）→ 关宿主（等待落盘）→ 关存储
            await resources.server.stop();
            await resources.runner.stop();
            await resources.host.close();
            resources.store.close();
        } catch (error) {
            exitCode = 1;
            process.stderr.write(`zbot web 停止失败：${(error as Error)?.message ?? error}\n`);
        }
        await flushStdio();
    } catch {
        // stdio 已断开（EPIPE 等）：不再尝试写，但必须继续退出，否则进程永远停不下来
    } finally {
        // 排空 tty 输入队列：终端探针（背景色 / 设备属性 / 光标位置）的回包可能还躺在
        // 队列里，web 从不读 stdin，不排掉的话 shell 恢复后会把它当输入回显成一串 ^[。
        const discarded = await discardPendingInput();
        if (discarded > 0) {
            process.stderr.write(`排空终端输入队列：丢弃 ${discarded} 字节残留应答\n`);
        }
        clearTimeout(forceExit);
        // 收尾完成即退出：残留句柄（MCP stdio 等）不该让进程挂着
        process.exit(exitCode);
    }
}

/** SSE 心跳间隔：与 http-server 默认值保持一致。 */
const SSE_HEARTBEAT_MS = 15_000;

/** 并发上限：环境变量可调，但夹在 1..16，避免把 provider 速率打爆。 */
function resolveMaxConcurrent(): number {
    const parsed = Number.parseInt(process.env.ZBOT_JOBS_MAX_CONCURRENT ?? "", 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CONCURRENT;
    return Math.min(parsed, 16);
}

export async function runWeb(argv: string[]): Promise<void> {
    const args = parseWebArgs(argv);
    const token = resolveWebToken(args.token);
    warnLegacyStateDir();

    // 启动信息走 stderr：stdout 留给需要管道化的机器输出。
    process.stderr.write(`zbot web 启动中（cwd=${args.cwd}）\n`);

    // 工作目录是任务基准：工具层（TUI_CWD / startupToolCwd）与新会话默认值必须同一口径。
    process.chdir(args.cwd);
    process.env.TUI_CWD = args.cwd;
    setStartupToolCwd(args.cwd);

    const runtimeReady = initializeSessionHostRuntime();
    const host = new LocalSessionHost(runtimeReady, { startupCwd: args.cwd });
    await runtimeReady;

    // Job 存储与调度与宿主同进程：租约负责崩溃后判定 lost，队列本身持久化在 SQLite
    const jobsDbPath = getStateDir("web", "db", "jobs.sqlite");
    const store = new JobStore({ path: jobsDbPath });
    // agent 在任务里用 job_comment 工具写评论：装配层把工具层的写入意图接到存储上
    setJobCommentWriter(({ jobId, sessionId, body }) => {
        store.addComment({ jobId, ...(sessionId ? { sessionId } : {}), author: "agent", body });
    });
    const runner = new JobRunner({
        store,
        host,
        owner: createUlid(),
        maxConcurrent: resolveMaxConcurrent(),
        // web 端在回合中输入的内容：下一次请求前带给模型
        consumePendingInputs: sessionId => takeInputs(sessionId, "request"),
    });
    runner.start();

    // 「下次 turn 才带上」的输入：等回合收尾、会话锁释放后再开一轮，
    // 不打断正在跑的推理；多条排队输入合成一段，避免拆成多个回合。
    host.onTurnFinished = sessionId => {
        const queued = takeInputs(sessionId, "turn");
        if (!queued || queued.length === 0) return;
        void host
            .sendMessage(sessionId, joinInputs(queued), {
                consumePendingMessages: () => takeInputs(sessionId, "request"),
            })
            .catch(error => console.error(`[web] 会话 ${sessionId} 追加回合失败:`, error));
    };

    let server: HttpServerHandle;
    try {
        server = startHttpServer({
            host,
            port: args.port,
            bind: args.bind,
            token,
            heartbeatMs: SSE_HEARTBEAT_MS,
            jobs: { store, runner, host, heartbeatMs: SSE_HEARTBEAT_MS },
        });
    } catch (error) {
        // 端口被占用等启动失败必须退出：否则进程留着但没监听，调用方以为服务在跑
        process.stderr.write(`zbot web 启动失败：${(error as Error)?.message ?? error}\n`);
        runner.stop();
        host.close().catch(() => undefined);
        process.exit(1);
    }
    const resources: WebResources = { server, runner, host, store };
    process.stderr.write(`zbot web 已就绪 ${server.url}\n`);
    process.stderr.write(`任务队列：${jobsDbPath}（并发上限 ${resolveMaxConcurrent()}）\n`);
    process.stderr.write(`访问令牌：${token}\n`);
    // 把宿主的事件流接到实时信号：只有界面要渲染的两类——正在生成的正文、是否在思考。
    // 推理正文与工具参数增量都不推（前者不渲染，后者等消息定稿后随工具块一次给）。
    host.onEvent = (_requestId, sessionId, event) => {
        switch (event.type) {
            case "text_delta":
                pushLiveText(sessionId, event.delta);
                break;
            case "reasoning_delta":
                pushLiveThinking(sessionId, true);
                break;
            case "message_end":
            case "error":
            case "aborted":
                pushLiveEnd(sessionId);
                break;
            case "steer_update":
                if (event.phase === "completed" || event.phase === "steered") pushLiveEnd(sessionId);
                break;
            default:
                break;
        }
    };


    // 长驻服务：单次漏处理的 rejection 不该带走服务；未捕获异常则视为状态不可信，走收尾退出。
    // 处理器在 runtimeReady 之后注册：启动期没有需要清理的资源，此时收到信号直接退出即可。
    let stopping = false;
    const stop = (reason: string, exitCode = 0): void => {
        if (stopping) return;
        stopping = true;
        void shutdown(resources, reason, exitCode);
    };
    process.on("unhandledRejection", reason => {
        console.error("[web] 未处理的 Promise 拒绝:", reason);
    });
    process.on("uncaughtException", error => {
        console.error("[web] 未捕获异常:", error);
        // 非 0 退出码：让 systemd/docker 的失败重启策略能识别这次是崩溃而不是正常停止
        stop("uncaughtException", 1);
    });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.once(signal, () => stop(signal));
    }

    // 长驻：生命周期由信号或致命异常驱动，这里只是不让函数返回
    await new Promise<void>(() => {});
}
