/**
 * 会话间 /compact：宿主原生执行（不经前端执行器、不产生普通模型对话）、
 * 忙时排队、连续调用、失败回传与互斥释放。
 *
 * 独立文件：mock.module 需要独占进程，抹掉真实上游请求。
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

/** 非空时该会话的上游请求会一直挂住，用于制造“会话忙”。 */
let turnGate: Promise<void> | null = null;
let turnGateSession: string | null = null;
/** 非空时压缩请求直接失败，用于验证失败回传与互斥释放。 */
let compactFailure: string | null = null;
const requests: Array<{ sessionId?: string; query: string; kind?: string }> = [];

const realChatRuntime = await import("../../src/services/chat-runtime.js");
mock.module("../../src/services/chat-runtime.js", () => ({
    ...realChatRuntime,
    runChatQuery: async (options: any) => {
        requests.push({
            sessionId: options.sessionId,
            query: options.query ?? "",
            kind: options.initialRequestKind,
        });
        if (compactFailure && options.initialRequestKind === "context_compaction") {
            throw new Error(compactFailure);
        }
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-peer-compact-"));
    originalStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;

    agent = new LocalSessionHost();
    sessionA = (await agent.createSession()).sessionId;
    sessionB = (await agent.createSession()).sessionId;
    await agent.claimSession(sessionA);
    await agent.claimSession(sessionB);
    turnGate = null;
    turnGateSession = null;
    compactFailure = null;
    requests.length = 0;
});

afterEach(async () => {
    turnGate = null;
    turnGateSession = null;
    compactFailure = null;
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

/** 只统计目标会话（sessionB）的回合请求，请求方收到结果后也会跑一轮，不能混算。 */
function targetRequests() {
    return requests.filter(item => item.sessionId === sessionB);
}

function peerTurns() {
    return targetRequests().filter(item => item.kind === "peer_request");
}

function compactions() {
    return targetRequests().filter(item => item.kind === "context_compaction");
}

async function sendAndWait(text: string, options: { queueIfBusy?: boolean } = {}) {
    const outcome = await agent.sessionControl.send(sessionA, sessionB, text, {
        expectResult: true,
        ...options,
    });
    const resultOf = () => readEvents(sessionA)
        .filter(event => event.type === "peer_result" && event.payload.msgId === outcome.message.id)
        .at(-1)?.payload;
    await waitFor(() => resultOf() !== undefined);
    const result = resultOf();
    if (!result) throw new Error("等待结果超时");
    return { queued: outcome.queued, result: result as { ok: boolean; text: string; stopReason: string; error?: string } };
}

/** 给目标会话造一轮真实历史，让 /compact 有东西可压。 */
async function seedHistory(): Promise<void> {
    await sendAndWait("先聊一轮");
    expect(peerTurns()).toHaveLength(1);
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

describe("会话间 /compact", () => {
    test("在目标会话执行压缩：不产生普通回合，写入 context_compacted，互斥随后释放", async () => {
        await seedHistory();
        const peerTurnsBefore = peerTurns().length;

        const { result } = await sendAndWait("/compact");

        expect(result.ok).toBe(true);
        expect(result.stopReason).toBe("command");
        expect(result.text).toContain("已压缩会话上下文");
        // 只多了一次压缩请求，没有把 /compact 当作用户消息送给模型
        expect(peerTurns()).toHaveLength(peerTurnsBefore);
        expect(compactions()).toHaveLength(1);
        expect(readEvents(sessionB).some(event =>
            event.type === "context_compacted" && event.payload.compactedContext === "压缩摘要")).toBe(true);
        expect(agent.isSessionBusy(sessionB)).toBe(false);
    });

    test("附加要求进入压缩提示，不被丢弃", async () => {
        await seedHistory();

        const { result } = await sendAndWait("/compact 重点保留并发竞态结论");

        expect(result.ok).toBe(true);
        expect(result.text).toContain("重点保留并发竞态结论");
        expect(compactions().at(-1)?.query).toContain("用户特定压缩要求：重点保留并发竞态结论");
    });

    test("忙时排队：会话空闲后执行压缩并回传成功结果", async () => {
        await seedHistory();
        const release = holdSession(sessionB);
        // 占住会话的一轮普通回合
        const occupying = sendAndWait("占用会话");
        await waitFor(() => requests.some(item => item.sessionId === sessionB && item.kind === "peer_request"
            && item.query.includes("占用会话")));

        const queued = await agent.sessionControl.send(sessionA, sessionB, "/compact", {
            expectResult: true,
            queueIfBusy: true,
        });
        expect(queued.queued).toBe(true);
        expect((await agent.sessionControl.queueState(sessionB)).map(entry => entry.msgId))
            .toEqual([queued.message.id]);

        release();
        await occupying;
        await waitFor(() => readEvents(sessionA).some(event => event.type === "peer_result"
            && event.payload.msgId === queued.message.id));
        const result = readEvents(sessionA)
            .filter(event => event.type === "peer_result" && event.payload.msgId === queued.message.id)
            .at(-1)!.payload as { ok: boolean; text: string; stopReason: string };

        expect(result.ok).toBe(true);
        expect(result.stopReason).toBe("command");
        expect(result.text).toContain("已压缩会话上下文");
        expect(await agent.sessionControl.queueState(sessionB)).toEqual([]);
        expect(agent.isSessionBusy(sessionB)).toBe(false);
    });

    test("连续调用：第二次无历史可压缩时明确失败，之后仍能正常投递", async () => {
        await seedHistory();

        expect((await sendAndWait("/compact")).result.ok).toBe(true);
        const second = await sendAndWait("/compact");
        expect(second.result.ok).toBe(false);
        expect(second.result.text).toContain("没有可压缩的对话历史");
        expect(second.result.stopReason).toBe("error");
        expect(agent.isSessionBusy(sessionB)).toBe(false);

        // 失败路径没有把互斥借走不放：普通投递仍能执行
        const normal = await sendAndWait("失败后还能聊");
        expect(normal.result.ok).toBe(true);
        expect(normal.result.stopReason).toBe("stop");
        expect(agent.isSessionBusy(sessionB)).toBe(false);
    });

    test("上游失败时回传失败原因，互斥释放后可再次压缩成功", async () => {
        await seedHistory();
        compactFailure = "上游 500：压缩失败";

        const failed = await sendAndWait("/compact");
        expect(failed.result.ok).toBe(false);
        expect(failed.result.stopReason).toBe("error");
        // 结果落盘只保留 text：失败原因同时是 text，CLI 侧再取 socket 结果的 error
        expect(failed.result.text).toContain("上游 500");
        expect(agent.isSessionBusy(sessionB)).toBe(false);
        expect(readEvents(sessionB).some(event => event.type === "context_compacted")).toBe(false);

        compactFailure = null;
        const { result } = await sendAndWait("/compact");
        expect(result.ok).toBe(true);
        expect(agent.isSessionBusy(sessionB)).toBe(false);
    });
});
