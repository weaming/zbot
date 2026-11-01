/**
 * 会话事件的 HTTP 视图：只保留 Web 端真正会渲染的字段。
 *
 * 原始事件是给重放用的（工具输出全文、思考全文、段边界、提交元信息都在里面），
 * 一个中等长度的会话就能到 8~9 MB；而时间线只画「谁说了什么 + 工具名与用时」。
 * 体积差主要来自工具输出正文与推理正文，这里统统不进响应。
 *
 * 只作用于 HTTP（JSON 与 SSE），不影响磁盘上的事件日志与重放。
 */

import type { AgentEvent } from "../events/agent-events.js";
import { isCancelledStopReason } from "../control/protocol.js";
import { isPeerSendTool, parsePeerSendCall } from "../tools/tool-kinds.js";
import { parsePeerResultText } from "../utils/peer-result.js";
import { isUlid, shortSessionId } from "../utils/session-id.js";
import { formatToolArguments } from "../utils/tool-progress.js";

/**
 * 单次工具调用的参数超过这个长度就不带原文（只给 argumentSize）：
 * 大型 patch/脚本正文能占掉整个响应的一半，界面要看原文时按需再拉。
 */
const ARGUMENTS_MAX_CHARS = 400;
/** 摘要一行够用，再长也只是噪音。 */
const SUMMARY_MAX_CHARS = 120;

/**
 * 会话间发送（session_send）的正文与结果不走「工具输出只留长度」的口径：
 * 它们是会话之间的对话内容，界面要按 Markdown 常驻展示，否则对方回了什么无从看起。
 * 只对这一个工具例外，长度上限防止一次派活把响应撑爆。
 */
const PEER_TEXT_MAX_CHARS = 4000;
const PEER_RESULT_MAX_CHARS = 8000;

/** 超长正文截断并留一句说明，避免界面以为对方只回了这么点。 */
function clipPeerText(text: string, max: number): string {
    // 快路径：UTF-16 长度不超上限时码点数必然也不超
    if (text.length <= max) return text;
    // 按码点截断：slice 会切出孤立代理对，emoji 变乱码
    const points = [...text];
    if (points.length <= max) return text;
    return `${points.slice(0, max).join("")}\n\n…（已截断，原文 ${points.length} 字）`;
}

/** 一次 patch 里改动的单个文件。 */
interface PatchFileStat {
    path: string;
    kind: "add" | "update" | "delete";
    added: number;
    removed: number;
}

interface PatchStat {
    files: PatchFileStat[];
    added: number;
    removed: number;
}

/**
 * 工具的三种历史形状统一成 name + 参数原文：
 * - OpenAI chat：`{ id, function: { name, arguments } }`
 * - Responses custom tool：`{ id, custom: { name, input } }`（apply_patch 这类自由文本工具）
 * - 已经拍平的：`{ id, name, arguments }`
 */
export function readToolCall(call: any): { id?: string; name: string; rawArguments: string } {
    const fn = call?.function;
    const custom = call?.custom;
    const name = (typeof fn?.name === "string" && fn.name)
        || (typeof custom?.name === "string" && custom.name)
        || (typeof call?.name === "string" && call.name)
        || "工具";
    const rawArguments = typeof fn?.arguments === "string"
        ? fn.arguments
        : typeof custom?.input === "string"
          ? custom.input
          : typeof call?.arguments === "string"
            ? call.arguments
            : "";
    return { ...(typeof call?.id === "string" ? { id: call.id } : {}), name, rawArguments };
}

/**
 * apply_patch 的 patch 文本按文件统计增删行：
 * 界面要的是「改了哪些文件、各加减多少」，把整份 patch 摊在时间线上没人看。
 */
function patchStatOf(name: string, rawArguments: string): PatchStat | null {
    if (!/apply_patch/i.test(name)) return null;

    const files: PatchFileStat[] = [];
    let current: PatchFileStat | null = null;
    for (const line of rawArguments.split("\n")) {
        const header = /^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/.exec(line);
        if (header) {
            current = {
                path: header[2]!,
                kind: header[1] === "Add" ? "add" : header[1] === "Update" ? "update" : "delete",
                added: 0,
                removed: 0,
            };
            files.push(current);
            continue;
        }
        if (line.startsWith("*** ")) {
            current = null;
            continue;
        }
        if (!current || line.startsWith("@@")) continue;
        if (line.startsWith("+")) current.added += 1;
        else if (line.startsWith("-")) current.removed += 1;
    }
    if (files.length === 0) return null;

    return {
        files,
        added: files.reduce((sum, file) => sum + file.added, 0),
        removed: files.reduce((sum, file) => sum + file.removed, 0),
    };
}

function summarizePatch(stat: PatchStat): string {
    const counts = `${stat.files.length} 个文件`;
    // 只有一边有改动时别写成「+300 −0」
    const changed = [
        stat.added > 0 ? `+${stat.added}` : "",
        stat.removed > 0 ? `−${stat.removed}` : "",
    ].filter(Boolean);
    return changed.length > 0 ? `${counts} · ${changed.join(" ")}` : counts;
}

function summarizeCall(name: string, rawArguments: string): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawArguments);
    } catch {
        return oneLine(rawArguments);
    }
    // 命令类工具最有信息量的就是命令本身，别退化成 command=... cwd=... 一串
    const command = (parsed as { command?: unknown; cmd?: unknown })?.command ?? (parsed as { cmd?: unknown })?.cmd;
    if (typeof command === "string" && command.trim()) return oneLine(command);
    const formatted = formatToolArguments(parsed);
    return oneLine(formatted || rawArguments);
}

function oneLine(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > SUMMARY_MAX_CHARS ? `${flat.slice(0, SUMMARY_MAX_CHARS)}…` : flat;
}

export interface SessionEventView {
    seq: number;
    ts: string;
    sessionId: string;
    type: string;
    payload: Record<string, unknown>;
}

/** 界面不渲染、也不参与排序的事件：直接不发。 */
const DROPPED_TYPES = new Set([
    "turn_segment_start",
    "turn_stream_delta",
    "usage_recorded",
    "standalone_turn",
    "session_created",
    "session_renamed",
    "session_archived",
    "session_unarchived",
    "session_cwd_changed",
    "model_selected",
    "lazy_mcp_changed",
]);

/**
 * 单条事件的视图；返回 null 表示这条不下发。
 * 保留：用户/会话间消息、AI 正文与工具调用、工具状态行、系统通知。
 */
export function toSessionEventView(event: AgentEvent): SessionEventView | null {
    if (DROPPED_TYPES.has(event.type)) return null;

    const base = { seq: event.seq, ts: event.ts, sessionId: event.sessionId, type: event.type as string };

    switch (event.type) {
        case "user_message": {
            const payload = event.payload;
            return {
                ...base,
                payload: {
                    text: payload.text,
                    trigger: payload.trigger,
                    // 图片只要 id（拉缩略图）与文件名（alt）；URL 形式的引用直接给 url
                    ...(payload.images?.length
                        ? {
                              images: payload.images.map(image => (
                                  "id" in image
                                      ? { id: image.id, filename: image.filename }
                                      : { url: image.url, filename: image.filename }
                              )),
                          }
                        : {}),
                },
            };
        }
        case "peer_message":
            return {
                ...base,
                payload: {
                    direction: event.payload.direction,
                    peerId: event.payload.peerId,
                    ...(event.payload.peerTitle ? { peerTitle: event.payload.peerTitle } : {}),
                    text: event.payload.text,
                },
            };
        case "peer_result":
            // 结果正文也下发：这是「派活拿到了什么」的主线，与 TUI 的结果气泡对齐
            return {
                ...base,
                payload: {
                    msgId: event.payload.msgId,
                    peerId: event.payload.peerId,
                    ...(event.payload.peerTitle ? { peerTitle: event.payload.peerTitle } : {}),
                    ok: event.payload.ok,
                    ...(event.payload.lost ? { lost: true } : {}),
                    ...(event.payload.late ? { late: true } : {}),
                    // 取消与否由服务端判定：前端不必复制 stopReason 口径
                    ...(isCancelledStopReason(event.payload.stopReason) ? { cancelled: true } : {}),
                    text: clipPeerText(event.payload.text, PEER_RESULT_MAX_CHARS),
                },
            };
        case "steer_update":
            return {
                ...base,
                payload: {
                    turnId: event.payload.turnId,
                    responseId: event.payload.responseId,
                    phase: event.payload.phase,
                    ...(event.payload.text ? { text: event.payload.text } : {}),
                    ...(event.payload.isAwaitingToolInput ? { isAwaitingToolInput: true } : {}),
                },
            };
        case "context_compacted":
        case "assistant_history_repaired":
            return { ...base, payload: {} };
        case "turn_commit":
            // 正文与事件 seq 列表都不需要；界面只关心"这一回合收尾了没有"
            return { ...base, payload: { turnId: event.payload.turnId } };
        case "turn_message": {
            const message = event.payload.message as Record<string, unknown>;
            const role = message.role;
            if (role === "assistant") {
                const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
                return {
                    ...base,
                    payload: {
                        // turnId 用于判断该回合是否已收尾（收尾后不再显示「思考中」）
                        turnId: event.payload.turnId,
                        message: {
                            role,
                            ...(typeof message.content === "string" && message.content ? { content: message.content } : {}),
                            // 只有"有没有想过"这件事有意义，推理正文不进响应
                            ...(typeof message.reasoning_content === "string" && message.reasoning_content
                                ? { hasReasoning: true }
                                : {}),
                            ...(toolCalls.length > 0
                                ? {
                                      tool_calls: toolCalls.map((call: any) => {
                                          const { id, name, rawArguments } = readToolCall(call);
                                          const patchStat = patchStatOf(name, rawArguments);
                                          const peer = isPeerSendTool(name)
                                              ? parsePeerSendCall(rawArguments)
                                              : undefined;
                                          return {
                                              ...(id ? { id } : {}),
                                              name,
                                              // 摘要由服务端算好：界面只要一行字，不必为此传整份参数
                                              summary: patchStat ? summarizePatch(patchStat) : summarizeCall(name, rawArguments),
                                              // patch 类给结构化的文件增删，界面按文件列表渲染
                                              ...(patchStat ? { patchStat } : {}),
                                              // 小参数照旧带上，界面还能展开看原文
                                              ...(rawArguments.length > 0 && rawArguments.length <= ARGUMENTS_MAX_CHARS
                                                  ? { arguments: rawArguments }
                                                  : {}),
                                              // 大参数只留长度：界面点开时再按需拉全文
                                              ...(rawArguments.length > ARGUMENTS_MAX_CHARS
                                                  ? { argumentSize: rawArguments.length }
                                                  : {}),
                                              // 期望结果的会话间发送：正文是对话内容，界面要常驻展示
                                              ...(peer?.expectResult
                                                  ? {
                                                        expectResult: true,
                                                        ...(peer.session
                                                            ? {
                                                                  peerTarget: isUlid(peer.session)
                                                                      ? shortSessionId(peer.session)
                                                                      : peer.session,
                                                              }
                                                            : {}),
                                                        ...(peer.waitSeconds > 0
                                                            ? { peerWaitSeconds: peer.waitSeconds }
                                                            : {}),
                                                        ...(peer.text
                                                            ? { peerText: clipPeerText(peer.text, PEER_TEXT_MAX_CHARS) }
                                                            : {}),
                                                    }
                                                  : {}),
                                          };
                                      }),
                                  }
                                : {}),
                        },
                    },
                };
            }
            if (role === "tool") {
                const content = typeof message.content === "string" ? message.content : "";
                const isPeerSend = typeof message.name === "string" && isPeerSendTool(message.name);
                // 会话间结果：剥掉给模型看的会话头与 stopReason 尾注，正文与状态分开给界面
                const peerResult = isPeerSend ? parsePeerResultText(content) : undefined;
                return {
                    ...base,
                    payload: {
                        // turnId 用于判断该回合是否已收尾（收尾后不再显示「思考中」）
                        turnId: event.payload.turnId,
                        message: {
                            role,
                            ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
                            ...(typeof message.name === "string" ? { name: message.name } : {}),
                            ...(typeof message.durationMs === "number" ? { durationMs: message.durationMs } : {}),
                            ...(message.isError === true ? { isError: true } : {}),
                            // 输出正文只留长度：界面只显示「← 工具 用时」，正文去日志看；
                            // 会话间结果按剥包装后的正文算，悬停字数与实际展示一致
                            contentLength: peerResult ? peerResult.body.length : content.length,
                            // 会话间发送例外：结果是对方的产出，界面按 Markdown 展示。
                            // 单事件投影看不到这次调用是否 expect_result，只能按工具名放行；
                            // 纯通知的 ack 只有一行，多带的代价可以接受。
                            ...(peerResult
                                ? {
                                      content: clipPeerText(peerResult.body, PEER_RESULT_MAX_CHARS),
                                      ...(peerResult.isResult && peerResult.status
                                          ? { peerResultStatus: peerResult.status }
                                          : {}),
                                  }
                                : {}),
                        },
                    },
                };
            }
            // 其余角色（例如历史里的 user）只留正文
            return { ...base, payload: { message: { role, content: message.content ?? "" } } };
        }
        default:
            return { ...base, payload: {} };
    }
}

/** 批量投影，null 结果被过滤掉。 */
export function toSessionEventViews(events: AgentEvent[]): SessionEventView[] {
    const views: SessionEventView[] = [];
    for (const event of events) {
        const view = toSessionEventView(event);
        if (view) views.push(view);
    }
    return views;
}

/**
 * SSE 帧的 data：省掉客户端本来就知道的两个字段。
 * - `seq` 已经在 `id:` 行（断线续传的游标），data 里再放一份是纯冗余；
 * - `sessionId` 在 URL 里（/sessions/:id/live、/jobs/:id/live?sessionId=）。
 * 一帧省下约 50 字节，帧多时（长会话回放）就是可见的体积。
 */
export function toLiveEventPayload(view: SessionEventView): Omit<SessionEventView, "seq" | "sessionId"> {
    const { seq: _seq, sessionId: _sessionId, ...rest } = view;
    return rest;
}
