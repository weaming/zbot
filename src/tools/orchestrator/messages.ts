/**
 * 协议消息转换：把内部 ChatMessage 物化成各协议要求的上游输入形态。
 *
 * 三处容易出错的差异集中在这里：
 *   - Responses 用 input_image / function_call_output，Chat Completions 用 image_url
 *   - 工具返回的图片要补成紧随其后的用户多模态消息（Chat Completions 无工具内图片）
 *   - Responses 专属字段（response_output）在切换到 Chat Completions 前必须剥离
 */

import type { ChatMessage } from "../../types/session.js";
import type { ToolImageContent } from "../tool-interface.js";
import type { InputAudioContent } from "../../types/audio.js";
import { materializeImageMessages } from "../../utils/image-assets.js";
import { isApplyPatchTool } from "../tool-kinds.js";
import { patchArgumentsJson, patchFromArguments } from "../../utils/patch-args.js";
import type { ApplyPatchToolMode } from "./apply-patch-tool.js";
import { repairResponsesFunctionCallItemIds } from "./responses-input.js";

/** function_call → custom_tool_call：同一个补丁从 JSON 参数挪到裸文本 input。 */
function toCustomToolCallItem(item: any): any {
  return {
    type: "custom_tool_call",
    call_id: item.call_id ?? item.id,
    ...(item.id ? { id: item.id } : {}),
    name: item.name,
    input: patchFromArguments(item.arguments) ?? "",
  };
}

/** custom_tool_call → function_call：裸文本重新包成 {"patch": ...} 的参数。 */
function toFunctionCallItem(item: any): any {
  return {
    type: "function_call",
    call_id: item.call_id ?? item.id,
    ...(item.id ? { id: item.id } : {}),
    name: item.name,
    arguments: patchArgumentsJson(typeof item.input === "string" ? item.input : ""),
  };
}

/** response_output 只装模型的输出项，apply_patch 的调用项就是 function_call / custom_tool_call。 */
function isApplyPatchCallItem(item: any): boolean {
  if (item?.type !== "function_call" && item?.type !== "custom_tool_call") return false;
  return typeof item.name === "string" && isApplyPatchTool(item.name);
}

/**
 * 历史里的 apply_patch 调用按当前上游形态重写（custom ↔ function 双向）。
 * 换模型或换协议后历史仍能复用，否则上游会因工具形态不匹配拒绝请求。
 */
export function normalizeToolCallShapes(
  messages: ChatMessage[],
  mode: ApplyPatchToolMode,
): ChatMessage[] {
  // 非 custom 上游（含不处理工具定义的模型）都要拿到 function 形态：历史里的自由文本调用
  // 换模型后仍能复用，否则上游会因工具形态不匹配直接拒绝请求。
  const wantsCustom = mode === "custom";

  return messages.map(message => {
    if (message.role !== "assistant") return message;

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    let changed = false;
    const normalizedCalls = toolCalls.map((call: any) => {
      const isCustom = call?.type === "custom";
      const name = isCustom ? call?.custom?.name : call?.function?.name;
      if (typeof name !== "string" || !isApplyPatchTool(name)) return call;

      if (wantsCustom && !isCustom) {
        changed = true;
        return {
          id: call.id,
          type: "custom",
          custom: { name, input: patchFromArguments(call?.function?.arguments) ?? "" },
        };
      }
      if (!wantsCustom && isCustom) {
        changed = true;
        const input = typeof call?.custom?.input === "string" ? call.custom.input : "";
        return {
          id: call.id,
          type: "function",
          function: { name, arguments: patchArgumentsJson(input) },
        };
      }
      return call;
    });

    // response_output 是原样回放的模型输出项：形态跟着当前上游走，否则上游会认不出调用类型
    const responseOutput = Array.isArray(message.response_output) ? message.response_output : [];
    let outputChanged = false;
    const hasPatchCall = responseOutput.some(isApplyPatchCallItem);
    const normalizedOutput = hasPatchCall ? responseOutput.map((item: any) => {
      if (!isApplyPatchCallItem(item)) return item;
      if (wantsCustom && item.type === "function_call") {
        outputChanged = true;
        return toCustomToolCallItem(item);
      }
      if (!wantsCustom && item.type === "custom_tool_call") {
        outputChanged = true;
        return toFunctionCallItem(item);
      }
      return item;
    }) : responseOutput;

    if (!changed && !outputChanged) return message;
    return {
      ...message,
      ...(changed ? { tool_calls: normalizedCalls } : {}),
      ...(outputChanged ? { response_output: normalizedOutput } : {}),
    } as ChatMessage;
  });
}

function responseImagePart(part: any): any {
  if (part.type === "file") return { type: "input_image", file_id: part.file_id };
  return {
    type: "input_image",
    image_url: part.image_url?.url,
    detail: part.image_url?.detail ?? "original",
  };
}

export async function materializeResponsesInput(
  messages: ChatMessage[],
  materializeImages: typeof materializeImageMessages = materializeImageMessages,
): Promise<any[]> {
  const materializedUsers = await materializeImages(messages);
  const result: any[] = [];

  // custom 工具调用的结果必须回成 custom_tool_call_output，否则上游对不上调用类型
  const customCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall?.type === "custom" && typeof toolCall.id === "string") customCallIds.add(toolCall.id);
    }
    for (const item of Array.isArray(message.response_output) ? message.response_output : []) {
      if (item?.type === "custom_tool_call" && typeof item.call_id === "string") customCallIds.add(item.call_id);
    }
  }

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const materialized = materializedUsers[index] as any;

    if (message.role === "tool") {
      const output: any[] = [{ type: "input_text", text: message.content }];
      if (message.imageContent && message.imageContent.length > 0) {
        const imageMessage = await materializeImages([{
          role: "user",
          content: [
            { type: "text", text: "" },
            ...message.imageContent,
          ],
        } as ChatMessage]);
        for (const part of (imageMessage[0] as any).content.slice(1)) {
          if (part.type === "image_url" || part.type === "file") {
            output.push(responseImagePart(part));
          } else if (part.type === "text" && part.text) {
            output.push({ type: "input_text", text: part.text });
          }
        }
      }
      result.push(customCallIds.has(message.tool_call_id)
        ? { type: "custom_tool_call_output", call_id: message.tool_call_id, output }
        : { type: "function_call_output", call_id: message.tool_call_id, output });
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.response_output)) {
      result.push(...repairResponsesFunctionCallItemIds(message.response_output));
      continue;
    }

    if (message.role === "assistant") {
      if (message.content) {
        result.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: message.content }],
        });
      }
      for (const toolCall of message.tool_calls ?? []) {
        if (toolCall?.type === "custom") {
          result.push({
            type: "custom_tool_call",
            call_id: toolCall.id,
            name: toolCall.custom?.name,
            input: typeof toolCall.custom?.input === "string" ? toolCall.custom.input : "",
          });
          continue;
        }
        result.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.function?.name,
          arguments: toolCall.function?.arguments ?? "{}",
        });
      }
      continue;
    }

    if (message.role === "system") {
      result.push({ role: "system", content: message.content });
      continue;
    }

    if (typeof materialized.content === "string") {
      result.push({ role: "user", content: materialized.content });
      continue;
    }

    result.push({
      role: "user",
      content: materialized.content.map((part: any) => {
        if (part.type === "text") return { type: "input_text", text: part.text };
        if (part.type === "image_url" || part.type === "file") return responseImagePart(part);
        // 其余块类型（将来的 user 音频等）原样透传，避免被当成图片构造成 input_image
        return part;
      }),
    });
  }

  return result;
}

/**
 * 把工具结果中的图片/音频补成请求专用的用户多模态消息。
 *
 * Chat Completions 的工具消息只能承载文本，图片走 image_url、音频走 input_audio，
 * 因此都提升为紧随其后的 user 消息。音频是否注入由 allowAudio 控制：只有明确支持
 * input_audio 的端点才开，其他端点（如 DeepSeek）会因未知内容块返回 400。
 */
export function expandToolMediaMessages(
    messages: ChatMessage[],
    options: { allowAudio?: boolean } = {},
): ChatMessage[] {
    const expanded: ChatMessage[] = [];
    const pendingMedia: Array<ToolImageContent | InputAudioContent> = [];
    const flushMedia = () => {
        if (pendingMedia.length === 0) return;

        const hasImage = pendingMedia.some((part) => part.type !== "input_audio");
        const hasAudio = pendingMedia.some((part) => part.type === "input_audio");
        expanded.push({
            role: "user",
            content: [
                {
                    type: "text",
                    text: hasImage && hasAudio
                        ? "工具返回了图片与音频，请结合工具结果分析这些内容。"
                        : hasImage
                            ? "工具返回了图片，请结合工具结果分析图片内容。"
                            : "工具返回了音频，请结合工具结果分析音频内容。",
                },
                ...pendingMedia,
            ],
        });
        pendingMedia.length = 0;
    };

    for (const message of messages) {
        if (message.role !== "tool") {
            flushMedia();
            expanded.push(message);
            continue;
        }

        // 是否注入音频由 allowAudio 决定；但字段本身是本地元数据，任何情况下都不能上行
        const hasLocalMedia = message.imageContent !== undefined || message.audioContent !== undefined;
        if (!hasLocalMedia) {
            expanded.push(message);
            continue;
        }

        const images = message.imageContent ?? [];
        const audios = options.allowAudio ? (message.audioContent ?? []) : [];
        pendingMedia.push(
            ...images,
            ...audios.map((audio) => ({ type: "input_audio" as const, input_audio: audio })),
        );

        const {
            imageContent: _imageContent,
            audioContent: _audioContent,
            ...toolMessage
        } = message;
        expanded.push(toolMessage as ChatMessage);
    }
    flushMedia();
    return expanded;
}

export function stripResponsesMetadata(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => {
    if (message.role !== "assistant") return message;
    if (!Array.isArray(message.response_output) && !message.citations) return message;
    // response_output 与 citations 都是本地保存的渲染事实，不上行
    const { response_output: _responseOutput, citations: _citations, ...chatMessage } = message;
    return chatMessage as ChatMessage;
  });
}

/**
 * 丢弃「纯文本轮」的历史思维链。
 *
 * 实测（DeepSeek Flash，官方端点）的硬约束只有一条：**带 tool_calls 的轮次**
 * 必须原样回传 reasoning_content，缺了就 400，与当前请求是否声明 tools 无关；
 * 纯文本轮带不带都行（官方文档写「带 tools 时全轮都要回传」，实测只强制工具轮）。
 * 因此只给「不下发工具」的纯生成请求（上下文压缩等）用这个剥离。
 */
export function stripReasoningContent(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => {
    if (message.role !== "assistant" || !("reasoning_content" in message)) return message;
    // 工具轮不能碰：reasoning_content 是这类轮次上行的必需字段
    const hasToolTurn = (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
      || (Array.isArray(message.response_output) && message.response_output.some(
        (item: any) => item?.type === "function_call" || item?.type === "custom_tool_call",
      ));
    if (hasToolTurn) return message;
    const { reasoning_content: _reasoning, ...chatMessage } = message as ChatMessage & { reasoning_content?: string };
    return chatMessage as ChatMessage;
  });
}
