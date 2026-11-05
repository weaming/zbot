/**
 * 会话控制服务端：每个被认领的会话监听一个 unix socket。
 *
 * 职责边界：
 * - 本模块只管协议与路由（谁投递了什么、结果回给谁）；
 * - "能不能受理"、"收到的消息怎么落地"由注入的 handlers 决定，因为那属于 agent 层。
 */

import fs from "fs";
import net from "net";
import { ensureControlDir, getSocketPath } from "./paths.js";
import { isLocallyBound, PROCESS_INSTANCE_ID, probeOwnership, registerBound, releaseSocketFile } from "./registry.js";
import {
    encodeFrame,
    splitFrames,
    type PeerAcceptOutcome,
    type PeerErrorCode,
    type PeerFrame,
    type PeerMessage,
    type PeerOwnerInfo,
    type PeerQueuedEntry,
    type PeerResult,
} from "./protocol.js";

/** 已受理但尚未回结果的消息上限：防止对端永不取结果导致内存无限增长。 */
const MAX_DELIVERIES = 200;

export interface PeerServerHandlers {
    /** 本会话展示名（who 握手与 release 提示用）。 */
    title(): string | undefined;
    /** 是否正在跑 turn。 */
    isBusy(): boolean;
    /**
     * 原子受理一条入站消息：accepted 立即执行，queued 已入队，full/busy 拒绝。
     * 受理成功时结果稍后由 pushResult 回传。
     */
    accept(message: PeerMessage): Promise<PeerAcceptOutcome> | PeerAcceptOutcome;
    /** 撤销排队中的消息（只对仍在队列里的生效）。 */
    cancelQueued?(msgId: string): { ok: true } | { ok: false; reason: "not_found" | "running" };
    /** 当前排队快照（观测用）。 */
    queueState?(): PeerQueuedEntry[];
    /** 协商释放：忙时返回 false，持有者只在空闲时放行。 */
    release(): Promise<boolean> | boolean;
    /**
     * 断线重连后查询：done = 已就绪但未送达的结果，pending = 仍在处理中的 msgId。
     * keep=true 只读查看暂存，结果仍留给真正的收件人（命令行 wait 用）。
     */
    pendingState(
        msgIds: string[],
        options?: { keep?: boolean },
    ): { done: PeerResult[]; pending: string[] };
}

export type BindResult =
    | { ok: true }
    | { ok: false; reason: "owned"; pid?: number }
    | { ok: false; reason: "error"; message: string };

export interface PeerServerOptions {
    /** 归属探测超时；测试可调小。 */
    probeTimeoutMs?: number;
}

interface Delivery {
    from: string;
    socket: net.Socket | null;
}

export class PeerServer {
    private server: net.Server | null = null;
    /** msgId → 发起方连接：结果回传的路由表。 */
    private readonly deliveries = new Map<string, Delivery>();

    constructor(
        private readonly sessionId: string,
        private readonly handlers: PeerServerHandlers,
        private readonly options: PeerServerOptions = {},
    ) {}

    get isBound(): boolean {
        return this.server !== null;
    }

    /** 已受理但尚未回结果的消息数。 */
    get pendingCount(): number {
        return this.deliveries.size;
    }

    /**
     * 绑定 socket。
     * 被其他实例持有时返回 owned；EADDRINUSE 且 connect 失败说明是残留文件，清理后重试一次。
     */
    async bind(): Promise<BindResult> {
        if (this.server) return { ok: true };
        if (isLocallyBound(this.sessionId)) return { ok: false, reason: "owned", pid: process.pid };

        ensureControlDir();
        const socketPath = getSocketPath(this.sessionId);

        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                this.server = await this.listen(socketPath);
                registerBound(this.sessionId, socketPath, fs.statSync(socketPath).ino);
                return { ok: true };
            } catch (error: any) {
                if (error?.code !== "EADDRINUSE") {
                    return { ok: false, reason: "error", message: `监听 ${socketPath} 失败：${error?.message ?? error}` };
                }

                const ownership = await probeOwnership(this.sessionId, this.options.probeTimeoutMs);
                if (ownership.state === "mine") return { ok: false, reason: "owned", pid: process.pid };
                if (ownership.state === "other") return { ok: false, reason: "owned", pid: ownership.info?.pid };

                // free：确认无监听者，是残留文件，清理后重试
                try {
                    fs.unlinkSync(socketPath);
                } catch {
                    // 已被别的实例清理
                }
            }
        }

        return { ok: false, reason: "error", message: "socket 文件竞争失败，请稍后重试" };
    }

    /** 结果就绪时回传给发起方；返回是否成功送达（false 表示对端连接不可用）。 */
    pushResult(result: PeerResult): boolean {
        const delivery = this.deliveries.get(result.msgId);
        if (!delivery) return false;

        const socket = delivery.socket;
        if (!socket || socket.destroyed || !socket.writable) return false;
        if (!writeFrame(socket, { type: "result", result })) return false;

        this.deliveries.delete(result.msgId);
        return true;
    }

    /** 入站消息没有 expectResult 时移除投递槽，不等待无用的结果回传。 */
    forgetDelivery(msgId: string): void {
        this.deliveries.delete(msgId);
    }

    /** 关闭监听并释放 socket 文件（带 inode 校验）。 */
    unbind(): void {
        const server = this.server;
        this.server = null;
        this.deliveries.clear();

        if (server) {
            try {
                server.close();
            } catch {
                // 未在运行
            }
        }
        releaseSocketFile(this.sessionId);
    }

    private listen(socketPath: string): Promise<net.Server> {
        return new Promise<net.Server>((resolve, reject) => {
            const server = net.createServer((socket) => this.attach(socket));

            const onError = (error: Error) => {
                server.removeListener("listening", onListening);
                try {
                    server.close();
                } catch {
                    // 未在运行
                }
                reject(error);
            };
            const onListening = () => {
                server.removeListener("error", onError);
                resolve(server);
            };

            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(socketPath);
        });
    }

    private attach(socket: net.Socket): void {
        socket.setEncoding("utf8");
        let buffer = "";

        socket.on("data", (chunk: string) => {
            buffer += chunk;
            const { frames, rest } = splitFrames(buffer);
            buffer = rest;
            for (const frame of frames) void this.handleFrame(socket, frame);
        });
        socket.on("error", () => undefined);
        socket.on("close", () => {
            // 连接断了但条目保留：结果仍可由对端重连后 query_pending 取回
            for (const delivery of this.deliveries.values()) {
                if (delivery.socket === socket) delivery.socket = null;
            }
        });
    }

    private async handleFrame(socket: net.Socket, frame: PeerFrame): Promise<void> {
        switch (frame.type) {
            case "ping":
                writeFrame(socket, { type: "pong", id: frame.id });
                return;
            case "who":
                writeFrame(socket, { type: "who", id: frame.id, info: this.buildOwnerInfo() });
                return;
            case "release":
                await this.handleRelease(socket, frame.id);
                return;
            case "query_pending":
                this.handleQueryPending(socket, frame.id, frame.msgIds, frame.keep === true);
                return;
            case "queue_state":
                writeFrame(socket, { type: "queue_state", id: frame.id, entries: this.handlers.queueState?.() ?? [] });
                return;
            case "cancel_queued":
                this.handleCancelQueued(socket, frame.id, frame.msgId);
                return;
            case "deliver":
                await this.handleDeliver(socket, frame.id, frame.message);
                return;
            default:
                // 推送帧不是合法请求；忽略而不是断连
                return;
        }
    }

    private buildOwnerInfo(): PeerOwnerInfo {
        const title = this.handlers.title();
        return {
            pid: process.pid,
            instanceId: PROCESS_INSTANCE_ID,
            sessionId: this.sessionId,
            ...(title ? { title } : {}),
            busy: this.handlers.isBusy(),
            pending: this.deliveries.size,
            queued: this.handlers.queueState?.().length ?? 0,
        };
    }

    private handleCancelQueued(socket: net.Socket, id: string, msgId: string): void {
        const result = this.handlers.cancelQueued?.(msgId) ?? { ok: false as const, reason: "not_found" as const };
        writeFrame(socket, {
            type: "cancel_queued_result",
            id,
            ok: result.ok,
            ...(result.ok ? {} : { reason: result.reason }),
        });
    }

    private async handleRelease(socket: net.Socket, id: string): Promise<void> {
        let ok = false;
        try {
            ok = await this.handlers.release();
        } catch {
            ok = false;
        }

        if (!ok) {
            writeFrame(socket, { type: "release_result", id, ok: false, reason: "busy" });
            return;
        }

        writeFrame(socket, { type: "release_result", id, ok: true });
        this.unbind();
    }

    private handleQueryPending(socket: net.Socket, id: string, msgIds: string[], keep: boolean): void {
        const { done, pending } = this.handlers.pendingState(msgIds, keep ? { keep: true } : undefined);
        writeFrame(socket, { type: "pending_state", id, done, pending });
    }

    private async handleDeliver(socket: net.Socket, id: string, message: PeerMessage): Promise<void> {
        if (!message || typeof message.id !== "string" || message.to !== this.sessionId) {
            writeFrame(socket, { type: "ack", id, ok: false, error: "bad_request" });
            return;
        }

        // 先登记投递槽再受理：受理期间回合若极快结束，结果推送也能找到归属
        this.deliveries.set(message.id, { from: message.from, socket });
        this.evictDeliveries();

        let outcome: PeerAcceptOutcome = { status: "busy" };
        try {
            outcome = await this.handlers.accept(message);
        } catch {
            outcome = { status: "busy" };
        }

        // 白名单：未知/旧式返回值一律按拒绝处理，不能误判成“已受理”
        if (outcome.status !== "accepted" && outcome.status !== "queued") {
            this.deliveries.delete(message.id);
            const error: PeerErrorCode = outcome.status === "full" ? "queue_full" : "busy";
            writeFrame(socket, { type: "ack", id, ok: false, error });
            return;
        }

        if (outcome.status === "queued") {
            writeFrame(socket, { type: "ack", id, ok: true, queued: true, position: outcome.position });
            return;
        }

        writeFrame(socket, { type: "ack", id, ok: true });
    }

    /** 超出上限时丢弃最早的投递槽：对应结果会由 query_pending 兜住或按丢失处理。 */
    private evictDeliveries(): void {
        while (this.deliveries.size > MAX_DELIVERIES) {
            const oldest = this.deliveries.keys().next().value;
            if (oldest === undefined) break;
            this.deliveries.delete(oldest);
        }
    }
}

function writeFrame(socket: net.Socket, frame: PeerFrame): boolean {
    try {
        socket.write(encodeFrame(frame));
        return true;
    } catch {
        return false;
    }
}
