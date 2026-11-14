import fs from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { skillRegistry } from "../skills/skill-registry.js";
import { loadIdentityContext } from "../skills/base-skill.js";
import { executeWithChat, createChatClient, isAbortError } from "../tools/chat-orchestrator.js";
import { executeMcpTool, getOpenAIToolDefinitions, type ToolDefinitionOptions } from "../tools/tool-registry.js";
import { getJobContext } from "../tools/job-context.js";
import { createTodoReminderProvider } from "../tools/todo-tool.js";
import { runWithToolCwd } from "../utils/tool-cwd-context.js";
import {
    describeDroppedMedia,
    toolContentToAudioContent,
    toolContentToImageContent,
    toolResultToText,
} from "../tools/tool-interface.js";
import { isToolSearchEnabled, supportsAudioInput } from "../tools/orchestrator/turn-request.js";
import type { ImageInputCapability } from "../tools/orchestrator/image-input.js";
import { resolveProtocol } from "../tools/orchestrator/request-builder.js";
import type { ChatMessage, Session } from "../types/session.js";
import type { SteerUpdate, StreamDelta } from "../types/chat.js";
import { toUserContent, type UserContent, type UserMessageInput } from "../types/image.js";
import type { ToolCall } from "../types/tool-call.js";
import { getSessionContextHistoryWithIds } from "../utils/conversation-history.js";
import type { LLMRequestKind } from "../utils/logger.js";
import type { UIEvent } from "../events/ui-events.js";
import { getSessionToolNames } from "../tools/session-tools.js";
import { getAskUserToolNames } from "../tools/ask-user-tool.js";
import { isDeepSeekCostStatEnabled } from "../pricing/deepseek.js";
import type { ChatApiProtocol, ChatModelSelection } from "../types/chat-model.js";
import { getModelPreferencesFile } from "../utils/state-paths.js";
import { withFileLock } from "../utils/file-lock.js";
import { countTextTokens } from "../utils/tokenizer.js";
import { createHash } from "node:crypto";
import {
    getDefaultModelTarget,
    getProvider,
    getProviders,
    type DefaultModelTarget,
    type ProviderConfig,
} from "../config/index.js";
export { closeResponsesSession as closeChatSessionTransport } from "../tools/orchestrator/responses-session.js";
export { deleteResponsesBaseline } from "../tools/orchestrator/responses-baseline.js";
export { steerResponsesSession as steerChatSession } from "../tools/orchestrator/responses-session.js";

/** 当前会话注入的工具名集合：工具下发与 token 预算共用，避免两处漂移。 */
function activeToolNames(sessionId?: string): string[] {
    return [
        ...getSessionToolNames(sessionId),
        ...getAskUserToolNames(sessionId),
        ...(getJobContext() ? ["job_comment"] : []),
    ];
}

const toolDefinitionsTokenCache = new Map<string, number>();

/**
 * 工具定义占用的 token 数（按内容摘要缓存）。
 * 压缩请求与阈值判定都要把它从窗口预算里扣掉：它不进历史，但确实挤占窗口。
 */
export async function getToolDefinitionsTokens(
    options: { sessionId?: string; model?: string; modelSelection?: ChatModelSelection } = {},
): Promise<number> {
    const settings = getChatApiSettings(options.modelSelection);
    const model = options.model ?? settings.model;
    const defs = getOpenAIToolDefinitions(activeToolNames(options.sessionId), toolDefinitionOptions({
        sessionId: options.sessionId,
        settings,
        model,
    }));
    const json = JSON.stringify(defs);
    const key = `${model}:${createHash("sha1").update(json).digest("hex")}`;
    const cached = toolDefinitionsTokenCache.get(key);
    if (cached !== undefined) return cached;
    const tokens = await countTextTokens(json, model);
    toolDefinitionsTokenCache.set(key, tokens);
    return tokens;
}

export interface ChatApiSettings {
    /** config.yaml 里的 provider 名。 */
    provider: string;
    apiKey: string;
    apiBase: string;
    model: string;
    protocol?: ChatApiProtocol;
    reasoningEffort?: string;
    reasoningEfforts?: string[];
    /** 托管工具类型：由上游执行，本地不执行。 */
    hostedTools: string[];
    /** Responses 是否走 WebSocket；默认走 HTTP，只有显式 `true` 才启用。 */
    websocket?: boolean;
    /** Responses 是否请求上游保存。 */
    store: boolean;
    /** Chat Completions 是否允许 `input_audio`；省略时按模型名启发式。 */
    audioInput?: boolean;
    /** 该服务是否接受图片；省略时视为接受，只有 `textOnlyModels` 命中的模型判否。 */
    imageInput?: ImageInputCapability;
    /** 该 provider 的上下文窗口覆盖值。 */
    contextWindowTokens?: number;
    /** runtime.deepseekCostStat：开启后非官方端点（局域网网关）也按官方价格表估算费用。 */
    enableCostStat: boolean;
}

export type ChatModelOption = ChatModelSelection;

/**
 * 工具下发口径：任务级 MCP 白名单 + 接入端 tool_search 能力 + 本会话临时启用的 lazy server。
 * 下发（getToolDefinitions）与窗口预算（getToolDefinitionsTokens）共用同一份，避免两处漂移。
 */
function toolDefinitionOptions(options: {
    sessionId?: string;
    settings: ChatApiSettings;
    model: string;
}): ToolDefinitionOptions {
    return {
        toolSearch: isToolSearchEnabled({
            protocol: options.settings.protocol ?? "chat_completions",
            model: options.model,
            baseURL: options.settings.apiBase,
            hostedTools: options.settings.hostedTools,
        }),
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    };
}

let defaultModelOption: ChatModelOption | null | undefined;

/**
 * 偏好文件里的选择：新格式带 provider；旧格式只有 protocol + model，
 * 按协议映射到第一个匹配的 provider（模型已不存在时仍映射，退化为临时模型）。
 */
function normalizePreference(value: Partial<ChatModelOption> & { protocol?: string }): ChatModelOption | undefined {
    if (typeof value.model !== "string" || !value.model.trim()) return undefined;
    const model = value.model.trim();
    const effort = typeof value.reasoningEffort === "string" ? { reasoningEffort: value.reasoningEffort } : {};

    if (typeof value.provider === "string" && value.provider.trim()) {
        const provider = getProvider(value.provider.trim());
        if (!provider) return undefined;
        return { provider: provider.name, protocol: provider.protocol, model, ...effort };
    }

    const protocol = value.protocol;
    if (protocol !== "responses" && protocol !== "chat_completions") return undefined;
    const provider = getProviders().find(candidate => candidate.protocol === protocol
        && candidate.models.includes(model))
        ?? getProviders().find(candidate => candidate.protocol === protocol);
    if (!provider) return undefined;
    return { provider: provider.name, protocol: provider.protocol, model, ...effort };
}

function getDefaultChatModelOption(): ChatModelOption | undefined {
    if (defaultModelOption !== undefined) return defaultModelOption ?? undefined;
    try {
        const value = JSON.parse(fs.readFileSync(getModelPreferencesFile(), "utf8")) as Partial<ChatModelOption>;
        defaultModelOption = normalizePreference(value) ?? null;
        return defaultModelOption ?? undefined;
    } catch {
        // 缺失或损坏的偏好文件使用配置里的 defaults。
    }
    defaultModelOption = null;
    return undefined;
}

export async function setDefaultChatModelOption(option: ChatModelOption): Promise<void> {
    const provider = getProvider(option.provider);
    if (!provider) {
        throw new Error(`provider 不存在：${option.provider}`);
    }
    if (!provider.models.includes(option.model)) {
        throw new Error(`临时模型不能设为默认：${provider.name} · ${option.model}（先加进配置的 models）`);
    }

    const file = getModelPreferencesFile();
    await withFileLock(file, () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporaryFile = `${file}.tmp`;
        fs.writeFileSync(temporaryFile, JSON.stringify(option, null, 2), "utf8");
        fs.renameSync(temporaryFile, file);
    });
    defaultModelOption = { ...option };
}

function isPrivateIPv4(hostname: string): boolean {
    if (isIP(hostname) !== 4) return false;

    const [first, second] = hostname.split(".").map(Number);
    return first === 10
        || first === 127
        || (first === 169 && second === 254)
        || (first === 172 && second >= 16 && second <= 31)
        || (first === 192 && second === 168);
}

function isLocalApiHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (
        normalized === "localhost"
        || normalized.endsWith(".localhost")
        || normalized.endsWith(".local")
        || normalized.endsWith(".lan")
        || normalized.endsWith(".internal")
    ) {
        return true;
    }

    if (isPrivateIPv4(normalized)) return true;
    if (isIP(normalized) === 0) return !normalized.includes(".");
    if (isIP(normalized) !== 6) return false;

    return normalized === "::1"
        || /^f[cd]/.test(normalized)
        || /^fe[89ab]/.test(normalized)
        || (normalized.startsWith("::ffff:") && isPrivateIPv4(normalized.slice("::ffff:".length)));
}

export function validateChatApiSettings(settings: ChatApiSettings): string | undefined {
    const baseName = `providers.${settings.provider}.baseUrl`;

    let apiUrl: URL;
    try {
        apiUrl = new URL(settings.apiBase);
    } catch {
        return `${baseName} 不是有效 URL：${settings.apiBase}`;
    }

    if (apiUrl.protocol !== "http:" && apiUrl.protocol !== "https:") {
        return `${baseName} 只支持 http 或 https：${settings.apiBase}`;
    }

    if (!settings.apiKey.trim() && !isLocalApiHostname(apiUrl.hostname)) {
        const ref = getProvider(settings.provider)?.apiKeyRef;
        if (ref) {
            return `API 密钥不可用：providers.${settings.provider}.apiKey=$${ref} 引用的环境变量 ${ref} 未设置`;
        }
        return `缺少 API 密钥：请在 config.yaml 的 providers.${settings.provider}.apiKey 填写（本地或局域网服务可省略）`;
    }

    // 本地/局域网服务可以不带模型名，由服务端选默认；远端必须说清用哪个模型
    if (!settings.model.trim() && !isLocalApiHostname(apiUrl.hostname)) {
        return `缺少模型：请在 config.yaml 的 providers.${settings.provider}.models 里列出，或用 /model ${settings.provider} <模型> 临时指定`;
    }

    return undefined;
}

export function formatChatProviderError(error: unknown, currentSettings = getChatApiSettings()): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("回合消息落盘失败") || message.startsWith("流式消息落盘失败")) return message;
    const explicitStatus = typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status?: unknown }).status)
        : undefined;
    const messageStatus = Number(message.match(/(?:^|\s)(\d{3})(?=\s|:|$)/)?.[1]);
    const status = Number.isFinite(explicitStatus) ? explicitStatus : messageStatus;

    if (status === 401 || status === 403) {
        return `LLM provider 请求失败（HTTP ${status}）：认证失败，请检查 config.yaml 的 providers.${currentSettings.provider}.apiKey。`;
    }

    if (status === 429) {
        return `LLM provider 请求失败（HTTP 429）：provider 已限流或额度已用尽。${message}`;
    }

    if (status !== undefined && status >= 400) {
        return `LLM provider 请求失败（HTTP ${status}）：${message}`;
    }

    if (message.includes("fetch failed") || message.includes("ECONNREFUSED")) {
        const baseName = `providers.${currentSettings.provider}.baseUrl`;
        return `LLM provider 请求失败：无法连接 ${currentSettings.apiBase}，请检查 ${baseName} 和网络代理。`;
    }

    return `LLM provider 请求失败：${message}`;
}

export interface ChatRunOptions {
    query: string;
    queryContent?: UserContent;
    systemPrompt: string;
    history?: any[];
    /** 会话绑定的工作目录：工具调用在该目录下执行（缺省时回退进程级 TUI_CWD）。 */
    cwd?: string;
    /**
     * 实时解析工具执行目录：命中时优先于 cwd。
     * 会话 cwd 可能在回合中间被 cwd 工具改写，后续工具应立即用新目录。
     */
    resolveCwd?: () => string | undefined;
    userId: number;
    sessionId?: string;
    modelSelection?: ChatModelSelection;
    modelOverride?: string;
    contextEpochId?: string;
    initialRequestKind?: Exclude<LLMRequestKind, 'tool_response'>;
    signal?: AbortSignal;
    stream?: boolean;
    /** 禁止本次请求继续调用工具，仅根据已有历史生成文本。 */
    disableToolCalls?: boolean;
    consumePendingMessages?: () => Array<string | UserMessageInput> | undefined;
    onConsumePending?: (text: string, messages: Array<string | UserMessageInput>) => void | Promise<void>;
    onSteerUpdate?: (update: SteerUpdate) => Promise<void>;
    onToolCall?: (name: string, args: any, mode: "serial" | "parallel") => void;
    onToolResult?: (name: string, result: string) => void;
    onAssistantToolCallContent?: (content: string) => Promise<void> | void;
    onInvalidAssistantHistory?: () => void;
    onProgress?: (text: string) => void;
    onEvent?: (event: UIEvent) => void | Promise<void>;
    autoCompactActiveTurn?: boolean;
    /** 续跑仅在 provider 明确报输入超窗时压缩，不做请求前预压缩。 */
    compactOnProviderOverflow?: boolean;
    /** 回合内每条完整消息定稿时的落盘回调（turn_message 事件源）。 */
    onTurnMessage?: (message: ChatMessage) => void | Promise<void>;
    onStreamDelta?: (delta: StreamDelta, requestIndex: number) => Promise<void>;
    /** 回合内压缩成功后的落盘回调：摘要在重启后不可回滚（否则上下文又回涨到压缩前）。 */
    onTurnCompact?: (compactedContext: string) => Promise<void>;
    /** 续跑：不把 query 插入为 user 消息，保持上游请求与中断前一致。 */
    skipUserQuery?: boolean;
    /** 续跑：进入循环前先补跑这些工具调用（中断时缺结果的调用）。 */
    pendingToolCalls?: ToolCall[];
}

/** 选择 → 实际生效的 provider 与模型；临时模型（不在 models 里）照样生效。 */
function resolveActiveTarget(sessionSelection?: ChatModelSelection): {
    provider: ProviderConfig;
    model: string;
    reasoningEffort?: string;
} {
    const requested = sessionSelection ?? getDefaultChatModelOption();
    // 旧会话落盘的 model_selected 没有 provider：按协议映射到第一个匹配的 provider
    const requestedProvider = requested
        ? getProvider(requested.provider)
            ?? getProviders().find(candidate => candidate.protocol === requested.protocol)
        : undefined;
    if (requested && requestedProvider && requested.model.trim()) {
        return {
            provider: requestedProvider,
            model: requested.model.trim(),
            ...(requested.reasoningEffort ? { reasoningEffort: requested.reasoningEffort } : {}),
        };
    }

    const fallback: DefaultModelTarget = getDefaultModelTarget();
    return {
        provider: getProvider(fallback.provider)!,
        model: fallback.model,
        ...(fallback.reasoningEffort ? { reasoningEffort: fallback.reasoningEffort } : {}),
    };
}

export function getChatApiSettings(sessionSelection?: ChatModelSelection): ChatApiSettings {
    const target = resolveActiveTarget(sessionSelection);
    const provider = target.provider;
    return {
        provider: provider.name,
        apiKey: provider.apiKey,
        apiBase: provider.baseUrl,
        model: target.model,
        protocol: provider.protocol,
        reasoningEffort: target.reasoningEffort,
        ...(provider.efforts ? { reasoningEfforts: provider.efforts } : {}),
        hostedTools: provider.hostedTools,
        ...(provider.websocket === undefined ? {} : { websocket: provider.websocket }),
        store: provider.store,
        ...(provider.audioInput === undefined ? {} : { audioInput: provider.audioInput }),
        imageInput: {
            ...(provider.imageInput === undefined ? {} : { imageInput: provider.imageInput }),
            ...(provider.textOnlyModels ? { textOnlyModels: provider.textOnlyModels } : {}),
        },
        ...(provider.contextWindowTokens === undefined ? {} : { contextWindowTokens: provider.contextWindowTokens }),
        enableCostStat: isDeepSeekCostStatEnabled(),
    };
}

/** 可切换的模型清单：按 providers 顺序展开各自 models。 */
export function getChatModelOptions(): ChatModelOption[] {
    return getProviders().flatMap(provider => provider.models.map(model => ({
        provider: provider.name,
        protocol: provider.protocol,
        model,
    })));
}

/**
 * 组装 system prompt：身份文件 + 技能清单。
 * 每次调用都现读磁盘，不缓存；cwd 用于身份文件里 {{TUI_CWD}} 的插值。
 */
export function buildSystemPrompt(cwd?: string): string {
    const sections: string[] = [];
    const identity = loadIdentityContext(cwd ? { TUI_CWD: cwd } : undefined).trim();
    if (identity) {
        sections.push(identity);
    }

    sections.push(skillRegistry.buildSkillListing());
    return sections.join("\n\n");
}

export function buildConversationHistory(
    session: Pick<Session, "turns" | "compactedContext" | "compactedThroughTurnId"> & Partial<Pick<Session, "compactedKeepFromMessageId" | "contextEpochId">>,
    pendingMessages: Array<string | UserMessageInput>,
    options: { skipToolCallIds?: ReadonlySet<string> } = {},
): any[] {
    const extraMessages = pendingMessages.slice(0, -1);
    // 带上消息 id：请求前的压缩判定与工具结果投影都按 id 缓存，长会话只算新增内容
    const history = getSessionContextHistoryWithIds(session, options);
    history.push(...extraMessages.map(input => ({
        role: "user" as const,
        content: toUserContent(typeof input === "string" ? { text: input } : input),
    })));
    return history;
}

export async function runChatQuery(options: ChatRunOptions) {
    const settings = getChatApiSettings(options.modelSelection);
    if (options.modelOverride?.trim()) settings.model = options.modelOverride.trim();
    const settingsError = validateChatApiSettings(settings);
    if (settingsError) {
        throw new Error(`LLM provider 配置无效：${settingsError}`);
    }

    const client = createChatClient(
        settings.apiKey,
        settings.apiBase,
        settings.protocol,
        options.sessionId,
        settings.model,
        {
            ...(settings.websocket === undefined ? {} : { websocket: settings.websocket }),
            store: settings.store,
            ...(settings.audioInput === undefined ? {} : { audioInput: settings.audioInput }),
        },
    );
    let activeTurnCompactionFailed = false;

    try {
        client.preconnect?.();
        return await executeWithChat({
            query: options.query,
            queryContent: options.queryContent,
            client,
            model: settings.model,
            reasoningEffort: settings.reasoningEffort,
            reasoningEfforts: settings.reasoningEfforts,
            ...(settings.hostedTools.length > 0 ? { hostedTools: settings.hostedTools } : {}),
            ...(settings.imageInput ? { imageInput: settings.imageInput } : {}),
            executeTool: async (name: string, args: any) => {
                if (options.signal?.aborted) {
                    throw new DOMException("User terminated the request", "AbortError");
                }

                const finalArgs = { ...(args || {}) };
                finalArgs.__userId = options.userId;
                if (options.sessionId !== undefined) finalArgs.__sessionId = options.sessionId;
                const execute = () => executeMcpTool(name, finalArgs, options.signal);
                const toolCwd = options.resolveCwd?.() ?? options.cwd;
                const result = toolCwd
                    ? await runWithToolCwd(toolCwd, execute)
                    : await execute();
                const content = toolResultToText(result);
                const audioContent = toolContentToAudioContent(result.content);
                // provider 能力判定留在这一层，说明函数只消费结果；
                // 用 resolveProtocol / client.baseURL 与实际生效路径（prepareRequest）保持同源
                const audioDropReason = resolveProtocol(client) === "responses"
                    ? "responses"
                    : supportsAudioInput(settings.model, client.baseURL, settings.audioInput) ? undefined : "endpoint";
                const mediaNotice = describeDroppedMedia(result.content, { audioDropReason });
                return {
                    content: mediaNotice ? `${content}${mediaNotice}` : content,
                    imageContent: await toolContentToImageContent(result.content, options.sessionId),
                    audioContent,
                    contextPolicy: result.contextPolicy,
                    // 结构化失败必须一路上行到调度层：`_order` 串行链靠它决定是否中止
                    isError: result.isError,
                };
            },
            getSystemPrompt: () => options.systemPrompt,
            // 会话级工具按会话注入：会话间通信要控制通道、提问要有人能回答（见各自 getXxxToolNames）。
            // job_comment 只在任务执行上下文里下发；MCP 工具按任务勾选的白名单过滤。
            // 压缩这类纯生成请求照旧带上工具声明：工具定义参与前缀，换一份就等于让整段
            // 历史丢掉缓存（命中价与 miss 价差一个量级）；窗口预算改由「裁历史」来让出。
            getToolDefinitions: () => getOpenAIToolDefinitions(
                activeToolNames(options.sessionId),
                toolDefinitionOptions({ sessionId: options.sessionId, settings, model: settings.model }),
            ),
            ...(options.disableToolCalls ? { toolChoice: "none" as const } : {}),
            history: options.history ?? [],
            sessionId: options.sessionId,
            contextEpochId: options.contextEpochId,
            initialRequestKind: options.initialRequestKind,
            stream: options.stream,
            consumePendingMessages: options.consumePendingMessages,
            onConsumePending: options.onConsumePending,
            onSteerUpdate: options.onSteerUpdate,
            compactMessagesIfNeeded: options.autoCompactActiveTurn || options.compactOnProviderOverflow
                ? async (messages, lastPromptTokens, providerMaxTokens) => {
                    if (!options.autoCompactActiveTurn && providerMaxTokens === undefined) return undefined;
                    if (activeTurnCompactionFailed) return undefined;
                    const { compactActiveTurnMessagesIfNeeded } = await import("./auto-compact.js");
                    // 预算要扣掉工具定义：它随请求上行占窗口，但不在历史里
                    const toolsTokens = await getToolDefinitionsTokens({
                        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
                        model: settings.model,
                        ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
                    });
                    return compactActiveTurnMessagesIfNeeded(messages, {
                        model: settings.model,
                        systemPrompt: options.systemPrompt,
                        toolsTokens,
                        userId: options.userId,
                        signal: options.signal,
                        sessionId: options.sessionId,
                        modelSelection: options.modelSelection,
                        contextEpochId: options.contextEpochId,
                        lastPromptTokens,
                        providerMaxTokens,
                        ...(options.onTurnCompact ? { onCompacted: options.onTurnCompact } : {}),
                        onUsage: usage => options.onEvent?.({ type: "usage", usage }),
                        onProgress: message => {
                            options.onProgress?.(message);
                            options.onEvent?.({ type: "progress", message });
                        },
                        onFailure: () => { activeTurnCompactionFailed = true; },
                    });
                }
                : undefined,
            getContextReminders: options.sessionId ? createTodoReminderProvider(options.sessionId) : undefined,
            onToolCall: options.onToolCall,
            onToolResult: options.onToolResult,
            onAssistantToolCallContent: options.onAssistantToolCallContent,
            onInvalidAssistantHistory: options.onInvalidAssistantHistory,
            onProgress: options.onProgress,
            onTurnMessage: options.onTurnMessage,
            onStreamDelta: options.onStreamDelta,
            skipUserQuery: options.skipUserQuery,
            pendingToolCalls: options.pendingToolCalls,
            onEvent: event => {
                if (event.type === "error") {
                    options.onEvent?.({ ...event, message: formatChatProviderError(event.message, settings) });
                    return;
                }
                options.onEvent?.(event);
            },
            signal: options.signal,
        });
    } catch (error: any) {
        if (isAbortError(error)) {
            throw error;
        }
        const wrappedError: any = new Error(formatChatProviderError(error, settings), { cause: error });
        if (error?.partialMessages) {
            wrappedError.partialMessages = error.partialMessages;
        }
        throw wrappedError;
    } finally {
        client.close?.();
    }
}
