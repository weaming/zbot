/**
 * 会话间通信的真实跨进程验证：两个 OS 进程各自认领会话，通过 unix socket 交付消息与回传结果。
 *
 * 单元测试已在同进程内覆盖协议与编排逻辑，这里只验证进程边界上的事实：
 * - 归属探测能读到**另一个进程**的 pid/title/busy；
 * - 结果确实跨越进程回到发起方队列（下一次请求附加的那份文本）；
 * - 目标忙时协商被拒（不夺权）、不可达时直接报错；
 * - 持有者被 kill 后 socket 成为 stale，由清理逻辑回收。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { SessionControl, PeerSendFailure } from "../../src/control/channel.js";
import { getSocketPath } from "../../src/control/paths.js";
import { cleanupStaleSockets, probeOwnership } from "../../src/control/registry.js";
import type { PeerMessage, PeerResult } from "../../src/control/protocol.js";

const PROJECT_ROOT = path.resolve(import.meta.dir, "..", "..");
const CHILD_SCRIPT = path.resolve(import.meta.dir, "helpers", "peer-child.ts");

const SESSION_PARENT = "01PEERPARENT0000000000000AA";
const SESSION_CHILD = "01PEERCHILD0000000000000BB";
const SESSION_BUSY = "01PEERBUSY00000000000000CC";
const SESSION_MISSING = "01PEERNONE00000000000000DD";

let stateDir: string;
let originalStateDir: string | undefined;

/** 子进程 stdout 的 JSON 事件流：按事件名等待，超时即失败。 */
class ChildPeer {
    readonly events: Array<Record<string, any>> = [];
    private buffer = "";
    private readonly decoder = new TextDecoder();

    private constructor(
        readonly sessionId: string,
        private readonly proc: ReturnType<typeof Bun.spawn>,
    ) {
        void this.pump();
    }

    static spawn(sessionId: string, env: Record<string, string> = {}): ChildPeer {
        const proc = Bun.spawn(["bun", CHILD_SCRIPT], {
            cwd: PROJECT_ROOT,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "inherit",
            env: {
                ...process.env,
                ZBOT_STATE_DIR: stateDir,
                PEER_CHILD_SESSION: sessionId,
                ...env,
            },
        });
        return new ChildPeer(sessionId, proc);
    }

    private async pump(): Promise<void> {
        const stream = this.proc.stdout as ReadableStream<Uint8Array>;
        for await (const chunk of stream) {
            this.buffer += this.decoder.decode(chunk as Uint8Array);
            let index = this.buffer.indexOf("\n");
            while (index >= 0) {
                const line = this.buffer.slice(0, index).trim();
                this.buffer = this.buffer.slice(index + 1);
                index = this.buffer.indexOf("\n");
                if (line) this.events.push(JSON.parse(line));
            }
        }
    }

    get pid(): number {
        const ready = this.events.find(event => event.event === "ready");
        if (!ready) throw new Error("子进程尚未 ready");
        return ready.pid;
    }

    send(command: string): void {
        (this.proc.stdin as { write(data: string): void }).write(`${command}\n`);
    }

    async waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (check()) return;
            await Bun.sleep(10);
        }
        throw new Error(`等待超时：${label}；已收到事件 ${JSON.stringify(this.events)}`);
    }

    waitEvent(name: string, timeoutMs = 5_000): Promise<Record<string, any>> {
        return this.waitFor(() => this.events.some(event => event.event === name), name, timeoutMs).then(
            () => this.events.find(event => event.event === name)!,
        );
    }

    kill(): void {
        this.proc.kill("SIGKILL");
    }
}

/** 父进程宿主：记录收到的结果与丢失通知，供断言。 */
function createHost(sessionId: string) {
    const state = {
        results: [] as Array<{ requester: string; message: PeerMessage; result: PeerResult }>,
        lost: [] as Array<{ requester: string; msgIds: string[]; target: string }>,
        released: [] as string[],
    };
    const control = new SessionControl({
        title: () => "parent",
        isBusy: () => false,
        accept: () => ({ status: "accepted" as const }),
        onOutbound: () => {},
        onResult: (requester, message, result) => state.results.push({ requester, message, result }),
        onLost: (requester, msgIds, target) => state.lost.push({ requester, msgIds, target }),
        onReleased: (released) => state.released.push(released),
    }, { probeTimeoutMs: 500, negotiateTimeoutMs: 500 });
    return { control, state, sessionId };
}

let parent: ReturnType<typeof createHost>;
let child: ChildPeer;

beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-peer-xproc-"));
    originalStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = stateDir;

    parent = createHost(SESSION_PARENT);
    const claimed = await parent.control.claim(SESSION_PARENT);
    expect(claimed).toEqual({ ok: true });

    child = ChildPeer.spawn(SESSION_CHILD, { PEER_CHILD_TITLE: "对端会话" });
    await child.waitEvent("ready");
    child.send("claim");
    const claim = await child.waitEvent("claim");
    expect(claim.result).toEqual({ ok: true });
});

afterAll(async () => {
    parent?.control.close();
    child?.kill();
    if (originalStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = originalStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("跨进程归属", () => {
    test("本实例持有的会话探测为 mine", async () => {
        expect(await parent.control.probe(SESSION_PARENT)).toEqual({ state: "mine" });
    });

    test("另一进程持有的会话能读到 pid/title/busy", async () => {
        const ownership = await parent.control.probe(SESSION_CHILD);

        expect(ownership.state).toBe("other");
        if (ownership.state !== "other") return;
        expect(ownership.info?.pid).toBe(child.pid);
        expect(ownership.info?.title).toBe("对端会话");
        expect(ownership.info?.busy).toBe(false);
    });

    test("未认领的会话探测为 free", async () => {
        expect(await parent.control.probe(SESSION_MISSING)).toEqual({ state: "free" });
    });
});

describe("跨进程消息与结果回传", () => {
    test("发消息到另一进程并拿回结果（结果进请求者队列）", async () => {
        const { message } = await parent.control.send(SESSION_PARENT, SESSION_CHILD, "你好", { expectResult: true });

        expect(parent.control.awaitingResults(SESSION_PARENT)).toBe(1);

        const inbound = await child.waitEvent("inbound");
        expect(inbound.text).toBe("你好");
        expect(inbound.expectResult).toBe(true);

        await waitUntil(() => parent.state.results.length === 1, "结果回到父进程");

        expect(parent.state.results[0].result.text).toBe("已处理:你好");
        expect(parent.state.results[0].requester).toBe(SESSION_PARENT);
        expect(parent.state.results[0].message.id).toBe(message.id);

        // 结果不额外驱动一轮：只进队列，等下一次请求取走
        await waitUntil(() => parent.control.awaitingResults(SESSION_PARENT) === 0, "等待结果落地");
        const queued = parent.control.takeResults(SESSION_PARENT);

        expect(queued).toHaveLength(1);
        expect(queued[0]).toContain("已处理:你好");
        expect(queued[0]).toContain(SESSION_CHILD);
        expect(parent.control.takeResults(SESSION_PARENT)).toEqual([]);
    });

    test("阻塞等待时结果直接返回，不入请求者队列", async () => {
        const resultsBefore = parent.state.results.length;
        const { message } = await parent.control.send(SESSION_PARENT, SESSION_CHILD, "快点", { expectResult: true });

        const outcome = await parent.control.waitForResult(message.id, 5_000);

        expect(outcome.ok).toBe(true);
        expect(outcome.ok ? outcome.result.text : "").toBe("已处理:快点");
        expect(parent.state.results.length).toBe(resultsBefore);
        expect(parent.control.awaitingResults(SESSION_PARENT)).toBe(0);
        expect(parent.control.queuedResults(SESSION_PARENT)).toBe(0);
        expect(parent.control.takeResults(SESSION_PARENT)).toEqual([]);
    });

    test("等待超时只解除等待，结果照旧进队列", async () => {
        const { message } = await parent.control.send(SESSION_PARENT, SESSION_CHILD, "慢慢来", { expectResult: true });

        expect(await parent.control.waitForResult(message.id, 1)).toEqual({ ok: false, reason: "timeout" });

        await waitUntil(() => parent.control.queuedResults(SESSION_PARENT) === 1, "超时后的结果入队");
        expect(parent.control.takeResults(SESSION_PARENT)[0]).toContain("已处理:慢慢来");
    });

    test("目标不可达时直接报错，不排队不重试", async () => {
        const failure = await parent.control
            .send(SESSION_PARENT, SESSION_MISSING, "在吗", {})
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(PeerSendFailure);
        expect((failure as PeerSendFailure).reason).toBe("unreachable");
    });
});

describe("跨进程归属协商", () => {
    test("持有者忙时协商被拒（不夺权）", async () => {
        const busyChild = ChildPeer.spawn(SESSION_BUSY, { PEER_CHILD_BUSY: "1" });
        try {
            await busyChild.waitEvent("ready");
            busyChild.send("claim");
            expect((await busyChild.waitEvent("claim")).result).toEqual({ ok: true });

            const attempt = await parent.control.claim(SESSION_BUSY);

            expect(attempt.ok).toBe(false);
            expect((attempt as { reason: string }).reason).toBe("busy");
            // 被拒绝后 socket 仍归对方所有
            const ownership = await parent.control.probe(SESSION_BUSY);
            expect(ownership.state).toBe("other");
            expect((ownership as { info?: { pid: number } }).info?.pid).toBe(busyChild.pid);
            // 对方也没收到释放通知
            expect(busyChild.events.some(event => event.event === "released")).toBe(false);
        } finally {
            busyChild.kill();
        }
    });
});

describe("stale socket 清理", () => {
    test("持有者被杀后 socket 变 stale 并被清理", async () => {
        expect(fs.existsSync(getSocketPath(SESSION_CHILD))).toBe(true);

        child.kill();
        await parent.control.probe(SESSION_CHILD);
        // 等连接真正断开（进程退出后 connect 必然失败）
        await waitUntil(async () => (await probeOwnership(SESSION_CHILD, 200)).state === "free", "对端进程退出");

        const removed = await cleanupStaleSockets(200);
        expect(removed).toContain(SESSION_CHILD);
        expect(fs.existsSync(getSocketPath(SESSION_CHILD))).toBe(false);
        expect(await probeOwnership(SESSION_CHILD, 200)).toEqual({ state: "free" });
    });
});

async function waitUntil(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await Bun.sleep(10);
    }
    throw new Error(`等待超时：${label}`);
}
