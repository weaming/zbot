import type { UIEvent } from "../../events/ui-events.js";
import type { StreamDelta } from "../../types/chat.js";
import type { ChatMessage } from "../../types/session.js";
import type { ChatCompletionChunk } from "openai/resources/chat/completions/completions";
import { patchArgumentsJson } from "../../utils/patch-args.js";
import { partialAssistantMessage } from "../../utils/stream-recovery.js";
import { GptTextFilter } from "./gpt-text.js";

interface ChatStreamChunk extends Omit<ChatCompletionChunk, "choices"> {
  x_usage_source?: string;
  choices: Array<Omit<ChatCompletionChunk.Choice, "delta"> & {
    delta: ChatCompletionChunk.Choice.Delta & {
      reasoning_content?: string;
      tool_calls?: Array<ChatCompletionChunk.Choice.Delta.ToolCall & {
        type?: string;
        custom?: { name?: string; input?: string };
        thought_signature?: string;
        thoughtSignature?: string;
      }>;
    };
  }>;
}

/** 工具调用的展示/落盘参数：custom 工具把裸文本重新包成 {"patch": ...}，与历史消息同形。 */
function toolCallArgsJson(kind: "function" | "custom", argumentsText: string): string {
  return kind === "custom" ? patchArgumentsJson(argumentsText) : argumentsText;
}

function withPartialMessage(error: unknown, message: ChatMessage | undefined): unknown {
  if (!message) return error;
  const wrapped = error && typeof error === "object" ? error : new Error(String(error));
  (wrapped as { partialMessage?: ChatMessage }).partialMessage = message;
  return wrapped;
}

/** 将 Chat Completions 数据块聚合为内部消息，并发出界面事件。 */
export async function collectChatStream(
  stream: AsyncIterable<ChatStreamChunk>,
  emit: (event: UIEvent) => void,
  persistDelta?: (delta: StreamDelta) => Promise<void>,
  requestModel?: string,
): Promise<{ assistantMsg: any; usage: any; model: string; finishReason: string }> {
  const textFilter = new GptTextFilter(requestModel);
  let content = "";
  let reasoningContent = "";
  const finishText = async (): Promise<void> => {
    const text = textFilter.finish();
    if (!text) return;
    await persistDelta?.({ text });
    content += text;
    emit({ type: "text_delta", delta: text });
  };
  const toolCalls = new Map<number, {
    id: string;
    name: string;
    arguments: string;
    kind: "function" | "custom";
    thoughtSignature?: string;
  }>();
  let usage: any;
  let model = "";
  let finishReason = "";
  // 无 index 的 tool_call（非标准流或 mock）按出现顺序分配
  let toolCallCursor = 0;

  try {
    for await (const chunk of stream) {
      if (chunk.model) model = chunk.model;
      // usage 与 x_usage_source 同帧下发（网关收尾帧），一起留住以便判定口径
      if (chunk.usage) usage = chunk.usage;
      if (chunk.x_usage_source) usage = { ...(usage ?? {}), x_usage_source: chunk.x_usage_source };

      const choice = chunk.choices?.[0];
      const delta = choice?.delta ?? {};
      const text = textFilter.push(delta.content ?? "");
      // Chat chunk 没有与 Responses 相同的事件 type；正文、reasoning 和工具参数可同帧出现。
      const toolDeltas = (delta.tool_calls ?? []).map((call: any) => ({
        ...call,
        index: call.index ?? toolCallCursor++,
      }));
      // custom 的增量续片不一定重复带 type：按字段存在与否取值，才能拼出完整补丁
      const toolDeltaName = (call: any) => call?.custom?.name ?? call?.function?.name;
      const toolDeltaArgs = (call: any) => call?.custom?.input ?? call?.function?.arguments;
      const streamDelta: StreamDelta = {
        ...(text ? { text } : {}),
        ...(delta.reasoning_content ? { reasoning: delta.reasoning_content } : {}),
        ...(toolDeltas.length > 0 ? { toolCalls: toolDeltas.map((call: any) => ({
          index: call.index,
          ...(call.id ? { id: call.id } : {}),
          ...(toolDeltaName(call) ? { name: toolDeltaName(call) } : {}),
          ...(toolDeltaArgs(call) ? { arguments: toolDeltaArgs(call) } : {}),
          ...((call.thought_signature ?? call.thoughtSignature)
            ? { thoughtSignature: call.thought_signature ?? call.thoughtSignature }
            : {}),
        })) } : {}),
      };
      if (streamDelta.text || streamDelta.reasoning || streamDelta.toolCalls?.length) {
        await persistDelta?.(streamDelta);
      }

      if (text) {
        content += text;
        emit({ type: "text_delta", delta: text });
      }
      if (delta.reasoning_content) {
        reasoningContent += delta.reasoning_content;
        emit({ type: "reasoning_delta", delta: delta.reasoning_content });
      }
      if (toolDeltas.length > 0) {
        for (const tc of toolDeltas) {
          const index = tc.index;
          let slot = toolCalls.get(index);
          if (!slot) {
            slot = {
              id: "",
              name: "",
              arguments: "",
              kind: tc.type === "custom" || tc.custom ? "custom" : "function",
            };
            toolCalls.set(index, slot);
          }
          if (tc.id) slot.id = tc.id;
          const thoughtSignature = tc.thought_signature ?? tc.thoughtSignature;
          if (thoughtSignature) slot.thoughtSignature = thoughtSignature;
          const name = toolDeltaName(tc);
          const argsDelta = toolDeltaArgs(tc);
          if (name) {
            slot.name = name;
            emit({ type: "toolcall_start", index, id: slot.id, name: slot.name });
          }
          if (argsDelta) {
            slot.arguments += argsDelta;
            emit({ type: "toolcall_args_delta", index, delta: argsDelta });
          }
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
  } catch (error) {
    await finishText();
    throw withPartialMessage(error, partialAssistantMessage(content, reasoningContent, [...toolCalls.values()]));
  }

  await finishText();

  for (const [index, slot] of toolCalls) {
    emit({
      type: "toolcall_end",
      index,
      id: slot.id,
      name: slot.name,
      argsJson: toolCallArgsJson(slot.kind, slot.arguments),
    });
  }

  const assistantMsg: any = { role: "assistant", content: content || null };
  if (reasoningContent) assistantMsg.reasoning_content = reasoningContent;
  if (toolCalls.size > 0) {
    assistantMsg.tool_calls = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, slot]) => ({
        id: slot.id || `call_${crypto.randomUUID().slice(0, 8)}`,
        ...(slot.kind === "custom"
          ? { type: "custom", custom: { name: slot.name, input: slot.arguments } }
          : { type: "function", function: { name: slot.name, arguments: slot.arguments } }),
        ...(slot.thoughtSignature ? { thought_signature: slot.thoughtSignature } : {}),
      }));
  }
  return { assistantMsg, usage, model, finishReason };
}
