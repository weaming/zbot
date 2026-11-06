/**
 * 会话间控制通道：归属协商 + 消息投递 + 结果回传。
 *
 * 这是 TUI/agent 与 `src/control` 协议层之间唯一的编排点：
 * - 会话归属：认领 = 本进程 bind 其 socket；被占用时向持有者**协商**释放（不夺权）；
 * - 消息投递：目标在本进程直接走内存，否则走 socket；
 * - 结果回传：`expect_result` 的消息在目标回合结束后自动回来，进请求者的结果队列，
 *   由下一次 HTTP 请求附加，不额外驱动一轮；`waitForResult` 是可选的前台等待，
 *   命中时直接兑现给调用方（不入队）。
 *
 * 不支持的场景（有意为之）：目标不可达 / 目标忙 / 目标进程重启 —— 一律报错，不排队、不补投。
 */

import { PeerClientPool, PeerConnectError, requestOnce } from "./client.js";
import { OutboxLedger, type WaitOutcome } from "./outbox-ledger.js";
import { getSocketPath } from "./paths.js";
import {
    createFrameId,
    createPeerMessage,
    isCancelledStopReason,
    type PeerAcceptOutcome,
    type PeerMessage,
    type PeerQueuedEntry,
    type PeerResult,
} from "./protocol.js";
import { listOwnership, probeOwnership, type PeerOwnership } from "./registry.js";
import { PeerServer } from "./server.js";
import type { SessionOrigin } from "../types/session.js";

/** `session_send` 的失败原因：只有 unreachable 表示目标不在线，busy 由调用方决定是否重试。 */
export type PeerSendError = "unreachable" | "busy" | "queue_full" | "internal";

export class PeerSendFailure extends Error {
    constructor(
        readonly reason: PeerSendError,
        message: string,
    ) {
        super(message);
        this.name = "PeerSendFailure";
    }
}

/** 投递结果：queued 表示目标忙、消息已排队，等待空闲后执行。 */
export interface PeerSendOutcome {
    message: PeerMessage;
    queued: boolean;
    position?: number;
}

export type ClaimResult =
    | { ok: true }
    /** 持有者忙，拒绝释放。 */
    | { ok: false; reason: "busy"; pid?: number }
    /** 持有者无应答（进程卡死/通道异常），无法确认状态。 */
    | { ok: false; reason: "unresponsive" }
    /** 协商已成功，但第二次绑定时被别的实例抢先——竞争失败，不是对端无应答。 */
    | { ok: false; reason: "raced"; winnerPid?: number }
    | { ok: false; reason: "error"; message: string };

export type SpawnResult = { ok: true; sessionId: string } | { ok: false; error: string };

/** 前台等待的结果：除 ok 外都只解除等待（等待项保留），none 表示这条消息已不在等待表里。 */
export type { WaitOutcome };

/** 通道层需要宿主（agent/UI）提供的会话能力。 */
export interface SessionControlHost {
    /** 会话展示名（who 握手用）。 */
    title(sessionId: string): string | undefined;
    /** 是否正在跑 turn。 */
    isBusy(sessionId: string): boolean;
    /** 新建一个空会话（只进内存，不落盘）；cwd 缺省用宿主默认目录。 */
    createSession(
        cwd?: string,
        init?: { origin?: SessionOrigin; title?: string },
    ): Promise<{ sessionId: string }>;
    /** 会话绑定的工作目录（派生新会话时继承父会话）。 */
    sessionCwd(sessionId: string): Promise<string>;
    /** 子会话已建立并认领：宿主把它加进会话列表 / 固化标题。 */
    onSessionSpawned(sessionId: string, title?: string): void;
    /** 归档并释放本实例派生的子会话；归档保留历史，不执行删除。 */
    archiveSpawnedSession?(sessionId: string, automatic: boolean): Promise<void>;
    /** 中止本实例管理的子会话；close=true 时等待当前 turn 收尾后归档并释放。 */
    cancelSpawnedSession?(sessionId: string, close: boolean): Promise<boolean>;
    /**
     * 原子受理一条入站消息：accepted 立即执行，queued 入队（忙时排队投递），
     * full/busy 拒绝且不落任何事实。实现方负责落盘与启动回合。
     */
    accept(message: PeerMessage): Promise<PeerAcceptOutcome> | PeerAcceptOutcome;
    /** 撤销排队中的消息（只对仍在队列里的生效）。 */
    cancelQueued?(sessionId: string, msgId: string): { ok: true } | { ok: false; reason: "not_found" | "running" };
    /** 指定会话的排队快照（who / queue_state 观测用）。 */
    queueState?(sessionId: string): PeerQueuedEntry[];
    /**
     * 改会话标题并返回真正生效的标题。标题是元数据：回合执行中也允许改，
     * 由持有者在本进程内落盘，避免命令行跨进程写同一份事件日志。
     */
    rename?(sessionId: string, title: string): Promise<string> | string;
    /** 出站消息已成功投递（落时间线用）。 */
    onOutbound(from: string, message: PeerMessage): void;
    /** 结果到达请求者会话：已进结果队列，宿主负责落时间线与提示。 */
    onResult(requester: string, message: PeerMessage, result: PeerResult, options?: { late?: boolean }): void;
    /** 结果确定丢失（目标进程不可达或等待超时）。 */
    onLost(requester: string, msgIds: string[], target: string): void;
    /** 远端协商释放成功：宿主把会话从 tabs / activeSessions 摘掉。 */
    onReleased(sessionId: string): void;
}

export interface SessionControlOptions {
    /** `expect_result` 的等待上限，超时即判定结果丢失。 */
    resultTimeoutMs?: number;
    /** 归属探测超时。 */
    probeTimeoutMs?: number;
    /** 协商释放的应答超时；持有者无响应即放弃（不夺权）。 */
    negotiateTimeoutMs?: number;
    /** 单个会话最多保留多少条未消费结果。 */
    maxResultsPerSession?: number;
}

/** 默认等待结果的时长。 */
const DEFAULT_RESULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_NEGOTIATE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_RESULTS_PER_SESSION = 50;
/** 结果暂存上限：对端一直不来取时避免内存无限增长。 */
const MAX_RESULT_STASH = 200;

/** 本实例同时管理的子会话上限：避免模型无限打开子会话把进程压垮。 */
export const MAX_SPAWNED_SESSIONS = 8;

export class SessionControl {
    private readonly servers = new Map<string, PeerServer>();
    /** 本实例派生或唤醒后接管的子会话；释放后移除。 */
    private readonly spawned = new Set<string>();
    /** 用户选择 auto_close 的子会话：首个期望结果的回合完成后归档。 */
    private readonly autoCloseSpawned = new Set<string>();
    /** 正在取消后关闭的子会话：拒绝新投递，避免归档与新 turn 竞态。 */
    private readonly closingSpawned = new Set<string>();
    /** 走本进程内存投递的入站消息 id：完成后直接回给本地请求者，不走 socket。 */
    private readonly localInbound = new Set<string>();
    /** 出站消息台账：一条消息一个状态，替代原先散落的三个容器。 */
    private readonly outbox: OutboxLedger;
    private readonly pool: PeerClientPool;
    private readonly resultTimeoutMs: number;
    private readonly probeTimeoutMs: number | undefined;
    private readonly negotiateTimeoutMs: number;
    private readonly maxResultsPerSession: number;

    constructor(
        private readonly host: SessionControlHost,
        options: SessionControlOptions = {},
    ) {
        this.resultTimeoutMs = options.resultTimeoutMs ?? DEFAULT_RESULT_TIMEOUT_MS;
        this.probeTimeoutMs = options.probeTimeoutMs;
        this.negotiateTimeoutMs = options.negotiateTimeoutMs ?? DEFAULT_NEGOTIATE_TIMEOUT_MS;
        this.maxResultsPerSession = options.maxResultsPerSession ?? DEFAULT_MAX_RESULTS_PER_SESSION;
        this.outbox = new OutboxLedger({
            maxQueuedPerSession: this.maxResultsPerSession,
            maxStashed: MAX_RESULT_STASH,
            maxExpired: MAX_RESULT_STASH,
        });
        this.pool = new PeerClientPool({
            onResult: (target, result) => this.handleRemoteResult(target, result),
            onLost: (target, msgIds) => this.handleRemoteLost(target, msgIds),
        });
    }

    // ── 归属 ────────────────────────────────────────────────────

    isClaimed(sessionId: string): boolean {
        return this.servers.has(sessionId);
    }

    get claimedSessionIds(): string[] {
        return [...this.servers.keys()];
    }

    /** 认领会话：本进程 bind 其 socket；被其他实例占用时协商释放，绝不夺权。 */
    /**
     * 认领会话。
     * noNegotiate：被其他实例持有时直接失败，不发起协商式转移 ——
     * 编程化入口（HTTP）不该把会话从正在运行的 TUI 里抢走。
     */
    async claim(sessionId: string, options: { noNegotiate?: boolean } = {}): Promise<ClaimResult> {
        if (this.servers.has(sessionId)) return { ok: true };

        const server = new PeerServer(
            sessionId,
            {
                title: () => this.host.title(sessionId),
                isBusy: () => this.closingSpawned.has(sessionId) || this.host.isBusy(sessionId),
                accept: (message) => this.closingSpawned.has(sessionId)
                    ? { status: "busy" as const }
                    : this.host.accept(message),
                cancelQueued: (msgId) => this.host.cancelQueued?.(sessionId, msgId) ?? { ok: false, reason: "not_found" },
                queueState: () => this.host.queueState?.(sessionId) ?? [],
                ...(this.host.rename
                    ? { rename: (title: string) => this.host.rename!(sessionId, title) }
                    : {}),
                release: () => {
                    if (this.host.isBusy(sessionId)) return false;
                    this.servers.delete(sessionId);
                    this.spawned.delete(sessionId);
                    this.autoCloseSpawned.delete(sessionId);
                    this.closingSpawned.delete(sessionId);
                    this.host.onReleased(sessionId);
                    return true;
                },
                pendingState: (msgIds, options) => options?.keep
                    ? this.outbox.peekStashed(msgIds)
                    : this.outbox.takeStashed(msgIds),
            },
            this.probeTimeoutMs !== undefined ? { probeTimeoutMs: this.probeTimeoutMs } : {},
        );

        const first = await server.bind();
        if (first.ok) {
            this.servers.set(sessionId, server);
            return { ok: true };
        }
        if (first.reason === "error") return { ok: false, reason: "error", message: first.message };

        // 被其他实例持有：协商式转移，持有者忙则放弃
        if (first.pid === process.pid) return { ok: false, reason: "error", message: "会话已被本实例持有" };
        if (options.noNegotiate) {
            return first.pid !== undefined
                ? { ok: false, reason: "busy", pid: first.pid }
                : { ok: false, reason: "unresponsive" };
        }

        const negotiation = await this.requestRelease(sessionId);
        if (!negotiation.ok) return negotiation;

        // 协商成功后重新绑定：此时失败只可能是被别的实例抢先，不能再归因为「无应答」
        const second = await server.bind();
        if (second.ok) {
            this.servers.set(sessionId, server);
            return { ok: true };
        }
        if (second.reason === "error") return { ok: false, reason: "error", message: second.message };
        if (second.pid === process.pid) return { ok: false, reason: "error", message: "会话已被本实例持有" };
        return second.pid !== undefined
            ? { ok: false, reason: "raced", winnerPid: second.pid }
            : { ok: false, reason: "raced" };
    }

    /** 本实例主动放弃会话：关监听、释放 socket 文件、允许其他实例认领。 */
    release(sessionId: string): void {
        this.spawned.delete(sessionId);
        this.autoCloseSpawned.delete(sessionId);
        this.closingSpawned.delete(sessionId);
        const server = this.servers.get(sessionId);
        if (!server) return;

        this.servers.delete(sessionId);
        server.unbind();
    }

    // ── 派生子会话 ──────────────────────────────────────────────

    /** 本实例当前派生、仍持有的子会话数。 */
    get spawnedCount(): number {
        return this.spawned.size;
    }

    isSpawnedSession(sessionId: string): boolean {
        return this.spawned.has(sessionId);
    }

    forgetSpawnedSession(sessionId: string): void {
        this.spawned.delete(sessionId);
        this.autoCloseSpawned.delete(sessionId);
    }

    /**
     * 派生一个子会话并立即认领：只负责建会话，派活由调用方随后 send。
     * 子会话继承父会话的工作目录；数量受 MAX_SPAWNED_SESSIONS 限制。
     */
    async spawnSession(
        parentSessionId: string,
        title?: string,
        options: { autoClose?: boolean } = {},
    ): Promise<SpawnResult> {
        if (this.spawned.size >= MAX_SPAWNED_SESSIONS) {
            return {
                ok: false,
                    error: `本实例管理的子会话已达上限（${MAX_SPAWNED_SESSIONS} 个），请先关闭不再需要的子会话`,
            };
        }

        const cwd = await this.host.sessionCwd(parentSessionId);
        const { sessionId } = await this.host.createSession(cwd, { origin: "tool", title });

        const claimed = await this.claim(sessionId);
        if (!claimed.ok) {
            // 认领失败（极端情况）：把它从宿主会话列表摘掉，不留一个谁都用不了的会话
            this.host.onReleased(sessionId);
            return { ok: false, error: `子会话已建立但认领失败：${describeClaimFailure(claimed)}` };
        }

        this.spawned.add(sessionId);
        if (options.autoClose) this.autoCloseSpawned.add(sessionId);
        this.host.onSessionSpawned(sessionId, title);
        return { ok: true, sessionId };
    }

    /** 归档本实例派生且当前空闲的子会话；不允许工具关闭任意用户会话。 */
    async closeSpawnedSession(
        sessionId: string,
        options: { automatic?: boolean } = {},
    ): Promise<{ ok: true } | { ok: false; error: string }> {
        if (!this.spawned.has(sessionId)) {
            return { ok: false, error: "只能关闭本实例派生或唤醒后接管且仍由本实例持有的子会话" };
        }
        if (this.host.isBusy(sessionId)) {
            return { ok: false, error: `子会话 ${sessionId} 正在执行，完成后再关闭` };
        }
        if (!this.host.archiveSpawnedSession) {
            return { ok: false, error: "当前宿主未提供子会话归档能力" };
        }

        this.closingSpawned.add(sessionId);
        try {
            await this.host.archiveSpawnedSession(sessionId, options.automatic === true);
            this.spawned.delete(sessionId);
            this.autoCloseSpawned.delete(sessionId);
            return { ok: true };
        } catch (error) {
            this.closingSpawned.delete(sessionId);
            return { ok: false, error: `归档子会话失败：${(error as Error)?.message ?? error}` };
        }
    }

    /** 中止本实例管理的子会话；可选等 turn 收尾后归档。 */
    async cancelSpawnedSession(
        sessionId: string,
        options: { close?: boolean } = {},
    ): Promise<{ ok: true; closed: boolean } | { ok: false; error: string }> {
        if (!this.spawned.has(sessionId)) {
            return { ok: false, error: "只能取消本实例派生或唤醒后接管的子会话" };
        }
        if (!this.host.cancelSpawnedSession) {
            return { ok: false, error: "当前宿主未提供子会话取消能力" };
        }

        const shouldClose = options.close === true;
        if (shouldClose) this.closingSpawned.add(sessionId);
        try {
            const cancelled = await this.host.cancelSpawnedSession(sessionId, shouldClose);
            if (!cancelled) {
                if (shouldClose) this.closingSpawned.delete(sessionId);
                return { ok: false, error: `子会话 ${sessionId} 当前没有可取消的运行中任务` };
            }
            if (shouldClose) {
                this.spawned.delete(sessionId);
                this.autoCloseSpawned.delete(sessionId);
            }
            return { ok: true, closed: shouldClose };
        } catch (error) {
            if (shouldClose) this.closingSpawned.delete(sessionId);
            return { ok: false, error: `取消子会话失败：${(error as Error)?.message ?? error}` };
        }
    }

    /** 唤醒已归档会话后，将其纳入本实例可安全关闭的子会话集合。 */
    adoptSpawnedSession(sessionId: string): boolean {
        if (!this.servers.has(sessionId)) return false;
        if (this.spawned.has(sessionId)) return true;
        if (this.spawned.size >= MAX_SPAWNED_SESSIONS) return false;
        this.spawned.add(sessionId);
        return true;
    }

    /** 唤醒事务期间暂时拒绝消息，直到认领与取消归档都完成。 */
    beginSessionWake(sessionId: string): boolean {
        if (this.closingSpawned.has(sessionId)) return false;
        this.closingSpawned.add(sessionId);
        return true;
    }

    endSessionWake(sessionId: string): void {
        this.closingSpawned.delete(sessionId);
    }

    probe(sessionId: string): Promise<PeerOwnership> {
        return probeOwnership(sessionId, this.probeTimeoutMs);
    }

    listOwnership(sessionIds: string[]): Promise<Map<string, PeerOwnership>> {
        return listOwnership(sessionIds, this.probeTimeoutMs);
    }

    // ── 消息 ────────────────────────────────────────────────────

    /**
     * 发一条消息。目标不可达时抛 PeerSendFailure；忙时按 queueIfBusy 决定排队还是报错。
     * `expect_result` 时结果稍后自动回传，进请求者的结果队列。
     */
    async send(
        from: string,
        to: string,
        text: string,
        options: {
            expectResult?: boolean;
            replyTo?: string;
            closeOnResult?: boolean;
            queueIfBusy?: boolean;
            expiresAt?: string;
            /** 固定消息 id：重试同一投递时复用，服务端按 msgId 幂等。 */
            messageId?: string;
        } = {},
    ): Promise<PeerSendOutcome> {
        if (from === to) throw new PeerSendFailure("internal", "不能给自己发消息");
        if (this.closingSpawned.has(to)) {
            throw new PeerSendFailure("busy", `会话 ${to} 正在取消/关闭，请稍后重试`);
        }

        const message = createPeerMessage({
            ...(options.messageId ? { id: options.messageId } : {}),
            from,
            to,
            text,
            ...(options.replyTo ? { replyTo: options.replyTo } : {}),
            ...(options.expectResult ? { expectResult: true } : {}),
            ...(options.closeOnResult ? { closeOnResult: true } : {}),
            ...(options.queueIfBusy ? { queueIfBusy: true } : {}),
            ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
        });

        if (message.expectResult) {
            // 先登记再投递：目标可能在 accept/deliver 返回前就完成回合。
            this.outbox.addAwaiting({ msgId: message.id, requester: from, target: to, message });
        }

        let queued = false;
        let position: number | undefined;
        try {
            if (this.servers.has(to)) {
                // 同进程直投：不经过 socket，省一次序列化与连接
                this.localInbound.add(message.id);
                let outcome: PeerAcceptOutcome = { status: "busy" };
                try {
                    outcome = await this.host.accept(message);
                } catch {
                    outcome = { status: "busy" };
                }
                // 白名单：未知/旧式返回值一律按忙处理，不能误判成“已受理”
                if (outcome.status !== "accepted" && outcome.status !== "queued") {
                    this.localInbound.delete(message.id);
                    throw new PeerSendFailure(
                        outcome.status === "full" ? "queue_full" : "busy",
                        outcome.status === "full"
                            ? `会话 ${to} 的排队已满，请稍后重试`
                            : `会话 ${to} 正在执行中，请稍后重试`,
                    );
                }
                queued = outcome.status === "queued";
                if (outcome.status === "queued") position = outcome.position;
            } else {
                const remote = await this.deliverRemote(to, message);
                queued = remote.queued;
                position = remote.position;
            }
        } catch (error) {
            if (message.expectResult) this.outbox.removeAwaiting(message.id);
            throw error;
        }

        if (message.expectResult) this.startExpectationTimeout(from, message, to);
        this.host.onOutbound(from, message);
        return { message, queued, ...(position !== undefined ? { position } : {}) };
    }

    /** 撤销排队中的消息；跨进程走 socket，同进程直接问宿主。 */
    async cancelQueued(
        sessionId: string,
        msgId: string,
    ): Promise<{ ok: boolean; reason?: "not_found" | "running" }> {
        if (this.servers.has(sessionId)) {
            return this.host.cancelQueued?.(sessionId, msgId) ?? { ok: false, reason: "not_found" };
        }
        const reply = await requestOnce(getSocketPath(sessionId), {
            type: "cancel_queued",
            id: createFrameId(),
            msgId,
        });
        if (reply.type !== "cancel_queued_result") return { ok: false, reason: "not_found" };
        return { ok: reply.ok, ...(reply.reason ? { reason: reply.reason } : {}) };
    }

    /** 读排队快照；跨进程走 socket，同进程直接问宿主。 */
    async queueState(sessionId: string): Promise<PeerQueuedEntry[]> {
        if (this.servers.has(sessionId)) return this.host.queueState?.(sessionId) ?? [];
        const reply = await requestOnce(getSocketPath(sessionId), { type: "queue_state", id: createFrameId() });
        return reply.type === "queue_state" ? reply.entries : [];
    }

    /**
     * 回传一轮 turn 的结果；由宿主在回合结束时调用。
     *
     * 结果**无条件暂存**一份：推送只是快路径，对端半死连接上的 write 会"成功"但实际丢失，
     * 所以真正的可靠性由发起方重连后 query_pending 兜住（暂存有上限，不会无限增长）。
     */
    completeInbound(sessionId: string, message: PeerMessage, result: PeerResult): void {
        if (this.localInbound.delete(message.id)) {
            if (!message.expectResult) return;
            const delivered = this.handleRemoteResult(sessionId, result);
            if (delivered) this.autoCloseAfterResult(sessionId, message, result);
            return;
        }

        if (!message.expectResult) {
            this.servers.get(sessionId)?.forgetDelivery(message.id);
            return;
        }

        this.outbox.stashResult(result);
        // socket.write 返回成功不代表对端已收到；保留子会话监听器，让 query_pending 可补发。
        // 当前协议没有结果 ACK，因此跨进程结果不能触发 auto_close。
        this.servers.get(sessionId)?.pushResult(result);
    }

    /** 取走请求者待附加的结果（下一次 HTTP 请求用），取后即清。 */
    takeResults(sessionId: string): string[] {
        return this.outbox.takeQueued(sessionId);
    }

    /** 本实例发出的、仍在等结果的消息数。 */
    awaitingResults(sessionId: string): number {
        return this.outbox.awaitingCount(sessionId);
    }

    /** 已就绪、等待下一次请求附加的结果条数。 */
    queuedResults(sessionId: string): number {
        return this.outbox.queuedCount(sessionId);
    }

    /**
     * 前台阻塞等待某条自己发出的消息的结果：命中时直接返回结果，
     * 不入「待附加」队列、不触发驱动轮，省掉一次 HTTP 往返。
     * 超时 / 丢失 / 中止 / 转后台只解除等待，等待项仍在，结果此后到达仍按原路入队。
     */
    waitForResult(msgId: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitOutcome> {
        const expectation = this.outbox.get(msgId);
        if (!expectation || expectation.state !== "awaiting" || expectation.waiter) {
            return Promise.resolve({ ok: false, reason: "none" });
        }
        if (signal?.aborted) return Promise.resolve({ ok: false, reason: "aborted" });

        return new Promise<WaitOutcome>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let settled = false;

            const settle = (outcome: WaitOutcome) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                expectation.waiter = null;
                resolve(outcome);
            };
            const onAbort = () => settle({ ok: false, reason: "aborted" });

            timer = setTimeout(() => settle({ ok: false, reason: "timeout" }), timeoutMs);
            timer.unref?.();
            expectation.waiter = settle;
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }

    /**
     * 把某会话正在前台等待的结果放入后台（⌃B）：兑现为 `detached`，
     * 调用方立刻拿回控制权，等待项保留，结果到达后照原路入队并驱动下一轮。
     * 返回本次放下的等待数（0 表示没有可放后台的等待）。
     */
    detachWaits(sessionId: string): number {
        let count = 0;
        for (const entry of this.outbox.awaitingEntries()) {
            if (entry.requester !== sessionId) continue;
            const waiter = entry.waiter;
            if (!waiter) continue;
            entry.waiter = null;
            count += 1;
            waiter({ ok: false, reason: "detached" });
        }
        return count;
    }

    /** 退出前释放全部监听与连接。 */
    close(): void {
        for (const server of this.servers.values()) server.unbind();
        this.servers.clear();
        this.spawned.clear();
        this.autoCloseSpawned.clear();
        this.closingSpawned.clear();
        // 未兑现的等待一律以 aborted 结束，避免悬挂 Promise
        for (const entry of this.outbox.awaitingEntries()) {
            const waiter = entry.waiter;
            entry.waiter = null;
            waiter?.({ ok: false, reason: "aborted" });
        }
        this.outbox.clear();
        this.localInbound.clear();
        this.pool.closeAll();
    }

    // ── 内部 ────────────────────────────────────────────────────

    private async deliverRemote(to: string, message: PeerMessage): Promise<{ queued: boolean; position?: number }> {
        let reply;
        try {
            reply = await this.pool.deliver(to, message);
        } catch (error) {
            if (error instanceof PeerConnectError) {
                throw new PeerSendFailure("unreachable", `会话 ${to} 不可达（未认领或进程已退出）`);
            }
            throw new PeerSendFailure("internal", `发送到会话 ${to} 失败：${(error as Error)?.message ?? error}`);
        }

        if (reply.type !== "ack") {
            throw new PeerSendFailure("internal", `会话 ${to} 返回了非预期的应答`);
        }
        if (!reply.ok) {
            if (reply.error === "queue_full") throw new PeerSendFailure("queue_full", `会话 ${to} 的排队已满，请稍后重试`);
            if (reply.error === "busy") throw new PeerSendFailure("busy", `会话 ${to} 正在执行中，请稍后重试`);
            throw new PeerSendFailure("unreachable", `会话 ${to} 拒绝了消息（${reply.error}）`);
        }
        return {
            queued: reply.queued === true,
            ...(reply.position !== undefined ? { position: reply.position } : {}),
        };
    }

    /** 向持有者发起协商释放；持有者忙或无应答都算失败（不夺权）。 */
    private async requestRelease(sessionId: string): Promise<ClaimResult> {
        let reply;
        try {
            reply = await requestOnce(
                getSocketPath(sessionId),
                { type: "release", id: `release-${sessionId}` },
                this.negotiateTimeoutMs,
            );
        } catch (error) {
            if (error instanceof PeerConnectError && error.code === "connect") {
                // 无监听者：残留文件，交给 bind 的重试逻辑清理
                return { ok: true };
            }
            return { ok: false, reason: "unresponsive" };
        }

        if (reply.type !== "release_result") return { ok: false, reason: "unresponsive" };
        if (reply.ok) return { ok: true };
        return { ok: false, reason: "busy" };
    }

    private startExpectationTimeout(requester: string, message: PeerMessage, target: string): void {
        if (this.outbox.get(message.id)?.state !== "awaiting") return;

        const timer = setTimeout(() => {
            // 超时是状态迁移，只能经台账做一次：重复触发不会二次上报
            const expired = this.outbox.expire(message.id);
            if (!expired) return;
            expired.waiter?.({ ok: false, reason: "timeout" });
            this.host.onLost(requester, [message.id], target);
        }, this.resultTimeoutMs);
        timer.unref?.();
        this.outbox.setTimer(message.id, timer);
    }

    /** 结果到达：有前台等待者就直给，否则进请求者队列等下一次请求附加。 */
    private handleRemoteResult(sourceSessionId: string, result: PeerResult): boolean {
        // 先完成状态迁移再回调宿主：宿主抛错也不会让条目留在半成品状态
        const target = this.outbox.get(result.msgId)?.target ?? sourceSessionId;
        const settled = this.outbox.settle(
            result.msgId,
            late => formatResultText(target, result, { late }),
        );
        if (!settled) {
            console.warn(`[SessionControl] Dropping untracked or expired result ${result.msgId} from ${sourceSessionId}`);
            return false;
        }

        if (settled.waiter) {
            settled.waiter({ ok: true, result });
            return true;
        }
        this.host.onResult(settled.entry.requester, settled.entry.message, result, { late: settled.late });
        return true;
    }

    /** 仅对本进程内存投递的期望结果自动归档；跨进程推送没有 ACK，不可据 write 成功关闭。 */
    private autoCloseAfterResult(sessionId: string, message: PeerMessage, result: PeerResult): void {
        if (!message.expectResult || (!message.closeOnResult && !this.autoCloseSpawned.has(sessionId))
            || isCancelledStopReason(result.stopReason)) return;
        void this.closeSpawnedSession(sessionId, { automatic: true }).then(result => {
            if (!result.ok) console.warn(`⚠️ [SessionControl] 自动归档子会话失败: ${result.error}`);
        });
    }

    private handleRemoteLost(target: string, msgIds: string[]): void {
        for (const msgId of msgIds) {
            const expired = this.outbox.expire(msgId);
            if (!expired) continue;
            expired.waiter?.({ ok: false, reason: "lost" });
            this.host.onLost(expired.entry.requester, [msgId], target);
        }
    }

}

/**
 * 结果进入模型上下文时的文本形态：与时间线展示同源，避免两处措辞漂移。
 * 被取消的回合单独标出——它没有产出，不能与"正常完成但没说话"混为一谈。
 */
export function formatResultText(target: string, result: PeerResult, options: { late?: boolean } = {}): string {
    const cancelled = isCancelledStopReason(result.stopReason);
    const status = cancelled ? "（已取消）" : result.ok ? "" : "（未正常完成）";
    const late = options.late ? "（迟到）" : "";
    const header = `[会话 ${target} 的结果${status}${late}]`;
    const body = result.text.trim() || (cancelled ? "（本轮被取消，没有文本输出）" : "（无文本输出）");
    return [header, body, `（stopReason: ${result.stopReason}）`].join("\n");
}

/** 入站消息给模型的文本：结果由机器回传，模型不需要为此调用工具。 */
export function formatInboundPrompt(message: PeerMessage, peerTitle?: string): string {
    const who = peerTitle ? `${message.from}（${peerTitle}）` : message.from;
    const lines = [`[会话 ${who} 发来的消息]`, message.text];

    if (message.expectResult) {
        lines.push(
            "",
            ">>> 这条消息期望结果：请完成这件事。",
            "你的本轮最终输出会自动作为结果回传给对方，不需要为回信调用任何工具。",
            `要中途先说一句时才用 session_send(..., reply_to="${message.id}")。`,
        );
    }
    return lines.join("\n");
}

/** 认领失败的展示文案：UI flash 与 UI 工具提示共用，避免两处措辞漂移。 */
export function describeClaimFailure(result: ClaimResult): string {
    if (result.ok) return "";
    if (result.reason === "busy") {
        return result.pid
            ? `会话正由其他实例（PID ${result.pid}）执行中，turn 结束后才能接管`
            : "会话正由其他实例执行中，turn 结束后才能接管";
    }
    if (result.reason === "unresponsive") return "无法确认持有者状态（未应答），暂不能接管";
    if (result.reason === "raced") {
        return result.winnerPid
            ? `持有权被其他实例（PID ${result.winnerPid}）抢先取得，请稍后重试`
            : "持有权被其他实例抢先取得，请稍后重试";
    }
    return result.message;
}
