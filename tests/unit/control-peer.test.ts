/**
 * 会话控制服务端 / 客户端：受理与 busy 拒绝、结果回传、协商释放、断线补发与丢失上报。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import net from "net";
import { PeerClientPool, PeerConnectError, requestOnce } from "../../src/control/client.js";
import { getSocketPath } from "../../src/control/paths.js";
import { createPeerMessage, encodeFrame, splitFrames, type PeerResult } from "../../src/control/protocol.js";
import { forgetBound, locallyBoundSessionIds, probeOwnership } from "../../src/control/registry.js";
import { PeerServer, type PeerServerHandlers } from "../../src/control/server.js";
import { useTmpStateDir, type TmpStateDir } from "./test-env.js";

let stateDir: TmpStateDir;
const servers: PeerServer[] = [];
const pools: PeerClientPool[] = [];
const raws: net.Server[] = [];

beforeEach(() => {
    stateDir = useTmpStateDir("zbot-control-peer-");
    for (const sessionId of locallyBoundSessionIds()) forgetBound(sessionId);
});

afterEach(() => {
    for (const pool of pools.splice(0)) pool.closeAll();
    for (const server of servers.splice(0)) server.unbind();
    for (const raw of raws.splice(0)) {
        try {
            raw.close();
        } catch {
            // 已关闭
        }
    }
    for (const sessionId of locallyBoundSessionIds()) forgetBound(sessionId);
    stateDir.cleanup();
});

interface RecordingHandlers extends PeerServerHandlers {
    accepted: string[];
    released: number;
    done: PeerResult[];
    busy: boolean;
}

function makeHandlers(overrides: Partial<PeerServerHandlers> = {}): RecordingHandlers {
    const state: RecordingHandlers = {
        accepted: [],
        released: 0,
        done: [],
        busy: false,
        title: () => "会话一号",
        isBusy: () => state.busy,
        accept: (message) => {
            if (state.busy) return { status: "busy" as const };
            state.accepted.push(message.id);
            return { status: "accepted" as const };
        },
        release: () => {
            if (state.busy) return false;
            state.released += 1;
            return true;
        },
        pendingState: (msgIds) => ({
            done: state.done.filter((item) => msgIds.includes(item.msgId)),
            pending: msgIds.filter((msgId) => !state.done.some((item) => item.msgId === msgId)),
        }),
        ...overrides,
    };
    return state;
}

async function bindServer(sessionId: string, handlers: RecordingHandlers): Promise<PeerServer> {
    const server = new PeerServer(sessionId, handlers, { probeTimeoutMs: 100 });
    servers.push(server);
    expect(await server.bind()).toEqual({ ok: true });
    return server;
}

function makePool(overrides: { onResult?: (target: string, result: PeerResult) => void; onLost?: (target: string, ids: string[]) => void } = {}): PeerClientPool {
    const pool = new PeerClientPool({
        onResult: overrides.onResult ?? (() => undefined),
        ...(overrides.onLost ? { onLost: overrides.onLost } : {}),
    }, { requestTimeoutMs: 300, reconnectDelayMs: 10 });
    pools.push(pool);
    return pool;
}

function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
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

describe("PeerServer 绑定与归属", () => {
    test("bind 成功后归属为本实例，重复 bind 报 owned", async () => {
        const handlers = makeHandlers();
        await bindServer("s1", handlers);

        expect(await probeOwnership("s1", 100)).toEqual({ state: "mine" });

        const second = new PeerServer("s1", handlers, { probeTimeoutMs: 100 });
        expect(await second.bind()).toEqual({ ok: false, reason: "owned", pid: process.pid });
    });

    test("被外来监听占用时 bind 报 owned 且不清理对方文件", async () => {
        const socketPath = getSocketPath("s2");
        fs.mkdirSync(`${stateDir.dir}/sessions/control`, { recursive: true });
        const foreign = net.createServer(() => undefined);
        await new Promise<void>((resolve) => foreign.listen(socketPath, () => resolve()));
        raws.push(foreign);

        const server = new PeerServer("s2", makeHandlers(), { probeTimeoutMs: 100 });
        const result = await server.bind();
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.reason).toBe("owned");
        expect(fs.existsSync(socketPath)).toBe(true);
    });

    test("残留 socket 文件被清理后可成功 bind", async () => {
        fs.mkdirSync(`${stateDir.dir}/sessions/control`, { recursive: true });
        fs.writeFileSync(getSocketPath("s3"), "");

        const server = new PeerServer("s3", makeHandlers(), { probeTimeoutMs: 100 });
        servers.push(server);
        expect(await server.bind()).toEqual({ ok: true });
    });
});

describe("who 握手", () => {
    test("返回实时身份与忙闲", async () => {
        const handlers = makeHandlers();
        await bindServer("s1", handlers);

        const reply = await requestOnce(getSocketPath("s1"), { type: "who", id: "q1" }, 300);
        expect(reply.type).toBe("who");
        if (reply.type !== "who") return;
        expect(reply.info.pid).toBe(process.pid);
        expect(reply.info.sessionId).toBe("s1");
        expect(reply.info.title).toBe("会话一号");
        expect(reply.info.busy).toBe(false);

        handlers.busy = true;
        const busyReply = await requestOnce(getSocketPath("s1"), { type: "who", id: "q2" }, 300);
        expect(busyReply.type === "who" && busyReply.info.busy).toBe(true);
    });
});

describe("deliver 受理语义", () => {
    test("空闲时受理并 ack ok，pending 计数上升", async () => {
        const handlers = makeHandlers();
        const server = await bindServer("s1", handlers);
        const pool = makePool();
        const message = createPeerMessage({ from: "s9", to: "s1", text: "帮我看看", expectResult: true });

        const reply = await pool.deliver("s1", message);
        expect(reply).toEqual({ type: "ack", id: (reply as { id: string }).id, ok: true });
        expect(handlers.accepted).toEqual([message.id]);
        expect(server.pendingCount).toBe(1);
    });

    test("忙碌时拒绝且不落任何投递槽", async () => {
        const handlers = makeHandlers();
        handlers.busy = true;
        const server = await bindServer("s1", handlers);
        const pool = makePool();

        const reply = await pool.deliver("s1", createPeerMessage({ from: "s9", to: "s1", text: "在吗" }));
        expect(reply).toEqual({ type: "ack", id: (reply as { id: string }).id, ok: false, error: "busy" });
        expect(handlers.accepted).toEqual([]);
        expect(server.pendingCount).toBe(0);
    });

    test("to 与监听会话不一致时拒绝为 bad_request", async () => {
        const handlers = makeHandlers();
        await bindServer("s1", handlers);
        const pool = makePool();

        const reply = await pool.deliver("s1", createPeerMessage({ from: "s9", to: "s9", text: "错投" }));
        expect(reply.type === "ack" && reply.ok).toBe(false);
        expect(handlers.accepted).toEqual([]);
    });

    test("目标不可达抛 connect 错误", async () => {
        const pool = makePool();
        await expect(
            pool.deliver("s-nope", createPeerMessage({ from: "s9", to: "s-nope", text: "hi" })),
        ).rejects.toBeInstanceOf(PeerConnectError);
    });
});

describe("结果回传", () => {
    test("pushResult 送达发起方并清空投递槽", async () => {
        const handlers = makeHandlers();
        const server = await bindServer("s1", handlers);
        const received: PeerResult[] = [];
        const pool = makePool({ onResult: (_target, result) => received.push(result) });

        const message = createPeerMessage({ from: "s9", to: "s1", text: "总结一下", expectResult: true });
        await pool.deliver("s1", message);

        const result: PeerResult = { msgId: message.id, ok: true, text: "做完了", stopReason: "stop" };
        expect(server.pushResult(result)).toBe(true);
        await waitFor(() => received.length > 0);

        expect(received).toEqual([result]);
        expect(server.pendingCount).toBe(0);
    });

    test("发起方连接已断时 pushResult 返回 false，结果交由上层保留", async () => {
        const handlers = makeHandlers();
        const server = await bindServer("s1", handlers);
        const pool = makePool();

        const message = createPeerMessage({ from: "s9", to: "s1", text: "hi", expectResult: true });
        await pool.deliver("s1", message);
        pool.closeAll();

        // 等对端感知连接断开（close 事件跨进程投递，不是同步的）
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(server.pushResult({ msgId: message.id, ok: true, text: "x", stopReason: "stop" })).toBe(false);
    });

    test("query_pending 区分已完成与处理中", async () => {
        const handlers = makeHandlers();
        await bindServer("s1", handlers);
        const pool = makePool();

        const first = createPeerMessage({ from: "s9", to: "s1", text: "a", expectResult: true });
        await pool.deliver("s1", first);
        handlers.done.push({ msgId: first.id, ok: true, text: "结果", stopReason: "stop" });

        const reply = await requestOnce(
            getSocketPath("s1"),
            { type: "query_pending", id: "qp", msgIds: [first.id, "missing"] },
            300,
        );
        expect(reply.type).toBe("pending_state");
        if (reply.type !== "pending_state") return;
        expect(reply.done.map((item) => item.msgId)).toEqual([first.id]);
        expect(reply.pending).toEqual(["missing"]);
    });
});

describe("协商释放", () => {
    test("空闲时释放成功并移除 socket 文件", async () => {
        const handlers = makeHandlers();
        await bindServer("s1", handlers);

        const reply = await requestOnce(getSocketPath("s1"), { type: "release", id: "r1" }, 300);
        expect(reply).toEqual({ type: "release_result", id: "r1", ok: true });
        expect(handlers.released).toBe(1);
        expect(fs.existsSync(getSocketPath("s1"))).toBe(false);
    });

    test("忙碌时拒绝释放且保留 socket", async () => {
        const handlers = makeHandlers();
        handlers.busy = true;
        await bindServer("s1", handlers);
        const socketPath = getSocketPath("s1");

        const reply = await requestOnce(socketPath, { type: "release", id: "r2" }, 300);
        expect(reply).toEqual({ type: "release_result", id: "r2", ok: false, reason: "busy" });
        expect(handlers.released).toBe(0);
        expect(fs.existsSync(socketPath)).toBe(true);
        expect(await probeOwnership("s1", 100)).toEqual({ state: "mine" });
    });
});

describe("客户端断线补发", () => {
    test("连接断开后重连 query_pending 取回已就绪结果", async () => {
        const results: PeerResult[] = [];
        const socketPath = getSocketPath("s4");
        fs.mkdirSync(`${stateDir.dir}/sessions/control`, { recursive: true });

        // 假持有者：ack 投递后立刻断开连接，随后回应 query_pending 补发结果
        const raw = net.createServer((socket) => {
            socket.setEncoding("utf8");
            let buffer = "";
            let deliveredId = "";
            socket.on("data", (chunk: string) => {
                buffer += chunk;
                const { frames, rest } = splitFrames(buffer);
                buffer = rest;
                for (const frame of frames) {
                    if (frame.type === "deliver") {
                        deliveredId = frame.message.id;
                        socket.write(encodeFrame({ type: "ack", id: frame.id, ok: true }));
                        socket.end();
                        continue;
                    }
                    if (frame.type === "query_pending") {
                        socket.write(
                            encodeFrame({
                                type: "pending_state",
                                id: frame.id,
                                done: [
                                    { msgId: deliveredId, ok: true, text: "补发的结果", stopReason: "stop" },
                                ],
                                pending: [],
                            }),
                        );
                    }
                }
            });
            socket.on("error", () => undefined);
        });
        await new Promise<void>((resolve) => raw.listen(socketPath, () => resolve()));
        raws.push(raw);

        const pool = makePool({ onResult: (_target, result) => results.push(result) });
        const message = createPeerMessage({ from: "s9", to: "s4", text: "跑个长任务", expectResult: true });
        const reply = await pool.deliver("s4", message);
        expect(reply.type === "ack" && reply.ok).toBe(true);

        await waitFor(() => results.length > 0, 1_000);
        expect(results[0]?.text).toBe("补发的结果");
    });

    test("目标彻底消失时上报结果丢失", async () => {
        const lost: string[][] = [];
        const socketPath = getSocketPath("s5");
        fs.mkdirSync(`${stateDir.dir}/sessions/control`, { recursive: true });

        const raw = net.createServer((socket) => {
            socket.setEncoding("utf8");
            let buffer = "";
            socket.on("data", (chunk: string) => {
                buffer += chunk;
                const { frames, rest } = splitFrames(buffer);
                buffer = rest;
                for (const frame of frames) {
                    if (frame.type !== "deliver") continue;
                    socket.write(encodeFrame({ type: "ack", id: frame.id, ok: true }));
                    socket.end();
                    // 模拟持有者进程死亡：文件消失，后续连接一律失败
                    fs.rmSync(socketPath, { force: true });
                    raw.close();
                }
            });
            socket.on("error", () => undefined);
        });
        await new Promise<void>((resolve) => raw.listen(socketPath, () => resolve()));
        raws.push(raw);

        const pool = makePool({ onLost: (_target, ids) => lost.push(ids) });
        const message = createPeerMessage({ from: "s9", to: "s5", text: "任务", expectResult: true });
        await pool.deliver("s5", message);

        await waitFor(() => lost.length > 0, 1_500);
        expect(lost[0]).toEqual([message.id]);
    });
});
