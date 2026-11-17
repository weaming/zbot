/**
 * 观察通道：只读边界、快照游标、订阅推送的单调性与退订、版本握手、socket 清理。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import net from "net";
import type { LiveFrame } from "../../src/events/live-stream.js";
import type { SessionEventView } from "../../src/events/session-event-view.js";
import { cleanupStaleObserveSockets } from "../../src/observe/cleanup.js";
import { getObserveSocketPath } from "../../src/observe/paths.js";
import { OBSERVE_PROTOCOL_VERSION } from "../../src/observe/protocol.js";
import { ObserveServer, type ObserveSnapshot } from "../../src/observe/server.js";
import { useTmpStateDir, type TmpStateDir } from "./test-env.js";

const SESSION = "01JOBSEVESESSION0000000001";

let stateDir: TmpStateDir;
const servers: ObserveServer[] = [];
const clients: Array<() => void> = [];

beforeEach(() => {
    stateDir = useTmpStateDir("zbot-observe-");
});

afterEach(() => {
    for (const close of clients.splice(0)) close();
    for (const server of servers.splice(0)) server.unbind();
    stateDir.cleanup();
});

function view(seq: number): SessionEventView {
    return { seq, ts: "2026-11-18T00:00:00.000Z", sessionId: SESSION, type: "assistant_message", payload: { seq } };
}

/** 内存版事实源：快照按 seq 取，订阅把新事件推给监听者。 */
class FakeSource {
    events: SessionEventView[] = [];
    eventListeners = new Set<(view: SessionEventView) => void>();
    liveListeners = new Set<(frame: LiveFrame) => void>();

    push(next: SessionEventView): void {
        this.events.push(next);
        for (const listener of this.eventListeners) listener(next);
    }

    live(frame: LiveFrame): void {
        for (const listener of this.liveListeners) listener(frame);
    }

    snapshot(since: number, limit: number): Promise<ObserveSnapshot> {
        const rest = this.events.filter(event => event.seq > since);
        const page = rest.slice(0, limit);
        return Promise.resolve({
            events: page,
            lastSeq: this.lastSeq(),
            more: rest.length > page.length,
        });
    }

    lastSeq(): number {
        return this.events.length === 0 ? 0 : this.events[this.events.length - 1].seq;
    }
}

async function start(): Promise<{ source: FakeSource; server: ObserveServer }> {
    const source = new FakeSource();
    const server = new ObserveServer(SESSION, {
        title: () => "观察目标",
        isBusy: () => false,
        lastSeq: () => Promise.resolve(source.lastSeq()),
        snapshot: (since, limit) => source.snapshot(since, limit),
        watchEvents: listener => {
            source.eventListeners.add(listener);
            return () => source.eventListeners.delete(listener);
        },
        watchLive: listener => {
            source.liveListeners.add(listener);
            return () => source.liveListeners.delete(listener);
        },
    });
    servers.push(server);
    const bound = await server.bind();
    expect(bound.ok).toBe(true);
    return { source, server };
}

interface Client {
    send(frame: unknown): void;
    next(): Promise<any>;
    close(): void;
}

function connect(): Promise<Client> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(getObserveSocketPath(SESSION));
        socket.setEncoding("utf8");
        const queue: any[] = [];
        const waiters: Array<(frame: any) => void> = [];
        let buffer = "";

        socket.on("data", (chunk: string) => {
            buffer += chunk;
            for (;;) {
                const index = buffer.indexOf("\n");
                if (index === -1) break;
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                if (!line.trim()) continue;
                const frame = JSON.parse(line);
                const waiter = waiters.shift();
                if (waiter) waiter(frame);
                else queue.push(frame);
            }
        });
        socket.on("error", reject);
        socket.once("connect", () => {
            const close = () => socket.destroy();
            clients.push(close);
            resolve({
                send: frame => socket.write(`${JSON.stringify(frame)}\n`),
                next: () =>
                    new Promise((done, fail) => {
                        const queued = queue.shift();
                        if (queued !== undefined) return done(queued);
                        const timer = setTimeout(() => fail(new Error("等帧超时")), 2000);
                        waiters.push(frame => {
                            clearTimeout(timer);
                            done(frame);
                        });
                    }),
                close,
            });
        });
    });
}

describe("握手与只读边界", () => {
    test("版本一致才算就绪，不一致如实说明", async () => {
        await start();
        const client = await connect();

        client.send({ type: "hello", id: "h1", version: OBSERVE_PROTOCOL_VERSION });
        expect(await client.next()).toMatchObject({
            type: "hello_result",
            id: "h1",
            ok: true,
            version: OBSERVE_PROTOCOL_VERSION,
            sessionId: SESSION,
            title: "观察目标",
        });

        client.send({ type: "hello", id: "h2", version: OBSERVE_PROTOCOL_VERSION + 1 });
        const bad = await client.next();
        expect(bad.ok).toBe(false);
        expect(bad.error).toContain("协议版本不一致");
    });

    test("写操作类帧一律拒绝，连接保持可用", async () => {
        await start();
        const client = await connect();
        for (const type of ["deliver", "query_pending", "cancel_queued", "queue_state", "rename", "release"]) {
            client.send({ type, id: `x-${type}` });
            expect(await client.next()).toMatchObject({ type: "error", id: `x-${type}`, code: "forbidden" });
        }
        client.send({ type: "ping", id: "p" });
        expect(await client.next()).toMatchObject({ type: "pong", id: "p" });
    });
});

describe("快照与订阅", () => {
    test("快照按 since 取一段并说明是否还有更多", async () => {
        const { source } = await start();
        source.events.push(view(1), view(2), view(3));
        const client = await connect();

        client.send({ type: "snapshot", id: "s1", since: 1, limit: 1 });
        const page = await client.next();
        expect(page).toMatchObject({ type: "snapshot_result", id: "s1", lastSeq: 3, more: true });
        expect(page.events.map((event: SessionEventView) => event.seq)).toEqual([2]);

        client.send({ type: "snapshot", id: "s2", since: 2, limit: 10 });
        const rest = await client.next();
        expect(rest.more).toBe(false);
        expect(rest.events.map((event: SessionEventView) => event.seq)).toEqual([3]);
    });

    test("订阅先补游标之后的事件，再推持久化与瞬态帧，seq 单调不重复", async () => {
        const { source } = await start();
        source.events.push(view(1), view(2));
        const client = await connect();

        client.send({ type: "subscribe", id: "sub", since: 1 });
        expect(await client.next()).toMatchObject({ type: "subscribed", id: "sub", lastSeq: 2 });
        const backlog = await client.next();
        expect(backlog).toMatchObject({ type: "events" });
        expect(backlog.events.map((event: SessionEventView) => event.seq)).toEqual([2]);

        source.push(view(3));
        expect(await client.next()).toMatchObject({ type: "events", events: [{ seq: 3 }] });

        // 同一个 seq 重复到达（日志重放与实时推送重叠）不会再下发
        source.push(view(3));
        source.live({ t: "text", d: "正在生成" });
        expect(await client.next()).toMatchObject({ type: "live", frame: { t: "text", d: "正在生成" } });

        source.push(view(4));
        expect(await client.next()).toMatchObject({ type: "events", events: [{ seq: 4 }] });
    });

    test("退订后不再推送，socket 释放后文件消失", async () => {
        const { source, server } = await start();
        const client = await connect();
        client.send({ type: "subscribe", id: "sub" });
        expect(await client.next()).toMatchObject({ type: "subscribed", id: "sub" });
        expect(source.eventListeners.size).toBe(1);

        client.send({ type: "unsubscribe", id: "off" });
        expect(await client.next()).toMatchObject({ type: "unsubscribed", id: "off" });
        expect(source.eventListeners.size).toBe(0);

        server.unbind();
        expect(fs.existsSync(getObserveSocketPath(SESSION))).toBe(false);
    });
});

describe("残留回收", () => {
    test("连不上的观察 socket 被清掉，活着的保留", async () => {
        // 活着的：本进程正在服务
        await start();

        // 死文件：没人应答的残留。真实场景是进程被 kill 留下的 socket，
        // 探测走的是同一条"连不上"分支（ENOTSOCK / ECONNREFUSED 都算 stale）。
        const staleId = "01JOBSTALE0000000000000001";
        const stalePath = getObserveSocketPath(staleId);
        fs.writeFileSync(stalePath, "");
        expect(fs.existsSync(stalePath)).toBe(true);

        const removed = await cleanupStaleObserveSockets(200);
        expect(removed).toEqual([staleId]);
        expect(fs.existsSync(stalePath)).toBe(false);
        expect(fs.existsSync(getObserveSocketPath(SESSION))).toBe(true);
    });
});
