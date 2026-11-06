/**
 * herdr CLI 客户端：只 `zbot herdr` 用，负责新建标签页与在 pane 里执行命令。
 *
 * 走官方 CLI（`$HERDR_BIN_PATH`）而不是自己拼 socket 协议：创建接口的输出是
 * `{ id, result, type }` 信封，标签页与 pane 的 id 在 `result.tab.tab_id` /
 * `result.root_pane.pane_id` 里；解析失败时退化为正则兜底，避免 herdr 换版就把命令打死。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HerdrCliError } from "./args.js";

const execFileAsync = promisify(execFile);
/** 单次 herdr 调用上限：卡住的 CLI 不该把 spawn 挂死。 */
const CALL_TIMEOUT_MS = 20_000;

export interface HerdrSpawnContext {
    binPath: string;
    workspaceId: string;
}

/** 发起本次 spawn 的 pane（herdr 通过环境变量注入）：用于回报「在哪开的」。 */
export interface HerdrCaller {
    workspaceId: string | null;
    tabId: string | null;
    paneId: string | null;
}

export function readHerdrCaller(env: NodeJS.ProcessEnv): HerdrCaller | undefined {
    if (env.HERDR_ENV !== "1") return undefined;
    const caller: HerdrCaller = {
        workspaceId: env.HERDR_WORKSPACE_ID?.trim() || null,
        tabId: env.HERDR_TAB_ID?.trim() || null,
        paneId: env.HERDR_PANE_ID?.trim() || null,
    };
    return caller.workspaceId || caller.tabId || caller.paneId ? caller : undefined;
}

/**
 * 从 herdr 注入的环境变量取上下文：只有确认在 herdr 里运行才继续，
 * 否则「新建标签页」这个前提根本不存在，直接报错比留半个会话干净。
 */
export function readHerdrSpawnContext(
    env: NodeJS.ProcessEnv,
    workspaceOverride?: string,
): HerdrSpawnContext {
    if (env.HERDR_ENV !== "1") {
        throw new HerdrCliError(
            "herdr_unavailable",
            "zbot herdr 需要在 herdr 里运行（HERDR_ENV != 1）：请在 herdr pane 内执行，"
            + "或用 `zbot serve` 提交后台任务",
            1,
            { herdrEnv: env.HERDR_ENV ?? null },
        );
    }
    const binPath = env.HERDR_BIN_PATH?.trim();
    if (!binPath) {
        throw new HerdrCliError("herdr_unavailable", "缺少 HERDR_BIN_PATH：当前环境不是 herdr 拉起的", 1, {});
    }
    const workspaceId = (workspaceOverride ?? env.HERDR_WORKSPACE_ID)?.trim();
    if (!workspaceId) {
        throw new HerdrCliError(
            "herdr_unavailable",
            "缺少 HERDR_WORKSPACE_ID：用 --workspace 指定目标 workspace",
            1,
            {},
        );
    }
    return { binPath, workspaceId };
}

export interface CreateTabInput {
    workspaceId: string;
    cwd: string;
    label: string;
    focus: boolean;
    /** 显式传给新 pane 的环境变量（状态目录这类只在调用方 shell 里设置的值）。 */
    env?: Record<string, string>;
}

export interface CreatedTab {
    tabId: string;
    paneId: string;
}

/** herdr 侧标签页元数据（展示用，字段可能随 herdr 版本增删）。 */
export interface HerdrTabMeta {
    tabId: string;
    workspaceId: string | null;
    label: string | null;
    number: number | null;
    paneCount: number | null;
    focused: boolean | null;
    agentStatus: string | null;
}

/** herdr 侧 pane 元数据：agent_status / tokens 由 pane 内的 zbot 自己上报。 */
export interface HerdrPaneMeta {
    paneId: string;
    tabId: string | null;
    workspaceId: string | null;
    cwd: string | null;
    foregroundCwd: string | null;
    focused: boolean | null;
    agent: string | null;
    agentStatus: string | null;
    title: string | null;
    tokens: Record<string, string> | null;
}

export interface HerdrCli {
    createTab(input: CreateTabInput): Promise<CreatedTab>;
    /** 在 pane 里执行一条命令（等价于输入文本并回车）。 */
    runInPane(paneId: string, command: string): Promise<void>;
    getTab(tabId: string): Promise<HerdrTabMeta | undefined>;
    getPane(paneId: string): Promise<HerdrPaneMeta | undefined>;
    listPanes(): Promise<HerdrPaneMeta[]>;
    closeTab(tabId: string): Promise<void>;
}

export function createHerdrCli(binPath: string): HerdrCli {
    return {
        async createTab(input) {
            const created = parseCreatedTab(await callHerdr(binPath, buildCreateTabArgs(input)));
            if (!created) {
                throw new HerdrCliError("herdr_failed", "herdr tab create 的输出里没有标签页/pane id", 1, {});
            }
            return created;
        },
        async runInPane(paneId, command) {
            await callHerdr(binPath, ["pane", "run", paneId, command]);
        },
        async getTab(tabId) {
            const payload = parseEnvelope(await callHerdr(binPath, ["tab", "get", tabId]));
            return normalizeTab(payload?.tab);
        },
        async getPane(paneId) {
            const payload = parseEnvelope(await callHerdr(binPath, ["pane", "get", paneId]));
            return normalizePane(payload?.pane);
        },
        async listPanes() {
            const payload = parseEnvelope(await callHerdr(binPath, ["pane", "list"])) as
                { panes?: RawPane[] } | undefined;
            return (payload?.panes ?? [])
                .map(normalizePane)
                .filter((pane): pane is HerdrPaneMeta => pane !== undefined);
        },
        async closeTab(tabId) {
            await callHerdr(binPath, ["tab", "close", tabId]);
        },
    };
}

/**
 * `herdr tab create` 的 argv：herdr 的 CLI 只认「空格分词」，`--flag=value` 会报
 * `unknown option`（0.9.5 实测），所以环境变量也必须拆成两个 token。
 */
export function buildCreateTabArgs(input: CreateTabInput): string[] {
    return [
        "tab", "create",
        "--workspace", input.workspaceId,
        "--cwd", input.cwd,
        "--label", input.label,
        input.focus ? "--focus" : "--no-focus",
        ...Object.entries(input.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    ];
}

async function callHerdr(binPath: string, args: string[]): Promise<string> {
    try {
        const { stdout } = await execFileAsync(binPath, args, {
            timeout: CALL_TIMEOUT_MS,
            maxBuffer: 4 * 1024 * 1024,
        });
        return stdout.trim();
    } catch (error) {
        throw new HerdrCliError(
            "herdr_failed",
            `herdr ${args.slice(0, 2).join(" ")} 失败：${describeFailure(error)}`,
            1,
            { args },
        );
    }
}

/** 先判超时/找不到可执行文件，再退回 stderr（herdr 原文）与异常消息。 */
function describeFailure(error: unknown): string {
    const shaped = error as {
        stderr?: unknown;
        message?: unknown;
        code?: unknown;
        killed?: unknown;
        signal?: unknown;
    } | null;
    const code = typeof shaped?.code === "string" ? shaped.code : undefined;
    if (code === "ENOENT") return "找不到 HERDR_BIN_PATH 指向的可执行文件";
    // execFile 超时会杀子进程：此时 stderr 一般是空的，只有 killed/signal 能说明原因
    if (shaped?.killed === true || (typeof shaped?.signal === "string" && shaped.signal.length > 0) || code === "ETIMEDOUT") {
        return `执行超时（${CALL_TIMEOUT_MS / 1000}s，已终止 herdr 子进程）`;
    }
    const stderr = typeof shaped?.stderr === "string" ? shaped.stderr.trim() : "";
    const message = typeof shaped?.message === "string" ? shaped.message.trim() : String(error);
    return (stderr || message).slice(0, 300);
}

function parseCreatedTab(output: string): CreatedTab | undefined {
    const payload = parseEnvelope(output);
    const tabId = payload?.tab?.tab_id;
    const paneId = payload?.root_pane?.pane_id;
    if (typeof tabId === "string" && typeof paneId === "string") return { tabId, paneId };
    // 输出不是 JSON（老版本或人类可读模式）：正则兜底，但必须各自唯一，
    // 否则可能把 `zbot resume` 打进别人的 pane
    const tabMatch = uniqueMatch(output, /"tab_id"\s*:\s*"([^"]+)"/g);
    const paneMatch = uniqueMatch(output, /"pane_id"\s*:\s*"([^"]+)"/g);
    return tabMatch && paneMatch ? { tabId: tabMatch, paneId: paneMatch } : undefined;
}

function uniqueMatch(output: string, pattern: RegExp): string | undefined {
    const hits = new Set([...output.matchAll(pattern)].map(match => match[1]));
    return hits.size === 1 ? [...hits][0] : undefined;
}

/** herdr 的 JSON 信封：`{ id, result, type }`；解析失败返回 undefined（人类可读输出）。 */
function parseEnvelope(output: string): HerdrEnvelope | undefined {
    try {
        const parsed = JSON.parse(output) as { result?: HerdrEnvelope };
        return parsed?.result;
    } catch {
        return undefined;
    }
}

interface HerdrEnvelope {
    tab?: RawTab;
    root_pane?: RawPane;
    pane?: RawPane;
}

interface RawTab {
    tab_id?: unknown;
    workspace_id?: unknown;
    label?: unknown;
    number?: unknown;
    pane_count?: unknown;
    focused?: unknown;
    agent_status?: unknown;
}

interface RawPane {
    pane_id?: unknown;
    tab_id?: unknown;
    workspace_id?: unknown;
    cwd?: unknown;
    foreground_cwd?: unknown;
    focused?: unknown;
    agent?: unknown;
    agent_status?: unknown;
    title?: unknown;
    tokens?: unknown;
}

function normalizeTab(raw: RawTab | undefined): HerdrTabMeta | undefined {
    const tabId = asString(raw?.tab_id);
    if (!tabId) return undefined;
    return {
        tabId,
        workspaceId: asString(raw?.workspace_id) ?? null,
        label: asString(raw?.label) ?? null,
        number: asNumber(raw?.number),
        paneCount: asNumber(raw?.pane_count),
        focused: asBoolean(raw?.focused),
        agentStatus: asString(raw?.agent_status) ?? null,
    };
}

function normalizePane(raw: RawPane | undefined): HerdrPaneMeta | undefined {
    const paneId = asString(raw?.pane_id);
    if (!paneId) return undefined;
    return {
        paneId,
        tabId: asString(raw?.tab_id) ?? null,
        workspaceId: asString(raw?.workspace_id) ?? null,
        cwd: asString(raw?.cwd) ?? null,
        foregroundCwd: asString(raw?.foreground_cwd) ?? null,
        focused: asBoolean(raw?.focused),
        agent: asString(raw?.agent) ?? null,
        agentStatus: asString(raw?.agent_status) ?? null,
        title: asString(raw?.title) ?? null,
        tokens: asTokenMap(raw?.tokens),
    };
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
    return typeof value === "boolean" ? value : null;
}

function asTokenMap(value: unknown): Record<string, string> | null {
    if (!value || typeof value !== "object") return null;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string");
    return entries.length > 0 ? Object.fromEntries(entries) : null;
}
