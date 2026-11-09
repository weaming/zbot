/**
 * 会话控制通道：同进程直投、跨进程投递、协商认领、结果回传与丢失上报。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import net from "net";
import { formatResultText, PeerSendFailure, SessionControl, type SessionControlHost } from "../../src/control/channel.js";
import { requestOnce } from "../../src/control/client.js";
import { ensureControlDir, getSocketPath } from "../../src/control/paths.js";
import { createPeerMessage, encodeFrame, splitFrames, type PeerFrame, type PeerMessage, type PeerResult } from "../../src/control/protocol.js";
import { forgetBound, locallyBoundSessionIds } from "../../src/control/registry.js";
import { useTmpStateDir, type TmpStateDir } from "./test-env.js";

let stateDir: TmpStateDir;
const controls: SessionControl[] = [];
const fakes: FakePeer[] = [];

beforeEach(() => {
    stateDir = useTmpStateDir("zbot-control-channel-");
    for (const sessionId of locallyBoundSessionIds()) forgetBound(sessionId);
});

afterEach(() => {
    for (const control of controls.splice(0)) control.close();
    for (const fake of fakes.splice(0)) fake.stop();
    for (const sessionId of locallyBoundSessionIds()) forgetBound(sessionId);
    stateDir.cleanup();
});

/** 假的外部持有者：按配置回应 release / who / deliver。 */
class FakePeer {
    private server: net.Server | null = null;
    readonly released = { count: 0 };
    /** ack 投递时是否回 busy。 */
    deliverBusy = false;
    /** 收到 release 时：true 放行（并删除 socket 文件），false 回 busy。 */
    releaseAllowed = true;
    /** 收到 release 时是否完全不回应（模拟进程卡死）。 */
    silent = false;
    readonly delivered: PeerMessage[] = [];
    private readonly sockets = new Set<net.Socket>();

    constructor(readonly sessionId: string) {}

    async start(): Promise<void> {
        ensureControlDir();
        const socketPath = getSocketPath(this.sessionId);
        this.server = net.createServer((socket) => {
            this.sockets.add(socket);
            socket.setEncoding("utf8");
            let buffer = "";
            socket.on("data", (chunk: string) => {
                buffer += chunk;
                const { frames, rest } = splitFrames(buffer);
                buffer = rest;
                for (const frame of frames) this.handle(socket, frame);
            });
            socket.on("error", () => undefined);
            socket.on("close", () => this.sockets.delete(socket));
        });
        await new Promise<void>((resolve) => this.server?.listen(socketPath, () => resolve()));
    }

    stop(): void {
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        try {
            this.server?.close();
        } catch {
            // 已关闭
        }
        this.server = null;
        fs.rmSync(getSocketPath(this.sessionId), { force: true });
    }

    private handle(socket: net.Socket, frame: PeerFrame): void {
        if (frame.type === "deliver") {
            this.delivered.push(frame.message);
            socket.write(
                encodeFrame(
                    this.deliverBusy
                        ? { type: "ack", id: frame.id, ok: false, error: "busy" }
                        : { type: "ack", id: frame.id, ok: true },
                ),
            );
            return;
        }

        if (frame.type === "who") {
            socket.write(
                encodeFrame({
                    type: "who",
                    id: frame.id,
                    info: {
                        pid: 1,
                        instanceId: "fake",
                        sessionId: this.sessionId,
                        busy: false,
                        pending: 0,
                    },
                }),
            );
            return;
        }

        if (frame.type === "release") {
            if (this.silent) return;
            this.released.count += 1;
            if (!this.releaseAllowed) {
                socket.write(encodeFrame({ type: "release_result", id: frame.id, ok: false, reason: "busy" }));
                return;
            }
            socket.write(encodeFrame({ type: "release_result", id: frame.id, ok: true }));
            fs.rmSync(getSocketPath(this.sessionId), { force: true });
        }
    }
}

interface RecordingHost extends SessionControlHost {
    accepted: PeerMessage[];
    inbound: PeerMessage[];
    outbound: PeerMessage[];
    results: Array<{ requester: string; result: PeerResult; late?: boolean }>;
    lost: Array<{ requester: string; msgIds: string[] }>;
    releasedSessions: string[];
    spawnedSessions: string[];
    createdCwds: string[];
    archivedSessions: Array<{ sessionId: string; automatic: boolean }>;
    renamed: Array<{ sessionId: string; title: string }>;
    busy: Set<string>;
}

function makeHost(): RecordingHost {
    const host: RecordingHost = {
        accepted: [],
        inbound: [],
        outbound: [],
        results: [],
        lost: [],
        releasedSessions: [],
        spawnedSessions: [],
        createdCwds: [],
        archivedSessions: [],
        renamed: [],
        busy: new Set<string>(),
        title: (sessionId) => `会话 ${sessionId}`,
        isBusy: (sessionId) => host.busy.has(sessionId),
        createSession: async (cwd) => {
            host.createdCwds.push(cwd ?? "");
            return { sessionId: `spawned-${host.createdCwds.length}` };
        },
        sessionCwd: async (sessionId) => `/cwd/${sessionId}`,
        onSessionSpawned: (sessionId) => host.spawnedSessions.push(sessionId),
        archiveSpawnedSession: async (sessionId, automatic) => {
            host.archivedSessions.push({ sessionId, automatic });
        },
        accept: (message) => {
            if (host.busy.has(message.to)) return { status: "busy" as const };
            host.accepted.push(message);
            return { status: "accepted" as const };
        },
        rename: (sessionId, title) => {
            host.renamed.push({ sessionId, title });
            return title.slice(0, 200);
        },
        onOutbound: (_from, message) => host.outbound.push(message),
        onResult: (requester, _message, result, options) => host.results.push({
            requester,
            result,
            ...(options?.late ? { late: true } : {}),
        }),
        onLost: (requester, msgIds) => host.lost.push({ requester, msgIds }),
        onReleased: (sessionId) => host.releasedSessions.push(sessionId),
    };
    return host;
}

function makeControl(host: RecordingHost, options: Record<string, unknown> = {}): SessionControl {
    const control = new SessionControl(host, {
        probeTimeoutMs: 100,
        negotiateTimeoutMs: 200,
        resultTimeoutMs: 60_000,
        ...options,
    });
    controls.push(control);
    return control;
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

describe("认领与释放", () => {
    test("空闲会话可直接认领，重复认领幂等", async () => {
        const host = makeHost();
        const control = makeControl(host);

        expect(await control.claim("a")).toEqual({ ok: true });
        expect(control.isClaimed("a")).toBe(true);
        expect(control.claimedSessionIds).toEqual(["a"]);
        expect(await control.claim("a")).toEqual({ ok: true });
        expect(fs.existsSync(getSocketPath("a"))).toBe(true);
    });

    test("主动释放后 socket 文件消失、不再自认领", async () => {
        const host = makeHost();
        const control = makeControl(host);
        await control.claim("a");

        control.release("a");
        expect(control.isClaimed("a")).toBe(false);
        expect(fs.existsSync(getSocketPath("a"))).toBe(false);
    });

    test("其他实例空闲时协商成功并接管", async () => {
        const fake = new FakePeer("b");
        fakes.push(fake);
        await fake.start();

        const host = makeHost();
        const control = makeControl(host);
        expect(await control.claim("b")).toEqual({ ok: true });
        expect(fake.released.count).toBe(1);
        expect(control.isClaimed("b")).toBe(true);
    });

    test("其他实例忙碌时拒绝转移，认领失败为 busy", async () => {
        const fake = new FakePeer("c");
        fake.releaseAllowed = false;
        fakes.push(fake);
        await fake.start();

        const host = makeHost();
        const control = makeControl(host);
        expect(await control.claim("c")).toEqual({ ok: false, reason: "busy" });
        expect(control.isClaimed("c")).toBe(false);
        expect(host.releasedSessions).toEqual([]);
    });

    test("持有者无应答时放弃认领（不夺权）", async () => {
        const fake = new FakePeer("d");
        fake.silent = true;
        fakes.push(fake);
        await fake.start();

        const control = makeControl(makeHost());
        expect(await control.claim("d")).toEqual({ ok: false, reason: "unresponsive" });
        expect(fs.existsSync(getSocketPath("d"))).toBe(true);
    });

    test("远端协商释放成功时通知宿主摘掉会话", async () => {
        const host = makeHost();
        const control = makeControl(host);
        await control.claim("e");

        // 模拟另一个实例发起协商：本实例放行（空闲）
        const reply = await fetchRelease(control, "e");
        expect(reply).toBe("ok");
        expect(host.releasedSessions).toEqual(["e"]);
        expect(control.isClaimed("e")).toBe(false);
    });
});

describe("派生子会话", () => {
    test("继承父会话 cwd、立即认领并通知宿主", async () => {
        const host = makeHost();
        const control = makeControl(host);

        const result = await control.spawnSession("parent", "读日志");

        expect(result).toEqual({ ok: true, sessionId: "spawned-1" });
        expect(host.createdCwds).toEqual(["/cwd/parent"]);
        expect(host.spawnedSessions).toEqual(["spawned-1"]);
        expect(control.isClaimed("spawned-1")).toBe(true);
        expect(control.spawnedCount).toBe(1);
    });

    test("释放后名额归还，可继续派生", async () => {
        const host = makeHost();
        const control = makeControl(host);
        const first = await control.spawnSession("parent");

        control.release(first.ok ? first.sessionId : "");
        expect(control.spawnedCount).toBe(0);
        expect((await control.spawnSession("parent")).ok).toBe(true);
    });
});

describe("同进程直投", () => {
    test("目标是本实例会话时走内存，不建 socket 连接", async () => {
        const host = makeHost();
        const control = makeControl(host);
        await control.claim("a");
        await control.claim("b");

        const { message } = await control.send("a", "b", "帮我看下日志");
        expect(host.accepted.map((item) => item.id)).toEqual([message.id]);
        expect(host.outbound.map((item) => item.id)).toEqual([message.id]);
    });

    test("目标忙时直接报错且不残留投递记录", async () => {
        const host = makeHost();
        const control = makeControl(host);
        await control.claim("a");
        await control.claim("b");
        host.busy.add("b");

        await expect(control.send("a", "b", "在吗")).rejects.toBeInstanceOf(PeerSendFailure);
        expect(host.accepted).toEqual([]);

        // 解忙后可再次投递（说明上一次没有留下脏状态）
        host.busy.delete("b");
        const { message } = await control.send("a", "b", "在吗");
        expect(host.accepted.map((item) => item.id)).toEqual([message.id]);
    });

    test("expect_result 的结果直接回到请求者队列", async () => {
        const host = makeHost();
        const control = makeControl(host);
        await control.claim("a");
        await control.claim("b");

        const { message } = await control.send("a", "b", "跑一下", { expectResult: true });
        expect(control.awaitingResults("a")).toBe(1);

        control.completeInbound("b", message, { msgId: message.id, ok: true, text: "跑完了", stopReason: "stop" });

        expect(control.awaitingResults("a")).toBe(0);
        expect(control.queuedResults("a")).toBe(1);
        expect(host.results.map((item) => item.result.text)).toEqual(["跑完了"]);

        const injected = control.takeResults("a");
        expect(injected.length).toBe(1);
        expect(injected[0]).toContain("跑完了");
        expect(control.queuedResults("a")).toBe(0);
    });

    test("被取消的回合回传结果时，文本标明已取消而不是普通结果", async () => {
        const host = makeHost();
        const control = makeControl(host);
        await control.claim("a");
        await control.claim("b");

        const { message } = await control.send("a", "b", "跑一下", { expectResult: true });
        control.completeInbound("b", message, {
            msgId: message.id,
            ok: true,
            text: "",
            stopReason: "aborted",
        });

        const injected = control.takeResults("a");
        expect(injected[0]).toContain("（已取消）");
        expect(injected[0]).toContain("（本轮被取消，没有文本输出）");
    });

    test("accept 在 send 返回前完成时，预登记的期望仍能接住结果", async () => {
        let control: SessionControl;
        const host = makeHost();
        host.accept = message => {
            control.completeInbound(message.to, message, {
                msgId: message.id,
                ok: true,
                text: "立即完成",
                stopReason: "stop",
            });
            return { status: "accepted" as const };
        };
        control = makeControl(host);
        await control.claim("target");

        const { message } = await control.send("requester", "target", "快速任务", { expectResult: true });

        expect(control.queuedResults("requester")).toBe(1);
        expect(host.results[0]?.result.msgId).toBe(message.id);
        expect(control.takeResults("requester")[0]).toContain("立即完成");
    });

    test("auto_close 不因跨进程 socket.write 成功而归档，保留 pending 查询通道", async () => {
        const childHost = makeHost();
        const childControl = makeControl(childHost);
        const spawned = await childControl.spawnSession("parent", "自动关闭子会话", { autoClose: true });
        expect(spawned.ok).toBe(true);
        if (!spawned.ok) return;

        const senderHost = makeHost();
        const senderControl = makeControl(senderHost);
        await senderControl.send("remote-parent", spawned.sessionId, "执行远程任务", { expectResult: true });
        const message = senderHost.outbound[0]!;

        // 远端 delivery socket 仍可写，所以服务端 pushResult() 会返回 true；但这不等于对端收到。
        childControl.completeInbound(spawned.sessionId, message, {
            msgId: message.id,
            ok: true,
            text: "已完成",
            stopReason: "stop",
        });
        await waitFor(() => senderHost.results.length === 1);

        expect(childHost.archivedSessions).toEqual([]);
        expect(childControl.spawnedCount).toBe(1);
        expect(childControl.isClaimed(spawned.sessionId)).toBe(true);
        expect(senderHost.results[0]?.result.text).toBe("已完成");
    });

    test("半死连接未消费 push 时，auto_close 保留会话供 query_pending 补发", async () => {
        const host = makeHost();
        const control = makeControl(host);
        const spawned = await control.spawnSession("parent", "断线恢复子会话", { autoClose: true });
        expect(spawned.ok).toBe(true);
        if (!spawned.ok) return;

        const message = createPeerMessage({
            from: "remote-parent",
            to: spawned.sessionId,
            text: "执行任务",
            expectResult: true,
        });
        const socket = net.createConnection(getSocketPath(spawned.sessionId));
        socket.setEncoding("utf8");
        await new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
        });

        const ackPromise = new Promise<any>((resolve, reject) => {
            let buffer = "";
            const onData = (chunk: string) => {
                buffer += chunk;
                const split = splitFrames(buffer);
                buffer = split.rest;
                for (const frame of split.frames) {
                    if (frame.type !== "ack") continue;
                    socket.off("data", onData);
                    resolve(frame);
                }
            };
            socket.on("data", onData);
            socket.once("error", reject);
        });

        socket.write(encodeFrame({ type: "deliver", id: "deliver-half-dead", message }));
        expect(await ackPromise).toEqual({ type: "ack", id: "deliver-half-dead", ok: true });
        // 保持 TCP socket 可写，但暂停应用层读取：pushResult 的 socket.write 可成功，结果帧未被消费。
        socket.pause();
        control.completeInbound(spawned.sessionId, message, {
            msgId: message.id,
            ok: true,
            text: "可恢复结果",
            stopReason: "stop",
        });
        expect(host.archivedSessions).toEqual([]);
        socket.destroy();

        const pending = await requestOnce(getSocketPath(spawned.sessionId), {
            type: "query_pending",
            id: "query-half-dead",
            msgIds: [message.id],
        }, 300);
        expect(pending.type).toBe("pending_state");
        if (pending.type === "pending_state") {
            expect(pending.done).toEqual([{
                msgId: message.id,
                ok: true,
                text: "可恢复结果",
                stopReason: "stop",
            }]);
        }
        expect(control.spawnedCount).toBe(1);
        expect(control.isClaimed(spawned.sessionId)).toBe(true);
    });

    test("迟到结果在超时通知后仍进入队列，并在本地接收后自动归档", async () => {
        const host = makeHost();
        const control = makeControl(host, { resultTimeoutMs: 10 });
        const spawned = await control.spawnSession("parent", "延迟结果子会话", { autoClose: true });
        expect(spawned.ok).toBe(true);
        if (!spawned.ok) return;

        const { message } = await control.send("parent", spawned.sessionId, "执行任务", { expectResult: true });
        await waitFor(() => host.lost.length === 1);
        control.completeInbound(spawned.sessionId, message, {
            msgId: message.id,
            ok: true,
            text: "迟到结果",
            stopReason: "stop",
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(host.lost).toHaveLength(1);
        expect(host.results).toEqual([{ requester: "parent", result: {
            msgId: message.id,
            ok: true,
            text: "迟到结果",
            stopReason: "stop",
        }, late: true }]);
        expect(control.takeResults("parent")).toEqual([
            `[会话 ${spawned.sessionId} 的结果（迟到）]\n迟到结果\n（stopReason: stop）`,
        ]);
        expect(host.archivedSessions).toEqual([{ sessionId: spawned.sessionId, automatic: true }]);
        expect(control.spawnedCount).toBe(0);
    });

    test("跨进程迟到结果进入请求方队列并标记 late，但不自动归档", async () => {
        const childHost = makeHost();
        const childControl = makeControl(childHost);
        const spawned = await childControl.spawnSession("child-parent", "远端迟到结果", { autoClose: true });
        expect(spawned.ok).toBe(true);
        if (!spawned.ok) return;

        const senderHost = makeHost();
        const senderControl = makeControl(senderHost, { resultTimeoutMs: 10 });
        await senderControl.send("remote-parent", spawned.sessionId, "执行远程任务", { expectResult: true });
        const message = senderHost.outbound[0]!;
        await waitFor(() => senderHost.lost.length === 1);

        childControl.completeInbound(spawned.sessionId, message, {
            msgId: message.id,
            ok: true,
            text: "远端迟到结果正文",
            stopReason: "stop",
        });
        await waitFor(() => senderHost.results.length === 1);

        expect(senderHost.results[0]?.late).toBe(true);
        expect(senderControl.takeResults("remote-parent")).toEqual([
            `[会话 ${spawned.sessionId} 的结果（迟到）]\n远端迟到结果正文\n（stopReason: stop）`,
        ]);
        expect(childHost.archivedSessions).toEqual([]);
        expect(childControl.spawnedCount).toBe(1);
    });

    test("不期望结果时不留等待项", async () => {
        const host = makeHost();
        const control = makeControl(host);
        await control.claim("a");
        await control.claim("b");

        const { message } = await control.send("a", "b", "通知一下");
        control.completeInbound("b", message, { msgId: message.id, ok: true, text: "收到", stopReason: "stop" });

        expect(control.awaitingResults("a")).toBe(0);
        expect(control.queuedResults("a")).toBe(0);
    });

    test("不能给自己发消息", async () => {
        const control = makeControl(makeHost());
        await control.claim("a");
        await expect(control.send("a", "a", "自问自答")).rejects.toBeInstanceOf(PeerSendFailure);
    });

    test("同一会话的短 id / 大小写变体也算自己", async () => {
        const control = makeControl(makeHost());
        const self = "01JAAAAAAAAAAAAAAAAAAAAAA1";
        await control.claim(self);
        for (const alias of [self.slice(-8), self.toLowerCase()]) {
            await expect(control.send(self, alias, "自问自答")).rejects.toThrow(/不能给自己发消息/);
        }
    });

    test("过短的尾串不当成自己：按普通目标处理（不可达）", async () => {
        const control = makeControl(makeHost());
        const self = "01JAAAAAAAAAAAAAAAAAAAAAA1";
        await control.claim(self);
        await expect(control.send(self, "AA1", "hi")).rejects.toThrow(/不可达/);
    });
});

describe("跨进程投递", () => {
    test("目标不可达时报 unreachable", async () => {
        const host = makeHost();
        const control = makeControl(host);
        await control.claim("a");

        await expect(control.send("a", "missing", "hi")).rejects.toBeInstanceOf(PeerSendFailure);
        expect(host.outbound).toEqual([]);
    });

    test("远端忙时原样上抛 busy", async () => {
        const fake = new FakePeer("f");
        fake.deliverBusy = true;
        fakes.push(fake);
        await fake.start();

        const host = makeHost();
        const control = makeControl(host);
        await control.claim("a");

        const failure = await control.send("a", "f", "hi").catch((error) => error);
        expect(failure).toBeInstanceOf(PeerSendFailure);
        expect((failure as PeerSendFailure).reason).toBe("busy");
    });

    test("远端受理成功后成功返回，且不写本地直投标记", async () => {
        const fake = new FakePeer("g");
        fakes.push(fake);
        await fake.start();

        const host = makeHost();
        const control = makeControl(host);
        await control.claim("a");

        const { message } = await control.send("a", "g", "跑个任务", { expectResult: true });
        expect(fake.delivered.map((item) => item.id)).toEqual([message.id]);
        expect(host.outbound.map((item) => item.id)).toEqual([message.id]);
        expect(control.awaitingResults("a")).toBe(1);
    });
});

describe("等待超时", () => {
    test("超时未回结果时上报丢失并清理等待项", async () => {
        const host = makeHost();
        const control = makeControl(host, { resultTimeoutMs: 30 });
        await control.claim("a");
        await control.claim("b");

        const { message } = await control.send("a", "b", "慢慢来", { expectResult: true });
        await waitFor(() => host.lost.length > 0);

        expect(host.lost[0]?.msgIds).toEqual([message.id]);
        expect(control.awaitingResults("a")).toBe(0);
        expect(control.queuedResults("a")).toBe(0);
    });
});

describe("阻塞等待结果", () => {
    /** 建一对同进程会话，返回已发出、仍在等结果的消息。 */
    async function sendExpecting(control: SessionControl) {
        await control.claim("a");
        await control.claim("b");
        const { message } = await control.send("a", "b", "跑一下", { expectResult: true });
        return message;
    }

    test("命中时直接返回结果，不入队也不通知宿主", async () => {
        const host = makeHost();
        const control = makeControl(host);
        const message = await sendExpecting(control);

        const waiting = control.waitForResult(message.id, 5_000);
        control.completeInbound("b", message, { msgId: message.id, ok: true, text: "跑完了", stopReason: "stop" });

        const outcome = await waiting;
        expect(outcome.ok).toBe(true);
        expect(outcome.ok ? outcome.result.text : "").toBe("跑完了");
        expect(control.awaitingResults("a")).toBe(0);
        expect(control.queuedResults("a")).toBe(0);
        expect(control.takeResults("a")).toEqual([]);
        expect(host.results).toEqual([]);
    });

    test("超时只解除等待，结果到达仍入队并通知宿主", async () => {
        const host = makeHost();
        const control = makeControl(host);
        const message = await sendExpecting(control);

        expect(await control.waitForResult(message.id, 20)).toEqual({ ok: false, reason: "timeout" });
        expect(control.awaitingResults("a")).toBe(1);

        control.completeInbound("b", message, { msgId: message.id, ok: true, text: "迟到的结果", stopReason: "stop" });
        expect(control.queuedResults("a")).toBe(1);
        expect(host.results.map(item => item.result.text)).toEqual(["迟到的结果"]);
        expect(control.takeResults("a")[0]).toContain("迟到的结果");
    });

    test("消息不在等待表里时返回 none", async () => {
        const control = makeControl(makeHost());
        expect(await control.waitForResult("missing", 20)).toEqual({ ok: false, reason: "none" });
    });

    test("调用方已中止时直接返回 aborted，等待项保留", async () => {
        const host = makeHost();
        const control = makeControl(host);
        const message = await sendExpecting(control);

        const controller = new AbortController();
        controller.abort();

        expect(await control.waitForResult(message.id, 5_000, controller.signal)).toEqual({
            ok: false,
            reason: "aborted",
        });
        expect(control.awaitingResults("a")).toBe(1);
    });

    test("等待期间中止时立即兑现 aborted", async () => {
        const host = makeHost();
        const control = makeControl(host);
        const message = await sendExpecting(control);

        const controller = new AbortController();
        const waiting = control.waitForResult(message.id, 5_000, controller.signal);
        controller.abort();

        expect(await waiting).toEqual({ ok: false, reason: "aborted" });
    });

    test("等待超过结果上限时间时兑现 timeout 并上报丢失", async () => {
        const host = makeHost();
        const control = makeControl(host, { resultTimeoutMs: 30 });
        const message = await sendExpecting(control);

        expect(await control.waitForResult(message.id, 5_000)).toEqual({ ok: false, reason: "timeout" });
        expect(host.lost.map(item => item.msgIds)).toEqual([[message.id]]);
        expect(control.awaitingResults("a")).toBe(0);
    });

    test("关闭通道时未兑现的等待返回 aborted", async () => {
        const host = makeHost();
        const control = makeControl(host);
        const message = await sendExpecting(control);

        const waiting = control.waitForResult(message.id, 5_000);
        control.close();
        expect(await waiting).toEqual({ ok: false, reason: "aborted" });
    });

    test("放入后台：等待兑现为 detached，结果到达仍入队并通知宿主", async () => {
        const host = makeHost();
        const control = makeControl(host);
        const message = await sendExpecting(control);

        const waiting = control.waitForResult(message.id, 5_000);
        expect(control.detachWaits("a")).toBe(1);
        expect(await waiting).toEqual({ ok: false, reason: "detached" });
        // 等待项保留：结果只是转入后台
        expect(control.awaitingResults("a")).toBe(1);

        control.completeInbound("b", message, { msgId: message.id, ok: true, text: "后台结果", stopReason: "stop" });
        expect(control.queuedResults("a")).toBe(1);
        expect(host.results.map(item => item.result.text)).toEqual(["后台结果"]);
    });

    test("没有前台等待时放入后台是空操作", async () => {
        const host = makeHost();
        const control = makeControl(host);
        await sendExpecting(control);

        expect(control.detachWaits("a")).toBe(0);
        expect(control.detachWaits("missing")).toBe(0);
    });
});

describe("结果暂存与补发", () => {
    test("发起方断线时结果被暂存，重连 query_pending 取回", async () => {
        const host = makeHost();
        const control = makeControl(host);
        await control.claim("a");

        // 远端发起方投递后立刻断线
        const first = await connectPeer("a");
        const message: PeerMessage = {
            id: "msg-stash-1",
            from: "remote",
            to: "a",
            text: "跑个任务",
            expectResult: true,
            createdAt: new Date().toISOString(),
        };
        first.socket.write(encodeFrame({ type: "deliver", id: "d1", message }));
        expect((await first.next("ack")).type).toBe("ack");
        first.close();

        await waitFor(() => host.accepted.length === 1);
        control.completeInbound("a", message, { msgId: message.id, ok: true, text: "暂存的结果", stopReason: "stop" });

        // 重连后取回：done 带结果，pending 为空，且第二次查询不再返回
        const second = await connectPeer("a");
        second.socket.write(encodeFrame({ type: "query_pending", id: "q1", msgIds: [message.id] }));
        const reply = await second.next("pending_state");
        second.close();

        expect(reply.type).toBe("pending_state");
        if (reply.type !== "pending_state") return;
        expect(reply.done.map((item) => item.text)).toEqual(["暂存的结果"]);
        expect(reply.pending).toEqual([]);

        const third = await connectPeer("a");
        third.socket.write(encodeFrame({ type: "query_pending", id: "q2", msgIds: [message.id] }));
        const again = await third.next("pending_state");
        third.close();
        expect(again.type === "pending_state" && again.done).toEqual([]);
    });
});

/** 以另一实例的身份连到本实例的 socket，按帧类型取一条应答。 */
async function connectPeer(sessionId: string): Promise<{
    socket: net.Socket;
    next: (type: string) => Promise<PeerFrame>;
    close: () => void;
}> {
    const socket = new net.Socket();
    socket.setEncoding("utf8");
    const queue: PeerFrame[] = [];
    const waiters: Array<{ type: string; resolve: (frame: PeerFrame) => void }> = [];
    let buffer = "";

    socket.on("data", (chunk: string) => {
        buffer += chunk;
        const { frames, rest } = splitFrames(buffer);
        buffer = rest;
        for (const frame of frames) {
            const index = waiters.findIndex((waiter) => waiter.type === frame.type);
            if (index === -1) queue.push(frame);
            else waiters.splice(index, 1)[0]!.resolve(frame);
        }
    });
    socket.on("error", () => undefined);

    await new Promise<void>((resolve) => socket.connect(getSocketPath(sessionId), () => resolve()));

    return {
        socket,
        next: (type: string) =>
            new Promise<PeerFrame>((resolve) => {
                const index = queue.findIndex((frame) => frame.type === type);
                if (index !== -1) return resolve(queue.splice(index, 1)[0]!);
                waiters.push({ type, resolve });
            }),
        close: () => socket.destroy(),
    };
}

/** 以另一实例的身份请求本实例释放会话，返回结果描述。 */
async function fetchRelease(_control: SessionControl, sessionId: string): Promise<string> {
    const peer = await connectPeer(sessionId);
    peer.socket.write(encodeFrame({ type: "release", id: "r1" }));
    const reply = await peer.next("release_result");
    peer.close();
    if (reply.type !== "release_result") return "error";
    return reply.ok ? "ok" : "busy";
}

describe("运行时改标题", () => {
    test("持有者落盘并回传生效值，空标题给明确原因", async () => {
        const host = makeHost();
        const control = makeControl(host);
        await control.claim("t1");

        const ok = await requestOnce(getSocketPath("t1"), { type: "rename", id: "n1", title: "  重构标题  " }, 500);
        expect(ok.type).toBe("rename_result");
        if (ok.type !== "rename_result") throw new Error("预期 rename_result");
        expect(ok.ok).toBe(true);
        expect(ok.title).toBe("重构标题");
        expect(host.renamed).toEqual([{ sessionId: "t1", title: "重构标题" }]);

        const blank = await requestOnce(getSocketPath("t1"), { type: "rename", id: "n2", title: "   " }, 500);
        if (blank.type !== "rename_result") throw new Error("预期 rename_result");
        expect(blank.ok).toBe(false);
        expect(blank.error).toContain("不能为空");
        expect(host.renamed).toHaveLength(1);
    });
});

describe("结果文本形态", () => {
    test("正常完成、未完成、已取消三种终态措辞互不混淆", () => {
        const base = { msgId: "msg-1", text: "" };

        expect(formatResultText("s1", { ...base, ok: true, stopReason: "stop" })).toContain("[会话 s1 的结果]");
        expect(formatResultText("s1", { ...base, ok: false, stopReason: "error" })).toContain("（未正常完成）");
        expect(formatResultText("s1", { ...base, ok: true, stopReason: "aborted" })).toContain("（已取消）");
        expect(formatResultText("s1", { ...base, ok: true, stopReason: "aborted" })).toContain("（本轮被取消，没有文本输出）");
    });
});
