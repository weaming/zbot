/**
 * 会话命令行：让其他 AI 或用户直接增删查改 ~/.zbot/sessions 下的会话。
 *
 * 与 TUI 并存时的安全边界：
 * - 读操作（list / show）只读事件日志，任何时刻可执行；
 * - 写操作（new / rename / archive / unarchive / delete）要求目标会话未被任何实例持有
 *   （控制 socket 无监听者），并在会话锁内落盘，避免与运行中的 TUI 双写事件序列；
 * - send 是唯一需要"有实例持有"的操作：它通过控制 socket 投递给运行中的会话。
 *
 * 输出默认人类可读，`--json` 给结构化数据（供其他 AI 解析）。
 */

import fs from "node:fs";
import path from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentEvent } from "../events/agent-events.js";
import { EventLog } from "../events/event-log.js";
import { listSavedSessionIds } from "../events/session-files.js";
import { SessionReplay } from "../events/session-replay.js";
import { summarizeEvents } from "../host/summary.js";
import { abbreviatePath } from "../format/path.js";
import { describeOrigin } from "../format/session-origin.js";
import { padColumns, truncatePlain } from "../format/text.js";
import { sortSessions, type SessionOrderItem } from "../utils/session-order.js";
import { formatRelativeTime } from "../utils/time.js";
import { createUlid } from "../utils/ulid.js";
import { getSessionsDir, resolveCwdInput } from "../utils/runtime-paths.js";
import { patchArgumentsJson } from "../utils/patch-args.js";
import { isUlid, sanitizeSessionId, shortSessionId } from "../utils/session-id.js";
import { acquireSessionLock } from "../utils/session-lock.js";
import { removeSessionArtifacts } from "../events/session-cleanup.js";
import {
    describeOwnership as describePeerOwnership,
    listOwnership,
    probeOwnership,
    type PeerOwnership,
} from "../control/registry.js";
import { getSocketPath, removeSocketFile } from "../control/paths.js";
import { PeerConnectError, PeerConnection } from "../control/client.js";
import { describeClaimFailure } from "../control/channel.js";
import { createPeerMessage, isCancelledStopReason, type PeerResult } from "../control/protocol.js";
import type { SessionSummary } from "../host/session-host-types.js";
import { MAX_SESSION_TITLE_LENGTH, type StoredChatMessage } from "../types/session.js";
import type { ChatModelSelection } from "../types/chat-model.js";
import type { UserContent } from "../types/image.js";
import { AppError } from "../utils/app-error.js";
import { SESSION_CLI_USAGE } from "./help.js";

/** show 默认展示的轮数：够看上下文，又不至于刷屏。 */
const DEFAULT_SHOW_TURNS = 3;
/** 非 --full 时单条消息的预览列宽。 */
const MESSAGE_PREVIEW_COLUMNS = 200;
/** --lite 的 assistant 摘要列宽。 */
const LITE_ASSISTANT_COLUMNS = 300;
/** 列表列宽上限：宽字符按显示列计，避免中文标题把表格拉歪。 */
const TITLE_COLUMNS = 40;
const CWD_COLUMNS = 28;
/** send --wait 的默认等待上限。 */
const DEFAULT_WAIT_SECONDS = 300;
/**
 * 排队投递的默认有效期：只限制"排队等多久"，不影响已开始执行的回合。
 * 必须短于结果等待上限（control 侧默认 10 分钟），否则 --wait 会先超时并判"结果丢失"。
 */
const DEFAULT_QUEUE_EXPIRES_SECONDS = 270;

const eventLog = new EventLog();
const replay = new SessionReplay(eventLog);

/** 列表行：摘要 + 归属（socket 探测结果）；排序键与摘要同源，供 sortSessions 使用。 */
export interface SessionListRow extends SessionOrderItem {
    summary: SessionSummary;
    ownership?: PeerOwnership;
    /** 真实创建时间（首条事件 ts）。 */
    createdAt?: string;
    /** 日志文件存在但读不出任何有效事件：保留一行并标注，别让它从列表里静默消失。 */
    corrupted?: boolean;
}

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

interface ListCommand {
    kind: "list";
    all: boolean;
    json: boolean;
}

interface ShowCommand {
    kind: "show";
    id: string;
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

interface NewCommand {
    kind: "new";
    title?: string;
    cwd?: string;
    json: boolean;
}

interface RenameCommand {
    kind: "rename";
    id: string;
    title: string;
    json: boolean;
}

interface ArchiveCommand {
    kind: "archive" | "unarchive";
    id: string;
    json: boolean;
}

interface DeleteCommand {
    kind: "delete";
    id: string;
    json: boolean;
}

interface SendCommand {
    kind: "send";
    id: string;
    text: string;
    /** undefined 表示不等待结果（异步投递）。 */
    waitSeconds?: number;
    json: boolean;
    /** 目标忙时排队（默认 true）；--no-queue 关掉后忙即失败。 */
    queue: boolean;
    /** 排队有效期（秒），不是执行时限。 */
    expiresSeconds: number;
    /** 只撤销排队中的消息，不投递正文。 */
    cancelMsgId?: string;
}

interface QueueCommand {
    kind: "queue";
    id: string;
    json: boolean;
}

interface RunCommand {
    kind: "run";
    text: string;
    title?: string;
    cwd?: string;
    json: boolean;
}

type SessionCommand =
    | { kind: "help" }
    | ListCommand
    | ShowCommand
    | NewCommand
    | RenameCommand
    | ArchiveCommand
    | DeleteCommand
    | SendCommand
    | QueueCommand
    | RunCommand;

/** 一次性本地宿主的装配形态（send 无持有者时临时接管用）。 */
export interface LocalSendHost {
    createSessionForCli(cwd: string, init?: { origin?: "user" | "web" | "job" | "tool"; title?: string }): Promise<{ sessionId: string }>;
    claimSession(sessionId: string, options?: { noNegotiate?: boolean }): Promise<{ ok: boolean; reason?: string; message?: string }>;
    executePeerCommandLocally(
        sessionId: string,
        text: string,
    ): Promise<
        | { kind: "command"; ok: boolean; output: string; stopReason: string; finish: () => Promise<void> }
        | { kind: "prompt"; prompt: string }
    >;
    sendMessage(sessionId: string, text: string): Promise<{ aborted?: boolean }>;
    subscribeEvents(...args: any[]): () => void;
    abortSession(sessionId: string): Promise<boolean>;
    close(): Promise<void>;
}

export interface SessionCliIO {
    /** 标准输出：默认写 process.stdout。 */
    write?: (text: string) => void;
    /** 读取 stdin（send 未给文本时用）；默认读到 EOF。 */
    readStdin?: () => Promise<string>;
    /** send 无持有者时的一次性宿主（测试注入；默认创建真实 LocalSessionHost + 运行时）。 */
    createLocalSendHost?: (startupCwd: string) => Promise<LocalSendHost>;
}

/** 参数/用法错误：`--json` 调用方靠 code=usage 与运行时失败区分开。 */
function usageError(message: string): SessionCliError {
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
        default:
            throw usageError(`未知子命令：${command}\n\n${SESSION_CLI_USAGE}`);
    }
}

function parseListArgs(args: string[]): ListCommand {
    const command: ListCommand = { kind: "list", all: false, json: false };
    for (const arg of args) {
        if (arg === "--all" || arg === "-a") command.all = true;
        else if (arg === "--json") command.json = true;
        else throw usageError(`list 不支持参数：${arg}`);
    }
    return command;
}

function parseShowArgs(args: string[]): ShowCommand {
    const command: ShowCommand = {
        kind: "show",
        id: "",
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
    if (!command.id) throw usageError("用法：zbot session show <id> [--turns N|--all] [--full] [--json]");
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
                command.waitSeconds = DEFAULT_WAIT_SECONDS;
                continue;
            }
            if (arg.startsWith("--wait=")) {
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

// ── 入口 ─────────────────────────────────────────────────────

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
            return runSend(command, write, io.readStdin ?? readStdin, io);
        case "queue":
            return runQueue(command, write);
        case "run":
            return runSessionTask(command, write, io.readStdin ?? readStdin, io);
    }
}

async function runList(command: ListCommand, write: (text: string) => void): Promise<void> {
    const savedIds = listSavedSessionIds();
    const ownership = await listOwnership(savedIds);
    const rows: SessionListRow[] = [];
    for (const sessionId of savedIds) {
        const meta = await readSessionMeta(sessionId);
        if (!meta) {
            // 事件日志存在却读不出有效事件：留一行标注，避免脚本以为会话"不存在"；
            // 更新时间用文件 mtime，否则排序会把这些行永远顶在最前面
            const updatedAt = eventFileMtime(sessionId);
            rows.push({
                sessionId,
                ...(updatedAt ? { updatedAt } : {}),
                summary: { sessionId, messageCount: 0, ...(updatedAt ? { updatedAt } : {}) },
                ownership: ownership.get(sessionId),
                corrupted: true,
            });
            continue;
        }
        const { summary } = meta;
        rows.push({
            sessionId,
            ...(summary.updatedAt ? { updatedAt: summary.updatedAt } : {}),
            ...(summary.archived ? { archived: true } : {}),
            summary,
            ownership: ownership.get(sessionId),
            ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
        });
    }
    const visible = sortSessions(rows).filter(row => command.all || !row.summary.archived);

    if (command.json) {
        write(`${JSON.stringify(visible.map(toJsonRow), null, 2)}\n`);
        return;
    }
    if (visible.length === 0) {
        write("（没有会话）\n");
        return;
    }
    write(`${formatTable(visible).join("\n")}\n`);
}

async function runShow(command: ShowCommand, write: (text: string) => void): Promise<void> {
    const sessionId = await resolveSessionId(command.id);

    // 事件视图：只读增量，不重放整段历史
    if (command.sinceSeq !== undefined) {
        const [events, lastSeq] = await Promise.all([
            eventLog.read(sessionId, command.sinceSeq + 1, undefined, { persistedOnly: true }),
            eventLog.lastSeq(sessionId),
        ]);
        if (command.json) {
            write(`${JSON.stringify({
                sessionId,
                lastSeq,
                events: events.map(toJsonEvent),
            }, null, 2)}\n`);
            return;
        }
        if (events.length === 0) {
            write(`（seq > ${command.sinceSeq} 没有新事件）\n`);
            return;
        }
        write(`${events.map(formatEventLine).join("\n")}\n`);
        return;
    }

    const [meta, replayed, ownership, lastSeq] = await Promise.all([
        readSessionMeta(sessionId),
        replay.replayTo(sessionId),
        probeOwnership(sessionId),
        eventLog.lastSeq(sessionId),
    ]);
    const summary = meta?.summary;
    // 事件日志读不出有效事件（损坏/半行）：明确标出来，别让它看起来只是"空会话"
    const corrupted = meta === null;
    const updatedAt = summary?.updatedAt ?? (corrupted ? eventFileMtime(sessionId) : undefined);
    const { session } = replayed;
    const turns = command.afterTurn !== undefined
        ? session.turns.slice(command.afterTurn)
        : command.all ? session.turns : session.turns.slice(-command.turns);
    const startIndex = session.turns.length - turns.length;
    // 标题口径与 TUI 一致：显式重命名优先，否则取首条用户消息（session.title 只记重命名）
    const title = summary?.title ?? session.title;
    // 目录取自事件（session_created / session_cwd_changed）；缺失时不拿重放回退值冒充真实 cwd
    const cwd = summary?.cwd;

    if (command.json) {
        write(`${JSON.stringify({
            sessionId,
            title: title ?? null,
            cwd: cwd ?? null,
            origin: summary?.origin ?? session.origin ?? null,
            ...toJsonOwnership(ownership),
            archived: summary?.archived === true,
            ...(corrupted ? { corrupted: true } : {}),
            totalTurns: session.turns.length,
            lastSeq,
            createdAt: meta?.createdAt ?? null,
            updatedAt: updatedAt ?? null,
            modelSelection: session.modelSelection ?? null,
            lastPromptTokens: session.lastPromptTokens ?? null,
            compactCount: session.compactCount,
            turnDetails: turns.map((turn, index) => command.lite
                ? toLiteTurn(turn, startIndex + index + 1)
                : {
                    index: startIndex + index + 1,
                    id: turn.id,
                    status: turn.status,
                    messages: turn.messages,
                }),
        }, null, 2)}\n`);
        return;
    }

    const lines = [
        `会话   ${sessionId}`,
        `标题   ${title ?? "（未命名）"}`,
        `目录   ${cwd ? abbreviatePath(cwd, process.env.HOME, CWD_COLUMNS) : "（未知）"}`,
        `来源   ${describeOrigin(summary?.origin ?? session.origin)}`,
        `状态   ${describePeerOwnership(sessionId, ownership ?? { state: "free" })}${summary?.archived ? " · 已归档" : ""}`,
        `轮数   ${session.turns.length}（压缩 ${session.compactCount} 次）`,
        `游标   seq=${lastSeq}`,
        `更新   ${formatTimestamp(updatedAt)}`,
        `创建   ${formatTimestamp(meta?.createdAt)}`,
    ];
    if (corrupted) lines.push("日志   损坏（读不出有效事件）");
    if (session.modelSelection) lines.push(`模型   ${formatModel(session.modelSelection)}`);
    if (session.lastPromptTokens) lines.push(`上下文 最近一次输入 ${session.lastPromptTokens} tokens`);

    lines.push("", `消息（${describeTurnRange(startIndex, session.turns.length)}）`);
    turns.forEach((turn, index) => {
        lines.push(...(command.lite
            ? renderLiteTurn(turn, startIndex + index + 1)
            : renderTurn(turn, startIndex + index + 1, command.full)));
    });
    write(`${lines.join("\n")}\n`);
}

/** 事件摘要：只保留复盘需要的字段，避免把整条消息塞进增量输出。 */
function summarizeEvent(event: AgentEvent): Record<string, unknown> {
    switch (event.type) {
        case "session_created":
            return { cwd: event.payload.cwd, origin: event.payload.origin ?? "user" };
        case "user_message":
            return { text: truncatePlain(event.payload.text, MESSAGE_PREVIEW_COLUMNS), trigger: event.payload.trigger };
        case "turn_message": {
            const message = event.payload.message;
            const toolNames = message.role === "assistant"
                ? (message.tool_calls ?? []).map(call => call?.function?.name ?? call?.custom?.name ?? call?.name ?? "tool")
                : [];
            return {
                role: message.role,
                text: truncatePlain(typeof message.content === "string" ? message.content : "", MESSAGE_PREVIEW_COLUMNS),
                ...(toolNames.length > 0 ? { tools: toolNames } : {}),
            };
        }
        case "turn_commit":
            return {
                stopReason: event.payload.stopReason ?? null,
                interrupted: event.payload.interrupted === true,
            };
        case "peer_message":
            return {
                direction: event.payload.direction,
                peerId: event.payload.peerId,
                text: truncatePlain(event.payload.text, MESSAGE_PREVIEW_COLUMNS),
                ...(event.payload.queued ? { queued: true } : {}),
            };
        case "peer_result":
            return {
                msgId: event.payload.msgId,
                ok: event.payload.ok,
                stopReason: event.payload.stopReason ?? null,
            };
        case "session_renamed":
            return { title: event.payload.title };
        default:
            return {};
    }
}

function toJsonEvent(event: AgentEvent): Record<string, unknown> {
    return { seq: event.seq, ts: event.ts, type: event.type, summary: summarizeEvent(event) };
}

function formatEventLine(event: AgentEvent): string {
    const summary = summarizeEvent(event);
    const parts = Object.entries(summary).map(([key, value]) =>
        `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
    return `#${event.seq} ${event.type}${parts.length > 0 ? ` ${parts.join(" ")}` : ""}`;
}

/** 精简回合：不带完整消息，只给数量、工具名与最后一条 assistant 摘要。 */
function toLiteTurn(
    turn: { id?: string; status: string; messages: StoredChatMessage[] },
    index: number,
): Record<string, unknown> {
    const assistant = [...turn.messages].reverse().find(message =>
        message.role === "assistant" && typeof message.content === "string" && message.content.trim());
    const toolNames = [...new Set(turn.messages.flatMap(message => message.role === "assistant"
        ? (message.tool_calls ?? []).map(call => call?.function?.name ?? call?.custom?.name ?? call?.name ?? "tool")
        : []))];
    return {
        index,
        id: turn.id ?? null,
        status: turn.status,
        messageCount: turn.messages.length,
        lastAssistant: assistant && typeof assistant.content === "string"
            ? truncatePlain(assistant.content, LITE_ASSISTANT_COLUMNS)
            : null,
        toolNames,
    };
}

function renderLiteTurn(
    turn: { status: string; messages: StoredChatMessage[] },
    index: number,
): string[] {
    const lite = toLiteTurn(turn, index);
    const lines = [`── #${index} ${turn.status} · ${turn.messages.length} 条消息`];
    const toolNames = lite.toolNames as string[];
    if (toolNames.length > 0) lines.push(`  工具: ${toolNames.join(", ")}`);
    if (typeof lite.lastAssistant === "string" && lite.lastAssistant) lines.push(`  assistant: ${lite.lastAssistant}`);
    return lines;
}

async function runNew(command: NewCommand, write: (text: string) => void): Promise<void> {
    const cwd = command.cwd ? resolveCwdInput(command.cwd, process.cwd()) : process.cwd();
    if (!isDirectory(cwd)) throw usageError(`cwd 不是已存在的目录：${cwd}`);
    const title = command.title ? cleanTitle(command.title) : undefined;

    const sessionId = createUlid();
    await eventLog.append(sessionId, "session_created", { cwd, origin: "user" });
    if (title) await eventLog.append(sessionId, "session_renamed", { title });

    if (command.json) {
        write(`${JSON.stringify({ sessionId, cwd, title: title ?? null }, null, 2)}\n`);
        return;
    }
    write(`已创建会话 ${sessionId}（${abbreviatePath(cwd, process.env.HOME, CWD_COLUMNS)}）${title ? `「${title}」` : ""}\n`);
}

/**
 * `session run`：新建 → 认领 → 执行一轮 → 释放。
 * 认领在建会话之后立刻完成（socket bind 原子），避免 new + send 之间被别的实例插手。
 */
/**
 * 一次性宿主：dotenv + 宿主环境 + 运行时（不挂技能监听）+ 日志落文件。
 * `session run` 与 `send` 的无持有者接管共用，保证两处装配完全一致。
 */
async function createOneShotHost(startupCwd: string): Promise<LocalSendHost> {
    // 必须在 configureHostEnvironment 之前取：它会把 ZBOT_STATE_DIR 改成 ~/.zbot
    const stateDir = process.env.ZBOT_STATE_DIR;
    const [{ LocalSessionHost, initializeSessionHostRuntime }, mcp, runtimeContext] = await Promise.all([
        import("../host/session-host.js"),
        import("../mcp/client-manager.js"),
        import("../host/runtime-context.js"),
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
            await host.close().catch((error) => {
                console.error("⚠️ [session] 关闭一次性宿主失败:", error);
            });
            await mcp.closeAllMcpClients().catch((error) => {
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
async function runSendLocally(
    command: SendCommand,
    sessionId: string,
    text: string,
    write: (text: string) => void,
    io: SessionCliIO,
): Promise<void> {
    const { runHostTurn } = await import("./session-turn.js");
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

async function runSessionTask(
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

    const { runHostTurn } = await import("./session-turn.js");
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

async function runRename(command: RenameCommand, write: (text: string) => void): Promise<void> {
    const sessionId = await resolveSessionId(command.id);
    const title = cleanTitle(command.title);
    await withSessionLockFree(sessionId, async () => {
        await eventLog.append(sessionId, "session_renamed", { title });
    });
    if (command.json) {
        write(`${JSON.stringify({ sessionId, action: "rename", title }, null, 2)}\n`);
        return;
    }
    write(`已重命名 ${shortSessionId(sessionId)} → ${title}\n`);
}

async function runArchive(command: ArchiveCommand, write: (text: string) => void): Promise<void> {
    const sessionId = await resolveSessionId(command.id);
    await withSessionLockFree(sessionId, async () => {
        await eventLog.append(
            sessionId,
            command.kind === "archive" ? "session_archived" : "session_unarchived",
            {},
        );
    });
    if (command.json) {
        write(`${JSON.stringify({ sessionId, action: command.kind, archived: command.kind === "archive" }, null, 2)}\n`);
        return;
    }
    write(`${command.kind === "archive" ? "已归档" : "已取消归档"} ${shortSessionId(sessionId)}\n`);
}

async function runDelete(command: DeleteCommand, write: (text: string) => void): Promise<void> {
    const sessionId = await resolveSessionId(command.id);
    const meta = await readSessionMeta(sessionId);
    const turns = meta?.summary.messageCount ?? 0;
    await withSessionLockFree(sessionId, async () => {
        // 锁留给 release 收尾，否则会在临界区中途删掉自己的互斥文件
        await removeSessionArtifacts(sessionId, { skipLock: true });
        // 删 socket 前再确认一次无监听者：这段窗口里别人可能刚好 bind 上来
        if ((await probeOwnership(sessionId)).state === "free") removeSocketFile(sessionId);
    });
    if (command.json) {
        write(`${JSON.stringify({ sessionId, action: "delete", deleted: true, turns }, null, 2)}\n`);
        return;
    }
    write(`已删除 ${shortSessionId(sessionId)}（${turns} 轮）\n`);
}

async function runSend(
    command: SendCommand,
    write: (text: string) => void,
    readStdinText: () => Promise<string>,
    io: SessionCliIO = {},
): Promise<void> {
    const sessionId = await resolveSendTarget(command.id);
    if (command.cancelMsgId) return cancelQueuedSend(sessionId, command, write);

    const text = command.text || (await readStdinText()).trim();
    if (!text) throw usageError("send 需要消息正文");

    const ownership = await probeOwnership(sessionId);
    if (ownership.state === "free") {
        // 没有实例持有：由本进程临时接管执行一条（命令直接跑，普通文本跑一轮），
        // 否则归档后的 /unarchive 这类命令永远没有可达路径。
        return runSendLocally(command, sessionId, text, write, io);
    }

    let settleResult: (result: PeerResult) => void = () => undefined;
    const resultPromise = new Promise<PeerResult>((resolve) => {
        settleResult = resolve;
    });
    const message = createPeerMessage({
        from: `cli-${process.pid}`,
        to: sessionId,
        text,
        ...(command.waitSeconds === undefined ? {} : { expectResult: true }),
        ...(command.queue ? { queueIfBusy: true } : {}),
        expiresAt: new Date(Date.now() + command.expiresSeconds * 1000).toISOString(),
    });
    const connection = new PeerConnection({
        socketPath: getSocketPath(sessionId),
        onResult: (result) => settleResult(result),
    });

    try {
        const reply = await connection.deliver(message);
        if (reply.type !== "ack") {
            throw new SessionCliError(
                "bad_reply",
                `会话 ${shortSessionId(sessionId)} 返回了非预期应答`,
                1,
                { sessionId, delivered: false },
            );
        }
        if (!reply.ok) {
            throw new SessionCliError(reply.error, describeAckError(sessionId, reply.error), 1, {
                sessionId,
                delivered: false,
            });
        }

        const queued = reply.queued === true;
        const position = reply.position;
        if (command.waitSeconds === undefined) {
            if (command.json) {
                write(`${JSON.stringify({
                    sessionId,
                    msgId: message.id,
                    delivered: true,
                    queued,
                    ...(position !== undefined ? { position } : {}),
                    ...(queued ? { expiresAt: message.expiresAt } : {}),
                }, null, 2)}\n`);
            } else if (queued) {
                write(`已排队到 ${shortSessionId(sessionId)}（第 ${position ?? "?"} 位，${message.id}）`
                    + `，会话空闲后执行；最晚 ${formatTimestamp(message.expiresAt)}\n`);
            } else {
                write(`已投递到 ${shortSessionId(sessionId)}（${message.id}）\n`);
            }
            return;
        }

        // 等待结果时先把排队状态告诉人类，避免看起来一直没反应
        if (queued && !command.json) {
            write(`已排队到 ${shortSessionId(sessionId)}（第 ${position ?? "?"} 位，${message.id}），等待执行...\n`);
        }

        const result = await withTimeout(resultPromise, command.waitSeconds * 1000, sessionId, message.id);
        if (!result.ok) {
            // 失败也把已产出的部分输出带出来：人类模式进 stderr，--json 进 details
            // 失败时 text 可能已是错误原因本身（命令拒绝/非法参数），别把它当"部分输出"再打一遍
            const partial = result.text && result.text !== result.error
                ? `\n（部分输出）\n${result.text}`
                : "";
            throw new SessionCliError(
                "peer_failed",
                `${result.error ?? `会话 ${shortSessionId(sessionId)} 执行失败：${result.stopReason}`}${partial}`,
                1,
                { sessionId, msgId: message.id, delivered: true, stopReason: result.stopReason, partialText: result.text },
            );
        }
        if (command.json) {
            write(`${JSON.stringify({
                sessionId,
                ...result,
                delivered: true,
                ...(queued ? { queued: true, ...(position !== undefined ? { position } : {}) } : {}),
            }, null, 2)}\n`);
            return;
        }
        // 被取消的回合没有产出：如实说"已取消"，不要含糊成"没有输出"
        const emptyText = isCancelledStopReason(result.stopReason)
            ? "（对方回合已取消，没有输出）\n"
            : "（对方回合没有输出）\n";
        write(result.text ? `${result.text}\n` : emptyText);
    } finally {
        connection.close();
    }
}

// ── 会话数据读取 ─────────────────────────────────────────────

/** 撤销排队中的消息：只对仍在队列里的生效，已开始执行返回失败。 */
async function cancelQueuedSend(
    sessionId: string,
    command: SendCommand,
    write: (text: string) => void,
): Promise<void> {
    const msgId = command.cancelMsgId!;
    const ownership = await probeOwnership(sessionId);
    if (ownership.state === "free") {
        throw new SessionCliError(
            "no_holder",
            `会话 ${shortSessionId(sessionId)} 没有运行中的实例持有，无法撤销排队消息`,
            1,
            { sessionId, msgId, cancelled: false },
        );
    }

    const connection = new PeerConnection({
        socketPath: getSocketPath(sessionId),
        onResult: () => undefined,
    });
    try {
        const reply = await connection.cancelQueued(msgId);
        if (reply.type !== "cancel_queued_result") {
            throw new SessionCliError("bad_reply", `会话 ${shortSessionId(sessionId)} 返回了非预期应答`, 1, {
                sessionId,
                msgId,
            });
        }
        if (!reply.ok) {
            if (reply.reason === "running") {
                throw new SessionCliError("send_running", "消息已开始执行，无法撤销", 1, {
                    sessionId,
                    msgId,
                    cancelled: false,
                });
            }
            throw new SessionCliError("not_found", "排队消息不存在或已执行", 1, {
                sessionId,
                msgId,
                cancelled: false,
            });
        }

        if (command.json) write(`${JSON.stringify({ sessionId, msgId, cancelled: true }, null, 2)}\n`);
        else write(`已撤销排队消息 ${msgId}\n`);
    } catch (error) {
        // 旧版本持有者会忽略新帧，只能给结构化不可达错误，不能裸抛连接异常
        if (error instanceof PeerConnectError) {
            throw new SessionCliError(
                "unreachable",
                `会话 ${shortSessionId(sessionId)} 不可达或不支持排队撤销（进程可能刚退出）`,
                1,
                { sessionId, msgId, cancelled: false },
            );
        }
        throw error;
    } finally {
        connection.close();
    }
}

/** 查看持有者的排队快照；没有持有者时返回空队列而不是报错。 */
async function runQueue(command: QueueCommand, write: (text: string) => void): Promise<void> {
    const sessionId = await resolveSendTarget(command.id);
    const ownership = await probeOwnership(sessionId);
    if (ownership.state === "free") {
        if (command.json) write(`${JSON.stringify({ sessionId, holding: false, entries: [] }, null, 2)}\n`);
        else write(`会话 ${shortSessionId(sessionId)} 当前没有实例持有（队列为空）\n`);
        return;
    }

    const connection = new PeerConnection({
        socketPath: getSocketPath(sessionId),
        onResult: () => undefined,
    });
    try {
        const reply = await connection.queueState();
        if (reply.type !== "queue_state") {
            throw new SessionCliError("bad_reply", `会话 ${shortSessionId(sessionId)} 返回了非预期应答`, 1, {
                sessionId,
            });
        }
        if (command.json) {
            write(`${JSON.stringify({ sessionId, holding: true, entries: reply.entries }, null, 2)}\n`);
            return;
        }
        if (reply.entries.length === 0) {
            write("（队列为空）\n");
            return;
        }
        const lines = reply.entries.map(entry =>
            `#${entry.position} ${entry.msgId} from=${entry.from} 入队 ${formatTimestamp(entry.queuedAt)}`
            + `${entry.expiresAt ? ` 最晚 ${formatTimestamp(entry.expiresAt)}` : ""}`);
        write(`${lines.join("\n")}\n`);
    } catch (error) {
        if (error instanceof PeerConnectError) {
            throw new SessionCliError(
                "unreachable",
                `会话 ${shortSessionId(sessionId)} 不可达或不支持排队查询（进程可能刚退出）`,
                1,
                { sessionId },
            );
        }
        throw error;
    } finally {
        connection.close();
    }
}

/** 会话摘要 + 真实创建时间（取首条事件 ts；Session.createdAt 是重放时刻，不能代表创建时间）。 */
async function readSessionMeta(
    sessionId: string,
): Promise<{ summary: SessionSummary; createdAt?: string } | null> {
    const events = await eventLog.read(sessionId);
    if (events.length === 0) return null;
    return { summary: summarizeEvents(sessionId, events), ...(events[0] ? { createdAt: events[0].ts } : {}) };
}

/** 事件日志文件的 mtime：日志损坏时唯一的"更新时间"来源。 */
function eventFileMtime(sessionId: string): string | undefined {
    try {
        const file = path.join(getSessionsDir("events"), `${sanitizeSessionId(sessionId)}.jsonl`);
        return fs.statSync(file).mtime.toISOString();
    } catch {
        return undefined;
    }
}

/** 把用户输入的 id 补全：优先精确匹配，其次唯一前缀，再次唯一后缀（工具里惯用末几位）。 */
export function resolveSessionIdFrom(input: string, savedIds: string[]): string {
    const trimmed = input.trim();
    if (!trimmed) throw new SessionCliError("usage", "需要会话 id");
    if (savedIds.includes(trimmed)) return trimmed;

    const prefix = savedIds.filter(sessionId => sessionId.startsWith(trimmed));
    const suffix = savedIds.filter(sessionId => sessionId.endsWith(trimmed));

    // 前缀与后缀各命中一个但指向不同会话时同样算歧义，不能悄悄取前缀
    const candidates = [...new Set([...prefix, ...suffix])];
    if (candidates.length > 1) {
        throw new SessionCliError(
            "ambiguous",
            `会话 ${trimmed} 匹配到多个候选：${candidates.map(shortSessionId).join(" ")}，请写更长的 id`,
            1,
            { candidates },
        );
    }
    if (candidates.length === 1) return candidates[0]!;
    throw new SessionCliError("not_found", `会话不存在：${trimmed}`, 1, { input: trimmed });
}

async function resolveSessionId(input: string): Promise<string> {
    return resolveSessionIdFrom(input, listSavedSessionIds());
}

/**
 * send 的目标解析：另一实例刚派生、还没落任何事件的会话不在磁盘上，
 * 只要给的是完整 ULID 就按原样交给控制通道判定可达性（与 session_send 工具一致）。
 */
async function resolveSendTarget(input: string): Promise<string> {
    const trimmed = input.trim();
    try {
        return await resolveSessionId(trimmed);
    } catch (error) {
        if (isUlid(trimmed)) return trimmed;
        throw error;
    }
}

function toJsonRow(row: SessionListRow): Record<string, unknown> {
    const { summary } = row;
    return {
        sessionId: summary.sessionId,
        title: summary.title ?? null,
        cwd: summary.cwd ?? null,
        origin: summary.origin ?? null,
        turns: summary.messageCount,
        createdAt: row.createdAt ?? null,
        updatedAt: summary.updatedAt ?? null,
        archived: summary.archived === true,
        ...(row.corrupted ? { corrupted: true } : {}),
        ...toJsonOwnership(row.ownership),
        modelSelection: summary.modelSelection ?? null,
    };
}

/**
 * 归属的机器可读形态（`--json` 用）；归档态只由 `archived` 表达，不覆盖状态字段。
 * 缺省值一律给 null，保证键集合稳定、调用方不用判 undefined。
 */
function toJsonOwnership(
    ownership?: PeerOwnership,
): { status: string; holderPid: number | null; busy: boolean | null; queued: number | null } {
    if (!ownership || ownership.state === "free") return { status: "idle", holderPid: null, busy: null, queued: null };
    if (ownership.state === "mine") return { status: "mine", holderPid: process.pid, busy: null, queued: null };
    const info = ownership.info;
    return { status: "held", holderPid: info?.pid ?? null, busy: info?.busy ?? null, queued: info?.queued ?? null };
}

// ── 展示 ─────────────────────────────────────────────────────

const TABLE_HEADERS = ["状态", "ID", "来源", "轮数", "更新", "目录", "标题"];

export function formatTable(rows: SessionListRow[]): string[] {
    const body = rows.map(row => [
        formatStatusCell(row),
        shortSessionId(row.summary.sessionId),
        describeOrigin(row.summary.origin),
        `${row.summary.messageCount}轮`,
        formatRelativeTime(row.summary.updatedAt),
        abbreviatePath(row.summary.cwd ?? "", process.env.HOME, CWD_COLUMNS) || "-",
        truncatePlain(row.summary.title ?? "-", TITLE_COLUMNS) || "-",
    ]);
    const widths = TABLE_HEADERS.map((header, column) => Math.max(
        visibleWidth(header),
        ...body.map(cells => visibleWidth(cells[column] ?? "")),
    ));
    const joinRow = (cells: string[]) => cells
        .map((cell, column) => padColumns(cell, widths[column] ?? 0))
        .join("  ")
        .trimEnd();
    return [joinRow(TABLE_HEADERS), ...body.map(joinRow)];
}

/** 状态列：归档与归属同时展示，避免 `--all` 时看不出归档会话还被谁持有。 */
function formatStatusCell(row: SessionListRow): string {
    if (row.corrupted) return "日志损坏";
    const ownership = row.ownership ?? { state: "free" as const };
    const owner = describePeerOwnership(row.summary.sessionId, ownership);
    if (!row.summary.archived) return owner;
    return ownership.state === "free" ? "已归档" : `已归档 · ${owner}`;
}

function renderTurn(turn: { status: string; messages: StoredChatMessage[] }, index: number, full: boolean): string[] {
    const createdAt = turn.messages[0]?.createdAt;
    const lines = [`── #${index} ${turn.status}${createdAt ? ` ${formatDateTime(createdAt)}` : ""}`];
    if (turn.messages.length === 0) lines.push("  （空回合）");
    for (const message of turn.messages) lines.push(...renderMessage(message, full));
    return lines;
}

function renderMessage(message: StoredChatMessage, full: boolean): string[] {
    switch (message.role) {
        case "user":
            return [`user: ${formatBody(userText(message.content), full)}`];
        case "assistant": {
            const lines: string[] = [];
            if (message.content) lines.push(`assistant: ${formatBody(message.content, full)}`);
            for (const call of message.tool_calls ?? []) {
                const name = call?.function?.name ?? call?.custom?.name ?? call?.name ?? "tool";
                // 自由文本工具的参数按 {"patch": ...} 展示，与 function 调用同形
                const args = call?.function?.arguments
                    ?? (typeof call?.custom?.input === "string" ? patchArgumentsJson(call.custom.input) : "");
                lines.push(`  ⤷ ${name}(${formatBody(String(args), full)})`);
            }
            return lines.length > 0 ? lines : ["assistant:（空）"];
        }
        case "tool":
            return [`tool[${message.name ?? message.tool_call_id}]: ${formatBody(message.content, full)}`];
        case "system":
            return [`system: ${formatBody(message.content, full)}`];
        default: {
            // 日志里可能混进本版本不认识的 role：降级成一行文本，别让整条命令崩在裸 JS 报错上
            const unknown = message as { role?: string; content?: unknown };
            return [`${unknown.role ?? "unknown"}: ${formatBody(String(unknown.content ?? ""), full)}`];
        }
    }
}

function formatBody(text: string, full: boolean): string {
    if (!text) return "（空）";
    if (!full) return truncatePlain(text, MESSAGE_PREVIEW_COLUMNS);
    // --full 也要剥控制序列：日志里混进的工具/网页输出可以清屏或写剪贴板
    return stripTerminalSequences(text).replace(/\n/g, "\n  ");
}

function userText(content: UserContent): string {
    if (typeof content === "string") return content;
    return (content ?? [])
        .map(part => {
            if (part.type === "text") return part.text;
            if (part.type === "input_audio") return "[音频]";
            return "[图片]";
        })
        .join(" ");
}

function describeAckError(sessionId: string, code: string): string {
    switch (code) {
        case "busy":
            return `会话 ${shortSessionId(sessionId)} 正在执行中，请稍后重试`;
        case "queue_full":
            return `会话 ${shortSessionId(sessionId)} 的排队已满（最多 8 条），请稍后重试`;
        case "unreachable":
            return `会话 ${shortSessionId(sessionId)} 不可达（进程可能刚退出）`;
        default:
            return `会话 ${shortSessionId(sessionId)} 拒绝了消息（${code}）`;
    }
}

function formatTimestamp(iso?: string): string {
    if (!iso) return "（无）";
    return `${formatDateTime(iso)}（${formatRelativeTime(iso)}）`;
}

/** 展示的轮次范围：单轮不写成 `第 13-13 轮`。 */
function describeTurnRange(startIndex: number, total: number): string {
    if (total === 0) return "无";
    if (total - startIndex === 1) return `第 ${total} 轮，共 ${total} 轮`;
    return `第 ${startIndex + 1}-${total} 轮，共 ${total} 轮`;
}

/** 事件时间统一用 UTC ISO 落盘，展示时按本机时区换算，避免同一屏里混着两种时区。 */
function formatDateTime(iso: string): string {
    const time = new Date(iso);
    if (Number.isNaN(time.getTime())) return iso;
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`
        + ` ${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
}

/** 模型选择只展示协议与模型名，便于跨会话比较。 */
function formatModel(selection: ChatModelSelection): string {
    return [selection.protocol, selection.model].filter(Boolean).join(" · ") || "（未知）";
}

// ── 守卫与工具 ────────────────────────────────────────────────

/** 写操作前确认没有实例持有该会话：持有者的内存状态不会跟着事件日志走，双写会让 seq 分叉。 */
async function assertSessionFree(sessionId: string): Promise<void> {
    const ownership = await probeOwnership(sessionId);
    if (ownership.state === "free") return;
    const info = ownership.state === "other" ? ownership.info : undefined;
    throw new SessionCliError(
        "held",
        `会话 ${shortSessionId(sessionId)} 正被其他实例持有${info ? `（pid ${info.pid}${info.busy ? "，执行中" : ""}）` : ""}`
        + "，请在那个实例里操作，或先 /close 释放后再试",
        1,
        { sessionId, holderPid: info?.pid ?? null, busy: info?.busy ?? null },
    );
}

async function withSessionLock<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const lock = await acquireSessionLock(sessionId).catch((error: any) => {
        const message = error?.message ?? String(error);
        // 只有"别的实例在跑/在写"才是 held；权限、文件系统等异常保持 failed
        const code = /其他实例|竞争|正在写入|holder/i.test(message) ? "held" : "failed";
        throw new SessionCliError(code, message, 1, { sessionId });
    });
    try {
        return await run();
    } finally {
        await lock.release();
    }
}

/**
 * 写操作的标准姿势：**先廉价探测一次**（拿到"被持有"的友好错误，不必先碰锁），
 * **再取锁，锁内重新探测**作为权威判定 —— 否则第一次探测为 free 与真正 append 之间的
 * 窗口里被别的实例 claim 并开跑，两侧会各自从旧 lastSeq +1，把 seq 写分叉。
 */
async function withSessionLockFree<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    await assertSessionFree(sessionId);
    return withSessionLock(sessionId, async () => {
        await assertSessionFree(sessionId);
        return run();
    });
}

function withTimeout(
    promise: Promise<PeerResult>,
    timeoutMs: number,
    sessionId: string,
    msgId: string,
): Promise<PeerResult> {
    return new Promise<PeerResult>((resolve, reject) => {
        const timer = setTimeout(() => {
            // 超时≠失败投递：消息已进对方回合，重发会在目标会话里多压一轮
            reject(new SessionCliError(
                "wait_timeout",
                `等待会话 ${shortSessionId(sessionId)} 的结果超时（${Math.round(timeoutMs / 1000)}s）；`
                + `消息已投递（msgId=${msgId}），不要重复发送`,
                2,
                { sessionId, msgId, delivered: true },
            ));
        }, timeoutMs);
        timer.unref?.();
        promise.then(
            (result) => {
                clearTimeout(timer);
                resolve(result);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

function cleanTitle(title: string): string {
    const cleaned = title.trim().slice(0, MAX_SESSION_TITLE_LENGTH);
    if (!cleaned) throw usageError("标题不能为空");
    return cleaned;
}

function isDirectory(target: string): boolean {
    try {
        return fs.statSync(target).isDirectory();
    } catch {
        return false;
    }
}

async function readStdin(): Promise<string> {
    // 交互式终端下不等 stdin：没有正文时应立刻报用法错误，而不是挂住进程
    if (process.stdin.isTTY) return "";
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}
