/**
 * `config.yaml` 的结构：providers + defaults + 运行期配置。
 *
 * 除运行时注入的变量（`ZBOT_STATE_DIR`、`TUI_CWD`、`HERDR_*` 等）外，
 * 用户可编辑的配置项都在这里，不再读 `~/.zbot/env`。
 */

import { z } from "zod";
import { CHAT_API_PROTOCOLS } from "../types/chat-model.js";

/** 单个模型服务：一个 provider 固定一个协议。 */
const providerSchema = z.object({
    protocol: z.enum(CHAT_API_PROTOCOLS),
    baseUrl: z.string().trim().min(1),
    /** 直接写密钥，或写 `$ENV_NAME` / `${ENV_NAME}` 引用进程环境。 */
    apiKey: z.string().optional(),
    /** 可切换的模型；面板里还能临时手输未列出的模型。 */
    models: z.array(z.string()).default([]),
    /** 可选思考强度候选。 */
    efforts: z.array(z.string()).optional(),
    /** Responses 托管工具类型（如 `web_search`, `tool_search`）。 */
    hostedTools: z.array(z.string()).optional(),
    /** Responses 是否走 WebSocket；省略时按模型名启发式。 */
    websocket: z.boolean().optional(),
    /** Responses 是否请求上游保存，默认 `false`。 */
    store: z.boolean().optional(),
    /** Chat Completions 是否允许下发 `input_audio`；省略时按模型名启发式。 */
    audioInput: z.boolean().optional(),
    /** 该服务是否接受图片内容块；省略时视为接受，只有 `textOnlyModels` 命中的模型判否。 */
    imageInput: z.boolean().optional(),
    /** 纯文本模型名（小写子串匹配）：发请求前把图片块降级成文本说明，避免整轮 404。 */
    textOnlyModels: z.array(z.string()).optional(),
    /** 该服务的上下文窗口；省略时用 runtime 值或内置模型表。 */
    contextWindowTokens: z.number().int().positive().optional(),
});

/** 默认模型选择：省略时取 providers 里第一个。 */
const defaultsSchema = z.object({
    provider: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    /** 默认思考强度，`auto` 表示不显式下发。 */
    reasoningEffort: z.string().trim().min(1).optional(),
});

/** 上下文预算与自动压缩。 */
const runtimeSchema = z.object({
    /** 显式指定时压过内置模型窗口表；省略时按模型名查表。 */
    contextWindowTokens: z.number().int().positive().optional(),
    reservedOutputTokens: z.number().int().nonnegative().default(8_192),
    autocompactBufferTokens: z.number().int().nonnegative().default(15_000),
    retainTailTokens: z.number().int().nonnegative().default(12_000),
    /** 压缩触发比例，0~1。 */
    autocompactRatio: z.number().gt(0).lte(1).default(0.8),
    toolResultSummary: z.object({
        thresholdTokens: z.number().int().positive().default(8_192),
        headTokens: z.number().int().positive().default(1_024),
        tailTokens: z.number().int().positive().default(2_048),
    }).prefault({}),
    /** 关闭真分词（诊断用）。 */
    tokenizer: z.boolean().default(true),
    memoryUserId: z.number().int().nonnegative().default(0),
    identityFile: z.string().trim().min(1).optional(),
    extraIdentityFile: z.string().trim().min(1).optional(),
    /** 归档会话保留天数，<= 0 表示不清理。 */
    archiveRetentionDays: z.number().int().default(14),
    /** 协议日志里保留流式增量事件。 */
    llmLogDeltas: z.boolean().default(false),
    /** 非官方端点（局域网网关）也按 DeepSeek 官方价格表估算费用。 */
    deepseekCostStat: z.boolean().default(false),
    /** apply_patch 的下发形态：custom 自由文本 / off 原样下发；省略时按模型名启发式。 */
    applyPatchMode: z.enum(["custom", "off"]).optional(),
});

const networkSchema = z.object({
    /** 命令行工具与网络请求使用的代理。 */
    proxy: z.string().trim().min(1).optional(),
    /** 模型 API 单独使用的代理。 */
    openaiProxy: z.string().trim().min(1).optional(),
});

const mcpSchema = z.object({
    serversFile: z.string().trim().min(1).optional(),
});

const webSchema = z.object({
    token: z.string().trim().min(1).optional(),
    jobsMaxConcurrent: z.number().int().positive().max(16).default(2),
});

const tuiSchema = z.object({
    disableNotifications: z.boolean().default(false),
    debugWheel: z.boolean().default(false),
});

/** 根对象：providers 是名字到配置的映射，顺序即面板里的展示顺序。 */
export const configSchema = z.object({
    providers: z.record(z.string(), providerSchema),
    defaults: defaultsSchema.prefault({}),
    runtime: runtimeSchema.prefault({}),
    network: networkSchema.prefault({}),
    mcp: mcpSchema.prefault({}),
    web: webSchema.prefault({}),
    tui: tuiSchema.prefault({}),
});

type RawConfig = z.infer<typeof configSchema>;
export type RawProvider = RawConfig["providers"][string];
