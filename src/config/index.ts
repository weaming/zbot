/**
 * `config.yaml` 的唯一读取口：加载、校验、归一化并缓存。
 *
 * 路径默认 `~/.zbot/config.yaml`，`ZBOT_CONFIG_FILE` 可覆盖（测试与多实例用）。
 * 只有用户可编辑的配置走这里；运行时注入的路径类变量（`ZBOT_STATE_DIR`、`TUI_CWD`、
 * `ZBOT_SESSION_ID`、`HERDR_*`）仍留在进程环境。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { envReferenceTarget, resolveEnvReference } from "../utils/env-ref.js";
import { configSchema, type RawProvider } from "./schema.js";
import type { ChatApiProtocol } from "../types/chat-model.js";

/** 配置缺失或非法：带上文件路径，便于直接照着改。 */
class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

/** 一个模型服务的最终形态：名字来自 providers 的键，密钥已展开引用。 */
export interface ProviderConfig {
    name: string;
    protocol: ChatApiProtocol;
    baseUrl: string;
    apiKey: string;
    /** `apiKey` 写成 `$ENV` 引用时记下目标名，引用落空时用于报错。 */
    apiKeyRef?: string;
    models: string[];
    efforts?: string[];
    hostedTools: string[];
    websocket?: boolean;
    store: boolean;
    audioInput?: boolean;
    /** 该服务是否接受图片内容块；省略时视为接受。 */
    imageInput?: boolean;
    /** 纯文本模型名关键词（已小写）：命中即在发请求前降级掉图片。 */
    textOnlyModels?: string[];
    contextWindowTokens?: number;
}

export interface RuntimeConfig {
    contextWindowTokens?: number;
    reservedOutputTokens: number;
    autocompactBufferTokens: number;
    retainTailTokens: number;
    autocompactRatio: number;
    toolResultSummary: { thresholdTokens: number; headTokens: number; tailTokens: number };
    tokenizer: boolean;
    memoryUserId: number;
    identityFile?: string;
    extraIdentityFile?: string;
    archiveRetentionDays: number;
    llmLogDeltas: boolean;
    deepseekCostStat: boolean;
    applyPatchMode?: "custom" | "off";
}

export interface NetworkConfig {
    proxy?: string;
    openaiProxy?: string;
}

export interface McpConfig {
    serversFile?: string;
}

export interface WebConfig {
    token?: string;
    jobsMaxConcurrent: number;
}

export interface TuiConfig {
    disableNotifications: boolean;
    debugWheel: boolean;
}

export interface DefaultModelTarget {
    provider: string;
    model: string;
    reasoningEffort?: string;
}

export interface ZbotConfig {
    /** 实际加载的文件路径。 */
    file: string;
    providers: ProviderConfig[];
    defaults: { provider?: string; model?: string; reasoningEffort?: string };
    runtime: RuntimeConfig;
    network: NetworkConfig;
    mcp: McpConfig;
    web: WebConfig;
    tui: TuiConfig;
}

const DEFAULT_CONFIG_NAME = "config.yaml";

/** 配置文件路径：`ZBOT_CONFIG_FILE` 优先。 */
export function getConfigFilePath(): string {
    const configured = process.env.ZBOT_CONFIG_FILE?.trim();
    if (configured) return path.resolve(expandHome(configured));
    return path.join(os.homedir(), ".zbot", DEFAULT_CONFIG_NAME);
}

/** 展开 `~`，其余原样（配置里的路径字段只支持这一种简写）。 */
function expandHome(value: string): string {
    if (value === "~") return os.homedir();
    if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
    return value;
}

/** 去空、去重、保序。 */
function normalizeList(values: string[] | undefined, transform: (value: string) => string = value => value): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of values ?? []) {
        const value = transform(raw.trim());
        if (!value || seen.has(value)) continue;
        seen.add(value);
        result.push(value);
    }
    return result;
}

function normalizeBaseUrl(value: string): string {
    return value.trim().replace(/\/+$/, "");
}

function normalizeProvider(name: string, raw: RawProvider, file: string): ProviderConfig {
    const rawApiKey = raw.apiKey ?? "";
    const apiKey = resolveEnvReference(rawApiKey).trim();
    const apiKeyRef = envReferenceTarget(rawApiKey);
    return {
        name,
        protocol: raw.protocol,
        baseUrl: normalizeBaseUrl(raw.baseUrl),
        apiKey,
        ...(apiKeyRef === undefined ? {} : { apiKeyRef }),
        models: normalizeList(raw.models),
        ...(raw.efforts ? { efforts: normalizeList(raw.efforts, value => value.toLowerCase()) } : {}),
        hostedTools: normalizeList(raw.hostedTools),
        ...(raw.websocket === undefined ? {} : { websocket: raw.websocket }),
        store: raw.store ?? false,
        ...(raw.audioInput === undefined ? {} : { audioInput: raw.audioInput }),
        ...(raw.imageInput === undefined ? {} : { imageInput: raw.imageInput }),
        ...(raw.textOnlyModels ? { textOnlyModels: normalizeList(raw.textOnlyModels, value => value.toLowerCase()) } : {}),
        ...(raw.contextWindowTokens === undefined ? {} : { contextWindowTokens: raw.contextWindowTokens }),
    };
}

function readConfigFile(file: string): unknown {
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch (error: any) {
        if (error?.code === "ENOENT") {
            throw new ConfigError(`未找到配置文件 ${file}：请从仓库 config.example.yaml 复制后填写 providers`);
        }
        throw new ConfigError(`读取配置文件失败 ${file}：${error?.message ?? error}`);
    }

    try {
        return yaml.load(text);
    } catch (error: any) {
        throw new ConfigError(`配置文件不是合法 YAML（${file}）：${error?.message ?? error}`);
    }
}

/** 解析并归一化一份配置对象。 */
function parseConfig(input: unknown, file = getConfigFilePath()): ZbotConfig {
    const parsed = configSchema.safeParse(input ?? {});
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue?.path.join(".") || "(root)";
        throw new ConfigError(`配置文件 ${file} 的 ${where} 不合法：${issue?.message ?? "未知错误"}`);
    }

    const raw = parsed.data;
    const providers = Object.entries(raw.providers).map(([name, provider]) => normalizeProvider(name, provider, file));
    if (providers.length === 0) {
        throw new ConfigError(`配置文件 ${file} 没有配置任何 provider：请至少配置一个（见 config.example.yaml）`);
    }

    const providerNames = new Set(providers.map(provider => provider.name));
    const defaultProvider = raw.defaults.provider;
    if (defaultProvider && !providerNames.has(defaultProvider)) {
        throw new ConfigError(`配置文件 ${file} 的 defaults.provider 指向不存在的 provider：${defaultProvider}`);
    }

    return {
        file,
        providers,
        defaults: {
            ...(defaultProvider ? { provider: defaultProvider } : {}),
            ...(raw.defaults.model ? { model: raw.defaults.model } : {}),
            ...(raw.defaults.reasoningEffort ? { reasoningEffort: raw.defaults.reasoningEffort } : {}),
        },
        runtime: {
            ...raw.runtime,
            ...(raw.runtime.identityFile ? { identityFile: expandHome(raw.runtime.identityFile) } : {}),
            ...(raw.runtime.extraIdentityFile ? { extraIdentityFile: expandHome(raw.runtime.extraIdentityFile) } : {}),
        },
        network: {
            ...(raw.network.proxy ? { proxy: expandHome(raw.network.proxy) } : {}),
            ...(raw.network.openaiProxy ? { openaiProxy: expandHome(raw.network.openaiProxy) } : {}),
        },
        mcp: {
            ...(raw.mcp.serversFile ? { serversFile: expandHome(raw.mcp.serversFile) } : {}),
        },
        web: {
            ...(raw.web.token ? { token: raw.web.token } : {}),
            jobsMaxConcurrent: raw.web.jobsMaxConcurrent,
        },
        tui: { ...raw.tui },
    };
}

let cachedConfig: ZbotConfig | undefined;

/** 宿主启动时补的默认值：额外身份文件默认取 ~/.zbot/AGENTS.md，但不算用户配置。 */
let extraIdentityFileDefault: string | undefined;

export function setExtraIdentityFileDefault(file: string | undefined): void {
    extraIdentityFileDefault = file;
}

/** 额外身份文件：配置优先，其次宿主默认值。 */
export function getExtraIdentityFile(): string | undefined {
    return getConfig().runtime.extraIdentityFile ?? extraIdentityFileDefault;
}

/** 进程内的思考强度覆盖（`/model effort` 在没有会话时设置），不落盘。 */
let runtimeReasoningEffort: string | undefined;

export function getRuntimeReasoningEffort(): string | undefined {
    return runtimeReasoningEffort;
}

export function setRuntimeReasoningEffort(value: string | undefined): void {
    runtimeReasoningEffort = value;
}

/** 当前配置（首次调用读盘后缓存）。 */
export function getConfig(): ZbotConfig {
    if (!cachedConfig) cachedConfig = parseConfig(readConfigFile(getConfigFilePath()));
    return cachedConfig;
}

/** 丢掉缓存：配置变更或测试换文件后重新加载。 */
export function reloadConfig(): ZbotConfig {
    cachedConfig = undefined;
    return getConfig();
}

export function getProviders(): ProviderConfig[] {
    return getConfig().providers;
}

export function getProvider(name: string): ProviderConfig | undefined {
    return getProviders().find(provider => provider.name === name);
}

export function getRuntimeConfig(): RuntimeConfig {
    return getConfig().runtime;
}

export function getNetworkConfig(): NetworkConfig {
    return getConfig().network;
}

export function getMcpConfig(): McpConfig {
    return getConfig().mcp;
}

export function getWebConfig(): WebConfig {
    return getConfig().web;
}

export function getTuiConfig(): TuiConfig {
    return getConfig().tui;
}

/** 默认模型目标：配置里的 defaults.provider/model，落在第一个 provider 的模型上。 */
export function getDefaultModelTarget(): DefaultModelTarget {
    const config = getConfig();
    const provider = config.defaults.provider
        ? config.providers.find(candidate => candidate.name === config.defaults.provider)!
        : config.providers[0]!;
    const model = config.defaults.model ?? provider.models[0] ?? "";
    return {
        provider: provider.name,
        model,
        ...(config.defaults.reasoningEffort ? { reasoningEffort: config.defaults.reasoningEffort } : {}),
    };
}
