/**
 * 会话级运行态：阶段与 UI 占位是两件不同的事，不能再用一个布尔表示。
 *
 * 这里守住三条性质：
 *   1. 忙闲按会话隔离（后台会话在跑，不影响别的会话的判断）
 *   2. 占位可叠加且逐个释放，任一残留都仍算忙
 *   3. reset 之后不会留下让 tab 停在 spinner 上的残余状态
 */

import { describe, expect, test } from "bun:test";
import { TurnStateStore } from "../../src/tui/turn-state.js";

describe("阶段", () => {
    test("设置阶段后可按会话查回", () => {
        const store = new TurnStateStore();
        store.setPhase("a", "waiting");

        expect(store.phase("a")?.phase).toBe("waiting");
        expect(store.hasPhase("a")).toBe(true);
        expect(store.isBusy("a")).toBe(true);
    });

    test("阶段按会话隔离", () => {
        const store = new TurnStateStore();
        store.setPhase("a", "waiting");

        expect(store.isBusy("b")).toBe(false);
        expect(store.activeSessionIds).toEqual(["a"]);
    });

    test("无会话时任何查询都不算忙", () => {
        const store = new TurnStateStore();
        expect(store.isBusy(null)).toBe(false);
        expect(store.isBusy(undefined)).toBe(false);
        expect(store.phase(null)).toBeUndefined();
    });

    test("切换阶段保留起始时间，便于展示总耗时", () => {
        const store = new TurnStateStore();
        store.setPhase("a", "waiting");
        const startedAt = store.phase("a")!.startTime;

        store.setPhase("a", "reasoning");
        expect(store.phase("a")!.startTime).toBe(startedAt);
    });

    test("进入工具阶段记录工具起点，离开时清掉", () => {
        const store = new TurnStateStore();
        store.setPhase("a", "tool", "bash");
        expect(store.phase("a")!.toolStartTime).toBeDefined();

        store.setPhase("a", "reasoning");
        expect(store.phase("a")!.toolStartTime).toBeUndefined();
    });

    test("清除阶段后不再算忙", () => {
        const store = new TurnStateStore();
        store.setPhase("a", "tool", "bash");
        store.clearPhase("a");

        expect(store.hasPhase("a")).toBe(false);
        expect(store.isBusy("a")).toBe(false);
    });
});

describe("UI 占位", () => {
    test("占位让会话算忙，但不产生模型阶段", () => {
        const store = new TurnStateStore();
        store.lock("a", "clearing");

        expect(store.isBusy("a")).toBe(true);
        expect(store.hasPhase("a")).toBe(false);
        expect(store.phase("a")).toBeUndefined();
    });

    test("占位可叠加，逐一释放后才算空闲", () => {
        const store = new TurnStateStore();
        store.lock("a", "switching");
        store.lock("a", "reloading");

        store.unlock("a", "switching");
        expect(store.isBusy("a")).toBe(true);

        store.unlock("a", "reloading");
        expect(store.isBusy("a")).toBe(false);
    });

    test("释放未持有的占位是空操作", () => {
        const store = new TurnStateStore();
        store.unlock("a", "clearing");
        expect(store.isBusy("a")).toBe(false);
    });

    test("占位原因可枚举，便于诊断", () => {
        const store = new TurnStateStore();
        store.lock("a", "clearing");
        store.lock("a", "compacting");
        expect(store.lockReasons("a").sort()).toEqual(["clearing", "compacting"]);
    });
});

describe("组合与清理", () => {
    test("阶段与占位任一存在都算忙", () => {
        const store = new TurnStateStore();
        store.setPhase("a", "waiting");
        store.lock("b", "clearing");

        expect(store.isBusy("a")).toBe(true);
        expect(store.isBusy("b")).toBe(true);
        expect(store.hasAnyActivity()).toBe(true);
    });

    test("reset 同时清阶段与占位", () => {
        const store = new TurnStateStore();
        store.setPhase("a", "tool", "bash");
        store.lock("a", "reloading");

        store.reset("a");

        // 关键是两者都被清掉：只清一个会让 tab 停在 spinner 上
        expect(store.hasPhase("a")).toBe(false);
        expect(store.isLocked("a")).toBe(false);
        expect(store.isBusy("a")).toBe(false);
    });

    test("reset 不影响其他会话", () => {
        const store = new TurnStateStore();
        store.setPhase("a", "waiting");
        store.setPhase("b", "waiting");

        store.reset("a");
        expect(store.isBusy("b")).toBe(true);
    });

    test("clear 后无任何活动", () => {
        const store = new TurnStateStore();
        store.setPhase("a", "waiting");
        store.lock("b", "clearing");

        store.clear();
        expect(store.hasAnyActivity()).toBe(false);
        expect(store.activeSessionIds).toEqual([]);
    });

    test("hasModelActivity 只认模型侧活动，不认纯 UI 占位", () => {
        const store = new TurnStateStore();
        expect(store.hasModelActivity()).toBe(false);

        store.lock("a", "clearing");
        store.lock("b", "switching");
        store.lock("c", "reloading");
        expect(store.hasModelActivity()).toBe(false);

        store.lock("d", "compacting");
        expect(store.hasModelActivity()).toBe(true);
        store.unlock("d", "compacting");

        store.lock("e", "resuming");
        expect(store.hasModelActivity()).toBe(true);
        store.unlock("e", "resuming");

        store.setPhase("f", "tool", "bash");
        expect(store.hasModelActivity()).toBe(true);
        store.clearPhase("f");
        expect(store.hasModelActivity()).toBe(false);
    });
});
