import { afterEach, describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { AcpAgent, type AcpHost } from "./acp-agent.js";
import type { SessionRuntimeCapabilities } from "../control/runtime.js";
import type { AgentEvent } from "../events/agent-events.js";
import type { SessionSummary } from "../host/session-host-types.js";
import { emptyUsage } from "../events/ui-events.js";

const SESSION_ID = "01M7HTFE6V91561SAV4KR4BV53";
const MODEL = { provider: "test", model: "model", protocol: "chat_completions" as const };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function fixture(capabilities: acp.ClientCapabilities = { elicitation: { form: {} } }) {
    const claimed = new Set<string>();
    const saved = new Map<string, SessionSummary>();
    const updates: acp.SessionNotification[] = [];
    const permissions: acp.RequestPermissionRequest[] = [];
    const histories = new Map<string, AgentEvent[]>();
    const calls = { aborts: [] as string[], sends: [] as string[], releases: [] as string[], mcpClosed: 0 };
    let caps: SessionRuntimeCapabilities | undefined;
    let listener: Parameters<AcpHost["subscribeEvents"]>[0] | undefined;
    let permission: (request: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse> = async () => ({ outcome: { outcome: "selected", optionId: "allow" } });
    let elicitation: (request: acp.CreateElicitationRequest) => Promise<acp.CreateElicitationResponse> = async () => ({ action: "accept", content: { answer_0: "first" } });
    let selection = MODEL;
    let count = 0;
    const host: AcpHost = {
        createSession: async cwd => {
            const sessionId = `${SESSION_ID.slice(0, -2)}${String(++count).padStart(2, "0")}`;
            saved.set(sessionId, { sessionId, cwd, messageCount: 0 });
            return { sessionId };
        },
        claimSession: async (id, options) => {
            expect(options).toEqual({ noNegotiate: true });
            if (claimed.has(id)) return { ok: false, reason: "busy" } as any;
            claimed.add(id);
            return { ok: true };
        },
        releaseSession: id => { claimed.delete(id); calls.releases.push(id); },
        ensureSessionCreated: async () => {},
        isSessionClaimed: id => claimed.has(id), isSessionBusy: () => false,
        listSessions: async () => [...saved.values()],
        isSessionArchived: async id => saved.get(id)?.archived ?? false,
        unarchiveSession: async () => { throw new Error("不能自动取消归档"); },
        closeSession: async () => { throw new Error("不能自动归档"); },
        getSessionCwd: async id => saved.get(id)?.cwd ?? process.cwd(),
        setSessionCwd: async (id, cwd) => { saved.get(id)!.cwd = cwd; },
        getSessionModelSelection: async () => selection,
        setSessionModelSelection: async (_id, model) => { selection = model as typeof MODEL; },
        setSessionLazyMcpServers: async () => {},
        sendMessage: async (id, text) => { calls.sends.push(text); return {}; },
        abortSession: async id => { calls.aborts.push(id); return true; },
        subscribeEvents: callback => { listener = callback; return () => { listener = undefined; }; },
        readSessionEvents: async id => histories.get(id) ?? [],
    };
    let failure: unknown;
    const agent = new AcpAgent({
        host, models: [MODEL, { ...MODEL, model: "other" }], defaultModel: MODEL, defaultServers: [],
        saveImage: async () => { throw new Error("此用例不保存图片"); },
        connectMcp: async () => ({ servers: [], close: async () => { calls.mcpClosed++; } }),
        registerRuntime: value => { caps = value; return () => { caps = undefined; }; },
        onFailure: error => { failure = error; },
    });
    const client = acp.client({ name: "zbot-test" })
        .onNotification("session/update", context => { updates.push(context.params); })
        .onRequest("session/request_permission", context => { permissions.push(context.params); return permission(context.params); })
        .onRequest("elicitation/create", context => elicitation(context.params));
    const connection = client.connect(agent.app());
    cleanups.push(async () => { connection.close(); await agent.dispose(); });
    const initialize = () => connection.agent.request("initialize", { protocolVersion: 1, clientCapabilities: capabilities });
    const create = () => connection.agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const ready = async () => { await initialize(); return (await create()).sessionId; };
    const emit = (event: AgentEvent) => listener?.(event.sessionId, event);
    return {
        agent, connection, host, calls, claimed, saved, histories, updates, permissions, initialize, create, ready, emit,
        caps: () => caps!, failure: () => failure,
        permission: (handler: typeof permission) => { permission = handler; },
        elicitation: (handler: typeof elicitation) => { elicitation = handler; },
    };
}

async function waitFor(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("等待 ACP 状态超时");
        await new Promise(resolve => setTimeout(resolve, 1));
    }
}

describe("标准 ACP 会话", () => {
    test("SDK 握手、参数验证、能力协商和独立多会话身份", async () => {
        const f = fixture();
        await expect(f.create()).rejects.toMatchObject({ code: -32600 });
        const initialized = await f.initialize();
        expect(initialized.protocolVersion).toBe(1);
        expect(initialized.agentCapabilities).toMatchObject({ loadSession: true, sessionCapabilities: { resume: {}, close: {}, list: {} } });
        await expect(f.connection.agent.request("session/new", { cwd: "relative", mcpServers: [] })).rejects.toMatchObject({ code: -32602 });
        const first = await f.create();
        const second = await f.create();
        expect(first.sessionId).not.toBe(second.sessionId);
        expect(first.configOptions?.[0]).toMatchObject({ id: "model", type: "select" });
        await expect(f.connection.agent.request("session/prompt", { sessionId: SESSION_ID, prompt: [{ type: "text", text: "wrong" }] })).rejects.toMatchObject({ code: -32002 });
        expect(f.calls.sends).toHaveLength(0);
    });

    test("流式文字、思考和工具通知在 prompt 的最终响应之前发完，不重复完整正文", async () => {
        const f = fixture();
        const id = await f.ready();
        f.host.sendMessage = async () => {
            f.host.onEvent?.(1, id, { type: "reasoning_delta", delta: "思考" });
            f.host.onEvent?.(1, id, { type: "text_delta", delta: "你好" });
            f.host.onEvent?.(1, id, { type: "message_end", content: "你好", stopReason: "stop" });
            f.host.onEvent?.(1, "OTHER", { type: "text_delta", delta: "不能泄露" });
            f.host.onEvent?.(1, id, { type: "tool_start", toolId: 1, callId: "c1", name: "bash", args: {}, mode: "serial" });
            f.host.onEvent?.(1, id, { type: "tool_result", toolId: 1, callId: "c1", name: "bash", summary: "done", isError: false, durationMs: 1 });
            return {};
        };
        const result = await f.connection.agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "hello" }] });
        expect(result.stopReason).toBe("end_turn");
        expect(f.updates.map(frame => frame.update.sessionUpdate)).toEqual([
            "agent_thought_chunk", "agent_message_chunk", "tool_call", "tool_call_update",
        ]);
        expect(f.updates.every(frame => frame.sessionId === id)).toBe(true);
    });

    test("回合忙时拒绝重入，取消通知不会被模型请求阻塞，并关闭未完成工具", async () => {
        const f = fixture();
        const id = await f.ready();
        let resolveTurn: ((value: { aborted: boolean }) => void) | undefined;
        f.host.sendMessage = async () => {
            f.host.onEvent?.(1, id, { type: "tool_start", toolId: 1, callId: "open", name: "bash", args: {}, mode: "serial" });
            return new Promise(resolve => { resolveTurn = resolve; });
        };
        f.host.abortSession = async () => { resolveTurn?.({ aborted: true }); return true; };
        const request = { sessionId: id, prompt: [{ type: "text" as const, text: "run" }] };
        const running = f.connection.agent.request("session/prompt", request);
        await waitFor(() => Boolean(resolveTurn));
        await expect(f.connection.agent.request("session/prompt", request)).rejects.toMatchObject({ code: -32000 });
        await f.connection.agent.notify("session/cancel", { sessionId: id });
        expect((await running).stopReason).toBe("cancelled");
        expect(f.updates.at(-1)?.update).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "open", status: "failed" });
        f.host.sendMessage = async () => ({});
        expect((await f.connection.agent.request("session/prompt", request)).stopReason).toBe("end_turn");
    });

    test("持久化错误和 length 映射为协议错误与 max_tokens", async () => {
        const f = fixture();
        const id = await f.ready();
        let error: string | undefined = "provider unavailable";
        f.host.sendMessage = async () => {
            f.emit({ type: "turn_commit", sessionId: id, seq: 1, ts: "2026-11-17T12:00:00Z", payload: {
                turnId: "turn", events: [], userMessages: [], stopReason: "length", interrupted: false, usage: emptyUsage(), error,
            } });
            return {};
        };
        const request = { sessionId: id, prompt: [{ type: "text" as const, text: "run" }] };
        await expect(f.connection.agent.request("session/prompt", request)).rejects.toMatchObject({ code: -32603 });
        error = undefined;
        expect((await f.connection.agent.request("session/prompt", request)).stopReason).toBe("max_tokens");
    });

    test("load 在响应前按顺序重放历史，close 保留会话，resume 不重放", async () => {
        const f = fixture();
        await f.initialize();
        f.saved.set(SESSION_ID, { sessionId: SESSION_ID, cwd: process.cwd(), messageCount: 2 });
        f.histories.set(SESSION_ID, [
            { type: "user_message", sessionId: SESSION_ID, seq: 1, ts: "now", payload: { text: "问题", turnId: "t", trigger: "user" } },
            { type: "turn_message", sessionId: SESSION_ID, seq: 2, ts: "now", payload: { turnId: "t", message: { role: "user", content: "问题" } } },
            { type: "turn_message", sessionId: SESSION_ID, seq: 3, ts: "now", payload: { turnId: "t", message: { role: "assistant", content: "回答" } } },
        ]);
        const params = { sessionId: SESSION_ID, cwd: process.cwd(), mcpServers: [] };
        await f.connection.agent.request("session/load", params);
        expect(f.updates.map(update => update.update.sessionUpdate)).toEqual(["user_message_chunk", "agent_message_chunk"]);
        await f.connection.agent.request("session/close", { sessionId: SESSION_ID });
        expect(f.saved.has(SESSION_ID)).toBe(true);
        expect(f.claimed.has(SESSION_ID)).toBe(false);
        expect(f.calls.mcpClosed).toBe(1);
        await f.connection.agent.request("session/resume", params);
        expect(f.updates).toHaveLength(2);
        expect(f.claimed.has(SESSION_ID)).toBe(true);
    });

    test("list 过滤归档与子会话，load 不抢占他人持有权或改变归档", async () => {
        const f = fixture();
        await f.initialize();
        f.saved.set(SESSION_ID, { sessionId: SESSION_ID, cwd: process.cwd(), messageCount: 0, archived: true });
        const params = { sessionId: SESSION_ID, cwd: process.cwd(), mcpServers: [] };
        expect((await f.connection.agent.request("session/list", {})).sessions).toHaveLength(0);
        await expect(f.connection.agent.request("session/load", params)).rejects.toMatchObject({ code: -32000 });
        f.saved.get(SESSION_ID)!.archived = false;
        f.claimed.add(SESSION_ID);
        await expect(f.connection.agent.request("session/load", params)).rejects.toMatchObject({ code: -32000 });
        expect(f.calls.releases).toHaveLength(0);
        await expect(f.connection.agent.request("session/list", { cursor: "bad" })).rejects.toMatchObject({ code: -32602 });
    });

    test("模型切换经宿主持久化并通知完整配置，未知值不被接受", async () => {
        const f = fixture();
        await f.initialize();
        const created = await f.create();
        const config = created.configOptions![0]!;
        if (config.type !== "select") throw new Error("期望模型选项");
        const target = config.options[1] as acp.SessionConfigSelectOption;
        const result = await f.connection.agent.request("session/set_config_option", {
            sessionId: created.sessionId, configId: "model", value: target.value,
        });
        expect(result.configOptions[0]?.currentValue).toBe(target.value);
        expect(f.updates.at(-1)?.update.sessionUpdate).toBe("config_option_update");
        await expect(f.connection.agent.request("session/set_config_option", {
            sessionId: created.sessionId, configId: "model", value: "unknown",
        })).rejects.toMatchObject({ code: -32602 });
    });
});

describe("ACP 交互与资源边界", () => {
    test("权限请求关联工具 callId，内部参数不出进程，未知授权选项视为拒绝", async () => {
        const f = fixture();
        const id = await f.ready();
        const allowed: boolean[] = [];
        f.permission(async () => ({ outcome: { outcome: "selected", optionId: "unexpected" } }));
        f.host.sendMessage = async () => {
            f.host.onEvent?.(1, id, { type: "tool_start", toolId: 1, callId: "call-permission", name: "bash", args: { command: "pwd" }, mode: "serial" });
            allowed.push(await f.caps().authorizeTool!("bash", { command: "pwd", __sessionId: id, __userId: "private" }, id));
            return {};
        };
        await f.connection.agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "run" }] });
        expect(allowed).toEqual([false]);
        expect(f.permissions[0]?.toolCall.toolCallId).toBe("call-permission");
        expect(f.permissions[0]?.toolCall.rawInput).toEqual({ command: "pwd" });
        expect(f.permissions[0]?.options.map(option => option.kind)).toEqual(["allow_once", "reject_once"]);
    });

    test("取消能结束不响应的权限请求，不等待客户端配合", async () => {
        const f = fixture();
        const id = await f.ready();
        f.permission(() => new Promise(() => {}));
        f.host.sendMessage = async () => {
            const allowed = await f.caps().authorizeTool!("bash", {}, id);
            expect(allowed).toBe(false);
            return { aborted: true };
        };
        const running = f.connection.agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "run" }] });
        await waitFor(() => f.permissions.length > 0);
        await f.connection.agent.notify("session/cancel", { sessionId: id });
        expect((await running).stopReason).toBe("cancelled");
    });

    test("表单提问保留自填与多选，无协商时不注册 ask_user", async () => {
        const f = fixture();
        const id = await f.ready();
        const answer = await f.caps().askUser!({
            requestId: "q", sessionId: id, questions: [{ header: "选择", question: "选哪个", options: [{ label: "first" }, { label: "second" }], multiSelect: true }],
        });
        expect(answer).toEqual({ cancelled: false, answers: [{ header: "选择", question: "选哪个", selected: ["first"] }] });
        f.elicitation(async () => ({ action: "accept", content: { answer_0: "first\n自填" } }));
        expect(await f.caps().askUser!({ requestId: "q2", sessionId: id, questions: [{ header: "h", question: "q", options: [{ label: "first" }], multiSelect: true }] }))
            .toMatchObject({ cancelled: false, answers: [{ selected: ["first"], custom: "自填" }] });
        const other = fixture({});
        await other.ready();
        expect(other.caps().askUser).toBeUndefined();
    });

    test("失去持有权后不再执行目标会话，断线清理释放自有会话", async () => {
        const f = fixture();
        const id = await f.ready();
        f.claimed.delete(id);
        await expect(f.connection.agent.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "run" }] })).rejects.toMatchObject({ code: -32002 });
        f.host.onSessionReleased?.(id, "peer");
        expect(f.failure()).toBeInstanceOf(Error);
        expect(f.calls.sends).toHaveLength(0);
    });
});
