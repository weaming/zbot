/**
 * `zbot session` 的命令解析与输入校验：字符串 → 命令结构，不碰会话存储。
 */

import fs from "node:fs";
import { MAX_SESSION_TITLE_LENGTH } from "../../types/session.js";
import { AppError } from "../../utils/app-error.js";
import { SESSION_CLI_USAGE } from "../help.js";

/** show 默认展示的轮数：够看上下文，又不至于刷屏。 */
const DEFAULT_SHOW_TURNS = 3;
/**
 * 排队投递的默认有效期：只限制"排队等多久"，不影响已开始执行的回合。
 * 与等待上限无关：`--wait` 不设上限，排队到期会回传明确的终态结果（不会静静丢消息）。
 */
const DEFAULT_QUEUE_EXPIRES_SECONDS = 270;
/**
 * 带机器可读分类与退出码的 CLI 错误：`--json` 调用方靠 code / exitCode 判断下一步
 * （例如 wait_timeout 表示"消息已投递，不要重发"）。
 */
export class SessionCliError extends AppError {
    constructor(
        code: string,
        message: string,
        exitCode = 1,
        details: Record<string, unknown> = {},
    ) {
        super(code, message, exitCode, details);
        this.name = "SessionCliError";
    }
}
export interface ListCommand {
    kind: "list";
    /** 含已归档会话。 */
    all: boolean;
    json: boolean;
    /** 只看有实例持有的会话（运行中/闲置但未释放）。 */
    held: boolean;
    /** 只看最近 N 条（排序后的前 N 条）。 */
    limit?: number;
}

export interface ShowCommand {
    kind: "show";
    /** 空串表示用当前会话指针（见 utils/session-pointer）。 */
    id: string;
    /** 取最近更新过的会话，而不是当前会话。 */
    last: boolean;
    turns: number;
    all: boolean;
    full: boolean;
    json: boolean;
    /** 只输出 seq 大于该值的事件（事件视图）。 */
    sinceSeq?: number;
    /** 只输出索引大于该值的回合（回合视图）。 */
    afterTurn?: number;
    /** 精简视图：不带完整 messages。 */
    lite: boolean;
    /** 是否显式给过 --turns（用于和 --since 的互斥校验）。 */
    turnsSpecified?: boolean;
}

export interface NewCommand {
    kind: "new";
    title?: string;
    cwd?: string;
    json: boolean;
}

export interface RenameCommand {
    kind: "rename";
    id: string;
    title: string;
    json: boolean;
}

export interface ArchiveCommand {
    kind: "archive" | "unarchive";
    id: string;
    json: boolean;
}

export interface DeleteCommand {
    kind: "delete";
    id: string;
    json: boolean;
}

export interface SendCommand {
    kind: "send";
    id: string;
    text: string;
    /** 显式等待结果（`--wait`）：默认一直等到 turn 进入终态。 */
    wait: boolean;
    /** 等待上限（秒）；只在 `--wait=秒` 时给定，undefined 表示不设上限。 */
    waitSeconds?: number;
    json: boolean;
    /** 目标忙时排队（默认 true）；--no-queue 关掉后忙即失败。 */
    queue: boolean;
    /** 排队有效期（秒），不是执行时限。 */
    expiresSeconds: number;
    /** 只撤销排队中的消息，不投递正文。 */
    cancelMsgId?: string;
}

export interface QueueCommand {
    kind: "queue";
    id: string;
    json: boolean;
}

export interface WaitCommand {
    kind: "wait";
    /** 空串表示用当前会话指针。 */
    id: string;
    /** 按入站消息 id 定位回合（`session send` 输出的 msgId）。 */
    msgId?: string;
    /** 按回合 id 定位（`session show --json` 的 turnDetails[].id）。 */
    turnId?: string;
    /** 等待上限（秒）；undefined 表示一直等到终态。 */
    timeoutSeconds?: number;
    json: boolean;
}

export interface RunCommand {
    kind: "run";
    text: string;
    title?: string;
    cwd?: string;
    json: boolean;
}

export type SessionCommand =
    | { kind: "help" }
    | ListCommand
    | ShowCommand
    | NewCommand
    | RenameCommand
    | ArchiveCommand
    | DeleteCommand
    | SendCommand
    | QueueCommand
    | WaitCommand
    | RunCommand;

/** 参数/用法错误：`--json` 调用方靠 code=usage 与运行时失败区分开。 */
export function usageError(message: string): SessionCliError {
    return new SessionCliError("usage", message);
}

// ── 参数解析 ──────────────────────────────────────────────────

export function isSessionCliInvocation(argv: string[]): boolean {
    return argv[0] === "session" || argv[0] === "sessions";
}

export function parseSessionArgs(argv: string[]): SessionCommand {
    const [command, ...rest] = argv;
    switch (command) {
        case undefined:
        case "help":
        case "-h":
        case "--help":
            return { kind: "help" };
        case "list":
        case "ls":
            return parseListArgs(rest);
        case "show":
        case "cat":
            return parseShowArgs(rest);
        case "new":
            return parseNewArgs(rest);
        case "rename":
            return parseRenameArgs(rest);
        case "archive":
            return { kind: "archive", ...parseIdOnlyArgs(rest, "archive") };
        case "unarchive":
            return { kind: "unarchive", ...parseIdOnlyArgs(rest, "unarchive") };
        case "delete":
        case "rm":
            return { kind: "delete", ...parseIdOnlyArgs(rest, "delete") };
        case "send":
            return parseSendArgs(rest);
        case "queue":
            return parseQueueArgs(rest);
        case "run":
            return parseRunArgs(rest);
        case "wait":
            return parseWaitArgs(rest);
        default:
            throw usageError(`未知子命令：${command}\n\n${SESSION_CLI_USAGE}`);
    }
}

function parseListArgs(args: string[]): ListCommand {
    const command: ListCommand = { kind: "list", all: false, json: false, held: false };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (arg === "--all" || arg === "-a") command.all = true;
        else if (arg === "--json") command.json = true;
        else if (arg === "--held") command.held = true;
        else if (arg === "--limit" || arg === "-n") {
            command.limit = parsePositiveInt(args[index + 1], arg);
            index += 1;
        } else if (arg.startsWith("--limit=")) {
            command.limit = parsePositiveInt(arg.slice("--limit=".length), "--limit");
        } else if (arg.startsWith("-n=")) {
            command.limit = parsePositiveInt(arg.slice("-n=".length), "-n");
        } else {
            throw usageError(`list 不支持参数：${arg}`);
        }
    }
    return command;
}

function parseShowArgs(args: string[]): ShowCommand {
    const command: ShowCommand = {
        kind: "show",
        id: "",
        last: false,
        turns: DEFAULT_SHOW_TURNS,
        all: false,
        full: false,
        json: false,
        lite: false,
    };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (arg === "--json") command.json = true;
        else if (arg === "--full") command.full = true;
        else if (arg === "--lite") command.lite = true;
        else if (arg === "--all" || arg === "-a") command.all = true;
        else if (arg === "--last" || arg === "-l") command.last = true;
        else if (arg.startsWith("--since=")) {
            // seq 从 1 起，但允许 --since=0 表示“从头按事件流式读”
            command.sinceSeq = parseNonNegativeInt(arg.slice("--since=".length), "--since");
        } else if (arg.startsWith("--after-turn=")) {
            command.afterTurn = parsePositiveInt(arg.slice("--after-turn=".length), "--after-turn");
        } else if (arg === "--since" || arg === "--after-turn") {
            throw usageError(`${arg} 的取值请写成 ${arg}=N（空格形式会被当成会话 id）`);
        } else if (arg === "--turns") {
            command.turns = parsePositiveInt(args[index + 1], "--turns");
            command.turnsSpecified = true;
            index += 1;
        } else if (arg.startsWith("--turns=")) {
            command.turns = parsePositiveInt(arg.slice("--turns=".length), "--turns");
            command.turnsSpecified = true;
        } else if (arg.startsWith("-")) {
            throw usageError(`show 不支持参数：${arg}`);
        } else if (command.id) {
            throw usageError("show 只接受一个会话 id");
        } else {
            command.id = arg;
        }
    }
    if (command.id && command.last) throw usageError("--last 不能与会话 id 同时使用");
    if (!command.id && !command.last && command.sinceSeq !== undefined) {
        // 事件视图必须指向确定的会话：指针可能已被别的实例改写
        throw usageError("--since 需要显式会话 id（当前会话可能已变化）");
    }
    if (command.sinceSeq !== undefined) {
        // 事件视图与回合视图互斥：静默忽略其中一个会让调用方以为参数生效了
        if (command.afterTurn !== undefined) throw usageError("--since 与 --after-turn 不能同时使用");
        if (command.all) throw usageError("--since 是事件视图，不能与 --all 同用");
        if (command.full) throw usageError("--since 是事件视图，不能与 --full 同用");
        if (command.lite) throw usageError("--since 已是精简事件视图，不能与 --lite 同用");
        if (command.turnsSpecified) throw usageError("--since 是事件视图，不能与 --turns 同用");
    }
    return command;
}

function parseNewArgs(args: string[]): NewCommand {
    const command: NewCommand = { kind: "new", json: false };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (arg === "--json") command.json = true;
        else if (arg === "--title") {
            command.title = requireValue(args[index + 1], "--title");
            index += 1;
        } else if (arg.startsWith("--title=")) {
            command.title = requireValue(arg.slice("--title=".length), "--title");
        } else if (arg === "--cwd") {
            command.cwd = requireValue(args[index + 1], "--cwd");
            index += 1;
        } else if (arg.startsWith("--cwd=")) {
            command.cwd = requireValue(arg.slice("--cwd=".length), "--cwd");
        } else {
            throw usageError(`new 不支持参数：${arg}`);
        }
    }
    return command;
}

function parseRenameArgs(args: string[]): RenameCommand {
    // `--` 之后一律当标题，允许标题里出现 - 开头的片段
    const separator = args.indexOf("--");
    const head = separator === -1 ? args : args.slice(0, separator);
    const literalTitle = separator === -1 ? [] : args.slice(separator + 1);
    const [id, ...flagParts] = head;
    if (!id || id.startsWith("-")) throw usageError("用法：zbot session rename <id> <标题>");

    let json = false;
    const titleParts: string[] = [];
    for (const part of flagParts) {
        if (part === "--json") {
            json = true;
            continue;
        }
        // 开关样式的片段明确报错，避免把 --xxx 当成标题静默写进去；正文用 `--` 分隔
        if (part.startsWith("-")) throw usageError(`rename 不支持参数：${part}（标题请写在 -- 之后）`);
        titleParts.push(part);
    }
    const title = [...titleParts, ...literalTitle].join(" ").trim();
    if (!title) throw usageError("rename 需要新标题");
    return { kind: "rename", id, title, json };
}

function parseSendArgs(args: string[]): SendCommand {
    const command: SendCommand = {
        kind: "send",
        id: "",
        text: "",
        wait: false,
        json: false,
        queue: true,
        expiresSeconds: DEFAULT_QUEUE_EXPIRES_SECONDS,
    };
    const textParts: string[] = [];
    // `--` 之后一律当正文，允许消息以 - 开头
    let literal = false;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (!literal && arg === "--") {
            literal = true;
            continue;
        }
        if (!literal) {
            if (arg === "--json") { command.json = true; continue; }
            if (arg === "--queue") { command.queue = true; continue; }
            if (arg === "--no-queue") { command.queue = false; continue; }
            if (arg.startsWith("--expires=")) {
                command.expiresSeconds = parsePositiveInt(arg.slice("--expires=".length), "--expires");
                continue;
            }
            if (arg.startsWith("--cancel=")) {
                command.cancelMsgId = requireValue(arg.slice("--cancel=".length), "--cancel");
                continue;
            }
            if (arg === "--wait") {
                const next = args[index + 1];
                if (next !== undefined && /^\d+$/.test(next)) {
                    throw usageError(`--wait 的秒数请写成 --wait=${next}（空格形式会被当成消息正文）`);
                }
                // 不带秒数 = 一直等到终态；固定短超时会静默丢掉已经投递的结果
                command.wait = true;
                continue;
            }
            if (arg.startsWith("--wait=")) {
                command.wait = true;
                command.waitSeconds = parsePositiveInt(arg.slice("--wait=".length), "--wait");
                continue;
            }
            if (arg.startsWith("-")) throw usageError(`send 不支持参数：${arg}（等待秒数写成 --wait=秒）`);
            if (!command.id) {
                command.id = arg;
                continue;
            }
        }
        textParts.push(arg);
    }
    if (!command.id) throw usageError("用法：zbot session send <id> <文本> [--wait[=秒]]");
    command.text = textParts.join(" ").trim();
    if (command.cancelMsgId && command.text) throw usageError("--cancel 不需要正文");
    return command;
}

function parseQueueArgs(args: string[]): QueueCommand {
    const json = args.includes("--json");
    const unknown = args.find(arg => arg.startsWith("-") && arg !== "--json");
    if (unknown) throw usageError(`queue 不支持参数：${unknown}`);
    const id = args.filter(arg => arg !== "--json")[0];
    if (!id || id.startsWith("-")) throw usageError("用法：zbot session queue <id> [--json]");
    return { kind: "queue", id, json };
}

/**
 * `wait` 的参数：id 可省略（当前会话），选择器二选一，超时可省略（一直等）。
 *
 * `--msg` 是 `session send` 输出的 msgId（最可靠：把消息与回合绑在一起）；
 * `--turn` 是 `session show --json` 的 turnDetails[].id；都不给则等最近一轮。
 */
function parseWaitArgs(args: string[]): WaitCommand {
    const command: WaitCommand = { kind: "wait", id: "", json: false };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (arg === "--json") { command.json = true; continue; }
        if (arg === "--msg") {
            command.msgId = requireValue(args[index + 1], "--msg");
            index += 1;
            continue;
        }
        if (arg.startsWith("--msg=")) {
            command.msgId = requireValue(arg.slice("--msg=".length), "--msg");
            continue;
        }
        if (arg === "--turn") {
            command.turnId = requireValue(args[index + 1], "--turn");
            index += 1;
            continue;
        }
        if (arg.startsWith("--turn=")) {
            command.turnId = requireValue(arg.slice("--turn=".length), "--turn");
            continue;
        }
        if (arg === "--timeout") {
            command.timeoutSeconds = parsePositiveInt(args[index + 1], "--timeout");
            index += 1;
            continue;
        }
        if (arg.startsWith("--timeout=")) {
            command.timeoutSeconds = parsePositiveInt(arg.slice("--timeout=".length), "--timeout");
            continue;
        }
        if (arg.startsWith("-")) throw usageError(`wait 不支持参数：${arg}`);
        if (command.id) throw usageError("wait 只接受一个会话 id");
        command.id = arg;
    }
    if (command.msgId && command.turnId) throw usageError("--msg 与 --turn 不能同时使用");
    return command;
}

function parseRunArgs(args: string[]): RunCommand {
    const command: RunCommand = { kind: "run", text: "", json: false };
    const textParts: string[] = [];
    let literal = false;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (!literal && arg === "--") {
            literal = true;
            continue;
        }
        if (!literal) {
            if (arg === "--json") { command.json = true; continue; }
            if (arg === "--title") {
                command.title = requireValue(args[index + 1], "--title");
                index += 1;
                continue;
            }
            if (arg.startsWith("--title=")) {
                command.title = requireValue(arg.slice("--title=".length), "--title");
                continue;
            }
            if (arg === "--cwd") {
                command.cwd = requireValue(args[index + 1], "--cwd");
                index += 1;
                continue;
            }
            if (arg.startsWith("--cwd=")) {
                command.cwd = requireValue(arg.slice("--cwd=".length), "--cwd");
                continue;
            }
            if (arg.startsWith("-") && arg !== "-") {
                throw usageError(`run 不支持参数：${arg}（正文以 - 开头时用 -- 分隔）`);
            }
        }
        textParts.push(arg);
    }
    command.text = textParts.join(" ").trim();
    if (!command.text) throw usageError("用法：zbot session run <文本> [--title 标题] [--cwd 目录] [--json]");
    return command;
}

/** archive / unarchive / delete 的参数：一个 id + 可选 --json。 */
function parseIdOnlyArgs(args: string[], command: string): { id: string; json: boolean } {
    const unknown = args.find(arg => arg.startsWith("-") && arg !== "--json");
    if (unknown) throw usageError(`${command} 不支持参数：${unknown}`);
    const json = args.includes("--json");
    const positional = args.filter(arg => arg !== "--json");
    const id = positional[0];
    if (!id || id.startsWith("-")) throw usageError(`用法：zbot session ${command} <id> [--json]`);
    if (positional.length > 1) throw usageError(`${command} 只接受一个会话 id`);
    return { id, json };
}

function requireValue(value: string | undefined, flag: string): string {
    if (!value || value.startsWith("-")) throw usageError(`${flag} 需要取值`);
    return value;
}

function parsePositiveInt(value: string | undefined, flag: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw usageError(`${flag} 需要正整数`);
    return parsed;
}

function parseNonNegativeInt(value: string | undefined, flag: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) throw usageError(`${flag} 需要非负整数`);
    return parsed;
}

// ── 输入校验 ─────────────────────────────────────────────────
export function cleanTitle(title: string): string {
    const cleaned = title.trim().slice(0, MAX_SESSION_TITLE_LENGTH);
    if (!cleaned) throw usageError("标题不能为空");
    return cleaned;
}

export function isDirectory(target: string): boolean {
    try {
        return fs.statSync(target).isDirectory();
    } catch {
        return false;
    }
}
