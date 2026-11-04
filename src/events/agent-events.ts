/**
 * Agent 事件（持久化，事实源）：append-only 事件日志的条目。
 * Session 状态是其投影——重放事件序列可确定性重建任意时间点状态。
 *
 * 回合内容以 turn_message（每条完整消息一次，保留 provider 专有字段）为准；
 * turn_stream_delta 在完整消息定稿前保存已展示的流式片段，供异常退出恢复。
 * 位置由 turn_segment_start（段起始边界）给出；回合收尾用一条 turn_commit 元信息事件以
 * seq 列表指向它们，避免把同一份内容在终态事件里再存一遍。
 */

import type { ChatMessage, SessionOrigin } from "../types/session.js";
import type { SteerUpdate, StreamDelta, UsageInfo } from "../types/chat.js";
import type { ImageInputRef, UserMessageInput } from "../types/image.js";
import type { ChatModelSelection } from "../types/chat-model.js";

export type AgentEventType =
    | "session_created"
    | "user_message"
    | "peer_message"
    | "peer_result"
    | "turn_message"
    | "turn_stream_delta"
    | "steer_update"
    | "turn_segment_start"
    | "turn_commit"
    | "context_compacted"
    | "assistant_history_repaired"
    | "standalone_turn"
    | "usage_recorded"
    | "session_archived"
    | "session_unarchived"
    | "session_renamed"
    | "session_cwd_changed"
    | "model_selected"
    | "lazy_mcp_changed";

/** 用户消息附带的图片引用。 */
type UserImageRef = ImageInputRef;

export interface AgentEventPayloads {
    /** origin 缺省视为 user（老日志没有该字段）。 */
    session_created: { cwd: string; origin?: SessionOrigin };
    /**
     * 用户消息事实源。turnId 把同一回合的增量消息归组；trigger 区分用户输入与执行中
     * 并入的 pending 消息。
     */
    user_message: {
        text: string;
        images?: UserImageRef[];
        turnId: string;
        /** peer：另一个会话发来的消息或它回传的结果，时间线上按会话卡片渲染。 */
        trigger: "user" | "pending" | "peer";
    };
    /**
     * 会话间消息事实源（UI 时间线专用）：入站请求、出站消息、结果回传各一条。
     * 不参与 Session 投影——会话间对话是展示与驱动来源，模型上下文由 user_message 承载。
     */
    peer_message: {
        msgId: string;
        direction: "in" | "out";
        /** 对端会话 id。 */
        peerId: string;
        /** 对端展示名快照（会话可能被重命名或删除）。 */
        peerTitle?: string;
        text: string;
        /** 本轮是否期望结果（入站消息携带）。 */
        expectResult?: boolean;
        /** 在回应哪条消息。 */
        replyTo?: string;
        /** 入站消息因目标忙被排队：仅标记“入队”，是否已执行需结合后续 user_message/peer_result 判断。 */
        queued?: boolean;
        /** 排队截止时间（ISO）。 */
        expiresAt?: string;
        createdAt: string;
    };
    /** 会话间结果事实源（UI 时间线专用）：对方回合的产出回传，或等待失败。 */
    peer_result: {
        /** 关联的请求消息 id。 */
        msgId: string;
        /** 产出这条结果的对端会话。 */
        peerId: string;
        peerTitle?: string;
        /** 对方回合是否正常完成。 */
        ok: boolean;
        /** 结果确定丢失（对方进程退出或等待超时）。 */
        lost?: boolean;
        /** 已报告超时/丢失后才到达的结果。 */
        late?: boolean;
        text: string;
        stopReason?: string;
        createdAt: string;
    };
    /**
     * 回合内每条**完整**消息定稿即落盘（不含流式 delta），让强杀/崩溃也能恢复现场。
     * 保留 provider 专有字段（reasoning_details、tool_call 的 thought_signature 等），
     * 重放时直接回传，避免请求格式错误。同一 turnId 的 turn_commit 出现后即视为终态。
     */
    turn_message: { turnId: string; message: ChatMessage };
    /** 流式片段先落盘再展示；完整 assistant 消息落盘后不再用这些片段恢复。 */
    turn_stream_delta: { turnId: string; requestIndex: number; delta: StreamDelta };
    /** UI 专用的 steer 状态与前响应快照；不进入模型消息历史。 */
    steer_update: { turnId: string } & SteerUpdate;
    /**
     * 回合内的段边界（时间线分段）：每段**开始**时落一条，seq 即该段的起始时间。
     * 群消息按 seq 与段边界比较，就能在重放时插到与实时一致的段位。
     */
    turn_segment_start: { turnId: string; kind: "reasoning" | "text" | "tool" | "user" };
    /**
     * 回合终态元信息：只存关系（events 指向底层事件 seq）与收尾事实，不重复内容。
     * events 按时间线顺序列出本回合的 turn_message / turn_segment_start。
     */
    turn_commit: {
        turnId: string;
        events: number[];
        userMessages: Array<string | UserMessageInput>;
        stopReason: string;
        usage: UsageInfo;
        interrupted: boolean;
        /**
         * 回合结束时按当前历史算出的上下文规模（本地估算，含思维链与工具媒体）。
         * provider 只在请求成功时给 usage，失败回合靠它把真实占用暴露给状态栏；
         * 也覆盖「回合内压缩后 provider 值偏小」的口径差。
         */
        contextTokens?: number;
        /**
         * 本回合实际生效的 MCP 选中集快照（回合开始时定下，中途增删不影响本回合）。
         * 缺省表示该回合不做限制（老会话没有选中集）。
         */
        mcpServers?: string[];
        /** provider/orchestrator 抛错时填入，便于事后排查 429/502/length/error。 */
        error?: string;
    };
    context_compacted: {
        compactedContext: string;
        instruction?: string;
        /**
         * 回合内压缩：摘要已经替换了本回合此前全部消息（含旧历史），
         * 重放时这些 turn_message 属于被摘要吸收的范围，不能再物化。
         */
        scope?: "turn";
        /** scope=turn 时对应的回合 id。 */
        turnId?: string;
        /** 保留段起始消息 id，供当前进程定位。 */
        keepFromMessageId?: string;
        /** 持久化位置，避免重放时重新生成的消息 id 使边界失效。 */
        keepFromPosition?: { turnIndex: number; messageIndex: number };
        usage?: UsageInfo;
    };
    /** 上游拒绝空助手消息后，移除历史中无正文且无工具调用的助手消息。 */
    assistant_history_repaired: {};
    /**
     * 不经编排器的独立回合投影源。
     * injected：自动注入的上下文（群聊状态更新）标记 —— 不是用户活动，会话排序时不计入更新时间。
     */
    standalone_turn: { messages: ChatMessage[]; injected?: boolean };
    usage_recorded: { usage: UsageInfo };
    session_archived: {};
    /** 取消归档：与 session_archived 成对，末态决定会话是否归档。 */
    session_unarchived: {};
    /** 用户双击 tab 重命名会话标题（tab 显示优先于首条用户消息）。 */
    session_renamed: { title: string };
    /** 会话工作目录被改写（cwd 工具 / /cwd 命令）：最后一条决定当前目录。 */
    session_cwd_changed: { cwd: string };
    /** 会话固定使用的协议与模型。 */
    model_selected: ChatModelSelection;
    /** 本会话临时启用的 lazy MCP server（整份覆盖，空数组表示全部回到默认不下发）。 */
    lazy_mcp_changed: { servers: string[] };
}

export type AgentEvent = {
    [T in AgentEventType]: {
        seq: number;
        ts: string;
        sessionId: string;
        type: T;
        payload: AgentEventPayloads[T];
    };
}[AgentEventType];

/**
 * 是否为自动注入的上下文事件（群聊状态更新等）：不算用户活动。
 *
 * 会话更新时间与归档判定都要忽略它 —— 归档后这类注入仍会落盘，若当成活动会让
 * 归档态失效、闲置会话被顶到列表最前。
 * 兜底识别旧事件（injected 标记落地前写下的）：注入内容恒为一条以 "[群聊状态更新" 开头的 system 消息。
 */
export function isInjectedContext(event: AgentEvent): boolean {
    if (event.type !== "standalone_turn") return false;
    if (event.payload.injected === true) return true;

    const messages = event.payload.messages ?? [];
    return messages.length > 0
        && messages.every(message => message.role === "system"
            && typeof message.content === "string"
            && message.content.startsWith("[群聊状态更新"));
}
