/**
 * HTTP 前端协议测试：用轻量 stub host 验证路由、鉴权、游标与事件流衔接。
 * 真实 turn 会打上游模型，不在这一层测；host 行为由 host 自己的测试覆盖。
 */

import { describe, expect, spyOn, test } from "bun:test";
import type { AgentEvent } from "../events/agent-events.js";
import type { SessionSummary } from "../host/session-host-types.js";
import type { SessionApiHost } from "./http-server.js";
import { startHttpServer, type HttpServerHandle } from "./http-server.js";

const TOKEN = "test-token";

interface StubCalls {
    claimed: string[];
    sent: Array<{ sessionId: string; text: string }>;
    cancelled: string[];
    /** readSessionEventsSince 收到的 after：断言游标真的被透传，而不是始终从头读。 */
    sinceCalls: number[];
    /** 自动取消归档调用的会话 id。 */
    unarchived: string[];
}

interface StubHost {
    host: SessionApiHost;
    calls: StubCalls;
    /** 手动推一条实时事件（null 表示时间轴重置）。 */
    emit(sessionId: string, event: AgentEvent | null): void;
    /** 当前订阅者数量，用于验证断连后清理。 */
    listenerCount(): number;
}

function createStubHost(
    options: { busy?: boolean; history?: AgentEvent[]; claimed?: boolean; heldByOther?: boolean; archived?: boolean } = {},
): StubHost {
    const calls: StubCalls = { claimed: [], sent: [], cancelled: [], sinceCalls: [], unarchived: [] };
    const listeners = new Set<(sessionId: string, event: AgentEvent | null) => void>();
    const summary = (sessionId: string): SessionSummary => ({ sessionId, messageCount: 0 });

    const host = {
        listSessions: async () => [summary("s1")],
        listActiveSessionIds: () => ["s1"],
        createSession: async () => ({ sessionId: "s-new" }),
        renameSession: async () => {},
        isSessionClaimed: () => options.claimed ?? true,
        probeSession: async () => (options.heldByOther ? { state: "other" } : { state: "free" }),
        claimSession: async (sessionId: string) => {
            calls.claimed.push(sessionId);
            return { ok: true };
        },
        readSessionEventsSince: async (_sessionId: string, after: number) => {
            calls.sinceCalls.push(after);
            return (options.history ?? []).filter(event => event.seq > after);
        },
        subscribeEvents: (listener: (sessionId: string, event: AgentEvent | null) => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        isSessionBusy: () => options.busy ?? false,
        isSessionArchived: async () => options.archived ?? false,
        unarchiveSession: async (sessionId: string) => {
            calls.unarchived.push(sessionId);
        },
        sendMessage: async (sessionId: string, text: string) => {
            calls.sent.push({ sessionId, text });
            return {};
        },
        abortSession: async (sessionId: string) => {
            calls.cancelled.push(sessionId);
            return true;
        },
        close: async () => {},
    } as unknown as SessionApiHost;

    return {
        host,
        calls,
        emit: (sessionId, event) => {
            for (const listener of listeners) listener(sessionId, event);
        },
        listenerCount: () => listeners.size,
    };
}

function event(seq: number, sessionId = "s1"): AgentEvent {
    return {
        seq,
        ts: new Date(0).toISOString(),
        sessionId,
        // 用界面会渲染的类型：HTTP 层会过滤掉 turn_segment_start 这类内部事件
        type: "context_compacted",
        payload: {},
    } as AgentEvent;
}

/** 起一个只监听回环、端口由系统分配的实例。 */
function web(host: SessionApiHost, heartbeatMs = 60_000): HttpServerHandle {
    return startHttpServer({ host, port: 0, token: TOKEN, heartbeatMs });
}

async function call(handle: HttpServerHandle, path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${handle.url}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    });
}

/** 增量读取 SSE：可分段读而不必提前断开。 */
function openFrameReader(res: Response): {
    read(count: number, timeoutMs?: number): Promise<string[]>;
    close(): Promise<void>;
} {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    return {
        async read(count, timeoutMs = 2_000) {
            const frames: string[] = [];
            const deadline = Date.now() + timeoutMs;
            while (frames.length < count && Date.now() < deadline) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                for (let index = buffer.indexOf("\n\n"); index !== -1; index = buffer.indexOf("\n\n")) {
                    frames.push(buffer.slice(0, index));
                    buffer = buffer.slice(index + 2);
                    if (frames.length >= count) break;
                }
            }
            return frames;
        },
        async close() {
            await reader.cancel();
        },
    };
}

/** 断连到 cancel 回调之间隔了事件循环，轮询等待订阅清理完成。 */
async function waitForListenerCleanup(stub: StubHost): Promise<number> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
        if (stub.listenerCount() === 0) break;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    return stub.listenerCount();
}

describe("http-server 鉴权与路由", () => {
    test("缺令牌与错误令牌都返回 401，query 令牌可用", async () => {
        const { host } = createStubHost();
        const handle = web(host);
        try {
            expect((await fetch(`${handle.url}/api/healthz`)).status).toBe(401);
            expect((await fetch(`${handle.url}/api/healthz`)).status).toBe(401);
            expect(
                (
                    await fetch(`${handle.url}/api/healthz`, {
                        headers: { authorization: "Bearer wrong" },
                    })
                ).status,
            ).toBe(401);
            // 只认 header：URL 令牌不再接受（会被缓存/写进历史/进 Referer）
            expect((await fetch(`${handle.url}/api/healthz?token=${TOKEN}`)).status).toBe(401);
            expect((await fetch(`${handle.url}/api/healthz`, {
                headers: { authorization: `Bearer ${TOKEN}` },
            })).status).toBe(200);
        } finally {
            await handle.stop();
        }
    });

    test("未知路径 404，端点清单在 /endpoints", async () => {
        const { host } = createStubHost();
        const handle = web(host);
        try {
            expect((await call(handle, "/api/nope")).status).toBe(404);
            const endpoints = await call(handle, "/api/endpoints");
            expect(endpoints.status).toBe(200);
            expect((await endpoints.json() as { endpoints: string[] }).endpoints.length).toBeGreaterThan(0);
            // 没启用 Job 调度时不提供界面
            expect((await call(handle, "/")).status).toBe(404);
        } finally {
            await handle.stop();
        }
    });
});

describe("http-server 会话接口", () => {
    test("创建会话后立即认领（命令行也能投递）", async () => {
        const { host, calls } = createStubHost();
        const handle = web(host);
        try {
            const res = await call(handle, "/api/sessions", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ title: "任务 A" }),
            });

            expect(res.status).toBe(201);
            expect((await res.json() as { sessionId: string }).sessionId).toBe("s-new");
            expect(calls.claimed).toEqual(["s-new"]);
        } finally {
            await handle.stop();
        }
    });

    test("wait=true 等到回合结束并回结果", async () => {
        const { host, calls } = createStubHost();
        const handle = web(host);
        try {
            const res = await call(handle, "/api/sessions/s1/messages", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: "跑测试", wait: true }),
            });

            expect(res.status).toBe(200);
            expect(await res.json()).toMatchObject({ ok: true, sessionId: "s1" });
            expect(calls.sent).toEqual([{ sessionId: "s1", text: "跑测试" }]);
        } finally {
            await handle.stop();
        }
    });

    test("未持有时先认领再发消息", async () => {
        const { host, calls } = createStubHost({ claimed: false });
        const handle = web(host);
        try {
            const res = await call(handle, "/api/sessions/s1/messages", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: "投递", wait: true }),
            });

            expect(res.status).toBe(200);
            expect(calls.claimed).toEqual(["s1"]);
            expect(calls.sent.length).toBe(1);
        } finally {
            await handle.stop();
        }
    });

    test("会话被其他实例持有时拒绝投递，不夺权", async () => {
        const { host, calls } = createStubHost({ claimed: false, heldByOther: true });
        const handle = web(host);
        try {
            const res = await call(handle, "/api/sessions/s1/messages", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: "投递", wait: true }),
            });

            expect(res.status).toBe(409);
            expect(calls.claimed).toEqual([]);
            expect(calls.sent).toEqual([]);
        } finally {
            await handle.stop();
        }
    });

    test("不带 wait 返回 202，空 text 400，忙时 409", async () => {
        const idle = createStubHost();
        const idleHandle = web(idle.host);
        try {
            const accepted = await call(idleHandle, "/api/sessions/s1/messages", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: "后台跑" }),
            });
            expect(accepted.status).toBe(202);

            const empty = await call(idleHandle, "/api/sessions/s1/messages", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: "   " }),
            });
            expect(empty.status).toBe(400);
        } finally {
            await idleHandle.stop();
        }

        const busy = createStubHost({ busy: true });
        const busyHandle = web(busy.host);
        try {
            const res = await call(busyHandle, "/api/sessions/s1/messages", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: "并发任务" }),
            });
            expect(res.status).toBe(409);
        } finally {
            await busyHandle.stop();
        }
    });

    test("取消投递到 host", async () => {
        const { host, calls } = createStubHost();
        const handle = web(host);
        try {
            const res = await call(handle, "/api/sessions/s1/cancel", { method: "POST" });

            expect(await res.json()).toMatchObject({ cancelled: true, sessionId: "s1" });
            expect(calls.cancelled).toEqual(["s1"]);
        } finally {
            await handle.stop();
        }
    });

    test("归档会话发送消息时自动取消归档，再照常入队", async () => {
        const stub = createStubHost({ archived: true });
        const handle = web(stub.host);
        try {
            const res = await call(handle, "/api/sessions/s-archived/inputs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: "继续", mode: "request" }),
            });
            const body = await res.json() as { started: boolean; unarchived?: boolean };

            expect(res.status).toBe(202);
            expect(body.unarchived).toBe(true);
            // 先取消归档再发，顺序不能反
            expect(stub.calls.unarchived).toEqual(["s-archived"]);
            expect(stub.calls.sent.map(item => item.text)).toEqual(["继续"]);
        } finally {
            await handle.stop();
        }
    });

    test("随时输入：空闲直接开跑，忙则按模式排队并可查询", async () => {
        const idle = createStubHost();
        const idleHandle = web(idle.host);
        try {
            const res = await call(idleHandle, "/api/sessions/sess-idle/inputs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: "补充一句" }),
            });
            expect(res.status).toBe(202);
            expect((await res.json() as { started: boolean }).started).toBe(true);
            expect(idle.calls.sent).toEqual([{ sessionId: "sess-idle", text: "补充一句" }]);
        } finally {
            await idleHandle.stop();
        }

        const busy = createStubHost({ busy: true });
        const busyHandle = web(busy.host);
        try {
            const queued = await call(busyHandle, "/api/sessions/sess-busy/inputs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: "下轮再带上", mode: "turn" }),
            });
            expect((await queued.json() as { queued: boolean }).queued).toBe(true);

            const stats = await call(busyHandle, "/api/sessions/sess-busy/inputs");
            expect(await stats.json()).toEqual({ request: 0, turn: 1 });
        } finally {
            await busyHandle.stop();
        }
    });
});

describe("http-server 事件流", () => {
    test("events 一次性 JSON 把 since 透传给 host 并按游标过滤", async () => {
        const { host, calls } = createStubHost({ history: [event(1), event(2), event(3)] });
        const handle = web(host);
        try {
            const res = await call(handle, "/api/sessions/s1/events?since=2");
            const events = await res.json() as AgentEvent[];

            expect(calls.sinceCalls).toEqual([2]);
            expect(events.map(item => item.seq)).toEqual([3]);
        } finally {
            await handle.stop();
        }
    });

    test("since 非整数返回 400", async () => {
        const { host } = createStubHost();
        const handle = web(host);
        try {
            expect((await call(handle, "/api/sessions/s1/events?since=5abc")).status).toBe(400);
            expect((await call(handle, "/api/sessions/s1/events?since=-1")).status).toBe(400);
        } finally {
            await handle.stop();
        }
    });

    test("Last-Event-ID 头优先于 since", async () => {
        const { host, calls } = createStubHost({ history: [event(1), event(2)] });
        const handle = web(host);
        try {
            // Last-Event-ID 是游标语义，仍按一次性 JSON 接口验证
            const res = await call(handle, "/api/sessions/s1/events?since=0", {
                headers: { "last-event-id": "1" },
            });
            const events = await res.json() as AgentEvent[];

            expect(calls.sinceCalls).toEqual([1]);
            expect(events.map(item => item.seq)).toEqual([2]);
        } finally {
            await handle.stop();
        }
    });

    test("SSE 帧的 data 省掉 seq 与 sessionId（分别在 id: 行与 URL 里）", async () => {
        const stub = createStubHost({ history: [event(1)] });
        const handle = web(stub.host);
        try {
            const res = await call(handle, "/api/sessions/s1/live?since=0");
            const frames = openFrameReader(res);
            const [frame] = await frames.read(1);

            expect(frame).toContain("id: 1");
            const data = frame!.split("\n").find(line => line.startsWith("data: "))!.slice(6);
            const payload = JSON.parse(data) as Record<string, unknown>;
            expect(payload.seq).toBeUndefined();
            expect(payload.sessionId).toBeUndefined();
            // 其余字段照常下发
            expect(payload.type).toBe("context_compacted");
            expect(typeof payload.ts).toBe("string");

            await frames.close();
        } finally {
            await handle.stop();
        }
    });

    test("SSE 先回放历史再推增量，且按 seq 去重", async () => {
        const stub = createStubHost({ history: [event(1), event(2)] });
        const handle = web(stub.host);
        try {
            const res = await call(handle, "/api/sessions/s1/live?since=0");
            expect(res.headers.get("content-type")).toContain("text/event-stream");

            const frames = openFrameReader(res);
            // 先等到回放的 2 帧，再推实时事件：避免用固定 sleep 猜时序
            expect((await frames.read(2)).map(frame => frame.match(/id: (\d+)/)?.[1])).toEqual(["1", "2"]);

            stub.emit("s1", event(3));
            stub.emit("s1", event(2)); // 重复 seq，应被过滤
            expect((await frames.read(1))[0]).toContain("id: 3");

            await frames.close();
        } finally {
            await handle.stop();
        }
    });

    test("时间轴重置时下发 reset 帧并归零游标", async () => {
        const stub = createStubHost({ history: [event(5)] });
        const handle = web(stub.host);
        try {
            const frames = openFrameReader(await call(handle, "/api/sessions/s1/live?since=0"));
            expect((await frames.read(1))[0]).toContain("id: 5");

            stub.emit("s1", null);
            expect((await frames.read(1))[0]).toContain("event: reset");

            // 游标归零后，较小 seq 也要能推出来
            stub.emit("s1", event(1));
            expect((await frames.read(1))[0]).toContain("id: 1");

            await frames.close();
        } finally {
            await handle.stop();
        }
    });

    test("空闲时下发心跳帧", async () => {
        const { host } = createStubHost();
        const handle = web(host, 20);
        try {
            const frames = openFrameReader(await call(handle, "/api/sessions/s1/live?since=0"));
            expect((await frames.read(1))[0]).toContain(": ping");
            await frames.close();
        } finally {
            await handle.stop();
        }
    });

    test("客户端断开后订阅被清理", async () => {
        const stub = createStubHost();
        const handle = web(stub.host, 20);
        const abort = new AbortController();
        try {
            const res = await fetch(`${handle.url}/api/sessions/s1/live?since=0`, {
                headers: { authorization: `Bearer ${TOKEN}` },
                signal: abort.signal,
            });
            // 先收到一帧心跳，确认服务端已进入 start（订阅已建立）
            await res.body!.getReader().read();
            expect(stub.listenerCount()).toBe(1);

            abort.abort();
            expect(await waitForListenerCleanup(stub)).toBe(0);
        } finally {
            await handle.stop();
        }
    });

    test("回放期间断开：订阅归零且不再创建心跳定时器", async () => {
        const stub = createStubHost();
        let releaseReplay: (events: AgentEvent[]) => void = () => {};
        const gate = new Promise<AgentEvent[]>(resolve => {
            releaseReplay = resolve;
        });
        // 可控慢回放：模拟客户端在回放未结束时就断开
        (stub.host as unknown as { readSessionEventsSince: () => Promise<AgentEvent[]> }).readSessionEventsSince =
            () => gate;

        // 拦截定时器创建：这条用例守的就是「断开后不得再建心跳」，只看订阅数守不住
        // 断言写的是「整段窗口内一个心跳都没建」：当前实现里心跳只在回放结束后创建，
        // 若将来把心跳提前到回放之前（同样正确），这里要改成以 abort 时刻为基线比对。
        const createdHeartbeats: number[] = [];
        const realSetInterval = globalThis.setInterval;
        const spy = spyOn(globalThis, "setInterval").mockImplementation(((
            handler: TimerHandler,
            timeout?: number,
        ) => {
            createdHeartbeats.push(timeout ?? 0);
            return realSetInterval(handler as () => void, timeout);
        }) as typeof globalThis.setInterval);

        const handle = web(stub.host, 20);
        const abort = new AbortController();
        try {
            // 慢回放期间不会发出任何帧，服务端可能迟迟不 flush 响应头，这里不 await 请求本身
            const pending = fetch(`${handle.url}/api/sessions/s1/live?since=0`, {
                headers: { authorization: `Bearer ${TOKEN}` },
                signal: abort.signal,
            }).catch(() => undefined);
            for (let attempt = 0; attempt < 100 && stub.listenerCount() === 0; attempt += 1) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            expect(stub.listenerCount()).toBe(1);

            abort.abort();
            expect(await waitForListenerCleanup(stub)).toBe(0);

            // 回放这时才返回：closed 早退必须挡住心跳创建（否则 interval 无人清理）
            releaseReplay([event(1)]);
            await new Promise(resolve => setTimeout(resolve, 60));
            expect(stub.listenerCount()).toBe(0);
            expect(createdHeartbeats).toEqual([]);
            await pending;
        } finally {
            spy.mockRestore();
            await handle.stop();
        }
    });
});
