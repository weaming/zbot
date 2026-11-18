/**
 * 用量归一化与统计：把各上游口径不同的 usage 收成一份内部表示。
 *
 * 三种来源必须区分，绝不用本地估算冒充 provider 数据：
 *   - provider：常规上游，字段即本请求量
 *   - accumulated_delta：网关给会话累计值，需差分成本请求新增
 *   - unavailable：上游没给 usage，输入 token 保持未知
 */

import { createHash } from "node:crypto";
import type { LLMRequestKind, LLMUsageLogEntry } from "../../utils/logger.js";
import type { UsageInfo } from "../../types/chat.js";
import { estimateTextTokens } from "../../utils/token-estimator.js";

/** 差分基准的会话上限，超出后按插入序淘汰最老的一条。 */
const ACCUMULATED_USAGE_BASELINE_MAX = 512;

/** 每个会话上一次读到的「上游累计 token」，用于把累计值差分成本请求新增。 */
const accumulatedUsageBaseline = new Map<string, number>();

/**
 * 上游是否只给「会话累计」token：网关（llm-deepseek-web）用 x_usage_source 标注，
 * 该值是随会话单调增长的累计量（含新增输入），不是本请求的生成量。
 */
function isAccumulatedUsage(usage: any): boolean {
    return usage?.x_usage_source?.completion_tokens === "upstream";
}

/**
 * 把上游累计值差分成本请求新增（本请求 = 本次累计 − 上次累计）。
 * 累计回退（上游会话重建、网关重启）时无法差分，退回本次累计本身。
 */
function deltaOfAccumulatedUsage(sessionId: string | undefined, accumulated: number): number {
    if (!sessionId || accumulated <= 0) return accumulated;

    const baseline = accumulatedUsageBaseline.get(sessionId);
    accumulatedUsageBaseline.set(sessionId, accumulated);
    if (accumulatedUsageBaseline.size > ACCUMULATED_USAGE_BASELINE_MAX) {
        const oldest = accumulatedUsageBaseline.keys().next().value;
        if (oldest !== undefined) accumulatedUsageBaseline.delete(oldest);
    }

    if (baseline === undefined || accumulated <= baseline) return accumulated;
    return accumulated - baseline;
}

export interface UsageInput {
    model: string;
    /** provider 原始 usage（可能带网关附带的 x_usage_source）。 */
    usage: any;
    durationMs: number;
    apiHost?: string;
    sessionId?: string;
    /** 本次回复的正文与思考文本：上游不区分输入/输出时用它们估算生成量。 */
    outputText?: string;
    reasoningText?: string;
}

/** provider usage → 内部 UsageInfo（日志、UI、计费共用同一份口径）。 */
export function toUsageInfo(input: UsageInput): UsageInfo {
    const { model, usage, durationMs, apiHost, sessionId } = input;
    const promptTokens = usage?.prompt_tokens ?? 0;
    const cacheHitTokens = usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const accumulated = isAccumulatedUsage(usage);
    const completionTokens = accumulated
        ? deltaOfAccumulatedUsage(sessionId, usage?.completion_tokens ?? 0)
        : (usage?.completion_tokens ?? 0);
    const totalTokens = accumulated ? completionTokens : (usage?.total_tokens ?? promptTokens + completionTokens);

    return {
        model,
        // 记录落盘时的端点 host：回放历史按当时端点判定官方计费，不受日后更换 endpoint 影响
        ...(apiHost ? { apiHost } : {}),
        promptTokens,
        cacheHitTokens,
        cacheMissTokens: usage?.prompt_cache_miss_tokens ?? Math.max(promptTokens - cacheHitTokens, 0),
        completionTokens,
        reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        totalTokens,
        durationMs,
        ...(accumulated
            ? {
                outputTokens: estimateTextTokens(input.outputText ?? "") + estimateTextTokens(input.reasoningText ?? ""),
            }
            : {}),
    };
}

export interface UsageStatsInput {
    model: string;
    requestBody: Record<string, any>;
    response: any;
    requestStartedAt: number;
    requestKind: LLMRequestKind;
    sessionId?: string;
    contextEpochId?: string;
    /** 归一化后的用量：累计型上游已差分，日志与 UI/计费保持同一口径。 */
    normalized?: UsageInfo;
    now?: number;
}

/** 组装落盘用的用量条目（含诊断用的前缀 hash）。 */
export function buildUsageStats(input: UsageStatsInput): LLMUsageLogEntry {
    const { requestBody, response, normalized } = input;
    const usage = response.usage;
    const promptTokens = normalized?.promptTokens ?? usage?.prompt_tokens ?? 0;
    const cacheHitTokens = normalized?.cacheHitTokens ?? usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const cacheMissTokens = normalized?.cacheMissTokens ?? usage?.prompt_cache_miss_tokens ?? Math.max(promptTokens - cacheHitTokens, 0);
    const completionTokens = normalized?.completionTokens ?? usage?.completion_tokens ?? 0;
    const reasoningTokens = normalized?.reasoningTokens ?? usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    const totalTokens = normalized?.totalTokens ?? usage?.total_tokens ?? promptTokens + completionTokens;
    const responseContent = response.choices?.[0]?.message?.content ?? "";
    const outputText = typeof responseContent === "string" ? responseContent : JSON.stringify(responseContent);

    // 前缀 hash：分别对 system prompt 和工具 schema 取 hash，用于诊断缓存命中变化
    const systemContent = requestBody.messages?.[0]?.role === "system"
        ? requestBody.messages[0].content
        : requestBody.input?.find((item: any) => item?.role === "system")?.content ?? "";
    const systemHash = createHash("sha256").update(systemContent).digest("hex").slice(0, 16);
    const toolsHash = createHash("sha256").update(JSON.stringify(requestBody.tools ?? [])).digest("hex").slice(0, 16);
    const inputPayload = requestBody.messages ?? requestBody.input ?? [];

    return {
        timestamp: new Date(input.now ?? Date.now()).toISOString(),
        caller: "zbot",
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
        ...(input.contextEpochId ? { context_epoch_id: input.contextEpochId } : {}),
        request_kind: input.requestKind,
        model: response.model || input.model,
        prompt_tokens: promptTokens,
        cache_hit_tokens: cacheHitTokens,
        cache_miss_tokens: cacheMissTokens,
        completion_tokens: completionTokens,
        reasoning_tokens: reasoningTokens,
        total_tokens: totalTokens,
        input_chars: Array.from(JSON.stringify(inputPayload)).length,
        output_chars: Array.from(outputText).length,
        duration_ms: (input.now ?? Date.now()) - input.requestStartedAt,
        token_usage_source: usage ? "provider" : "unavailable",
        token_usage_semantics: isAccumulatedUsage(usage) ? "accumulated_delta" : "provider",
        system_hash: systemHash,
        tools_hash: toolsHash,
    };
}
