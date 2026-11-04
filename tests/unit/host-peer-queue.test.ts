/**
 * 排队投递：忙时入队、回合结束自动执行、队列有界、msgId 幂等、取消与过期。
 *
 * 独立文件：mock.module 需要独占进程，否则会和真实上游请求串味。
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

/** 非空时回合会一直等它 resolve，用于制造“会话忙”。 */
let turnGate: Promise<void> | null = null;
let turnGateSession: string | null = null;
const startedSessions: string[] = [];
const finishedQueries: Array<{ sessionId?: string; query?: string }> = [];

const realChatRuntime = await import("../../src/services/chat-runtime.js");
mock.module("../../src/services/chat-runtime.js", () => ({
    ...realChatRuntime,
    runChatQuery: async (options: any) => {
        startedSessions.push(options.sessionId);
        if (turnGate && (!turnGateSession || options.sessionId === turnGateSession)) await turnGate;
        if (options.signal?.aborted) {
            options.onEvent?.({ type: "aborted", stopReason: "aborted" });
            return { content: "", toolCalls: 0, messages: [] };
        }
        finishedQueries.push({ sessionId: options.sessionId, query: options.query });
        options.onEvent?.({ type: "message_end", content: `输出 ${finishedQueries.length}`, stopReason: "stop" });
        return {
            content: `输出 ${finishedQueries.length}`,
            toolCalls: 0,
            messages: [{ role: "assistant", content: "ok" }],
        };
    },
}));

const { LocalSessionHost } = await import("../../src/host/session-host.js");
const { setSessionControl, setSessionDirectory } = await import("../../src/control/runtime.js");

let tmpDir: string;
let originalStateDir: string | undefined;
let agent: InstanceType<typeof LocalSessionHost>;
let sessionA: string;
let sessionB: string;

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-peer-queue-"));
    originalStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;

    agent = new LocalSessionHost();
    sessionA = (await agent.createSession()).sessionId;
    sessionB = (await agent.createSession()).sessionId;
    // 同进程直投要求目标由本实例持有
    await agent.claimSession(sessionA);
    await agent.claimSession(sessionB);
    turnGate = null;
    turnGateSession = null;
    startedSessions.length = 0;
    finishedQueries.length = 0;
});

afterEach(async () => {
    turnGate = null;
    turnGateSession = null;
    await agent.close();
    setSessionControl(undefined);
    setSessionDirectory(undefined);
    if (originalStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = originalStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
    mock.restore();
});

function readEvents(sessionId: string): any[] {
    const eventsPath = path.join(tmpDir, "sessions", "events", `${sessionId}.jsonl`);
    if (!fs.existsSync(eventsPath)) return [];
    return fs
        .readFileSync(eventsPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
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

/** 让指定会话的下一轮一直挂住，返回放行函数。 */
function holdSession(sessionId: string): () => void {
    let release!: () => void;
    turnGate = new Promise<void>(resolve => { release = resolve; });
    turnGateSession = sessionId;
    return () => {
        turnGate = null;
        turnGateSession = null;
        release();
    };
}

describe("排队投递", () => {
    test("忙时入队并返回位次；回合结束后自动执行并回传结果", async () => {
        const release = holdSession(sessionB);
        await agent.sessionControl.send(sessionA, sessionB, "占用", { expectResult: true });
        await waitFor(() => startedSessions.includes(sessionB));

        const queued = await agent.sessionControl.send(sessionA, sessionB, "追加指令", {
            expectResult: true,
            queueIfBusy: true,
        });
        expect(queued.queued).toBe(true);
        expect(queued.position).toBe(1);
        expect((await agent.sessionControl.queueState(sessionB)).map(entry => entry.msgId))
            .toEqual([queued.message.id]);
        expect(readEvents(sessionB).some(event => event.type === "peer_message"
            && event.payload.msgId === queued.message.id
            && event.payload.queued === true)).toBe(true);

        release();
        await waitFor(() => finishedQueries.filter(query => query.sessionId === sessionB).length === 2);
        expect((await agent.sessionControl.queueState(sessionB))).toEqual([]);
        await waitFor(() => readEvents(sessionA).filter(event => event.type === "peer_result").length === 2);
    });

    test("队列有界：超过上限返回 queue_full", async () => {
        const release = holdSession(sessionB);
        await agent.sessionControl.send(sessionA, sessionB, "占用", { expectResult: true });
        await waitFor(() => startedSessions.includes(sessionB));

        for (let index = 0; index < 8; index += 1) {
            const item = await agent.sessionControl.send(sessionA, sessionB, `排队 ${index}`, { queueIfBusy: true });
            expect(item.queued).toBe(true);
            expect(item.position).toBe(index + 1);
        }
        const overflowId = "01QUEUEFULL000000000000000";
        const firstFull = await agent.sessionControl
            .send(sessionA, sessionB, "溢出", { queueIfBusy: true, messageId: overflowId })
            .catch(error => error);
        expect(firstFull).toMatchObject({ reason: "queue_full" });
        // 满队列时同一 msgId 重投也必须继续报 queue_full，不能静默变成 accepted
        const secondFull = await agent.sessionControl
            .send(sessionA, sessionB, "溢出", { queueIfBusy: true, messageId: overflowId })
            .catch(error => error);
        expect(secondFull).toMatchObject({ reason: "queue_full" });
        release();
    });

    test("msgId 幂等：重复投递不会重复执行，而是重推上次结果", async () => {
        const first = await agent.sessionControl.send(sessionA, sessionB, "只跑一次", {
            expectResult: true,
            messageId: "01IDEMPOTENT00000000000000",
        });
        const resultEvents = () => readEvents(sessionA).filter(event => event.type === "peer_result"
            && event.payload.msgId === first.message.id);
        await waitFor(() => resultEvents().length === 1);

        const again = await agent.sessionControl.send(sessionA, sessionB, "只跑一次", {
            expectResult: true,
            messageId: first.message.id,
        });
        expect(again.queued).toBe(false);
        // 重推同一份结果（而不是启动第二轮）
        await waitFor(() => resultEvents().length === 2);
        expect(finishedQueries.filter(query => query.sessionId === sessionB).length).toBe(1);
    });

    test("取消排队：出队并回传 cancelled 结果", async () => {
        const release = holdSession(sessionB);
        await agent.sessionControl.send(sessionA, sessionB, "占用", { expectResult: true });
        await waitFor(() => startedSessions.includes(sessionB));

        const queued = await agent.sessionControl.send(sessionA, sessionB, "会被取消", {
            expectResult: true,
            queueIfBusy: true,
        });
        expect(await agent.sessionControl.cancelQueued(sessionB, queued.message.id)).toEqual({ ok: true });
        expect(await agent.sessionControl.queueState(sessionB)).toEqual([]);
        await waitFor(() => readEvents(sessionA).some(event => event.type === "peer_result"
            && event.payload.msgId === queued.message.id
            && event.payload.stopReason === "cancelled"));

        // 已在执行的消息不可撤销
        expect((await agent.sessionControl.cancelQueued(sessionB, "01NOTQUEUED000000000000000")).ok).toBe(false);
        release();
    });

    test("并发入队不会互相覆盖", async () => {
        const release = holdSession(sessionB);
        await agent.sessionControl.send(sessionA, sessionB, "占用", { expectResult: true });
        await waitFor(() => startedSessions.includes(sessionB));

        const [first, second] = await Promise.all([
            agent.sessionControl.send(sessionA, sessionB, "并发一", { expectResult: true, queueIfBusy: true }),
            agent.sessionControl.send(sessionA, sessionB, "并发二", { expectResult: true, queueIfBusy: true }),
        ]);
        expect([first.position, second.position].sort()).toEqual([1, 2]);
        expect((await agent.sessionControl.queueState(sessionB)).map(entry => entry.msgId))
            .toEqual([first.message.id, second.message.id]);

        release();
        await waitFor(() => finishedQueries.filter(query => query.sessionId === sessionB).length === 3);
    });

    test("取消回合后排队消息继续执行（不永久停滞）", async () => {
        const spawned = await agent.sessionControl.spawnSession(sessionA, "取消测试");
        expect(spawned.ok).toBe(true);
        if (!spawned.ok) return;
        const child = spawned.sessionId;

        const release = holdSession(child);
        await agent.sessionControl.send(sessionA, child, "占用", { expectResult: true });
        await waitFor(() => startedSessions.includes(child));
        const queued = await agent.sessionControl.send(sessionA, child, "排队并继续", {
            expectResult: true,
            queueIfBusy: true,
        });

        const cancelPromise = agent.sessionControl.cancelSpawnedSession(child, { close: false });
        release();
        expect(await cancelPromise).toEqual({ ok: true, closed: false });

        // 取消也算回合结束：队首消息要被执行并回传结果
        await waitFor(() => finishedQueries.filter(query => query.sessionId === child).length === 1);
        await waitFor(() => readEvents(sessionA).some(event => event.type === "peer_result"
            && event.payload.msgId === queued.message.id));
    });

    test("宿主关闭时排队消息按 cancelled 收尾", async () => {
        const release = holdSession(sessionB);
        await agent.sessionControl.send(sessionA, sessionB, "占用", { expectResult: true });
        await waitFor(() => startedSessions.includes(sessionB));
        const queued = await agent.sessionControl.send(sessionA, sessionB, "来不及执行", {
            expectResult: true,
            queueIfBusy: true,
        });

        await agent.close();
        release();
        await waitFor(() => readEvents(sessionA).some(event => event.type === "peer_result"
            && event.payload.msgId === queued.message.id
            && event.payload.stopReason === "cancelled"));
    });

    test("过期：排队超时后不执行，回传 expired 结果", async () => {
        const release = holdSession(sessionB);
        await agent.sessionControl.send(sessionA, sessionB, "占用", { expectResult: true });
        await waitFor(() => startedSessions.includes(sessionB));

        const queued = await agent.sessionControl.send(sessionA, sessionB, "会过期", {
            expectResult: true,
            queueIfBusy: true,
            expiresAt: new Date(Date.now() - 1_000).toISOString(),
        });
        release();

        await waitFor(() => readEvents(sessionA).some(event => event.type === "peer_result"
            && event.payload.msgId === queued.message.id
            && event.payload.stopReason === "expired"));
        expect(finishedQueries.filter(query => query.sessionId === sessionB).length).toBe(1);
    });
});
