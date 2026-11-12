/**
 * Chat Completions API orchestrator
 * 使用 OpenAI Chat Completions 协议
 * 支持完整的 LLM 调用循环
 */

import crypto from "node:crypto";
import OpenAI from "openai";
import type { UIEvent } from "../events/ui-events.js";
import type { SteerUpdate, StreamDelta } from "../types/chat.js";
import { toUserContent, type UserContent, type UserMessageInput } from "../types/image.js";
import type { ChatMessage } from "../types/session.js";
import { type ToolCall } from "../types/tool-call.js";
import { uploadDeepSeekFile, uploadDeepSeekFileData } from "../utils/image-assets.js";
import { type LLMRequestKind } from "../utils/logger.js";
import { getOpenAIProxyFetch } from "../utils/proxy.js";
import { isGptModel } from "../utils/responses-transport.js";
import { resolveProtocol } from "./orchestrator/request-builder.js";
import { collectChatStream } from "./orchestrator/chat-stream.js";
import { collectResponsesStream } from "./orchestrator/responses-stream.js";
import { acquireResponsesSession } from "./orchestrator/responses-session.js";
import { runToolBatch, type ToolBatchOutcome } from "./orchestrator/tool-loop.js";
import { truncateAssistantToolCalls } from "./orchestrator/tool-order.js";
import { runTurnLoop, type TurnContext } from "./orchestrator/turn-loop.js";
import type { ImageInputCapability } from "./orchestrator/image-input.js";
import { type ToolExecutionResponse } from "./tool-interface.js";
import { createUlid } from "../utils/ulid.js";

/** 差分基准的会话上限，超出后按插入序淘汰最老的一条。 */
const ACCUMULATED_USAGE_BASELINE_MAX = 512;

/** 每个会话上一次读到的「上游累计 token」，用于把累计值差分成本请求新增。 */
const accumulatedUsageBaseline = new Map<string, number>();

/**
 * 上游是否只给「会话累计」token：网关（llm-deepseek-web）用 x_usage_source 标注，
 * 该值是随会话单调增长的累计量（含新增输入），不是本请求的生成量。
 */
/**
 * 把上游累计值差分成本请求新增（本请求 = 本次累计 − 上次累计）。
 * 累计回退（上游会话重建、网关重启）时无法差分，退回本次累计本身。
 */
function deltaOfAccumulatedUsage(sessionId: string | undefined, accumulated: number): number {
  if (!sessionId || accumulated <= 0) return accumulated;

  const baseline = accumulatedUsageBaseline.get(sessionId);
  accumulatedUsageBaseline.set(sessionId, accumulated);
  if (accumulatedUsageBaseline.size > ACCUMULATED_USAGE_BASELINE_MAX) {
    const oldest = accumulatedUsageBaseline.keys().next().value;
    if (oldest !== undefined) accumulatedUsageBaseline.delete(oldest);
  }

  if (baseline === undefined || accumulated <= baseline) return accumulated;
  return accumulated - baseline;
}


export function isAbortError(error: any): boolean {
  return error?.name === "AbortError" ||
    error?.name === "APIUserAbortError" ||
    error?.message === "Request was aborted." ||
    error?.message?.includes("abort");
}

/** 协议传输开关：来自 provider 配置，省略时按模型名启发式。 */
export interface ChatTransportOptions {
  /** Responses 是否走 WebSocket。 */
  websocket?: boolean;
  /** Responses 是否请求上游保存。 */
  store?: boolean;
  /** Chat Completions 是否允许 `input_audio`。 */
  audioInput?: boolean;
}

// Chat Completions API 客户端
export interface ChatClient {
  imageCacheScope?: string;
  baseURL: string;
  protocol?: "responses" | "chat_completions";
  transport?: ChatTransportOptions;
  create(params: any, options?: any): Promise<any>;
  createResponse?(params: any, options?: any): Promise<any>;
  preconnect?(): void;
  close?(): void;
  uploadFile?(imagePath: string): Promise<{ id: string }>;
  uploadFileData?(data: string, filename: string, mimeType: string): Promise<{ id: string }>;
}

// 创建 Chat Completions 客户端
export function createChatClient(
  apiKey: string,
  baseURL?: string,
  protocol?: "responses" | "chat_completions",
  sessionId?: string,
  model?: string,
  transport: ChatTransportOptions = {},
): ChatClient {
  const finalURL = baseURL || "https://api.openai.com/v1";
  const normalizedApiKey = apiKey.trim();
  const client = new OpenAI({
    apiKey: normalizedApiKey || "zbot-local-no-auth",
    baseURL: finalURL,
    maxRetries: 0,
    defaultHeaders: {
      Authorization: normalizedApiKey ? undefined : null,
      "x-llm-caller": "zbot",
    },
    fetch: getOpenAIProxyFetch(),
  });
  const cacheSessionId = protocol === "responses" ? sessionId : undefined;
  const responsesSession = acquireResponsesSession(client, !!normalizedApiKey, cacheSessionId);
  return {
    baseURL: finalURL,
    imageCacheScope: crypto.createHash("sha256").update(normalizedApiKey).digest("hex"),
    protocol,
    transport,
    async create(params, options) {
      // 对于需要完整路径的 API（如 DashScope），直接调用 chat.completions.create
      // 库会自动添加 /chat/completions
      const response = await client.chat.completions.create(params, options);
      return response;
    },
    async createResponse(params, options) {
      const useWebSocket = transport.websocket ?? isGptModel(params.model);
      return responsesSession.session.create(params, options?.signal, options?.onSteerAccepted, useWebSocket, options?.onSteerUpdate);
    },
    close() { responsesSession.release(); },
    preconnect() {
      if (protocol === "responses" && (transport.websocket ?? isGptModel(model))) responsesSession.session.preconnect();
    },
    async uploadFile(imagePath: string) {
      const fileID = await uploadDeepSeekFile(imagePath, {
        apiKey: normalizedApiKey,
      });
      return { id: fileID };
    },
    async uploadFileData(data: string, filename: string, mimeType: string) {
      const fileID = await uploadDeepSeekFileData(data, filename, mimeType, {
        apiKey: normalizedApiKey,
      });
      return { id: fileID };
    },
  };
}

export interface OrchestratorOptions {
  query: string;
  queryContent?: UserContent;
  client: ChatClient;
  model: string;
  /** 接入端图片能力（来自 provider 配置）：收不了时把图片块降级成文本。 */
  imageInput?: ImageInputCapability;
  reasoningEffort?: string;
  reasoningEfforts?: string[];
  toolChoice?: "auto" | "none";
  tools?: any[];
  /** 托管工具类型（Responses 专用，来自 OPENAI_RESPONSES_HOSTED_TOOLS）：声明给上游执行，本地没有对应实现。 */
  hostedTools?: string[];
  // 执行工具的函数
  executeTool?: (name: string, args: any) => Promise<ToolExecutionResponse>;
  // 获取系统提示词
  getSystemPrompt?: () => string;
  // 获取工具定义
  getToolDefinitions?: () => any[];
  /** 是否使用 Chat Completions 流式响应。 */
  stream?: boolean;
  onToolCall?: (name: string, args: any, mode: 'serial' | 'parallel') => void;
  onToolResult?: (name: string, result: string) => void;
  onAssistantToolCallContent?: (content: string) => Promise<void> | void;
  onInvalidAssistantHistory?: () => void;
  onProgress?: (text: string) => void;
  // 统一渲染事件流（流式增量 + 执行阶段 + 收尾），与 onToolCall 等回调并存
  onEvent?: (event: UIEvent) => void | Promise<void>;
  // 历史消息
  history?: ChatMessage[];
  // 会话标识，仅 zbot 对话请求提供
  sessionId?: string;
  contextEpochId?: string;
  initialRequestKind?: Exclude<LLMRequestKind, 'tool_response'>;
  /** 消费执行期间累积的 pending 消息（组合成一条附加到后续请求） */
  consumePendingMessages?: () => Array<string | UserMessageInput> | undefined;
  onConsumePending?: (text: string, messages: Array<string | UserMessageInput>) => void | Promise<void>;
  onSteerUpdate?: (update: SteerUpdate) => Promise<void>;
  /** 后续工具轮次发请求前，可替换仅用于请求的上下文；完整本轮消息仍单独保留。 */
  compactMessagesIfNeeded?: (messages: ChatMessage[], lastPromptTokens?: number, providerMaxTokens?: number) => Promise<ChatMessage[] | undefined>;
  /** 每轮请求前返回仅用于本次请求的提醒消息（不落盘、不进历史），用于任务清单等状态回环。 */
  getContextReminders?: () => string[] | undefined;
  /** 回合内每条完整消息定稿时的落盘回调（串行调用）。 */
  onTurnMessage?: (message: ChatMessage) => void | Promise<void>;
  onStreamDelta?: (delta: StreamDelta, requestIndex: number) => Promise<void>;
  /** 续跑：不把 query 作为 user 消息插入（历史尾部已是待续上下文，上游无感）。 */
  skipUserQuery?: boolean;
  /** 续跑：进入循环前先执行的工具调用（补齐中断时缺结果的调用）。 */
  pendingToolCalls?: ToolCall[];
  // 中止信号
  signal?: AbortSignal;
}

export interface ChatExecutionResult {
  content: string;
  toolCalls?: number;
  messages: ChatMessage[];
}

/**
 * 执行 Chat Completions API 工具调用
 * 支持完整的 LLM 调用循环
 */
export async function executeWithChat(
  options: OrchestratorOptions,
): Promise<ChatExecutionResult> {
  const {
    query,
    queryContent,
    client,
    model,
    imageInput,
    tools = [],
    hostedTools,
    toolChoice,
    executeTool,
    getSystemPrompt,
    getToolDefinitions,
    stream = false,
    onToolCall,
    onToolResult,
    onAssistantToolCallContent,
    onEvent,
    history = [],
    sessionId,
    contextEpochId,
    initialRequestKind = "user_request",
    consumePendingMessages,
    onConsumePending,
    onSteerUpdate,
    compactMessagesIfNeeded,
    getContextReminders,
    onTurnMessage,
    onStreamDelta,
    skipUserQuery = false,
    pendingToolCalls,
    signal,
  } = options;

  const effectiveSessionId = sessionId ?? "standalone";

  // ── 消息容器与落盘：turn_message 串行落盘，保证事件顺序与消息顺序一致 ──
  const messages: ChatMessage[] = [];
  const turnMessages: ChatMessage[] = [];
  let persistChain: Promise<void> = Promise.resolve();
  let persistFailure: unknown;
  const persistMessage = (message: ChatMessage): void => {
    if (!onTurnMessage) return;
    // 必须传原对象：run-turn 靠对象身份去重（失败/中断回合按 partialMessages 补写），
    // 这里换成副本会让去重恒为 false 并重复落 turn_message。
    // audioContent 的剔除下沉到唯一落盘口 persistTurnMessage。
    persistChain = persistChain
      .then(() => onTurnMessage(message))
      .catch((error: any) => {
        persistFailure ??= error;
        console.error("⚠️ [Orchestrator] turn_message 落盘失败:", error?.message ?? error);
      });
  };
  /**
   * 定稿消息已不可变，立即分配 id：token 记账与工具结果投影都按 id 缓存，
   * 回合内每轮请求才能只算新增消息。前提是同一个对象只 append 一次
   * （失败/中断回合靠对象身份去重），否则会出现两条同 id 消息。
   */
  const ensureMessageId = (message: ChatMessage): void => {
    if (!("id" in message)) (message as ChatMessage & { id?: string }).id = createUlid();
  };

  const appendTurnMessage = (message: ChatMessage): void => {
    ensureMessageId(message);
    ctx.messages.push(message);
    turnMessages.push(message);
    persistMessage(message);
  };

  // 装配初始上下文
  if (getSystemPrompt) {
    const systemPrompt = getSystemPrompt();
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  }
  messages.push(...history);
  // 续跑时不插入 query：历史尾部已是待续上下文，上游无感
  if (!skipUserQuery) messages.push({ role: "user", content: queryContent ?? query });

  const emit = (event: UIEvent): void => { void onEvent?.(event); };
  let toolIdCounter = 0;

  /** 执行一批工具调用，并把 assistant 消息与工具结果按原顺序入列。 */
  const runToolCalls = async (calls: ToolCall[], assistantMessage?: ChatMessage): Promise<void> => {
    if (calls.length === 0) {
      if (assistantMessage) appendTurnMessage(assistantMessage);
      return;
    }

    const host = {
      ...(executeTool ? { executeTool } : {}),
      ...(onToolCall ? { onToolCall } : {}),
      ...(onToolResult ? { onToolResult } : {}),
      emit,
      nextToolId: () => ++toolIdCounter,
      assertNotAborted: () => {
        if (signal?.aborted) throw new DOMException("User terminated the request", "AbortError");
      },
    };

    let outcome: ToolBatchOutcome | undefined;
    try {
      outcome = await runToolBatch(host, calls);
    } finally {
      // assistant 必须先于工具结果入列。`_order` 链失败后被跳过的调用要从历史里删掉，
      // 否则上游会因 tool_calls 与 tool 结果不成对而拒绝下一次请求；
      // 中止等异常路径拿不到 outcome，此时保留全量调用，交给续跑机制补结果。
      if (assistantMessage) {
        appendTurnMessage(outcome
          ? truncateAssistantToolCalls(assistantMessage, new Set(outcome.results.map(result => result.callId)))
          : assistantMessage);
      }
      for (const result of outcome?.results ?? []) appendTurnMessage(result.message);
    }
  };

  const ctx: TurnContext = {
    client,
    model,
    baseURL: client.baseURL,
    tools,
    ...(signal ? { signal } : {}),
    stream: !!stream,
    sessionId: effectiveSessionId,
    ...(contextEpochId ? { contextEpochId } : {}),
    initialRequestKind,
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.reasoningEfforts ? { reasoningEfforts: options.reasoningEfforts } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    messages,
    turnMessages,
    ...(imageInput ? { imageInput } : {}),
    counters: { emptyResponse: 0, lengthRetry: 0 },
    iteration: 0,
    ...(hostedTools?.length ? { hostedTools } : {}),
    emit,
    appendTurnMessage,
    persistMessage,
    ...(consumePendingMessages ? { consumePendingMessages } : {}),
    ...(onConsumePending ? { onConsumePending } : {}),
    ...(compactMessagesIfNeeded ? { compactMessagesIfNeeded } : {}),
    ...(getToolDefinitions ? { getToolDefinitions } : {}),
    ...(getContextReminders ? { getContextReminders } : {}),
    ...(onAssistantToolCallContent ? { onAssistantToolCallContent } : {}),
    ...(options.onInvalidAssistantHistory ? { onInvalidAssistantHistory: options.onInvalidAssistantHistory } : {}),
    runToolCalls,
    sendRequest: (requestBody: Record<string, any>) => sendProtocolRequest({
      client,
      protocol: resolveProtocol(client),
      requestBody,
      stream: !!stream,
      signal,
      emit,
      ...(onStreamDelta ? { persistDelta: (delta: StreamDelta) => onStreamDelta(delta, ctx.iteration) } : {}),
      onSteerAccepted: async (text: string) => {
        const input = { text, trigger: "pending" as const };
        appendTurnMessage({ role: "user", content: toUserContent(input) });
        await onConsumePending?.(text, [input]);
      },
      onSteerUpdate,
    }),
  };

  try {
    // 续跑：先把中断时缺结果的工具调用补跑完，请求体与中断前一致
    if (pendingToolCalls && pendingToolCalls.length > 0) {
      await runToolCalls(pendingToolCalls);
    }
    return await runTurnLoop(ctx);
  } finally {
    // 回合结束（含中断/报错）前等增量消息落盘完成
    await persistChain;
    if (persistFailure) {
      const error: any = new Error("回合消息落盘失败，请检查会话存储目录", { cause: persistFailure });
      error.partialMessages = turnMessages;
      emit({ type: "error", message: error.message });
      throw error;
    }
  }
}

/**
 * 按协议发起一次请求：流式走聚合器，非流式直接返回原始响应。
 * 协议分派只在这里出现一次，循环里不再判断 useResponses。
 */
async function sendProtocolRequest(input: {
  client: ChatClient;
  protocol: "responses" | "chat_completions";
  requestBody: Record<string, any>;
  stream: boolean;
  signal: AbortSignal | undefined;
  emit: (event: UIEvent) => void;
  persistDelta?: (delta: StreamDelta) => Promise<void>;
  onSteerAccepted?: (input: string) => Promise<void>;
  onSteerUpdate?: (update: SteerUpdate) => Promise<void>;
}): Promise<any> {
  const { client, protocol, requestBody, stream, signal, emit, persistDelta, onSteerAccepted, onSteerUpdate } = input;
  if (protocol === "responses") {
    return stream
      ? collectResponsesResponse(client, requestBody, signal, emit, persistDelta, onSteerAccepted, onSteerUpdate)
      : client.createResponse?.(requestBody, { signal });
  }
  return stream
    ? collectStreamResponse(client, requestBody, signal, emit, persistDelta)
    : client.create(requestBody, { signal });
}

/**
 * 遍历 Chat Completions 流式响应，聚合出与非流式一致的 assistantMsg，并顺带发出渲染事件。
 */
async function collectStreamResponse(
  client: ChatClient,
  requestBody: Record<string, any>,
  signal: AbortSignal | undefined,
  emit: (event: UIEvent) => void,
  persistDelta?: (delta: StreamDelta) => Promise<void>,
): Promise<any> {
  const stream = await client.create(requestBody, { signal });
  const { assistantMsg, usage, model, finishReason } = await collectChatStream(stream, emit, persistDelta);
  return {
    model,
    choices: [{ message: assistantMsg, finish_reason: finishReason }],
    usage,
  };
}

async function collectResponsesResponse(
  client: ChatClient,
  requestBody: Record<string, any>,
  signal: AbortSignal | undefined,
  emit: (event: UIEvent) => void,
  persistDelta?: (delta: StreamDelta) => Promise<void>,
  onSteerAccepted?: (input: string) => Promise<void>,
  onSteerUpdate?: (update: SteerUpdate) => Promise<void>,
): Promise<any> {
  const stream = await client.createResponse?.(requestBody, { signal, onSteerAccepted, onSteerUpdate });
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") return stream;
  return collectResponsesStream(stream, emit, persistDelta);
}
