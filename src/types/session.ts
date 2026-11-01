type ToolResultMode = 'adaptive' | 'full';

/** 会话标题长度上限（renameSession 与命令行共用）。 */
export const MAX_SESSION_TITLE_LENGTH = 200;

/**
 * 会话来源：谁建的。只用于区分「任务跑出来的会话」与「人开的会话」，
 * 不参与会话运行语义；老会话没有该字段时视为 user。
 */
export type SessionOrigin = "user" | "web" | "job" | "tool";

export interface ToolResultPolicy {
    mode: ToolResultMode;
}

// OpenAI-compatible message types
import type { ImageAssetContent, ImageDataContent, UserContent } from './image.js';
import type { AudioContent } from './audio.js';
import type { ChatModelSelection } from './chat-model.js';

/** 上游托管工具（如 web_search）随正文返回的引用来源。 */
export interface Citation {
    url: string;
    title?: string;
    /** Responses 字符级 citation 在合并正文中的起止偏移。 */
    startIndex?: number;
    endIndex?: number;
}

/** @public */
export type ChatMessage =
    | { role: 'user'; content: UserContent }
    | { role: 'assistant'; content: string | null; tool_calls?: any[]; citations?: Citation[]; [key: string]: any }
    | {
        role: 'tool';
        tool_call_id: string;
        content: string;
        name?: string;
        contextPolicy?: ToolResultPolicy;
        /** 执行耗时（ms）：本地渲染元数据，上行前剥离。 */
        durationMs?: number;
        /** 工具执行失败：本地渲染元数据，上行前剥离（时间线据此标红） */
        isError?: boolean;
        /** 工具返回的图片/音频：本地元数据，上行前由 expandToolMediaMessages 抽成独立 user 消息。 */
        imageContent?: Array<ImageAssetContent | ImageDataContent>;
        audioContent?: AudioContent[];
        [key: string]: any;
    }
    | { role: 'system'; content: string };

/** 持久化消息附带本地元数据；发送给 LLM 前会被剥离。 */
export type StoredChatMessage = ChatMessage & {
    id: string;
    createdAt: string;
    /** 工具结果是否要求完整保留（本地元数据，发送给模型前剥离）。 */
    contextPolicy?: ToolResultPolicy;
};

/** 一次用户交互的完整消息序列，工具调用与结果按原始顺序保存。 */
export interface ConversationTurn {
    id: string;
    messages: StoredChatMessage[];
    status: 'completed' | 'interrupted' | 'failed';
}

type ContextChangeReason = 'session_start' | 'hard_trim' | 'compact';

interface ContextState {
    startedAt: string;
    reason: ContextChangeReason;
    sourceUserTurnCount: number;
    retainedUserTurnCount: number;
    compactedAt?: string;
    compactInstruction?: string;
}

export interface Session {
    sessionId: string; // ULID，会话唯一标识
    /** 会话来源（建会话的一方）；老会话缺省视为 user。 */
    origin?: SessionOrigin;
    /** 会话绑定的工作目录：新会话取创建时当前工具目录；旧数据无记录时回退当前工具目录。恢复/切换会话时作为工具执行与路径渲染基准。 */
    cwd: string;
    /** 会话标题：显式重命名优先，否则取首条用户消息；tab 展示用。 */
    title?: string;
    contextEpochId: string; // 当前上下文代际，用于区分压缩和硬裁剪后的缓存前缀
    turns: ConversationTurn[];
    compactedContext?: string;
    /** 压缩截止的 turn：它之前的回合全部折叠进 compactedContext。 */
    compactedThroughTurnId?: string;
    /**
     * 保留段起始消息 id（消息级边界）。
     * 正常按完整 turn 切分时它就是保留段首个 turn 的第一条消息；
     * 单个 turn 超过保留预算时会在 turn 内切分，此时它落在 turn 中间。
     */
    compactedKeepFromMessageId?: string;
    contextState: ContextState;
    totalUserTurnCount: number;
    hardTrimCount: number;
    compactCount: number;
    /** 最近一次 provider 请求返回的输入 token，用于下一次自动压缩预判。 */
    lastPromptTokens?: number;
    createdAt?: string; // 会话创建时间（上海时区 ISO 字符串）
    updatedAt?: string; // 最近一次持久化相关变更时间
    archivedAt?: string; // 会话归档时间（上海时区 ISO 字符串）
    /** 会话固定使用的模型与协议；缺省时采用全局默认配置。 */
    modelSelection?: ChatModelSelection;
    /**
     * 本会话临时启用的 lazy MCP server（/mcp 面板）。
     * 生效范围只有该会话：模型不支持 tool_search 时，只有这些 server 的工具会下发。
     */
    lazyMcpServers?: string[];
}
