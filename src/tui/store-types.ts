/**
 * TUI 状态层公共类型：消息视图、工具块、会话视图与监听器契约。
 * 投影逻辑分别见 store-projector.ts（渲染事件流）与 store-history.ts（领域事件重放）。
 */

import type { UsageInfo } from "../types/chat.js";
import type { ChatModelSelection } from "../types/chat-model.js";
import type { Citation, SessionOrigin } from "../types/session.js";

export interface UiMessage {
    id: number;
    role: "user" | "assistant" | "system";
    text: string;
    reasoning?: string;
    streaming: boolean;
    /**
     * 排序键：块内最后一条内容的时间（ms）。流式消息随最新 delta 推进，
     * 因此恒为当前最大值、永远排在末尾；完整消息定格在最后一条内容的时间。
     */
    sortKey: number;
    /**
     * 会话间消息标记：另一个会话发来/我发出去的消息，或对方回传的结果。
     * 与 chat 同理，始终渲染全文，按方向区分配色。
     */
    peer?: PeerMeta;
    /** assistant turn 按事件顺序排列的思考、文本和工具片段。 */
    timeline?: AssistantTimelineItem[];
    /** assistant 内嵌工具调用块索引，供展开状态和查找使用。 */
    toolBlocks?: ToolBlock[];
}

export type AssistantTimelineItem =
    /** renderedOffset：流式渲染已消费的字符偏移（视口块增量追加用）。 */
    | { type: "reasoning"; text: string; renderedOffset?: number }
    | { type: "text"; text: string }
    | { type: "user"; text: string }
    | { type: "steer_status"; responseId: string; phase: "completed" | "steered" }
    | { type: "tool"; block: ToolBlock }
    /** 回合执行期间到达的会话间消息/结果：按到达时机与文本/工具片段交错。 */
    | { type: "peer"; text: string; peer: PeerMeta }
    /** 托管工具（web_search 等）的引用来源：消息末尾的来源清单。 */
    | { type: "sources"; items: Citation[] };

/** 会话间消息元数据（UiMessage.peer 的非空形态）。 */
export interface PeerMeta {
    /** in = 对方发给我（含结果回传）；out = 我发给对方。 */
    direction: "in" | "out";
    msgId: string;
    peerId: string;
    /** 对端展示名快照。 */
    peerTitle?: string;
    /** 这是一条结果回传，而不是普通消息。 */
    isResult?: boolean;
    ok?: boolean;
    lost?: boolean;
    late?: boolean;
    /** 对方回合被取消（中止/中断），没有产出：结果只能反映"被取消"。 */
    cancelled?: boolean;
    /** 对方回合结束时是否会自动回传结果。 */
    expectResult?: boolean;
}

export interface ToolBlock {
    id: number;
    requestId: number;
    /** 事件侧工具标识（executeWithChat 每次请求从 1 计数），与 requestId 共同定位 */
    toolId: number;
    /** 稳定调用 id（= toolCall.id）：tool_result 按它配对，跨实时/重放一致。 */
    callId?: string;
    name: string;
    args?: string;
    result?: string;
    isError?: boolean;
    /** 执行耗时（ms）：来自 tool_result 事件或落盘的工具消息，重放旧数据时可能缺失。 */
    durationMs?: number;
    /** 执行起始时刻（ms epoch）：仅实时运行中的块有值，用于取消时结算已运行时间。 */
    startedAt?: number;
    /** 用户在工具执行期间中止了回合：块没有结果，状态显示为已取消。 */
    cancelled?: boolean;
    expanded: boolean;
}

export interface SessionView {
    sessionId: string;
    /** 会话来源：`job`（任务跑出来的会话）在会话条/面板标题前显示 ⚑。 */
    origin?: SessionOrigin;
    /** 会话绑定的工作目录（来自会话摘要），会话面板的目录列据此标识来源。 */
    cwd?: string;
    messageCount: number;
    lastUserMessage?: string;
    /** 会话标题：显式重命名优先，否则取首条用户消息（tab 固定展示）。 */
    title?: string;
    updatedAt?: string;
    archived?: boolean;
    modelSelection?: ChatModelSelection;
}

export interface StoreListeners {
    onMessagesChanged: () => void;
    onSessionsChanged: () => void;
    onStatusChanged: () => void;
}

/**
 * 会话累计平均生成速率（token/秒）：Σ生成 token / ΣdurationMs，用于状态栏展示。
 * 生成 token 取 usage.outputTokens（上游不区分输入/输出时的本地估算）或 completionTokens。
 */
export interface RequestRate {
    /** 整体平均：Σ生成 token / ΣdurationMs */
    totalTps: number;
    /** 思考阶段平均速率（以首个正文 delta 作为思考结束点，无思考时为 undefined） */
    reasoningTps?: number;
    /** 正文输出阶段平均速率（无正文时为 undefined） */
    outputTps?: number;
    completionTokens: number;
    reasoningTokens: number;
    durationMs: number;
}

/** 单个会话的 UI 聚合状态：消息列表、token 累计、速率累计与进行中的回合标记。 */
export interface SessionUiState {
    messages: UiMessage[];
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    /**
     * 上下文占用的唯一事实来源：provider 实测优先，失败回合/未请求时回落到本地估算。
     * 两路数值只在这一处汇合，展示层不再自行取大。
     */
    contextTokens: number;
    /** contextTokens 的来源：provider = 上游 usage 实测；local = 本地估算（展示更淡）。 */
    contextSource?: "provider" | "local";
    /** DeepSeek 会话费用累计（元），由 costFor 注入计算：官方端点或开启 runtime.deepseekCostStat 后按官方价格表估算。 */
    costYuan: number;
    /** 会话累计平均速率；请求进行中仍显示已完成请求的累计值（状态栏置灰）。 */
    lastRate?: RequestRate;
    /** 速率累计：只统计有耗时的请求，token 与耗时成对累加，避免分母错配。 */
    summedCompletionTokens: number;
    summedReasoningTokens: number;
    summedOutputTokens: number;
    summedDurationMs: number;
    summedReasoningMs: number;
    summedOutputMs: number;
    /** 本次请求起点与首包时间，用于切分思考/输出阶段（均为本地时间戳，非估算）。 */
    requestStartedAt?: number;
    firstReasoningAt?: number;
    firstTextAt?: number;
    activeRequestId: number | null;
    activeAssistantId: number | null;
    /** 当前流式 assistant 消息的直接引用：避免每个 delta 都按 id 线性查找。 */
    activeAssistant?: UiMessage;
    /**
     * 群消息实时插入锚点：当前开放段在 timeline 中的起始下标。
     * 段级粒度（reasoning/text/tool/user 各算一段），与重放侧按 turn_segment_start 对齐。
     */
    activeChatAnchor?: number;
    /**
     * 当前 LLM 迭代开始时 timeline 的长度（每次 turn_start 重置）。
     * message_end 的最终值只属于本轮迭代，对账时以它为边界，
     * 否则多轮工具循环会把最终回复/最终思考搬到工具调用之前的段里（见 store-message.ts）。
     */
    iterationStartIndex?: number;
}

export function createSessionUiState(): SessionUiState {
    return {
        messages: [],
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        contextTokens: 0,
        costYuan: 0,
        summedCompletionTokens: 0,
        summedReasoningTokens: 0,
        summedOutputTokens: 0,
        summedDurationMs: 0,
        summedReasoningMs: 0,
        summedOutputMs: 0,
        activeRequestId: null,
        activeAssistantId: null,
        activeAssistant: undefined,
    };
}

export interface ChatStoreOptions {
    /** 单次 usage 的费用计算器（元）。TUI 仅对官方 DeepSeek 接入注入；缺省不计费。 */
    costFor?: (usage: UsageInfo, atMs: number) => number;
}
