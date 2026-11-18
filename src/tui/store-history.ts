/**
 * 领域事件重放投影：把持久化的事件历史（AgentEvent[]）全量重建为消息列表。
 * 用于切换会话 / 进程重启后恢复时间线。
 *
 * 排序语义与实时一致：助手消息按段（reasoning/text/tool/user/chat）排序，
 * turn_segment_start 记录每段的起始边界；群消息按 seq 落在「当时开放的那一段」，
 * 从而在不打断助手消息整体的前提下，插到时间线任意段位。
 *
 * 回合内容以 turn_message（每条完整消息一次）为准，未定稿时从 turn_stream_delta 恢复，
 * turn_commit 只提供收尾事实，
 * 二者通过 turnId 关联；messages 不再在终态事件里重复存储。
 */

import type { AgentEvent } from "../events/agent-events.js";
import { isCancelledStopReason } from "../control/protocol.js";
import type { ChatMessage } from "../types/session.js";
import type { SteerUpdate } from "../types/chat.js";
import { StreamRecovery } from "../utils/stream-recovery.js";
import { isReasoningPlaceholder } from "../utils/reasoning-placeholder.js";
import type { AssistantTimelineItem, SessionUiState, ToolBlock, UiMessage } from "./store-types.js";
import {
    abortMarkText,
    appendTimelineTextToList,
    composeAbortText,
    createMessage,
    extractToolCalls,
    INTERRUPT_LABEL,
    interruptLabel,
} from "./store-message.js";
import { addTokenUsage, recordEstimatedContextTokens, resetTokenUsage } from "./store-usage.js";
import type { ProjectionDeps } from "./store-projector.js";
import type { PeerMeta } from "./store-types.js";

/** 会话间事件 → 时间线片段（消息与结果共用一条投影路径）。 */
function anchorOfPeerEvent(
    event: Extract<AgentEvent, { type: "peer_message" | "peer_result" }>,
): AnchorEntry {
    if (event.type === "peer_message") {
        const { msgId, direction, peerId, peerTitle, text, expectResult } = event.payload;
        return {
            seq: event.seq,
            text,
            peer: {
                direction,
                msgId,
                peerId,
                ...(peerTitle ? { peerTitle } : {}),
                ...(expectResult ? { expectResult: true } : {}),
            },
        };
    }

    const { msgId, peerId, peerTitle, ok, lost, late, text, stopReason } = event.payload;
    const peer: PeerMeta = {
        direction: "in",
        msgId,
        peerId,
        ...(peerTitle ? { peerTitle } : {}),
        isResult: true,
        ok,
        ...(lost ? { lost: true } : {}),
        ...(late ? { late: true } : {}),
        ...(isCancelledStopReason(stopReason) ? { cancelled: true } : {}),
    };
    return { seq: event.seq, text, peer };
}

function peerEventKey(event: Extract<AgentEvent, { type: "peer_message" | "peer_result" }>): string {
    if (event.type !== "peer_result") return `${event.payload.msgId}${event.type}`;
    const outcome = event.payload.lost ? "lost" : event.payload.late ? "late" : "result";
    return `${event.payload.msgId}${event.type}${outcome}`;
}

type TurnCommitEvent = Extract<AgentEvent, { type: "turn_commit" }>;
type SegmentStartKind = "reasoning" | "text" | "tool" | "user";

/**
 * 回合内插入时间线的外部消息片段：seq 用于定位它在段序列中的插入位置。
 * 目前只有会话间消息与结果（peer）。
 */
interface AnchorEntry {
    seq: number;
    text: string;
    peer: NonNullable<UiMessage["peer"]>;
}

/** 回合内的段起始边界。 */
interface SegmentEntry {
    seq: number;
    kind: SegmentStartKind;
}

/**
 * 从回合消息里取最后一条助手正文，包括失败前已收到的部分输出。
 */
type HistoryDisplayMessage = ChatMessage | ({ role: "steer_update"; content?: string } & SteerUpdate);

function deriveContent(messages: HistoryDisplayMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]!;
        if (message.role !== "assistant") continue;
        return typeof message.content === "string" ? message.content : "";
    }
    return "";
}

/**
 * 把原始历史消息（OpenAI 风格）还原成 assistant turn 的时间线、reasoning 与工具块。
 * nextBlockId 由调用方注入，保证与实时事件的工具块 id 序列不冲突。
 * chats / segments 用于把回合执行期间到达的群消息按段位插进时间线。
 */
function buildHistoryTimeline(
    messages: HistoryDisplayMessage[],
    content: string,
    interruptMark: string | undefined,
    nextBlockId: () => number,
    chats: AnchorEntry[] = [],
    segments: SegmentEntry[] = [],
): { timeline: AssistantTimelineItem[]; reasoning?: string; toolBlocks: ToolBlock[] } {
    const toolBlocks: ToolBlock[] = [];
    const blocksByCallId = new Map<string, ToolBlock>();
    const toolCalls = extractToolCalls(messages);
    const timeline: AssistantTimelineItem[] = [];
    let reasoning = "";
    let pendingSteerText: string | undefined;
    // 与实时路径（orchestrator 的 ++toolIdCounter）口径一致：按出现序赋 1..N，
    // 让两侧 toolId 都等于数组序，排序语义统一。
    let toolIdCounter = 0;

    for (const message of messages) {
        if (message.role === "steer_update") {
            if (message.phase === "accepted" || message.phase === "failed") continue;
            if (message.content) timeline.push({ type: "text", text: message.content });
            pendingSteerText = message.isAwaitingToolInput ? message.content : undefined;
            timeline.push({ type: "steer_status", responseId: message.responseId, phase: message.phase });
            continue;
        }
        if (message.role === "user") {
            const userContent = message.content ?? ("text" in message ? message.text : undefined);
            if (typeof userContent === "string" && userContent) {
                timeline.push({ type: "user", text: userContent });
            }
            continue;
        }

        if (message.role === "assistant") {
            const messageReasoning = message.reasoning_content ?? message.reasoning;
            // 老日志里可能存着补请求用的占位思考：它是协议产物，不当思考渲染。
            if (typeof messageReasoning === "string" && messageReasoning && !isReasoningPlaceholder(messageReasoning)) {
                reasoning += messageReasoning;
                appendTimelineTextToList(timeline, "reasoning", messageReasoning);
            }

            if (typeof message.content === "string" && message.content && message.content !== pendingSteerText) {
                appendTimelineTextToList(timeline, "text", message.content);
            }
            pendingSteerText = undefined;

            // 托管工具引用：与实时投影一致，排在正文之后
            if (Array.isArray(message.citations) && message.citations.length > 0) {
                timeline.push({ type: "sources", items: message.citations });
            }

            for (const toolCall of message.tool_calls ?? []) {
                const id = toolCall?.id ?? toolCall?.call_id;
                if (typeof id !== "string" || !id) continue;
                const call = toolCalls.get(id);
                const block: ToolBlock = {
                    id: nextBlockId(),
                    requestId: 0,
                    toolId: ++toolIdCounter,
                    callId: id,
                    name: call?.name ?? toolCall?.function?.name ?? toolCall?.name ?? id,
                    args: call?.args,
                    expanded: false,
                };
                toolBlocks.push(block);
                blocksByCallId.set(id, block);
                timeline.push({ type: "tool", block });
            }
            continue;
        }

        if (message.role === "tool") {
            const block = blocksByCallId.get(message.tool_call_id);
            if (block) {
                block.result = String(message.content);
                block.isError = message.isError === true;
                if (typeof message.durationMs === "number") block.durationMs = message.durationMs;
            } else {
                const call = toolCalls.get(message.tool_call_id);
                const fallbackBlock: ToolBlock = {
                    id: nextBlockId(),
                    requestId: 0,
                    toolId: ++toolIdCounter,
                    name: message.name ?? call?.name ?? message.tool_call_id,
                    args: call?.args,
                    result: String(message.content),
                    expanded: false,
                    ...(typeof message.durationMs === "number" ? { durationMs: message.durationMs } : {}),
                };
                toolBlocks.push(fallbackBlock);
                timeline.push({ type: "tool", block: fallbackBlock });
            }
        }
    }

    // 只有被中止/中断的回合才把「没有结果消息」判为取消：正常收尾的回合缺结果
    // 更像是落盘异常，标成黄色「已取消」会误导；耗时未落盘，这里只能显示取消状态。
    if (interruptMark) {
        for (const block of toolBlocks) {
            if (block.result === undefined) block.cancelled = true;
        }
    }

    // 群消息落点：找到「chat 到达时开放的那一段」，文本/思考段插到它之前，工具段插到它之后。
    const insertions = new Map<number, AnchorEntry[]>();
    const pushChat = (index: number, chat: AnchorEntry): void => {
        const list = insertions.get(index);
        if (list) list.push(chat);
        else insertions.set(index, [chat]);
    };
    for (const chat of chats) {
        let openIndex = -1;
        for (const [index, segment] of segments.entries()) {
            if (segment.seq > chat.seq) break;
            openIndex = index;
        }
        if (openIndex < 0) pushChat(0, chat);
        else pushChat(segments[openIndex]!.kind === "tool" ? openIndex + 1 : openIndex, chat);
    }

    const withChats: AssistantTimelineItem[] = [];
    const anchorItem = (entry: AnchorEntry): AssistantTimelineItem =>
        ({ type: "peer", text: entry.text, peer: entry.peer });
    timeline.forEach((item, index) => {
        for (const entry of insertions.get(index) ?? []) withChats.push(anchorItem(entry));
        withChats.push(item);
    });
    for (const entry of insertions.get(timeline.length) ?? []) withChats.push(anchorItem(entry));

    const hasContent = messages.some(message => message.role === "assistant" && message.content === content);
    if (content && !hasContent) appendTimelineTextToList(withChats, "text", content);
    if (interruptMark) appendTimelineTextToList(withChats, "text", abortMarkText(Boolean(content), interruptMark));

    return { timeline: withChats, reasoning: reasoning || undefined, toolBlocks };
}

/** 领域事件历史 → 会话 UI 状态（清空后全量重建）。 */
export function projectHistory(
    state: SessionUiState,
    events: AgentEvent[],
    deps: ProjectionDeps,
    isCurrent: boolean,
): void {
    state.messages = [];
    state.activeRequestId = null;
    state.activeAssistantId = null;
    state.activeAssistant = undefined;
    state.activeChatAnchor = undefined;
    state.iterationStartIndex = undefined;
    resetTokenUsage(state);

    const eventAt = (event: AgentEvent): number =>
        Number.isFinite(Date.parse(event.ts)) ? Date.parse(event.ts) : Date.now();
    const chatSortKey = (event: AgentEvent): number => {
        const createdAt = event.type === "peer_message" || event.type === "peer_result"
            ? event.payload.createdAt
            : undefined;
        const parsed = createdAt ? Date.parse(createdAt) : Number.NaN;
        return Number.isFinite(parsed) ? parsed : eventAt(event);
    };

    // 回合消息（turn_message）按 turnId 归组：内容只存这一份，终态事件只引用。
    const messagesByTurn = new Map<string, HistoryDisplayMessage[]>();
    const streamByTurn = new Map<string, StreamRecovery>();
    const appendRecoveredStream = (turnId: string, stream: StreamRecovery): void => {
        const partial = stream.message();
        if (!partial) return;
        const list = messagesByTurn.get(turnId) ?? [];
        list.push(partial);
        messagesByTurn.set(turnId, list);
    };
    for (const event of events) {
        if (event.type === "turn_stream_delta") {
            const { turnId, requestIndex, delta } = event.payload;
            const stream = streamByTurn.get(turnId) ?? new StreamRecovery();
            stream.push(requestIndex, delta);
            streamByTurn.set(turnId, stream);
        } else if (event.type === "steer_update") {
            const list = messagesByTurn.get(event.payload.turnId) ?? [];
            list.push({
                role: "steer_update",
                responseId: event.payload.responseId,
                phase: event.payload.phase,
                content: event.payload.text,
                isAwaitingToolInput: event.payload.isAwaitingToolInput,
            });
            messagesByTurn.set(event.payload.turnId, list);
        } else if (event.type === "turn_message") {
            const list = messagesByTurn.get(event.payload.turnId) ?? [];
            list.push(event.payload.message);
            messagesByTurn.set(event.payload.turnId, list);
            if (event.payload.message.role === "assistant") streamByTurn.get(event.payload.turnId)?.clear();
        } else if (event.type === "turn_commit") {
            const stream = streamByTurn.get(event.payload.turnId);
            if (stream) appendRecoveredStream(event.payload.turnId, stream);
            streamByTurn.delete(event.payload.turnId);
        }
    }

    // 已闭合回合：同 turnId 以最后一条 turn_commit（终态）为准。
    const commitsById = new Map<string, TurnCommitEvent>();
    for (const event of events) {
        if (event.type === "turn_commit") commitsById.set(event.payload.turnId, event);
    }
    for (const [turnId, stream] of streamByTurn) {
        appendRecoveredStream(turnId, stream);
    }

    const handledTurnIds = new Set<string>();
    const renderedUnclosedTurnIds = new Set<string>();
    /** 会话间消息按「msgId + 事件类型」去重：同一条消息的请求与结果各自保留。 */
    const seenPeerIds = new Set<string>();

    // 预扫描回合内的段边界与群消息：按落盘顺序归属到当前未结束的回合，
    // 与实时路径「回合执行中插进气泡段位」一致；回合外的群消息仍渲染为独立消息。
    const segmentsByTurn = new Map<string, SegmentEntry[]>();
    const chatsByTurn = new Map<string, AnchorEntry[]>();
    const assignedChatSeqs = new Set<number>();
    {
        let activeTurnId: string | null = null;
        for (const event of events) {
            if (event.type === "user_message") {
                if (event.payload.turnId) activeTurnId = event.payload.turnId;
                continue;
            }
            if (event.type === "turn_message" || event.type === "turn_stream_delta") {
                activeTurnId = event.payload.turnId;
                continue;
            }
            if (event.type === "turn_commit") {
                activeTurnId = null;
                continue;
            }
            if (event.type === "turn_segment_start") {
                if (!activeTurnId) continue;
                const list = segmentsByTurn.get(activeTurnId) ?? [];
                list.push({ seq: event.seq, kind: event.payload.kind });
                segmentsByTurn.set(activeTurnId, list);
                continue;
            }
            if (!activeTurnId) continue;
            if (event.type !== "peer_message" && event.type !== "peer_result") continue;
            const key = peerEventKey(event);
            if (seenPeerIds.has(key)) continue;
            seenPeerIds.add(key);
            const list = chatsByTurn.get(activeTurnId) ?? [];
            list.push(anchorOfPeerEvent(event));
            chatsByTurn.set(activeTurnId, list);
            assignedChatSeqs.add(event.seq);
        }
    }

    /** 渲染回合终态的助手消息与错误提示；token 用量统一在 turn_commit 自身位置累加。 */
    const pushCommitTurn = (event: TurnCommitEvent, sortKey: number): void => {
        const { turnId, interrupted, stopReason, error } = event.payload;
        const messages = messagesByTurn.get(turnId) ?? [];
        const content = deriveContent(messages);
        const label = interrupted ? interruptLabel(stopReason) : undefined;
        // 与实时路径逐字一致的收尾正文，拼接规则共用 composeAbortText（避免各自实现漂移）。
        const replyText = label ? composeAbortText(content, label) : content;
        const { timeline, reasoning, toolBlocks } = buildHistoryTimeline(
            messages,
            content,
            label,
            deps.nextBlockId,
            chatsByTurn.get(turnId) ?? [],
            segmentsByTurn.get(turnId) ?? [],
        );
        if (timeline.length > 0 || content || interrupted || stopReason !== "error") {
            state.messages.push(
                createMessage(deps.nextMessageId, {
                    role: "assistant",
                    text: replyText,
                    reasoning,
                    timeline,
                    toolBlocks,
                    sortKey,
                }),
            );
        }
        if (stopReason === "error" && error) {
            state.messages.push(
                createMessage(deps.nextMessageId, {
                    role: "system",
                    text: `⚠️ ${error}`,
                    sortKey,
                }),
            );
        }
    };

    /** 未闭合回合（进程被强杀，只剩 turn_message 增量）恢复为（中断）助手消息。 */
    const pushInterruptedTurn = (turnId: string, sortKey: number): void => {
        const messages = messagesByTurn.get(turnId);
        if (!messages) return;
        const { timeline, reasoning, toolBlocks } = buildHistoryTimeline(
            messages,
            "",
            INTERRUPT_LABEL,
            deps.nextBlockId,
            chatsByTurn.get(turnId) ?? [],
            segmentsByTurn.get(turnId) ?? [],
        );
        state.messages.push(
            createMessage(deps.nextMessageId, {
                role: "assistant",
                text: INTERRUPT_LABEL,
                reasoning,
                timeline,
                toolBlocks,
                sortKey,
            }),
        );
    };

    for (const event of events) {
        const eventAtMs = eventAt(event);
        switch (event.type) {
            case "user_message": {
                // 会话间消息已逐条落成 peer_message/peer_result、执行中并入的 pending 消息只进助手时间线，重放时都不单独渲染气泡
                // peer 来源的 user 消息（会话间消息/结果）已由 peer_* 事件渲染，跳过避免重复
                const isPending = event.payload.trigger === "pending" || event.payload.trigger === "peer";
                if (!isPending) {
                    state.messages.push(
                        createMessage(deps.nextMessageId, {
                            role: "user",
                            text: event.payload.text,
                            sortKey: eventAtMs,
                        }),
                    );
                }
                break;
            }
            case "peer_message":
            case "peer_result": {
                // 回合内的会话间消息已随助手气泡时间线渲染，这里跳过避免重复
                if (assignedChatSeqs.has(event.seq)) break;
                const key = peerEventKey(event);
                if (seenPeerIds.has(key)) break;
                seenPeerIds.add(key);
                const anchor = anchorOfPeerEvent(event);
                const message = createMessage(deps.nextMessageId, {
                    role: "system",
                    text: anchor.text,
                    sortKey: chatSortKey(event),
                });
                message.peer = anchor.peer;
                state.messages.push(message);
                break;
            }
            case "turn_message":
            case "steer_update":
            case "turn_stream_delta":
                // 每个未闭合回合在首条消息处渲染一次。
                if (
                    !commitsById.has(event.payload.turnId) &&
                    !renderedUnclosedTurnIds.has(event.payload.turnId)
                ) {
                    renderedUnclosedTurnIds.add(event.payload.turnId);
                    pushInterruptedTurn(event.payload.turnId, eventAtMs);
                }
                break;
            case "turn_commit": {
                const turnId = event.payload.turnId;
                // 同 turnId 重复落盘（异常情况）只计费与渲染一次，且统一以最后一条终态为准
                if (handledTurnIds.has(turnId)) break;
                handledTurnIds.add(turnId);
                const terminal = commitsById.get(turnId) ?? event;
                addTokenUsage(state, terminal.payload.usage, eventAt(terminal), deps.costFor);
                recordEstimatedContextTokens(state, terminal.payload.contextTokens);
                pushCommitTurn(terminal, eventAt(terminal));
                break;
            }
            case "context_compacted":
                if (event.payload.usage) {
                    addTokenUsage(state, event.payload.usage, eventAtMs, deps.costFor);
                }
                state.messages.push(
                    createMessage(deps.nextMessageId, {
                        role: "system",
                        text: `🗜️ 已压缩上下文`,
                        sortKey: eventAtMs,
                    }),
                );
                break;
            case "usage_recorded":
                addTokenUsage(state, event.payload.usage, eventAtMs, deps.costFor);
                break;
            case "turn_segment_start":
            case "session_created":
            case "session_archived":
                break;
        }
    }
    if (isCurrent) {
        deps.notifyMessages();
    }
}
