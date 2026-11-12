/**
 * 状态栏内容模型：把 store / 环境里的散数据算成两行状态栏文本。
 * 纯函数，不碰 TUI 组件与定时器；峰谷倒计时启停、重绘等副作用留在 app.ts。
 */

import { formatCostYuan, goDurationMinutes } from "../pricing/deepseek.js";
import { formatElapsedDuration } from "../utils/time.js";
import { formatCompactTokens } from "../utils/token-budget.js";
import { SPINNER_FRAMES } from "./session-marker.js";
import { theme } from "./theme.js";
import type { RequestRate } from "./store.js";

/** 执行阶段快照（与 app.ts 的 SessionPhaseState 结构兼容）。 */
type StatusPhase = {
    phase: "waiting" | "reasoning" | "tool" | "generating" | "compacting";
    startTime: number;
    toolName?: string;
    toolStartTime?: number;
    message?: string;
};

export interface StatusBarInput {
    modelName: string;
    effort: string;
    sessionId: string | null;
    phase?: StatusPhase;
    spinnerIndex: number;
    /** 当前时间戳（毫秒）；由调用方注入，便于测试。 */
    now: number;
    /** 正在等用户作答的会话数（提问挂起，tab 条同时打 `?` 标记）。 */
    awaitingAnswer?: number;
    /** 当前会话仍在运行的后台 shell 任务数；0 或省略时不占位。 */
    backgroundRunning?: number;
    /** 上下文占用（唯一事实来源，来自 store.contextTokens）。 */
    contextTokens: number;
    /** 上下文数值来源：provider = 上游实测；local = 本地估算（显示更淡）。 */
    contextSource?: "provider" | "local";
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    reasoningTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    costYuan: number;
    lastRate?: RequestRate;
    cwd: string;
    home?: string;
    /** 是否按 DeepSeek 官方价格表计费（官方端点或开启 runtime.deepseekCostStat）。 */
    isDeepSeekPriced: boolean;
    deepSeek?: { phase: "peak" | "offpeak"; switchInMs: number };
    contextWindow: number;
}

export interface StatusBarModel {
    line1: { left: string; right: string };
    line2: { left: string; right: string };
}

/** 运行阶段提示：`⠋ 思考中... (1.2s)`，工具执行超 3s 时附带工具耗时。 */
function buildPhaseHint(phase: StatusPhase | undefined, spinnerIndex: number, now: number): string {
    if (!phase) return "";

    const spinnerChar = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
    const elapsed = formatElapsedDuration(now - phase.startTime);
    let phaseText = "等待响应...";
    if (phase.phase === "reasoning") {
        phaseText = "思考中...";
    } else if (phase.phase === "tool") {
        phaseText = `执行工具 ${phase.toolName || ""}...`;
    } else if (phase.phase === "generating") {
        phaseText = "生成回复...";
    } else if (phase.phase === "compacting") {
        phaseText = phase.message || "压缩上下文...";
    }

    let timingText = elapsed;
    if (phase.phase === "tool" && phase.toolStartTime) {
        const toolElapsedMs = now - phase.toolStartTime;
        if (toolElapsedMs >= 3000) {
            timingText = `${formatElapsedDuration(toolElapsedMs)} | ${elapsed}`;
        }
    }
    return theme.commandText(`${spinnerChar} ${phaseText} (${timingText})`);
}

/** 速率标签：`⚡45T/s (🤔35 ✏️10)`，整个会话的累计平均；括号内为阶段速率，缺对应阶段时省略。 */
export function formatRateTag(rate: RequestRate, isStale: boolean): string {
    const parts: string[] = [];
    if (rate.reasoningTps !== undefined) parts.push(`🤔${Math.round(rate.reasoningTps)}`);
    if (rate.outputTps !== undefined) parts.push(`✏️${Math.round(rate.outputTps)}`);
    const detail = parts.length > 0 ? ` (${parts.join(" ")})` : "";
    const text = `⚡${Math.round(rate.totalTps)}T/s${detail}`;
    return isStale ? theme.dim(text) : text;
}

/** Token 统计：上下文占用 / 累计 / 输入输出 / 思考 / 缓存命中率，逐项按需出现。 */
function buildTokenStats(input: StatusBarInput): string {
    const parts: string[] = [];
    const { contextTokens, contextWindow, contextSource } = input;

    // 上下文占用单独着色：来源为本地估算时更淡，避免把估算值当成上游实测
    let contextPart = "";
    if (contextTokens > 0 && contextWindow > 0) {
        const ctxRate = `${((contextTokens / contextWindow) * 100).toFixed(1)}%`;
        const text = `${formatCompactTokens(contextTokens)}/${formatCompactTokens(contextWindow)}(${ctxRate})`;
        contextPart = contextSource === "local" ? theme.faint(text) : theme.dim(text);
    }
    if (input.totalTokens > 0) {
        parts.push(`Σ${formatCompactTokens(input.totalTokens)}`);
    }
    if (input.promptTokens > 0) {
        parts.push(`${formatCompactTokens(input.promptTokens)}=>${formatCompactTokens(input.completionTokens)}`);
    } else if (input.completionTokens > 0) {
        // 上游不给输入侧 token（如 llm-deepseek-web）时只报生成量，避免把「不可得」显示成 0
        parts.push(`→${formatCompactTokens(input.completionTokens)}`);
    }
    if (input.reasoningTokens > 0) {
        parts.push(`🤔${formatCompactTokens(input.reasoningTokens)}`);
    }
    const cacheTotal = input.cacheHitTokens + input.cacheMissTokens;
    if (cacheTotal > 0) {
        const cacheRate = `${((input.cacheHitTokens / cacheTotal) * 100).toFixed(1)}%`;
        parts.push(
            `🎯${cacheRate}(${formatCompactTokens(input.cacheHitTokens)}/${formatCompactTokens(input.cacheMissTokens)})`,
        );
    }
    const detailPart = parts.length > 0 ? theme.dim(parts.join(" ")) : "";
    return [contextPart, detailPart].filter(Boolean).join(" ");
}

/** 组装两行状态栏文本。 */
export function buildStatusBarModel(input: StatusBarInput): StatusBarModel {
    const modelTag = theme.dim(`${input.modelName} · 🧠 ${input.effort}`);
    const sessionTag = input.sessionId ? theme.dim(input.sessionId) : theme.dim("无会话");

    const statusHint = buildPhaseHint(input.phase, input.spinnerIndex, input.now);
    const tokens = buildTokenStats(input);

    // 官方 DeepSeek 费用估算（仅官方接入且产生费用时显示），紧跟 Token 统计右侧。
    const costPart = input.costYuan > 0 ? theme.statusOk(` ${formatCostYuan(input.costYuan)}`) : "";

    // 峰谷倒计时（分钟精度）；无 token/费用统计时省略分隔点，避免新会话出现孤立的 "·"
    let countdownPart = "";
    if (input.isDeepSeekPriced && input.deepSeek) {
        const phaseLabel = input.deepSeek.phase === "peak" ? "高峰" : "空闲";
        const separator = tokens || costPart ? " · " : " ";
        countdownPart = theme.dim(`${separator}${phaseLabel}剩${goDurationMinutes(input.deepSeek.switchInMs)}`);
    }

    const statsLeft = [tokens ? ` ${tokens}` : "", costPart, countdownPart].join("");

    // 第 1 行右侧：阶段提示 + 当前目录（home 缩写 ~）
    const cwdTag = theme.dim(
        input.home && input.cwd.startsWith(input.home) ? `~${input.cwd.slice(input.home.length)}` : input.cwd,
    );
    // 有会话挂着未作答的提问时置前提示：提问浮层不一定在当前会话上，只有 tab 标记容易漏看
    const questionTag = input.awaitingAnswer
        ? theme.statusWarn(`❓${input.awaitingAnswer} 待作答`)
        : "";
    // 后台任务没有浮层可看，只能在这里体现；否则用户看不出还有长任务在跑
    const backgroundTag = input.backgroundRunning
        ? theme.dim(`⚙${input.backgroundRunning} 后台`)
        : "";
    const line1Right = [questionTag, backgroundTag, statusHint, cwdTag].filter(Boolean).join("  ");

    // 第 1 行左侧末尾：会话累计平均生成速率；请求进行中置灰表示还没算上本轮
    const rateTag = input.lastRate ? formatRateTag(input.lastRate, input.phase !== undefined) : "";
    const line1Left = rateTag ? `${modelTag} ${rateTag}` : modelTag;

    return {
        line1: { left: ` ${line1Left}`, right: line1Right },
        line2: { left: statsLeft, right: sessionTag },
    };
}
