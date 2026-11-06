import fs from "fs";
import os from "os";
import path from "path";
import embeddedIdentity from "./AGENTS.md" with { type: "text" };
import { setEmbeddedIdentity } from "../skills/base-skill.js";
import { getSessionLogFile, getStartupLogFile } from "../utils/state-paths.js";
import { CONSOLE_TIMESTAMP_MARK } from "../utils/logger.js";
import { expandHomePath, setStartupToolCwd } from "../utils/runtime-paths.js";

const DEFAULT_HOST_STATE_DIR = path.join(os.homedir(), ".zbot");
const DEFAULT_HOST_SRC_ROOT = "src";
const CONTAINER_PATH_PREFIX = "/app/";
const STARTUP_LOG_MAX_BYTES = 2 * 1024 * 1024;
const STARTUP_LOG_KEEP_LINES = 100;
const STARTUP_LOG_TRIM_INTERVAL_MS = 60_000;
const LOG_TAIL_CHUNK_BYTES = 64 * 1024;

function isContainerPath(value: string | undefined): boolean {
    return !value || value.startsWith(CONTAINER_PATH_PREFIX);
}

function resolveHostSrcRoot(): string {
    const configuredSrcRoot = process.env.TUI_SRC_ROOT || process.env.SRC_ROOT;
    if (configuredSrcRoot && !isContainerPath(configuredSrcRoot)) {
        return path.resolve(expandHomePath(configuredSrcRoot));
    }

    return path.join(os.homedir(), DEFAULT_HOST_SRC_ROOT);
}

function rewriteContainerServicesForHost(): void {
    if (!process.env.MCP_HUB_URL || process.env.MCP_HUB_URL.includes("://mcp-hub:")) {
        process.env.MCP_HUB_URL = "http://127.0.0.1:3010/mcp";
    }
    if (!process.env.NETWORK_PROXY || process.env.NETWORK_PROXY.includes("host.docker.internal")) {
        process.env.NETWORK_PROXY = "http://localhost:7890";
    }
}

function formatLogArgument(argument: unknown): string {
    if (argument instanceof Error) return argument.stack || argument.message;
    if (typeof argument === "string") return argument;

    try {
        return JSON.stringify(argument);
    } catch {
        return String(argument);
    }
}

let currentLogFile: string | null = null;
let trimTimer: ReturnType<typeof setInterval> | undefined;
let startupCwd = "";

/** TUI 启动时的 cwd：新会话默认工作目录的固定基准，不随会话切换而变化。 */
export function getStartupCwd(): string {
    return startupCwd || process.cwd();
}

/** 从文件末尾向前分块读取最后 count 行，避免整读大文件。 */
function readLastLines(file: string, count: number): string[] {
    const fd = fs.openSync(file, "r");

    try {
        let pos = fs.fstatSync(fd).size;
        const chunks: string[] = [];
        let lineCount = 0;

        while (pos > 0 && lineCount <= count) {
            const len = Math.min(LOG_TAIL_CHUNK_BYTES, pos);
            pos -= len;
            const buf = Buffer.allocUnsafe(len);
            fs.readSync(fd, buf, 0, len, pos);
            const chunk = buf.toString("utf8");
            chunks.push(chunk);
            // 块内完整行数，仅用于判断是否已覆盖足够行
            lineCount += chunk.split("\n").length - 1;
        }

        const lines = chunks.reverse().join("").split("\n");
        // 未读到文件头时首行是残片
        if (pos > 0) lines.shift();
        if (lines[lines.length - 1] === "") lines.pop();
        return lines;
    } finally {
        fs.closeSync(fd);
    }
}

/** startup.log 超过 2M 时裁剪为最后 100 行，避免长期运行无限膨胀。 */
function trimStartupLog(file: string): void {
    try {
        if (fs.statSync(file).size <= STARTUP_LOG_MAX_BYTES) return;

        const kept = readLastLines(file, STARTUP_LOG_KEEP_LINES).slice(-STARTUP_LOG_KEEP_LINES);
        const header = `${new Date().toISOString()} startup.log trimmed, kept last ${STARTUP_LOG_KEEP_LINES} lines`;
        fs.writeFileSync(file, `${[header, ...kept].join("\n")}\n`, "utf8");
    } catch {
        // 裁剪失败不应阻断日志写入。
    }
}

/** 启动日志裁剪：启动时执行一次，之后每分钟一次，避免每写一行都 stat。 */
function startTrimTimer(): void {
    if (trimTimer) clearInterval(trimTimer);
    trimStartupLog(getStartupLogFile());
    trimTimer = setInterval(() => trimStartupLog(getStartupLogFile()), STARTUP_LOG_TRIM_INTERVAL_MS);
    trimTimer.unref?.();
}

/** 将 agent 和 MCP 的后台日志写入文件，避免破坏 TUI 的终端绘制。 */
export function redirectLogsToFile(): () => void {
    currentLogFile = getStartupLogFile();
    startTrimTimer();
    const original = {
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error,
        debug: console.debug,
    };
    const writeLog = (...args: unknown[]): void => {
        try {
            if (!currentLogFile) return;
            fs.mkdirSync(path.dirname(currentLogFile), { recursive: true });
            fs.appendFileSync(
                currentLogFile,
                `${new Date().toISOString()} ${args.map(formatLogArgument).join(" ")}\n`,
                "utf8",
            );
        } catch {
            // 日志写入失败不应影响 TUI。
        }
    };

    console.log = writeLog;
    console.info = writeLog;
    console.warn = writeLog;
    console.error = writeLog;
    console.debug = writeLog;
    // 标记：行首 ISO 时间戳已由 writeLog 提供，logger 的 console patch 不要再叠加本地时间
    (console as unknown as Record<symbol, unknown>)[CONSOLE_TIMESTAMP_MARK] = true;

    return () => {
        if (trimTimer) {
            clearInterval(trimTimer);
            trimTimer = undefined;
        }
        currentLogFile = null;
        console.log = original.log;
        console.info = original.info;
        console.warn = original.warn;
        console.error = original.error;
        console.debug = original.debug;
        delete (console as unknown as Record<symbol, unknown>)[CONSOLE_TIMESTAMP_MARK];
    };
}

/** 会话就绪后把日志目标切到该会话的文件；日志按 session 分离存储。 */
export function setLogSession(sessionId: string | null): void {
    if (currentLogFile) {
        currentLogFile = sessionId ? getSessionLogFile(sessionId) : getStartupLogFile();
    }
}

/**
 * 解析宿主环境要用的状态目录与启动目录：显式给值优先（一次性 CLI 沿用调用方），
 * 否则回落到 `~/.zbot` 与当前目录。纯函数，便于单独验证。
 */
export function resolveHostEnvironment(
    options: { stateDir?: string; startupCwd?: string } = {},
): { stateDir: string; startupCwd: string } {
    return {
        stateDir: options.stateDir ?? DEFAULT_HOST_STATE_DIR,
        startupCwd: options.startupCwd ?? process.cwd(),
    };
}

/**
 * 将本地工具依赖的路径和宿主服务地址切换为 TUI 所在环境。
 *
 * `stateDir`/`startupCwd` 供独立宿主（如 TUI 与 web）覆盖：调用方可能已经用自定义
 * 状态目录解析出会话，这里再切回 `~/.zbot` 就会「会话不存在」。
 */
export function configureHostEnvironment(
    options: { stateDir?: string; startupCwd?: string } = {},
): void {
    const { stateDir, startupCwd: startup } = resolveHostEnvironment(options);
    const srcRoot = resolveHostSrcRoot();
    fs.mkdirSync(stateDir, { recursive: true });

    process.env.SRC_ROOT = srcRoot;
    process.env.ZBOT_STATE_DIR = stateDir;
    setEmbeddedIdentity(embeddedIdentity);
    process.env.ZBOT_EXTRA_IDENTITY_FILE = path.join(os.homedir(), ".zbot", "AGENTS.md");
    process.env.TUI_PLATFORM = `${process.platform} ${process.arch}`;
    process.env.TUI_CWD = startup;
    // 固化启动目录：TUI_CWD 之后会随会话切换被改写，新建会话仍须以启动目录为初始值。
    startupCwd = startup;
    // 同一份固化值也交给工具层：旧会话缺 cwd 时不能继承当前选中会话的目录。
    setStartupToolCwd(startup);
    process.env.TUI_SRC_ROOT = srcRoot;
    rewriteContainerServicesForHost();
}
