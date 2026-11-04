/**
 * 会话间入站投递的状态机：排队（FIFO、有界）、msgId 幂等、过期、取消、终态结果缓存。
 *
 * 这里只做「状态与决策」，不碰事件日志、控制通道、会话锁与回合执行：
 * 宿主拿到决策后自己落盘、回传结果、抢互斥、跑回合。因此本模块可以脱离宿主直接单测，
 * 竞态/幂等/过期的边界不必靠起真宿主 + mock 上游来验证。
 *
 * 键一律是 `sessionId:msgId`（msgId 由发送方生成，只在目标会话内唯一）。
 */

import type { PeerMessage, PeerQueuedEntry, PeerResult } from "../control/protocol.js";

/** 每会话排队投递上限：满了回 queue_full，不静默丢消息。 */
export const MAX_QUEUED_PEER_MESSAGES = 8;
/** msgId 幂等窗口：近期受理/排队过的消息不再重复执行。 */
const MAX_SEEN_PEER_MESSAGES = 512;
/** 已完成结果缓存上限：只服务重推，不追全历史。 */
const MAX_COMPLETED_PEER_RESULTS = 64;

/** 排队失败的终态原因：到期未执行、会话不再可执行（释放/关闭/归档前清空）。 */
export type PeerDropReason = "expired" | "cancelled";

/** 幂等状态：受理占位 → 排队 → 执行中(accepted) → 终态(done)。 */
type PeerSeenStatus = "accepted" | "queued" | "done";

/** 排队中的一条消息；`queuedAt` 是入队时刻（会话时区 ISO），只用于观测。 */
export interface QueuedPeerMessage {
    message: PeerMessage;
    queuedAt: string;
}

/**
 * 受理决策：
 * - new：首次见到，占位已写入，调用方可以开始执行或入队；
 * - queued：同 msgId 仍在队列里，返回原位次（调用方按"已排队"应答，不重复执行）；
 * - accepted：同 msgId 已被受理，正在执行或刚执行完但结果已淘汰；
 * - replay：已完成且结果还在缓存里，调用方应把该结果重推一份。
 */
export type PeerAcceptDecision =
    | { kind: "new" }
    | { kind: "queued"; position: number }
    | { kind: "accepted" }
    | { kind: "replay"; result: PeerResult };

export interface PeerInboxOptions {
    maxQueued?: number;
    /** 幂等窗口上限（测试用小值验证淘汰）。 */
    maxSeen?: number;
    /** 结果缓存上限（测试用小值验证淘汰）。 */
    maxCompletedResults?: number;
    /** 时钟；过期判定与测试注入用。 */
    now?: () => number;
}

/** 排队消息的终态失败结果：发送方要拿到明确终态，而不是一直等。 */
function dropResult(message: PeerMessage, reason: PeerDropReason): PeerResult {
    return {
        msgId: message.id,
        ok: false,
        text: "",
        stopReason: reason,
        error: reason === "expired" ? "排队超时未执行" : "排队消息已取消",
    };
}

export class PeerInbox {
    private readonly queues = new Map<string, QueuedPeerMessage[]>();
    private readonly seen = new Map<string, PeerSeenStatus>();
    /** 只缓存 expectResult 的终态：没有等待方的结果没人会来问。 */
    private readonly results = new Map<string, PeerResult>();
    private readonly maxQueued: number;
    private readonly maxSeen: number;
    private readonly maxCompletedResults: number;
    private readonly now: () => number;

    constructor(options: PeerInboxOptions = {}) {
        this.maxQueued = options.maxQueued ?? MAX_QUEUED_PEER_MESSAGES;
        this.maxSeen = options.maxSeen ?? MAX_SEEN_PEER_MESSAGES;
        this.maxCompletedResults = options.maxCompletedResults ?? MAX_COMPLETED_PEER_RESULTS;
        this.now = options.now ?? Date.now;
    }

    /** 幂等判定 + 同步占位：同一 msgId 的并发重投只有第一个拿到 new。 */
    begin(message: PeerMessage): PeerAcceptDecision {
        const key = this.keyOf(message);
        const status = this.seen.get(key);

        if (status === "queued") {
            const position = this.positionOf(message.to, message.id);
            // 仍在队列里就回原位次；已出队说明正在执行（或刚执行完）
            return position !== undefined ? { kind: "queued", position } : { kind: "accepted" };
        }
        if (status === "accepted") return { kind: "accepted" };
        if (status === "done") {
            const result = this.results.get(key);
            if (result) return { kind: "replay", result };
            // 结果缓存已淘汰：宁可重执一次，也不能返回一个永远等不到结果的 accepted
            this.seen.delete(key);
        }

        this.remember(key, "accepted");
        return { kind: "new" };
    }

    /** 入队；队列已满返回 full（占位一并回滚，让重投仍按新消息处理）。 */
    enqueue(message: PeerMessage, queuedAt: string): { position: number } | "full" {
        const sessionId = message.to;
        const queue = this.queues.get(sessionId) ?? [];
        if (queue.length >= this.maxQueued) {
            // 满队列也要回滚占位：否则同 msgId 重投会被当成"已受理"却永不执行
            this.seen.delete(this.keyOf(message));
            return "full";
        }

        queue.push({ message, queuedAt });
        this.queues.set(sessionId, queue);
        this.remember(this.keyOf(message), "queued");
        return { position: queue.length };
    }

    /** 队首（不移动）：宿主据此决定能否执行。 */
    head(sessionId: string): QueuedPeerMessage | undefined {
        return this.queues.get(sessionId)?.[0];
    }

    /** 出队：宿主已抢到会话互斥，消息即将执行。 */
    shift(sessionId: string): QueuedPeerMessage | undefined {
        const queue = this.queues.get(sessionId);
        if (!queue || queue.length === 0) return undefined;
        const entry = queue.shift();
        this.pruneQueue(sessionId, queue);
        return entry;
    }

    /** 受理/入队失败时回滚：移出队列（若已入队）并清掉幂等占位，重投按新消息处理。 */
    rollback(message: PeerMessage): void {
        const queue = this.queues.get(message.to);
        if (queue) {
            const index = queue.findIndex(entry => entry.message.id === message.id);
            if (index !== -1) {
                queue.splice(index, 1);
                this.pruneQueue(message.to, queue);
            }
        }
        this.seen.delete(this.keyOf(message));
    }

    /** 出队并提交执行：把幂等状态从 queued 改为执行中。 */
    markRunning(message: PeerMessage): void {
        this.remember(this.keyOf(message), "accepted");
    }

    /** 是否已过期；没有 expiresAt 或时间戳非法时永不过期。 */
    isExpired(message: PeerMessage, now: number = this.now()): boolean {
        if (!message.expiresAt) return false;
        const deadline = Date.parse(message.expiresAt);
        return Number.isFinite(deadline) && deadline <= now;
    }

    /**
     * 出队并生成终态失败结果（过期/取消），同时记入幂等窗口。
     * 不在队列里也照样出结果：调用方可能已经 shift/takeAll 过，终态仍必须回传给发送方。
     */
    drop(message: PeerMessage, reason: PeerDropReason): PeerResult {
        this.removeFromQueue(message.to, message.id);
        const result = dropResult(message, reason);
        this.rememberResult(message, result);
        return result;
    }

    /** 取走该会话全部排队消息（会话释放/宿主关闭时按 cancelled 收尾）。 */
    takeAll(sessionId: string): QueuedPeerMessage[] {
        const queue = this.queues.get(sessionId) ?? [];
        this.queues.delete(sessionId);
        return queue;
    }

    /** 撤销排队中的消息；已出队在执行时返回 running。 */
    cancel(
        sessionId: string,
        msgId: string,
    ): { ok: true; message: PeerMessage } | { ok: false; reason: "not_found" | "running" } {
        const queue = this.queues.get(sessionId);
        const index = queue?.findIndex(entry => entry.message.id === msgId) ?? -1;
        if (!queue || index === -1) {
            return this.seen.get(`${sessionId}:${msgId}`) === "accepted"
                ? { ok: false, reason: "running" }
                : { ok: false, reason: "not_found" };
        }

        const [entry] = queue.splice(index, 1);
        this.pruneQueue(sessionId, queue);
        return entry ? { ok: true, message: entry.message } : { ok: false, reason: "not_found" };
    }

    /** 记终态：同 msgId 重投时重推结果而不是重复执行；只有 expectResult 的才留结果。 */
    rememberResult(message: PeerMessage, result: PeerResult): void {
        const key = this.keyOf(message);
        this.remember(key, "done");
        if (!message.expectResult) {
            this.results.delete(key);
            return;
        }
        this.results.delete(key);
        this.results.set(key, result);
        while (this.results.size > this.maxCompletedResults) {
            const oldest = this.results.keys().next().value;
            if (oldest === undefined) break;
            this.results.delete(oldest);
        }
    }

    /** 观测快照（`/queue` 命令与面板用）。 */
    snapshot(sessionId: string): PeerQueuedEntry[] {
        return (this.queues.get(sessionId) ?? []).map((entry, index) => ({
            msgId: entry.message.id,
            from: entry.message.from,
            queuedAt: entry.queuedAt,
            ...(entry.message.expiresAt ? { expiresAt: entry.message.expiresAt } : {}),
            position: index + 1,
        }));
    }

    /** 清掉该会话的终态结果缓存，避免长进程里按会话累积。 */
    forgetResults(sessionId: string): void {
        const prefix = `${sessionId}:`;
        for (const key of [...this.results.keys()]) {
            if (key.startsWith(prefix)) this.results.delete(key);
        }
    }

    /** 仍有排队消息的会话 id（宿主退出时逐会话收尾）。 */
    sessionIds(): string[] {
        return [...this.queues.keys()];
    }

    /** 清空全部状态（宿主退出）。 */
    clear(): void {
        this.queues.clear();
        this.seen.clear();
        this.results.clear();
    }

    private keyOf(message: PeerMessage): string {
        return `${message.to}:${message.id}`;
    }

    private positionOf(sessionId: string, msgId: string): number | undefined {
        const index = this.queues.get(sessionId)?.findIndex(entry => entry.message.id === msgId) ?? -1;
        return index === -1 ? undefined : index + 1;
    }

    private removeFromQueue(sessionId: string, msgId: string): void {
        const queue = this.queues.get(sessionId);
        if (!queue) return;
        const index = queue.findIndex(entry => entry.message.id === msgId);
        if (index === -1) return;
        queue.splice(index, 1);
        this.pruneQueue(sessionId, queue);
    }

    /** 空队列不留键：会话多了也只在有排队时占内存。 */
    private pruneQueue(sessionId: string, queue: QueuedPeerMessage[]): void {
        if (queue.length === 0) this.queues.delete(sessionId);
    }

    /** 记幂等状态；Map 保序，超窗口时淘汰最早一条。 */
    private remember(key: string, status: PeerSeenStatus): void {
        this.seen.delete(key);
        this.seen.set(key, status);
        while (this.seen.size > this.maxSeen) {
            const oldest = this.seen.keys().next().value;
            if (oldest === undefined) break;
            this.seen.delete(oldest);
        }
    }
}
