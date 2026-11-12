import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defaultTestConfig, useConfig } from "./test-config.js";

/**
 * 上下文压缩回归用例（对应真实事故：状态栏 69.1k/500k，请求却被 provider 判 1096619 tokens 超窗）：
 * 1. 请求级压缩只改本轮请求，不改 session.turns，因此 lastPromptTokens 变小不能当成「历史变小」，
 *    否则下一回合按未压缩历史重建请求直接 400；
 * 2. 压缩请求只执行一次；取消或失败时不会写入部分摘要。
 */

type RunChatQueryImpl = (options: any) => Promise<any>;

let runChatQueryImpl: RunChatQueryImpl = async () => {
    throw new Error("runChatQuery 未在测试中设置");
};

const realChatRuntime = await import("../../src/services/chat-runtime.js");

mock.module("../../src/services/chat-runtime.js", () => {
    return {
        ...realChatRuntime,
        runChatQuery: (options: any) => runChatQueryImpl(options),
    };
});

const { autoCompactIfNeeded, compactActiveTurnMessagesIfNeeded, planManualCompaction } = await import("../../src/services/auto-compact.js");
const { runTurnCore } = await import("../../src/services/run-turn.js");
const { createEmptySession } = await import("../../src/events/session-replay.js");
const { appendCompletedTurn, getSessionContextHistory, replaceWithCompactedContext } = await import(
    "../../src/utils/conversation-history.js"
);
const { shouldAutoCompact, getAutoCompactThreshold } = await import(
    "../../src/utils/token-budget.js"
);
const { emptyUsage } = await import("../../src/events/ui-events.js");

/** 窗口按用例改装：写临时 config.yaml 后重新加载。 */
let restoreConfig: (() => void) | undefined;

function useContextWindow(tokens: number): void {
    restoreConfig?.();
    restoreConfig = useConfig(defaultTestConfig({
        runtime: { tokenizer: false, memoryUserId: 0, contextWindowTokens: tokens },
    })).restore;
}

/** 造一段超过测试窗口的长文本。 */
function longText(tokens: number): string {
    return "a".repeat(tokens * 3.5);
}

beforeEach(() => {
    // 收紧窗口，用例不必造百万 token 的假历史。
    useContextWindow(40_000);
});

afterEach(() => {
    restoreConfig?.();
    restoreConfig = undefined;
});

afterAll(() => {
    mock.module("../../src/services/chat-runtime.js", () => realChatRuntime);
});

describe("shouldAutoCompact 与 lastPromptTokens 的关系", () => {
    test("本轮请求被请求级压缩后，lastPromptTokens 偏小也不能阻止压缩", async () => {
        const session = createEmptySession("sess-stale-prompt-tokens");
        appendCompletedTurn(
            session,
            ["超长问题"],
            [{ role: "assistant", content: longText(60_000) }],
            true,
        );

        const threshold = getAutoCompactThreshold("deepseek-chat");
        expect(threshold).toBeLessThan(estimate(session));

        // 事故现场：历史远超阈值，但上一个请求因为回合内压缩只上报了 69073
        expect(await shouldAutoCompact(session, { model: "deepseek-chat", lastPromptTokens: 69_073 })).toBe(true);
        // 没有 provider 数值时同样要靠本地估算兜底
        expect(await shouldAutoCompact(session, { model: "deepseek-chat" })).toBe(true);
    });

    test("历史与 provider 数值都低于阈值时不压缩", async () => {
        const session = createEmptySession("sess-small-context");
        appendCompletedTurn(session, ["短问题"], [{ role: "assistant", content: "短回复" }], true);

        const threshold = getAutoCompactThreshold("deepseek-chat");
        expect(await shouldAutoCompact(session, { model: "deepseek-chat", lastPromptTokens: threshold - 1 })).toBe(false);
    });
});

describe("provider 超窗后的本轮原子压缩", () => {
    test("主请求超窗后先尝试一次禁止工具调用的完整摘要", async () => {
        const histories: string[] = [];
        runChatQueryImpl = async options => {
            expect(options.disableToolCalls).toBe(true);
            histories.push(JSON.stringify(options.history));
            return { content: `摘要 ${histories.length}`, toolCalls: 0, messages: [] };
        };

        const result = await compactActiveTurnMessagesIfNeeded([
            { role: "system", content: "系统提示" },
            { role: "user", content: "继续任务" },
            { role: "tool", content: "结果".repeat(4_000) },
        ], {
            model: "deepseek-chat",
            systemPrompt: "系统提示",
            userId: 1,
            providerMaxTokens: 20_000,
        });

        expect(histories).toHaveLength(1);
        expect(histories[0]).toContain("结果");
        expect(result?.[0]).toEqual({ role: "system", content: "系统提示" });
        expect(result?.[1]?.content).toContain("摘要 1");
    });

    test("摘要请求自身超窗时不重试且不返回部分摘要", async () => {
        useContextWindow(8000);
        let requests = 0;
        runChatQueryImpl = async options => {
            requests++;
            expect(options.disableToolCalls).toBe(true);
            throw new Error("LLM provider 请求失败（HTTP 400）：400 WorkBuddy AI: prompt is too long: 10001 tokens > 10000 maximum");
        };

        await expect(compactActiveTurnMessagesIfNeeded([
            { role: "system", content: "系统提示" },
            { role: "user", content: "a".repeat(40_000) },
        ], {
            model: "deepseek-chat",
            systemPrompt: "系统提示",
            userId: 1,
        })).rejects.toThrow("本轮上下文压缩失败");

        expect(requests).toBe(1);
    });

    test("摘要响应到达时已取消，不交付临时摘要", async () => {
        const controller = new AbortController();
        runChatQueryImpl = async () => {
            controller.abort();
            return { content: "未提交的摘要", toolCalls: 0, messages: [] };
        };

        await expect(compactActiveTurnMessagesIfNeeded([
            { role: "system", content: "系统提示" },
            { role: "user", content: "继续任务" },
        ], {
            model: "deepseek-chat",
            systemPrompt: "系统提示",
            userId: 1,
            providerMaxTokens: 20_000,
            signal: controller.signal,
        })).rejects.toHaveProperty("name", "AbortError");
    });
});

describe("autoCompactIfNeeded 单次原子压缩", () => {
    test("正常阈值触发的压缩只发一次请求（前缀缓存可命中）", async () => {
        // 收紧窗口使阈值变小，用例无需构造百万 token 历史。
        useContextWindow(20000);
        const session = createEmptySession("sess-single-request-compact");
        appendCompletedTurn(session, ["开头问题"], [{ role: "assistant", content: longText(4_800) }], true);
        appendCompletedTurn(session, ["尾部问题"], [{ role: "assistant", content: "短回复" }], true);

        // 确实越过阈值，但历史总长仍在单次请求的预算内
        expect(await shouldAutoCompact(session, { model: "deepseek-chat" })).toBe(true);

        const histories: any[][] = [];
        runChatQueryImpl = async options => {
            histories.push(options.history);
            return { content: "SUMMARY", toolCalls: 0, messages: [] };
        };

        let persistedPosition: { turnIndex: number; messageIndex: number } | undefined;
        const result = await autoCompactIfNeeded(session, {
            model: "deepseek-chat",
            persistCompactedEvent: async payload => {
                persistedPosition = payload.keepFromPosition;
            },
        });

        expect(result.wasCompacted).toBe(true);
        expect(histories).toHaveLength(1);
        // 单次请求：历史原样作为前缀发出（无摘要注入），待压缩范围内的回合全部进摘要
        expect(JSON.stringify(histories[0])).toContain("开头问题");
        expect(JSON.stringify(histories[0])).toContain("尾部问题");
        expect(JSON.stringify(histories[0])).not.toContain("conversation_summary");

        // 压缩后上下文 = 摘要 + 保留段：保留预算内留下最后一条消息，其余全部折叠
        const contextAfter = getSessionContextHistory(session);
        expect(contextAfter).toHaveLength(3);
        expect(JSON.stringify(contextAfter)).toContain("SUMMARY");
        expect(JSON.stringify(contextAfter)).toContain("短回复");
        expect(JSON.stringify(contextAfter)).not.toContain("开头问题");
        expect(JSON.stringify(contextAfter)).not.toContain("尾部问题");
        // 保留段起点是消息级边界，落在最后一条消息上
        expect(session.compactedKeepFromMessageId).toBe(session.turns[1]!.messages[1]!.id);
        expect(persistedPosition).toEqual({ turnIndex: 1, messageIndex: 1 });
    });

    test("优先按完整 turn 保留：预算够时切点落在 turn 边界", async () => {
        useContextWindow(20000);
        const session = createEmptySession("sess-keep-turns");
        for (let index = 1; index <= 4; index++) {
            appendCompletedTurn(session, [`问题 ${index}`], [{ role: "assistant", content: longText(5_000) }], true);
        }

        const histories: any[][] = [];
        runChatQueryImpl = async options => {
            histories.push(options.history);
            return { content: "SUMMARY", toolCalls: 0, messages: [] };
        };

        const result = await autoCompactIfNeeded(session, { model: "deepseek-chat" });
        expect(result.wasCompacted).toBe(true);

        // 尾部 3 个 turn 合计已过 12k 保留预算，切点落在 turn 边界：保留段从 turn2 的第一条消息开始
        expect(session.compactedKeepFromMessageId).toBe(session.turns[1]!.messages[0]!.id);
        expect(session.compactedThroughTurnId).toBe(session.turns[0]!.id);
        expect(JSON.stringify(histories.at(-1))).toContain("问题 1");
        expect(JSON.stringify(histories.at(-1))).not.toContain("问题 2");

        // 上下文 = 摘要 + 确认 + 保留的 3 个完整 turn（6 条消息）
        const context = getSessionContextHistory(session);
        expect(context).toHaveLength(8);
        expect(JSON.stringify(context)).toContain("SUMMARY");
        expect(JSON.stringify(context)).not.toContain("问题 1");
        expect(JSON.stringify(context)).toContain("问题 2");
        expect(JSON.stringify(context)).toContain("问题 4");

        // 压缩之后新产生的回合仍会进上下文
        appendCompletedTurn(session, ["新问题"], [{ role: "assistant", content: "新回复" }], true);
        const after = getSessionContextHistory(session);
        expect(after).toHaveLength(10);
        expect(JSON.stringify(after)).toContain("新问题");
    });

    test("连续压缩：上次保留段会被下次压缩一起吸收", async () => {
        useContextWindow(20000);
        const session = createEmptySession("sess-absorb-tail");
        for (let index = 1; index <= 4; index++) {
            appendCompletedTurn(session, [`问题 ${index}`], [{ role: "assistant", content: longText(5_000) }], true);
        }

        const histories: any[][] = [];
        runChatQueryImpl = async options => {
            histories.push(options.history);
            return { content: `SUMMARY_${histories.length}`, toolCalls: 0, messages: [] };
        };

        await autoCompactIfNeeded(session, { model: "deepseek-chat" });
        expect(session.compactedKeepFromMessageId).toBe(session.turns[1]!.messages[0]!.id);

        appendCompletedTurn(session, ["问题 5"], [{ role: "assistant", content: longText(5_000) }], true);
        appendCompletedTurn(session, ["问题 6"], [{ role: "assistant", content: longText(5_000) }], true);
        await autoCompactIfNeeded(session, { model: "deepseek-chat" });

        // 第二次压缩从上次保留段起点开始：上次留下的 turn2 也进了摘要，随后被新的保留段取代
        const secondRound = histories.slice(1).map(history => JSON.stringify(history)).join("");
        expect(secondRound).toContain("conversation_summary");
        expect(secondRound).toContain("SUMMARY_1");
        expect(secondRound).toContain("问题 2");
        expect(secondRound).not.toContain("问题 6");
        expect(session.compactedKeepFromMessageId).toBe(session.turns[3]!.messages[0]!.id);
    });

    test("历史超窗时压缩范围往前收、保留段原样接上，且只发一次压缩请求", async () => {
        const session = createEmptySession("sess-single-compact");
        for (let index = 1; index <= 3; index++) {
            appendCompletedTurn(
                session,
                [`问题 ${index}`],
                [{ role: "assistant", content: longText(20_000) }],
                true,
            );
        }

        const histories: any[][] = [];
        runChatQueryImpl = async options => {
            histories.push(options.history);
            options.onEvent?.({
                type: "usage",
                usage: { ...emptyUsage(), model: "test", promptTokens: 100, totalTokens: 100, requestCount: 1 },
            });
            return { content: "SUMMARY", toolCalls: 0, messages: [] };
        };

        const result = await autoCompactIfNeeded(session, { model: "deepseek-chat" });

        expect(result.wasCompacted).toBe(true);
        expect(histories).toHaveLength(1);
        expect(JSON.stringify(histories[0])).not.toContain("conversation_summary");
        // 超窗时不再「丢掉头部、只压尾部」，而是把压缩范围往前收：
        // 压缩请求只含被压的那部分（装得下），剩下的原样作为保留段接在摘要后面
        expect(JSON.stringify(histories[0])).toContain("问题 1");
        expect(JSON.stringify(histories[0])).not.toContain("问题 3");
        expect(estimate({ turns: [{ messages: histories[0] }] })).toBeLessThanOrEqual(40_000);
        expect(session.compactedContext).toBe("SUMMARY");
        // 保留段前移到第二个回合：内容一点没丢，下次请求就是「摘要 + 保留段 + 新输入」
        expect(session.compactedKeepFromMessageId).toBe(session.turns[1]!.messages[0]!.id);
        expect(session.compactedThroughTurnId).toBe(session.turns[0]!.id);
        const contextAfter = getSessionContextHistory(session);
        expect(JSON.stringify(contextAfter)).toContain("SUMMARY");
        // 摘要 + 确认 + 两个保留回合（各 user/assistant）
        expect(contextAfter).toHaveLength(6);
        expect(JSON.stringify(contextAfter)).toContain("问题 2");
        expect(JSON.stringify(contextAfter)).toContain("问题 3");
        expect(session.compactCount).toBe(1);
        expect(result.usage?.requestCount).toBe(1);
        expect(result.postTokens).toBeLessThan(result.preTokens ?? 0);
    });

    test("回合内压缩成功后回调落盘摘要（重启不回滚）", async () => {
        const persisted: string[] = [];
        runChatQueryImpl = async () => ({ content: "本轮进展摘要", toolCalls: 0, messages: [] });

        const messages = await compactActiveTurnMessagesIfNeeded(
            [
                { role: "system", content: "sys" },
                { role: "user", content: "做点事" },
                { role: "assistant", content: "好的" },
            ],
            {
                systemPrompt: "sys",
                userId: 0,
                providerMaxTokens: 40_000,
                onCompacted: async (text: string) => { persisted.push(text); },
            },
        );

        expect(persisted).toEqual(["本轮进展摘要"]);
        expect(JSON.stringify(messages)).toContain("<active_turn_summary>");
    });

    test("手动 /compact：不超窗时整段折叠，超窗时把装不下的尾部原样保留", async () => {
        const small = createEmptySession("sess-manual-small");
        appendCompletedTurn(small, ["问题"], [{ role: "assistant", content: "回答" }], true);
        const whole = await planManualCompaction(small, { model: "deepseek-chat" });
        expect(whole.keepFromMessageId).toBeUndefined();
        expect(whole.turnsToCompact).toHaveLength(1);

        // 三个 20k token 的回合：窗口 40k，装不下的部分必须留成保留段，而不是被裁掉
        const big = createEmptySession("sess-manual-big");
        for (let index = 1; index <= 3; index++) {
            appendCompletedTurn(big, [`问题 ${index}`], [{ role: "assistant", content: longText(20_000) }], true);
        }
        const split = await planManualCompaction(big, { model: "deepseek-chat" });
        expect(split.keepFromMessageId).toBe(big.turns[1]!.messages[0]!.id);
        expect(split.turnsToCompact).toHaveLength(1);
    });

    test("取消后不落压缩事件，不修改会话", async () => {
        const session = createEmptySession("sess-aborted-compact");
        appendCompletedTurn(session, ["问题"], [{ role: "assistant", content: longText(60_000) }], true);
        const originalContextEpochId = session.contextEpochId;
        const controller = new AbortController();
        let persisted = false;
        runChatQueryImpl = async () => {
            controller.abort();
            return { content: "未提交的摘要", toolCalls: 0, messages: [] };
        };

        await expect(autoCompactIfNeeded(session, {
            model: "deepseek-chat",
            signal: controller.signal,
            persistCompactedEvent: async () => { persisted = true; },
        })).rejects.toHaveProperty("name", "AbortError");

        expect(persisted).toBe(false);
        expect(session.compactedContext).toBeUndefined();
        expect(session.compactCount).toBe(0);
        expect(session.contextEpochId).toBe(originalContextEpochId);
    });

    test("压缩事件写入失败时不修改会话", async () => {
        const session = createEmptySession("sess-persist-failed-compact");
        appendCompletedTurn(session, ["问题"], [{ role: "assistant", content: longText(60_000) }], true);
        const originalContextEpochId = session.contextEpochId;
        runChatQueryImpl = async () => ({ content: "未提交的摘要", toolCalls: 0, messages: [] });

        await expect(autoCompactIfNeeded(session, {
            model: "deepseek-chat",
            persistCompactedEvent: async () => { throw new Error("写入失败"); },
        })).rejects.toThrow("写入失败");

        expect(session.compactedContext).toBeUndefined();
        expect(session.compactCount).toBe(0);
        expect(session.contextEpochId).toBe(originalContextEpochId);
    });

});

describe("context_compacted 事件重放", () => {
    test("重放恢复保留段边界（消息级）", async () => {
        const { EventLog } = await import("../../src/events/event-log.js");
        const { SessionReplay } = await import("../../src/events/session-replay.js");
        const sessionId = "sess-replay-keep-from";
        const log = new EventLog();
        await log.append(sessionId, "session_created", { cwd: "/tmp" });
        await log.append(sessionId, "context_compacted", {
            compactedContext: "SUMMARY",
            keepFromMessageId: "msg-keep-from",
        });

        const { session } = await new SessionReplay(log).replayTo(sessionId);
        expect(session.compactedContext).toBe("SUMMARY");
        // 旧事件没有稳定位置且消息不存在时，回退到压缩时的回合边界。
        expect(session.compactedKeepFromMessageId).toBeUndefined();
    });
});

describe("runTurnCore 请求历史在压缩之后构造", () => {
    test("预压缩改写的历史会用在同一回合的请求里", async () => {
        const session = createEmptySession("sess-turn-history");
        appendCompletedTurn(session, ["旧问题"], [{ role: "assistant", content: longText(20_000) }], true);
        const staleHistoryLength = session.turns[0].messages.length;

        let sentHistory: any[] = [];
        runChatQueryImpl = async options => {
            sentHistory = options.history;
            return { content: "ok", toolCalls: 1, messages: [{ role: "assistant", content: "ok" }] };
        };

        const outcome = await runTurnCore({
            session,
            turnId: "turn-1",
            userMessages: ["新问题"],
            query: "新问题",
            systemPrompt: "system",
            buildHistory: () => {
                // 压缩写回后重建历史：只剩摘要前缀 + 本轮用户消息
                const history: any[] = session.compactedContext
                    ? [{ role: "user", content: `<conversation_summary>\n${session.compactedContext}` }]
                    : [];
                return [...history, { role: "user", content: "新问题" }];
            },
            signal: new AbortController().signal,
        }, {
            persistUserMessages: async () => {},
            persistPendingMessage: async () => {},
            persistTurnMessage: async () => 0,
            persistSegmentStart: async () => 0,
            persistTurn: async () => {},
            // 压缩发生在 buildHistory 之前
            autoCompact: async () => {
                replaceWithCompactedContext(session, "SUMMARY", { compactedThroughTurnId: session.turns[0].id });
                return undefined;
            },
        });

        expect(outcome.aborted).toBe(false);
        expect(sentHistory.some(message => String(message.content).includes("SUMMARY"))).toBe(true);
        expect(sentHistory.length).toBeLessThan(staleHistoryLength + 2);
    });
});

function estimate(session: { turns: any[] }): number {
    return session.turns.reduce((total, turn) => {
        return total + turn.messages.reduce((sum: number, message: any) => sum + messageTokens(message), 0);
    }, 0);
}

function messageTokens(message: any): number {
    return Math.ceil(String(message.content ?? "").length / 3.5) + 4;
}
