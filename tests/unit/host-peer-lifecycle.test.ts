/**
 * 会话间生命周期命令：/new /archive /close /delete /unarchive /clear /continue。
 *
 * 重点验证：结果先送达再拆链路、确认词、归档态门禁、忙碌排队、互斥释放。
 *
 * 独立文件：mock.module 需要独占进程。
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

/** 非空时该会话的上游请求会一直挂住，用于制造“会话忙”。 */
let turnGate: Promise<void> | null = null;
let turnGateSession: string | null = null;
const requests: Array<{ sessionId?: string; query: string }> = [];

const realChatRuntime = await import("../../src/services/chat-runtime.js");
mock.module("../../src/services/chat-runtime.js", () => ({
    ...realChatRuntime,
    runChatQuery: async (options: any) => {
        requests.push({ sessionId: options.sessionId, query: options.query ?? "" });
        if (turnGate && (!turnGateSession || options.sessionId === turnGateSession)) await turnGate;
        if (options.signal?.aborted) {
            options.onEvent?.({ type: "aborted", stopReason: "aborted" });
            return { content: "", toolCalls: 0, messages: [] };
        }
        const content = options.initialRequestKind === "context_compaction" ? "压缩摘要" : "模型输出";
        options.onEvent?.({ type: "message_end", content, stopReason: "stop" });
        return { content, toolCalls: 0, messages: [{ role: "assistant", content }] };
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-peer-lifecycle-"));
    originalStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;

    agent = new LocalSessionHost();
    sessionA = (await agent.createSession()).sessionId;
    sessionB = (await agent.createSession()).sessionId;
    await agent.claimSession(sessionA);
    await agent.claimSession(sessionB);
    turnGate = null;
    turnGateSession = null;
    requests.length = 0;
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

async function waitForAsync(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
    const started = Date.now();
    while (!await check()) {
        if (Date.now() - started > timeoutMs) throw new Error("等待条件超时");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
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

async function sendAndWait(text: string) {
    const outcome = await agent.sessionControl.send(sessionA, sessionB, text, { expectResult: true });
    const resultOf = () => readEvents(sessionA)
        .filter(event => event.type === "peer_result" && event.payload.msgId === outcome.message.id)
        .at(-1)?.payload;
    await waitFor(() => resultOf() !== undefined);
    const result = resultOf();
    if (!result) throw new Error("等待结果超时");
    return result as { ok: boolean; text: string; stopReason: string };
}

/** 让指定会话的上游请求挂住，返回放行函数。 */
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

describe("会话间生命周期命令", () => {
    test("/new 创建并认领子会话，可立即投递", async () => {
        const created = await sendAndWait("/new 临时子会话");
        expect(created.ok).toBe(true);
        const newId = /[0-9A-HJKMNP-TV-Z]{26}/.exec(created.text)?.[0];
        expect(newId).toBeDefined();
        expect(agent.isSessionClaimed(newId!)).toBe(true);
        expect((await agent.listSessions()).find(item => item.sessionId === newId)?.title).toBe("临时子会话");

        const reply = await agent.sessionControl.send(sessionA, newId!, "你好", { expectResult: true });
        await waitFor(() => readEvents(sessionA).some(event =>
            event.type === "peer_result" && event.payload.msgId === reply.message.id && event.payload.ok === true));
    });

    test("/close 先把结果送达，再释放持有；数据保留", async () => {
        const result = await sendAndWait("/close");
        expect(result.ok).toBe(true);
        expect(result.text).toContain("已关闭会话");

        await waitFor(() => !agent.isSessionClaimed(sessionB));
        // 结果已经落在请求方时间线上（先送达后拆链路）
        expect(readEvents(sessionA).some(event => event.type === "peer_result" && event.payload.text.includes("已关闭会话"))).toBe(true);
        expect((await agent.listSessions()).some(item => item.sessionId === sessionB)).toBe(true);
        expect(readEvents(sessionB).some(event => event.type === "session_archived")).toBe(false);
    });

    test("/archive 归档并释放持有，之后只读命令仍可投递", async () => {
        const result = await sendAndWait("/archive");
        expect(result.ok).toBe(true);
        expect(result.text).toContain("已归档");

        await waitFor(() => !agent.isSessionClaimed(sessionB));
        expect(await agent.isSessionArchived(sessionB)).toBe(true);

        // 归档态：重新认领（等价于 TUI 里只读打开），只读命令可执行且不写目标时间线
        await agent.claimSession(sessionB);
        const before = readEvents(sessionB).length;
        const help = await sendAndWait("/help");
        expect(help.ok).toBe(true);
        expect(help.text).toContain("可用命令");
        expect(readEvents(sessionB)).toHaveLength(before);
        await waitForAsync(async () => !agent.isSessionBusy(sessionB));

        // 需要可写会话的命令在归档态明确失败（不是"假装执行"）
        const refusedWrite = await sendAndWait("/cwd");
        expect(refusedWrite.ok).toBe(false);
        expect(refusedWrite.text).toContain("先 /unarchive");
        expect(readEvents(sessionB)).toHaveLength(before);
    });

    test("/unarchive 在归档态可投递并恢复可写", async () => {
        // 先归档（会释放持有，需要重新认领才能投递）
        expect((await sendAndWait("/archive")).ok).toBe(true);
        await waitFor(() => !agent.isSessionClaimed(sessionB));
        await agent.claimSession(sessionB);

        const result = await sendAndWait("/unarchive");
        expect(result.ok).toBe(true);
        expect(await agent.isSessionArchived(sessionB)).toBe(false);

        // 恢复后普通命令与回合都能跑
        expect((await sendAndWait("/cwd")).ok).toBe(true);
        expect(agent.isSessionBusy(sessionB)).toBe(false);
    });

    test("/delete 需要 confirm；带确认后先回结果再删除", async () => {
        const refused = await sendAndWait("/delete");
        expect(refused.ok).toBe(false);
        expect(refused.text).toContain("必须显式确认");
        expect((await agent.listSessions()).some(item => item.sessionId === sessionB)).toBe(true);

        const deleted = await sendAndWait("/delete confirm");
        expect(deleted.ok).toBe(true);
        await waitForAsync(async () => !(await agent.listSessions()).some(item => item.sessionId === sessionB));
        expect(fs.existsSync(path.join(tmpDir, "sessions", "events", `${sessionB}.jsonl`))).toBe(false);
        expect(readEvents(sessionA).some(event => event.type === "peer_result" && event.payload.text.includes("已删除"))).toBe(true);
    });

    test("/clear 需要 confirm，清空后会话仍可用", async () => {
        await sendAndWait("先聊一轮");
        const refused = await sendAndWait("/clear");
        expect(refused.ok).toBe(false);
        expect((await agent.listSessions()).find(item => item.sessionId === sessionB)?.messageCount).toBe(1);

        const cleared = await sendAndWait("/clear confirm");
        expect(cleared.ok).toBe(true);
        expect((await agent.listSessions()).find(item => item.sessionId === sessionB)?.messageCount).toBe(0);
        expect(agent.isSessionBusy(sessionB)).toBe(false);
        expect((await sendAndWait("/help")).ok).toBe(true);
    });

    test("/continue 无续跑点时如实说明，不残留 busy", async () => {
        const result = await sendAndWait("/continue");
        expect(result.ok).toBe(true);
        expect(result.text).toMatch(/没有可继续的|已继续执行/);
        expect(agent.isSessionBusy(sessionB)).toBe(false);
    });

    test("忙时排队：命令在回合结束后执行，结果按 msgId 回传", async () => {
        const release = holdSession(sessionB);
        const occupying = agent.sessionControl.send(sessionA, sessionB, "占用会话", { expectResult: true });
        await waitFor(() => requests.some(item => item.sessionId === sessionB && item.query.includes("占用会话")));

        const queued = await agent.sessionControl.send(sessionA, sessionB, "/help", {
            expectResult: true,
            queueIfBusy: true,
        });
        expect(queued.queued).toBe(true);
        expect(queued.position).toBe(1);

        release();
        await occupying.catch(() => undefined);
        await waitFor(() => readEvents(sessionA).some(event =>
            event.type === "peer_result" && event.payload.msgId === queued.message.id));
        const result = readEvents(sessionA)
            .filter(event => event.type === "peer_result" && event.payload.msgId === queued.message.id)
            .at(-1)!.payload as { ok: boolean; text: string; stopReason: string };
        expect(result.ok).toBe(true);
        expect(result.stopReason).toBe("command");
        expect(result.text).toContain("可用命令");
        expect(await agent.sessionControl.queueState(sessionB)).toEqual([]);
        expect(agent.isSessionBusy(sessionB)).toBe(false);
    });
});
