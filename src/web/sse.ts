/**
 * SSE 传输层：把「带 seq 游标的事件源」变成 text/event-stream。
 *
 * 与业务无关：会话执行流与 Job 状态流共用同一套回放、增量、心跳与清理逻辑，
 * 调用方只需提供 readSince（回放）与 subscribe（增量）。
 *
 * 衔接顺序必须是「先订阅、后回放」：回放期间到达的事件先入缓冲，回放结束后按 seq 去重补推，
 * 这样既不漏（订阅早于读盘）也不重（seq 单调过滤）。
 */

interface SseRecord {
    seq: number;
    /** 直接 JSON 序列化进 data 字段。 */
    payload: unknown;
}

export interface SseSource {
    /** 日志标签，只用于错误输出。 */
    label: string;
    /** 读 seq > since 的历史事件。 */
    readSince(since: number): Promise<SseRecord[]>;
    /** 订阅增量；listener 收到 null 表示时间轴被重置（客户端须丢弃游标）。 */
    subscribe(listener: (record: SseRecord | null) => void): () => void;
    /**
     * 订阅瞬态信号（如正在生成的正文）：帧不带 id，不参与游标，断线重连后由持久化事件补齐。
     * 只在"正在发生"时才推，历史回放不涉及。
     */
    subscribeLive?(listener: (frame: { event: string; data: string }) => void): () => void;
}

/**
 * 打开一条 SSE 响应。
 * 断线续传靠 id 字段（Last-Event-ID），重置事件用 `event: reset` + `id: 0`。
 */
export function openSseStream(
    source: SseSource,
    since: number,
    heartbeatMs: number,
    signal: AbortSignal,
): Response {
    const encoder = new TextEncoder();
    let dispose = (): void => {};

    const body = new ReadableStream<Uint8Array>({
        async start(controller) {
            let lastSeq = since;
            let replaying = true;
            let closed = false;
            let heartbeat: ReturnType<typeof setInterval> | undefined;
            let unsubscribeLive: (() => void) | undefined;
            const buffered: Array<SseRecord | null> = [];

            const write = (text: string): boolean => {
                if (closed) return false;
                try {
                    controller.enqueue(encoder.encode(text));
                    return true;
                } catch {
                    // 客户端已断开：中途层静默断连不会触发 cancel，这里兜住资源清理
                    return false;
                }
            };
            const send = (record: SseRecord | null): void => {
                if (record === null) {
                    // 时间轴重置：id 必须归零，否则浏览器会带着失效的 Last-Event-ID 重连且永久静默
                    lastSeq = 0;
                    if (!write("id: 0\nevent: reset\ndata: {}\n\n")) dispose();
                    return;
                }
                if (record.seq <= lastSeq) return;
                lastSeq = record.seq;
                if (!write(`id: ${record.seq}\ndata: ${JSON.stringify(record.payload)}\n\n`)) dispose();
            };

            const unsubscribe = source.subscribe(record => {
                if (replaying) buffered.push(record);
                else send(record);
            });

            const finish = (): void => {
                if (closed) return;
                closed = true;
                unsubscribe();
                unsubscribeLive?.();
                if (heartbeat) clearInterval(heartbeat);
                heartbeat = undefined;
                try {
                    controller.close();
                } catch {
                    // 已关闭
                }
            };
            dispose = finish;
            signal.addEventListener("abort", finish, { once: true });

            try {
                for (const record of await source.readSince(since)) {
                    if (closed) break;
                    send(record);
                }
            } catch (error) {
                // 注释帧只放固定文案：错误文本可能含换行，会破坏帧结构
                console.error(`[web] ${source.label} 事件回放失败:`, error);
                write(": 回放失败\n\n");
            }
            replaying = false;
            for (const record of buffered) {
                if (closed) break;
                send(record);
            }
            buffered.length = 0;

            // 回放结束后再接实时信号：历史与"正在发生"不混在一起，也不参与 seq 去重
            if (!closed && source.subscribeLive) {
                unsubscribeLive = source.subscribeLive(frame => {
                    if (!write(`event: ${frame.event}\ndata: ${frame.data}\n\n`)) dispose();
                });
            }

            // 回放期间已断开就别再建定时器：否则 interval 无人清理，会永久空转
            if (closed) return;
            heartbeat = setInterval(() => {
                if (!write(": ping\n\n")) dispose();
            }, heartbeatMs);
        },
        cancel() {
            dispose();
        },
    });

    return new Response(body, {
        headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
        },
    });
}

/** 解析 SSE 游标：Last-Event-ID 优先于 since，且必须是严格非负整数。 */
export function parseSseCursor(req: Request, url: URL): { since: number } | { error: string } {
    const headerId = req.headers.get("last-event-id")?.trim();
    const querySince = url.searchParams.get("since")?.trim();
    const raw = headerId || querySince || null;
    if (raw === null) return { since: 0 };
    if (!/^\d+$/.test(raw)) return { error: "since 必须是非负整数" };
    return { since: Number.parseInt(raw, 10) };
}
