/**
 * apply_patch 的上游形态适配。
 *
 * 补丁是多行、语法密集的文本：作为 JSON 函数参数下发时，每个换行、引号、反斜杠都要转义，
 * 模型在长度压力下最容易在这里产出坏 JSON（参数截断或被转义成字面量）。OpenAI 的官方答案
 * 是 custom（freeform）工具：模型直接输出补丁原文，不经过 JSON。
 *
 * 只对能吃下 custom 的上游换形态；其余（DeepSeek 只有 function 工具、其他模型未知）一律原样
 * 下发——schema 里 `patch` 已声明为字符串，再往描述里塞转义提醒属于未经验证的 prompt 干预，
 * 不抵它带来的 token 与漂移成本。历史消息的形态转换不受这条限制，见 messages.ts。
 */

import { getRuntimeConfig } from "../../config/index.js";
import { isDeepSeekStyle } from "../../pricing/deepseek.js";
import { isApplyPatchTool } from "../tool-kinds.js";

/** 工具形态：custom 自由文本 / off 原样下发（含 DeepSeek 这类只支持 function 的上游）。 */
export type ApplyPatchToolMode = "custom" | "off";

/**
 * 解析当前上游该用哪种形态：gpt-* 走 custom，其余（含 DeepSeek）原样下发。
 * 配置 `runtime.applyPatchMode` 命中时优先于模型判定，出问题可一键关掉 custom 形态。
 */
export function resolveApplyPatchToolMode(
    input: { model: string; baseURL?: string },
    configured: ApplyPatchToolMode | undefined = getRuntimeConfig().applyPatchMode,
): ApplyPatchToolMode {
    if (configured) return configured;

    if (isDeepSeekStyle(input.model, input.baseURL)) return "off";
    if (input.model.toLowerCase().includes("gpt-")) return "custom";
    return "off";
}

/** custom 工具的描述尾巴：补丁要裸输出，不能被 JSON 或代码块围栏包住。 */
const FREEFORM_DESCRIPTION_TAIL =
    "\n\n直接输出补丁原文：以 `*** Begin Patch` 开头、`*** End Patch` 结尾。"
    + "不要包成 JSON、不要加代码块围栏、不要附带解释。";

/** 追加说明尾巴；已经带过的不再追加，保证重复适配幂等。 */
function appendOnce(text: string, tail: string): string {
    return text.endsWith(tail) ? text : `${text}${tail}`;
}

function customToolDefinition(tool: any, name: string): any {
    const description = tool.function?.description ?? tool.description;
    return {
        type: "custom" as const,
        name,
        // 空描述时尾巴是唯一告诉模型「输出裸补丁」的线索，所以缺描述也要加；已带过则不重复加
        description: appendOnce(typeof description === "string" ? description : "", FREEFORM_DESCRIPTION_TAIL),
        format: { type: "text" as const },
        // defer_loading 由调用方按 tool_search 能力决定，形态转换不能顺手丢掉它
        ...(tool.deferLoading === true ? { deferLoading: true } : {}),
    };
}

function chatCompletionsCustomTool(tool: any): any {
    const { type: _type, name, description, format, deferLoading } = tool;
    return {
        type: "custom",
        ...(deferLoading === true ? { deferLoading: true } : {}),
        custom: {
            name,
            ...(description ? { description } : {}),
            ...(format ? { format } : {}),
        },
    };
}

/**
 * 按上游协议把 apply_patch 改写成 custom 工具定义；其余工具与 off 模式原样返回。
 * 只在 custom 模式下才需要区分协议：Responses 是扁平形状，Chat Completions 包在 `custom` 里。
 */
export function adaptToolsForUpstream(
    tools: any[],
    options: { mode: ApplyPatchToolMode; protocol: "responses" | "chat_completions" },
): any[] {
    if (options.mode !== "custom") return tools;

    return tools.map(tool => {
        // 只认 function 与扁平 custom 两种入参；Chat Completions 的嵌套 custom 读不到名字，
        // 原样返回（再适配即 no-op）。prepareRequest 每次都用注册表里的原始定义，不依赖这条路径。
        const name = tool?.function?.name ?? tool?.name;
        if (typeof name !== "string" || !isApplyPatchTool(name)) return tool;

        // 入参可能是 function 形状，也可能是已经转换过的扁平 custom：两种都能直接读描述与 deferLoading
        const flat = customToolDefinition(tool, name);
        return options.protocol === "chat_completions" ? chatCompletionsCustomTool(flat) : flat;
    });
}
