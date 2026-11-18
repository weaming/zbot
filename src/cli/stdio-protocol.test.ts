import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import type { AgentEvent } from "../events/agent-events.js";
import { emptyUsage } from "../events/ui-events.js";
import { HISTORY_MAX_EVENTS, runStdioProtocol, type ReplayRecord, type StdioHost } from "./stdio-protocol.js";
import { createStdioCapabilities, parseStdioArgs } from "./stdio.js";
import type { UserAnswer, UserQuestionRequest } from "../utils/user-question.js";

type Frame = { id?: string | number; result?: any; error?: { code: number; message: string }; method?: string; params?: any };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function waitFor(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("等待 fake transport 超时");
        await new Promise(resolve => setTimeout(resolve, 1));
    }
}

/** 合法的完整 ULID（Crockford Base32，26 位）。 */
const RESUME_ID = "01M7HTFE6V91561SAV4KR4BV53";

function fixture(extra: Partial<Parameters<typeof runStdioProtocol>[0]> = {}, ownId = "OWN") {
    const input = new PassThrough();
    const frames: Frame[] = [];
    let listener: Parameters<StdioHost["subscribeEvents"]>[0] | undefined;
    const calls = {
        created: 0, cwd: "", closed: 0, aborts: 0, subscribed: false, claimed: "",
        unarchived: [] as string[], archivedSessions: [] as string[], released: [] as string[], order: [] as string[],
    };
    const savedIds = new Set<string>();
    const archivedIds = new Set<string>();
    const host: StdioHost = {
        createSession: async cwd => { calls.created++; calls.cwd = cwd!; return { sessionId: ownId }; },
        claimSession: async (id, options) => {
            expect(options).toEqual({ noNegotiate: true });
            calls.claimed = id;
            calls.order.push(`claim:${id}`);
            return { ok: true };
        },
        isSessionClaimed: id => calls.claimed === id,
        isSessionBusy: () => false,
        listSessions: async () => [...savedIds].map(id => ({ sessionId: id, messageCount: 1, archived: archivedIds.has(id) })),
        isSessionArchived: async id => archivedIds.has(id),
        unarchiveSession: async id => {
            calls.unarchived.push(id);
            calls.order.push(`unarchive:${id}`);
            archivedIds.delete(id);
        },
        closeSession: async id => { calls.archivedSessions.push(id); archivedIds.add(id); },
        releaseSession: id => { calls.released.push(id); calls.order.push(`release:${id}`); if (calls.claimed === id) calls.claimed = ""; },
        sendMessage: async () => ({}),
        abortSession: async () => { calls.aborts++; return true; },
        close: async () => { calls.closed++; },
        subscribeEvents: callback => {
            listener = callback;
            calls.subscribed = true;
            return () => { calls.subscribed = false; };
        },
    };
    const output = new Writable({ write(chunk, _encoding, callback) {
        frames.push(JSON.parse(chunk.toString()));
        callback();
    } });
    const done = runStdioProtocol({ host, cwd: "/workspace", input, output, ...extra });
    void done.catch(() => undefined);
    cleanups.push(async () => { input.end(); await done.catch(() => undefined); });
    const request = async (method: string, params: unknown = {}, id = `req-${frames.length}`) => {
        input.write(`${JSON.stringify({ id, method, params })}\n`);
        await waitFor(() => frames.some(frame => frame.id === id));
        return frames.find(frame => frame.id === id)!;
    };
    const ready = async () => { await request("initialize", { version: 1 }, "init"); await request("session/create", {}, "create"); };
    const identity = () => ({ instanceId: frames.find(frame => frame.result?.instanceId)?.result.instanceId, sessionId: ownId });
    return { input, output, host, calls, frames, done, request, ready, identity, savedIds, archivedIds,
        emit: (event: AgentEvent | null, id = ownId) => listener?.(id, event) };
}

function commit(): AgentEvent {
    return { type: "turn_commit", seq: 5, ts: "2026-11-16T10:00:00Z", sessionId: "OWN", payload: {
        turnId: "TURN", events: [1, 2], userMessages: ["hello"], stopReason: "stop", usage: emptyUsage(), interrupted: false,
    } };
}

describe("stdio JSONL", () => {
    test("实时工具事件转发为 session/tool，只限本会话且截断文本", async () => {
        const f = fixture();
        await f.ready();
        const identity = f.identity();
        f.host.onEvent?.(1, "OWN", { type: "tool_start", toolId: 1, callId: "c1", name: "bash", args: { command: "ls" }, mode: "serial" });
        await waitFor(() => f.frames.some(frame => frame.method === "session/tool"));
        const started = f.frames.find(frame => frame.method === "session/tool")!;
        expect(started.params).toMatchObject({
            instanceId: identity.instanceId, sessionId: "OWN",
            call: { callId: "c1", name: "bash", state: "running" },
        });
        expect(started.params.call.input).toBe(JSON.stringify({ command: "ls" }));

        f.host.onEvent?.(1, "OWN", { type: "tool_result", toolId: 1, callId: "c1", name: "bash", summary: "ok", isError: false, durationMs: 12 });
        await waitFor(() => f.frames.filter(frame => frame.method === "session/tool").length === 2);
        expect(f.frames.filter(frame => frame.method === "session/tool")[1]!.params.call)
            .toMatchObject({ callId: "c1", state: "succeeded", output: "ok", durationMs: 12 });

        // 其他会话、其他类型的事件不外发
        f.host.onEvent?.(1, "OTHER", { type: "tool_start", toolId: 2, callId: "c2", name: "bash", args: {}, mode: "serial" });
        f.host.onEvent?.(1, "OWN", { type: "text_delta", delta: "hello" });
        await f.request("shutdown");
        await f.done;
        expect(f.frames.filter(frame => frame.method === "session/tool")).toHaveLength(2);
    });

    test("初始化、唯一会话、隔离外部 ID、持久化记录原样投递", async () => {
        const f = fixture();
        expect((await f.request("session/create")).error?.code).toBe(-32000);
        expect((await f.request("initialize", { version: 2 })).error?.code).toBe(-32602);
        expect((await f.request("initialize", { version: 1 })).result).toEqual({ version: 1, instanceId: expect.any(String) });
        expect((await f.request("initialize", { version: 1 })).error?.code).toBe(-32000);
        expect((await f.request("session/create", { sessionId: "EXTERNAL" })).error?.code).toBe(-32602);
        expect((await f.request("session/create", { model: "unsupported" })).error?.code).toBe(-32602);
        expect((await f.request("session/create")).result).toEqual({ sessionId: "OWN", instanceId: expect.any(String) });
        expect(f.calls.cwd).toBe("/workspace");
        expect(f.calls.claimed).toBe("OWN");
        expect((await f.request("session/create")).error?.code).toBe(-32000);
        const record = commit();
        f.emit(record, "EXTERNAL");
        f.emit(null);
        f.emit(record);
        await f.request("shutdown");
        await f.done;
        const { sessionId: _id, ...expected } = record;
        expect(f.frames.filter(frame => frame.method === "session/record")).toEqual([{ method: "session/record", params: { ...f.identity(), record: expected } }]);
        expect(f.calls.created).toBe(1);
        expect(f.calls.closed).toBe(1);
        expect(f.calls.subscribed).toBe(false);
    });

    test("send 立即受理，模型等待不阻塞 busy/cancel，commit 为唯一正式终态", async () => {
        const f = fixture();
        await f.ready();
        let finish!: (value: {}) => void;
        f.host.sendMessage = async (id, text) => {
            expect([id, text]).toEqual(["OWN", "hello"]);
            return new Promise(resolve => { finish = resolve; });
        };
        expect((await f.request("session/send", { text: "hello" })).result).toEqual({ accepted: true });
        expect((await f.request("session/send", { text: "next" })).error?.code).toBe(-32001);
        expect((await f.request("session/cancel")).result).toEqual({ requested: true });
        f.host.onEvent?.(1, "OWN", { type: "progress", message: "start" });
        expect(f.calls.aborts).toBe(2);
        f.emit(commit());
        finish({});
        await new Promise(resolve => setTimeout(resolve, 1));
        await f.request("shutdown");
        await f.done;
        expect(f.frames.some(frame => frame.method === "session/finished")).toBe(false);
    });

    test("未产生 commit 的成功、异常和取消都有兜底终态", async () => {
        const f = fixture();
        await f.ready();
        await f.request("session/send", { text: "hello" }, "send1");
        await waitFor(() => f.frames.some(frame => frame.method === "session/finished"));
        expect(f.frames.find(frame => frame.method === "session/finished")?.params).toEqual({ ...f.identity(), state: "done" });
        f.host.sendMessage = async () => { throw new Error("fake upstream failed"); };
        await f.request("session/send", { text: "hello" }, "send2");
        await waitFor(() => f.frames.some(frame => frame.method === "session/error"));
        expect(f.frames.find(frame => frame.method === "session/error")?.params).toEqual({ ...f.identity(), message: "fake upstream failed" });
        expect(f.frames.filter(frame => frame.method === "session/finished").at(-1)?.params).toEqual({ ...f.identity(), state: "failed" });
        f.host.sendMessage = async () => ({ aborted: true });
        await f.request("session/send", { text: "hello" }, "send3");
        await waitFor(() => f.frames.filter(frame => frame.method === "session/finished").length === 3);
        expect(f.frames.filter(frame => frame.method === "session/finished").at(-1)?.params).toEqual({ ...f.identity(), state: "cancelled" });
    });

    test("取消期间抛错标记 cancelled，不自动成功", async () => {
        const f = fixture();
        await f.ready();
        let fail!: (error: Error) => void;
        f.host.sendMessage = async () => new Promise((_resolve, reject) => { fail = reject; });
        await f.request("session/send", { text: "hello" });
        await f.request("session/cancel");
        fail(new Error("cancelled"));
        await waitFor(() => f.frames.some(frame => frame.method === "session/finished"));
        expect(f.frames.find(frame => frame.method === "session/finished")?.params).toEqual({ ...f.identity(), state: "cancelled" });
    });

    test("兼容 Go 数字 ID，保持响应 ID 类型；子会话事件不进入顶层协议", async () => {
        const f = fixture();
        f.input.write('{"id":1,"method":"initialize","params":{"version":1}}\n');
        f.input.write('{"id":2,"method":"session/create","params":{}}\n');
        await waitFor(() => f.frames.some(frame => frame.id === 2));
        expect(f.frames.find(frame => frame.id === 1)?.result).toEqual({ version: 1, instanceId: expect.any(String) });
        expect(f.frames.find(frame => frame.id === 2)?.result).toEqual({ sessionId: "OWN", instanceId: expect.any(String) });
        f.emit(commit(), "SPAWNED_CHILD");
        f.host.onEvent?.(2, "SPAWNED_CHILD", { type: "progress", message: "internal agent" });
        f.input.write('{"id":3,"method":"session/cancel","params":{}}\n');
        f.input.write('{"id":4,"method":"shutdown","params":{}}\n');
        await f.done;
        expect(f.frames.find(frame => frame.id === 3)?.result).toEqual({ requested: true });
        expect(f.frames.find(frame => frame.id === 4)?.result).toEqual({});
        expect(f.frames.some(frame => frame.method === "session/record")).toBe(false);
    });

    test("分片 UTF-8、多个请求一块与 EOF 尾行", async () => {
        const f = fixture();
        const line = Buffer.from(JSON.stringify({ id: "中文", method: "initialize", params: { version: 1 } }) + "\n");
        for (const byte of line) f.input.write(Buffer.from([byte]));
        await waitFor(() => f.frames.some(frame => frame.id === "中文"));
        f.input.end('{"id":"c","method":"session/create","params":{}}\n{"id":"s","method":"shutdown","params":{}}');
        await f.done;
        expect(f.frames.filter(frame => frame.id !== undefined).map(frame => frame.id)).toEqual(["中文", "c", "s"]);
    });

    test("无效请求可恢复，不接受未知方法、空正文或外部 sessionId", async () => {
        const f = fixture();
        f.input.write('nope\n[]\n{"id":"bad","method":3}\n');
        await waitFor(() => f.frames.length === 3);
        expect(f.frames.map(frame => frame.error?.code)).toEqual([-32700, -32600, -32600]);
        expect(f.frames[2]?.id).toBe("bad");
        await f.ready();
        expect((await f.request("session/list")).error?.code).toBe(-32601);
        expect((await f.request("session/send", { text: " " })).error?.code).toBe(-32602);
        expect((await f.request("session/send", { text: "hi", sessionId: "other" })).error?.code).toBe(-32602);
        expect((await f.request("session/cancel", { sessionId: "other" })).error?.code).toBe(-32602);
        expect((await f.request("shutdown", [])).error?.code).toBe(-32602);
    });

    test("claim 失败不能再次创建或投递", async () => {
        const f = fixture();
        f.host.claimSession = async () => ({ ok: false, reason: "busy" });
        await f.request("initialize", { version: 1 });
        expect((await f.request("session/create")).error?.message).toContain("其他实例");
        expect((await f.request("session/create")).error?.code).toBe(-32000);
        expect((await f.request("session/send", { text: "hello" })).error?.code).toBe(-32000);
    });

    test("EOF、信号与进行中回合退出都会关宿主并摘掉订阅", async () => {
        const controller = new AbortController();
        const f = fixture({ signal: controller.signal });
        await f.ready();
        let settle!: (value: { aborted: boolean }) => void;
        f.host.sendMessage = async () => new Promise(resolve => { settle = resolve; });
        f.host.close = async () => { f.calls.closed++; settle({ aborted: true }); };
        await f.request("session/send", { text: "hello" });
        controller.abort();
        await f.done;
        expect(f.calls.closed).toBe(1);
        expect(f.calls.subscribed).toBe(false);
        const eof = fixture();
        eof.input.end();
        await eof.done;
        expect(eof.calls.closed).toBe(1);
    });

    test("超长输入、输出断管、超时与事件积压均清理退出", async () => {
        const oversized = fixture({ maxLineBytes: 10 });
        oversized.input.write("12345678901");
        await expect(oversized.done).rejects.toThrow("输入行超过上限");
        expect(oversized.calls.closed).toBe(1);
        const broken = fixture({ output: new Writable({ write(_chunk, _encoding, callback) { callback(new Error("EPIPE")); } }) });
        broken.input.write('{"id":"init","method":"initialize","params":{"version":1}}\n');
        await expect(broken.done).rejects.toThrow("EPIPE");
        expect(broken.calls.closed).toBe(1);
        const stalled = fixture({ output: new Writable({ write() {} }), writeTimeoutMs: 10 });
        stalled.input.write('{"id":"init","method":"initialize","params":{"version":1}}\n');
        await expect(stalled.done).rejects.toThrow("输出等待超时");
        const overflow = fixture({ maxOutputBytes: 256 });
        await overflow.ready();
        overflow.emit({ ...commit(), payload: { ...commit().payload, extra: "x".repeat(500) } } as AgentEvent);
        await expect(overflow.done).rejects.toThrow("输出队列超过上限");
        expect(overflow.calls.closed).toBe(1);
    });

    test("两个宿主实例 ID 独立不变，交叉 target 和额外字段一律拒绝", async () => {
        const first = fixture({}, "FIRST");
        const second = fixture({}, "SECOND");
        await first.ready();
        await second.ready();
        const firstIdentity = first.identity();
        const secondIdentity = second.identity();
        expect(firstIdentity.instanceId).toMatch(/^[0-9a-f-]{36}$/);
        expect(firstIdentity.instanceId).not.toBe(secondIdentity.instanceId);
        const methods = ["initialize", "session/create", "session/resume", "session/send", "session/cancel",
            "session/status", "session/archive", "session/unarchive", "shutdown"];
        for (const method of methods) {
            const base = method === "initialize" ? { version: 1 }
                : method === "session/resume" ? { sessionId: RESUME_ID }
                    : method === "session/send" ? { text: "hello" } : {};
            for (const target of [{ sessionId: secondIdentity.sessionId }, { instanceId: secondIdentity.instanceId }, { target: secondIdentity }]) {
                expect((await first.request(method, { ...base, ...target })).error?.code).toBe(-32602);
            }
        }
        // 同实例 ID 也不是允许的入参，不靠客户端传来的身份决定路由。
        expect((await first.request("session/status", firstIdentity)).error?.code).toBe(-32602);
        expect((await first.request("session/status")).result).toEqual({ ...firstIdentity, state: "idle" });
        expect((await second.request("session/status")).result).toEqual({ ...secondIdentity, state: "idle" });
        expect(first.calls.created).toBe(1);
        expect(second.calls.created).toBe(1);
        expect((await first.request("initialize", { version: 1 })).error?.code).toBe(-32000);
        expect(first.identity()).toEqual(firstIdentity);
        expect((await first.request("toString")).error?.code).toBe(-32601);
        expect((await first.request("__proto__")).error?.code).toBe(-32601);
        first.emit({ ...commit(), sessionId: "SECOND" }, "FIRST");
        second.emit({ ...commit(), sessionId: "FIRST" }, "SECOND");
        first.emit({ ...commit(), sessionId: "FIRST" }, "FIRST");
        await first.request("shutdown");
        await second.request("shutdown");
        expect(first.frames.filter(frame => frame.method === "session/record")).toHaveLength(1);
        expect(first.frames.find(frame => frame.method === "session/record")?.params).toMatchObject(firstIdentity);
        expect(second.frames.some(frame => frame.method === "session/record")).toBe(false);
    });

    test("status 查询本进程实际 claim/busy，未创建时不伪造 sessionId", async () => {
        const f = fixture();
        await f.request("initialize", { version: 1 });
        const before = (await f.request("session/status")).result;
        expect(before).toEqual({ instanceId: f.identity().instanceId, state: "idle" });
        await f.request("session/create");
        let finish!: (outcome: {}) => void;
        f.host.sendMessage = async () => new Promise(resolve => { finish = resolve; });
        await f.request("session/send", { text: "hello" });
        expect((await f.request("session/status")).result).toEqual({ ...f.identity(), state: "working" });
        finish({});
        await waitFor(() => f.frames.some(frame => frame.method === "session/finished"));
        expect((await f.request("session/status")).result).toEqual({ ...f.identity(), state: "idle" });
        f.host.isSessionBusy = () => true;
        expect((await f.request("session/status")).result.state).toBe("working");
        f.host.isSessionBusy = () => false;
        // 内存 sessionId 仍然存在，但实际 control claim 已不在本宿主。
        f.calls.claimed = "OTHER";
        expect((await f.request("session/status")).result).toEqual({ ...f.identity(), state: "lost" });
        await f.done;
        expect(f.calls.closed).toBe(1);
        expect(f.frames.find(frame => frame.method === "session/status" && frame.params.state === "lost")?.params).toEqual({ ...f.identity(), state: "lost" });
        expect(f.frames.find(frame => frame.method === "session/error")?.params).toMatchObject(f.identity());
    });

    test("丢失持有权后不接受 send；release 和周期检查主动关闭，不把 child 当顶层", async () => {
        const released = fixture();
        await released.ready();
        released.host.onSessionReleased?.("CHILD", "auto");
        expect((await released.request("session/status")).result.state).toBe("idle");
        released.calls.claimed = "";
        released.host.onSessionReleased?.("OWN", "peer");
        await released.done;
        expect(released.calls.closed).toBe(1);
        expect(released.frames.filter(frame => frame.method === "session/status" && frame.params.state === "lost")).toHaveLength(1);
        const polling = fixture({ ownershipCheckMs: 5 });
        await polling.ready();
        polling.calls.claimed = "";
        await polling.done;
        expect(polling.calls.closed).toBe(1);
        expect(polling.frames.some(frame => frame.method === "session/status" && frame.params.state === "lost")).toBe(true);
        const denied = fixture();
        await denied.ready();
        let hasSent = false;
        denied.host.sendMessage = async () => { hasSent = true; return {}; };
        denied.calls.claimed = "OTHER";
        expect((await denied.request("session/send", { text: "must not run" })).error?.code).toBe(-32002);
        await denied.done;
        expect(hasSent).toBe(false);
    });

    test("所有通知加不可覆盖的实例/顶层身份，包括问答、错误、结束与 closing", async () => {
        let runtimeNotify!: (method: string, params: unknown) => void;
        let isUnregistered = false;
        const f = fixture({ registerRuntime: (notify, ownsSession) => {
            runtimeNotify = notify;
            expect(ownsSession("OTHER")).toBe(false);
            return () => { isUnregistered = true; };
        } });
        await f.ready();
        runtimeNotify("session/status", { state: "question_cancelled", requestId: "Q", instanceId: "fake", sessionId: "fake" });
        f.host.sendMessage = async () => { throw new Error("fake error"); };
        await f.request("session/send", { text: "hello" });
        await waitFor(() => f.frames.some(frame => frame.method === "session/finished"));
        f.emit(commit());
        await f.request("shutdown");
        await f.done;
        for (const frame of f.frames.filter(frame => frame.method?.startsWith("session/"))) {
            expect(frame.params).toMatchObject(f.identity());
        }
        expect(f.frames.find(frame => frame.method === "session/status" && frame.params.state === "question_cancelled")?.params.requestId).toBe("Q");
        expect(f.frames.find(frame => frame.method === "session/status" && frame.params.state === "closing")).toBeDefined();
        expect(isUnregistered).toBe(true);
    });

    test("提问走 session/question，客户端用 question/answer 作答", async () => {
        let askUser!: (request: UserQuestionRequest) => Promise<UserAnswer>;
        const f = fixture({ registerRuntime: (_notify, _ownsSession, ask) => {
            askUser = ask;
            return () => undefined;
        } });
        await f.ready();

        const pending = askUser({
            requestId: "Q1",
            sessionId: "OWN",
            questions: [{ header: "颜色", question: "选哪个？", options: [{ label: "红" }] }],
        });
        await waitFor(() => f.frames.some(frame => frame.method === "session/question"));
        const asked = f.frames.find(frame => frame.method === "session/question")!;
        expect(asked.params).toMatchObject({ requestId: "Q1", sessionId: "OWN" });
        expect(asked.params.questions[0].question).toBe("选哪个？");

        // 空作答被拒绝，等待仍然保留，可以继续作答。
        expect((await f.request("question/answer", { requestId: "Q1", answers: [] })).error?.code).toBe(-32602);
        const answers = [{ header: "颜色", question: "选哪个？", selected: ["红"] }];
        expect((await f.request("question/answer", { requestId: "Q1", answers })).error).toBeUndefined();
        expect(await pending).toEqual({ cancelled: false, answers });

        // 已经作答过的 requestId 不再等待：如实报错而不是假装成功。
        expect((await f.request("question/answer", { requestId: "Q1", answers })).error?.code).toBe(-32000);
    });

    test("ask_user 立即明确取消并发通知；CLI 参数不接受未知选项", async () => {
        const notices: unknown[] = [];
        const caps = createStdioCapabilities((method, params) => notices.push({ method, params }), id => id === "OWN");
        expect(caps.ownsSession("OTHER")).toBe(false);
        expect(await caps.askUser!({ requestId: "Q", sessionId: "OWN", questions: [] })).toEqual({ cancelled: true });
        expect(notices).toEqual([{ method: "session/status", params: { state: "question_cancelled", requestId: "Q" } }]);
        expect(parseStdioArgs([])).toEqual({ cwd: process.cwd() });
        expect(parseStdioArgs(["--cwd", "."])).toEqual({ cwd: process.cwd() });
        expect(() => parseStdioArgs(["--model", "x"])).toThrow("用法");
        expect(() => parseStdioArgs(["--cwd"])).toThrow("用法");
    });
});

describe("stdio JSONL resume / archive / unarchive", () => {
    test("resume 后重放已存轮次：响应先到，历史带 replay 标记", async () => {
        const history: ReplayRecord[] = [
            { type: "session_created", seq: 1, ts: "2026-11-16T10:00:00Z", payload: { cwd: "/workspace" } },
            { type: "user_message", seq: 2, ts: "2026-11-16T10:00:01Z", payload: { text: "hi" } },
        ];
        const seen: Array<{ id: string; limit: number }> = [];
        const f = fixture({ readHistory: async (id, limit) => {
            seen.push({ id, limit });
            return history;
        } });
        f.savedIds.add(RESUME_ID);
        await f.request("initialize", { version: 1 }, "init");
        expect((await f.request("session/resume", { sessionId: RESUME_ID }, "resume")).result)
            .toMatchObject({ sessionId: RESUME_ID });
        await waitFor(() => f.frames.some(frame => frame.method === "session/history"));
        const replayed = f.frames.find(frame => frame.method === "session/history")!;
        expect(replayed.params).toMatchObject({ sessionId: RESUME_ID, replay: true, records: history });
        expect(seen).toEqual([{ id: RESUME_ID, limit: HISTORY_MAX_EVENTS }]);
        // 历史在响应之后发出，客户端不会把它当成新建会话的通知
        const resumeIndex = f.frames.findIndex(frame => frame.id === "resume");
        expect(f.frames.indexOf(replayed)).toBeGreaterThan(resumeIndex);
        await f.request("shutdown");
        await f.done;
    });

    test("没有历史读取器或读取失败时不伪造历史", async () => {
        const plain = fixture();
        plain.savedIds.add(RESUME_ID);
        await plain.request("initialize", { version: 1 }, "init");
        await plain.request("session/resume", { sessionId: RESUME_ID }, "resume");
        await plain.request("shutdown");
        await plain.done;
        expect(plain.frames.some(frame => frame.method === "session/history")).toBe(false);

        const failing = fixture({ readHistory: async () => { throw new Error("日志损坏"); } });
        failing.savedIds.add(RESUME_ID);
        await failing.request("initialize", { version: 1 }, "init");
        await failing.request("session/resume", { sessionId: RESUME_ID }, "resume");
        await waitFor(() => failing.frames.some(frame => frame.params?.state === "history-failed"));
        expect(failing.frames.some(frame => frame.method === "session/history")).toBe(false);
        await failing.request("shutdown");
        await failing.done;
    });

    test("新建会话不重放历史", async () => {
        const f = fixture({ readHistory: async () => {
            throw new Error("新建会话不该读历史");
        } });
        await f.ready();
        await f.request("shutdown");
        await f.done;
        expect(f.frames.some(frame => frame.method === "session/history")).toBe(false);
    });

    test("resume 未归档会话：只认该 id，不取消归档，身份沿用 initialize", async () => {
        const f = fixture();
        f.savedIds.add(RESUME_ID);
        const init = await f.request("initialize", { version: 1 }, "init");
        const instanceId = init.result.instanceId;
        // 小写写法归一成大写口径，认领用的就是磁盘上的 id
        expect((await f.request("session/resume", { sessionId: RESUME_ID.toLowerCase() }, "resume")).result)
            .toEqual({ sessionId: RESUME_ID, instanceId });
        expect(f.calls.order).toEqual([`claim:${RESUME_ID}`]);
        expect(f.calls.unarchived).toEqual([]);
        expect((await f.request("session/status", {}, "status")).result)
            .toEqual({ instanceId, sessionId: RESUME_ID, state: "idle" });
        f.emit(commit());
        f.emit({ ...commit(), sessionId: "OTHER" }, RESUME_ID);
        f.emit({ ...commit(), sessionId: RESUME_ID }, RESUME_ID);
        await f.request("shutdown", {}, "shutdown");
        await f.done;
        const records = f.frames.filter(frame => frame.method === "session/record");
        expect(records).toHaveLength(1);
        expect(records[0]!.params).toMatchObject({ instanceId, sessionId: RESUME_ID });
        expect(f.calls.closed).toBe(1);
        expect(f.calls.subscribed).toBe(false);
    });

    test("resume 已归档会话：先取消归档再认领", async () => {
        const f = fixture();
        f.savedIds.add(RESUME_ID);
        f.archivedIds.add(RESUME_ID);
        await f.request("initialize", { version: 1 }, "init");
        expect((await f.request("session/resume", { sessionId: RESUME_ID }, "resume")).result)
            .toMatchObject({ sessionId: RESUME_ID });
        expect(f.calls.order).toEqual([`unarchive:${RESUME_ID}`, `claim:${RESUME_ID}`]);
        expect(f.archivedIds.has(RESUME_ID)).toBe(false);
        await f.request("shutdown");
        await f.done;
        expect(f.calls.closed).toBe(1);
    });

    test("resume 认领失败：明确 -32000 且本次机会已用掉", async () => {
        const f = fixture();
        f.savedIds.add(RESUME_ID);
        f.host.claimSession = async () => ({ ok: false, reason: "busy", pid: 4321 });
        await f.request("initialize", { version: 1 }, "init");
        const failed = await f.request("session/resume", { sessionId: RESUME_ID }, "resume");
        expect(failed.error?.code).toBe(-32000);
        expect(failed.error?.message).toContain("4321");
        expect((await f.request("session/resume", { sessionId: RESUME_ID })).error?.code).toBe(-32000);
        expect((await f.request("session/create")).error?.code).toBe(-32000);
        expect((await f.request("session/send", { text: "hi" })).error?.code).toBe(-32000);
        expect(f.calls.created).toBe(0);
    });

    test("resume 非法 id 不消费机会，未知 id 报 -32000 且不认领", async () => {
        const f = fixture();
        await f.request("initialize", { version: 1 }, "init");
        expect((await f.request("session/resume", {})).error?.code).toBe(-32602);
        expect((await f.request("session/resume", { sessionId: 42 })).error?.code).toBe(-32602);
        expect((await f.request("session/resume", { sessionId: "OWN" })).error?.code).toBe(-32602);
        expect((await f.request("session/resume", { sessionId: RESUME_ID, target: RESUME_ID })).error?.code).toBe(-32602);
        expect(f.calls.claimed).toBe("");
        const unknown = await f.request("session/resume", { sessionId: RESUME_ID }, "resume");
        expect(unknown.error?.code).toBe(-32000);
        expect(unknown.error?.message).toContain("会话不存在");
        expect(f.calls.claimed).toBe("");
        expect((await f.request("session/resume", { sessionId: RESUME_ID })).error?.code).toBe(-32000);
    });

    test("重复 resume 与 resume 后再 create 都被拒绝", async () => {
        const f = fixture();
        f.savedIds.add(RESUME_ID);
        await f.request("initialize", { version: 1 }, "init");
        await f.request("session/resume", { sessionId: RESUME_ID }, "resume");
        expect((await f.request("session/resume", { sessionId: RESUME_ID })).error?.message).toContain("一次");
        expect((await f.request("session/create")).error?.message).toContain("一次");
        expect(f.calls.created).toBe(0);
        expect(f.calls.order).toEqual([`claim:${RESUME_ID}`]);
    });

    test("resume 后 send/cancel 只作用于恢复的会话，通知身份贯穿", async () => {
        const f = fixture();
        f.savedIds.add(RESUME_ID);
        await f.request("initialize", { version: 1 }, "init");
        await f.request("session/resume", { sessionId: RESUME_ID }, "resume");
        let sent = "";
        f.host.sendMessage = async (id, text) => { sent = `${id}:${text}`; return {}; };
        await f.request("session/send", { text: "hello" }, "send");
        await waitFor(() => f.frames.some(frame => frame.method === "session/finished"));
        expect(sent).toBe(`${RESUME_ID}:hello`);
        expect((await f.request("session/cancel", {}, "cancel")).result).toEqual({ requested: true });
        expect(f.calls.aborts).toBe(1);
        f.emit({ ...commit(), sessionId: RESUME_ID }, RESUME_ID);
        await f.request("shutdown", {}, "shutdown");
        await f.done;
        const notices = f.frames.filter(frame => frame.method?.startsWith("session/") === true);
        expect(notices.length).toBeGreaterThan(0);
        expect(notices.every(frame => frame.params.sessionId === RESUME_ID)).toBe(true);
        expect(notices.every(frame => typeof frame.params.instanceId === "string")).toBe(true);
        expect(notices.some(frame => frame.params.state === "lost")).toBe(false);
    });

    test("archive 落归档并释放持有权：事件停止，随后可 unarchive 与 shutdown", async () => {
        const f = fixture();
        await f.ready();
        const { instanceId } = f.identity();
        expect((await f.request("session/archive", {}, "archive")).result).toEqual({ archived: true });
        expect(f.calls.archivedSessions).toEqual(["OWN"]);
        expect(f.calls.released).toEqual(["OWN"]);
        expect(f.calls.claimed).toBe("");
        expect(f.archivedIds.has("OWN")).toBe(true);
        // 归档后：不再转发事件，也不再被判成"失去持有权"
        f.emit(commit());
        f.host.onSessionReleased?.("OWN", "archive");
        expect((await f.request("session/status", {}, "status")).result).toEqual({ instanceId, state: "idle" });
        expect((await f.request("session/send", { text: "hi" })).error?.code).toBe(-32000);
        expect((await f.request("session/archive")).error?.code).toBe(-32000);
        expect((await f.request("session/unarchive", {}, "unarchive")).result).toEqual({ unarchived: true });
        expect(f.calls.unarchived).toEqual(["OWN"]);
        expect(f.archivedIds.has("OWN")).toBe(false);
        expect((await f.request("session/unarchive")).error?.message).toContain("未归档");
        await f.request("shutdown", {}, "shutdown");
        await f.done;
        expect(f.calls.closed).toBe(1);
        expect(f.frames.some(frame => frame.method === "session/record")).toBe(false);
        expect(f.frames.some(frame => frame.params?.state === "lost")).toBe(false);
    });

    test("archive 拒绝执行中的回合与无顶层会话；unarchive 无目标", async () => {
        const busyTurn = fixture();
        await busyTurn.ready();
        let finish!: (value: {}) => void;
        busyTurn.host.sendMessage = async () => new Promise(resolve => { finish = resolve; });
        await busyTurn.request("session/send", { text: "hello" });
        expect((await busyTurn.request("session/archive")).error?.code).toBe(-32001);
        finish({});
        await waitFor(() => busyTurn.frames.some(frame => frame.method === "session/finished"));
        await busyTurn.request("shutdown");
        await busyTurn.done;
        expect(busyTurn.calls.archivedSessions).toEqual([]);

        const busyHost = fixture();
        await busyHost.ready();
        busyHost.host.isSessionBusy = () => true;
        expect((await busyHost.request("session/archive")).error?.code).toBe(-32001);
        await busyHost.request("shutdown");
        await busyHost.done;

        const idle = fixture();
        await idle.request("initialize", { version: 1 }, "init");
        expect((await idle.request("session/archive")).error?.code).toBe(-32000);
        expect((await idle.request("session/unarchive")).error?.code).toBe(-32000);
        await idle.request("shutdown");
        await idle.done;
    });
});
