/**
 * 观察服务端：每个被持有的会话一个只读 socket。
 *
 * 职责只有三件：初始化查询（snapshot）、订阅推送（持久化事件 + 瞬态信号）、心跳。
 * 它不参与归属判定、没有投递与结果回传，也不做消费语义：
 * 任何写操作类帧回 forbidden，观察者无从顺手动到会话。
 *
 * 隔离：一条连接一个状态机，慢消费者只影响自己那条连接（超过积压上限就丢帧并补 gap），
 * 不会阻塞宿主事件循环里的其他前端，也不会影响控制通道。
 */

import fs from "fs";
import net from "net";
import type { LiveFrame } from "../events/live-stream.js";
import type { SessionEventView } from "../events/session-event-view.js";
import { ensureObserveDir, getObserveSocketPath } from "./paths.js";
import { pendingQuestion, subscribeQuestions, type PendingQuestion } from "../control/question-registry.js";
import {
    encodeObserveFrame,
    MAX_SNAPSHOT_EVENTS,
    OBSERVE_PROTOCOL_VERSION,
    splitObserveFrames,
    type ObserveErrorCode,
    type ObserveFrame,
    type ObservePush,
    type ObserveReply,
    type ObserveRequest,
} from "./protocol.js";

/** 单条连接允许积压的字节数：超过就丢事件帧并补 gap，绝不拖住宿主。 */
const MAX_BACKLOG_BYTES = 4 << 20;
/** 归属探测超时：连上但不应答，保守当作"有人在服务"。 */
const PROBE_TIMEOUT_MS = 300;

/** 控制类帧：观察通道一律拒绝，避免观察者顺手动到会话。 */
const WRITE_FRAMES = new Set(["deliver", "query_pending", "cancel_queued", "queue_state", "rename", "release"]);

export interface ObserveSnapshot {
    events: SessionEventView[];
    lastSeq: number;
    more: boolean;
}

export interface ObserveServerHandlers {
    title(): string | undefined;
    isBusy(): boolean;
    /** 会话当前最后 seq（无日志时 0）。 */
    lastSeq(): Promise<number>;
    /** 读 since 之后的一段持久化事件（已转成界面视图）。 */
    snapshot(since: number, limit: number): Promise<ObserveSnapshot>;
    /** 订阅持久化事件（已转成界面视图），返回退订函数。 */
    watchEvents(listener: (view: SessionEventView) => void): () => void;
    /** 订阅瞬态信号，返回退订函数。 */
    watchLive(listener: (frame: LiveFrame) => void): () => void;
}

export type ObserveBindResult =
    | { ok: true }
    | { ok: false; reason: "owned" | "error"; message?: string };

interface Connection {
    socket: net.Socket;
    /** 已经下发到的 seq：重复事件在这里被丢，客户端不必再判重。 */
    lastSeq: number;
    subscribed: boolean;
    /** 订阅刚建立、回放还在读：期间的新事件先攒着，保证 seq 单调。 */
    buffering: boolean;
    buffered: SessionEventView[];
    /** 丢过但还没通知客户端的事件区间。 */
    droppedFrom?: number;
    droppedTo?: number;
    detach: Array<() => void>;
}

export class ObserveServer {
    private server: net.Server | null = null;
    /** bind 时的 inode：释放前比对，避免误删别人重建的同名 socket。 */
    private ino = 0;
    private readonly connections = new Set<Connection>();

    constructor(
        private readonly sessionId: string,
        private readonly handlers: ObserveServerHandlers,
    ) {}

    get isBound(): boolean {
        return this.server !== null;
    }

    /** 绑定观察 socket；失败只降级（观察通道是旁路，不能影响会话本身）。 */
    async bind(): Promise<ObserveBindResult> {
        if (this.server) return { ok: true };
        ensureObserveDir();
        const socketPath = getObserveSocketPath(this.sessionId);

        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                this.server = await this.listen(socketPath);
                this.ino = fs.statSync(socketPath).ino;
                return { ok: true };
            } catch (error: any) {
                if (error?.code !== "EADDRINUSE") {
                    return { ok: false, reason: "error", message: `监听 ${socketPath} 失败：${error?.message ?? error}` };
                }
                // 残留文件（unix socket 不随进程退出消失）：确认无人应答才清理
                if (await probeObserveSocket(socketPath)) return { ok: false, reason: "owned" };
                try {
                    fs.unlinkSync(socketPath);
                } catch {
                    // 已被别的实例清理
                }
            }
        }
        return { ok: false, reason: "error", message: "观察 socket 文件竞争失败" };
    }

    /** 关闭监听、断开所有订阅、释放 socket 文件（inode 校验）。 */
    unbind(): void {
        const server = this.server;
        this.server = null;
        for (const connection of this.connections) this.detach(connection);
        this.connections.clear();
        if (server) {
            try {
                server.close();
            } catch {
                // 未在运行
            }
        }
        try {
            if (fs.statSync(getObserveSocketPath(this.sessionId)).ino === this.ino) {
                fs.unlinkSync(getObserveSocketPath(this.sessionId));
            }
        } catch {
            // 文件已不存在：视为已清理
        }
    }

    private listen(socketPath: string): Promise<net.Server> {
        return new Promise((resolve, reject) => {
            const server = net.createServer(socket => this.attach(socket));
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
        const connection: Connection = {
            socket,
            lastSeq: 0,
            subscribed: false,
            buffering: false,
            buffered: [],
            detach: [],
        };
        this.connections.add(connection);

        let buffer = "";
        socket.on("data", (chunk: string) => {
            buffer += chunk;
            const { frames, rest } = splitObserveFrames(buffer);
            buffer = rest;
            for (const frame of frames) void this.handleFrame(connection, frame);
        });
        socket.on("error", () => undefined);
        socket.on("close", () => {
            this.detach(connection);
            this.connections.delete(connection);
        });
    }

    private async handleFrame(connection: Connection, raw: unknown): Promise<void> {
        const frame = raw as Partial<ObserveRequest> & { type?: unknown; id?: unknown };
        const type = typeof frame.type === "string" ? frame.type : "";
        const id = typeof frame.id === "string" ? frame.id : undefined;

        if (WRITE_FRAMES.has(type)) {
            this.error(connection, id, "forbidden", "观察通道只读：投递与消费请走控制通道");
            return;
        }

        switch (type) {
            case "ping":
                this.reply(connection, { type: "pong", id: id ?? "" });
                return;
            case "hello": {
                const version = Number((raw as { version?: unknown }).version);
                if (version !== OBSERVE_PROTOCOL_VERSION) {
                    const lastSeq = await this.lastSeq();
                    this.reply(connection, {
                        type: "hello_result",
                        id: id ?? "",
                        ok: false,
                        version: OBSERVE_PROTOCOL_VERSION,
                        sessionId: this.sessionId,
                        busy: this.handlers.isBusy(),
                        lastSeq,
                        error: `协议版本不一致：本机支持 ${OBSERVE_PROTOCOL_VERSION}，收到 ${String(version)}`,
                    });
                    return;
                }
                const title = this.handlers.title();
                this.reply(connection, {
                    type: "hello_result",
                    id: id ?? "",
                    ok: true,
                    version: OBSERVE_PROTOCOL_VERSION,
                    sessionId: this.sessionId,
                    ...(title ? { title } : {}),
                    busy: this.handlers.isBusy(),
                    lastSeq: await this.lastSeq(),
                });
                return;
            }
            case "snapshot":
                await this.handleSnapshot(connection, raw as { since?: unknown; limit?: unknown }, id);
                return;
            case "subscribe":
                await this.handleSubscribe(connection, raw as { since?: unknown }, id);
                return;
            case "unsubscribe":
                this.detach(connection);
                connection.subscribed = false;
                this.reply(connection, { type: "unsubscribed", id: id ?? "" });
                return;
            default:
                this.error(connection, id, "bad_request", `未知帧类型：${type || "(缺 type)"}`);
                return;
        }
    }

    private async handleSnapshot(
        connection: Connection,
        frame: { since?: unknown; limit?: unknown },
        id: string | undefined,
    ): Promise<void> {
        const since = clampSeq(frame.since);
        const limit = clampLimit(frame.limit);
        try {
            const snapshot = await this.handlers.snapshot(since, limit);
            this.reply(connection, {
                type: "snapshot_result",
                id: id ?? "",
                events: snapshot.events,
                lastSeq: snapshot.lastSeq,
                more: snapshot.more,
            });
        } catch (error: any) {
            this.error(connection, id, "internal", `读取事件失败：${error?.message ?? error}`);
        }
    }

    private async handleSubscribe(
        connection: Connection,
        frame: { since?: unknown },
        id: string | undefined,
    ): Promise<void> {
        if (!connection.subscribed) {
            connection.subscribed = true;
            connection.buffering = true;
            connection.buffered = [];
            connection.lastSeq = Math.max(connection.lastSeq, clampSeq(frame.since));
            connection.detach.push(
                this.handlers.watchEvents(view => this.onEvent(connection, view)),
                this.handlers.watchLive(frame => this.onLive(connection, frame)),
                subscribeQuestions(event => {
                    if (event.question.sessionId !== this.sessionId) return;
                    if (event.kind === "asked") {
                        this.onQuestion(connection, event.question);
                    } else {
                        this.write(connection, { type: "question_closed", requestId: event.question.requestId });
                    }
                }),
            );
        }
        const lastSeq = await this.lastSeq();
        this.reply(connection, { type: "subscribed", id: id ?? "", lastSeq });

        // 回放订阅前的那一段：客户端按 seq 去重，重复只会被丢掉，不会出现空隙
        const since = clampSeq(frame.since) || connection.lastSeq;
        try {
            const backlog = await this.handlers.snapshot(since, MAX_SNAPSHOT_EVENTS);
            for (const view of backlog.events) this.onEvent(connection, view);
        } catch {
            // 回放失败不影响后续实时推送：客户端仍可再发 snapshot 补齐
        }
        connection.buffering = false;
        const buffered = connection.buffered;
        connection.buffered = [];
        for (const view of buffered) this.sendEvents(connection, [view]);
        // 订阅瞬间已经有提问在等：先补一条，别让它等到下一次变化才出现。
        const asked = pendingQuestion(this.sessionId);
        if (asked) this.onQuestion(connection, asked);
    }

    /** 持久化事件：订阅回放期间先攒着，保证下发 seq 单调。 */
    private onEvent(connection: Connection, view: SessionEventView): void {
        if (view.seq <= connection.lastSeq) return;
        if (connection.buffering) {
            connection.buffered.push(view);
            return;
        }
        this.sendEvents(connection, [view]);
    }

    private onLive(connection: Connection, frame: LiveFrame): void {
        if (!connection.subscribed) return;
        // 瞬态信号可丢：落后时直接跳过，靠持久化事件补齐
        if (connection.buffering || connection.socket.writableLength > MAX_BACKLOG_BYTES) return;
        const push: ObservePush = { type: "live", frame };
        this.write(connection, push);
    }

    /** 待答提问：外部界面据此显示可作答的选项。 */
    private onQuestion(connection: Connection, question: PendingQuestion): void {
        if (connection.buffering || connection.socket.writableLength > MAX_BACKLOG_BYTES) return;
        this.write(connection, {
            type: "question",
            question: {
                requestId: question.requestId,
                sessionId: question.sessionId,
                questions: question.questions,
            },
        });
    }

    private sendEvents(connection: Connection, views: SessionEventView[]): void {
        const fresh = views.filter(view => view.seq > connection.lastSeq);
        if (fresh.length === 0) return;
        connection.lastSeq = fresh[fresh.length - 1].seq;

        if (connection.socket.writableLength > MAX_BACKLOG_BYTES) {
            connection.droppedFrom ??= fresh[0].seq;
            connection.droppedTo = fresh[fresh.length - 1].seq;
            return;
        }
        this.flushGap(connection);
        const push: ObservePush = { type: "events", events: fresh };
        this.write(connection, push);
    }

    private flushGap(connection: Connection): void {
        const fromSeq = connection.droppedFrom;
        if (fromSeq === undefined) return;
        const toSeq = connection.droppedTo ?? fromSeq;
        connection.droppedFrom = undefined;
        connection.droppedTo = undefined;
        const push: ObservePush = { type: "gap", fromSeq, toSeq };
        this.write(connection, push);
    }

    private reply(connection: Connection, frame: ObserveReply): void {
        this.write(connection, frame);
    }

    private error(connection: Connection, id: string | undefined, code: ObserveErrorCode, message: string): void {
        this.reply(connection, { type: "error", ...(id ? { id } : {}), code, message });
    }

    private write(connection: Connection, frame: ObserveFrame): void {
        const socket = connection.socket;
        if (socket.destroyed || !socket.writable) return;
        try {
            socket.write(encodeObserveFrame(frame));
        } catch {
            // 写失败按断线处理：连接会被 close 事件收拾
        }
    }

    private detach(connection: Connection): void {
        for (const off of connection.detach) {
            try {
                off();
            } catch {
                // 退订失败不该影响其他订阅者
            }
        }
        connection.detach = [];
    }

    private async lastSeq(): Promise<number> {
        try {
            return await this.handlers.lastSeq();
        } catch {
            return 0;
        }
    }
}

function clampSeq(value: unknown): number {
    const seq = Number(value);
    return Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
}

function clampLimit(value: unknown): number {
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit <= 0) return MAX_SNAPSHOT_EVENTS;
    return Math.min(limit, MAX_SNAPSHOT_EVENTS);
}

/** 探测 socket 是否有人应答：连上即视为已被持有（宁可不绑，也不重复服务）。 */
export function probeObserveSocket(socketPath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
    return new Promise(resolve => {
        const socket = net.connect(socketPath);
        const done = (held: boolean) => {
            socket.destroy();
            resolve(held);
        };
        socket.setTimeout(timeoutMs, () => done(true));
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
    });
}
