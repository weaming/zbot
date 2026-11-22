/**
 * 状态栏内容模型：把 store / 环境里的散数据算成状态栏文本。
 * 宽屏（>= 80 列）保持经典双行；窄屏（手机屏幕 < 80 列）自动切为 2–4 行紧凑布局，
 * 优先保证实时状态、模型、上下文占比、费用、精简目录与短会话 ID 可见。
 * 纯函数，不碰 TUI 组件与定时器；峰谷倒计时启停、重绘等副作用留在 app.ts。
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { truncatePath } from "../format/path.js";
import { truncatePlain } from "../format/text.js";
import { formatCostYuan, goDurationMinutes } from "../pricing/deepseek.js";
import { shortSessionId } from "../utils/session-id.js";
import { formatElapsedDuration } from "../utils/time.js";
import { formatCompactTokens } from "../utils/token-budget.js";
import { SPINNER_FRAMES } from "./session-marker.js";
import { theme } from "./theme.js";
import type { RequestRate } from "./store.js";

/** 低于该列宽时切换窄屏多行紧凑布局。 */
const NARROW_STATUS_BAR_WIDTH = 80;

const WIDE_RIGHT_PADDING = 2;
const NARROW_SIDE_PADDING = 1;
const MEDIUM_NARROW_WIDTH = 56;

const EFFORT_SHORT_LABELS: Record<string, string> = {
    minimal: "min",
    none: "off",
    low: "L",
    medium: "M",
    high: "H",
    xhigh: "XH",
};

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
    /** 协议后缀（如 chat / responses），宽屏拼接显示，窄屏自动省略。 */
    protocolLabel?: string;
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

/** 组装宽屏两行状态栏文本。 */
export function buildStatusBarModel(input: StatusBarInput): StatusBarModel {
    const displayModelName = input.protocolLabel
        ? `${input.modelName} (${input.protocolLabel})`
        : input.modelName;
    const modelTag = theme.dim(`${displayModelName} · 🧠 ${input.effort}`);
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

/** 单行左右对齐渲染：宽屏左侧优先，窄屏支持右侧优先与紧凑内边距。 */
export function renderWideStatusLine(leftText: string, rightText: string, safeWidth: number): string {
    if (!leftText && !rightText) {
        return " ".repeat(safeWidth);
    }
    if (visibleWidth(leftText) >= safeWidth) {
        return truncateToWidth(leftText, safeWidth);
    }

    const availableRightWidth = Math.max(
        0,
        safeWidth - visibleWidth(leftText) - 1 - WIDE_RIGHT_PADDING,
    );
    const truncatedRight = truncateToWidth(rightText, availableRightWidth, "…");
    const gap = Math.max(
        1,
        safeWidth
            - visibleWidth(leftText)
            - visibleWidth(truncatedRight)
            - WIDE_RIGHT_PADDING,
    );
    return `${leftText}${" ".repeat(gap)}${truncatedRight}${" ".repeat(WIDE_RIGHT_PADDING)}`;
}

/** 窄屏单行左右对齐渲染：带左右对称内边距，右侧内容优先不被挤掉。 */
function renderNarrowLine(leftText: string, rightText: string, safeWidth: number): string {
    const sidePadding = safeWidth >= 4 ? NARROW_SIDE_PADDING : 0;
    const innerWidth = Math.max(1, safeWidth - sidePadding * 2);
    const pad = " ".repeat(sidePadding);

    if (!leftText && !rightText) {
        return " ".repeat(safeWidth);
    }
    if (!rightText) {
        const body = truncateToWidth(leftText, innerWidth, "…");
        const tailPad = " ".repeat(Math.max(0, innerWidth - visibleWidth(body)));
        return `${pad}${body}${tailPad}${pad}`;
    }
    if (!leftText) {
        const body = truncateToWidth(rightText, innerWidth, "…");
        const leadPad = " ".repeat(Math.max(0, innerWidth - visibleWidth(body)));
        return `${pad}${leadPad}${body}${pad}`;
    }

    const fittedRight = truncateToWidth(rightText, innerWidth, "…");
    const rightWidth = visibleWidth(fittedRight);
    const maxLeftWidth = innerWidth - rightWidth - 1;
    if (maxLeftWidth <= 0) {
        const leadPad = " ".repeat(Math.max(0, innerWidth - rightWidth));
        return `${pad}${leadPad}${fittedRight}${pad}`;
    }

    const fittedLeft = truncateToWidth(leftText, maxLeftWidth, "…");
    const gap = Math.max(1, innerWidth - visibleWidth(fittedLeft) - rightWidth);
    return `${pad}${fittedLeft}${" ".repeat(gap)}${fittedRight}${pad}`;
}

/** 缩写思考强度，窄屏下减少占位。 */
function formatEffortShort(effort: string): string {
    return EFFORT_SHORT_LABELS[effort.toLowerCase()] ?? effort;
}

/** 紧凑速率标签：仅保留总吞吐，省略分阶段细节。 */
function formatCompactRateTag(rate: RequestRate, isStale: boolean): string {
    const text = `⚡${Math.round(rate.totalTps)}T/s`;
    return isStale ? theme.dim(text) : text;
}

/** 窄屏运行阶段文案：优先保证计时完整显示，仅在必要时截断工具名/阶段说明。 */
function buildNarrowPhaseHint(
    phase: StatusPhase,
    spinnerIndex: number,
    now: number,
    maxWidth: number,
    isMediumWidth: boolean,
): string {
    const spinnerChar = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
    const elapsed = formatElapsedDuration(now - phase.startTime);

    let timingText = elapsed;
    if (phase.phase === "tool" && phase.toolStartTime) {
        const toolElapsedMs = now - phase.toolStartTime;
        if (toolElapsedMs >= 3000) {
            timingText = `${formatElapsedDuration(toolElapsedMs)}|${elapsed}`;
        }
    }

    let label = "等待...";
    if (phase.phase === "reasoning") {
        label = isMediumWidth ? "思考中..." : "思考...";
    } else if (phase.phase === "tool") {
        const toolName = phase.toolName || "工具";
        label = isMediumWidth ? `工具 ${toolName}` : toolName;
    } else if (phase.phase === "generating") {
        label = isMediumWidth ? "生成回复..." : "生成...";
    } else if (phase.phase === "compacting") {
        label = phase.message || "压缩...";
    }

    const prefix = `${spinnerChar} `;
    const suffix = ` (${timingText})`;
    const fixedWidth = visibleWidth(prefix) + visibleWidth(suffix);
    if (maxWidth <= fixedWidth + 1) {
        return theme.commandText(truncatePlain(`${prefix}(${timingText})`, maxWidth));
    }

    const fittedLabel = truncatePlain(label, maxWidth - fixedWidth);
    return theme.commandText(`${prefix}${fittedLabel}${suffix}`);
}

/** 窄屏实时状态行：仅在有阶段、待作答或后台任务时显示，独占首行避免被挤掉。 */
function buildNarrowLiveLine(input: StatusBarInput, safeWidth: number): string | null {
    const hasPhase = input.phase !== undefined;
    const hasQuestion = (input.awaitingAnswer ?? 0) > 0;
    const hasBackground = (input.backgroundRunning ?? 0) > 0;
    if (!hasPhase && !hasQuestion && !hasBackground) return null;

    const isMediumWidth = safeWidth >= MEDIUM_NARROW_WIDTH;
    const sidePadding = safeWidth >= 4 ? NARROW_SIDE_PADDING : 0;
    const innerWidth = Math.max(1, safeWidth - sidePadding * 2);

    const badges: string[] = [];
    if (hasQuestion) {
        const text = isMediumWidth ? `❓${input.awaitingAnswer} 待答` : `❓${input.awaitingAnswer}`;
        badges.push(theme.statusWarn(text));
    }
    if (hasBackground) {
        const text = isMediumWidth ? `⚙${input.backgroundRunning} 后台` : `⚙${input.backgroundRunning}`;
        badges.push(theme.dim(text));
    }
    const badgesText = badges.join(" ");

    if (!input.phase) {
        return renderNarrowLine(badgesText, "", safeWidth);
    }

    const badgesWidth = visibleWidth(badgesText);
    const maxPhaseWidth = badgesWidth > 0 ? Math.max(8, innerWidth - badgesWidth - 1) : innerWidth;
    const phaseText = buildNarrowPhaseHint(
        input.phase,
        input.spinnerIndex,
        input.now,
        maxPhaseWidth,
        isMediumWidth,
    );
    return renderNarrowLine(phaseText, badgesText, safeWidth);
}

/** 窄屏模型与速率行：省略协议后缀、精简 effort 与速率，超长模型名按剩余宽度截断。 */
function buildNarrowModelLine(input: StatusBarInput, safeWidth: number): string {
    const sidePadding = safeWidth >= 4 ? NARROW_SIDE_PADDING : 0;
    const innerWidth = Math.max(1, safeWidth - sidePadding * 2);
    const isMediumWidth = safeWidth >= MEDIUM_NARROW_WIDTH;

    const effortText = isMediumWidth
        ? ` · 🧠 ${input.effort}`
        : ` · 🧠${formatEffortShort(input.effort)}`;
    const isStaleRate = input.phase !== undefined;

    let rateTag = "";
    if (input.lastRate) {
        const fullRate = formatRateTag(input.lastRate, isStaleRate);
        const compactRate = formatCompactRateTag(input.lastRate, isStaleRate);
        const fullModelLineWidth = visibleWidth(`${input.modelName}${effortText}`);
        if (isMediumWidth && fullModelLineWidth + 1 + visibleWidth(fullRate) <= innerWidth) {
            rateTag = fullRate;
        } else {
            rateTag = compactRate;
        }
    }

    const rateWidth = visibleWidth(rateTag);
    const effortWidth = visibleWidth(effortText);
    const minModelWidth = 10;

    // 宽度极窄时先放弃速率，优先保住模型名与思考强度
    if (rateWidth > 0 && innerWidth - rateWidth - 1 - effortWidth < minModelWidth) {
        rateTag = "";
    }

    const finalRateWidth = visibleWidth(rateTag);
    const leftBudget = finalRateWidth > 0 ? innerWidth - finalRateWidth - 1 : innerWidth;
    const modelBudget = Math.max(4, leftBudget - effortWidth);
    const fittedModel = truncatePlain(input.modelName, modelBudget);
    const leftText = theme.dim(`${fittedModel}${effortText}`);

    return renderNarrowLine(leftText, rateTag, safeWidth);
}

/** 窄屏统计行：上下文占比与费用优先，其余指标按块贪心填入、绝不截断半个数字。 */
function buildNarrowStatsLine(input: StatusBarInput, safeWidth: number): string | null {
    const costText = input.costYuan > 0 ? theme.statusOk(formatCostYuan(input.costYuan)) : "";

    const blocks: string[] = [];
    if (input.contextTokens > 0 && input.contextWindow > 0) {
        const ctxRate = `${((input.contextTokens / input.contextWindow) * 100).toFixed(1)}%`;
        const text = `${formatCompactTokens(input.contextTokens)}/${formatCompactTokens(input.contextWindow)}(${ctxRate})`;
        blocks.push(input.contextSource === "local" ? theme.faint(text) : theme.dim(text));
    }
    if (input.totalTokens > 0) {
        blocks.push(theme.dim(`Σ${formatCompactTokens(input.totalTokens)}`));
    }
    if (input.isDeepSeekPriced && input.deepSeek) {
        const phaseLabel = input.deepSeek.phase === "peak" ? "高峰" : "空闲";
        blocks.push(theme.dim(`${phaseLabel}剩${goDurationMinutes(input.deepSeek.switchInMs)}`));
    }
    const cacheTotal = input.cacheHitTokens + input.cacheMissTokens;
    if (cacheTotal > 0) {
        const cacheRate = `${((input.cacheHitTokens / cacheTotal) * 100).toFixed(0)}%`;
        blocks.push(theme.dim(`🎯${cacheRate}`));
    }
    if (input.promptTokens > 0) {
        blocks.push(
            theme.dim(`${formatCompactTokens(input.promptTokens)}=>${formatCompactTokens(input.completionTokens)}`),
        );
    } else if (input.completionTokens > 0) {
        blocks.push(theme.dim(`→${formatCompactTokens(input.completionTokens)}`));
    }
    if (input.reasoningTokens > 0) {
        blocks.push(theme.dim(`🤔${formatCompactTokens(input.reasoningTokens)}`));
    }

    if (blocks.length === 0 && !costText) return null;

    const sidePadding = safeWidth >= 4 ? NARROW_SIDE_PADDING : 0;
    const innerWidth = Math.max(1, safeWidth - sidePadding * 2);
    const costWidth = visibleWidth(costText);
    const leftBudget = costWidth > 0 ? Math.max(0, innerWidth - costWidth - 1) : innerWidth;

    const selected: string[] = [];
    let usedWidth = 0;
    for (const block of blocks) {
        const blockWidth = visibleWidth(block);
        const separatorWidth = selected.length > 0 ? 1 : 0;
        if (selected.length === 0) {
            selected.push(block);
            usedWidth = blockWidth;
            continue;
        }
        if (usedWidth + separatorWidth + blockWidth <= leftBudget) {
            selected.push(block);
            usedWidth += separatorWidth + blockWidth;
        }
    }

    return renderNarrowLine(selected.join(" "), costText, safeWidth);
}

/** 精简当前目录：放得下保留 ~ 缩写路径，放不下优先展示末级目录名。 */
function formatCompactCwd(cwd: string, home: string | undefined, maxWidth: number): string {
    const normalized = cwd.replace(/[\\/]+$/, "");
    if (!normalized) return cwd || "/";

    const homeShort = home && normalized === home
        ? "~"
        : home && normalized.startsWith(`${home}/`)
            ? `~${normalized.slice(home.length)}`
            : normalized;
    if (visibleWidth(homeShort) <= maxWidth) {
        return homeShort;
    }

    const lastSlash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
    const baseName = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
    if (baseName && visibleWidth(baseName) <= maxWidth) {
        return baseName;
    }
    return truncatePath(baseName || homeShort, maxWidth);
}

/** 窄屏底行：左侧精简目录，右侧末 8 位短会话 ID。 */
function buildNarrowMetaLine(input: StatusBarInput, safeWidth: number): string {
    const sidePadding = safeWidth >= 4 ? NARROW_SIDE_PADDING : 0;
    const innerWidth = Math.max(1, safeWidth - sidePadding * 2);

    const sessionLabel = input.sessionId ? shortSessionId(input.sessionId) : "无会话";
    const sessionTag = theme.dim(sessionLabel);
    const dirBudget = Math.max(4, innerWidth - visibleWidth(sessionTag) - 1);
    const cwdTag = theme.dim(formatCompactCwd(input.cwd, input.home, dirBudget));

    return renderNarrowLine(cwdTag, sessionTag, safeWidth);
}

/** 按终端列宽渲染状态栏行：宽屏 2 行，窄屏按需 2–4 行。 */
export function renderStatusBarLines(input: StatusBarInput, width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    if (safeWidth >= NARROW_STATUS_BAR_WIDTH) {
        const model = buildStatusBarModel(input);
        return [
            renderWideStatusLine(model.line1.left, model.line1.right, safeWidth),
            renderWideStatusLine(model.line2.left, model.line2.right, safeWidth),
        ];
    }

    const lines: string[] = [];
    const liveLine = buildNarrowLiveLine(input, safeWidth);
    if (liveLine) lines.push(liveLine);
    lines.push(buildNarrowModelLine(input, safeWidth));
    const statsLine = buildNarrowStatsLine(input, safeWidth);
    if (statsLine) lines.push(statsLine);
    lines.push(buildNarrowMetaLine(input, safeWidth));
    return lines;
}
