import { describe, expect, test } from "bun:test";
import type { UserQuestionRequest } from "../utils/user-question.js";
import {
    QuestionCoordinator,
    type QuestionDockView,
    type QuestionPanelLike,
    type QuestionPanelStack,
} from "./question-coordinator.js";
import type { PanelKind, PanelLayer } from "./panel-stack.js";

/**
 * 提问协调器单测：不起 ChatApp、不依赖 pi-tui。
 * 面板栈与 dock 用最小替身（语义与真实实现一致：remove 触发 onClose），
 * 面板工厂只记录构造参数。
 */

class FakePanelStack implements QuestionPanelStack {
    layers: PanelLayer[] = [];

    get isEmpty(): boolean {
        return this.layers.length === 0;
    }
    has(kind: PanelKind): boolean {
        return this.layers.some(layer => layer.kind === kind);
    }
    find(kind: PanelKind): PanelLayer | undefined {
        return [...this.layers].reverse().find(layer => layer.kind === kind);
    }
    remove(kind: PanelKind): void {
        const index = this.layers.findIndex(layer => layer.kind === kind);
        if (index < 0) return;
        const [layer] = this.layers.splice(index, 1);
        layer?.onClose?.();
    }
    push(layer: PanelLayer): void {
        this.layers.push(layer);
    }
}

function harness(options: { current?: string | null; exiting?: boolean } = {}) {
    const panels = new FakePanelStack();
    const dock: { panel?: QuestionPanelLike; collapsed?: string; cleared: number } & QuestionDockView = {
        cleared: 0,
        showPanel(panel) {
            this.panel = panel;
            this.collapsed = undefined;
        },
        showCollapsed(text) {
            this.collapsed = text;
            this.panel = undefined;
        },
        clear() {
            this.cleared += 1;
            this.panel = undefined;
            this.collapsed = undefined;
        },
    };
    const state = {
        current: options.current === undefined ? "sess-a" : options.current,
        exiting: options.exiting ?? false,
        flashes: [] as string[],
        renders: 0,
        stateChanges: 0,
        focusRestores: 0,
        created: [] as Array<{
            questions: unknown[];
            answers: unknown[];
            submit(): void;
            cancel(): void;
            collapse(): void;
        }>,
    };
    const coordinator = new QuestionCoordinator({
        panels,
        dock,
        currentSessionId: () => state.current,
        sessionLabel: sessionId => `会话 ${sessionId.slice(-1)}`,
        isExiting: () => state.exiting,
        restoreFocus: () => { state.focusRestores += 1; },
        requestRender: () => { state.renders += 1; },
        onStateChange: () => { state.stateChanges += 1; },
        flash: message => state.flashes.push(message),
        isCollapseKey: data => data === "CTRL_SHIFT_Q",
        createPanel: (input) => {
            state.created.push({
                questions: input.questions,
                answers: input.answers,
                submit: input.submit,
                cancel: input.cancel,
                collapse: input.collapse,
            });
            return { handleInput: () => {} };
        },
    });
    return { coordinator, panels, dock, state };
}

function requestOf(overrides: Partial<UserQuestionRequest> = {}): UserQuestionRequest {
    return {
        requestId: "q1",
        sessionId: "sess-a",
        questions: [
            { id: "q", header: "问题", question: "选哪个？", options: [{ label: "A" }, { label: "B" }] },
        ],
        ...overrides,
    } as UserQuestionRequest;
}

describe("QuestionCoordinator", () => {
    test("当前会话提问：挂面板、进栈、登记待答，状态变化触发重绘", async () => {
        const { coordinator, panels, dock, state } = harness();
        const answer = coordinator.ask(requestOf());

        expect(coordinator.pendingCount()).toBe(1);
        expect(coordinator.hasPending("sess-a")).toBe(true);
        expect(dock.panel).toBeDefined();
        expect(panels.find("question")?.sessionId).toBe("sess-a");
        expect(state.stateChanges).toBe(1);

        coordinator.pending("sess-a")!.settle({ cancelled: true });
        expect(await answer).toEqual({ cancelled: true });
        // 结算后：状态、面板、栈、dock 全部清干净
        expect(coordinator.pendingCount()).toBe(0);
        expect(panels.has("question")).toBe(false);
        expect(dock.panel).toBeUndefined();
        expect(state.stateChanges).toBe(2);
    });

    test("非当前会话提问：只 flash 提示，不打扰当前界面；切过去后 sync 弹出", async () => {
        const { coordinator, panels, dock, state } = harness({ current: "sess-b" });
        void coordinator.ask(requestOf({ sessionId: "sess-a" }));

        expect(dock.panel).toBeUndefined();
        expect(panels.isEmpty).toBe(true);
        expect(state.flashes.at(-1)).toContain("有会话在等你作答");

        state.current = "sess-a";
        coordinator.sync();
        expect(panels.find("question")?.sessionId).toBe("sess-a");
    });

    test("提交：把已作答项交给宿主结算（未答项不进入答案）", async () => {
        const { coordinator, state } = harness();
        const answerPromise = coordinator.ask(requestOf());
        coordinator.pending("sess-a")!.answers[0] = { selected: [0] } as never;

        // 走面板真实的 submit 回调：coordinator 负责过滤未作答项
        state.created.at(-1)!.submit();

        expect(await answerPromise).toEqual({ cancelled: false, answers: [{ selected: [0] }] });
        expect(state.created).toHaveLength(1);
    });

    test("abort：按取消结算并清理；已中止的 signal 不登记待答", async () => {
        const { coordinator, panels } = harness();
        const controller = new AbortController();
        const answerPromise = coordinator.ask(requestOf(), controller.signal);
        controller.abort();

        expect(await answerPromise).toEqual({ cancelled: true });
        expect(coordinator.pendingCount()).toBe(0);
        expect(panels.has("question")).toBe(false);

        const aborted = new AbortController();
        aborted.abort();
        const neverRegistered = coordinator.ask(requestOf({ requestId: "q2" }), aborted.signal);
        expect(await neverRegistered).toEqual({ cancelled: true });
        expect(coordinator.pendingCount()).toBe(0);
    });

    test("⌃⇧Q 折叠：只留一行提示并保留答案；toggle 重新展开用同一份 answers", async () => {
        const { coordinator, panels, dock, state } = harness();
        void coordinator.ask(requestOf());
        const answers = coordinator.pending("sess-a")!.answers;
        answers[0] = { selected: [1] } as never;

        const intercepted = panels.find("question")!.intercept?.("CTRL_SHIFT_Q");
        expect(intercepted).toBe(true);
        expect(panels.has("question")).toBe(false);
        expect(dock.collapsed).toContain("等待回答 1/1");
        expect(dock.collapsed).toContain("⌃⇧Q 展开");

        coordinator.toggle();
        expect(panels.has("question")).toBe(true);
        expect(state.created).toHaveLength(1);
        expect(coordinator.pending("sess-a")!.answers[0]).toEqual({ selected: [1] });
    });

    test("close 只作用于指定会话；有别的浮层时不抢当前界面", async () => {
        const { coordinator, panels, state } = harness();
        void coordinator.ask(requestOf());

        coordinator.close("sess-other");
        expect(panels.has("question")).toBe(true);

        coordinator.close("sess-a");
        expect(panels.has("question")).toBe(false);
        expect(state.focusRestores).toBeGreaterThan(0);
        // 问题本身还挂着：切走只是收起界面
        expect(coordinator.hasPending("sess-a")).toBe(true);

        panels.push({ kind: "session", panel: { handleInput: () => {} } });
        state.current = "sess-a";
        coordinator.sync();
        expect(panels.has("question")).toBe(false);
    });

    test("退出中不打开面板；阻塞文案取第一条待答问题", async () => {
        const exiting = harness({ exiting: true });
        void exiting.coordinator.ask(requestOf());
        expect(exiting.panels.has("question")).toBe(false);
        expect(exiting.coordinator.blockedMessage()).toContain("选哪个");
    });
});
