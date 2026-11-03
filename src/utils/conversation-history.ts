import type { ChatMessage, ConversationTurn, Session, StoredChatMessage } from '../types/session.js';
import { getShanghaiISOString } from './time.js';
import { projectToolMessageForPrompt } from './tool-result-context.js';
import { createUlid } from './ulid.js';
import { toUserContent, type UserMessageInput } from '../types/image.js';
import { repairToolCallPairing } from './conversation-history-repair.js';

type StoredUserInput = string | UserMessageInput;

function userInputMessage(input: StoredUserInput): ChatMessage {
    if (typeof input === 'string') return { role: 'user', content: input };
    return { role: 'user', content: toUserContent(input) };
}

function createStoredMessage(message: ChatMessage): StoredChatMessage {
    // audioContent 是内联 base64（读一个 5MB wav 就是 ~6.7MB），只在构造当轮请求时需要。
    // 图片走 sessions/assets 资产引用没有这个问题，音频暂无对应机制，落盘前直接剔除，
    // 代价是后续轮次只保留工具结果里的文本占位符。ctx.messages 里的原消息不受影响。
    const { audioContent: _audioContent, ...rest } = message as ChatMessage & { audioContent?: unknown };
    // 回合内已分配 id 的消息沿用原 id：token / 投影缓存都按 id 记账，重放后还能命中。
    // 前提同 appendTurnMessage：id 唯一，一个消息对象只落盘一次。
    const id = (message as { id?: string }).id ?? createUlid();
    return { ...rest, id, createdAt: getShanghaiISOString() } as StoredChatMessage;
}

function toChatMessage(message: StoredChatMessage): ChatMessage {
    const { id, createdAt, contextPolicy: _contextPolicy, ...chatMessage } = message;
    return chatMessage as ChatMessage;
}

/** 剥掉内部消息 id（只服务本地缓存，不属于上游协议）；构造请求体前必须过一遍。 */
export function stripInternalPromptIds(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(message => {
        if (!("id" in message)) return message;
        const { id: _id, ...rest } = message as ChatMessage & { id?: string };
        return rest as ChatMessage;
    });
}

function toPromptMessage(message: StoredChatMessage, withIds: boolean): ChatMessage {
    // id 是内部记账字段（token 缓存按它命中），不属于上游协议；请求序列化前由
    // turn-request 的 stripInternalPromptIds 统一剥离。
    const chatMessage = toChatMessage(message);
    if (withIds) (chatMessage as ChatMessage & { id?: string }).id = message.id;
    if (message.role !== 'tool') return chatMessage;

    const toolChatMessage = chatMessage as Extract<ChatMessage, { role: 'tool' }>;
    const projected = projectToolMessageForPrompt({
        ...toolChatMessage,
        contextPolicy: message.contextPolicy,
    }) as Extract<ChatMessage, { role: 'tool' }>;
    // contextPolicy 必须跟着消息一起交出去：投影只允许发生在构造请求的那一处
    // （chat-orchestrator 的 projectChatMessagesForPrompt）。在这里把策略提前剥掉，同一条消息就会
    // 『本轮全文发出、下一轮被二次投影截取』—— 前缀断裂，上游会话白白重建。
    return message.contextPolicy ? { ...projected, contextPolicy: message.contextPolicy } : projected;
}

/** 将内部回合展开为兼容 OpenAI 的扁平消息列表。 */
export function flattenTurns(turns: ConversationTurn[]): ChatMessage[] {
    return turns.flatMap((turn) => turn.messages.map(toChatMessage));
}

/** 获取完整历史，供每日总结等不受上下文窗口影响的消费者使用。 */
export function getSessionHistory(session: Pick<Session, 'turns'>): ChatMessage[] {
    return flattenTurns(session.turns);
}

/** 获取当前上下文窗口：系统消息与总结消息分开，总结消息使用 user 消息作为代际前缀注入。 */
export function getSessionContextHistory(
    session: Pick<Session, 'turns' | 'compactedContext' | 'compactedThroughTurnId'> & Partial<Pick<Session, 'compactedKeepFromMessageId' | 'contextEpochId'>>,
    options: { skipToolCallIds?: ReadonlySet<string> } = {},
): ChatMessage[] {
    return buildContextHistory(session, options, false);
}

/**
 * 同 getSessionContextHistory，但保留消息 id：token 记账与工具结果投影都按 id 缓存，
 * 长会话才能只算新增内容。id 是内部字段，构造请求体前由 turn-request 统一剥掉。
 */
export function getSessionContextHistoryWithIds(
    session: Pick<Session, 'turns' | 'compactedContext' | 'compactedThroughTurnId'> & Partial<Pick<Session, 'compactedKeepFromMessageId' | 'contextEpochId'>>,
    options: { skipToolCallIds?: ReadonlySet<string> } = {},
): ChatMessage[] {
    return buildContextHistory(session, options, true);
}

/** 上下文窗口构建：withIds 决定是否带内部 id（带 id 才能命中 token / 投影缓存）。 */
function buildContextHistory(
    session: Pick<Session, 'turns' | 'compactedContext' | 'compactedThroughTurnId'> & Partial<Pick<Session, 'compactedKeepFromMessageId' | 'contextEpochId'>>,
    options: { skipToolCallIds?: ReadonlySet<string> },
    withIds: boolean,
): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // 1. 压缩摘要作为首条 user 消息注入（配合一条 assistant 确认，形成固定不变的代际前缀）
    if (session.compactedContext) {
        const epochAttr = session.contextEpochId ? ` epoch="${session.contextEpochId}"` : '';
        messages.push({
            role: 'user',
            content: `<conversation_summary${epochAttr}>\n${session.compactedContext}\n</conversation_summary>`,
        });
        messages.push({
            role: 'assistant',
            content: '已确认上述历史上下文与关键进展，后续对话将基于此事实基础继续。',
        });
    }

    // 2. 拼接保留段（严格只读追加，保障前缀缓存）
    messages.push(...collectRetainedMessages(session, withIds));

    return repairToolCallPairing(messages, options.skipToolCallIds);
}

/**
 * 保留段消息：优先用消息级边界 compactedKeepFromMessageId（可能在 turn 中间开始），
 * 否则退回 turn 级边界 compactedThroughTurnId 之后的回合；两者都没有就是全部回合。
 * 边界消息找不到（会话被截断/边界陈旧）时返回空——宁可少发，也不把已摘要的历史再发一遍。
 */
function collectRetainedMessages(
    session: Pick<Session, 'turns' | 'compactedKeepFromMessageId' | 'compactedThroughTurnId'>,
    withIds: boolean,
): ChatMessage[] {
    const turns = session.turns ?? [];
    const keepFrom = session.compactedKeepFromMessageId;

    let startIndex = 0;
    if (!keepFrom && session.compactedThroughTurnId) {
        startIndex = turns.findIndex((turn) => turn.id === session.compactedThroughTurnId) + 1;
    }

    const messages: ChatMessage[] = [];
    let started = !keepFrom;
    for (const [index, turn] of turns.entries()) {
        if (index < startIndex) continue;
        for (const message of turn.messages) {
            if (!started) {
                if (message.id !== keepFrom) continue;
                started = true;
            }
            messages.push(toPromptMessage(message, withIds));
        }
    }
    return messages;
}

function updateContextEpoch(session: Session, reason: 'hard_trim' | 'compact', compactInstruction?: string): void {
    const timestamp = getShanghaiISOString();
    session.contextEpochId = createUlid();
    session.contextState = {
        startedAt: timestamp,
        reason,
        sourceUserTurnCount: session.totalUserTurnCount,
        retainedUserTurnCount: session.turns.length,
        ...(reason === 'compact' ? { compactedAt: timestamp, compactInstruction } : {}),
    };
}

function ensureTurns(session: Session): void {
    session.turns ??= [];
}

/** 物化一个回合追加到会话历史中。不再执行硬裁剪，统一由基于 Token 的自动压缩管理。 */
function pushTurn(session: Session, turnMessages: ChatMessage[], status: ConversationTurn['status']): boolean {
    session.turns.push({ id: createUlid(), messages: turnMessages.map(createStoredMessage), status });
    return false;
}

/**
 * 追加一个被中断/失败的回合：用户消息与已产生的工具段全量保留，进 LLM 上下文，
 * 保证调用中断或失败时已有消息仍进入后续上下文。
 */
export function appendInterruptedTurn(
    session: Session,
    userMessages: StoredUserInput[],
    partialMessages: ChatMessage[],
    status: 'interrupted' | 'failed',
): boolean {
    ensureTurns(session);
    const turnMessages: ChatMessage[] = [
        ...userMessages.map(userInputMessage),
        ...partialMessages,
    ];
    session.totalUserTurnCount += userMessages.length;
    return pushTurn(session, turnMessages, status);
}

/** 追加一个完整回合；原始消息永不因上下文裁剪而删除。 */
export function appendCompletedTurn(
    session: Session,
    messages: StoredUserInput[],
    responseMessages: ChatMessage[],
    shouldPersistToolHistory: boolean,
): boolean {
    ensureTurns(session);
    const turnMessages: ChatMessage[] = [];
    for (const message of messages) {
        turnMessages.push(userInputMessage(message));
    }
    if (shouldPersistToolHistory) {
        turnMessages.push(...responseMessages);
    } else {
        const finalMessage = responseMessages.at(-1);
        if (finalMessage?.role === 'assistant') turnMessages.push(finalMessage);
    }
    session.totalUserTurnCount += messages.length;
    return pushTurn(session, turnMessages, 'completed');
}

/**
 * 使用摘要压缩上下文，可指定压缩截止的 turn id：截止点之前的回合不再进上下文，
 * 保留段（keepFromMessageId 起，或 turn 级边界之后）仍照常拼接。都不传则压缩到当前最后一条消息。
 */
export function replaceWithCompactedContext(
    session: Session,
    compactedContext: string,
    options?: { instruction?: string; compactedThroughTurnId?: string; keepFromMessageId?: string } | string,
): void {
    ensureTurns(session);
    const instruction = typeof options === 'string' ? options : options?.instruction;
    const compactedThroughTurnId = typeof options === 'object' && options?.compactedThroughTurnId
        ? options.compactedThroughTurnId
        : session.turns.at(-1)?.id;
    const keepFromMessageId = typeof options === 'object' ? options.keepFromMessageId : undefined;

    session.compactedContext = compactedContext;
    session.compactedThroughTurnId = compactedThroughTurnId;
    session.compactedKeepFromMessageId = keepFromMessageId;
    session.compactCount += 1;
    session.lastPromptTokens = undefined;
    updateContextEpoch(session, 'compact', instruction);
}

/** 添加不经过聊天编排的完整回合，例如图片分析。 */
export function appendStandaloneTurn(session: Session, messages: ChatMessage[]): void {
    session.turns.push({ id: createUlid(), messages: messages.map(createStoredMessage), status: 'completed' });
    session.totalUserTurnCount += messages.filter((message) => message.role === 'user').length;
}
