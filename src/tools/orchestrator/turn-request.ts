/**
 * 单轮请求：准备消息与工具 → 组装请求体 → 发起调用 → 归一化响应。
 *
 * 抽出来的目的是让「协议差异」与「图片物化」不再纠缠在循环体内，
 * 循环只剩：准备一轮 → 决策 → 执行工具。
 */

import { isDeepSeekEndpoint } from "../../pricing/deepseek.js";
import type { ChatMessage } from "../../types/session.js";
import { projectChatMessagesForPrompt } from "../../utils/tool-result-context.js";
import { isResponsesStoreEnabled } from "../../utils/responses-transport.js";
import {
  materializeDeepSeekImageMessages,
  materializeImageMessages,
} from "../../utils/image-assets.js";
import type { UIEvent } from "../../events/ui-events.js";
/** 只声明本模块用到的最小客户端形状，避免与主模块形成循环依赖。 */
interface RequestClient {
    baseURL: string;
    protocol?: "responses" | "chat_completions";
    createResponse?: unknown;
    uploadFile?: (imagePath: string) => Promise<{ id: string }>;
    uploadFileData?: (data: string, filename: string, mimeType: string) => Promise<{ id: string }>;
}

type ChatClient = RequestClient;
import {
  buildRequestBody,
  resolveEffort,
  resolveProtocol,
  sortToolsByName,
  appendHostedTools,
  toResponsesToolDefinitions,
  toHostedToolDefinitions,
} from "./request-builder.js";
import {
  expandToolMediaMessages,
  materializeResponsesInput,
  normalizeToolCallShapes,
  stripReasoningContent,
  stripResponsesMetadata,
} from "./messages.js";
import { adaptToolsForUpstream, resolveApplyPatchToolMode } from "./apply-patch-tool.js";
import { stripInternalPromptIds } from "../../utils/conversation-history.js";

/** 把工具结果中的图片上传成 DeepSeek Files，返回 file id。 */
async function uploadImageForDeepSeek(client: ChatClient, image: any): Promise<string> {
    const uploaded = "path" in image
        ? await (client.uploadFile
            ? client.uploadFile(image.path)
            : Promise.reject(new Error("当前 DeepSeek 客户端不支持 Files API")))
        : await (client.uploadFileData
            ? client.uploadFileData(image.data, image.filename, image.mimeType)
            : Promise.reject(new Error("当前 DeepSeek 客户端不支持内存图片上传")));
    return uploaded.id;
}

/** 历史调用方从本模块取该判定，实现已下沉到 pricing（无上游依赖）。 */
export { isDeepSeekEndpoint };

/**
 * 判定接入端是否接受 Chat Completions 的 `input_audio` 内容块。
 *
 * 目前只有音频模型（如 gpt-audio-*、gpt-4o-audio-preview）支持；DeepSeek 只有视觉能力，
 * 收到 audio 内容块会返回 400。默认关闭，宁可退化成文本占位符。
 *
 * 名字启发式会误判「名字含 audio 但端点不接受 input_audio」的网关别名
 * （如自建 LiteLLM 的 my-audio-model），可用 TOOL_AUDIO_INPUT=on|off 强制覆盖。
 */
export function supportsAudioInput(model: string, baseURL: string): boolean {
    // 硬性不支持，任何覆盖都不能让它发 input_audio：该 env 是全局的，
    // 为网关别名开的开关不该顺带打死同一实例里的 DeepSeek 会话。
    if (isDeepSeekEndpoint(model, baseURL)) return false;

    const override = (process.env.TOOL_AUDIO_INPUT ?? "").trim().toLowerCase();
    if (override === "off" || override === "0" || override === "false") return false;
    if (override === "on" || override === "1" || override === "true") return true;

    return /audio/i.test(model);
}

/** DeepSeek 兼容端只托管服务端 web_search，且 flash 档上游会忽略，因此其余类型与 flash 档一律不发。 */
const DEEPSEEK_HOSTED_TOOL_TYPES: ReadonlySet<string> = new Set(["web_search"]);

const NO_HOSTED_TOOL_TYPES: ReadonlySet<string> = new Set();

/** 模型名同时含 deepseek 与 flash 的档位不执行服务端 web_search。 */
function isDeepSeekFlashModel(model: string): boolean {
    const name = model.toLowerCase();
    return name.includes("deepseek") && name.includes("flash");
}

/** 按接入端解析可声明的托管工具类型；不是 DeepSeek 时返回 undefined（不限制）。 */
function resolveHostedToolTypes(model: string, baseURL: string): ReadonlySet<string> | undefined {
    if (!isDeepSeekEndpoint(model, baseURL)) return undefined;
    return isDeepSeekFlashModel(model) ? NO_HOSTED_TOOL_TYPES : DEEPSEEK_HOSTED_TOOL_TYPES;
}

/**
 * 接入端本次请求能否声明 tool_search：托管工具只在 Responses 协议下发，
 * 且该类型要出现在接入端的能力集合里（DeepSeek 兼容端一个都没有）。
 * lazy MCP 工具的下发判定与 defer_loading 投影共用这一口径。
 */
export function isToolSearchEnabled(options: {
    protocol: string;
    model: string;
    baseURL: string;
    hostedTools?: string[];
}): boolean {
    if (options.protocol !== "responses") return false;
    const supportedTypes = resolveHostedToolTypes(options.model, options.baseURL);
    return toHostedToolDefinitions(options.hostedTools ?? [], { supportedTypes })
        .some(tool => tool.type === "tool_search");
}

export interface PrepareRequestOptions {
    client: ChatClient;
    model: string;
    /** 当前完整消息列表（含本轮已产生消息）。 */
    messages: ChatMessage[];
    /** 基础工具定义（未排序）。 */
    tools: any[];
    getToolDefinitions?: () => any[];
    /** 托管工具类型（上游执行，本地不执行）：调用方解析 OPENAI_RESPONSES_HOSTED_TOOLS 后传入。 */
    hostedTools?: string[];
    getContextReminders?: () => string[] | undefined;
    normalizedTools: (tools: any[]) => any[];
    toolChoice?: "auto" | "none";
    isFirstIteration: boolean;
    stream: boolean;
    reasoningEffort?: string;
    reasoningEfforts?: string[];
}

export interface PreparedRequest {
    protocol: "responses" | "chat_completions";
    requestBody: Record<string, any>;
    isMiniMax: boolean;
}

/** 把一轮请求的输入全部算好；纯装配，不发请求。 */
export async function prepareRequest(options: PrepareRequestOptions): Promise<PreparedRequest> {
    const { client, model } = options;
    const protocol = resolveProtocol(client);
    const useResponses = protocol === "responses";
    // apply_patch 是自由文本工具：只有 gpt-* 发 custom，其余上游原样下发
    const applyPatchMode = resolveApplyPatchToolMode({ model, baseURL: client.baseURL });

    // 全量工具始终按名称排序，确保不同请求使用稳定的工具前缀。
    const currentTools = sortToolsByName(options.getToolDefinitions ? options.getToolDefinitions() : options.tools);

    // 提醒消息只追加在请求尾部：不进历史、不落盘，前缀不变仍可命中缓存
    // 历史里的消息 id 只服务于本地 token 缓存，构造请求体前必须剥掉
    const projected = stripInternalPromptIds(projectChatMessagesForPrompt(options.messages));
    // 不下发工具时（纯生成请求）DeepSeek 不需要、也不会拼接历史思维链，剥掉省请求体
    const promptMessages = currentTools.length === 0 && isDeepSeekEndpoint(model, client.baseURL)
      ? stripReasoningContent(projected)
      : projected;
    const reminders = options.isFirstIteration ? [] : options.getContextReminders?.() ?? [];
    const sourceMessages: ChatMessage[] = reminders.length > 0
        ? [...promptMessages, ...reminders.map((content) => ({ role: "user" as const, content }))]
        : promptMessages;

    // 历史里的 apply_patch 调用先按当前上游形态归一，再按协议物化
    const shapedMessages = normalizeToolCallShapes(sourceMessages, applyPatchMode);
    const requestMessages = useResponses
        ? shapedMessages
        : expandToolMediaMessages(stripResponsesMetadata(shapedMessages), {
            allowAudio: supportsAudioInput(model, client.baseURL),
        });

    const materializedMessages = useResponses
        ? await materializeResponsesInput(requestMessages)
        : isDeepSeekEndpoint(model, client.baseURL)
            ? await materializeDeepSeekImageMessages(requestMessages, image => uploadImageForDeepSeek(client, image))
            : await materializeImageMessages(requestMessages);

    const normalizedTools = options.normalizedTools(currentTools);
    const adaptedTools = adaptToolsForUpstream(normalizedTools, { mode: applyPatchMode, protocol });
    // 托管工具只在 Responses 协议声明：Chat Completions 只接受 function 类型，
    // 严格的上游会直接以 422 unknown variant 拒绝 web_search 等类型。
    // DeepSeek 兼容端只有 pro 档托管 web_search；flash 档与 tool_search 均由能力集合过滤掉。
    const hostedToolTypes = resolveHostedToolTypes(model, client.baseURL);
    const supportedHostedTools = useResponses
        ? toHostedToolDefinitions(options.hostedTools ?? [], { supportedTypes: hostedToolTypes })
        : [];
    // tool_search 依赖至少一个延迟加载的 Responses function 工具；按实际声明的托管工具判断。
    const toolSearchSupported = supportedHostedTools.some(tool => tool.type === "tool_search");
    const enableDeferredLoading = toolSearchSupported
        && adaptedTools.some(tool => tool.deferLoading === true);
    const hostedTools = supportedHostedTools
        .filter(tool => tool.type !== "tool_search" || enableDeferredLoading);
    const requestTools = useResponses
        ? appendHostedTools(toResponsesToolDefinitions(adaptedTools, enableDeferredLoading), hostedTools)
        : adaptedTools.map(({ deferLoading: _deferLoading, ...tool }) => tool);

    const isMiniMax = model.startsWith("MiniMax-");
    const requestBody = buildRequestBody({
        protocol,
        model,
        baseURL: client.baseURL,
        messages: materializedMessages,
        tools: requestTools,
        ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
        stream: options.stream,
        store: isResponsesStoreEnabled(),
        isMiniMax,
        reasoning: {
            protocol,
            model,
            baseURL: client.baseURL,
            effort: resolveEffort(options.reasoningEffort),
            ...(options.reasoningEfforts ? { configuredEfforts: options.reasoningEfforts } : {}),
        },
    });

    return { protocol, requestBody, isMiniMax };
}
