/** 标准 ACP v1 前端：会话宿主负责执行与持久化，适配层负责协议与连接内身份。 */
import fs from "node:fs/promises";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { SessionHost } from "../host/session-host-types.js";
import type { SessionRuntimeCapabilities } from "../control/runtime.js";
import type { AgentEvent } from "../events/agent-events.js";
import type { UIEvent } from "../events/ui-events.js";
import type { ChatModelSelection } from "../types/chat-model.js";
import type { ImageAssetRef } from "../types/image.js";
import type { UserAnswer, UserQuestionRequest } from "../utils/user-question.js";
import { describeClaimFailure } from "../control/channel.js";
import { isUlid } from "../utils/session-id.js";
import { historyUpdates, parseAcpPrompt, textUpdates } from "./acp-content.js";
import type { AcpMcpScope } from "./acp-mcp.js";

export type AcpHost = Pick<SessionHost,
    "createSession" | "claimSession" | "releaseSession" | "ensureSessionCreated" | "isSessionClaimed"
    | "isSessionBusy" | "listSessions" | "isSessionArchived"
    | "getSessionCwd" | "setSessionCwd" | "getSessionModelSelection" | "setSessionModelSelection"
    | "setSessionLazyMcpServers" | "sendMessage" | "abortSession" | "subscribeEvents" | "onEvent"
    | "readSessionEvents" | "onSessionReleased">;

export interface AcpAgentOptions {
    host: AcpHost;
    models: ChatModelSelection[];
    defaultModel: ChatModelSelection;
    defaultServers: string[];
    saveImage(data: Buffer, filename: string): Promise<ImageAssetRef>;
    connectMcp(sessionId: string, cwd: string, servers: acp.McpServer[], signal: AbortSignal): Promise<AcpMcpScope>;
    readHistory?(sessionId: string): AsyncIterable<AgentEvent>;
    registerRuntime(capabilities: SessionRuntimeCapabilities): () => void;
    onFailure(error: Error): void;
    maxOutputBytes?: number;
}

interface ActiveTurn {
    controller: AbortController;
    done?: Promise<acp.PromptResponse>;
    commit?: Extract<AgentEvent, { type: "turn_commit" }>["payload"];
    hasTextDelta: boolean;
    openTools: Set<string>;
    permissionCalls: Array<{ callId: string; name: string }>;
}

interface AcpSession {
    mcp: AcpMcpScope;
    turn?: ActiveTurn;
    isLoading: boolean;
    isClosing: boolean;
}

const MAX_SESSIONS = 32;
const PAGE_SIZE = 100;

function modelId(model: ChatModelSelection): string {
    return JSON.stringify([model.provider, model.protocol, model.model, model.reasoningEffort ?? ""]);
}

export class AcpAgent {
    private readonly sessions = new Map<string, AcpSession>();
    private readonly controller = new AbortController();
    private client?: acp.AgentContext;
    private clientCapabilities: acp.ClientCapabilities = {};
    private unregisterRuntime?: () => void;
    private unsubscribe?: () => void;
    private previousOnEvent?: AcpHost["onEvent"];
    private previousOnReleased?: AcpHost["onSessionReleased"];
    private outputTail: Promise<void> = Promise.resolve();
    private pendingOutputBytes = 0;
    private outputError?: Error;
    private mutationTail: Promise<unknown> = Promise.resolve();
    private pendingMutations = 0;

    constructor(private readonly options: AcpAgentOptions) {}

    /** 生命周期修改串行化；模型回合保持独立，取消与权限响应不排在模型请求之后。 */
    private mutate<T>(operation: () => Promise<T>): Promise<T> {
        if (this.pendingMutations >= MAX_SESSIONS) return Promise.reject(new acp.RequestError(-32000, "生命周期请求队列已满"));
        this.pendingMutations++;
        const task = this.mutationTail.then(() => {
            this.controller.signal.throwIfAborted();
            return operation();
        });
        this.mutationTail = task.catch(() => undefined).finally(() => { this.pendingMutations--; });
        return task;
    }

    private requireSession(sessionId: string, allowLoading = false): AcpSession {
        const session = this.sessions.get(sessionId);
        if (!session || session.isClosing || (!allowLoading && session.isLoading)) throw acp.RequestError.sessionNotFound(sessionId);
        if (!this.options.host.isSessionClaimed(sessionId)) throw acp.RequestError.sessionNotFound(sessionId);
        return session;
    }

    private requireIdle(sessionId: string): AcpSession {
        const session = this.requireSession(sessionId);
        if (session.turn || this.options.host.isSessionBusy(sessionId)) throw new acp.RequestError(-32000, "会话正在执行回合");
        return session;
    }

    private update(sessionId: string, update: acp.SessionUpdate): Promise<void> {
        if (this.outputError) return Promise.reject(this.outputError);
        const bytes = Buffer.byteLength(JSON.stringify(update));
        if (this.pendingOutputBytes + bytes > (this.options.maxOutputBytes ?? 4 * 1024 * 1024)) {
            const error = new Error("ACP 输出队列超过上限");
            this.fail(error);
            return Promise.reject(error);
        }
        this.pendingOutputBytes += bytes;
        const task = this.outputTail.then(async () => {
            if (this.outputError) throw this.outputError;
            await this.client!.notify("session/update", { sessionId, update });
        });
        this.outputTail = task.catch(error => this.fail(error)).finally(() => { this.pendingOutputBytes -= bytes; });
        // UI 回调不能等待输出；返回的原任务仍向主动等待的调用方传播错误。
        void task.catch(() => undefined);
        return task;
    }

    private fail(error: unknown): void {
        if (this.outputError) return;
        this.outputError = error instanceof Error ? error : new Error(String(error));
        this.options.onFailure(this.outputError);
    }

    private emitText(sessionId: string, text: string, kind: "agent_message_chunk" | "agent_thought_chunk"): void {
        for (const update of textUpdates(text, kind)) void this.update(sessionId, update).catch(error => this.fail(error));
    }

    private forwardEvent(sessionId: string, event: UIEvent): void {
        const session = this.sessions.get(sessionId);
        if (!session || session.isLoading || !this.options.host.isSessionClaimed(sessionId)) return;
        const turn = session.turn;
        if (turn?.controller.signal.aborted) void this.options.host.abortSession(sessionId).catch(error => this.fail(error));
        switch (event.type) {
            case "text_delta":
                if (turn) turn.hasTextDelta = true;
                this.emitText(sessionId, event.delta, "agent_message_chunk");
                break;
            case "reasoning_delta": this.emitText(sessionId, event.delta, "agent_thought_chunk"); break;
            case "message_end":
                if (!turn?.hasTextDelta && event.content) this.emitText(sessionId, event.content, "agent_message_chunk");
                if (turn) turn.hasTextDelta = false;
                break;
            case "tool_start":
                turn?.openTools.add(event.callId);
                turn?.permissionCalls.push({ callId: event.callId, name: event.name });
                void this.update(sessionId, {
                    sessionUpdate: "tool_call", toolCallId: event.callId, title: event.name,
                    status: "in_progress", kind: "other", rawInput: event.args,
                }).catch(error => this.fail(error));
                break;
            case "tool_result":
                turn?.openTools.delete(event.callId);
                if (turn) turn.permissionCalls = turn.permissionCalls.filter(call => call.callId !== event.callId);
                void this.update(sessionId, {
                    sessionUpdate: "tool_call_update", toolCallId: event.callId,
                    status: event.isError ? "failed" : "completed",
                    content: [{ type: "content", content: { type: "text", text: event.summary.slice(0, 32_768) } }],
                }).catch(error => this.fail(error));
                break;
        }
    }

    private bind(client: acp.AgentContext): void {
        this.client = client;
        const host = this.options.host;
        this.previousOnEvent = host.onEvent;
        host.onEvent = (requestId, sessionId, event) => {
            this.previousOnEvent?.(requestId, sessionId, event);
            this.forwardEvent(sessionId, event);
        };
        this.previousOnReleased = host.onSessionReleased;
        host.onSessionReleased = (sessionId, cause) => {
            this.previousOnReleased?.(sessionId, cause);
            const session = this.sessions.get(sessionId);
            if (!session || session.isClosing) return;
            session.isClosing = true;
            session.turn?.controller.abort();
            this.fail(new Error(`ACP 会话已失去持有权: ${sessionId}`));
        };
        this.unsubscribe = host.subscribeEvents((sessionId, event) => {
            const session = this.sessions.get(sessionId);
            if (session?.turn && event?.type === "turn_commit") session.turn.commit = event.payload;
        });
    }

    private initialize(params: acp.InitializeRequest): acp.InitializeResponse {
        this.clientCapabilities = params.clientCapabilities ?? {};
        this.unregisterRuntime?.();
        this.unregisterRuntime = this.options.registerRuntime({
            ownsSession: id => this.sessions.has(id) && this.options.host.isSessionClaimed(id),
            authorizeTool: (name, args, sessionId, signal) => this.authorizeTool(name, args, sessionId, signal),
            ...(this.clientCapabilities.elicitation?.form ? {
                askUser: (request: UserQuestionRequest, signal?: AbortSignal) => this.askUser(request, signal),
            } : {}),
        });
        return {
            protocolVersion: acp.PROTOCOL_VERSION, agentInfo: { name: "zbot", version: "1.0.0" }, authMethods: [],
            agentCapabilities: {
                loadSession: true,
                promptCapabilities: { image: true, audio: false, embeddedContext: true },
                mcpCapabilities: { http: true, sse: true },
                sessionCapabilities: { list: {}, resume: {}, close: {} },
            },
        };
    }

    private async validateSetup(params: acp.NewSessionRequest | acp.LoadSessionRequest): Promise<void> {
        if (!path.isAbsolute(params.cwd) || !(await fs.stat(params.cwd)).isDirectory()) {
            throw acp.RequestError.invalidParams(undefined, "cwd 必须是存在的绝对目录");
        }
        if (params.additionalDirectories?.length || params.systemPrompt) {
            throw acp.RequestError.invalidParams(undefined, "当前宿主不支持附加工作目录或覆盖 systemPrompt");
        }
        if (params.mcpServers.length > 16) throw acp.RequestError.invalidParams(undefined, "最多 16 个 MCP 服务");
        if (this.sessions.size >= MAX_SESSIONS) throw new acp.RequestError(-32000, "连接最多同时持有 32 个会话，请先关闭空闲会话");
    }

    private async settings(sessionId: string): Promise<acp.LoadSessionResponse> {
        const selected = await this.options.host.getSessionModelSelection(sessionId) ?? this.options.defaultModel;
        const models = [...new Map([...this.options.models, selected].map(model => [modelId(model), model])).values()];
        return { configOptions: [{
            id: "model", name: "模型", category: "model", type: "select", currentValue: modelId(selected),
            options: models.map(model => ({ value: modelId(model), name: `${model.provider} / ${model.model}` })),
        }] };
    }

    private async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
        await this.validateSetup(params);
        const host = this.options.host;
        const created = await host.createSession(params.cwd, { selectedServers: this.options.defaultServers });
        const claim = await host.claimSession(created.sessionId, { noNegotiate: true });
        if (!claim.ok) throw new acp.RequestError(-32000, `无法认领新会话: ${describeClaimFailure(claim)}`);
        try {
            await host.ensureSessionCreated?.(created.sessionId);
            await this.activate(created.sessionId, params.cwd, params.mcpServers);
            const settings = await this.settings(created.sessionId);
            this.sessions.get(created.sessionId)!.isLoading = false;
            return { sessionId: created.sessionId, ...settings };
        } catch (error) {
            await this.release(created.sessionId);
            throw error;
        }
    }

    private async activate(sessionId: string, cwd: string, servers: acp.McpServer[]): Promise<void> {
        const mcp = await this.options.connectMcp(sessionId, cwd, servers, this.controller.signal);
        this.sessions.set(sessionId, { mcp, isLoading: true, isClosing: false });
        await this.options.host.setSessionLazyMcpServers(sessionId, [...this.options.defaultServers, ...mcp.servers]);
        this.controller.signal.throwIfAborted();
    }

    private async loadSession(params: acp.LoadSessionRequest, replay: boolean): Promise<acp.LoadSessionResponse> {
        await this.validateSetup(params);
        const sessionId = params.sessionId;
        if (!isUlid(sessionId)) throw acp.RequestError.invalidParams(undefined, "sessionId 必须为完整 ULID");
        if (this.sessions.has(sessionId)) throw new acp.RequestError(-32000, "会话已在此连接载入");
        const host = this.options.host;
        const summary = (await host.listSessions()).find(session => session.sessionId === sessionId && !session.delegation);
        if (!summary) throw acp.RequestError.sessionNotFound(sessionId);
        // 不自动改变归档事实；客户端可从原生会话管理入口取消归档后再载入。
        if (await host.isSessionArchived(sessionId)) throw new acp.RequestError(-32000, "会话已归档，请先取消归档");
        const claim = await host.claimSession(sessionId, { noNegotiate: true });
        if (!claim.ok) throw new acp.RequestError(-32000, `无法载入会话: ${describeClaimFailure(claim)}`);
        try {
            await this.activate(sessionId, params.cwd, params.mcpServers);
            const session = this.sessions.get(sessionId)!;
            session.isLoading = true;
            await host.setSessionCwd(sessionId, params.cwd);
            if (replay) {
                const events = this.options.readHistory?.(sessionId) ?? await host.readSessionEvents(sessionId);
                for await (const event of events) {
                    this.controller.signal.throwIfAborted();
                    for (const update of historyUpdates(event)) await this.update(sessionId, update);
                }
            }
            const settings = await this.settings(sessionId);
            session.isLoading = false;
            return settings;
        } catch (error) {
            await this.release(sessionId);
            throw error;
        }
    }

    private async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
        if (params.cursor && !/^\d+$/.test(params.cursor)) throw acp.RequestError.invalidParams(undefined, "无效分页游标");
        const offset = Number(params.cursor ?? 0);
        if (!Number.isSafeInteger(offset)) throw acp.RequestError.invalidParams(undefined, "无效分页游标");
        const sessions = (await this.options.host.listSessions())
            .filter(session => !session.archived && !session.archivedAt && !session.delegation && session.cwd
                && (!params.cwd || session.cwd === params.cwd))
            .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") || left.sessionId.localeCompare(right.sessionId));
        return {
            sessions: sessions.slice(offset, offset + PAGE_SIZE).map(session => ({
                sessionId: session.sessionId, cwd: session.cwd!, title: session.title, updatedAt: session.updatedAt,
            })),
            ...(sessions.length > offset + PAGE_SIZE ? { nextCursor: String(offset + PAGE_SIZE) } : {}),
        };
    }

    private async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
        const saved = (await this.options.host.listSessions()).find(session => session.sessionId === params.sessionId);
        if (!saved) throw acp.RequestError.sessionNotFound(params.sessionId);
        return this.loadSession({
            ...params,
            cwd: params.cwd ?? saved.cwd ?? await this.options.host.getSessionCwd(params.sessionId),
            mcpServers: params.mcpServers ?? [],
        }, false);
    }

    private prompt(params: acp.PromptRequest, signal: AbortSignal): Promise<acp.PromptResponse> {
        const session = this.requireIdle(params.sessionId);
        const turn: ActiveTurn = {
            controller: new AbortController(), hasTextDelta: false, openTools: new Set(), permissionCalls: [],
        };
        session.turn = turn;
        const cancel = (): void => {
            turn.controller.abort();
            void this.options.host.abortSession(params.sessionId).catch(error => this.fail(error));
        };
        signal.addEventListener("abort", cancel, { once: true });
        this.controller.signal.addEventListener("abort", cancel, { once: true });
        turn.done = (async (): Promise<acp.PromptResponse> => {
            try {
                const input = await parseAcpPrompt(params.prompt, this.options.saveImage);
                if (signal.aborted || this.controller.signal.aborted || turn.controller.signal.aborted) return { stopReason: "cancelled" };
                this.requireSession(params.sessionId);
                const outcome = await this.options.host.sendMessage(params.sessionId, input.text, { images: input.images });
                if (outcome.aborted || turn.controller.signal.aborted) return { stopReason: "cancelled" };
                if (turn.commit?.error) throw new acp.RequestError(-32603, turn.commit.error);
                const reason = turn.commit?.stopReason;
                return { stopReason: reason === "length" ? "max_tokens" : reason === "refusal" ? "refusal" : "end_turn" };
            } catch (error) {
                if (turn.controller.signal.aborted) return { stopReason: "cancelled" };
                throw error;
            } finally {
                try {
                    for (const toolCallId of turn.openTools) {
                        await this.update(params.sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
                    }
                    await this.outputTail;
                    if (this.outputError) throw this.outputError;
                } finally {
                    session.turn = undefined;
                    signal.removeEventListener("abort", cancel);
                    this.controller.signal.removeEventListener("abort", cancel);
                }
            }
        })();
        return turn.done;
    }

    private async cancel(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (!session || !this.options.host.isSessionClaimed(sessionId)) return;
        session.turn?.controller.abort();
        await this.options.host.abortSession(sessionId);
    }

    private async release(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) session.isClosing = true;
        try {
            await this.cancel(sessionId);
            await session?.turn?.done;
        } finally {
            try { await session?.mcp.close(); }
            finally {
                this.sessions.delete(sessionId);
                if (this.options.host.isSessionClaimed(sessionId)) this.options.host.releaseSession(sessionId, { cause: "user" });
            }
        }
    }

    private async setConfig(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
        const session = this.requireIdle(params.sessionId);
        const model = this.options.models.find(model => modelId(model) === params.value);
        if (params.configId !== "model" || !model) throw acp.RequestError.invalidParams(undefined, "未知模型配置");
        session.isLoading = true;
        try {
            await this.options.host.setSessionModelSelection(params.sessionId, model);
            const { configOptions } = await this.settings(params.sessionId);
            await this.update(params.sessionId, { sessionUpdate: "config_option_update", configOptions: configOptions! });
            return { configOptions: configOptions! };
        } finally { session.isLoading = false; }
    }

    private requestSignal(sessionId: string, signal?: AbortSignal): AbortSignal {
        const signals = [this.controller.signal, this.requireSession(sessionId).turn?.controller.signal, signal]
            .filter((signal): signal is AbortSignal => signal !== undefined);
        return AbortSignal.any(signals);
    }

    private async authorizeTool(name: string, args: unknown, sessionId: string, signal?: AbortSignal): Promise<boolean> {
        // 提问工具通过 elicitation 作答，不把回答问题伪装成授予执行权限。
        if (name === "ask_user") return true;
        const requestSignal = this.requestSignal(sessionId, signal);
        if (requestSignal.aborted) return false;
        const input = args && typeof args === "object"
            ? Object.fromEntries(Object.entries(args).filter(([key]) => !key.startsWith("__"))) : args;
        try {
            const turn = this.requireSession(sessionId).turn;
            const callIndex = turn?.permissionCalls.findIndex(call => call.name === name) ?? -1;
            const call = callIndex >= 0 ? turn!.permissionCalls.splice(callIndex, 1)[0] : undefined;
            const toolCallId = call?.callId ?? `permission-${crypto.randomUUID()}`;
            if (call) await this.update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "pending" });
            const response = await this.client!.request("session/request_permission", {
                sessionId, toolCall: { toolCallId, title: name, kind: "other", status: "pending", rawInput: input },
                options: [{ optionId: "allow", name: "允许本次", kind: "allow_once" }, { optionId: "reject", name: "拒绝本次", kind: "reject_once" }],
            }, { cancellationSignal: requestSignal, stopWaitingOnCancel: true });
            const isAllowed = !requestSignal.aborted && response.outcome.outcome === "selected" && response.outcome.optionId === "allow";
            if (call) await this.update(sessionId, {
                sessionUpdate: "tool_call_update", toolCallId, status: isAllowed ? "in_progress" : "failed",
            });
            return isAllowed;
        } catch (error) {
            if (requestSignal.aborted) return false;
            console.error(`[ACP] 工具授权失败 (${name}):`, error);
            return false;
        }
    }

    private async askUser(request: UserQuestionRequest, signal?: AbortSignal): Promise<UserAnswer> {
        const requestSignal = this.requestSignal(request.sessionId, signal);
        if (requestSignal.aborted) return { cancelled: true };
        const properties: Record<string, acp.ElicitationPropertySchema> = {};
        for (const [index, question] of request.questions.entries()) {
            // 自由文本保留自填和多选语义；选项说明包含在题干中，不限制客户端只能点单选。
            properties[`answer_${index}`] = {
                type: "string", title: question.header || question.question,
                description: [question.question, ...question.options.map(option => `${option.label}: ${option.description ?? ""}`),
                    question.multiSelect ? "可多选，使用换行分隔；也可直接输入其他答案。" : "可选择上述选项或输入其他答案。"].join("\n"),
            };
        }
        try {
            const response = await this.client!.request("elicitation/create", {
                mode: "form", sessionId: request.sessionId, message: "请回答以下问题",
                requestedSchema: { type: "object", properties, required: Object.keys(properties) },
            }, { cancellationSignal: requestSignal, stopWaitingOnCancel: true });
            if (requestSignal.aborted || response.action !== "accept" || !response.content || typeof response.content !== "object") {
                return { cancelled: true };
            }
            const content = response.content as Record<string, unknown>;
            const answers = request.questions.map((question, index) => {
                const raw = content[`answer_${index}`];
                if (typeof raw !== "string" || !raw.trim()) throw new Error("客户端返回了缺失或无效的提问答案");
                const labels = new Set(question.options.map(option => option.label));
                const values = question.multiSelect ? raw.split("\n").map(value => value.trim()).filter(Boolean) : [raw.trim()];
                const selected = values.filter(value => labels.has(value));
                const custom = values.filter(value => !labels.has(value)).join("\n");
                return { header: question.header, question: question.question, selected, ...(custom ? { custom } : {}) };
            });
            return { cancelled: false, answers };
        } catch (error) {
            if (!requestSignal.aborted) console.error("[ACP] 提问失败:", error);
            return { cancelled: true };
        }
    }

    app(): acp.AgentApp {
        return acp.agent({ name: "zbot" })
            .onConnect(connection => this.bind(connection.client))
            .onRequest("initialize", context => this.initialize(context.params))
            .onRequest("session/new", context => this.mutate(() => this.newSession(context.params)))
            .onRequest("session/load", context => this.mutate(() => this.loadSession(context.params, true)))
            .onRequest("session/resume", context => this.mutate(() => this.resumeSession(context.params)))
            .onRequest("session/list", context => this.listSessions(context.params))
            .onRequest("session/close", context => this.mutate(async () => {
                this.requireSession(context.params.sessionId);
                await this.release(context.params.sessionId);
                return {};
            }))
            .onRequest("session/set_config_option", context => this.mutate(() => this.setConfig(context.params)))
            .onRequest("session/prompt", context => this.prompt(context.params, context.signal))
            .onNotification("session/cancel", context => this.cancel(context.params.sessionId));
    }

    async dispose(): Promise<void> {
        this.controller.abort();
        this.unregisterRuntime?.();
        await this.mutationTail;
        this.unsubscribe?.();
        this.options.host.onEvent = this.previousOnEvent;
        this.options.host.onSessionReleased = this.previousOnReleased;
        const results = await Promise.allSettled([...this.sessions.keys()].map(id => this.release(id)));
        const failures = results.filter(result => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), "ACP 会话清理失败");
    }
}
