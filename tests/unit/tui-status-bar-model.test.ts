/**
 * 状态栏模型单测：纯函数，注入时间与数值，断言两行文本。
 */

import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
    buildStatusBarModel,
    formatRateTag,
    renderStatusBarLines,
    type StatusBarInput,
} from "../../src/tui/status-bar-model.js";
import { StatusBar } from "../../src/tui/status-bar.js";

/** 去掉 CSI 颜色与 OSC 超链接，只看可见文本。 */
function plain(text: string): string {
    return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

function input(overrides: Partial<StatusBarInput> = {}): StatusBarInput {
    return {
        modelName: "deepseek-chat",
        effort: "high",
        sessionId: "sess-abcdef123456",
        spinnerIndex: 0,
        now: 1_000_000,
        contextTokens: 0,
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        costYuan: 0,
        cwd: "/project",
        isChatObserver: false,
        isDeepSeekPriced: false,
        contextWindow: 0,
        ...overrides,
    };
}

describe("状态栏模型", () => {
    test("无 token 统计时第二行左为空，右侧显示会话 id", () => {
        const model = buildStatusBarModel(input());

        expect(plain(model.line1.left)).toContain("deepseek-chat · 🧠 high");
        expect(model.line2.left).toBe("");
        expect(plain(model.line2.right)).toBe("sess-abcdef123456");
    });

    test("后台任务运行时显示计数，0 或未设置时不占位", () => {
        const withTasks = buildStatusBarModel(input({ backgroundRunning: 2 }));
        expect(plain(withTasks.line1.right)).toContain("⚙2 后台");
        expect(plain(withTasks.line1.right)).not.toContain("/ps");
        expect(plain(withTasks.line1.right)).not.toContain("/stop");

        const without = buildStatusBarModel(input({ backgroundRunning: 0 }));
        expect(plain(without.line1.right)).not.toContain("后台");

        const unset = buildStatusBarModel(input());
        expect(plain(unset.line1.right)).not.toContain("后台");
    });

    test("无会话时显示「无会话」", () => {
        const model = buildStatusBarModel(input({ sessionId: null }));

        expect(plain(model.line2.right)).toBe("无会话");
    });

    test("Token 统计逐项出现：上下文占用 / 累计 / 输入输出 / 思考 / 缓存", () => {
        const model = buildStatusBarModel(input({
            contextTokens: 12_000,
            contextSource: "provider",
            contextWindow: 64_000,
            totalTokens: 34_000,
            promptTokens: 20_000,
            completionTokens: 14_000,
            reasoningTokens: 5_000,
            cacheHitTokens: 8_000,
            cacheMissTokens: 2_000,
        }));
        const text = plain(model.line2.left);

        expect(text).toContain("12k/64k(18.8%)");
        expect(text).toContain("Σ34k");
        expect(text).toContain("20k=>14k");
        expect(text).toContain("🤔5k");
        expect(text).toContain("🎯80.0%(8k/2k)");
    });

    test("执行阶段提示与工具耗时", () => {
        const reasoning = buildStatusBarModel(input({
            phase: { phase: "reasoning", startTime: 999_000 },
        }));
        expect(plain(reasoning.line1.right)).toContain("思考中");

        const tool = buildStatusBarModel(input({
            phase: { phase: "tool", toolName: "bash", startTime: 990_000, toolStartTime: 995_000 },
        }));
        const text = plain(tool.line1.right);
        expect(text).toContain("执行工具 bash");
        expect(text).toContain("5.0s | 10.0s");
    });

    test("DeepSeek 峰谷倒计时：有 token 时用 · 分隔，无统计时不出现孤立分隔点", () => {
        const withTokens = buildStatusBarModel(input({
            isDeepSeekPriced: true,
            deepSeek: { phase: "peak", switchInMs: 90 * 60_000 },
            totalTokens: 1_000,
        }));
        expect(plain(withTokens.line2.left)).toContain(" · 高峰剩");

        const noTokens = buildStatusBarModel(input({
            isDeepSeekPriced: true,
            deepSeek: { phase: "offpeak", switchInMs: 30 * 60_000 },
        }));
        const text = plain(noTokens.line2.left);
        expect(text).toContain("空闲剩");
        expect(text.trimStart().startsWith("·")).toBe(false);
    });

    test("速率标签：请求进行中置灰", () => {
        const rate = { totalTps: 45.4, outputTps: 10.2, reasoningTps: 35.1 };
        expect(plain(formatRateTag(rate, false))).toBe("⚡45T/s (🤔35 ✏️10)");
        expect(formatRateTag(rate, true)).not.toBe(formatRateTag(rate, false));
        expect(formatRateTag(rate, true)).toContain("\x1b[2m");
    });

    test("有提问在等作答时第 1 行右侧提示（提问不一定在当前会话上）", () => {
        const asking = buildStatusBarModel(input({ awaitingAnswer: 2 }));
        expect(plain(asking.line1.right)).toContain("❓2 待作答");

        const idle = buildStatusBarModel(input());
        expect(plain(idle.line1.right)).not.toContain("待作答");
    });
});

describe("状态栏窄屏响应式布局", () => {
    test("宽屏（>= 80 列）保持经典双行并包含协议后缀与完整会话 ID", () => {
        const lines = renderStatusBarLines(
            input({
                modelName: "deepseek-reasoner",
                protocolLabel: "chat",
                sessionId: "01JZZZZZZZZZZZZZZZZZZ12345",
                cwd: "/Users/me/src/zbot",
                home: "/Users/me",
            }),
            100,
        );

        expect(lines.length).toBe(2);
        expect(plain(lines[0])).toContain("deepseek-reasoner (chat)");
        expect(plain(lines[0])).toContain("~/src/zbot");
        expect(plain(lines[1])).toContain("01JZZZZZZZZZZZZZZZZZZ12345");
    });

    test("手机窄屏（40 列）空闲新会话占 2 行：模型精简 + 末级目录 + 短会话 ID", () => {
        const lines = renderStatusBarLines(
            input({
                modelName: "deepseek-reasoner",
                protocolLabel: "chat",
                effort: "high",
                sessionId: "01JZZZZZZZZZZZZZZZZZZ12345",
                cwd: "/Users/me/very/deep/workspace/zbot",
                home: "/Users/me",
            }),
            40,
        );

        expect(lines.length).toBe(2);
        for (const line of lines) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(40);
        }
        expect(plain(lines[0])).toContain("deepseek-reasoner");
        expect(plain(lines[0])).toContain("🧠H");
        expect(plain(lines[0])).not.toContain("(chat)");
        expect(plain(lines[1])).toContain("zbot");
        expect(plain(lines[1])).toContain("ZZZ12345");
        expect(plain(lines[1])).not.toContain("01JZZZZZZZZZZZZZZZZZZ12345");
    });

    test("手机窄屏（40 列）运行中 + 有统计时扩展为 4 行，实时状态独占首行不被挤掉", () => {
        const lines = renderStatusBarLines(
            input({
                modelName: "deepseek-reasoner",
                protocolLabel: "responses",
                effort: "high",
                sessionId: "01JZZZZZZZZZZZZZZZZZZ12345",
                phase: {
                    phase: "tool",
                    toolName: "execute-shell",
                    startTime: 990_000,
                    toolStartTime: 995_000,
                },
                awaitingAnswer: 2,
                backgroundRunning: 1,
                contextTokens: 12_000,
                contextSource: "provider",
                contextWindow: 64_000,
                totalTokens: 34_000,
                promptTokens: 20_000,
                completionTokens: 14_000,
                reasoningTokens: 5_000,
                cacheHitTokens: 8_000,
                cacheMissTokens: 2_000,
                costYuan: 0.1234,
                lastRate: { totalTps: 45.4, outputTps: 10.2, reasoningTps: 35.1 },
                cwd: "/Users/me/very/deep/workspace/zbot",
                home: "/Users/me",
            }),
            40,
        );

        expect(lines.length).toBe(4);
        for (const line of lines) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(40);
        }

        // 首行：实时执行阶段、耗时、待作答、后台任务全部可见
        expect(plain(lines[0])).toContain("5.0s|10.0s");
        expect(plain(lines[0])).toContain("❓2");
        expect(plain(lines[0])).toContain("⚙1");

        // 第 2 行：模型名去协议后缀、缩写 effort、精简速率
        expect(plain(lines[1])).toContain("deepseek-reasoner");
        expect(plain(lines[1])).toContain("🧠H");
        expect(plain(lines[1])).toContain("⚡45T/s");
        expect(plain(lines[1])).not.toContain("(responses)");
        expect(plain(lines[1])).not.toContain("✏️10");

        // 第 3 行：保留上下文占比与费用，无半截 token 统计
        expect(plain(lines[2])).toContain("12k/64k(18.8%)");
        expect(plain(lines[2])).toContain("¥0.12");

        // 第 4 行：末级目录 + 末 8 位会话 ID
        expect(plain(lines[3])).toContain("zbot");
        expect(plain(lines[3])).toContain("ZZZ12345");
    });

    test("极窄宽度（28 列）所有行均不溢出且仍保留关键计时、费用与短 ID", () => {
        const bar = new StatusBar();
        bar.setInput(
            input({
                modelName: "claude-3-7-sonnet-20250219",
                protocolLabel: "responses-ws",
                effort: "xhigh",
                sessionId: "01JZZZZZZZZZZZZZZZZZZ99999",
                phase: {
                    phase: "tool",
                    toolName: "very_long_tool_name_here",
                    startTime: 990_000,
                    toolStartTime: 995_000,
                },
                awaitingAnswer: 1,
                contextTokens: 12_000,
                contextWindow: 64_000,
                costYuan: 0.5,
                lastRate: { totalTps: 60 },
                cwd: "/Users/me/projects/super-long-directory-name",
                home: "/Users/me",
            }),
        );

        const lines = bar.render(28);
        expect(lines.length).toBe(4);
        for (const line of lines) {
            expect(visibleWidth(line)).toBeLessThanOrEqual(28);
        }
        expect(plain(lines[0])).toContain("5.0s|10.0s");
        expect(plain(lines[0])).toContain("❓1");
        expect(plain(lines[2])).toContain("¥0.50");
        expect(plain(lines[3])).toContain("ZZZ99999");
    });
});
