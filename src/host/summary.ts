/**
 * 会话摘要与实例用量聚合：纯函数，不依赖 agent 实例状态。
 */

import { isInjectedContext, type AgentEvent, type AgentEventType } from "../events/agent-events.js";
import type { EventLog, ScannedEvent } from "../events/event-log.js";
import type { UsageInfo } from "../types/chat.js";
import type { InstanceNetworkStats, SessionSummary } from "./session-host-types.js";

/** 会话摘要 + 真实创建时间（首条事件 ts；`Session.createdAt` 是重放时刻，不能代表创建时间）。 */
export interface SessionDigest {
    summary: SessionSummary;
    createdAt?: string;
}

/**
 * 每个事件类型「摘要会读它 payload 的哪些字段」；空数组表示只用到 seq/ts/type
 * （更新时间靠 ts，归档态靠 type）。
 *
 * 写成 Record<AgentEventType, …> 是为了编译期穷举：`AgentEventType` 新增成员时这里缺键
 * 会直接报类型错误，逼着作者回答「新类型影响摘要吗、要读哪些字段」。
 * SUMMARY_DECODE_TYPES 由它派生，不会出现两份清单漂移；若某类型这里声明为空却仍被
 * summarizeEvents 读 payload，`summary.test.ts` 的「越界访问即抛错」守卫会失败。
 */
export const SUMMARY_PAYLOAD_FIELDS: Record<AgentEventType, readonly string[]> = {
    // updatedAt 判定会读 injected / messages
    standalone_turn: ["injected", "messages"],
    session_created: ["cwd", "origin"],
    session_cwd_changed: ["cwd"],
    session_renamed: ["title"],
    model_selected: ["(整个对象)"],
    user_message: ["text"],
    turn_commit: ["interrupted"],
    peer_message: [],
    peer_result: [],
    turn_message: [],
    turn_stream_delta: [],
    steer_update: [],
    turn_segment_start: [],
    context_compacted: [],
    assistant_history_repaired: [],
    usage_recorded: [],
    session_archived: [],
    session_unarchived: [],
    session_cleared: [],
    lazy_mcp_changed: [],
};

/** 摘要需要完整 payload 的事件类型：轻量扫描只解码这些行。 */
export const SUMMARY_DECODE_TYPES: ReadonlySet<AgentEventType> = new Set(
    (Object.entries(SUMMARY_PAYLOAD_FIELDS) as Array<[AgentEventType, readonly string[]]>)
        .filter(([, fields]) => fields.length > 0)
        .map(([type]) => type),
);

/**
 * 带缓存的会话摘要读取：摘要只是事件流的纯函数，磁盘 seq 没变就没有重算的必要。
 *
 * 动因是全量解析太贵：真实数据 154 个会话、222 MB 日志，逐份解析约 830 ms，
 * 而逐个会话只读文件尾部取 seq 约 54 ms。`session list`、`/sessions`、
 * `GET /api/sessions` 都走这条路径，缓存把它们的耗时降到与 seq 探测同量级。
 *
 * 缓存键就是最后 seq：日志被截断/删除后 seq 变化，自动重算，不会给出过期摘要。
 *
 * 只读持久化事件（persistedOnly）：pending 流片段（`turn_stream_delta`）不占 seq，
 * 若参与摘要，摘要就会依赖「缓存之外又变了什么」，而缓存键看不见这类变化 —— 只能二选一。
 * 摘要统一按持久化事实派生：与 HTTP/SSE 对外承诺的口径一致，也让缓存命中与未命中同源。
 *
 * 冷路径走 `EventLog.scan`（只解析行首 + 少数类型的 payload）；扫描拿不准就回退全量读取，
 * 两条路径的摘要必须完全一致（有等价性测试）。
 */
export class SessionDigestReader {
    private readonly cache = new Map<string, { seq: number; digest: SessionDigest | null }>();

    constructor(private readonly eventLog: EventLog) {}

    /** 读会话摘要；没有事件（或日志不存在）时返回 null。 */
    async read(sessionId: string): Promise<SessionDigest | null> {
        const seq = await this.eventLog.lastSeq(sessionId, { forceRefresh: true });
        const cached = this.cache.get(sessionId);
        if (cached && cached.seq === seq) return cached.digest;

        const digest = await this.buildDigest(sessionId);
        this.cache.set(sessionId, { seq, digest });
        return digest;
    }

    private async buildDigest(sessionId: string): Promise<SessionDigest | null> {
        const scanned = await this.eventLog.scan(sessionId, SUMMARY_DECODE_TYPES);
        // 行首形状不认识：回退全量读取，宁可慢也不能给出与事实不符的摘要
        const events = scanned === null
            ? await this.eventLog.read(sessionId, 1, undefined, { persistedOnly: true })
            : asSummaryEvents(sessionId, scanned);
        if (events.length === 0) return null;
        return {
            summary: summarizeEvents(sessionId, events),
            ...(events[0] ? { createdAt: events[0].ts } : {}),
        };
    }

    /** 丢弃某会话的缓存（日志在外部被删除时调用）。 */
    clear(sessionId: string): void {
        this.cache.delete(sessionId);
    }
}

/**
 * 轻量扫描结果还原成摘要输入：未解码的类型补空 payload。
 * 补空之所以安全，是 SUMMARY_DECODE_TYPES 已覆盖 summarizeEvents 读 payload 的全部类型。
 */
function asSummaryEvents(sessionId: string, records: ScannedEvent[]): AgentEvent[] {
    return records.map(record => ({
        seq: record.seq,
        ts: record.ts,
        sessionId,
        type: record.type,
        payload: record.payload ?? {},
    }) as AgentEvent);
}

/** 由事件流派生会话摘要（标题、消息数、归档态、更新时间）。 */
export function summarizeEvents(sessionId: string, events: AgentEvent[]): SessionSummary {
    let messageCount = 0;
    let lastUserMessage: string | undefined;
    let firstUserMessage: string | undefined;
    let renamedTitle: string | undefined;
    let updatedAt: string | undefined;
    let archived = false;
    let modelSelection: SessionSummary["modelSelection"];
    let origin: SessionSummary["origin"];
    let cwd: string | undefined;

    for (const event of events) {
        // 更新时间只认用户/模型活动：群聊状态这类自动注入每隔几分钟落一条，
        // 若计入就会把闲置会话顶到 tab 条最前，启动默认选中的会话也跟着跑偏。
        // 只改下发口径的事件（lazy MCP 启用集）不算活动：切换一下就把闲置会话顶到最前没有意义。
        if (!isInjectedContext(event) && event.type !== "lazy_mcp_changed") updatedAt = event.ts;
        // 归档与取消归档成对出现，末态决定会话是否归档。
        if (event.type === "session_archived") archived = true;
        else if (event.type === "session_unarchived") archived = false;
        if (event.type === "turn_commit" && !event.payload.interrupted) messageCount += 1;
        if (event.type === "user_message") {
            lastUserMessage = event.payload.text.slice(0, 120);
            firstUserMessage ??= event.payload.text.slice(0, 200);
        }
        if (event.type === "session_renamed") renamedTitle = event.payload.title;
        if (event.type === "model_selected") modelSelection = event.payload;
        if (event.type === "session_created") cwd = event.payload.cwd;
        if (event.type === "session_created" && event.payload.origin) origin = event.payload.origin;
        if (event.type === "session_cwd_changed") cwd = event.payload.cwd;
    }

    return {
        sessionId,
        ...(origin ? { origin } : {}),
        ...(cwd ? { cwd } : {}),
        updatedAt,
        messageCount,
        lastUserMessage,
        title: renamedTitle ?? firstUserMessage,
        archived,
        ...(modelSelection ? { modelSelection } : {}),
    };
}

/** 聚合各会话的真实网络用量；未发起过请求的会话不计入。 */
export function aggregateInstanceUsage(usageBySession: Iterable<UsageInfo>): InstanceNetworkStats {
    let sessionCount = 0;
    let requestCount = 0;
    let promptTokens = 0;
    let cacheHitTokens = 0;
    let cacheMissTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;
    for (const usage of usageBySession) {
        if (!usage.requestCount) continue;
        sessionCount += 1;
        requestCount += usage.requestCount;
        promptTokens += usage.promptTokens;
        cacheHitTokens += usage.cacheHitTokens ?? 0;
        cacheMissTokens += usage.cacheMissTokens ?? 0;
        completionTokens += usage.completionTokens;
        reasoningTokens += usage.reasoningTokens ?? 0;
    }
    return {
        sessionCount,
        requestCount,
        promptTokens,
        completionTokens,
        reasoningTokens,
        cacheHitTokens,
        cacheMissTokens,
    };
}
