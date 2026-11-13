import type { UIEvent } from "../../events/ui-events.js";
import type { ResponsesServerEvent } from "../../events/responses-events.js";
import type { StreamDelta } from "../../types/chat.js";
import type { ChatMessage } from "../../types/session.js";
import { patchArgumentsJson } from "../../utils/patch-args.js";
import { partialAssistantMessage } from "../../utils/stream-recovery.js";
import { cleanGptText, GptTextFilter } from "./gpt-text.js";

/** 将 Responses 协议事件聚合为内部响应，并发出界面事件。 */
export async function collectResponsesStream(
  stream: AsyncIterable<ResponsesServerEvent>,
  emit: (event: UIEvent) => void,
  persistDelta?: (delta: StreamDelta) => Promise<void>,
  requestModel?: string,
): Promise<any> {
  const textFilter = new GptTextFilter(requestModel);
  const emitText = async (rawText: string): Promise<void> => {
    const text = textFilter.push(rawText);
    if (!text) return;
    await persistDelta?.({ text });
    emit({ type: "text_delta", delta: text });
  };
  const finishText = async (): Promise<void> => {
    const text = textFilter.finish();
    if (!text) return;
    await persistDelta?.({ text });
    emit({ type: "text_delta", delta: text });
  };
  let completedResponse: any;
  const outputItems: any[] = [];
  const functionCalls = new Map<string, {
    index: number;
    id: string;
    name: string;
    arguments: string;
    /** custom 是自由文本工具（apply_patch）：arguments 存的是裸补丁文本，不是 JSON。 */
    kind: "function" | "custom";
  }>();
  let model = "";
  let usage: any;
  let partialText = "";
  let partialReasoning = "";
  let responseId: string | undefined;
  const steeredResponseIds = new Set<string>();
  // 托管搜索的进度按 item_id 跟踪：同一轮可能连续搜多次，且会并行开多个
  const activeSearches = new Set<string>();
  let finishedSearches = 0;

  try {
    for await (const event of stream) {
      switch (event.type) {
        case "response.created": {
          if (responseId && steeredResponseIds.delete(responseId)) {
            completedResponse = undefined;
            outputItems.length = 0;
            functionCalls.clear();
            partialText = "";
            await finishText();
            partialReasoning = "";
            activeSearches.clear();
            finishedSearches = 0;
          }
          responseId = event.response?.id ?? responseId;
          break;
        }
        case "response.steer.accepted": {
          const targetId = event.steer?.previous_response_id;
          if (typeof targetId === "string") steeredResponseIds.add(targetId);
          break;
        }
        case "response.output_text.delta":
        case "response.refusal.delta": {
          partialText += event.delta;
          await emitText(event.delta);
          break;
        }
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta": {
          await persistDelta?.({ reasoning: event.delta });
          partialReasoning += event.delta;
          emit({ type: "reasoning_delta", delta: event.delta });
          break;
        }
        case "response.output_item.added": {
          const item = event.item;
          if (item?.type === "function_call" || item?.type === "custom_tool_call") {
            const isCustom = item.type === "custom_tool_call";
            const call = {
              index: event.output_index ?? functionCalls.size,
              id: item.call_id ?? item.id ?? `call_${crypto.randomUUID().slice(0, 8)}`,
              name: item.name ?? "",
              arguments: (isCustom ? item.input : item.arguments) ?? "",
              kind: isCustom ? "custom" as const : "function" as const,
            };
            await persistDelta?.({ toolCalls: [{
              index: call.index,
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            }] });
            functionCalls.set(item.id ?? call.id, call);
            emit({ type: "toolcall_start", index: call.index, id: call.id, name: call.name });
          }
          break;
        }
        case "response.function_call_arguments.delta":
        case "response.custom_tool_call_input.delta": {
          const key = event.item_id;
          const call = functionCalls.get(key) ?? {
            index: event.output_index ?? functionCalls.size,
            id: key,
            name: "",
            arguments: "",
            kind: event.type === "response.custom_tool_call_input.delta" ? "custom" as const : "function" as const,
          };
          const delta = typeof event.delta === "string" ? event.delta : "";
          await persistDelta?.({ toolCalls: [{ index: call.index, arguments: delta }] });
          call.arguments += delta;
          functionCalls.set(key, call);
          emit({ type: "toolcall_args_delta", index: call.index, delta });
          break;
        }
        case "response.custom_tool_call_input.done": {
          // 网关可能只在 done 里给完整文本；已有增量时不重复追加
          const key = event.item_id;
          const input = typeof event.input === "string" ? event.input : "";
          const call = functionCalls.get(key);
          if (call && call.arguments.length === 0 && input) {
            await persistDelta?.({ toolCalls: [{ index: call.index, arguments: input }] });
            call.arguments = input;
            emit({ type: "toolcall_args_delta", index: call.index, delta: input });
          }
          break;
        }
        case "response.output_text.done": {
          // 网关把增量合并成单个 done 事件时补上正文，已有 delta 时不重复追加
          const text = typeof event.text === "string" ? event.text : "";
          if (partialText.length === 0 && text) {
            partialText = text;
            await emitText(text);
          }
          break;
        }
        case "response.refusal.done": {
          const text = event.refusal;
          if (partialText.length === 0 && text) {
            partialText = text;
            await emitText(text);
          }
          break;
        }
        case "error":
          throw new Error(`Responses 请求失败: ${JSON.stringify(event)}`);
        case "response.compaction.compacting":
          emit({ type: "progress", message: "正在压缩上下文..." });
          break;
        case "response.reasoning_text.done": {
          const text = typeof event.text === "string" ? event.text : "";
          if (partialReasoning.length === 0 && text) {
            await persistDelta?.({ reasoning: text });
            partialReasoning = text;
            emit({ type: "reasoning_delta", delta: text });
          }
          break;
        }
        case "response.function_call_arguments.done": {
          const key = event.item_id;
          const args = typeof event.arguments === "string" ? event.arguments : "";
          const call = functionCalls.get(key);
          if (call && call.arguments.length === 0 && args) {
            await persistDelta?.({ toolCalls: [{ index: call.index, arguments: args }] });
            call.arguments = args;
            emit({ type: "toolcall_args_delta", index: call.index, delta: args });
          }
          break;
        }
        case "response.output_item.done": {
          if (event.item && event.output_index !== undefined) {
            outputItems[event.output_index] = event.item;
          }
          break;
        }
        case "response.web_search_call.in_progress":
        case "response.web_search_call.searching":
        case "response.web_search_call.completed":
        case "response.file_search_call.in_progress":
        case "response.file_search_call.searching":
        case "response.file_search_call.completed":
        case "response.tool_search_call.in_progress":
        case "response.tool_search_call.searching":
        case "response.tool_search_call.completed": {
          // OpenAI 云端托管搜索只映射为进度提示；查询词与来源在 output_item.done 中。
          const label = event.type.startsWith("response.tool_search_call.") ? "找工具"
            : event.type.startsWith("response.file_search_call.") ? "搜索文件" : "搜索";
          const key = typeof event.item_id === "string"
            ? event.item_id
            : `search_${event.output_index ?? activeSearches.size}`;
          if (event.type.endsWith(".completed")) {
            if (activeSearches.delete(key)) finishedSearches += 1;
            if (activeSearches.size === 0 && finishedSearches > 0) {
              emit({ type: "progress", message: `🌐 ${label}完成 ${finishedSearches}` });
            }
          } else if (!activeSearches.has(key)) {
            activeSearches.add(key);
            emit({ type: "progress", message: `🌐 ${label}中 ${activeSearches.size + finishedSearches}...` });
          }
          break;
        }
        case "response.code_interpreter_call.in_progress":
          emit({ type: "progress", message: "正在运行代码..." });
          break;
        case "response.code_interpreter_call.completed":
          emit({ type: "progress", message: "代码运行完成" });
          break;
        case "response.image_generation_call.in_progress":
          emit({ type: "progress", message: "正在生成图像..." });
          break;
        case "response.image_generation_call.completed":
          emit({ type: "progress", message: "图像生成完成" });
          break;
        case "response.completed": {
          completedResponse = event.response;
          model = event.response?.model ?? model;
          usage = event.response?.usage ?? usage;
          break;
        }
        case "response.failed":
        case "response.incomplete": {
          completedResponse = { ...(event.response ?? {}), status: event.type === "response.failed" ? "failed" : "incomplete" };
          model = event.response?.model ?? model;
          usage = event.response?.usage ?? usage;
          break;
        }
        case "codex.rate_limits":
        case "response.audio.delta":
        case "response.audio.done":
        case "response.audio.transcript.delta":
        case "response.audio.transcript.done":
        // OpenAI 云端托管工具调用事件：保留协议识别，当前不映射到 UI。
        case "response.code_interpreter_call_code.delta":
        case "response.code_interpreter_call_code.done":
        case "response.code_interpreter_call.interpreting":
        case "response.content_part.added":
        case "response.content_part.done":
        // OpenAI 云端托管工具调用事件。
        // OpenAI 云端托管工具调用事件。
        case "response.image_generation_call.generating":
        case "response.image_generation_call.partial_image":
        case "response.in_progress":
        case "response.mcp_call_arguments.delta":
        case "response.mcp_call_arguments.done":
        case "response.mcp_call.completed":
        case "response.mcp_call.failed":
        case "response.mcp_call.in_progress":
        case "response.mcp_list_tools.completed":
        case "response.mcp_list_tools.failed":
        case "response.mcp_list_tools.in_progress":
        case "response.output_text.annotation.added":
        case "response.queued":
        case "response.reasoning_summary_part.added":
        case "response.reasoning_summary_part.done":
        case "response.reasoning_summary_text.done":
        case "response.shell_call_command.added":
        case "response.shell_call_command.delta":
        case "response.shell_call_command.done":
        case "response.shell_call_output_content.delta":
        case "response.shell_call_output_content.done":
        case "response.steer.pending":
        case "response.steer.failed":
        case "response.interrupt.accepted":
        case "response.interrupt.failed":
          // 这些已知事件当前不映射到 UIEvent 或响应聚合结果。
          break;
        default:
          ignoreUnknownResponseEvent(event);
      }
    }
  } catch (error) {
    await finishText();
    const text = cleanGptText(partialText, requestModel);
    throw withPartialMessage(error, partialAssistantMessage(text, partialReasoning, [...functionCalls.values()]));
  }

  await finishText();

  for (const call of functionCalls.values()) {
    emit({
      type: "toolcall_end",
      index: call.index,
      id: call.id,
      name: call.name,
      argsJson: toolCallArgsJson(call.kind, call.arguments),
    });
  }

  const hasFailed = completedResponse?.status === "failed" || completedResponse?.status === "incomplete";
  const recovered = hasFailed
    ? partialAssistantMessage(partialText, partialReasoning, [...functionCalls.values()])
    : undefined;
  const fallbackText = typeof recovered?.content === "string" ? recovered.content : partialText;
  const streamedItems = outputItems.filter(Boolean);
  const suppliedItems = Array.isArray(completedResponse?.output) && completedResponse.output.length > 0
    ? completedResponse.output
    : streamedItems;
  const hasOutputText = suppliedItems.some((item: any) => item?.type === "message"
    && item.content?.some((part: any) => part?.type === "output_text" || part?.type === "refusal"));
  const output = fallbackText && !hasOutputText
    ? [...suppliedItems, { type: "message", content: [{ type: "output_text", text: fallbackText }] }]
    : suppliedItems;
  // 流里出现过、但 output_item.done 与 completed.output 都缺的调用：用累积的名字与参数补齐
  const knownCallIds = new Set(output.map((item: any) => item?.call_id ?? item?.id).filter(Boolean));
  const missingCalls = [...functionCalls.values()]
    .filter(call => call.name && !knownCallIds.has(call.id))
    .map(call => (call.kind === "custom"
      ? { type: "custom_tool_call", id: call.id, call_id: call.id, name: call.name, input: call.arguments, status: "completed" }
      : { type: "function_call", id: call.id, call_id: call.id, name: call.name, arguments: call.arguments }));
  const mergedOutput = missingCalls.length > 0 ? [...output, ...missingCalls] : output;
  if (completedResponse) completedResponse.output = mergedOutput;
  if (completedResponse && partialReasoning) completedResponse.reasoning_content = partialReasoning;
  return completedResponse ?? {
    model,
    output: mergedOutput,
    ...(partialReasoning ? { reasoning_content: partialReasoning } : {}),
    usage,
  };
}

function ignoreUnknownResponseEvent(_event: never): void {
  // 上游可能新增扩展事件，忽略未识别事件并继续接收响应。
}

function toolCallArgsJson(kind: "function" | "custom", argumentsText: string): string {
  return kind === "custom" ? patchArgumentsJson(argumentsText) : argumentsText;
}

function withPartialMessage(error: unknown, message: ChatMessage | undefined): unknown {
  if (!message) return error;
  const wrapped = error && typeof error === "object" ? error : new Error(String(error));
  (wrapped as { partialMessage?: ChatMessage }).partialMessage = message;
  return wrapped;
}
