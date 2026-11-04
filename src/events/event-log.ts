/**
 * 事件日志：append-only JSONL 文件，会话内 seq 递增，是会话状态的事实源。
 * 进程内缓存最后 seq，避免每次追加都扫文件尾。
 */

import fs from "fs";
import path from "path";
import { getSessionsDir } from "../utils/runtime-paths.js";
import { sanitizeSessionId } from "../utils/session-id.js";
import type { StreamDelta } from "../types/chat.js";
import type { AgentEvent, AgentEventPayloads, AgentEventType } from "./agent-events.js";

/** 从文件尾部回读的窗口：一次读这么多字节找最后一行，不够再往前翻一倍。 */
const TAIL_WINDOW_BYTES = 8 * 1024;
const TAIL_WINDOW_MAX_BYTES = 1024 * 1024;

/** 事件分页回读窗口：首屏要的是一屏数据，从 64 KB 起翻倍；比逐行扫全文件快得多。 */
const PAGE_WINDOW_BYTES = 64 * 1024;
const PAGE_WINDOW_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 流式片段聚合窗口：每这么久把缓冲里的片段落盘一次，把逐 token 写降成批量写。
 * 只按时间触发即可——pending 文件在进程活着时没有读取方，缓冲上限就等于这个窗口内
 * 产生的输出；崩溃时最多丢一个窗口的片段，而定稿内容由 turn_message 另外承载。
 */
const STREAM_FLUSH_MS = 1000;

/** pending 流文件的一行：一个请求里连续的若干 delta。片段不占主日志 seq。 */
interface StreamBatch {
    ts: string;
    turnId: string;
    requestIndex: number;
    deltas: StreamDelta[];
}

/** 单会话流式缓冲：active 是正在追加的批次，batches 是已封口待落盘的批次。 */
interface StreamState {
    active: StreamBatch | null;
    batches: StreamBatch[];
    timer: ReturnType<typeof setTimeout> | null;
    chain: Promise<void>;
}

/**
 * 持久化事件监听器：进程内前端（TUI / HTTP）各自订阅同一份事实源。
 * event 为 null 表示该会话的时间轴被重置（truncate / delete），
 * 订阅者必须丢弃已有游标，否则后续 seq 会小于旧游标而永久静默。
 */
export type EventLogListener = (sessionId: string, event: AgentEvent | null) => void;

/**
 * 轻量扫描得到的一条事件：行首字段总是可信，payload 只在调用方声明的类型上解码。
 * 因此它不能当 AgentEvent 用，只能喂给「只读少数类型 payload」的投影（如会话摘要）。
 */
export interface ScannedEvent {
    seq: number;
    ts: string;
    type: AgentEventType;
    /** 仅当该类型在 decodeTypes 里才有值。 */
    payload?: unknown;
}

export class EventLog {
    private readonly seqCache = new Map<string, number>();
    private readonly appendLocks = new Map<string, Promise<void>>();
    private readonly streamStates = new Map<string, StreamState>();
    /** 实时订阅者：只推持久化事件（新增即推），瞬态流式片段不在此列。 */
    private readonly listeners = new Set<EventLogListener>();

    /** 订阅持久化事件（append 成功后立即推送）；返回取消订阅函数。 */
    subscribe(listener: EventLogListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** 广播给所有订阅者；单个监听器抛错不影响其他监听器与写入流程。 */
    private emit(sessionId: string, event: AgentEvent | null): void {
        for (const listener of this.listeners) {
            try {
                listener(sessionId, event);
            } catch (error) {
                console.error("[EventLog] 事件监听器异常:", error);
            }
        }
    }

    private eventFilePath(sessionId: string): string {
        return path.join(getSessionsDir("events"), `${sanitizeSessionId(sessionId)}.jsonl`);
    }

    private streamFilePath(sessionId: string): string {
        return path.join(getSessionsDir("events"), `${sanitizeSessionId(sessionId)}.stream.jsonl`);
    }

    /** 会话当前最后 seq（无日志时 0）。支持 forceRefresh 绕过内存缓存重新读取磁盘。 */
    async lastSeq(sessionId: string, options?: { forceRefresh?: boolean }): Promise<number> {
        if (!options?.forceRefresh) {
            const cached = this.seqCache.get(sessionId);
            if (cached !== undefined) return cached;
        }

        const seq = await readLastSeqFromTail(this.eventFilePath(sessionId));
        this.seqCache.set(sessionId, seq);
        return seq;
    }

    /**
     * 追加一条流式片段：只进内存缓冲，按 STREAM_FLUSH_BYTES / STREAM_FLUSH_MS 批量落到
     * pending 流文件，既不进主日志也不占主日志 seq：
     * seq 是会话状态的时间轴，让逐 token 片段推进它会把 lastSeq 抬高，
     * 破坏「按 seq 尾部窗口回查」这类调用（如会话间结果扫描）。
     */
    async appendStreamDelta(
        sessionId: string,
        turnId: string,
        requestIndex: number,
        delta: StreamDelta,
    ): Promise<void> {
        const state = this.streamState(sessionId);
        if (!state.active || state.active.turnId !== turnId || state.active.requestIndex !== requestIndex) {
            this.sealBatch(state);
            state.active = {
                ts: new Date().toISOString(),
                turnId,
                requestIndex,
                deltas: [],
            };
        }

        const active = state.active;
        active.deltas.push(delta);
        this.scheduleFlush(sessionId, state);
    }

    /** 把缓冲里的流式片段立即落盘（消息定稿前、回合提交前、读取前调用）。 */
    async flushStream(sessionId: string): Promise<void> {
        const state = this.streamStates.get(sessionId);
        if (!state) return;
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
        this.sealBatch(state);
        if (state.batches.length === 0) return;

        const batches = state.batches;
        state.batches = [];
        const text = batches.map(batch => JSON.stringify(batch) + "\n").join("");
        state.chain = state.chain
            .then(() => fs.promises.appendFile(this.streamFilePath(sessionId), text, "utf8"))
            .catch(error => {
                // 流式片段只影响崩溃恢复，写失败不中断回合
                console.warn(`[EventLog] 流式片段落盘失败 (session=${sessionId}): ${error}`);
            });
        await state.chain;
    }

    /**
     * 回合定稿后剔除该回合的流式片段：pending 文件里其他未闭合回合的片段保留。
     * 文件清空即删除，常态下不残留任何流式数据。
     */
    async dropStream(sessionId: string, turnId: string): Promise<void> {
        await this.flushStream(sessionId);
        const filePath = this.streamFilePath(sessionId);
        const text = await readFileIfExists(filePath);
        if (!text) return;

        const kept: string[] = [];
        for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            let batch: StreamBatch;
            try {
                batch = JSON.parse(line) as StreamBatch;
            } catch {
                continue;
            }
            if (batch.turnId === turnId) continue;
            kept.push(line);
        }

        if (kept.length === 0) {
            await fs.promises.rm(filePath, { force: true });
            return;
        }
        const tempPath = `${filePath}.${process.pid}.tmp`;
        try {
            await fs.promises.writeFile(tempPath, kept.join("\n") + "\n", "utf8");
            await fs.promises.rename(tempPath, filePath);
        } finally {
            await fs.promises.rm(tempPath, { force: true });
        }
    }

    /** 丢弃会话全部流式片段（截断/删除会话时用）。 */
    async clearStream(sessionId: string): Promise<void> {
        const state = this.streamStates.get(sessionId);
        if (state?.timer) clearTimeout(state.timer);
        this.streamStates.delete(sessionId);
        await fs.promises.rm(this.streamFilePath(sessionId), { force: true });
    }

    private streamState(sessionId: string): StreamState {
        let state = this.streamStates.get(sessionId);
        if (!state) {
            state = { active: null, batches: [], timer: null, chain: Promise.resolve() };
            this.streamStates.set(sessionId, state);
        }
        return state;
    }

    /** 封口当前批次：后续 delta 属于新批次（换请求或换回合）。 */
    private sealBatch(state: StreamState): void {
        if (!state.active || state.active.deltas.length === 0) {
            state.active = null;
            return;
        }
        state.batches.push(state.active);
        state.active = null;
    }

    /** 静默 STREAM_FLUSH_MS 后落盘；定时器不阻止进程退出。 */
    private scheduleFlush(sessionId: string, state: StreamState): void {
        if (state.timer) return;
        state.timer = setTimeout(() => {
            state.timer = null;
            void this.flushStream(sessionId);
        }, STREAM_FLUSH_MS);
        state.timer.unref?.();
    }

    /** pending 流文件里的片段，展开成与主日志同形的 turn_stream_delta 事件。 */
    private async readStreamEvents(sessionId: string): Promise<AgentEvent[]> {
        if (this.streamStates.has(sessionId)) await this.flushStream(sessionId);
        const text = await readFileIfExists(this.streamFilePath(sessionId));
        if (!text) return [];

        const events: AgentEvent[] = [];
        for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            let batch: StreamBatch;
            try {
                batch = JSON.parse(line) as StreamBatch;
            } catch {
                console.warn(`[EventLog] 跳过损坏的流式片段行 (session=${sessionId}): ${line.slice(0, 120)}`);
                continue;
            }
            if (!Array.isArray(batch.deltas)) continue;
            batch.deltas.forEach(delta => {
                events.push({
                    // seq 在此只是占位，由 read 统一改写为「日志末尾」语义
                    seq: 0,
                    ts: batch.ts,
                    sessionId,
                    type: "turn_stream_delta",
                    payload: { turnId: batch.turnId, requestIndex: batch.requestIndex, delta },
                } as AgentEvent);
            });
        }
        return events;
    }

    /** 追加一条事件，返回带 seq 的完整事件。 */
    async append<T extends AgentEventType>(
        sessionId: string,
        type: T,
        payload: AgentEventPayloads[T],
    ): Promise<AgentEvent> {
        const previous = this.appendLocks.get(sessionId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>(resolve => { release = resolve; });
        const queued = previous.then(() => current);
        this.appendLocks.set(sessionId, queued);
        await previous;

        let appended: AgentEvent | undefined;
        try {
            const seq = (await this.lastSeq(sessionId)) + 1;
            const event = {
                seq,
                ts: new Date().toISOString(),
                sessionId,
                type,
                payload,
            } as AgentEvent;

            const filePath = this.eventFilePath(sessionId);
            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            await fs.promises.appendFile(filePath, JSON.stringify(event) + "\n", "utf8");
            this.seqCache.set(sessionId, seq);
            appended = event;
            return event;
        } finally {
            release();
            if (this.appendLocks.get(sessionId) === queued) this.appendLocks.delete(sessionId);
            // 广播放到锁释放之后：订阅者若在回调里 await 同一会话的 append，不会与本次写入互锁
            if (appended) this.emit(sessionId, appended);
        }
    }

    /**
     * 读取事件序列：fromSeq 起（默认从头），limit 限制条数（默认全部）。
     * 主日志之后并入 pending 流文件里的未闭合回合片段，使崩溃恢复与逐条落盘时行为一致。
     * 片段的 seq 统一取日志末尾值：它们只按 turnId 归组，不参与时间轴排序，
     * 这样 lastSeq 不会被逐 token 片段抬高。
     *
     * persistedOnly 跳过并入片段：对外接口（HTTP 事件流）只承诺带唯一 seq 的持久化事实，
     * 片段 seq 全等于日志末尾，既无法做游标也会让客户端按 seq 去重时丢帧。
     */
    async read(
        sessionId: string,
        fromSeq = 1,
        limit?: number,
        options: { persistedOnly?: boolean } = {},
    ): Promise<AgentEvent[]> {
        // 从尾部窗口回读：seq 单调递增，命中尾部窗口即可停，不必全量解析大会话日志。
        // 已知的最后 seq 用于校验尾部真实性（日志被外部改动时退化整文件扫描）。
        const events = await readEventsFromSeq(
            this.eventFilePath(sessionId),
            fromSeq,
            limit,
            await this.lastSeq(sessionId),
        );

        if (options.persistedOnly) return events;

        // 已达 limit 或 fromSeq 越过日志末尾时，片段排在更后面，不必读盘
        if (limit !== undefined && events.length >= limit) return events;
        const baseSeq = events.length > 0 ? events[events.length - 1].seq : 0;
        if (events.length > 0 && fromSeq > baseSeq) return events;

        const pending = await this.readStreamEvents(sessionId);
        for (const event of pending) event.seq = baseSeq;
        return pending.length === 0 ? events : events.concat(pending);
    }

    /**
     * 逆序取一页事件：返回 seq < beforeSeq 的最后 count 条，按 seq 升序。
     * 只看主日志（HTTP 接口承诺的只有带唯一 seq 的持久化事实）。
     */
    async readBefore(sessionId: string, beforeSeq: number, count: number): Promise<AgentEvent[]> {
        if (count <= 0) return [];
        return readEventsBackward(this.eventFilePath(sessionId), beforeSeq, count);
    }

    /**
     * 轻量全量扫描主日志：逐行只解析行首（seq/ts/type），只对 decodeTypes 命中的行做完整解析。
     *
     * 给「需要每一行时间戳、但只关心少数事件类型 payload」的投影用（会话摘要）：真实日志里
     * 约 99.9% 的字节属于 turn_message / turn_segment_start 这类与摘要无关的大事件，
     * 逐行 JSON.parse 它们纯属浪费，而摘要要的 ts/type 在行首就能可靠读到。
     *
     * 返回 null 表示「行首形状不认识」（编码顺序变了、日志被外部按别的格式改写）：
     * 调用方必须回退全量读取，不能拿半懂的数据当摘要。
     *
     * 语义与 read(..., { persistedOnly: true }) 对齐：不并入 pending 流片段；
     * 空行忽略；损坏行跳过并告警（半行写不进去的尾部 append 是唯一现实来源）。
     * 已知边界：极端截断恰好落在嵌套 `}` 之后时，行首仍然可读，这一行会被收下；
     * 摘要只用该行的 ts（与同一回合其它事件同源），不会因此伪造出别的字段。
     */
    async scan(sessionId: string, decodeTypes: ReadonlySet<string>): Promise<ScannedEvent[] | null> {
        const filePath = this.eventFilePath(sessionId);
        const text = await readFileIfExists(filePath);
        if (!text) return [];

        const records: ScannedEvent[] = [];
        for (const line of text.split("\n")) {
            // 空行是常态（每行都以 \n 结尾），先走零分配的快路径，空白行再退回去 trim
            if (line === "") continue;
            const head = parseEventLineHead(line);
            if (!head) {
                if (line.trim() === "") continue;
                return null;
            }
            // 行首可读但整行不完整（append 中断留下的半行）：与全量读取一致地跳过
            if (!line.endsWith("}") && !line.trimEnd().endsWith("}")) {
                console.warn(`[EventLog] 跳过损坏事件行 (${path.basename(filePath)}): ${line.slice(0, 120)}`);
                continue;
            }
            if (!decodeTypes.has(head.type)) {
                records.push(head);
                continue;
            }
            let payload: unknown;
            try {
                payload = JSON.parse(line).payload;
            } catch {
                console.warn(`[EventLog] 跳过损坏事件行 (${path.basename(filePath)}): ${line.slice(0, 120)}`);
                continue;
            }
            records.push({ ...head, payload });
        }
        return records;
    }

    /** 截断日志到 upToSeq（时间点恢复 = 该点之后的未来全部作废）。 */
    async truncate(sessionId: string, upToSeq: number): Promise<void> {
        const filePath = this.eventFilePath(sessionId);
        const text = await readFileIfExists(filePath);
        if (!text) return;

        const keptLines: string[] = [];
        for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            try {
                const event = JSON.parse(line) as AgentEvent;
                if (event.seq <= upToSeq) keptLines.push(line);
            } catch {
                continue;
            }
        }
        await fs.promises.writeFile(filePath, keptLines.join("\n") + "\n", "utf8");
        this.seqCache.set(sessionId, upToSeq);
        // 截断到过去：pending 里的流式片段属于被作废的未来回合
        await this.clearStream(sessionId);
        this.emit(sessionId, null);
    }

    /** 删除会话的完整事件日志（/delete 彻底删除）。 */
    async delete(sessionId: string): Promise<void> {
        try {
            await fs.promises.unlink(this.eventFilePath(sessionId));
        } catch (error: any) {
            if (error?.code !== "ENOENT") throw error;
        }
        this.seqCache.delete(sessionId);
        await this.clearStream(sessionId);
        this.emit(sessionId, null);
    }

    /** 清掉某会话的 seq 缓存（日志已在外部删除时用）。 */
    forget(sessionId: string): void {
        this.seqCache.delete(sessionId);
        this.streamStates.delete(sessionId);
    }

}

/**
 * 只读文件尾部求最后一条事件的 seq：大会话日志可达十几 MB，全量读入再逐行解析
 * 只为取一个数字，首次打开会卡顿并吃掉数十 MB 内存。这里从尾部按窗口回读，找到
 * 第一条有效事件即返回；窗口内没有（尾巴是超长行或大量损坏行）就往前翻倍。
 */
async function readLastSeqFromTail(filePath: string): Promise<number> {
    let handle: fs.promises.FileHandle;
    try {
        handle = await fs.promises.open(filePath, "r");
    } catch (error: any) {
        if (error?.code === "ENOENT") return 0;
        throw error;
    }

    try {
        let { size } = await handle.stat();
        let window = TAIL_WINDOW_BYTES;
        let rest = "";
        while (size > 0) {
            const length = Math.min(window, size);
            const start = size - length;
            const buffer = Buffer.allocUnsafe(length);
            const { bytesRead } = await handle.read(buffer, 0, length, start);
            // rest 是上次已读部分里属于最后一行之后的内容，需与本次拼接
            const text = buffer.subarray(0, bytesRead).toString("utf8") + rest;
            const lines = text.split("\n");
            // 窗口没覆盖到文件头时，首行很可能是被截断的半行
            const skipFirst = start > 0;
            for (let index = lines.length - 1; index >= (skipFirst ? 1 : 0); index--) {
                const seq = parseSeq(lines[index]);
                if (seq !== undefined) return seq;
            }
            if (!skipFirst) break;
            // 整窗都没有有效事件：保留首行（可能是跨窗口的一条）继续往前
            rest = lines[0];
            size = start;
            if (window >= TAIL_WINDOW_MAX_BYTES) {
                // 兜底：窗口已达上限，换整文件扫描，保证结果正确而非静默返回 0
                return await scanWholeFileForLastSeq(filePath);
            }
            window *= 2;
        }
        return 0;
    } finally {
        await handle.close();
    }
}

/** 解析一行事件；空行、损坏行与非法 seq 都返回 undefined。 */
function parseEventLine(line: string | undefined): AgentEvent | undefined {
    if (!line || !line.trim()) return undefined;
    try {
        const event = JSON.parse(line) as AgentEvent;
        return Number.isSafeInteger(event.seq) ? event : undefined;
    } catch {
        return undefined;
    }
}

/** 解析一行事件取出 seq；空行或损坏行返回 undefined。 */
function parseSeq(line: string | undefined): number | undefined {
    return parseEventLine(line)?.seq;
}

/**
 * append 写入的行首固定形状：`{"seq":N,"ts":"...","sessionId":"...","type":"...","payload":...}`。
 * 只读前缀与 JSON.parse 后取这几个字段等价（同一份字节），因此不必解析整行。
 * 形状不匹配（键序变化、外部改写、半行）一律返回 undefined，由调用方回退全量读取。
 */
function parseEventLineHead(line: string): ScannedEvent | undefined {
    const match = /^\{"seq":(\d+),"ts":"([^"\\]*)","sessionId":"([^"\\]*)","type":"([A-Za-z0-9_]+)"/.exec(line);
    if (!match) return undefined;
    const seq = Number(match[1]);
    if (!Number.isSafeInteger(seq)) return undefined;
    return { seq, ts: match[2]!, type: match[4]! as AgentEventType };
}

/**
 * 从 fromSeq 起正向读事件（最多 limit 条），按尾部窗口回读。
 *
 * 日志 seq 单调递增，所以从文件尾往前扫到「第一条 seq < fromSeq」就可以停：
 * 常驻进程的增量读（如只查最新一条）只碰末尾一个窗口，不必解析几十 MB 的历史。
 */
async function readEventsFromSeq(
    filePath: string,
    fromSeq: number,
    limit?: number,
    expectedLastSeq?: number,
): Promise<AgentEvent[]> {
    let handle: fs.promises.FileHandle;
    try {
        handle = await fs.promises.open(filePath, "r");
    } catch (error: any) {
        if (error?.code === "ENOENT") return [];
        throw error;
    }

    try {
        const { size } = await handle.stat();
        let pos = size;
        let window = PAGE_WINDOW_BYTES;
        let rest = Buffer.alloc(0);
        const collected: AgentEvent[] = [];
        let reachedEarlier = false;
        let previousSeq = Number.POSITIVE_INFINITY;
        let monotonic = true;
        let firstSeq: number | undefined;

        while (pos > 0 && !reachedEarlier) {
            const start = Math.max(0, pos - window);
            const length = pos - start;
            const buffer = Buffer.allocUnsafe(length);
            const { bytesRead } = await handle.read(buffer, 0, length, start);
            if (bytesRead < length) {
                // 读期间文件被其他实例截断：已收集的后缀仍然有效，不再往前读
                pos = 0;
                break;
            }
            // 按字节拼接再切行：逐窗 toString('utf8') 会把跨窗口边界的多字节字符解成 U+FFFD，
            // 事务日志被静默改坏后重放不再确定，且坏内容会进入下一轮上下文。
            const chunk = Buffer.concat([buffer.subarray(0, bytesRead), rest]);
            let bodyStart = 0;
            if (start > 0) {
                const firstNewline = chunk.indexOf(0x0A);
                bodyStart = firstNewline === -1 ? chunk.length : firstNewline + 1;
            }
            rest = Buffer.from(chunk.subarray(0, bodyStart));
            const lines = chunk.subarray(bodyStart).toString("utf8").split("\n");

            for (let index = lines.length - 1; index >= 0; index--) {
                const event = parseEventLine(lines[index]);
                if (!event) continue;
                if (firstSeq === undefined) firstSeq = event.seq;
                // 逆序遍历时 seq 必须单调不增；否则尾部窗口的「遇到更早即停」不成立
                if (event.seq > previousSeq) monotonic = false;
                previousSeq = event.seq;
                if (event.seq < fromSeq) {
                    reachedEarlier = true;
                    break;
                }
                collected.push(event);
            }

            pos = start;
            window = Math.min(window * 2, PAGE_WINDOW_MAX_BYTES);
        }

        // seq 连续递增是事实源的不变量：从尾部往前扫到的最后一条应当正好是 fromSeq，
        // 且尾部第一条应当就是已知的最后 seq。任一不成立（缺口、非单调、日志被外部改动）
        // 都说明尾部窗口的前缀假设不成立，退化整文件扫描，宁可一次全量也不静默漏事件。
        const oldestSeq = collected.at(-1)?.seq;
        const tailTampered = expectedLastSeq !== undefined
            && expectedLastSeq > 0
            && firstSeq !== undefined
            && firstSeq < expectedLastSeq;
        if (!monotonic || tailTampered || (oldestSeq !== undefined && oldestSeq > fromSeq)) {
            return readEventsWholeFile(filePath, fromSeq, limit);
        }

        collected.reverse();
        // limit 不能提前收敛：要返回 fromSeq 起最早的 limit 条，必须先定位到 fromSeq 边界
        return limit !== undefined && collected.length > limit ? collected.slice(0, limit) : collected;
    } finally {
        await handle.close();
    }
}

/** 整文件扫描读事件：尾部窗口的兜底（seq 非单调时）与损坏行提示。 */
async function readEventsWholeFile(
    filePath: string,
    fromSeq: number,
    limit?: number,
): Promise<AgentEvent[]> {
    const text = await readFileIfExists(filePath);
    if (!text) return [];

    const events: AgentEvent[] = [];
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let event: AgentEvent;
        try {
            event = JSON.parse(line);
        } catch {
            // 追加中断可能留下半行，跳过损坏行，不阻断整条日志
            console.warn(`[EventLog] 跳过损坏事件行 (${path.basename(filePath)}): ${line.slice(0, 120)}`);
            continue;
        }
        if (!Number.isSafeInteger(event.seq) || event.seq < fromSeq) continue;
        events.push(event);
        if (limit !== undefined && events.length >= limit) break;
    }
    return events;
}

/**
 * 从文件尾部逆序回读一页事件，返回升序结果。
 *
 * 收够 count 条之后还要再往前跨一个回合收尾（turn_commit）才停：切点落在回合边界上，
 * 时间线首屏才不会以"半截回合"（孤立的工具结果）开头。文件里没有 turn_commit 时读到头为止。
 */
async function readEventsBackward(
    filePath: string,
    beforeSeq: number,
    count: number,
): Promise<AgentEvent[]> {
    let handle: fs.promises.FileHandle;
    try {
        handle = await fs.promises.open(filePath, "r");
    } catch (error: any) {
        if (error?.code === "ENOENT") return [];
        throw error;
    }

    try {
        const { size } = await handle.stat();
        let pos = size;
        let window = PAGE_WINDOW_BYTES;
        let rest = Buffer.alloc(0);
        const collected: AgentEvent[] = [];
        let done = false;

        while (pos > 0 && !done) {
            const start = Math.max(0, pos - window);
            const length = pos - start;
            const buffer = Buffer.allocUnsafe(length);
            const { bytesRead } = await handle.read(buffer, 0, length, start);
            if (bytesRead < length) break;
            // 按字节拼接后切行：跨窗口边界的多字节字符不能逐窗解码，否则会被解成 U+FFFD
            const chunk = Buffer.concat([buffer.subarray(0, bytesRead), rest]);
            let bodyStart = 0;
            if (start > 0) {
                // 窗口没覆盖到文件头时，首行很可能是被截断的半行，留给下一轮拼接
                const firstNewline = chunk.indexOf(0x0A);
                bodyStart = firstNewline === -1 ? chunk.length : firstNewline + 1;
            }
            rest = Buffer.from(chunk.subarray(0, bodyStart));
            const lines = chunk.subarray(bodyStart).toString("utf8").split("\n");

            for (let index = lines.length - 1; index >= 0; index--) {
                const event = parseEventLine(lines[index]);
                if (!event || event.seq >= beforeSeq) continue;
                if (collected.length >= count && event.type === "turn_commit") {
                    done = true;
                    break;
                }
                collected.push(event);
            }

            pos = start;
            window = Math.min(window * 2, PAGE_WINDOW_MAX_BYTES);
        }

        collected.reverse();
        return collected;
    } finally {
        await handle.close();
    }
}

/** 尾部回读放弃时的整文件兜底：只保留最大值，不保留解析结果。 */
async function scanWholeFileForLastSeq(filePath: string): Promise<number> {
    const text = await readFileIfExists(filePath);
    if (!text) return 0;
    let seq = 0;
    for (const line of text.split("\n")) {
        const value = parseSeq(line);
        if (value !== undefined && value > seq) seq = value;
    }
    return seq;
}

async function readFileIfExists(filePath: string): Promise<string | null> {
    try {
        return await fs.promises.readFile(filePath, "utf8");
    } catch (error: any) {
        if (error?.code === "ENOENT") return null;
        throw error;
    }
}
