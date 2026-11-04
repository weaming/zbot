/**
 * LocalSessionHost 的会话间投递：认领、入站受理与落盘、回合结束自动回传结果、
 * 结果到达即驱动空闲请求方继续一轮（忙则留队列，回合结束补跑）。
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

/** 假 runChatQuery：跑一轮就发 message_end，模拟真实编排器的收尾事件。 */
let turnContent = "默认输出";
/** 非空时回合会一直等它 resolve，用于制造"会话忙"。 */
let turnGate: Promise<void> | null = null;
/** 非空时只闸住该会话的回合，其余会话照常跑完。 */
let turnGateSession: string | null = null;
/** 记录每次真实请求的参数，用于断言结果如何注入到驱动轮。 */
const queries: Array<{ sessionId?: string; query?: string; history: any[] }> = [];
const startedSessions: string[] = [];

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
        queries.push({ sessionId: options.sessionId, query: options.query, history: options.history ?? [] });
        options.onEvent?.({ type: "message_end", content: turnContent, stopReason: "stop" });
        return {
            content: turnContent,
            toolCalls: 0,
            messages: [{ role: "assistant", content: turnContent }],
        };
    },
}));

const { LocalSessionHost } = await import("../../src/host/session-host.js");
const { getSessionDirectory } = await import("../../src/control/runtime.js");
const { getSocketPath } = await import("../../src/control/paths.js");

let tmpDir: string;
let originalStateDir: string | undefined;
let agent: InstanceType<typeof LocalSessionHost>;
let sessionA: string;
let sessionB: string;

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-control-agent-"));
    originalStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;

    agent = new LocalSessionHost();
    sessionA = (await agent.createSession()).sessionId;
    sessionB = (await agent.createSession()).sessionId;
    turnContent = "默认输出";
    turnGate = null;
    turnGateSession = null;
    queries.length = 0;
    startedSessions.length = 0;
});

afterEach(async () => {
    turnGate = null;
    await agent.close();
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

describe("认领", () => {
    test("认领后本实例持有，socket 文件落盘", async () => {
        expect(agent.isSessionClaimed(sessionA)).toBe(false);
        expect(await agent.claimSession(sessionA)).toEqual({ ok: true });
        expect(agent.isSessionClaimed(sessionA)).toBe(true);
        expect(agent.claimedSessionIds()).toEqual([sessionA]);
        expect(fs.existsSync(getSocketPath(sessionA))).toBe(true);
    });

    test("释放后不再持有，且文件被清理", async () => {
        await agent.claimSession(sessionA);
        agent.releaseSession(sessionA);

        expect(agent.isSessionClaimed(sessionA)).toBe(false);
        expect(fs.existsSync(getSocketPath(sessionA))).toBe(false);
    });

    test("探测归属能区分本实例与未认领", async () => {
        expect(await agent.probeSession(sessionB)).toEqual({ state: "free" });
        await agent.claimSession(sessionB);
        expect(await agent.probeSession(sessionB)).toEqual({ state: "mine" });
    });
});

describe("会话间投递与结果回传", () => {
    test("派生的子会话继承 cwd、立即被认领，并通知宿主", async () => {
        await agent.claimSession(sessionA);
        const spawned: Array<{ sessionId: string; title?: string }> = [];
        agent.onSessionSpawned = (sessionId, title) => spawned.push({ sessionId, ...(title ? { title } : {}) });

        const result = await agent.sessionControl.spawnSession(sessionA, "读日志");

        expect(result.ok).toBe(true);
        const child = result.ok ? result.sessionId : "";
        expect(child).not.toBe(sessionA);
        expect(agent.isSessionClaimed(child)).toBe(true);
        expect(fs.existsSync(getSocketPath(child))).toBe(true);
        expect(await agent.getSessionCwd(child)).toBe(await agent.getSessionCwd(sessionA));
        expect(spawned).toEqual([{ sessionId: child, title: "读日志" }]);
    });

    test("派生的子会话可直接派活，结果自动回传给父会话", async () => {
        await agent.claimSession(sessionA);
        const spawned = await agent.sessionControl.spawnSession(sessionA);
        const child = spawned.ok ? spawned.sessionId : "";
        turnContent = "子会话的结论";

        const uiEvents: any[] = [];
        agent.onEvent = (_requestId, _sessionId, event) => uiEvents.push(event);
        await agent.sessionControl.send(sessionA, child, "读一遍日志", { expectResult: true });

        await waitFor(() => uiEvents.some(event => event.type === "peer_result"));
        // 父会话被结果驱动，结果原文进了它这一轮的 query
        await waitFor(() => queries.some(item => item.sessionId === sessionA));
        expect(queries.find(item => item.sessionId === sessionA)?.query).toContain("子会话的结论");
        expect(readEvents(child).filter(event => event.type === "user_message").length).toBe(1);
    });

    test("期望结果时对方回合输出自动回传给请求者", async () => {
        await agent.claimSession(sessionA);
        await agent.claimSession(sessionB);
        turnContent = "任务是：把日志读一遍，结论是没问题";

        const uiEvents: any[] = [];
        agent.onEvent = (_requestId, _sessionId, event) => uiEvents.push(event);

        // A 向 B 交付任务并期望结果
        await agent.sessionControl.send(sessionA, sessionB, "读一遍日志", { expectResult: true });

        // B 的回合结束后，结果应被自动回传给 A
        await waitFor(() => uiEvents.some(event => event.type === "peer_result"));
        const result = uiEvents.find(event => event.type === "peer_result");
        expect(result?.peerId).toBe(sessionB);
        expect(result?.text).toBe(turnContent);

        // 结果落盘后请求方被继续驱动：结果原文即本轮 query
        await waitFor(() => queries.some(item => item.sessionId === sessionA));
        expect(queries.filter(item => item.sessionId === sessionA)[0]?.query).toContain(turnContent);
        expect(agent.takePeerResults(sessionA)).toEqual([]);

        // 双方时间线各留一条事实
        const eventsA = readEvents(sessionA).filter(event => event.type === "peer_message");
        const eventsB = readEvents(sessionB).filter(event => event.type === "peer_message");
        expect(eventsA.map(event => event.payload.direction)).toEqual(["out"]);
        expect(eventsB.map(event => event.payload.direction)).toEqual(["in"]);
        expect(eventsB[0]?.payload.expectResult).toBe(true);

        // B 收到的消息以 peer 来源落进历史（模型上下文）
        const userMessages = readEvents(sessionB).filter(event => event.type === "user_message");
        expect(userMessages.at(-1)?.payload.trigger).toBe("peer");
        expect(userMessages.at(-1)?.payload.text).toContain("读一遍日志");
    });

    test("不期望结果时不产生等待项", async () => {
        await agent.claimSession(sessionA);
        await agent.claimSession(sessionB);

        const uiEvents: any[] = [];
        agent.onEvent = (_requestId, _sessionId, event) => uiEvents.push(event);
        await agent.sessionControl.send(sessionA, sessionB, "只是通知一声");

        await waitFor(() => readEvents(sessionB).some(event => event.type === "user_message"));
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(uiEvents.some(event => event.type === "peer_result")).toBe(false);
        expect(agent.takePeerResults(sessionA)).toEqual([]);
    });

    test("目标未认领时报不可达，且不落任何事件", async () => {
        await agent.claimSession(sessionA);

        await expect(
            agent.sessionControl.send(sessionA, sessionB, "在吗", { expectResult: true }),
        ).rejects.toThrow(/不可达/);

        expect(readEvents(sessionA).filter(event => event.type === "peer_message")).toEqual([]);
    });

    test("目标忙时报错且不落任何事件", async () => {
        await agent.claimSession(sessionA);
        await agent.claimSession(sessionB);

        let releaseTurn: (() => void) | undefined;
        turnGate = new Promise<void>((resolve) => {
            releaseTurn = resolve;
        });

        const running = agent.sendMessage(sessionB, "本地跑一个长任务");
        await waitFor(() => agent.isSessionBusy(sessionB));

        await expect(agent.sessionControl.send(sessionA, sessionB, "插队")).rejects.toThrow(/正在执行中/);
        expect(readEvents(sessionB).filter(event => event.type === "peer_message")).toEqual([]);

        releaseTurn?.();
        await running;
    });

    test("对端忙时不会被协商拿走持有权", async () => {
        await agent.claimSession(sessionB);

        let releaseTurn: (() => void) | undefined;
        turnGate = new Promise<void>((resolve) => {
            releaseTurn = resolve;
        });
        const running = agent.sendMessage(sessionB, "跑一个长任务");
        await waitFor(() => agent.isSessionBusy(sessionB));

        // 另一个"实例"（直接走 socket 协商）请求释放：忙则应被拒绝且文件保留
        const { requestOnce } = await import("../../src/control/client.js");
        const reply = await requestOnce(getSocketPath(sessionB), { type: "release", id: "neg" }, 500);
        expect(reply).toEqual({ type: "release_result", id: "neg", ok: false, reason: "busy" });
        expect(agent.isSessionClaimed(sessionB)).toBe(true);
        expect(fs.existsSync(getSocketPath(sessionB))).toBe(true);

        releaseTurn?.();
        await running;
    });
});

describe("结果到达即驱动请求方", () => {
    test("空闲请求方收到结果就继续一轮，结果作为 peer 来源的 user 消息落盘", async () => {
        await agent.claimSession(sessionA);
        await agent.claimSession(sessionB);
        turnContent = "结果是 42";

        await agent.sessionControl.send(sessionA, sessionB, "算一下", { expectResult: true });

        // 结果落盘后自动驱动请求方：请求方跑了一轮，结果原文就是本轮 query
        await waitFor(() => queries.some(item => item.sessionId === sessionA));
        expect(agent.sessionControl.queuedResults(sessionA)).toBe(0);
        expect(queries.filter(item => item.sessionId === sessionA)[0]?.query).toContain("结果是 42");

        // 结果作为 peer 来源的 user 消息落盘：进历史但不渲染成用户气泡
        const userMessages = readEvents(sessionA).filter(event => event.type === "user_message");
        expect(userMessages.every(event => event.payload.trigger === "peer")).toBe(true);
        expect(userMessages.every(event => String(event.payload.text).includes("结果是 42"))).toBe(true);

        // 再派一次活：上一轮结果已在会话历史里，新的结果又是本轮 query
        await waitFor(() => !agent.isSessionBusy(sessionA));
        await agent.sessionControl.send(sessionA, sessionB, "再算一次", { expectResult: true });
        await waitFor(() => queries.filter(item => item.sessionId === sessionA).length === 2);

        const driven = queries.filter(item => item.sessionId === sessionA)[1];
        expect(driven?.query).toContain("结果是 42");
        expect(driven?.history.some(message => String(message.content).includes("结果是 42"))).toBe(true);
    });

    test("结果原文可按事件日志回查", async () => {
        await agent.claimSession(sessionA);
        await agent.claimSession(sessionB);
        turnContent = "结果是 42";

        await agent.sessionControl.send(sessionA, sessionB, "算一下", { expectResult: true });
        await waitFor(() => queries.some(item => item.sessionId === sessionA));

        const { getPeerResultHistory } = await import("../../src/control/runtime.js");
        const results = await getPeerResultHistory()?.recentResults(sessionA, 1);
        expect(results?.length).toBe(1);
        expect(results?.[0]?.text).toContain("结果是 42");
        expect(results?.[0]?.peerId).toBe(sessionB);
        expect(results?.[0]?.ok).toBe(true);
    });

    test("请求方忙时结果留在队列，回合结束再补跑", async () => {
        await agent.claimSession(sessionA);
        await agent.claimSession(sessionB);

        // 只闸住 A 的回合，让 B 能把结果正常回传
        let releaseTurn: (() => void) | undefined;
        turnGate = new Promise<void>((resolve) => {
            releaseTurn = resolve;
        });
        turnGateSession = sessionA;
        const running = agent.sendMessage(sessionA, "本地跑一个长任务");
        await waitFor(() => agent.isSessionBusy(sessionA));

        turnContent = "结果是 42";
        await agent.sessionControl.send(sessionA, sessionB, "算一下", { expectResult: true });
        await waitFor(() => agent.sessionControl.queuedResults(sessionA) === 1);

        // 忙：结果不被消费，也不会插队跑新回合
        expect(queries.filter(item => item.sessionId === sessionA).length).toBe(0);

        releaseTurn?.();
        await running;

        // 回合结束补跑：长任务那轮 + 结果驱动的一轮
        await waitFor(() => queries.filter(item => item.sessionId === sessionA).length === 2);
        expect(agent.sessionControl.queuedResults(sessionA)).toBe(0);
        expect(queries.filter(item => item.sessionId === sessionA).at(-1)?.query).toContain("结果是 42");
    });

    test("没有待附加结果时回合结束不额外驱动", async () => {
        await agent.claimSession(sessionA);

        await agent.sendMessage(sessionA, "你好");

        expect(queries.map(item => item.sessionId)).toEqual([sessionA]);
    });

    test("会话未打开时结果留在队列，用户下次说话时前置注入", async () => {
        await agent.claimSession(sessionA);
        await agent.claimSession(sessionB);
        // 放弃持有：会话不在本实例内存里，结果到了也没法继续
        agent.releaseSession(sessionA);

        turnContent = "子会话的结论";
        await agent.sessionControl.send(sessionA, sessionB, "读一遍日志", { expectResult: true });
        await waitFor(() => agent.sessionControl.queuedResults(sessionA) === 1);
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(queries.filter(item => item.sessionId === sessionA).length).toBe(0);
        expect(agent.sessionControl.awaitingResults(sessionA)).toBe(0);

        // 用户再说话：积压结果作为前置 user 消息注入，并清空队列
        await agent.sendMessage(sessionA, "继续");
        expect(agent.sessionControl.queuedResults(sessionA)).toBe(0);

        const followUp = queries.find(item => item.sessionId === sessionA);
        expect(followUp?.query).toBe("继续");
        expect(followUp?.history.some(message => String(message.content).includes("子会话的结论"))).toBe(true);
    });

    test("唤醒已归档子会话后可继续派活", async () => {
        const spawned = await agent.sessionControl.spawnSession(sessionA, "可恢复子会话");
        expect(spawned.ok).toBe(true);
        if (!spawned.ok) return;
        await agent.renameSession(spawned.sessionId, "可恢复子会话");
        await agent.closeSession(spawned.sessionId);
        agent.releaseSession(spawned.sessionId);
        expect((await agent.listSessions()).find(item => item.sessionId === spawned.sessionId)?.archived).toBe(true);

        let wokenSession = "";
        agent.onSessionWoken = sessionId => { wokenSession = sessionId; };
        // 目录是宿主级能力，按 caller 会话解析：spawned 已归档释放，不能拿它的 id 去问
        const directory = getSessionDirectory(sessionA);
        expect(directory?.wake).toBeDefined();
        await directory!.wake!(spawned.sessionId);

        expect(wokenSession).toBe(spawned.sessionId);
        expect(agent.isSessionClaimed(spawned.sessionId)).toBe(true);
        expect((await agent.listSessions()).find(item => item.sessionId === spawned.sessionId)?.archived).toBe(false);

        turnContent = "恢复后的结果";
        await agent.sessionControl.send(sessionA, spawned.sessionId, "继续上次工作", { expectResult: true });
        await waitFor(() => queries.some(item => item.sessionId === spawned.sessionId));
        expect(queries.find(item => item.sessionId === spawned.sessionId)?.query).toContain("继续上次工作");

        await waitFor(() => !agent.isSessionBusy(spawned.sessionId));
        await agent.closeSession(spawned.sessionId);
        agent.releaseSession(spawned.sessionId);
        await directory!.wake!(spawned.sessionId);
        turnContent = "归档前的最终结果";
        await agent.sessionControl.send(sessionA, spawned.sessionId, "最后继续一次", {
            expectResult: true,
            closeOnResult: true,
        });
        await waitFor(() => !agent.isSessionClaimed(spawned.sessionId));
        expect((await agent.listSessions()).find(item => item.sessionId === spawned.sessionId)?.archived).toBe(true);
    });

    test("session_cancel 可中止当前子任务并选择是否归档", async () => {
        for (const close of [false, true]) {
            await agent.claimSession(sessionA);
            const spawned = await agent.sessionControl.spawnSession(sessionA, `取消任务 ${close}`);
            expect(spawned.ok).toBe(true);
            if (!spawned.ok) continue;

            let releaseTurn: (() => void) | undefined;
            turnGate = new Promise<void>(resolve => { releaseTurn = resolve; });
            turnGateSession = spawned.sessionId;
            const { message: sent } = await agent.sessionControl.send(sessionA, spawned.sessionId, "运行可取消任务", {
                expectResult: true,
            });
            await waitFor(() => startedSessions.includes(spawned.sessionId));

            const cancelPromise = agent.sessionControl.cancelSpawnedSession(spawned.sessionId, { close });
            await new Promise(resolve => setTimeout(resolve, 0));
            await expect(agent.sessionControl.send(sessionA, spawned.sessionId, "取消期间不应插入新任务"))
                .rejects.toThrow(/取消\/关闭|正在执行中/);
            releaseTurn?.();
            const cancelled = await cancelPromise;
            turnGate = null;
            turnGateSession = null;

            expect(cancelled).toEqual({ ok: true, closed: close });
            expect(readEvents(sessionA).some(event => event.type === "peer_message"
                && event.payload.msgId === sent.id)).toBe(true);
            expect(agent.isSessionBusy(spawned.sessionId)).toBe(false);
            expect(agent.isSessionClaimed(spawned.sessionId)).toBe(!close);
            expect((await agent.listSessions()).find(item => item.sessionId === spawned.sessionId)?.archived).toBe(close);
        }
    });
});
