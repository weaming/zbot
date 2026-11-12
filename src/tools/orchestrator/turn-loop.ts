/**
 * 回合主循环：准备一轮 → 决策 → 执行工具 → 下一轮，直到终态。
 *
 * 所有可变状态都在 TurnContext 里显式声明，不再散落成闭包变量：
 * 这样「这一轮用的是什么」可以直接从 ctx 读出来，测试也能只替换需要的那部分。
 */

import { endpointHost } from "../../pricing/deepseek.js";
import { recordLLMExchange } from "../../utils/logger.js";
import type { UIEvent } from "../../events/ui-events.js";
import type { UsageInfo } from "../../types/chat.js";
import type { ChatMessage } from "../../types/session.js";
import type { ToolCall } from "../../types/tool-call.js";
import { fromOpenAIToolCalls } from "../../types/tool-call.js";
import { normalizeToolDefinitionsForDeepSeek } from "../tool-schema.js";
import { toUserContent, type UserMessageInput } from "../../types/image.js";
import { normalizeResponsesResponse } from "./responses-output.js";
import { decideNext, nextCounters, EMPTY_RESPONSE_RETRY_PROMPT } from "./decide.js";
import { buildUsageStats, toUsageInfo } from "./usage.js";
import { isDeepSeekStyle, prepareRequest } from "./turn-request.js";
import type { ImageInputCapability } from "./image-input.js";
import type { LLMRequestKind } from "../../utils/logger.js";
import { getPromptTooLongLimit, isInvalidAssistantMessageError } from "../../utils/provider-context-limit.js";
import { filterEmptyAssistantMessages } from "../../utils/conversation-history-repair.js";
import { extractCitations } from "./citations.js";

/** 每轮请求的协议与客户端形状。 */
interface TurnClient {
  baseURL: string;
  protocol?: "responses" | "chat_completions";
  create(params: any, options?: any): Promise<any>;
  createResponse?(params: any, options?: any): Promise<any>;
}

type EmitFn = (event: UIEvent) => void;

export interface TurnContext {
  client: TurnClient;
  model: string;
  baseURL: string;
  /** 接入端图片能力（来自 provider 配置）：收不了时把图片块降级成文本。 */
  imageInput?: ImageInputCapability;
  tools: any[];
  signal?: AbortSignal;
  stream: boolean;
  sessionId: string;
  contextEpochId?: string;
  initialRequestKind: Exclude<LLMRequestKind, "tool_response">;
  reasoningEffort?: string;
  reasoningEfforts?: string[];
  toolChoice?: "auto" | "none";
  /** 托管工具类型（Responses 专用，来自 OPENAI_RESPONSES_HOSTED_TOOLS）：上游执行，本地不执行。 */
  hostedTools?: string[];

  // 消息与状态（就地修改）
  messages: ChatMessage[];
  turnMessages: ChatMessage[];
  counters: { emptyResponse: number; lengthRetry: number };
  iteration: number;

  // 回调
  emit: EmitFn;
  appendTurnMessage(message: ChatMessage): void;
  persistMessage(message: ChatMessage): void;
  consumePendingMessages?(): Array<string | UserMessageInput> | undefined;
  onConsumePending?(text: string, messages: Array<string | UserMessageInput>): void | Promise<void>;
  compactMessagesIfNeeded?(messages: ChatMessage[], lastPromptTokens?: number, providerMaxTokens?: number): Promise<ChatMessage[] | undefined>;
  getToolDefinitions?(): any[];
  getContextReminders?(): string[] | undefined;
  onAssistantToolCallContent?(content: string): Promise<void> | void;
  onInvalidAssistantHistory?(): void;
  /**
   * 执行一批工具调用（含 `_order` 编排），由调用方实现。
   * 入列责任也在这里：传 assistantMessage 是为了在串行链中断时按实际执行集合裁剪历史。
   */
  runToolCalls(calls: ToolCall[], assistantMessage?: ChatMessage): Promise<void>;
  /** 单轮请求：发请求并归一化。 */
  sendRequest(requestBody: Record<string, any>): Promise<any>;
}

/** finish_reason 必须归一成稳定字符串，未知一律 unknown。 */
function normalizeFinishReason(value: unknown): string {
  return typeof value === "string" && value ? value : "unknown";
}

/** 从 assistant 消息取正文。 */
function extractText(message: any): string | null {
  return message?.content || null;
}

/** 派生上层可展示的错误（携带 finishReason）。 */
function providerError(finishReason: string, message: string): Error {
  const error = new Error(message);
  (error as any).finishReason = finishReason;
  return error;
}

function isAbortError(error: any): boolean {
  return error?.name === "AbortError" || error?.name === "APIUserAbortError";
}

export interface TurnLoopResult {
  content: string;
  toolCalls: number;
  messages: ChatMessage[];
}

/**
 * 跑完一个回合。返回值与异常语义：
 * - 正常结束：content 为最终文本（可能为空）
 * - 中止：抛出 AbortError，并先发出 aborted 事件
 * - 其他失败：抛出原错误，并先发出 error 事件
 * 无论哪种结局，partialMessages 都挂上已产生的消息，供上层落盘。
 */
export async function runTurnLoop(ctx: TurnContext): Promise<TurnLoopResult> {
  let finalContent = "";
  let lastFinishReason = "stop";
  let lastUsageInfo: UsageInfo | undefined;
  let turnReasoning = "";
  const recordAttempt = (message: ChatMessage): void => {
    ctx.turnMessages.push(message);
    ctx.persistMessage(message);
  };
  const consumePending = async (): Promise<boolean> => {
    if (!ctx.consumePendingMessages) return false;
    const pending = ctx.consumePendingMessages();
    if (!pending?.length) return false;

    const pendingInputs = pending.map(input => typeof input === "string" ? { text: input } : input);
    const pendingInput: UserMessageInput = {
      text: pendingInputs.map(input => input.text).join("\n"),
      images: pendingInputs.flatMap(input => input.images ?? []),
    };
    ctx.appendTurnMessage({ role: "user", content: toUserContent(pendingInput) });
    await ctx.onConsumePending?.(pendingInput.text, pending);
    return true;
  };

  try {
    while (true) {
      if (ctx.iteration > 0) ctx.emit({ type: "turn_end", iteration: ctx.iteration });
      ctx.iteration += 1;
      ctx.emit({ type: "turn_start", iteration: ctx.iteration });

      if (ctx.signal?.aborted) throw new DOMException("User terminated the request", "AbortError");

      // 消费执行期间新进入的 pending 消息并注入本轮后续请求
      if (ctx.iteration > 1 || ctx.initialRequestKind === "turn_resume") await consumePending();

      if (ctx.iteration > 1 && ctx.compactMessagesIfNeeded) {
        const compacted = await ctx.compactMessagesIfNeeded(ctx.messages, lastUsageInfo?.promptTokens);
        if (compacted) ctx.messages = compacted;
      }

      const prepareCurrentRequest = () => prepareRequest({
        client: ctx.client,
        model: ctx.model,
        ...(ctx.imageInput ? { imageInput: ctx.imageInput } : {}),
        messages: ctx.messages,
        tools: ctx.tools,
        ...(ctx.getToolDefinitions ? { getToolDefinitions: ctx.getToolDefinitions } : {}),
        ...(ctx.hostedTools?.length ? { hostedTools: ctx.hostedTools } : {}),
        ...(ctx.toolChoice ? { toolChoice: ctx.toolChoice } : {}),
        ...(ctx.getContextReminders ? { getContextReminders: ctx.getContextReminders } : {}),
        normalizedTools: (list: any[]) => (isDeepSeekStyle(ctx.model, ctx.client.baseURL)
          ? normalizeToolDefinitionsForDeepSeek(list)
          : list),
        isFirstIteration: ctx.iteration === 1,
        stream: ctx.stream,
        ...(ctx.reasoningEffort ? { reasoningEffort: ctx.reasoningEffort } : {}),
        ...(ctx.reasoningEfforts ? { reasoningEfforts: ctx.reasoningEfforts } : {}),
      });
      let prepared = await prepareCurrentRequest();

      let requestStartedAt = Date.now();
      let response: any;
      let hasCompactedAfterOverflow = false;
      let hasRetriedInvalidAssistant = false;
      while (true) {
        if (prepared.protocol === "chat_completions") {
          recordLLMExchange("REQUEST", prepared.requestBody, { sessionId: ctx.sessionId });
        }
        requestStartedAt = Date.now();
        try {
          response = await ctx.sendRequest(prepared.requestBody);
          break;
        } catch (error) {
          if (prepared.protocol === "chat_completions" && !hasRetriedInvalidAssistant
            && isInvalidAssistantMessageError(error)) {
            const repairedMessages = filterEmptyAssistantMessages(ctx.messages);
            if (repairedMessages.length < ctx.messages.length) {
              if (ctx.signal?.aborted) throw new DOMException("User terminated the request", "AbortError");
              hasRetriedInvalidAssistant = true;
              ctx.messages = repairedMessages;
              ctx.onInvalidAssistantHistory?.();
              prepared = await prepareCurrentRequest();
              continue;
            }
          }
          const providerMaxTokens = getPromptTooLongLimit(error);
          if (!providerMaxTokens || hasCompactedAfterOverflow || !ctx.compactMessagesIfNeeded) throw error;
          hasCompactedAfterOverflow = true;
          const compacted = await ctx.compactMessagesIfNeeded(ctx.messages, lastUsageInfo?.promptTokens, providerMaxTokens);
          if (!compacted) throw error;
          if (ctx.signal?.aborted) throw new DOMException("User terminated the request", "AbortError");
          ctx.messages = compacted;
          prepared = await prepareCurrentRequest();
        }
      }
      const normalized = prepared.protocol === "responses" ? normalizeResponsesResponse(response) : response;
      const assistantMsg = normalized.choices?.[0]?.message;
      lastFinishReason = normalizeFinishReason(normalized.choices?.[0]?.finish_reason);

      lastUsageInfo = toUsageInfo({
        model: normalized.model || ctx.model,
        usage: normalized.usage,
        durationMs: Date.now() - requestStartedAt,
        apiHost: endpointHost(ctx.client.baseURL),
        sessionId: ctx.sessionId,
        outputText: typeof assistantMsg?.content === "string" ? assistantMsg.content : "",
        reasoningText: typeof assistantMsg?.reasoning_content === "string" ? assistantMsg.reasoning_content : "",
      });

      lastUsageInfo.latestPromptTokens = lastUsageInfo.promptTokens;

      if (prepared.protocol === "chat_completions") {
        const usageEntry = buildUsageStats({
          model: ctx.model,
          requestBody: prepared.requestBody,
          response: normalized,
          requestStartedAt,
          requestKind: ctx.iteration === 1 ? ctx.initialRequestKind : "tool_response",
          sessionId: ctx.sessionId,
          ...(ctx.contextEpochId ? { contextEpochId: ctx.contextEpochId } : {}),
          normalized: lastUsageInfo,
        });
        recordLLMExchange("RESPONSE", response, { sessionId: ctx.sessionId, usage: usageEntry });
      }
      ctx.emit({ type: "usage", usage: lastUsageInfo });

      if (!assistantMsg) {
        throw new Error(`${prepared.protocol === "responses" ? "Responses" : "Chat Completions"} 响应格式无效`);
      }

      // MiniMax reasoning_split=True 时把 reasoning_details 也存进历史，保证思维链连续
      const messageToStore = { ...assistantMsg };
      if (prepared.isMiniMax && assistantMsg.reasoning_details) {
        messageToStore.reasoning_details = assistantMsg.reasoning_details;
      }
      // 托管工具的引用来源随消息落盘：重放与实时都按同一份数据渲染
      const citations = extractCitations(assistantMsg);
      if (citations.length > 0) messageToStore.citations = citations;

      const reasoning = typeof assistantMsg.reasoning_content === "string"
        ? assistantMsg.reasoning_content
        : (typeof assistantMsg.reasoning === "string" ? assistantMsg.reasoning : "");
      // 本回合可能多轮 LLM 调用：reasoning 需累计，与 projector/replay 的合并语义一致
      turnReasoning += reasoning;

      const toolCalls = fromOpenAIToolCalls(assistantMsg.tool_calls);

      const decision = decideNext({
        finishReason: lastFinishReason,
        content: extractText(assistantMsg)?.trim() || "",
        toolCallCount: toolCalls.length,
        counters: ctx.counters,
      });

      if (decision.kind === "fail") {
        if (messageToStore.content || reasoning || toolCalls.length > 0) {
          const callText = toolCalls.map(call =>
            `[未执行的工具调用：${call.name} ${call.rawArgs}]`).join("\n");
          ctx.appendTurnMessage(callText
            ? { role: "assistant", content: [messageToStore.content, callText].filter(Boolean).join("\n\n"),
                ...(reasoning ? { reasoning_content: reasoning } : {}) }
            : messageToStore);
        }
        throw providerError(decision.reason === "content_filter" ? "content_filter" : "error", decision.message);
      }

      ctx.counters = nextCounters(ctx.counters, decision);

      if (decision.kind === "retry_length") {
        if (messageToStore.content || reasoning) recordAttempt(messageToStore);
        continue;
      }

      if (decision.kind === "retry_empty") {
        // 原请求保持不变；已生成的思考留在完整历史，首次重试追加提示。
        if (reasoning) recordAttempt(messageToStore);
        if (decision.appendPrompt) {
          ctx.appendTurnMessage({ role: "user", content: EMPTY_RESPONSE_RETRY_PROMPT });
        }
        continue;
      }

      if (decision.kind === "done") {
        if (decision.content || reasoning) ctx.appendTurnMessage(messageToStore);
        // 最后一条响应也可能与用户输入并发到达；把新消息接在当前上下文后继续，
        // 不要等续跑回合结束后才另开一轮。
        if (await consumePending()) continue;
        if (citations.length > 0) ctx.emit({ type: "citations", items: citations });
        finalContent = decision.content;
        break;
      }

      if (citations.length > 0) ctx.emit({ type: "citations", items: citations });

      const toolCallResponseContent = extractText(assistantMsg)?.trim();
      if (toolCallResponseContent) {
        await ctx.onAssistantToolCallContent?.(toolCallResponseContent);
        ctx.emit({ type: "assistant_text_before_tools", content: toolCallResponseContent });
      }

      // assistant 消息的入列交给 runToolCalls：`_order` 串行链中断时要按实际执行集合裁剪
      await ctx.runToolCalls(toolCalls, messageToStore);

      if (ctx.signal?.aborted) throw new DOMException("User terminated the request", "AbortError");
    }

    ctx.emit({ type: "turn_end", iteration: ctx.iteration });
    ctx.emit({
      type: "message_end",
      content: finalContent,
      stopReason: lastFinishReason,
      usage: lastUsageInfo,
      reasoning: turnReasoning || undefined,
    });

    return { content: finalContent, toolCalls: ctx.iteration, messages: ctx.turnMessages };
  } catch (error: any) {
    if (error?.partialMessage) ctx.appendTurnMessage(error.partialMessage);
    if (error && typeof error === "object") error.partialMessages = ctx.turnMessages;

    if (isAbortError(error)) {
      // 与重放侧 turn_commit.stopReason 同口径，避免实时与重放措辞漂移
      ctx.emit({ type: "aborted", stopReason: "aborted" });
      throw error;
    }
    ctx.emit({ type: "error", message: error.message ?? String(error) });
    throw error;
  }
}
