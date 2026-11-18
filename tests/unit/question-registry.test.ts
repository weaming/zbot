/**
 * 会话级待答注册表：面板与外部作答共享同一份等待，外部先答要让面板让位。
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
    getUserQuestionChannel,
    registerSessionRuntime,
    sessionRuntimeCount,
} from "../../src/control/runtime.js";
import { answerPendingQuestion, pendingQuestion, subscribeQuestions } from "../../src/control/question-registry.js";
import type { UserAnswer, UserQuestionRequest } from "../../src/utils/user-question.js";

const unregisterAll: Array<() => void> = [];

afterEach(() => {
    while (unregisterAll.length > 0) unregisterAll.pop()!();
});

function request(requestId = "Q1"): UserQuestionRequest {
    return {
        requestId,
        sessionId: "S1",
        questions: [{ header: "颜色", question: "选哪个？", options: [{ label: "红" }, { label: "蓝" }] }],
    };
}

/** 注册一个会话的提问通道：记录面板被 abort 的事实。 */
function registerAsk() {
    const seen: { aborted: boolean } = { aborted: false };
    const unregister = registerSessionRuntime({
        ownsSession: id => id === "S1",
        askUser: (req, signal) =>
            new Promise<UserAnswer>(resolve => {
                signal?.addEventListener("abort", () => {
                    seen.aborted = true;
                    resolve({ cancelled: true });
                }, { once: true });
            }),
    });
    unregisterAll.push(unregister);
    return seen;
}

describe("会话级待答注册表", () => {
    test("外部作答兑现等待，并让前端面板收到 abort", async () => {
        const panel = registerAsk();
        const changes: string[] = [];
        const off = subscribeQuestions(event => changes.push(`${event.kind}:${event.question.requestId}`));
        const channel = getUserQuestionChannel("S1");
        expect(channel).toBeDefined();

        const answer = channel!.ask(request());
        expect(pendingQuestion("S1")?.requestId).toBe("Q1");

        const result = answerPendingQuestion("S1", "Q1", {
            cancelled: false,
            answers: [{ header: "颜色", question: "选哪个？", selected: ["红"] }],
        });
        expect(result).toEqual({ ok: true });
        expect(await answer).toEqual({
            cancelled: false,
            answers: [{ header: "颜色", question: "选哪个？", selected: ["红"] }],
        });
        expect(panel.aborted).toBe(true);
        expect(pendingQuestion("S1")).toBeUndefined();
        expect(changes).toEqual(["asked:Q1", "closed:Q1"]);
        off();
    });

    test("没有等待中的提问时如实报原因，不伪造成功", async () => {
        registerAsk();
        expect(answerPendingQuestion("S1", "Q1", { cancelled: true })).toEqual({
            ok: false,
            reason: "not_found",
        });
        const channel = getUserQuestionChannel("S1")!;
        const answer = channel.ask(request("Q2"));
        // 请求号对不上也算没有对应提问。
        expect(answerPendingQuestion("S1", "Q1", { cancelled: true })).toEqual({
            ok: false,
            reason: "not_found",
        });
        expect(await new Promise<UserAnswer>(resolve => {
            // 取消这次提问，收尾避免悬挂
            expect(answerPendingQuestion("S1", "Q2", { cancelled: true })).toEqual({ ok: false, reason: "cancelled" });
            void answer.then(resolve);
        })).toEqual({ cancelled: true });
        expect(sessionRuntimeCount()).toBeGreaterThan(0);
    });
});
