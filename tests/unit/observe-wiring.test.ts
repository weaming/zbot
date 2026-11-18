/**
 * 观察通道的接线：认领会话时顺带打开只读旁路，释放时清理；
 * 持久化事件与瞬态信号都从宿主这一侧喂进来，和 TUI/web 共用同一份来源。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import net from "net";
import { SessionControl, type SessionControlHost } from "../../src/control/channel.js";
import { forgetBound, locallyBoundSessionIds } from "../../src/control/registry.js";
import { getObserveSocketPath } from "../../src/observe/paths.js";
import { OBSERVE_PROTOCOL_VERSION } from "../../src/observe/protocol.js";
import type { SessionEventView } from "../../src/events/session-event-view.js";
import { publishUIEvent, pushLiveEnd, subscribeLive, type LiveFrame } from "../../src/events/live-stream.js";
import { useTmpStateDir, type TmpStateDir } from "./test-env.js";

const SESSION = "01JOBOBSERVE00000000000001";

let stateDir: TmpStateDir;
const controls: SessionControl[] = [];
const sockets: net.Socket[] = [];

beforeEach(() => {
    stateDir = useTmpStateDir("zbot-observe-wiring-");
    for (const sessionId of locallyBoundSessionIds()) forgetBound(sessionId);
});

afterEach(() => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const control of controls.splice(0)) control.close();
    for (const sessionId of locallyBoundSessionIds()) forgetBound(sessionId);
    stateDir.cleanup();
});

/** 只有观察通道相关能力的宿主：控制协议的其余部分按最小实现填齐。 */
function makeHost(): SessionControlHost & { events: SessionEventView[]; listeners: Set<(view: SessionEventView) => void> } {
    const host = {
        instanceId: "test-instance",
        events: [] as SessionEventView[],
        listeners: new Set<(view: SessionEventView) => void>(),
        getSessionDelegation: async () => undefined,
        holdsSession: () => true,
        title: () => "观察目标",
        isBusy: () => false,
        createSession: async () => ({ sessionId: "spawned" }),
        sessionCwd: async (sessionId: string) => `/cwd/${sessionId}`,
        onSessionSpawned: () => undefined,
        accept: () => ({ status: "accepted" as const }),
        onOutbound: () => undefined,
        onResult: () => undefined,
        onLost: () => undefined,
        onReleased: () => undefined,
        readSessionEvents: async (sessionId: string, since: number, limit: number) => {
            const rest = host.events.filter(event => event.seq > since);
            return { events: rest.slice(0, limit), lastSeq: lastSeq(), more: rest.length > limit };
        },
        sessionLastSeq: async () => lastSeq(),
        watchSessionEvents: (_sessionId: string, listener: (view: SessionEventView) => void) => {
            host.listeners.add(listener);
            return () => host.listeners.delete(listener);
        },
    };

    function lastSeq(): number {
        return host.events.length === 0 ? 0 : host.events[host.events.length - 1].seq;
    }

    return host;
}

function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            if (check()) return resolve();
            if (Date.now() - started > timeoutMs) return reject(new Error("等待条件超时"));
            setTimeout(tick, 5);
        };
        tick();
    });
}

interface Reader {
    send(frame: unknown): void;
    next(): Promise<any>;
}

function connect(): Promise<Reader> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(getObserveSocketPath(SESSION));
        sockets.push(socket);
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
            });
        });
    });
}

describe("观察旁路的生命周期与事件来源", () => {
    test("认领即打开，释放即清理，事件与瞬态信号都能推给订阅者", async () => {
        const host = makeHost();
        const control = new SessionControl(host);
        controls.push(control);

        expect(await control.claim(SESSION)).toMatchObject({ ok: true });
        await waitFor(() => fs.existsSync(getObserveSocketPath(SESSION)));

        // 认领之前的持久化事实：订阅时按 since 补齐
        host.events.push({ seq: 1, ts: "2026-11-18T00:00:00.000Z", sessionId: SESSION, type: "user_message", payload: { text: "你好" } });

        const reader = await connect();
        reader.send({ type: "hello", id: "h", version: OBSERVE_PROTOCOL_VERSION });
        expect(await reader.next()).toMatchObject({ type: "hello_result", ok: true, sessionId: SESSION, lastSeq: 1 });

        reader.send({ type: "subscribe", id: "sub", since: 0 });
        expect(await reader.next()).toMatchObject({ type: "subscribed", id: "sub" });
        expect(await reader.next()).toMatchObject({ type: "events", events: [{ seq: 1 }] });

        // 持久化事件：日志 append 之后从 EventLog 订阅直接推
        host.events.push({ seq: 2, ts: "2026-11-18T00:00:01.000Z", sessionId: SESSION, type: "assistant_message", payload: { text: "在" } });
        for (const listener of host.listeners) listener(host.events[1]);
        expect(await reader.next()).toMatchObject({ type: "events", events: [{ seq: 2 }] });

        // 瞬态信号：宿主 notify 喂一次，订阅者拿到合批后的正文与收尾
        publishUIEvent(SESSION, { type: "text_delta", delta: "正在" });
        publishUIEvent(SESSION, { type: "text_delta", delta: "生成" });
        expect(await reader.next()).toMatchObject({ type: "live", frame: { t: "text", d: "正在生成" } });
        pushLiveEnd(SESSION);
        expect(await reader.next()).toMatchObject({ type: "live", frame: { t: "end" } });

        control.release(SESSION);
        await waitFor(() => !fs.existsSync(getObserveSocketPath(SESSION)));
    });

    test("publishUIEvent：tool_start 立即冲刷待发正文并关闭 thinking，turn_end 发出 end 帧", () => {
        const frames: LiveFrame[] = [];
        const unsubscribe = subscribeLive(SESSION, frame => frames.push(frame));
        try {
            publishUIEvent(SESSION, { type: "reasoning_delta", delta: "思考中" });
            publishUIEvent(SESSION, { type: "text_delta", delta: "先说一句" });
            // tool_start 到来：立即冲刷缓冲正文（不等待 80ms 合批定时器）
            publishUIEvent(SESSION, {
                type: "tool_start",
                toolId: 1,
                callId: "c1",
                name: "bash",
                args: {},
                mode: "serial",
            });
            // 仅 thinking=true 时 tool_start 也要能把 thinking 关掉
            publishUIEvent(SESSION, { type: "reasoning_delta", delta: "再想" });
            publishUIEvent(SESSION, {
                type: "tool_start",
                toolId: 2,
                callId: "c2",
                name: "bash",
                args: {},
                mode: "serial",
            });
            publishUIEvent(SESSION, { type: "turn_end", iteration: 1 });

            expect(frames).toEqual([
                { t: "think", on: true },
                { t: "think", on: false },
                { t: "text", d: "先说一句" },
                { t: "think", on: true },
                { t: "think", on: false },
                { t: "end" },
            ]);
        } finally {
            unsubscribe();
        }
    });
});
