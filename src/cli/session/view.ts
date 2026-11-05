/**
 * `list` 与 `show` 的只读视图：把事件日志投影成列表行/回合视图，再渲染成表格或 JSON。
 * 这里不写任何事件，任何时刻都可以执行。
 */

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentEvent } from "../../events/agent-events.js";
import { listSavedSessionIds } from "../../events/session-files.js";
import { abbreviatePath } from "../../format/path.js";
import { describeOrigin } from "../../format/session-origin.js";
import { padColumns, truncatePlain } from "../../format/text.js";
import { sortSessions, type SessionOrderItem } from "../../utils/session-order.js";
import { formatRelativeTime } from "../../utils/time.js";
import {
    describeOwnership as describePeerOwnership,
    listOwnership,
    probeOwnership,
    type PeerOwnership,
} from "../../control/registry.js";
import type { ChatModelSelection } from "../../types/chat-model.js";
import type { UserContent } from "../../types/image.js";
import { shortSessionId } from "../../utils/session-id.js";
import { patchArgumentsJson } from "../../utils/patch-args.js";
import type { StoredChatMessage } from "../../types/session.js";
import type { SessionSummary } from "../../host/session-host-types.js";
import { SessionCliError, type ListCommand, type ShowCommand } from "./args.js";
import {
    eventLog,
    eventFileMtime,
    readSessionMeta,
    replay,
    resolveCurrentSessionId,
    resolveCurrentSessionIdFrom,
    resolveSessionId,
} from "./store.js";

/** 非 --full 时单条消息的预览列宽。 */
const MESSAGE_PREVIEW_COLUMNS = 200;
/** --lite 的 assistant 摘要列宽。 */
const LITE_ASSISTANT_COLUMNS = 300;
/** 列表列宽上限：宽字符按显示列计，避免中文标题把表格拉歪。 */
const TITLE_COLUMNS = 40;
export const CWD_COLUMNS = 28;

/** 列表行：摘要 + 归属（socket 探测结果）；排序键与摘要同源，供 sortSessions 使用。 */
export interface SessionListRow extends SessionOrderItem {
    summary: SessionSummary;
    ownership?: PeerOwnership;
    /** 真实创建时间（首条事件 ts）。 */
    createdAt?: string;
    /** 日志文件存在但读不出任何有效事件：保留一行并标注，别让它从列表里静默消失。 */
    corrupted?: boolean;
}

/** 把磁盘上的会话 id 逐一投影成列表行（摘要 + 归属 + 真实创建时间）。 */
async function buildRows(sessionIds: string[]): Promise<SessionListRow[]> {
    const ownership = await listOwnership(sessionIds);
    const rows: SessionListRow[] = [];
    for (const sessionId of sessionIds) {
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
    return rows;
}

export async function runList(command: ListCommand, write: (text: string) => void): Promise<void> {
    const savedIds = listSavedSessionIds();
    const currentId = resolveCurrentSessionIdFrom(savedIds);
    const rows = sortSessions(await buildRows(savedIds))
        .filter(row => command.all || !row.summary.archived)
        .filter(row => !command.held || (row.ownership?.state ?? "free") !== "free");
    const visible = command.limit !== undefined ? rows.slice(0, command.limit) : rows;

    if (command.json) {
        write(`${JSON.stringify(visible.map(row => toJsonRow(row, currentId)), null, 2)}\n`);
        return;
    }
    if (visible.length === 0) {
        write("（没有会话）\n");
        return;
    }
    const lines = formatTable(visible);
    // 当前会话先给一行再上表格：`--limit` 截断后表里可能看不到它，别让人误判"没有当前会话"
    const current = currentId ? visible.find(row => row.summary.sessionId === currentId) : undefined;
    if (current) {
        lines.unshift(`当前会话：${shortSessionId(current.summary.sessionId)}  ${current.summary.title ?? "（未命名）"}`, "");
    }
    write(`${lines.join("\n")}\n`);
}

export async function runShow(command: ShowCommand, write: (text: string) => void): Promise<void> {
    const sessionId = await resolveShowTarget(command);

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


function toJsonRow(row: SessionListRow, currentId?: string): Record<string, unknown> {
    const { summary } = row;
    return {
        sessionId: summary.sessionId,
        current: currentId === summary.sessionId,
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

/**
 * show 的目标：显式 id > --last（最近更新）> 当前会话指针。
 *
 * 三者都不成立时给「下一步怎么做」而不是裸的 not_found：命令行最常见的困惑是
 * "我不知道当前会话是哪个"。
 */
async function resolveShowTarget(command: ShowCommand): Promise<string> {
    if (command.id) return resolveSessionId(command.id);
    if (command.last) return resolveLatestSessionId();

    return resolveCurrentSessionId();
}

/** 最近更新的会话：优先未归档；一个会话都没有时才报错。 */
async function resolveLatestSessionId(): Promise<string> {
    const rows = sortSessions(await buildRows(listSavedSessionIds()));
    const latest = rows.find(row => !row.summary.archived) ?? rows[0];
    if (!latest) {
        throw new SessionCliError("not_found", "还没有任何会话：启动 `zbot` 或 `zbot session new` 后再试", 1);
    }
    return latest.summary.sessionId;
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

export function formatTimestamp(iso?: string): string {
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
