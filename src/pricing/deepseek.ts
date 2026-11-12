/**
 * DeepSeek 官方计费判定与费用估算。
 *
 * 仅当接入端点为官方（host 为 api.deepseek.com）且模型命中官方价格表时计费；
 * 第三方中转 / 网关（即使跑的也是 deepseek 模型）一律不计，避免误算。
 * 显式打开 runtime.deepseekCostStat 时放宽端点限制：局域网网关（如本机 llm-server
 * 完整透传到官方 API）也按官方价格表估算，仍要求模型命中价格表。
 */

import type { UsageInfo } from "../types/chat.js";
import { getRuntimeConfig } from "../config/index.js";
import {
    DEEPSEEK_PRICING,
    type DeepSeekModelKey,
    type DeepSeekPriceBand,
    type DeepSeekPriceSnapshot,
} from "./deepseek-pricing.js";

/** 官方 OpenAI/Anthropic 兼容端点的 host（Anthropic 格式为 https://api.deepseek.com/anthropic，host 相同）。 */
export const DEEPSEEK_OFFICIAL_HOST = "api.deepseek.com";

/** 放开端点限制、对局域网网关也统计费用：`runtime.deepseekCostStat`。 */
export function isDeepSeekCostStatEnabled(enabled = getRuntimeConfig().deepseekCostStat): boolean {
    return enabled;
}

/**
 * 官方模型名 → 价格档。按顺序匹配，先命中先返回。
 * vision 系列与 flash 同价，因此统一归 flash 档。
 */
const MODEL_KEY_PATTERNS: Array<[DeepSeekModelKey, string]> = [
    ["flash", "deepseek-v4-flash"],
    // V4.1 Flash 当前唯一在服务的正式模型名
    ["flash", "deepseek-flash"],
    ["pro", "deepseek-v4-pro"],
];

/**
 * 宽松匹配：模型名同时含 `deepseek` 与 `flash` 或 `pro` 关键词。
 * 仅用于开启 deepseekCostStat 的第三方端点（网关常给模型名加厂商前缀与地域后缀，
 * 如 workbuddy-ai/deepseek-v4.1-flash-sg）。
 */
const LOOSE_MODEL_KEY_PATTERNS: Array<[DeepSeekModelKey, RegExp]> = [
    ["flash", /flash/],
    // 含 pro 但不是 flash 的一律按 pro 档
    ["pro", /pro/],
];

/**
 * 模型名 → 价格档。`loose` 为 true 时改用关键词宽松匹配（第三方网关场景）。
 * 官方价格表之外的模型名（如已停用的 deepseek-chat/reasoner）返回 undefined，不计费。
 */
export function normalizeDeepSeekModel(model?: string, loose = false): DeepSeekModelKey | undefined {
    if (!model) return undefined;
    const normalized = model.trim().toLowerCase();

    if (loose) {
        // 网关前缀/后缀随意，但必须是 DeepSeek 模型：否则 any-flash 这类别名会被误计价
        if (!normalized.includes("deepseek")) return undefined;
        for (const [key, pattern] of LOOSE_MODEL_KEY_PATTERNS) {
            if (pattern.test(normalized)) return key;
        }
        return undefined;
    }

    for (const [key, token] of MODEL_KEY_PATTERNS) {
        if (normalized.includes(token)) return key;
    }
    return undefined;
}

/** 取 URL 的 host（小写）；空值或无法解析返回 undefined。 */
export function endpointHost(url?: string): string | undefined {
    if (!url) return undefined;
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return undefined;
    }
}

/** 接入端点是否指向 DeepSeek 官方（host 精确匹配 api.deepseek.com）。 */
export function isOfficialDeepSeekEndpoint(apiBase?: string): boolean {
    return endpointHost(apiBase) === DEEPSEEK_OFFICIAL_HOST;
}

/**
 * 接入端是否跑 DeepSeek 模型：模型名含 deepseek，或端点就是官方 host。
 * 两者任一命中都按 DeepSeek 口径处理（能力集合、计费、工具形态都依赖它）。
 */
export function isDeepSeekEndpoint(model: string, baseURL?: string): boolean {
    return model.toLowerCase().includes("deepseek") || isOfficialDeepSeekEndpoint(baseURL);
}

/**
 * 是否为高峰时段：北京时间周一至周五 9:00-12:00、14:00-18:00（半开区间）。
 * 上海无夏令时，用固定 +8 偏移换算，避免依赖运行环境 TZ。
 */
export function isDeepSeekPeakTime(atMs: number = Date.now()): boolean {
    const shanghai = new Date(atMs + 8 * 60 * 60 * 1000);
    const weekday = shanghai.getUTCDay(); // 0=周日
    const hour = shanghai.getUTCHours();
    const minute = shanghai.getUTCMinutes();

    const { weekdays, windows } = DEEPSEEK_PRICING.rule;
    if (!weekdays.includes(weekday)) return false;

    const minutes = hour * 60 + minute;
    return windows.some(([start, end]) => minutes >= start * 60 && minutes < end * 60);
}

export interface DeepSeekPhaseInfo {
    /** 当前所处时段 */
    phase: "peak" | "offpeak";
    /** 距下次峰谷切换的毫秒数（恒 > 0） */
    switchInMs: number;
}

const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const PEAK_BOUNDARY_HOURS = [9, 12, 14, 18];

/**
 * 下次峰谷切换信息：返回当前时段与距最近切换边界的时长。
 * 边界按北京时间的 09:00/12:00/14:00/18:00（工作日）生成；
 * 周末整天为谷，下一次切换即下个工作日 09:00 高峰开始。
 */
export function deepSeekPhaseInfo(atMs: number = Date.now()): DeepSeekPhaseInfo {
    const phase: "peak" | "offpeak" = isDeepSeekPeakTime(atMs) ? "peak" : "offpeak";
    const dayStartUtc = Math.floor((atMs + SHANGHAI_UTC_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_UTC_OFFSET_MS;

    // 从当天起最多向后看 8 天，必然覆盖周末（周五 18:00 后 → 下周一 09:00）
    for (let offset = 0; offset < 8; offset++) {
        const dayAt = dayStartUtc + offset * DAY_MS;
        const weekday = new Date(dayAt + SHANGHAI_UTC_OFFSET_MS).getUTCDay();
        if (!DEEPSEEK_PRICING.rule.weekdays.includes(weekday)) continue;

        for (const hour of PEAK_BOUNDARY_HOURS) {
            const boundaryAt = dayAt + hour * HOUR_MS;
            if (boundaryAt > atMs) {
                return { phase, switchInMs: boundaryAt - atMs };
            }
        }
    }
    // 理论上不可达（8 天内必有工作日），兜底回退 09:00
    const fallbackAt = dayStartUtc + 8 * DAY_MS + 9 * HOUR_MS;
    return { phase, switchInMs: Math.max(fallbackAt - atMs, 1) };
}

/** 分钟粒度的 Go Duration 风格时长（向上取整，最短 1m）：2h3m / 45m / 1m。状态栏倒计时用。 */
export function goDurationMinutes(durationMs: number): string {
    const totalMinutes = Math.max(1, Math.ceil(durationMs / 60_000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
    return `${minutes}m`;
}

/** 取 atMs 时刻生效的价格段（早于最早段时按最早段近似）。 */
export function deepSeekSnapshotAt(atMs: number): DeepSeekPriceSnapshot {
    let current = DEEPSEEK_PRICING.snapshots[0];
    for (const snapshot of DEEPSEEK_PRICING.snapshots) {
        if (atMs < Date.parse(snapshot.effectiveFrom)) break;
        current = snapshot;
    }
    return current;
}

function bandOf(modelKey: DeepSeekModelKey, atMs: number): DeepSeekPriceBand {
    const phase = isDeepSeekPeakTime(atMs) ? "peak" : "offpeak";
    return deepSeekSnapshotAt(atMs).models[modelKey][phase];
}

/** 参与计价的 usage 片段。 */
type CostUsage = Pick<UsageInfo, "model" | "promptTokens" | "cacheHitTokens" | "cacheMissTokens" | "completionTokens">;

/**
 * 官方 DeepSeek 单次 usage 的费用（元）。
 * 计价部分：输入（缓存命中/未命中）与输出（含 reasoning tokens，官方计入输出）；
 * 单价取调用时刻（atMs）生效的价格段，官方调价不影响历史复盘。
 * `looseModel` 为 true 时按关键词宽松匹配模型名（第三方网关场景）。
 * 价格表外的模型名返回 0。
 */
export function deepSeekCostYuan(usage: CostUsage, atMs: number = Date.now(), looseModel = false): number {
    const modelKey = normalizeDeepSeekModel(usage.model, looseModel);
    if (!modelKey) return 0;

    const band = bandOf(modelKey, atMs);
    const cacheHit = usage.cacheHitTokens ?? 0;
    const cacheMiss = usage.cacheMissTokens ?? Math.max(usage.promptTokens - cacheHit, 0);
    const output = usage.completionTokens ?? 0;

    return (
        (cacheHit / 1_000_000) * band.cacheHit
        + (cacheMiss / 1_000_000) * band.cacheMiss
        + (output / 1_000_000) * band.output
    );
}

export interface ChatProviderSettings {
    model?: string;
    apiBase?: string;
    /** runtime.deepseekCostStat：开启后不校验端点 host，局域网网关也按官方价格表估算。 */
    enableCostStat?: boolean;
}

/**
 * 仅当「可计费端点 + 价格表内模型」时按峰谷计价，否则返回 0（第三方不计）。
 * 可计费端点 = 官方 api.deepseek.com，或开启 runtime.deepseekCostStat 后的任意端点。
 * 官方端点按官方模型名严格匹配；开启开关的第三方端点改用「含 deepseek 且含 flash/pro」的宽松匹配。
 * 端点优先取 usage 落盘时的 host（历史记录不受日后更换 endpoint 影响），旧记录回退当前配置。
 */
export function officialDeepSeekCostYuan(usage: CostUsage & Pick<UsageInfo, "apiHost">, atMs: number, settings: ChatProviderSettings): number {
    const pricing = resolvePricingMode(usage.apiHost ?? endpointHost(settings.apiBase), settings);
    if (!pricing) return 0;
    return deepSeekCostYuan(usage, atMs, pricing.looseModel);
}

/**
 * 判断某端点应否按官方价格表计费，以及模型名该用严格还是宽松匹配。
 * 不计费（第三方且未开开关）返回 undefined。状态栏与计费共用此判定，避免两处漂移。
 */
export function resolvePricingMode(
    host: string | undefined,
    settings: ChatProviderSettings,
): { looseModel: boolean } | undefined {
    const isOfficial = host === DEEPSEEK_OFFICIAL_HOST;
    if (!isOfficial && settings.enableCostStat !== true) return undefined;
    // 官方端点用官方模型名；第三方端点放宽为关键词匹配
    return { looseModel: !isOfficial };
}

/** 费用展示：≥100 四舍五入到元；<0.005 显示 <0.01；其余保留 2 位小数，千分位分组。 */
export function formatCostYuan(yuan: number): string {
    if (!Number.isFinite(yuan) || yuan <= 0) return "¥0";
    if (yuan < 0.005) return "¥<0.01";

    const fixed = yuan >= 100 ? Math.round(yuan).toString() : yuan.toFixed(2);
    const [integer, decimal] = fixed.split(".");
    const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return decimal ? `¥${grouped}.${decimal}` : `¥${grouped}`;
}
