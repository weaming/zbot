/**
 * JSONL 会话前端：单进程只持有一个顶层会话（自建 session/create 或恢复 session/resume）。
 * 不接收外部 target，身份一律由本进程认领结果决定。
 */
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { describeClaimFailure } from "../control/channel.js";
import type { UIEvent } from "../events/ui-events.js";
import type { SessionHost } from "../host/session-host-types.js";
import { isUlid } from "../utils/session-id.js";

export type StdioHost = Pick<SessionHost,
    "createSession" | "claimSession" | "releaseSession" | "closeSession" | "unarchiveSession" | "isSessionArchived"
    | "listSessions" | "ensureSessionCreated" | "sendMessage" | "abortSession" | "subscribeEvents" | "onEvent" | "onSessionReleased"
    | "isSessionClaimed" | "isSessionBusy" | "close">;

/** 恢复会话时重放的一条已存事件，形状与 session/record 的 record 一致。 */
export interface ReplayRecord {
    type: string;
    seq: number;
    ts: string;
    payload: unknown;
}

/** 恢复会话时最多重放多少条已存事件：够看一屏，也不至于把输出队列撑爆。 */
export const HISTORY_MAX_EVENTS = 400;
/** 单条 session/history 通知的字节预算，给传输层上限留足余量。 */
const HISTORY_BATCH_BYTES = 512 * 1024;
/** 单条记录超过这个大小就跳过：宁缺一条，也不让整条通知超过上限。 */
const HISTORY_MAX_RECORD_BYTES = 768 * 1024;
/** 实时工具事件里单个文本字段的上限：完整内容随后会随消息落盘。 */
const TOOL_TEXT_MAX_CHARS = 2000;

interface ProtocolOptions {
    host: StdioHost;
    cwd: string;
    input: Readable;
    output: Writable;
    signal?: AbortSignal;
    onClosing?: () => void;
    /** 读取恢复目标最近的事件；缺省时不重放历史。 */
    readHistory?: (sessionId: string, limit: number) => Promise<ReplayRecord[]>;
    registerRuntime?: (
        notify: (method: string, params: unknown) => void,
        ownsSession: (id: string) => boolean,
    ) => () => void;
    maxLineBytes?: number;
    maxOutputBytes?: number;
    writeTimeoutMs?: number;
    ownershipCheckMs?: number;
}

class ProtocolError extends Error {
    constructor(readonly code: number, message: string) { super(message); }
}

function objectParams(value: unknown): Record<string, unknown> {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ProtocolError(-32602, "params 必须是对象");
    }
    return value as Record<string, unknown>;
}

/** 有界、保序输出；消费者不再读取时必须关闭宿主，不能无限积压事件。 */
class JsonlWriter {
    private tail: Promise<void> = Promise.resolve();
    private pendingBytes = 0;
    private failure?: Error;

    constructor(
        private readonly output: Writable,
        private readonly maxBytes: number,
        private readonly timeoutMs: number,
        private readonly fail: (error: Error) => void,
    ) {}

    write(value: unknown): Promise<void> {
        if (this.failure) return Promise.reject(this.failure);
        const line = `${JSON.stringify(value)}\n`;
        const bytes = Buffer.byteLength(line);
        if (this.pendingBytes + bytes > this.maxBytes) {
            const error = new Error("stdio 输出队列超过上限");
            this.failure = error;
            this.fail(error);
            return Promise.reject(error);
        }
        this.pendingBytes += bytes;
        const task = this.tail.then(() => new Promise<void>((resolve, reject) => {
            if (this.failure) return reject(this.failure);
            const timer = setTimeout(() => reject(new Error("stdio 输出等待超时")), this.timeoutMs);
            try {
                this.output.write(line, error => {
                    clearTimeout(timer);
                    if (error) reject(error);
                    else resolve();
                });
            } catch (error) {
                clearTimeout(timer);
                reject(error);
            }
        }));
        this.tail = task.catch(error => {
            this.failure = error instanceof Error ? error : new Error(String(error));
            this.fail(this.failure);
        }).finally(() => { this.pendingBytes -= bytes; });
        return task;
    }

    async flush(): Promise<void> {
        await this.tail;
        if (this.failure) throw this.failure;
    }
}

/** 分发串行命令，回合独立执行；cancel 不会被 send 的模型等待阻塞。 */
export async function runStdioProtocol(options: ProtocolOptions): Promise<void> {
    const { host, input, output } = options;
    const instanceId = randomUUID();
    const maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    let isInitialized = false;
    /** 本进程是否已确定顶层会话（create 或 resume 只能二选一发生一次）。 */
    let hasTopSession = false;
    let sessionId: string | undefined;
    /** 已归档的顶层会话：归档后释放持有权，仅留给本进程内的 unarchive。 */
    let archivedSessionId: string | undefined;
    let isStopping = false;
    let hasLostOwnership = false;
    let transportError: Error | undefined;
    let turn: { hasCommit: boolean; isCancelRequested: boolean } | undefined;

    const stop = (error?: Error): void => {
        transportError ??= error;
        isStopping = true;
        input.destroy();
    };
    const writer = new JsonlWriter(output, options.maxOutputBytes ?? 4 * 1024 * 1024,
        options.writeTimeoutMs ?? 5000, stop);
    const notify = (method: string, params: unknown): void => {
        if (transportError) return;
        const identity = { instanceId, ...(sessionId ? { sessionId } : {}) };
        void writer.write({ method, params: { ...objectParams(params), ...identity } }).catch(stop);
    };
    const status = (): { instanceId: string; sessionId?: string; state: "idle" | "working" | "closing" | "lost" } => ({
        instanceId,
        ...(sessionId ? { sessionId } : {}),
        state: hasLostOwnership ? "lost" : isStopping ? "closing"
            : turn || (sessionId && host.isSessionBusy(sessionId)) ? "working" : "idle",
    });
    const checkOwnership = (): boolean => {
        if (!sessionId || isStopping) return !hasLostOwnership;
        if (host.isSessionClaimed(sessionId)) return true;
        hasLostOwnership = true;
        notify("session/status", { state: "lost" });
        notify("session/error", { message: "当前实例已失去顶层会话持有权" });
        stop();
        return false;
    };
    const onOutputError = (error: Error): void => stop(error);
    const onAbort = (): void => stop();
    output.on("error", onOutputError);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const unsubscribe = host.subscribeEvents((changedId, event) => {
        if (changedId !== sessionId || !event || event.sessionId !== sessionId) return;
        if (!checkOwnership()) return;
        if (event.type === "turn_commit" && turn) turn.hasCommit = true;
        const { type, seq, ts, payload } = event;
        notify("session/record", { record: { type, seq, ts, payload } });
    });
    const previousOnEvent = host.onEvent;
    host.onEvent = (requestId, changedId, event) => {
        previousOnEvent?.(requestId, changedId, event);
        if (changedId !== sessionId || !event || !checkOwnership()) return;
        forwardToolEvent(event);
        // cancel 可能发生在异步锁获取期间；首个运行事件再补发取消。
        if (turn?.isCancelRequested) {
            void host.abortSession(changedId).catch(stop);
        }
    };

    /**
     * 实时工具事件：持久日志要等回合结束才写 turn_message，界面在调用进行中
     * 只能靠这里知道工具正在跑。文本截断，完整内容随后随消息落盘。
     */
    function forwardToolEvent(event: UIEvent): void {
        if (event.type === "tool_start") {
            notify("session/tool", { call: {
                callId: event.callId, name: event.name, state: "running",
                input: truncateToolText(JSON.stringify(event.args ?? null)),
            } });
            return;
        }
        if (event.type === "tool_result") {
            notify("session/tool", { call: {
                callId: event.callId, name: event.name, durationMs: event.durationMs,
                output: truncateToolText(event.summary), state: event.isError ? "failed" : "succeeded",
            } });
        }
    }

    function truncateToolText(text: string): string {
        return text.length > TOOL_TEXT_MAX_CHARS ? `${text.slice(0, TOOL_TEXT_MAX_CHARS)}…` : text;
    }

    const previousOnReleased = host.onSessionReleased;
    host.onSessionReleased = (changedId, cause) => {
        previousOnReleased?.(changedId, cause);
        if (changedId === sessionId) checkOwnership();
    };
    const ownershipTimer = setInterval(checkOwnership, options.ownershipCheckMs ?? 1000);
    ownershipTimer.unref();
    const unregisterRuntime = options.registerRuntime?.(notify,
        id => id === sessionId && !hasLostOwnership && host.isSessionClaimed(id));

    /** 自建会话并认领：失败后该进程不再持有顶层会话。 */
    async function createTopSession(): Promise<string> {
        const created = await host.createSession(options.cwd);
        const claim = await host.claimSession(created.sessionId, { noNegotiate: true });
        if (!claim.ok) throw new ProtocolError(-32000, `无法认领新会话: ${describeClaimFailure(claim)}`);
        return created.sessionId;
    }

    /** 恢复目标只接受完整 ULID（Crockford Base32 大小写写法都认，统一大写口径）。 */
    function normalizeResumeId(rawId: unknown): string {
        if (typeof rawId !== "string") throw new ProtocolError(-32602, "session/resume 需要 string sessionId");
        const targetId = rawId.trim().toUpperCase();
        if (!isUlid(targetId)) throw new ProtocolError(-32602, "sessionId 必须是完整 ULID");
        return targetId;
    }

    /**
     * 恢复既有会话：先确认磁盘上真存在；归档态先取消归档（认领要求可写），
     * 再以不协商方式认领（绝不抢锁）；认领失败则重新归档，避免破坏原状态。
     */
    async function resumeTopSession(targetId: string): Promise<string> {
        // 磁盘上的会话摘要就是存在性事实源（只列已落盘的会话，空壳子会话没有可恢复的内容）
        const exists = (await host.listSessions()).some(summary => summary.sessionId === targetId);
        if (!exists) throw new ProtocolError(-32000, `会话不存在: ${targetId}`);
        const wasArchived = await host.isSessionArchived(targetId);
        if (wasArchived) await host.unarchiveSession(targetId);
        const claim = await host.claimSession(targetId, { noNegotiate: true });
        if (!claim.ok) {
            if (wasArchived) {
                await host.closeSession(targetId).catch(() => undefined);
            }
            throw new ProtocolError(-32000, `无法恢复会话: ${describeClaimFailure(claim)}`);
        }
        // 空会话也要有可恢复的事实：补一条 session_created。
        await host.ensureSessionCreated?.(targetId);
        return targetId;
    }

    async function execute(method: string, params: Record<string, unknown>): Promise<unknown> {
        const allowedParams: Record<string, string[]> = {
            initialize: ["version"], "session/create": [], "session/resume": ["sessionId"], "session/send": ["text"],
            "session/cancel": [], "session/status": [], "session/archive": [], "session/unarchive": [], shutdown: [],
        };
        const allowedKeys = Object.hasOwn(allowedParams, method) ? allowedParams[method] : undefined;
        if (!allowedKeys) throw new ProtocolError(-32601, `未知方法: ${method}`);
        if (Object.keys(params).some(key => !allowedKeys.includes(key))) {
            throw new ProtocolError(-32602, `${method} 不接受额外参数或外部 target`);
        }
        if (method === "initialize") {
            if (isInitialized) throw new ProtocolError(-32000, "已经 initialize");
            const isVersionValid = params.version === 1 && Object.keys(params).every(key => key === "version");
            if (!isVersionValid) throw new ProtocolError(-32602, "仅支持协议 version: 1");
            isInitialized = true;
            return { version: 1, instanceId };
        }
        if (!isInitialized) throw new ProtocolError(-32000, "请先 initialize");
        const hasOwnership = checkOwnership();
        if (method === "session/status") return status();
        if (!hasOwnership) throw new ProtocolError(-32002, "当前实例已失去顶层会话持有权");
        if (method === "shutdown") {
            return {};
        }
        if (method === "session/create" || method === "session/resume") {
            // 先校验参数（错误一律 -32602，不消费这一次机会）；认领失败则不再重试，避免反复抢锁
            const resumeId = method === "session/resume" ? normalizeResumeId(params.sessionId) : undefined;
            if (hasTopSession) throw new ProtocolError(-32000, "一个进程仅能创建或恢复一次顶层会话");
            hasTopSession = true;
            const topId = resumeId === undefined ? await createTopSession() : await resumeTopSession(resumeId);
            // 新建的空会话也落一条创建事实：否则进程重启后无法证明它存在。
            await host.ensureSessionCreated?.(topId);
            sessionId = topId;
            if (!checkOwnership()) throw new ProtocolError(-32002, "顶层会话持有权校验失败");
            return { sessionId: topId, instanceId };
        }
        if (method === "session/archive") {
            if (!sessionId) throw new ProtocolError(-32000, "没有可归档的顶层会话");
            const targetId = sessionId;
            if (turn || host.isSessionBusy(targetId)) {
                throw new ProtocolError(-32001, "会话正在执行回合，暂不能归档");
            }
            // closeSession 即归档（落 session_archived）；随后释放持有权，进程仍可继续 shutdown
            await host.closeSession(targetId);
            // 先摘掉顶层身份，release 回调才不会把它判成"失去持有权"而收尾
            sessionId = undefined;
            archivedSessionId = targetId;
            host.releaseSession(targetId, { cause: "archive" });
            return { archived: true };
        }
        if (method === "session/unarchive") {
            const targetId = sessionId ?? archivedSessionId;
            if (!targetId) throw new ProtocolError(-32000, "没有可取消归档的会话");
            if (!await host.isSessionArchived(targetId)) throw new ProtocolError(-32000, `会话未归档: ${targetId}`);
            await host.unarchiveSession(targetId);
            return { unarchived: true };
        }
        if (!sessionId) throw new ProtocolError(-32000, "请先 session/create 或 session/resume");
        if (method === "session/cancel") {
            if (turn) turn.isCancelRequested = true;
            await host.abortSession(sessionId);
            return { requested: true };
        }
        if (typeof params.text !== "string" || !params.text.trim()) {
            throw new ProtocolError(-32602, "session/send 仅接受非空 text");
        }
        if (turn) throw new ProtocolError(-32001, "会话正在执行回合");
        turn = { hasCommit: false, isCancelRequested: false };
        return { accepted: true };
    }

    /**
     * 重放恢复目标的已存轮次：resume 只认领会话，不会再发一遍历史通知，
     * 客户端要看过往回合只能由这里补。按字节封批，避免单条通知超过传输上限。
     */
    async function replayHistory(): Promise<void> {
        const targetId = sessionId;
        if (!targetId || !options.readHistory || hasLostOwnership) return;
        let records: ReplayRecord[];
        try {
            records = await options.readHistory(targetId, HISTORY_MAX_EVENTS);
        } catch (error) {
            notify("session/status", {
                state: "history-failed",
                message: `重放历史失败: ${error instanceof Error ? error.message : String(error)}`,
            });
            return;
        }
        let batch: ReplayRecord[] = [];
        let batchBytes = 0;
        let skipped = 0;
        const flush = async (): Promise<void> => {
            if (batch.length === 0) return;
            notify("session/history", { replay: true, records: batch });
            batch = [];
            batchBytes = 0;
            // 等这一批写完再装下一批，别把有界输出队列填满。
            await writer.flush().catch(() => undefined);
        };
        for (const record of records) {
            if (sessionId !== targetId || hasLostOwnership || isStopping || transportError) return;
            const bytes = Buffer.byteLength(JSON.stringify(record));
            if (bytes > HISTORY_MAX_RECORD_BYTES) {
                skipped++;
                continue;
            }
            if (batchBytes + bytes > HISTORY_BATCH_BYTES) await flush();
            batch.push(record);
            batchBytes += bytes;
        }
        await flush();
        if (skipped > 0) {
            notify("session/status", {
                state: "history-truncated",
                message: `${skipped} 条过大的历史记录未重放`,
            });
        }
    }

    async function dispatch(line: string): Promise<void> {
        let id: string | number = "";
        try {
            let raw: unknown;
            try { raw = JSON.parse(line); }
            catch { throw new ProtocolError(-32700, "无效 JSON"); }
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProtocolError(-32600, "请求必须是对象");
            const request = raw as Record<string, unknown>;
            const hasValidId = typeof request.id === "string"
                || (typeof request.id === "number" && Number.isFinite(request.id));
            if (hasValidId) id = request.id as string | number;
            if (!hasValidId || typeof request.method !== "string") {
                throw new ProtocolError(-32600, "请求需要 string/number id 与 string method");
            }
            const params = objectParams(request.params);
            const result = await execute(request.method, params);
            await writer.write({ id, result });
            if (request.method === "shutdown") { stop(); return; }
            // 历史放在响应之后：客户端先拿到身份，再收到重放，不会把历史当成新会话的通知。
            if (request.method === "session/resume") void replayHistory();
            if (request.method !== "session/send") return;
            if (!checkOwnership()) return;
            const activeTurn = turn!;
            const ownId = sessionId!;
            void (async () => {
                let state = "done";
                try {
                    const outcome = await host.sendMessage(ownId, params.text as string);
                    if (outcome.aborted) state = "cancelled";
                } catch (error) {
                    state = activeTurn.isCancelRequested ? "cancelled" : "failed";
                    if (!activeTurn.hasCommit) notify("session/error", { message: error instanceof Error ? error.message : String(error) });
                } finally {
                    if (!activeTurn.hasCommit && !hasLostOwnership) notify("session/finished", { state });
                    turn = undefined;
                }
            })();
        } catch (error) {
            if (transportError) return;
            const code = error instanceof ProtocolError ? error.code : -32000;
            const message = error instanceof Error ? error.message : String(error);
            await writer.write({ id, error: { code, message } });
        }
    }

    try {
        if (options.signal?.aborted) stop();
        let pending = Buffer.alloc(0);
        for await (const chunk of input) {
            if (isStopping) break;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            pending = Buffer.concat([pending, bytes]);
            let newline: number;
            while (!isStopping && (newline = pending.indexOf(10)) !== -1) {
                if (newline > maxLineBytes) throw new Error("stdio 输入行超过上限");
                const line = pending.subarray(0, newline).toString("utf8");
                pending = pending.subarray(newline + 1);
                if (line.trim()) await dispatch(line);
            }
            if (pending.length > maxLineBytes) throw new Error("stdio 输入行超过上限");
        }
        if (!isStopping && pending.length && pending.toString("utf8").trim()) await dispatch(pending.toString("utf8"));
    } catch (error) {
        if (!isStopping) transportError = error instanceof Error ? error : new Error(String(error));
    } finally {
        isStopping = true;
        clearInterval(ownershipTimer);
        if (!hasLostOwnership) notify("session/status", { state: "closing" });
        try {
            options.onClosing?.();
            await host.close();
            await writer.flush();
        } finally {
            unregisterRuntime?.();
            unsubscribe();
            host.onEvent = previousOnEvent;
            host.onSessionReleased = previousOnReleased;
            options.signal?.removeEventListener("abort", onAbort);
            output.off("error", onOutputError);
        }
    }
    if (transportError) throw transportError;
}
