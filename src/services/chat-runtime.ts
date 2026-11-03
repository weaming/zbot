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
    apiKey: string;
    apiBase: string;
    model: string;
    protocol?: ChatApiProtocol;
    reasoningEffort?: string;
    reasoningEfforts?: string[];
    /** 托管工具类型（OPENAI_RESPONSES_HOSTED_TOOLS）：由上游执行，本地不执行。 */
    hostedTools: string[];
    /** ENABLE_DS_COST_STAT：开启后非官方端点（局域网网关）也按官方价格表估算费用。 */
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

function getDefaultChatModelOption(): ChatModelOption | undefined {
    if (defaultModelOption !== undefined) return defaultModelOption ?? undefined;
    try {
        const value = JSON.parse(fs.readFileSync(getModelPreferencesFile(), "utf8")) as Partial<ChatModelOption>;
        if (
            (value.protocol === "responses" || value.protocol === "chat_completions")
            && typeof value.model === "string"
            && value.model.trim()
        ) {
            defaultModelOption = {
                protocol: value.protocol,
                model: value.model.trim(),
                ...(typeof value.reasoningEffort === "string" ? { reasoningEffort: value.reasoningEffort } : {}),
            };
            return defaultModelOption;
        }
    } catch {
        // 缺失或损坏的偏好文件使用环境变量默认值。
    }
    defaultModelOption = null;
    return undefined;
}

export async function setDefaultChatModelOption(option: ChatModelOption): Promise<void> {
    if (!getChatModelOptions().some(candidate =>
        candidate.protocol === option.protocol && candidate.model === option.model,
    )) {
        throw new Error(`模型配置不存在：${option.protocol} · ${option.model}`);
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
    const baseName = settings.protocol === "responses"
        ? "OPENAI_RESPONSES_BASE_URL"
        : settings.protocol === "chat_completions"
            ? "OPENAI_CHAT_BASE_URL"
            : "OPENAI_BASE_URL";

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
        const keyName = settings.protocol === "responses"
            ? "OPENAI_RESPONSES_API_KEY"
            : "OPENAI_CHAT_API_KEY";
        return `缺少 ${keyName} 或 OPENAI_API_KEY（本地或局域网服务可省略）`;
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
        const keyName = currentSettings.protocol === "responses"
            ? "OPENAI_RESPONSES_API_KEY"
            : "OPENAI_CHAT_API_KEY";
        return `LLM provider 请求失败（HTTP ${status}）：认证失败，请检查 ${keyName} 或 OPENAI_API_KEY。`;
    }

    if (status === 429) {
        return `LLM provider 请求失败（HTTP 429）：provider 已限流或额度已用尽。${message}`;
    }

    if (status !== undefined && status >= 400) {
        return `LLM provider 请求失败（HTTP ${status}）：${message}`;
    }

    if (message.includes("fetch failed") || message.includes("ECONNREFUSED")) {
        const baseName = currentSettings.protocol === "responses"
            ? "OPENAI_RESPONSES_BASE_URL"
            : "OPENAI_CHAT_BASE_URL";
        return `LLM provider 请求失败：无法连接 ${currentSettings.apiBase}，请检查 ${baseName} 或 OPENAI_BASE_URL 和网络代理。`;
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

export function getChatApiSettings(sessionSelection?: ChatModelSelection): ChatApiSettings {
    const legacyModel = process.env.OPENAI_MODEL || "";
    const responsesModel = process.env.OPENAI_RESPONSES_MODEL || "";
    const chatModel = process.env.OPENAI_CHAT_MODEL || "";
    const hasResponsesSettings = [
        process.env.OPENAI_RESPONSES_API_KEY,
        process.env.OPENAI_RESPONSES_BASE_URL,
        responsesModel,
        process.env.OPENAI_RESPONSES_MODELS,
    ].some(value => value?.trim());
    const hasChatSettings = [
        process.env.OPENAI_CHAT_API_KEY,
        process.env.OPENAI_CHAT_BASE_URL,
        chatModel,
        process.env.OPENAI_CHAT_MODELS,
    ].some(value => value?.trim());
    let protocol: ChatApiProtocol;
    if (hasResponsesSettings && !hasChatSettings) {
        protocol = "responses";
    } else if (hasChatSettings && !hasResponsesSettings) {
        protocol = "chat_completions";
    } else {
        protocol = "chat_completions";
    }
    const profileModel = protocol === "responses"
        ? responsesModel || parseCommaList(process.env.OPENAI_RESPONSES_MODELS)[0] || ""
        : chatModel || parseCommaList(process.env.OPENAI_CHAT_MODELS)[0] || "";
    const requestedOption = sessionSelection ?? getDefaultChatModelOption();
    const activeOption = requestedOption && getChatModelOptions().some(option =>
        option.protocol === requestedOption.protocol && option.model === requestedOption.model,
    ) ? requestedOption : undefined;
    const activeProtocol = activeOption?.protocol ?? protocol;
    const activeProfileApiKey = activeProtocol === "responses"
        ? process.env.OPENAI_RESPONSES_API_KEY
        : process.env.OPENAI_CHAT_API_KEY;
    const activeProfileApiBase = activeProtocol === "responses"
        ? process.env.OPENAI_RESPONSES_BASE_URL
        : process.env.OPENAI_CHAT_BASE_URL;
    const configuredEfforts = parseCommaList(activeProtocol === "responses"
        ? process.env.OPENAI_RESPONSES_EFFORTS
        : process.env.OPENAI_CHAT_EFFORTS);

    return {
        apiKey: activeProfileApiKey || process.env.OPENAI_API_KEY || "",
        apiBase: activeProfileApiBase || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        model: activeOption?.model || profileModel || legacyModel,
        protocol: activeProtocol,
        reasoningEffort: activeOption?.reasoningEffort,
        reasoningEfforts: configuredEfforts.length > 0 ? configuredEfforts : undefined,
        hostedTools: parseCommaList(process.env.OPENAI_RESPONSES_HOSTED_TOOLS),
        enableCostStat: isDeepSeekCostStatEnabled(),
    };
}

/** 逗号分隔配置值 → 去重后的列表（模型名、托管工具类型共用）。 */
function parseCommaList(value?: string): string[] {
    return [...new Set((value || "").split(",").map(item => item.trim()).filter(Boolean))];
}

function profileHasSettings(protocol: ChatApiProtocol): boolean {
    const prefix = protocol === "responses" ? "OPENAI_RESPONSES" : "OPENAI_CHAT";
    return [
        process.env[`${prefix}_API_KEY`],
        process.env[`${prefix}_BASE_URL`],
        process.env[`${prefix}_MODEL`],
        process.env[`${prefix}_MODELS`],
    ].some(value => value?.trim());
}

export function getChatModelOptions(): ChatModelOption[] {
    const legacyModel = process.env.OPENAI_MODEL?.trim() || "";
    const configuredProtocols = (['responses', 'chat_completions'] as const)
        .filter(protocol => profileHasSettings(protocol));
    const legacyProtocol: ChatApiProtocol = "chat_completions";
    const protocols = new Set<ChatApiProtocol>(configuredProtocols);
    if (legacyModel && !configuredProtocols.includes(legacyProtocol)) protocols.add(legacyProtocol);

    const options: ChatModelOption[] = [];
    for (const protocol of protocols) {
        const prefix = protocol === "responses" ? "OPENAI_RESPONSES" : "OPENAI_CHAT";
        const models = [
            process.env[`${prefix}_MODEL`],
            ...parseCommaList(process.env[`${prefix}_MODELS`]),
            ...(protocol === legacyProtocol ? [legacyModel] : []),
        ].map(model => model?.trim()).filter((model): model is string => Boolean(model));
        for (const model of new Set(models)) options.push({ protocol, model });
    }

    return options;
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

    const client = createChatClient(settings.apiKey, settings.apiBase, settings.protocol, options.sessionId, settings.model);
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
                    : supportsAudioInput(settings.model, client.baseURL) ? undefined : "endpoint";
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
