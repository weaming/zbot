/**
 * 已知 System One 兼容端点的预设。
 *
 * 这些服务共用同一套请求/响应结构，仅 base URL、模型名与密钥来源不同，
 * 因此用工厂函数收敛配置，避免各处散落字符串。
 */

import { DecisionProvider, type ProviderOptions } from "./provider.js";
import { readEnvValue } from "../utils/env-ref.js";

/** 指定 Liquid 决策模型的环境变量，覆盖其默认模型。 */
export const LIQUID_MODEL_ENV = "LIQUID_MODEL";

/** Liquid AI：d1 / d1-ultra，支持图像输入，零数据保留。 */
export const LIQUID_BASE_URL = "https://api.liquid.ai";
/** TypeSafe 官方 Jev。 */
export const TYPESAFE_BASE_URL = "https://api.typesafe.ai";
/** jevstyle 社区的 Jev-Style 2B 免费托管。 */
export const JEVSTYLE_BASE_URL = "https://api.jevstyle.com";
/** Mercury Decide 走 OpenRouter 的 decisions 端点（路径与 System One 不同）。 */
export const OPENROUTER_BASE_URL = "https://openrouter.ai";

type ProviderOverrides = Partial<Omit<ProviderOptions, "apiKey">> & { apiKey?: string };

/**
 * 解析模型名的优先级：显式参数 > 环境变量 > provider 默认值。
 * 空白字符串视为未设置。
 */
function resolveModel(
    explicit: string | undefined,
    envName: string,
    fallback: string,
): string {
    const candidate = explicit ?? process.env[envName];
    const trimmed = candidate?.trim();
    return trimmed ? trimmed : fallback;
}

/** 从环境变量取密钥，缺失时给出明确错误而不是发出匿名请求。 */
function requireKey(envName: string, explicit?: string): string {
    const value = explicit ?? readEnvValue(envName);
    if (!value?.trim()) {
        throw new Error(`缺少 API 密钥：请设置 ${envName} 或显式传入 apiKey`);
    }
    return value;
}

/** Liquid AI 的 d1 / d1-ultra。 */
export function createLiquid(options: ProviderOverrides = {}): DecisionProvider {
    return new DecisionProvider("liquid", {
        baseUrl: options.baseUrl ?? LIQUID_BASE_URL,
        apiKey: requireKey("LIQUID_API_KEY", options.apiKey),
        model: resolveModel(options.model, LIQUID_MODEL_ENV, "d1"),
        ...rest(options),
    });
}

/** TypeSafe 官方 Jev。 */
export function createTypeSafe(options: ProviderOverrides = {}): DecisionProvider {
    return new DecisionProvider("typesafe", {
        baseUrl: options.baseUrl ?? TYPESAFE_BASE_URL,
        apiKey: requireKey("TYPESAFE_API_KEY", options.apiKey),
        model: resolveModel(options.model, "TYPESAFE_MODEL", "jev-latest"),
        ...rest(options),
    });
}

/** jevstyle 免费托管（每天 1 万次）。 */
export function createJevStyle(options: ProviderOverrides = {}): DecisionProvider {
    return new DecisionProvider("jevstyle", {
        baseUrl: options.baseUrl ?? JEVSTYLE_BASE_URL,
        apiKey: requireKey("JEVSTYLE_API_KEY", options.apiKey),
        model: resolveModel(options.model, "JEVSTYLE_MODEL", "jev-style-2b-decision-v3"),
        ...rest(options),
    });
}

/** OpenRouter 上的免费 decisions 模型。端点路径不同，故单独覆盖。 */
class OpenRouterDecisionProvider extends DecisionProvider {
    protected endpointPath(): string {
        return "/api/alpha/decisions";
    }
}

export function createMercury(options: ProviderOverrides = {}): DecisionProvider {
    return new OpenRouterDecisionProvider("mercury", {
        baseUrl: options.baseUrl ?? OPENROUTER_BASE_URL,
        apiKey: requireKey("OPENROUTER_API_KEY", options.apiKey),
        model: resolveModel(options.model, "MERCURY_MODEL", "inception/mercury-decide:free"),
        ...rest(options),
    });
}

/** 去掉已消费的字段，避免重复展开。 */
function rest(options: ProviderOverrides): Omit<ProviderOptions, "baseUrl" | "apiKey" | "model"> {
    const { baseUrl: _b, apiKey: _k, model: _m, ...others } = options;
    return others;
}
