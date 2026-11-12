import path from "path";
import os from "os";
import { getRuntimeConfig } from "../config/index.js";
import { getAsyncToolCwd } from "./tool-cwd-context.js";

const DEFAULT_STATE_DIR = path.join(os.homedir(), ".zbot");

export function getStateDir(...parts: string[]): string {
    const stateRoot = process.env.ZBOT_STATE_DIR || DEFAULT_STATE_DIR;
    return path.join(path.resolve(expandEnv(stateRoot)), ...parts);
}

export function getToolCwd(): string {
    const scopedCwd = getAsyncToolCwd();
    if (scopedCwd) return path.resolve(scopedCwd);

    const tuiCwd = process.env.TUI_CWD || process.cwd();
    return path.resolve(expandEnv(tuiCwd));
}

/** 展示用路径：HOME 前缀替换为 `~`，其余原样。 */
export function formatDisplayPath(target: string, home: string | undefined = process.env.HOME): string {
    if (!home) return target;
    const trimmed = target.replace(/[\\/]+$/, "");
    if (trimmed === home) return "~";
    return trimmed.startsWith(`${home}/`) ? `~${trimmed.slice(home.length)}` : target;
}

/** 解析用户输入：`~` / `~/x` 展开 home，相对路径相对 base 解析。 */
export function resolveCwdInput(input: string, base: string, home: string | undefined = process.env.HOME): string {
    const trimmed = input.trim();
    const homeDir = home || os.homedir();
    if (trimmed === "~" || trimmed.startsWith("~/")) return path.resolve(expandHomePath(trimmed, homeDir));
    return path.resolve(base, trimmed);
}

/** 展开 `~` / `~/x` 为 home 绝对路径；其余输入原样返回（调用方自行决定相对基准）。 */
export function expandHomePath(value: string, home: string = os.homedir()): string {
    if (value === "~") return home;
    if (value.startsWith("~/")) return path.join(home, value.slice(2));
    return value;
}

let startupToolCwd: string | null = null;

/** 登记进程启动目录（TUI 启动时调用）：旧会话缺 cwd 时回退到这里。 */
export function setStartupToolCwd(cwd: string): void {
    startupToolCwd = path.resolve(expandEnv(cwd));
}

/**
 * 启动目录：旧会话没有 cwd 时的回退基准。
 * 不能用 getToolCwd()——它随会话切换变化，会把上一个会话的目录当成默认值。
 */
export function getStartupToolCwd(): string {
    if (startupToolCwd) return startupToolCwd;
    return path.resolve(expandEnv(process.env.TUI_CWD || process.cwd()));
}

export function getUserSkillsDir(...parts: string[]): string {
    return getStateDir("skills", ...parts);
}

/** TUI 共享技能目录，兼容 ~/.agents/skills 中的用户级技能。 */
export function getAgentsSkillsDir(...parts: string[]): string {
    const homeDir = process.env.HOME || os.homedir();
    return path.join(homeDir, ".agents", "skills", ...parts);
}

/** 默认记忆用户：配置里的 runtime.memoryUserId。 */
export function getDefaultMemoryUserId(): number {
    return getRuntimeConfig().memoryUserId;
}

export function normalizeMemoryUserId(userId?: number | string): number {
    if (userId === undefined || userId === "") return getDefaultMemoryUserId();

    const parsedUserId = typeof userId === "number" ? userId : Number(userId);
    return Number.isSafeInteger(parsedUserId) && parsedUserId >= 0
        ? parsedUserId
        : getDefaultMemoryUserId();
}

export function getSessionsDir(...parts: string[]): string {
    return getStateDir("sessions", ...parts);
}

/** 会话任务清单目录：sessions/todos/。 */
function getSessionTodosDir(...parts: string[]): string {
    return getSessionsDir("todos", ...parts);
}

/** 单个会话的任务清单文件：sessions/todos/<sessionId>.json（删除会话时一并清理）。 */
export function getSessionTodosFile(sessionId: string): string {
    return getSessionTodosDir(`${sessionId}.json`);
}

/** 展开 ${VAR} 形式的环境变量引用。 */
function expandEnv(value: string): string {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "");
}
