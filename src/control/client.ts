/**
 * 会话控制 socket 客户端：长连接池 + 请求/应答 + 异步结果推送。
 *
 * 连接由发起方**进程**持有，与"会话是否被本实例认领"解耦：
 * 切走会话不影响继续接收结果，只有进程退出才会丢（不支持离线投递）。
 */

import fs from "fs";
import net from "net";
import {
    createFrameId,
    encodeFrame,
    splitFrames,
    type PeerMessage,
    type PeerReply,
    type PeerRequest,
    type PeerResult,
} from "./protocol.js";
import { getSocketPath } from "./paths.js";

/** 单次请求应答的等待上限。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
/** 断线重连尝试间隔。 */
const DEFAULT_RECONNECT_DELAY_MS = 500;
/** 无 pending 时的空闲回收阈值。 */
const DEFAULT_IDLE_MS = 30_000;
/** 重连后补发已就绪结果的尝试次数，超过即判定结果丢失。 */
const MAX_RESYNC_ATTEMPTS = 3;

/** 连接层错误码：区分"连不上"（可判 stale）与"连上了没应答"（保守等待）。 */
export type PeerConnectErrorCode = "connect" | "timeout" | "closed";

export class PeerConnectError extends Error {
    constructor(
        readonly code: PeerConnectErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "PeerConnectError";
    }
}

interface Waiter {
    resolve: (reply: PeerReply) => void;
    reject: (error: Error) => void;
}

export interface PeerConnectionOptions {
    socketPath: string;
    /** 收到异步结果推送时的回调。 */
    onResult: (result: PeerResult) => void;
    requestTimeoutMs?: number;
    reconnectDelayMs?: number;
    /** 重连补发失败后的回调：结果确定丢失，交由上层提示。 */
    onLost?: (msgIds: string[]) => void;
}

/** 一条到目标会话的长连接：既能发请求，也能接收结果推送。 */
export class PeerConnection {
    private socket: net.Socket | null = null;
    private connecting: Promise<void> | null = null;
    private buffer = "";
    private readonly waiters = new Map<string, Waiter>();
    /** 已受理、仍在等结果的 msgId：有它就不允许关闭连接。 */
    private readonly pending = new Set<string>();
    private closed = false;
    private resyncTimer: ReturnType<typeof setTimeout> | null = null;
    private resyncAttempts = 0;
    private lastUsedAt = Date.now();

    constructor(private readonly options: PeerConnectionOptions) {}

    get socketPath(): string {
        return this.options.socketPath;
    }

    get lastUsed(): number {
        return this.lastUsedAt;
    }

    hasPending(): boolean {
        return this.pending.size > 0;
    }

    pendingCount(): number {
        return this.pending.size;
    }

    /** 发送一条消息；ack 成功且期望结果时登记 msgId。目标不可达会抛 PeerConnectError。 */
    async deliver(message: PeerMessage): Promise<PeerReply> {
        const reply = await this.request({ type: "deliver", id: createFrameId(), message });
        if (reply.type === "ack" && reply.ok && message.expectResult) {
            this.pending.add(message.id);
            this.resyncAttempts = 0;
        }
        return reply;
    }

    /** 撤销排队中的消息。 */
    cancelQueued(msgId: string): Promise<PeerReply> {
        return this.request({ type: "cancel_queued", id: createFrameId(), msgId });
    }

    /** 读取持有者的排队快照。 */
    queueState(): Promise<PeerReply> {
        return this.request({ type: "queue_state", id: createFrameId() });
    }

    /** 交给持有者改会话标题；结果帧是 rename_result。 */
    rename(title: string): Promise<PeerReply> {
        return this.request({ type: "rename", id: createFrameId(), title });
    }

    /**
     * 只读补查某些消息的终态结果（不消费对方暂存，可重复调用）。
     * 覆盖「推送丢了/连接半死」与命令行 wait 的并发轮询；连不上时抛 PeerConnectError。
     */
    async queryPending(msgIds: string[]): Promise<{ done: PeerResult[]; pending: string[] }> {
        const reply = await this.request({ type: "query_pending", id: createFrameId(), msgIds, keep: true });
        if (reply.type !== "pending_state") return { done: [], pending: msgIds };
        return { done: reply.done, pending: reply.pending };
    }

    /** 可以安全回收：无等待中的应答、无 pending 结果，且空闲超过阈值。 */
    isIdle(now: number, idleMs: number): boolean {
        return this.waiters.size === 0 && this.pending.size === 0 && now - this.lastUsedAt > idleMs;
    }

    close(): void {
        this.closed = true;
        this.clearResyncTimer();
        this.failWaiters(new PeerConnectError("closed", "连接已关闭"));
        const socket = this.socket;
        this.socket = null;
        try {
            socket?.destroy();
        } catch {
            // 已断开时忽略
        }
    }

    /** 发一个请求并等待配对应答。 */
    private async request(frame: PeerRequest): Promise<PeerReply> {
        this.lastUsedAt = Date.now();
        await this.ensureConnected();

        return new Promise<PeerReply>((resolve, reject) => {
            const socket = this.socket;
            if (!socket || !socket.writable) {
                reject(new PeerConnectError("closed", `连接 ${this.options.socketPath} 不可写`));
                return;
            }

            const timer = setTimeout(() => {
                this.waiters.delete(frame.id);
                reject(new PeerConnectError("timeout", `等待 ${this.options.socketPath} 应答超时`));
            }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

            this.waiters.set(frame.id, {
                resolve: (reply) => {
                    clearTimeout(timer);
                    resolve(reply);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });

            try {
                socket.write(encodeFrame(frame));
            } catch (error: any) {
                this.waiters.delete(frame.id);
                clearTimeout(timer);
                reject(new PeerConnectError("closed", `写入失败：${error?.message ?? error}`));
            }
        });
    }

    private ensureConnected(): Promise<void> {
        if (this.closed) return Promise.reject(new PeerConnectError("closed", "连接已关闭"));
        if (this.socket && !this.socket.destroyed) return Promise.resolve();
        if (this.connecting) return this.connecting;

        this.connecting = new Promise<void>((resolve, reject) => {
            if (!fs.existsSync(this.options.socketPath)) {
                reject(new PeerConnectError("connect", `连接 ${this.options.socketPath} 失败：socket 文件不存在`));
                return;
            }

            const socket = new net.Socket();
            const onError = (error: Error) => {
                socket.removeAllListeners();
                try {
                    socket.destroy();
                } catch {
                    // 忽略
                }
                reject(new PeerConnectError("connect", `连接 ${this.options.socketPath} 失败：${error.message}`));
            };

            // error 监听必须先挂：连接失败可能在同一个 tick 内抛出
            socket.once("error", onError);
            socket.setEncoding("utf8");
            socket.once("connect", () => {
                socket.removeListener("error", onError);
                this.socket = socket;
                this.buffer = "";
                socket.on("data", (chunk: string) => this.handleData(chunk));
                socket.on("error", () => undefined);
                socket.on("close", () => this.handleClose(socket));
                resolve();
            });

            try {
                socket.connect(this.options.socketPath);
            } catch (error: any) {
                onError(new Error(error?.message ?? String(error)));
            }
        }).finally(() => {
            this.connecting = null;
        });

        return this.connecting;
    }

    private handleData(chunk: string): void {
        this.buffer += chunk;
        const { frames, rest } = splitFrames(this.buffer);
        this.buffer = rest;

        for (const frame of frames) {
            if (frame.type === "result") {
                this.pending.delete(frame.result.msgId);
                this.options.onResult(frame.result);
                continue;
            }

            const id = (frame as { id?: string }).id;
            if (!id) continue;
            const waiter = this.waiters.get(id);
            if (!waiter) continue;

            this.waiters.delete(id);
            waiter.resolve(frame as PeerReply);
        }
    }

    private handleClose(socket: net.Socket): void {
        if (this.socket !== socket) return;
        this.socket = null;
        if (this.closed) return;

        this.failWaiters(new PeerConnectError("closed", `连接 ${this.options.socketPath} 已断开`));
        if (this.pending.size > 0) this.scheduleResync();
    }

    private failWaiters(error: Error): void {
        for (const waiter of this.waiters.values()) waiter.reject(error);
        this.waiters.clear();
    }

    private scheduleResync(): void {
        if (this.resyncTimer || this.closed) return;

        this.resyncTimer = setTimeout(() => {
            this.resyncTimer = null;
            void this.resync();
        }, this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS);
        this.resyncTimer.unref?.();
    }

    /** 重连后补发已就绪的结果：这是在线查询，不是离线投递。 */
    private async resync(): Promise<void> {
        if (this.closed || this.pending.size === 0) return;

        try {
            const reply = await this.request({
                type: "query_pending",
                id: createFrameId(),
                msgIds: [...this.pending],
            });
            if (reply.type !== "pending_state") return;

            for (const result of reply.done) {
                this.pending.delete(result.msgId);
                this.options.onResult(result);
            }
            this.pending.clear();
            for (const msgId of reply.pending) this.pending.add(msgId);
            this.resyncAttempts = 0;
        } catch {
            this.resyncAttempts += 1;
            if (this.resyncAttempts < MAX_RESYNC_ATTEMPTS) {
                this.scheduleResync();
                return;
            }
            // 目标进程已不可达：结果确定丢失（不支持离线投递），如实上报
            const lost = [...this.pending];
            this.pending.clear();
            this.options.onLost?.(lost);
        }
    }

    private clearResyncTimer(): void {
        if (!this.resyncTimer) return;
        clearTimeout(this.resyncTimer);
        this.resyncTimer = null;
    }
}

export interface PeerClientPoolOptions {
    requestTimeoutMs?: number;
    reconnectDelayMs?: number;
    idleMs?: number;
}

/** 按目标会话复用长连接的连接池。 */
export class PeerClientPool {
    private readonly connections = new Map<string, PeerConnection>();

    constructor(
        private readonly handlers: {
            onResult: (targetSessionId: string, result: PeerResult) => void;
            onLost?: (targetSessionId: string, msgIds: string[]) => void;
        },
        private readonly options: PeerClientPoolOptions = {},
    ) {}

    connection(targetSessionId: string): PeerConnection {
        const existing = this.connections.get(targetSessionId);
        if (existing) return existing;

        const onLost = this.handlers.onLost;
        const connection = new PeerConnection({
            socketPath: getSocketPath(targetSessionId),
            onResult: (result) => this.handlers.onResult(targetSessionId, result),
            ...(onLost ? { onLost: (msgIds: string[]) => onLost(targetSessionId, msgIds) } : {}),
            ...(this.options.requestTimeoutMs !== undefined
                ? { requestTimeoutMs: this.options.requestTimeoutMs }
                : {}),
            ...(this.options.reconnectDelayMs !== undefined
                ? { reconnectDelayMs: this.options.reconnectDelayMs }
                : {}),
        });
        this.connections.set(targetSessionId, connection);
        return connection;
    }

    /** 投递一条消息；目标不可达时抛 PeerConnectError 并丢弃该连接以便下次重连。 */
    async deliver(targetSessionId: string, message: PeerMessage): Promise<PeerReply> {
        const connection = this.connection(targetSessionId);
        try {
            return await connection.deliver(message);
        } catch (error) {
            if (error instanceof PeerConnectError) {
                this.connections.delete(targetSessionId);
                connection.close();
            }
            throw error;
        }
    }

    /** 回收空闲连接（无 pending 期间连接必须保留，否则结果无处可回）。 */
    releaseIdle(now = Date.now()): void {
        const idleMs = this.options.idleMs ?? DEFAULT_IDLE_MS;
        for (const [sessionId, connection] of [...this.connections]) {
            if (!connection.isIdle(now, idleMs)) continue;
            this.connections.delete(sessionId);
            connection.close();
        }
    }

    closeAll(): void {
        for (const connection of this.connections.values()) connection.close();
        this.connections.clear();
    }
}

/** 一次性请求：探测归属、协商释放等短交互用，用完即断。 */
export function requestOnce(
    socketPath: string,
    frame: PeerRequest,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<PeerReply> {
    return new Promise<PeerReply>((resolve, reject) => {
        const rejectConnect = (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            reject(new PeerConnectError("connect", `连接 ${socketPath} 失败：${message}`));
        };

        // 文件不存在是最常见的"无人持有"，直接判定，不依赖 connect 的系统调用行为
        if (!fs.existsSync(socketPath)) {
            rejectConnect(new Error("socket 文件不存在"));
            return;
        }

        const socket = new net.Socket();

        let settled = false;
        let buffer = "";
        const finish = (action: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.removeAllListeners();
            try {
                socket.destroy();
            } catch {
                // 忽略
            }
            action();
        };

        // error 监听必须先挂：连接失败可能在同一个 tick 内抛出
        socket.on("error", (error: Error) => finish(() => rejectConnect(error)));
        socket.setEncoding("utf8");

        const timer = setTimeout(() => {
            finish(() => reject(new PeerConnectError("timeout", `等待 ${socketPath} 应答超时`)));
        }, timeoutMs);

        socket.on("connect", () => {
            try {
                socket.write(encodeFrame(frame));
            } catch (error: any) {
                finish(() => reject(new PeerConnectError("closed", `写入失败：${error?.message ?? error}`)));
            }
        });

        socket.on("data", (chunk: string) => {
            buffer += chunk;
            const { frames, rest } = splitFrames(buffer);
            buffer = rest;

            for (const item of frames) {
                const id = (item as { id?: string }).id;
                if (id !== frame.id) continue;
                finish(() => resolve(item as PeerReply));
                return;
            }
        });

        // 用 new net.Socket() 并在 connect 前挂好监听：createConnection 在连接
        // 失败时会同步派发 error，来不及挂监听（bun 下会变成未捕获异常）。
        try {
            socket.connect(socketPath);
        } catch (error) {
            finish(() => rejectConnect(error));
        }
    });
}
