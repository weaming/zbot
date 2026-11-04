/**
 * ChatApp 的提问接线：装配通道、弹层、tab/状态栏可见性、作答与中止结算。
 * pi-tui 与 chat-runtime 都用替身（同 tui-app-pending-queue.test.ts 的口径）。
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { tuiStub } from "./tui-stub.js";

mock.module("@earendil-works/pi-tui", () => tuiStub);

const realChatRuntime = await import("../../src/services/chat-runtime.js");
mock.module("../../src/services/chat-runtime.js", () => ({
    ...realChatRuntime,
    runChatQuery: async () => ({ content: "stub", toolCalls: 0, messages: [] }),
}));

const herdrEvents: Array<{ kind: string; args: unknown[] }> = [];
const realHerdrReporter = await import("../../src/tui/herdr-reporter.js");
mock.module("../../src/tui/herdr-reporter.js", () => ({
    ...realHerdrReporter,
    herdrReporter: {
        supported: true,
        report: (state: string, message?: string) => herdrEvents.push({ kind: "state", args: [state, message] }),
        reportMetadata: (metadata: unknown) => herdrEvents.push({ kind: "metadata", args: [metadata] }),
        release: () => herdrEvents.push({ kind: "release", args: [] }),
    },
}));

const { ChatApp } = await import("../../src/tui/app.js");
const { ChatStore } = await import("../../src/tui/store.js");
const { getUserQuestionChannel, setUserQuestionChannel } = await import("../../src/utils/user-question.js");

const SESSION = "01JASKAPP000000000000000TEST";
const OTHER = "01JASKAPP000000000000000OTHR";

let tmpDir: string;
let originalStateDir: string | undefined;
let originalTuiCwd: string | undefined;

function makeAgent() {
    const claimed = new Set<string>([SESSION, OTHER]);
    return {
        claimedSessionIds: () => [...claimed],
        claimSession: async () => ({ ok: true as const }),
        isSessionClaimed: (sessionId: string) => claimed.has(sessionId),
        releaseSession: () => {},
        getSessionCwd: async () => tmpDir,
        getSessionModelSelection: async () => null,
        loadInputHistory: () => [],
        appendInputHistory: async () => {},
        readSessionEvents: async () => [],
        getSystemPrompt: async () => "",
        isSessionBusy: () => false,
        isSessionLockedByOther: () => false,
        takePeerResults: () => [],
        peerPendingStats: () => ({ awaiting: 0, queued: 0 }),
        probeSession: async () => ({ state: "mine" as const }),
        listSessionOwnership: async () => new Map(),
        onTurnFinished: undefined as any,
        onSessionReleased: undefined as any,
        onSessionSpawned: undefined as any,
        onEvent: undefined as any,
    };
}

function makeApp() {
    const agent = makeAgent();
    const store = new ChatStore();
    store.setSessions([
        { sessionId: SESSION, messageCount: 0, title: "提问会话" },
        { sessionId: OTHER, messageCount: 0, title: "别的会话" },
    ]);
    store.setCurrentSession(SESSION);

    const app = new ChatApp(agent as any, store);
    return { app, store, agent, tui: (app as any).tui };
}

function question(overrides: Record<string, unknown> = {}) {
    return {
        header: "部署方式",
        question: "这次部署走哪条路？",
        options: [{ label: "方案 A" }, { label: "方案 B" }],
        ...overrides,
    };
}

function request(sessionId = SESSION) {
    return { requestId: `req-${sessionId.slice(-4)}`, sessionId, questions: [question()] };
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-tui-ask-"));
    originalStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;
    originalTuiCwd = process.env.TUI_CWD;
});

afterEach(() => {
    if (originalStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = originalStateDir;
    // ChatApp 会把进程级 TUI_CWD 切到会话目录；不还原会让后续文件拿到已删除的临时目录。
    if (originalTuiCwd === undefined) delete process.env.TUI_CWD;
    else process.env.TUI_CWD = originalTuiCwd;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
    // 通道是进程级单例：本文件跑完必须撤掉，否则后续测试会看到「有人在场」
    setUserQuestionChannel(undefined);
    mock.restore();
});

describe("ChatApp 提问接线", () => {
    test("构造时装配提问通道", () => {
        makeApp();
        expect(getUserQuestionChannel()).toBeDefined();
    });

    test("当前会话提问：弹出浮层，作答后结算并收起", async () => {
        const { app, tui } = makeApp();
        const focusCalls: unknown[] = [];
        tui.setFocus = (component: unknown) => focusCalls.push(component);
        const pending = getUserQuestionChannel()!.ask(request());

        const entry = (app as any).panels.find("question");
        expect(entry.kind).toBe("question");
        expect(focusCalls.at(-1)).toBe(entry.panel);

        // 面板独占键盘：回车选定第一项
        (app as any).handlePanelInput("\r");
        const answer = await pending;

        expect(answer).toEqual({
            cancelled: false,
            answers: [{ header: "部署方式", question: "这次部署走哪条路？", selected: ["方案 A"] }],
        });
        expect((app as any).panels.find("question")).toBeUndefined();
        expect((app as any).pendingQuestions.size).toBe(0);
        expect(focusCalls.at(-1)).toBe((app as any).editor);
        expect(tui.flashCalls).toEqual([]);
    });

    test("别的会话提问：不抢当前界面，flash 提示；切过去自动弹层", async () => {
        const { app, tui, store } = makeApp();
        const pending = getUserQuestionChannel()!.ask(request(OTHER));

        expect((app as any).panels.find("question")).toBeUndefined();
        expect(tui.flashCalls.some((line: string) => line.includes("别的会话") && line.includes("等"))).toBe(true);

        await (app as any).selectSession(OTHER);
        expect(store.currentSessionId).toBe(OTHER);
        expect((app as any).panels.find("question")).toBeDefined();

        // 取消整次提问
        (app as any).handlePanelInput("\x03");
        expect(await pending).toEqual({ cancelled: true });
    });

    test("signal 中止（⌃C / 退出 / 会话被释放）按取消结算并收起浮层", async () => {
        const { app } = makeApp();
        const controller = new AbortController();
        const pending = getUserQuestionChannel()!.ask(request(), controller.signal);
        expect((app as any).panels.find("question")).toBeDefined();

        controller.abort();
        expect(await pending).toEqual({ cancelled: true });
        expect((app as any).panels.find("question")).toBeUndefined();
        expect((app as any).pendingQuestions.size).toBe(0);
    });

    test("已经中止的信号：直接按取消结算，不挂起也不弹层", async () => {
        const { app } = makeApp();
        const controller = new AbortController();
        controller.abort();

        const answer = await getUserQuestionChannel()!.ask(request(), controller.signal);
        expect(answer).toEqual({ cancelled: true });
        expect((app as any).panels.find("question")).toBeUndefined();
        expect((app as any).pendingQuestions.size).toBe(0);
    });

    test("tab 标记：等待作答的会话显示 ?（优先于运行中转圈）", async () => {
        const { app } = makeApp();
        const pending = getUserQuestionChannel()!.ask(request(OTHER));

        const tab = (app as any).buildSessionBarTabs().find((item: any) => item.sessionId === OTHER);
        expect(tab.question).toBe(true);
        expect((app as any).buildSessionBarTabs().find((item: any) => item.sessionId === SESSION).question).toBe(false);

        (app as any).pendingQuestions.get(OTHER).settle({ cancelled: true });
        await pending;
        expect((app as any).buildSessionBarTabs().find((item: any) => item.sessionId === OTHER).question).toBe(false);
    });

    test("事件流里单独渲染问答：折叠态也看得见，且只有 ask_user 享受这个待遇", () => {
        const { app, store } = makeApp();
        const askBlock = {
            id: 1,
            requestId: 1,
            toolId: 1,
            callId: "call-ask",
            name: "ask_user",
            args: JSON.stringify({ questions: [question()] }),
            result: "用户已回答：\n1. 这次部署走哪条路？ → 方案 A",
            isError: false,
            expanded: false,
            text: "",
        };
        const otherBlock = {
            ...askBlock,
            id: 2,
            toolId: 2,
            callId: "call-other",
            name: "yfinance__quote",
            args: '{"symbols":["TSM"]}',
            result: "ok",
        };
        store.messages = [{
            id: 1,
            role: "assistant",
            text: "",
            streaming: false,
            sortKey: Date.now(),
            timeline: [{ type: "tool", block: askBlock }, { type: "tool", block: otherBlock }],
            toolBlocks: [askBlock, otherBlock],
        }];

        (app as any).syncMessages();
        const entry = (app as any).messageComponents.get(1);
        const lines: string[] = entry.timeline.children.flatMap((child: any) => child.render(120));
        const plain = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

        expect(plain).toContain("❓ 提问");
        expect(plain).toContain("✓ 1. 部署方式 · 这次部署走哪条路？ → 方案 A");
        // 普通工具块在折叠态依旧不出现（只有专门的渲染器把它带进事件流）
        expect(plain).not.toContain("yfinance__quote");
    });

    test("详细模式下作答后立即更新消息流，无需等待回合结束", async () => {
        const { app, store, agent } = makeApp();
        await app.init();
        store.setCurrentSession(SESSION);
        (app as any).detailed = true;

        agent.onEvent(1, SESSION, { type: "turn_start", iteration: 0 });
        agent.onEvent(1, SESSION, {
            type: "tool_start",
            toolId: 1,
            callId: "call-ask",
            name: "ask_user",
            args: { questions: [question()] },
            mode: "serial",
        });
        (app as any).syncMessages();

        const visibleText = (): string => {
            const entry = [...(app as any).messageComponents.values()].find((item: any) => item.timeline);
            return entry.timeline.children.flatMap((child: any) => child.render(120)).join("\n")
                .replace(/\x1b\[[0-9;]*m/g, "");
        };
        expect(visibleText()).toContain("提问（等待作答）");

        agent.onEvent(1, SESSION, {
            type: "tool_result",
            toolId: 1,
            callId: "call-ask",
            name: "ask_user",
            summary: "用户已回答：\n1. 这次部署走哪条路？ → 方案 A",
            isError: false,
            durationMs: 1,
        });
        await Bun.sleep(30);

        expect((app as any).turnState.phase(SESSION)).toBeDefined();
        expect(visibleText()).toContain("这次部署走哪条路？ → 方案 A");
    });

    test("herdr 状态：提问挂起时 blocked，作答后回到 idle", async () => {
        const { app } = makeApp();
        herdrEvents.length = 0;

        const pending = getUserQuestionChannel()!.ask(request());
        expect(lastHerdrState()).toEqual(["blocked", "部署方式 · 这次部署走哪条路？"]);

        (app as any).handlePanelInput("\r");
        await pending;
        expect(lastHerdrState()).toEqual(["idle", undefined]);
    });

    test("herdr 状态：启动期阻断优先于提问与空闲", async () => {
        const { app } = makeApp();
        herdrEvents.length = 0;

        app.setHerdrBlocked("provider 配置无效");
        expect(lastHerdrState()).toEqual(["blocked", "provider 配置无效"]);

        const pending = getUserQuestionChannel()!.ask(request());
        expect(lastHerdrState()).toEqual(["blocked", "provider 配置无效"]);
        (app as any).pendingQuestions.get(SESSION).settle({ cancelled: true });
        await pending;
        expect(lastHerdrState()).toEqual(["blocked", "provider 配置无效"]);
    });

    test("herdr metadata：当前会话标题、显示名与 session token", () => {
        const { app } = makeApp();
        herdrEvents.length = 0;

        (app as any).syncHerdrMetadata();
        const metadata = herdrEvents.find(event => event.kind === "metadata")!.args[0] as any;
        expect(metadata.title).toBe("提问会话");
        expect(metadata.displayAgent).toBe("zbot");
        expect(metadata.tokens.session).toBe(SESSION.slice(-8));
    });

    test("herdr 状态：多会话并行，一个会话结束仍保持 working", async () => {
        const { app, agent } = makeApp();
        await app.init();
        herdrEvents.length = 0;

        agent.onEvent(1, SESSION, { type: "turn_start", iteration: 0 });
        agent.onEvent(1, OTHER, { type: "turn_start", iteration: 0 });
        expect(lastHerdrState()).toEqual(["working", undefined]);

        agent.onEvent(1, SESSION, { type: "message_end" });
        agent.onTurnFinished(SESSION);
        expect(lastHerdrState()).toEqual(["working", undefined]);

        agent.onEvent(1, OTHER, { type: "message_end" });
        agent.onTurnFinished(OTHER);
        expect(lastHerdrState()).toEqual(["idle", undefined]);
    });
});

function lastHerdrState(): [string, string | undefined] {
    const event = [...herdrEvents].reverse().find(item => item.kind === "state");
    return event ? [event.args[0] as string, event.args[1] as string | undefined] : ["none", undefined];
}
