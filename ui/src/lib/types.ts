export type JobState =
    | "queued"
    | "leased"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "lost";

export interface JobInput {
    prompt: string;
    workspace: string;
    title?: string;
    description?: string;
    labels?: string[];
    dueAt?: string;
    meta?: Record<string, string>;
    model?: string;
    /** 空数组 = 不用任何 MCP；undefined = 不限制 */
    mcpServers?: string[];
    priority?: number;
    timeoutSec?: number;
    freshSession?: boolean;
    maxAttempts?: number;
    /** 是否已授权执行：新建默认 false，点「开始」后才跑。 */
    autoStart?: boolean;
    /** 卡片所在的看板列：只由用户拖拽决定，与任务状态无关。 */
    column?: BoardColumnKey;
    archivedAt?: string;
}

export interface Job {
    id: string;
    source: string;
    idempotencyKey?: string;
    input: JobInput;
    state: JobState;
    priority: number;
    sessionId?: string;
    attempts: number;
    maxAttempts: number;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
    retriedFrom?: string;
}

export interface JobComment {
    id: string;
    jobId: string;
    sessionId?: string;
    author: "user" | "agent";
    authorName?: string;
    body: string;
    createdAt: string;
    editedAt?: string;
    deletedAt?: string;
}

export interface JobSession {
    jobId: string;
    sessionId: string;
    purpose: "run" | "branch";
    attempt: number;
    createdAt: string;
    /** 该会话是否已归档：归档的会话不能在卡片里继续发消息。 */
    archived?: boolean;
}

export interface McpServer {
    name: string;
    toolCount: number;
    /** 配置里 lazy：只影响默认是否选中（默认不选），选中与否才是下发判据 */
    lazy?: boolean;
}

/** 会话事件：只用到消息类，其余按类型丢弃。 */
export interface AgentEvent {
    seq: number;
    ts: string;
    sessionId: string;
    type: string;
    payload: {
        text?: string;
        /** user_message 的来源：user=本人输入，pending=回合中补发，peer=别的会话 */
        trigger?: "user" | "pending" | "peer";
        responseId?: string;
        phase?: "accepted" | "failed" | "completed" | "steered";
        isAwaitingToolInput?: boolean;
        /** 所属回合：配合 turn_commit 判断该回合是否已收尾 */
        turnId?: string;
        images?: Array<{ id: string; path: string; filename: string; mimeType: string }>;
        message?: {
            role: string;
            /** 正文；工具消息例外只有 session_send 的结果会带上（对话内容按 Markdown 展示） */
            content?: string | null;
            /** 思考内容：界面只显示「思考中」，不把推理过程铺开 */
            reasoning_content?: string | null;
            /** 服务端已经算好摘要；arguments 只在小参数时才带（大参数只留 summary） */
            tool_calls?: Array<{
                id?: string;
                name?: string;
                summary?: string;
                arguments?: string;
                /** 参数原文超长时不下发，只给长度：界面点开「参数」再按需拉全文 */
                argumentSize?: number;
                /** apply_patch 类工具：按文件统计的增删行数，界面直接渲染文件清单 */
                patchStat?: {
                    files: Array<{ path: string; kind: "add" | "update" | "delete"; added: number; removed: number }>;
                    added: number;
                    removed: number;
                };
                /** 期望结果的 session_send：界面按对话正文常驻渲染，不折叠 */
                expectResult?: boolean;
                /** session_send 发出的正文（对话内容，服务端直接下发） */
                peerText?: string;
                /** session_send 的目标会话（短 id） */
                peerTarget?: string;
                /** session_send 就地等待的秒数 */
                peerWaitSeconds?: number;
                /** 老数据兼容：原始 OpenAI 形状 */
                function?: { name: string; arguments: string };
            }>;
            tool_call_id?: string;
            /** 工具名（服务端投影后带上，省得界面反查 tool_call_id） */
            name?: string;
            /** 有推理内容（正文不下发） */
            hasReasoning?: boolean;
            /** 工具输出长度（正文不下发） */
            contentLength?: number;
            /** 工具耗时（毫秒）：历史回放只显示这个与状态，不铺开输出 */
            durationMs?: number;
            /** 工具执行失败 */
            isError?: boolean;
            /** 会话间发送拿到了对方产出时的结果状态（界面据此选标签与配色；与 src/utils/peer-result.ts 同源） */
            peerResultStatus?: "ok" | "cancelled" | "failed" | "late";
        };
        direction?: "in" | "out";
        msgId?: string;
        peerId?: string;
        peerTitle?: string;
        ok?: boolean;
        /** 会话间结果：确定丢失 */
        lost?: boolean;
        /** 会话间结果：超时/丢失报告之后才到达 */
        late?: boolean;
        /** 会话间结果：被取消的回合没有产出 */
        cancelled?: boolean;
    };
}

export type BoardColumnKey = "todo" | "doing" | "done" | "cancelled";

/** 一次工具调用的视图形状：时间线渲染与按需拉参数都用它。 */
export type ToolCallView = NonNullable<NonNullable<AgentEvent["payload"]["message"]>["tool_calls"]>[number];

/** 落盘后的图片引用（发送消息时带上）。 */
export interface ImageAsset {
    id: string;
    path: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
}
