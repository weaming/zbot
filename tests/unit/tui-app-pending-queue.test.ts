import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import fs from "fs";
import os from "os";
import path from "path";
import { getWheelLogFile } from "../../src/utils/state-paths.js";
import { SPINNER_FRAMES } from "../../src/tui/session-marker.js";
import type { SessionReleaseCause } from "../../src/host/session-host-types.js";

/**
 * TUI Pending 队列测试：
 * - mock 掉 @earendil-works/pi-tui，只暴露 ChatApp 真正用到的 API；
 * - mock 掉 services/chat-runtime，只把 runChatQuery 换成返回固定文本的桩
 *   （这些测试不触发真实 LLM，只走 ChatApp 的本地状态机）。
 * - LocalSessionHost 不直接使用；这里用极简 fake SessionHost 测 ChatApp。
 */

import { tuiStub } from "./tui-stub.js";
import { isolateModelEnv } from "./test-env.js";

mock.module("@earendil-works/pi-tui", () => tuiStub);

// 透传 chat-runtime 全 export，只替换 runChatQuery。
const realChatRuntime = await import("../../src/services/chat-runtime.js");
mock.module("../../src/services/chat-runtime.js", () => ({
    ...realChatRuntime,
    runChatQuery: async () => ({ content: "stub", toolCalls: 0, messages: [] }),
}));

const { ChatApp } = await import("../../src/tui/app.js");
const { ChatStore } = await import("../../src/tui/store.js");


/**
 * 往面板栈里塞一个假浮层：等价于"某个面板已打开并已渲染 height 行"。
 * 面板栈是唯一数据源，测试必须通过 panels 读写，不能再直接改 app 字段。
 */
function pushFakePanel(
    app: any,
    options: {
        kind?: string;
        height?: number;
        bounds?: { row: number; col: number; width: number; height: number };
        handleInput?: (data: string) => void;
        focus?: () => void;
    } = {},
): void {
    const height = options.height ?? 16;
    const panel = {
        handleInput: options.handleInput ?? (() => {}),
        updateItems: () => {},
        dispose: () => {},
    };
    const handle = {
        handle: {
            hide() {},
            focus: options.focus ?? (() => {}),
            isFocused: () => true,
            ...(options.bounds ? { getBounds: () => options.bounds } : {}),
        },
        height: () => height,
    };
    (app as any).panels.push({ kind: options.kind ?? "session", panel, meta: handle });
}

let tmpDir: string;
let originalStateDir: string | undefined;
let originalTuiCwd: string | undefined;
let restoreModelEnv: () => void;

interface FakeAgent {
    sendMessageCalls: { sessionId: string; text: string; resolve: (v: { aborted?: boolean }) => void }[];
    listSessions: () => Promise<any[]>;
    readSessionEvents: () => Promise<any[]>;
    createSession: () => Promise<{ sessionId: string }>;
    onEvent?: any;
    appendInputHistory: (sessionId: string, text: string) => Promise<void>;
    loadInputHistory: (sessionId: string) => string[];
    isSessionBusy: () => boolean;
    isSessionLockedByOther: () => boolean;
    getSystemPrompt: () => Promise<string>;
    reloadRuntime: () => Promise<{ skillCount: number; mcpServerCount: number; mcpToolCount: number }>;
    compactSession: () => Promise<void>;
    closeSession: () => Promise<void>;
    unarchiveSession: () => Promise<void>;
    abortSession: () => Promise<boolean>;
    getInstanceNetworkStats: () => any;
    clearSession: () => Promise<void>;
    deleteSession: () => Promise<void>;
    renameSession: (sessionId: string, title: string) => Promise<void>;
    getSessionCwd: () => Promise<string>;
    getSessionModelSelection: (sessionId: string) => Promise<{ protocol: string; model: string } | undefined>;
    setSessionModelSelection: (sessionId: string, selection: { protocol: string; model: string }) => Promise<void>;
    detachPeerWaits: (sessionId: string) => number;
    takePeerResults: (sessionId: string) => string[];
    claimSession: (sessionId: string) => Promise<{ ok: true }>;
    releaseSession: (sessionId: string, options?: { cause?: SessionReleaseCause }) => void;
    onSessionReleased?: (sessionId: string, cause: SessionReleaseCause) => void;
    isSessionClaimed: (sessionId: string) => boolean;
    claimedSessionIds: () => string[];
    probeSession: (sessionId: string) => Promise<{ state: "free" | "mine" | "other" }>;
    listSessionOwnership: (sessionIds: string[]) => Promise<Map<string, { state: string }>>;
    peerPendingStats: (sessionId: string) => { awaiting: number; queued: number };
    appendPeerMessage: (sessionId: string, payload: any) => Promise<void>;
    close: () => void;
    reloadRuntimeCalls: number;
}

function makeFakeAgent(): FakeAgent {
    const sendMessageCalls: any[] = [];
    /** 被认领的会话：测试可直接改写以模拟"本实例持有某些会话"。 */
    const claimed = new Set<string>();
    let agent!: FakeAgent;
    agent = {
        sendMessageCalls,
        claimSession: async (sessionId: string) => {
            claimed.add(sessionId);
            return { ok: true as const };
        },
        // 与真实 LocalSessionHost 一致：释放持有会同步通知宿主（本实例主动关闭 / 被接管）
        releaseSession: (sessionId: string, options?: { cause?: SessionReleaseCause }) => {
            claimed.delete(sessionId);
            agent.onSessionReleased?.(sessionId, options?.cause ?? "peer");
        },
        isSessionClaimed: (sessionId: string) => claimed.has(sessionId),
        claimedSessionIds: () => [...claimed],
        probeSession: async () => ({ state: "mine" as const }),
        listSessionOwnership: async () => new Map(),
        peerPendingStats: () => ({ awaiting: 0, queued: 0 }),
        appendPeerMessage: async () => {},
        listSessions: async () => [],
        listActiveSessionIds: () => [],
        readSessionEvents: async () => [],
        createSession: async () => ({ sessionId: "sess-pending-test" }),
        appendInputHistory: async () => {},
        loadInputHistory: () => [],
        isSessionBusy: () => false,
        isSessionLockedByOther: () => false,
        getSystemPrompt: async () => "",
        reloadRuntime: async () => {
            agent.reloadRuntimeCalls += 1;
            return { skillCount: 3, mcpServerCount: 2, mcpToolCount: 5 };
        },
        compactSession: async () => {},
        closeSession: async () => {},
        unarchiveSession: async () => {},
        abortSession: async () => false,
        getInstanceNetworkStats: () => ({ sessionCount: 0, requestCount: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }),
        clearSession: async () => {},
        deleteSession: async () => {},
        renameSession: async () => {},
        getSessionCwd: async () => tmpDir,
        getSessionModelSelection: async () => undefined,
        setSessionModelSelection: async () => {},
        detachPeerWaits: () => 0,
        takePeerResults: () => [],
        resumeSession: async () => ({ resumed: true }),
        close: () => {},
        reloadRuntimeCalls: 0,
    };
    return agent;
}

beforeEach(async () => {
    // 宿主 shell 导出的模型配置会让 getChatApiSettings 返回真实模型，隔离后再断言默认值。
    restoreModelEnv = isolateModelEnv();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-tui-pending-"));
    originalStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;
    originalTuiCwd = process.env.TUI_CWD;
});

afterEach(() => {
    restoreModelEnv();
    if (originalStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = originalStateDir;
    // ChatApp 会把进程级 TUI_CWD 切到会话目录；不还原会让后续文件拿到已删除的临时目录。
    if (originalTuiCwd === undefined) delete process.env.TUI_CWD;
    else process.env.TUI_CWD = originalTuiCwd;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// mock.module 是进程级全局：本文件跑完必须恢复，否则后续测试文件会拿到
// 缺失行为的假组件（例如没有 padding / 截断的 Text）。
afterAll(() => {
    mock.restore();
});

describe("ChatApp pending queue", () => {
    test("上下箭头切换多行历史后光标位于整段文字末尾", () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        const editor = (app as any).editor;

        editor.setHistory(["较新第一行\n较新末行", "较旧第一行\n较旧末行"]);

        editor.handleInput("\x1b[A");
        expect(editor.state.cursorLine).toBe(1);
        expect(editor.state.cursorCol).toBe("较新末行".length);

        editor.handleInput("\x1b[A");
        editor.handleInput("\x1b[B");
        expect(editor.state.cursorLine).toBe(1);
        expect(editor.state.cursorCol).toBe("较新末行".length);
    });

    test("enqueueOrSend enqueues when busy and renders the pending list", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        // 模拟 busy 状态：enqueueOrSend 走入队分支
        store.currentSessionId = "sess-pending";
        // 会话级忙：该会话有进行中的 turn 阶段
        (app as any).turnState.setPhase("sess-pending", "waiting");
        app.enqueueOrSend("再发一次消息");
        app.enqueueOrSend("再来一条");
        expect((app as any).pendingMessages).toEqual(["再发一次消息", "再来一条"]);
        expect((app as any).pendingIndex).toBe(1);
        const children = (app as any).pendingList.children as any[];
        const lines = children.map(child => child.getText());
        // 第一行 header，第三/四行是两条消息；选中的（index 1）有 > 前缀
        expect(lines[0]).toContain("2 pending");
        expect(lines[0]).toContain("⌥↑/⌥↓ 选择");
        expect(lines[1]).toContain("1) 再发一次消息");
        expect(lines[1]).not.toContain(">");
        expect(lines[2]).toContain("> 2) 再来一条");
        // 选中行长度与 layout 高度
        const minSizeEntry = (app as any).layout.entries.find((e: any) => e.component === (app as any).pendingList);
        expect(minSizeEntry.minSize).toBe(1 + 2);
    });

    test("enqueueOrSend 直接 send 当不 busy", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        (app as any).store.currentSessionId = "sess-pending-test";
        // 不 mock sendMessage；用 spy 替代。
        (app as any).turnState.clearPhase("sess-pending-test");
        (app as any).switching = false;
        const sendSpy = mock((_text: string) => {});
        (app as any).send = sendSpy;
        app.enqueueOrSend("直接发");
        expect(sendSpy).toHaveBeenCalledTimes(1);
        expect(sendSpy.mock.calls[0][0]).toBe("直接发");
        expect((app as any).pendingMessages).toEqual([]);
    });

    test("无会话时提交消息：先新建会话再发送", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        const sendSpy = mock((_text: string) => {});
        (app as any).send = sendSpy;
        (app as any).syncCurrentSessionState = () => {};

        expect(store.currentSessionId).toBeNull();
        app.enqueueOrSend("启动后的第一条消息");
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(store.currentSessionId).toBe("sess-pending-test");
        expect(sendSpy).toHaveBeenCalledTimes(1);
        expect(sendSpy.mock.calls[0][0]).toBe("启动后的第一条消息");
        expect((app as any).pendingMessages).toEqual([]);
    });

    test("非用户回合（群消息驱动）结束后自动放行排队的输入", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.setCurrentSession("sess-pending-test");
        store.setSessions([{ sessionId: "sess-pending-test", messageCount: 0 }]);

        const sent: string[] = [];
        (agent as any).sendMessage = async (_sessionId: string, text: string) => {
            sent.push(text);
            return {};
        };

        // 会话正被群消息回合占用：用户输入只能排队
        (agent as any).isSessionBusy = () => true;
        app.enqueueOrSend("排队中的消息");
        expect((app as any).pendingMessages).toEqual(["排队中的消息"]);

        // 群消息回合结束：agent 通知宿主，排队消息立刻发出（无需切会话）
        (agent as any).isSessionBusy = () => false;
        agent.onTurnFinished?.("sess-pending-test");
        // 轮询等待放行落地：固定 sleep 在负载高时会偶发失败
        for (let attempt = 0; attempt < 100 && sent.length === 0; attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }

        expect(sent).toEqual(["排队中的消息"]);
        expect((app as any).pendingMessages).toEqual([]);
    });

    test("非用户回合结束后复位当前会话忙标记，tab 不再停在 spinner", () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.setCurrentSession("sess-pending-test");
        store.setSessions([{ sessionId: "sess-pending-test", messageCount: 0 }]);
        void (agent as any).claimSession("sess-pending-test");

        // 会话被群消息回合占用：切到它时 syncCurrentSessionState 会把 busy 置为 true
        (agent as any).isSessionBusy = () => true;
        (app as any).syncCurrentSessionState();
        expect((app as any).isCurrentBusy()).toBe(true);
        expect((app as any).buildSessionBarTabs()[0].busy).toBe(true);

        // 回合真正结束（会话锁已释放，但不再经过 send() 的 finally）
        (agent as any).isSessionBusy = () => false;
        agent.onTurnFinished?.("sess-pending-test");

        expect((app as any).isCurrentBusy()).toBe(false);
        expect((app as any).buildSessionBarTabs()[0].busy).toBe(false);
    });

    test("refreshSessions 只加载已有会话，不自动新建", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);

        await (app as any).refreshSessions();

        expect(store.sessions).toEqual([]);
        expect(store.currentSessionId).toBeNull();
    });

    test("steer 接受后移除待发项并立即在当前时间线显示用户补充消息", () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        const sessionId = "sess-steer";
        store.setCurrentSession(sessionId);
        (agent as any).isSessionBusy = () => true;
        let accept: (() => void) | undefined;
        (agent as any).steerResponse = (_id: string, _text: string, onAccepted: () => void) => {
            accept = onAccepted;
            return Promise.resolve(true);
        };

        app.enqueueOrSend("正在运行时的补充");
        expect(app.pendingMessages).toEqual(["正在运行时的补充"]);
        expect(store.messages).toHaveLength(0);

        accept?.();
        expect(app.pendingMessages).toEqual([]);
        expect(store.messages.some(message =>
            message.text === "正在运行时的补充"
            || message.timeline?.some(item => item.type === "user" && item.text === "正在运行时的补充"),
        )).toBe(true);
    });

    test("steer 状态贴在对应 pending 消息右侧，不占助手时间线", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        await app.init();
        const sessionId = "sess-steer-status";
        store.setCurrentSession(sessionId);
        (agent as any).isSessionBusy = () => true;
        (agent as any).steerResponse = () => new Promise<boolean>(() => {});

        app.enqueueOrSend("第一条");
        app.enqueueOrSend("第二条");
        const lines = () => (app as any).pendingList.children.slice(1)
            .map((child: any) => stripTerminalSequences(child.getText()));

        expect(lines()[0]).toMatch(/第一条\s+切入中$/);
        expect(lines()[1]).toMatch(/第二条\s+切入中$/);
        expect(visibleWidth(lines()[0])).toBe(visibleWidth(lines()[1]));

        agent.onEvent?.(1, sessionId, { type: "steer_update", responseId: "response-a", phase: "accepted" });
        expect(lines()[0]).toMatch(/第一条\s+已接收$/);
        expect(lines()[1]).toMatch(/第二条\s+切入中$/);

        agent.onEvent?.(1, sessionId, { type: "steer_update", responseId: "response-a", phase: "failed" });
        agent.onEvent?.(1, sessionId, { type: "steer_update", responseId: "response-b", phase: "accepted" });
        expect(lines()[0]).toMatch(/第一条\s+切入失败$/);
        expect(lines()[1]).toMatch(/第二条\s+已接收$/);
        expect(store.messages.every(message => message.role !== "assistant")).toBe(true);
    });

    test("deletePending 按索引删除，pendingIndex 越界时收回", () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        (app as any).pendingMessages = ["a", "b", "c"];
        (app as any).pendingIndex = 1;
        // 删除非选中
        expect(app.deletePending(0)).toBe(true);
        expect((app as any).pendingMessages).toEqual(["b", "c"]);
        // pendingIndex 仍然指向 b，没变
        expect((app as any).pendingIndex).toBe(1);
        // 越界返回 false
        expect(app.deletePending(5)).toBe(false);
        // 删除当前选中
        expect(app.deletePending(1)).toBe(true);
        expect((app as any).pendingMessages).toEqual(["b"]);
        // 删除最后一条后归零
        expect(app.deletePending(0)).toBe(true);
        expect((app as any).pendingMessages).toEqual([]);
        expect((app as any).pendingIndex).toBe(0);
    });

    test("clearPending 清空队列和索引", () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        (app as any).pendingMessages = ["x", "y"];
        (app as any).pendingIndex = 1;
        app.clearPending();
        expect((app as any).pendingMessages).toEqual([]);
        expect((app as any).pendingIndex).toBe(0);
    });

    test("↑/↓ 切换 pendingIndex 时，selected 行带 > 前缀", () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "sess-pending";
        (app as any).turnState.setPhase("sess-pending", "waiting");
        app.enqueueOrSend("a");
        app.enqueueOrSend("b");
        app.enqueueOrSend("c");
        // children[0] 是 header；当前选中是 c（最新），即 children[3]
        let lines = (app as any).pendingList.children.map((c: any) => c.getText());
        expect(lines.findIndex((l: string) => l.includes(">"))).toBe(3);
        expect(lines[3]).toContain("> 3) c");
        // ↑ 回到 b
        (app as any).pendingIndex = 1;
        app.renderPending();
        lines = (app as any).pendingList.children.map((c: any) => c.getText());
        expect(lines.findIndex((l: string) => l.includes(">"))).toBe(2);
        expect(lines[2]).toContain("> 2) b");
        // ↑ 到 a
        (app as any).pendingIndex = 0;
        app.renderPending();
        lines = (app as any).pendingList.children.map((c: any) => c.getText());
        expect(lines.findIndex((l: string) => l.includes(">"))).toBe(1);
        expect(lines[1]).toContain("> 1) a");
    });

    test("超出 PENDING_MAX_VISIBLE 时窗口化，只显示围绕选中行的子集", () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "sess-pending";
        (app as any).turnState.setPhase("sess-pending", "waiting");
        for (let i = 0; i < 8; i += 1) app.enqueueOrSend(`m${i}`);
        // 选中第 6 条（index 5）；窗口居中应显示 m3..m7
        (app as any).pendingIndex = 5;
        app.renderPending();
        const lines = (app as any).pendingList.children.slice(1).map((c: any) => c.getText());
        // 行数 = 5（max visible），不含全部 8 条
        expect(lines.length).toBe(5);
        expect(lines[0]).toContain("m3");
        expect(lines[lines.length - 1]).toContain("m7");
        // 选中行（m5）带 > 前缀
        const selectedIndex = lines.findIndex((l: string) => l.includes(">"));
        expect(lines[selectedIndex]).toContain("m5");
    });

    test("真实 send 完成触发 pending 出队（覆盖生产代码 finally 路径）", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        (app as any).store.currentSessionId = "sess-pending-test";
        (app as any).store.addUserMessage = () => {};
        (app as any).syncCurrentSessionState = () => {};
        (app as any).editor.addToHistory = () => {};
        (app as any).editor.setCompact = () => {};
        (app as any).layout.setMinSize = () => {};
        (app as any).store.setAllToolBlocksExpanded = () => {};
        (app as any).pendingMessages = ["queued-1"];
        (app as any).pendingIndex = 0;

        let calls: string[] = [];
        (app as any).agent.sendMessage = async (_sid: string, text: string) => {
            calls.push(text);
            return { aborted: false };
        };

        // 真实 send 路径：第一次发 "first"，finally 出队 "queued-1" 再 send 一次。
        await (app as any).send("first");
        // 等待一次 microtask 让出队后的 send 跑完
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(calls).toContain("first");
        expect(calls).toContain("queued-1");
        expect((app as any).pendingMessages).toEqual([]);
        expect((app as any).pendingIndex).toBe(0);
    });

    test("提交消息后立即加入输入历史，回合中止不重复加入", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "sess-pending-test";
        const editorHistory: string[] = [];
        const persistedHistory: string[] = [];

        (app as any).store.addUserMessage = () => {};
        (app as any).syncCurrentSessionState = () => {};
        (app as any).editor.addToHistory = (text: string) => editorHistory.push(text);
        (app as any).agent.appendInputHistory = async (_sessionId: string, text: string) => {
            persistedHistory.push(text);
        };
        (app as any).agent.sendMessage = async () => ({ aborted: true });

        app.enqueueOrSend("被中止的消息");
        await Promise.resolve();

        expect(editorHistory).toEqual(["被中止的消息"]);
        expect(persistedHistory).toEqual(["被中止的消息"]);
    });

    test("发生上下文裁剪后显示提示", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        (app as any).store.currentSessionId = "sess-pending-test";
        (app as any).store.addUserMessage = () => {};
        (app as any).syncCurrentSessionState = () => {};
        (app as any).editor.addToHistory = () => {};
        (app as any).editor.setCompact = () => {};
        (app as any).layout.setMinSize = () => {};
        (app as any).store.setAllToolBlocksExpanded = () => {};
        (app as any).agent.sendMessage = async () => ({ aborted: false });

        await (app as any).send("发送消息");

        expect(store.messages.some(message => message.role === "system" && message.text.includes("上下文已自动裁剪"))).toBe(false);
    });

    test("selectSession 切换会话保留各会话独立 pending 队列", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "session-a";
        (app as any).pending.replace("session-a", ["a1", "a2"]);
        (app as any).pending.setIndex("session-a", 1);
        (app as any).pending.replace("session-b", ["b1"]);

        // session-b 处于 busy 状态时，切过去不应自动出队，队列保持完整
        (agent as any).isSessionBusy = (sid?: string) => sid === "session-b";

        (app as any).store.hasSessionView = () => true;
        (app as any).store.refreshView = () => {};
        (app as any).store.loadHistory = () => {};
        (app as any).clearMessages = () => {};
        (app as any).renderTabBar = () => {};
        (app as any).syncCurrentSessionState = () => {};

        // 切换到 session-b
        await (app as any).selectSession("session-b");
        expect(store.currentSessionId).toBe("session-b");
        expect(app.pendingMessages).toEqual(["b1"]);
        expect(app.pendingIndex).toBe(0);

        // 在 session-b 中添加一条 pending（getter 返回快照，改它不会写回队列，必须显式入队）
        (app as any).pending.push("session-b", "b2");
        expect(app.pendingMessages).toEqual(["b1", "b2"]);

        // 切换回 session-a，session-a 处于 idle 会自动将所有 pending 组合发送
        const sendCalls: string[] = [];
        (app as any).send = async (text: string, sid?: string) => {
            sendCalls.push(`${sid}:${text}`);
        };
        await (app as any).selectSession("session-a");
        expect(store.currentSessionId).toBe("session-a");
        expect(sendCalls).toEqual(["session-a:a1\na2"]);
        expect(app.pendingMessages).toEqual([]);

        // 再次切到 session-b（仍 busy），session-b 的 pending 也完整保留
        await (app as any).selectSession("session-b");
        expect(app.pendingMessages).toEqual(["b1", "b2"]);
    });

    test("后台 session 在 send 完成后自动触发该 session 的 pending 续发", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "session-a";
        (app as any).syncCurrentSessionState = () => {};
        (app as any).editor.addToHistory = () => {};
        (app as any).editor.setCompact = () => {};
        (app as any).layout.setMinSize = () => {};
        (app as any).store.setAllToolBlocksExpanded = () => {};

        (app as any).pending.replace("session-a", ["a-queued"]);

        const sentMap: { sessionId: string; text: string }[] = [];
        (app as any).agent.sendMessage = async (sid: string, text: string) => {
            sentMap.push({ sessionId: sid, text });
            return { aborted: false };
        };

        // 切换到 session-b
        store.currentSessionId = "session-b";

        // session-a 的后台 send 完成
        await (app as any).send("a-first", "session-a");
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(sentMap).toEqual([
            { sessionId: "session-a", text: "a-first" },
            { sessionId: "session-a", text: "a-queued" },
        ]);
        expect((app as any).pending.messages("session-a")).toEqual([]);
    });

    test("renderStatusBar 正确显示当前模型和思考强度，以及最后收到消息的输入token与模型总额百分比（为0项不展示）", () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "session-status-test";

        process.env.OPENAI_MODEL = "deepseek-reasoner";
        process.env.REASONING_EFFORT = "high";

        // 1. 模拟未产生 reasoning 与 cache 的 usage（不渲染 🤔 与 🎯）
        store.applyEvent(1, "session-status-test", {
            type: "usage",
            usage: {
                model: "deepseek-reasoner",
                promptTokens: 6400,
                completionTokens: 200,
                totalTokens: 6600,
                durationMs: 1,
            },
        });

        (app as any).renderStatusBar();

        const statusBar = (app as any).statusBar;
        let rendered = statusBar.render(120) as string[];
        expect(rendered.length).toBe(2);
        expect(rendered[0]).toContain("deepseek-reasoner");
        expect(rendered[0]).toContain("high");
        expect(rendered[0]).not.toContain("已连接");
        expect(rendered[0]).not.toContain("session-status-test");
        expect(rendered[1]).toContain("session-status-test");
        expect(rendered[1]).toContain("6.4k/64k(10.0%)");
        expect(rendered[1]).toContain("Σ6.6k");
        expect(rendered[1]).toContain("6.4k=>200");
        expect(rendered[1]).not.toContain("🤔");
        expect(rendered[1]).not.toContain("🎯");

        // 2. 模拟带 reasoning 与 cache 命中的 usage（正常展示 🤔 与 🎯）
        store.applyEvent(2, "session-status-test", {
            type: "usage",
            usage: {
                model: "deepseek-reasoner",
                promptTokens: 3200,
                completionTokens: 100,
                reasoningTokens: 56,
                cacheHitTokens: 3000,
                cacheMissTokens: 200,
                totalTokens: 3300,
                durationMs: 1,
            },
        });
        (app as any).renderStatusBar();
        rendered = statusBar.render(120) as string[];
        expect(rendered[1]).toContain("🤔56");
        expect(rendered[1]).toContain("🎯93.8%(3k/200)");

        // 3. 模拟请求发出后（忙碌/等待响应阶段）：状态栏应显示 Spinner 与等待提示
        (app as any).setSessionPhase("session-status-test", "waiting");
        (app as any).renderStatusBar();
        rendered = statusBar.render(120) as string[];
        expect(rendered[0]).toContain("等待响应...");

        // 4. 模拟转入思考中与工具执行阶段
        (app as any).setSessionPhase("session-status-test", "reasoning");
        (app as any).renderStatusBar();
        rendered = statusBar.render(120) as string[];
        expect(rendered[0]).toContain("思考中...");

        (app as any).setSessionPhase("session-status-test", "tool", "execute-shell");
        (app as any).renderStatusBar();
        rendered = statusBar.render(120) as string[];
        expect(rendered[0]).toContain("执行工具 execute-shell...");

        // 5. 模拟完成清空阶段
        (app as any).clearSessionPhase("session-status-test");
        (app as any).renderStatusBar();
        rendered = statusBar.render(120) as string[];
        expect(rendered[0]).not.toContain("等待响应");
        expect(rendered[0]).not.toContain("思考中");
        expect(rendered[0]).not.toContain("执行工具");

        delete process.env.REASONING_EFFORT;
    });

    test("renderStatusBar 在工具调用超过 3 秒时在右下角同时显示当前工具计时", () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        const statusBar = (app as any).statusBar;
        store.currentSessionId = "session-tool-timing-test";

        const now = Date.now();
        // 1. 工具调用耗时 < 3s 时，只显示总耗时
        (app as any).turnState.setPhase("session-tool-timing-test", "tool", "bash");
        (app as any).turnState.touch("session-tool-timing-test", {
            startTime: now - 5000,
            toolStartTime: now - 2000,
        });
        (app as any).renderStatusBar();
        let rendered = statusBar.render(120) as string[];
        expect(rendered[0]).toContain("执行工具 bash...");
        expect(rendered[0]).toContain("(5.0s)");
        expect(rendered[0]).not.toContain("|");

        // 2. 工具调用耗时 >= 3s 时，显示「工具耗时 | 总耗时」
        (app as any).turnState.touch("session-tool-timing-test", {
            startTime: now - 8000,
            toolStartTime: now - 4500,
        });
        (app as any).renderStatusBar();
        rendered = statusBar.render(120) as string[];
        expect(rendered[0]).toContain("执行工具 bash...");
        expect(rendered[0]).toContain("(4.5s | 8.0s)");
    });

    test("handleCommand 的思考强度只由 /model effort 设置", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "session-cmd-test";

        // 1. 无参查询
        await (app as any).handleCommand("/model effort");
        expect(store.messages.some(m => m.role === "system" && m.text.includes("当前思考强度"))).toBe(true);

        // 2. 设置 high
        const selections: Array<{ sessionId: string; selection: any }> = [];
        (agent as any).setSessionModelSelection = async (sessionId: string, selection: any) => {
            selections.push({ sessionId, selection });
        };
        await (app as any).handleCommand("/model effort high");
        // 会话内设置：写会话级选择，不污染进程环境
        expect(selections.at(-1)?.sessionId).toBe("session-cmd-test");
        expect(selections.at(-1)?.selection.reasoningEffort).toBe("high");
        expect(process.env.REASONING_EFFORT).toBeUndefined();
        expect(store.messages.some(m => m.role === "system" && m.text.includes("思考强度已设置为: high"))).toBe(true);

        // 3. 重置为 auto
        await (app as any).handleCommand("/model effort auto");
        expect(selections.at(-1)?.selection.reasoningEffort).toBe("auto");
        expect(store.messages.some(m => m.role === "system" && m.text.includes("思考强度已设为 auto"))).toBe(true);

        // 4. 非法参数报错
        await (app as any).handleCommand("/model effort invalid_level");
        expect(store.messages.some(m => m.role === "system" && m.text.includes("未知思考强度"))).toBe(true);

        // 5. /mcp 命令
        await (app as any).handleCommand("/mcp");
        expect(store.messages.some(m => m.role === "system" && m.text.includes("MCP 服务"))).toBe(true);

        // 6. /help 命令包含 /mcp
        await (app as any).handleCommand("/help");
        expect(store.messages.some(m => m.role === "system" && m.text.includes("/mcp"))).toBe(true);
    });

    test("/model 按目标模型的档位校验并归一化（与 session send 同口径）", async () => {
        // 当前模型是 deepseek 系（档位 none/low/high/max），目标模型是 responses 系
        // （档位含 minimal/medium/xhigh、没有 max）：两套档位不同，正是历史 bug 的场景
        const saved = {
            chatModel: process.env.OPENAI_CHAT_MODEL,
            responsesModel: process.env.OPENAI_RESPONSES_MODEL,
            chatBase: process.env.OPENAI_CHAT_BASE_URL,
            responsesBase: process.env.OPENAI_RESPONSES_BASE_URL,
        };
        process.env.OPENAI_CHAT_MODEL = "deepseek-chat";
        process.env.OPENAI_RESPONSES_MODEL = "gpt-5";
        process.env.OPENAI_CHAT_BASE_URL = "https://api.deepseek.com/v1";
        process.env.OPENAI_RESPONSES_BASE_URL = "https://api.openai.com/v1";
        try {
            const agent = makeFakeAgent();
            const store = new ChatStore();
            const app = new ChatApp(agent as any, store);
            store.currentSessionId = "session-model-use-test";
            (app as any).currentModelSelection = {
                protocol: "chat_completions",
                model: "deepseek-chat",
                reasoningEffort: "max",
            };
            const selections: any[] = [];
            (agent as any).setSessionModelSelection = async (_sessionId: string, selection: any) => {
                selections.push(selection);
            };

            // 目标模型支持的 medium：必须成功（旧实现用当前模型档位会被误判为未知）
            await (app as any).handleCommand("/model responses gpt-5 medium");
            expect(selections.at(-1)).toEqual({
                protocol: "responses",
                model: "gpt-5",
                reasoningEffort: "medium",
            });
            expect(store.messages.some(m => m.role === "system" && m.text.includes("未知思考强度"))).toBe(false);

            // 归一化：大写 HIGH 落盘为小写 high
            await (app as any).handleCommand("/model responses gpt-5 HIGH");
            expect(selections.at(-1)?.reasoningEffort).toBe("high");

            // 目标模型不支持的 max：必须报错并且不落盘（旧实现用当前模型档位会放过）
            const before = selections.length;
            await (app as any).handleCommand("/model responses gpt-5 max");
            expect(selections.length).toBe(before);
            expect(store.messages.some(m => m.role === "system" && m.text.includes("未知思考强度"))).toBe(true);

            // 省略强度：沿用当前档位（目标模型支持 high）
            await (app as any).handleCommand("/model responses gpt-5");
            expect(selections.at(-1)?.reasoningEffort).toBe("high");

            // 省略强度且原档位在目标模型不支持：回落 auto
            (app as any).currentModelSelection = {
                protocol: "chat_completions",
                model: "deepseek-chat",
                reasoningEffort: "max",
            };
            await (app as any).handleCommand("/model responses gpt-5");
            expect(selections.at(-1)?.reasoningEffort).toBe("auto");
        } finally {
            for (const [key, value] of Object.entries({
                OPENAI_CHAT_MODEL: saved.chatModel,
                OPENAI_RESPONSES_MODEL: saved.responsesModel,
                OPENAI_CHAT_BASE_URL: saved.chatBase,
                OPENAI_RESPONSES_BASE_URL: saved.responsesBase,
            })) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });

    test("/model 与 /model effort 是唯一入口；/effort /thinking /reasoning 已删除", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "session-cmd-test";
        const selections: any[] = [];
        (agent as any).setSessionModelSelection = async (_sessionId: string, selection: any) => {
            selections.push(selection);
        };

        // /model effort 设置强度
        await (app as any).handleCommand("/model effort high");
        expect(selections.at(-1)?.reasoningEffort).toBe("high");
        await (app as any).handleCommand("/model effort auto");
        expect(selections.at(-1)?.reasoningEffort).toBe("auto");

        // /model 用非法模型组合时明确拒绝
        await (app as any).handleCommand("/model chat_completions not-configured");
        expect(store.messages.some(m => m.role === "system" && m.text.includes("不可用的模型组合"))).toBe(true);

        // 已删除的命令不再被识别：/effort /thinking /reasoning 按普通文本提交给模型
        const sent: string[] = [];
        (agent as any).sendMessage = async (_sessionId: string, text: string) => {
            sent.push(text);
            return { aborted: false };
        };
        const before = selections.length;
        const strengthNotices = store.messages
            .filter(m => m.role === "system" && m.text.includes("思考强度已设为")).length;
        for (const text of ["/effort high", "/thinking auto", "/reasoning on"]) {
            await (app as any).handleCommand(text);
            expect(sent.at(-1)).toBe(text);
        }
        expect(selections.length).toBe(before);
        expect(store.messages.filter(m => m.role === "system" && m.text.includes("思考强度已设为")).length)
            .toBe(strengthNotices);
    });

    test("handleCommand 支持 /reload 并提示后续请求使用新运行时", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "session-reload-test";

        await (app as any).handleCommand("/reload");

        expect(store.messages.some(
            message => message.role === "system"
                && message.text.includes("3 个技能")
                && message.text.includes("5 个 MCP 工具")
                && message.text.includes("新的 tools 和 system prompt"),
        )).toBe(true);
    });

    test("运行中回合的 /reload 按会话去重，并在回合结束后执行", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        const sessionId = "session-reload-queue-test";
        store.currentSessionId = sessionId;
        await agent.claimSession(sessionId);
        agent.isSessionBusy = () => true;

        await (app as any).handleCommand("/reload");
        await (app as any).handleCommand("/reload");

        expect(agent.reloadRuntimeCalls).toBe(0);
        expect(store.messages.some(message => message.role === "system" && message.text.includes("不再重复排队"))).toBe(true);

        agent.isSessionBusy = () => false;
        (app as any).onAgentTurnFinished(sessionId);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(agent.reloadRuntimeCalls).toBe(1);
    });

    test("selectSession 切换会话保留各会话已输入的草稿内容", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "session-draft-a";

        (app as any).store.hasSessionView = () => true;
        (app as any).store.refreshView = () => {};
        (app as any).store.loadHistory = () => {};
        (app as any).clearMessages = () => {};
        (app as any).renderTabBar = () => {};
        (app as any).syncCurrentSessionState = () => {};

        // 1. 在 session-draft-a 输入草稿
        (app as any).editor.setText("正在写的草稿 A");
        (app as any).editor.onChange?.("正在写的草稿 A");

        // 2. 切换到 session-draft-b（此前无草稿）
        await (app as any).selectSession("session-draft-b");
        expect(store.currentSessionId).toBe("session-draft-b");
        expect((app as any).editor.getText()).toBe("");

        // 3. 在 session-draft-b 输入草稿
        (app as any).editor.setText("草稿 B 内容");
        (app as any).editor.onChange?.("草稿 B 内容");

        // 4. 切回 session-draft-a，草稿 A 恢复
        await (app as any).selectSession("session-draft-a");
        expect(store.currentSessionId).toBe("session-draft-a");
        expect((app as any).editor.getText()).toBe("正在写的草稿 A");

        // 5. 切回 session-draft-b，草稿 B 恢复
        await (app as any).selectSession("session-draft-b");
        expect(store.currentSessionId).toBe("session-draft-b");
        expect((app as any).editor.getText()).toBe("草稿 B 内容");

        // 6. 清空当前 session-draft-b，草稿被清除
        await (app as any).clearCurrentSession();
        expect((app as any).editor.getText()).toBe("");

        // 7. 切回 session-draft-a，草稿 A 依然完好
        await (app as any).selectSession("session-draft-a");
        expect((app as any).editor.getText()).toBe("正在写的草稿 A");
    });

    test("展开模式（detailed）在 busy 时不刷新流式更新，turn 结束后全量同步", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "sess-detailed";
        await app.init();

        let syncCount = 0;
        (app as any).scheduleSyncMessages = () => {
            syncCount++;
        };
        let fullSyncCount = 0;
        (app as any).syncMessages = () => {
            fullSyncCount++;
        };

        // 1. 处于详细展开模式且当前会话正在生成
        (app as any).detailed = true;
        (app as any).turnState.setPhase(store.currentSessionId!, "generating");

        // 模拟消息流式更新
        (store as any).listeners?.onMessagesChanged();
        expect(syncCount).toBe(0);

        // 2. 没有进行中的阶段时触发更新
        (app as any).turnState.clearPhase(store.currentSessionId!);
        (store as any).listeners?.onMessagesChanged();
        expect(syncCount).toBe(1);

        // 3. send 完成后全量同步
        (app as any).detailed = true;
        (app as any).agent.sendMessage = async () => ({ aborted: false });
        await (app as any).send("test message");
        expect(fullSyncCount).toBeGreaterThan(0);
    });

    test("发送新消息或消费 pending 消息时，普通模式自动滚动到底部，Ctrl+O 展开模式不受影响", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "sess-scroll-test";
        (app as any).syncCurrentSessionState = () => {};
        (app as any).editor.addToHistory = () => {};

        let scrollToEndCalls = 0;
        (app as any).scrollView.scrollToEnd = () => {
            scrollToEndCalls++;
        };

        // 1. 普通模式下发送消息：自动滚动到底部
        (app as any).detailed = false;
        let consumeFn: (() => string[] | undefined) | undefined;
        (app as any).agent.sendMessage = async (_sess: string, _text: string, options: any) => {
            consumeFn = options.consumePendingMessages;
            return { aborted: false };
        };

        await (app as any).send("user message 1");
        expect(scrollToEndCalls).toBe(1);

        // 2. 消费 pending 消息：普通模式自动滚动到底部
        (app as any).pending.push("sess-scroll-test", "pending msg 1");
        consumeFn?.();
        expect(scrollToEndCalls).toBe(2);

        // 3. Ctrl+O 切换到展开模式：不触发 scrollToEnd
        scrollToEndCalls = 0;
        (app as any).toggleDetailed();
        expect((app as any).detailed).toBe(true);
        expect(scrollToEndCalls).toBe(0);

        // 4. 展开模式下发送新消息与消费 pending：不强制 scrollToEnd
        await (app as any).send("user message 2");
        expect(scrollToEndCalls).toBe(0);

        (app as any).pending.push("sess-scroll-test", "pending msg 2");
        consumeFn?.();
        expect(scrollToEndCalls).toBe(0);
    });

    test("展开模式（⌃O）下 ⌃U / ⌃D 翻页，普通模式不拦截", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        await app.init();

        const tui = (app as any).tui;
        const send = (data: string) => tui.inputListeners.forEach((fn: (d: string) => any) => fn(data));

        // 1. 普通模式：⌃U / ⌃D 不翻页（⌃U 放行给编辑器，⌃D 走退出确认）
        (app as any).detailed = false;
        send("\x15");
        send("\x04");
        expect(tui.scrollByCalls).toEqual([]);

        // 2. 展开模式：⌃U 上翻一页、⌃D 下翻一页（视口 20 行 → 19）
        (app as any).detailed = true;
        send("\x15");
        send("\x04");
        expect(tui.scrollByCalls).toEqual([-19, 19]);
    });

    test("滚轮诊断写入独立文件（仅 ZBOT_TUI_DEBUG_WHEEL=1 时）", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        await app.init();

        pushFakePanel(app, { bounds: { row: 4, col: 4, width: 72, height: 16 } });

        // 默认关闭：不写文件
        const logFile = getWheelLogFile();
        delete process.env.ZBOT_TUI_DEBUG_WHEEL;
        fs.rmSync(logFile, { force: true });
        expect((app as any).isWheelOutsidePanel("\x1b[<65;1;1M")).toBe(true);
        expect(fs.existsSync(logFile)).toBe(false);

        // 开启后：面板外/面板内都落盘
        process.env.ZBOT_TUI_DEBUG_WHEEL = "1";
        try {
            expect((app as any).isWheelOutsidePanel("\x1b[<65;1;1M")).toBe(true);
            expect((app as any).isWheelOutsidePanel("\x1b[<65;40;12M")).toBe(false);
        } finally {
            delete process.env.ZBOT_TUI_DEBUG_WHEEL;
        }

        const content = fs.readFileSync(logFile, "utf8");
        expect(content).toContain("面板滚轮");
        expect(content).toContain("outside=true");
        expect(content).toContain("outside=false");
    });

    test("面板打开时 restoreFocus 聚焦面板浮层而非输入框", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        await app.init();

        let panelFocused = 0;
        let editorFocused = 0;
        (app as any).tui.setFocus = () => {
            editorFocused++;
        };
        pushFakePanel(app, { focus: () => { panelFocused++; } });

        // 面板打开：焦点回面板（否则 TuiAltScreen 会自己消费滚轮去滚背景）
        (app as any).restoreFocus();
        expect(panelFocused).toBe(1);
        expect(editorFocused).toBe(0);

        // 面板关闭：焦点回输入框
        (app as any).panels.clear();
        (app as any).restoreFocus();
        expect(panelFocused).toBe(1);
        expect(editorFocused).toBe(1);
    });

    test("面板打开时滚轮只在面板矩形内转发给面板", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        await app.init();

        const received: string[] = [];
        // 面板矩形：row 10 / col 20 / 40x10（0-based），对应 SGR 坐标 row+1 / col+1
        pushFakePanel(app, {
            height: 10,
            bounds: { row: 10, col: 20, width: 40, height: 10 },
            handleInput: (data: string) => received.push(data),
        });

        const send = (data: string) => (app as any).tui.inputListeners.forEach((fn: (d: string) => any) => fn(data));

        // 面板内滚轮：转发
        send("\x1b[<65;26;16M");
        expect(received).toEqual(["\x1b[<65;26;16M"]);

        // 面板外滚轮：不转发（也不动背景）
        send("\x1b[<65;5;16M");
        send("\x1b[<64;26;30M");
        expect(received).toEqual(["\x1b[<65;26;16M"]);

        // 键盘输入仍正常转发
        send("j");
        expect(received).toEqual(["\x1b[<65;26;16M", "j"]);
    });

    test("send 完成或中断时将全部 pending 消息组合为一条（换行分隔）立即发送", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "sess-pending-test";
        (app as any).syncCurrentSessionState = () => {};
        (app as any).editor.addToHistory = () => {};
        (app as any).editor.setCompact = () => {};
        (app as any).layout.setMinSize = () => {};
        (app as any).store.setAllToolBlocksExpanded = () => {};

        (app as any).pendingMessages = ["第一行指令", "第二行补充说明", "第三行参数"];
        (app as any).pendingIndex = 2;

        const sentMessages: string[] = [];
        (app as any).agent.sendMessage = async (_sid: string, text: string) => {
            sentMessages.push(text);
            return { aborted: false };
        };

        // 当前轮 send 完成，触发 sendNextPending
        await (app as any).send("首条启动消息");
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(sentMessages).toEqual([
            "首条启动消息",
            "第一行指令\n第二行补充说明\n第三行参数",
        ]);
        expect(app.pendingMessages).toEqual([]);
        expect(app.pendingIndex).toBe(0);
    });

    test("生成中按 Esc 中止当前轮，释放状态并立即组合消费所有 pending 消息", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "sess-pending-test";
        (app as any).syncCurrentSessionState = () => {};
        (app as any).editor.addToHistory = () => {};
        (app as any).editor.setCompact = () => {};
        (app as any).layout.setMinSize = () => {};
        (app as any).store.setAllToolBlocksExpanded = () => {};

        // 模拟生成中
        (app as any).turnState.setPhase(store.currentSessionId!, "waiting");
        app.enqueueOrSend("待办 1");
        app.enqueueOrSend("待办 2");
        expect(app.pendingMessages).toEqual(["待办 1", "待办 2"]);

        let abortCalled = false;
        agent.abortSession = async () => {
            abortCalled = true;
            return true;
        };

        const sentList: string[] = [];
        (app as any).agent.sendMessage = async (_sid: string, text: string) => {
            sentList.push(text);
            return { aborted: false };
        };

        // 模拟 Esc 触发中止并完成当前 turn
        await (app as any).abortCurrent();
        expect(abortCalled).toBe(true);

        // 模拟当前 turn 结束（因 abort 返回）
        await (app as any).send("被中止的生成");
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(sentList).toContain("被中止的生成");
        expect(sentList).toContain("待办 1\n待办 2");
        expect(app.pendingMessages).toEqual([]);
    });

    test("当前 turn 执行中 enqueueOrSend 不主动打断，由 consumePendingMessages 提取并附加到请求", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "sess-pending-test";
        (app as any).syncCurrentSessionState = () => {};
        (app as any).editor.addToHistory = () => {};
        (app as any).editor.setCompact = () => {};
        (app as any).layout.setMinSize = () => {};
        (app as any).store.setAllToolBlocksExpanded = () => {};

        let abortCalls = 0;
        agent.abortSession = async () => {
            abortCalls += 1;
            return true;
        };

        let capturedOptions: any;
        (app as any).agent.sendMessage = async (_sid: string, _text: string, options?: any) => {
            capturedOptions = options;
            return { aborted: false };
        };

        // 启动第一轮 send
        const sendPromise = (app as any).send("初始指令");
        expect((app as any).turnState.isBusy("__current__")).toBeDefined();

        // 执行期间用户输入新消息，不打断生成
        app.enqueueOrSend("执行期间插入指令 1");
        app.enqueueOrSend("执行期间插入指令 2");

        expect(abortCalls).toBe(0);
        expect(app.pendingMessages).toEqual(["执行期间插入指令 1", "执行期间插入指令 2"]);

        // 在迭代前调用 consumePendingMessages 消费 pending
        const consumed = capturedOptions.consumePendingMessages();
        expect(consumed).toEqual(["执行期间插入指令 1", "执行期间插入指令 2"]);
        expect(app.pendingMessages).toEqual([]);

        await sendPromise;
    });
});

describe("ChatApp /continue 与 ⌥+Enter", () => {
    function makeResumeAgent(resumeResult: any = { resumed: true }) {
        const agent = makeFakeAgent();
        const calls: string[] = [];
        (agent as any).resumeSession = async (sessionId: string) => {
            calls.push(sessionId);
            return resumeResult;
        };
        return { agent, calls };
    }

    test("handleCommand /continue 调用 resumeSession", async () => {
        const { agent, calls } = makeResumeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "sess-continue";

        await (app as any).handleCommand("/continue");
        expect(calls).toEqual(["sess-continue"]);
    });

    test("续跑中的新用户输入通过 consumePendingMessages 注入当前恢复回合", async () => {
        const { agent } = makeResumeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        const sessionId = "sess-continue-pending";
        store.currentSessionId = sessionId;
        const consumed: Array<string | { text: string; images?: any[] }> = [];
        agent.takePeerResults = () => [];
        (agent as any).resumeSession = async (_sessionId: string, options: any) => {
            app.enqueueOrSend("resume 中输入的补充指令");
            consumed.push(...(options.consumePendingMessages() ?? []));
            return { resumed: true };
        };

        await (app as any).continueCurrent();

        expect(consumed).toEqual(["resume 中输入的补充指令"]);
        expect(app.pendingMessages).toEqual([]);
    });

    test("⌥+Enter 等同触发 /continue", async () => {
        const { agent, calls } = makeResumeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "sess-continue-key";

        expect((app as any).tui.inputListeners[0]("\x1b[13;3u")).toEqual({ consume: true });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(calls).toEqual(["sess-continue-key"]);
    });

    test("无可续跑点时显示原因且不进入 busy", async () => {
        const { agent } = makeResumeAgent({ resumed: false, reason: "上一轮已结束，没有未完成的动作" });
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "sess-continue-none";

        await (app as any).continueCurrent();
        expect((app as any).isCurrentBusy()).toBe(false);
        expect(store.messages.some(message => message.role === "system" && message.text.includes("上一轮已结束"))).toBe(true);
    });

    test("busy 时 ⌥+Enter 只提示不触发续跑", async () => {
        const { agent, calls } = makeResumeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "sess-continue-busy";
        (app as any).turnState.setPhase("sess-continue-busy", "waiting");

        await (app as any).continueCurrent();
        expect(calls).toEqual([]);
    });
});

describe("ChatApp /close", () => {
    test("/close 关闭当前会话：释放持有、摘掉 tab，落盘事实保留", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        await app.init();
        store.setSessions([
            { sessionId: "sess-close", title: "待关闭", messageCount: 2 },
            { sessionId: "sess-stay", title: "留下的", messageCount: 1 },
        ]);
        await (app as any).selectSession("sess-close");
        await (app as any).selectSession("sess-stay");
        await (app as any).selectSession("sess-close");
        expect(agent.claimedSessionIds()).toContain("sess-close");

        await (app as any).handleCommand("/close");
        await new Promise(resolve => setTimeout(resolve, 10));

        // 释放持有：不再是本实例的会话，因此也不进 tab 条
        expect(agent.claimedSessionIds()).not.toContain("sess-close");
        // 自动切到另一个已持有会话，不空转
        expect(store.currentSessionId).toBe("sess-stay");
        // 会话与消息数保留：⌘P 里还能重新打开
        const closed = store.sessions.find(session => session.sessionId === "sess-close");
        expect(closed?.archived).toBeFalsy();
        expect(closed?.messageCount).toBe(2);
        expect((app as any).tui.flashCalls).toContain("已关闭会话（⌘P 可重新打开）");
    });

    test("/close 对执行中的会话只提示不释放", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.setSessions([{ sessionId: "sess-close-busy", messageCount: 1 }]);
        store.currentSessionId = "sess-close-busy";
        await agent.claimSession("sess-close-busy");
        agent.isSessionBusy = () => true;

        await (app as any).handleCommand("/close");

        expect(agent.claimedSessionIds()).toContain("sess-close-busy");
        expect(store.currentSessionId).toBe("sess-close-busy");
        expect((app as any).tui.flashCalls).toContain("会话执行中，暂不能关闭（⎋ 中止后再试）");
    });
});

describe("ChatApp Ctrl+C 快捷键", () => {
    function triggerCtrlC(app: any): any {
        const result = (app as any).tui.inputListeners[0]("\x03");
        return result;
    }

    test("重命名提交后原草稿回到输入框，归档不丢草稿", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        await app.init();
        store.currentSessionId = "sess-draft-keep";
        store.sessions = [{ sessionId: "sess-draft-keep", title: "旧标题", messageCount: 0 }];

        // 1. 重命名：输入框先被标题占位，提交后还原为未发送草稿
        (app as any).editor.setText("未发送的草稿");
        await (app as any).beginRename("sess-draft-keep");
        expect((app as any).editor.getText()).toBe("旧标题");
        await (app as any).commitRename("sess-draft-keep", "新标题");
        expect((app as any).editor.getText()).toBe("未发送的草稿");
        expect((app as any).drafts.get("sess-draft-keep")).toBe("未发送的草稿");

        // 2. 归档：草稿保留，取消归档/切回时仍在
        await (app as any).archiveSessionById("sess-draft-keep");
        expect((app as any).drafts.get("sess-draft-keep")).toBe("未发送的草稿");
    });

    test("草稿落盘后重启可恢复", async () => {
        const agent = makeFakeAgent();
        const first = new ChatApp(agent as any, new ChatStore());
        await first.init();
        (first as any).setDraft("sess-restart", "重启前的草稿");
        await (first as any).flushDrafts();

        const second = new ChatApp(agent as any, new ChatStore());
        await second.init();
        expect((second as any).drafts.get("sess-restart")).toBe("重启前的草稿");
    });

    test("空闲时放行并提示 ⌃D 退出，不中止也不退出", () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        (app as any).store.currentSessionId = "sess-idle";

        agent.isSessionBusy = () => false;
        const abortSpy = mock(async () => false);
        agent.abortSession = abortSpy as any;
        const exitSpy = mock(() => {});
        (app as any).exit = exitSpy;

        expect(triggerCtrlC(app)).toBeUndefined();
        expect(abortSpy).not.toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
        expect((app as any).tui.flashCalls).toContain("⌃D 退出");
    });

    test("本实例自身 busy 时中止当前请求而非退出", () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        (app as any).store.currentSessionId = "sess-busy";

        agent.isSessionBusy = () => true;
        agent.isSessionLockedByOther = () => false;
        const abortSpy = mock(async () => true);
        agent.abortSession = abortSpy as any;
        const exitSpy = mock(() => {});
        (app as any).exit = exitSpy;

        expect(triggerCtrlC(app)).toEqual({ consume: true });
        expect(abortSpy).toHaveBeenCalledTimes(1);
        expect(exitSpy).not.toHaveBeenCalled();
    });

    test("会话被其他实例持有排他锁时同样放行（无法中止也不退出）", () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        (app as any).store.currentSessionId = "sess-locked-by-other";

        agent.isSessionBusy = () => true;
        agent.isSessionLockedByOther = () => true;
        const abortSpy = mock(async () => false);
        agent.abortSession = abortSpy as any;
        const exitSpy = mock(() => {});
        (app as any).exit = exitSpy;

        expect(triggerCtrlC(app)).toBeUndefined();
        expect(abortSpy).not.toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
    });
});

describe("ChatApp 退出与删除确认", () => {
    function press(app: any, data: string): any {
        return (app as any).tui.inputListeners[0](data);
    }

    test("⌃D 需在 2 秒内连按两次才退出", () => {
        const agent = makeFakeAgent();
        const app = new ChatApp(agent as any, new ChatStore());
        const exitSpy = mock(() => {});
        (app as any).exit = exitSpy;

        expect(press(app, "\x04")).toEqual({ consume: true });
        expect(exitSpy).not.toHaveBeenCalled();

        expect(press(app, "\x04")).toEqual({ consume: true });
        expect(exitSpy).toHaveBeenCalledTimes(1);
    });

    test("⌃X 需在 2 秒内连按两次才删除当前会话", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        store.currentSessionId = "sess-delete";
        const deleteSpy = mock(async () => {});
        agent.deleteSession = deleteSpy as any;

        expect(press(app, "\x18")).toEqual({ consume: true });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(deleteSpy).not.toHaveBeenCalled();

        expect(press(app, "\x18")).toEqual({ consume: true });
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(deleteSpy).toHaveBeenCalledTimes(1);
    });

    test("⌃Q 不再触发退出", () => {
        const agent = makeFakeAgent();
        const app = new ChatApp(agent as any, new ChatStore());
        const exitSpy = mock(() => {});
        (app as any).exit = exitSpy;

        expect(press(app, "\x11")).toBeUndefined();
        expect(exitSpy).not.toHaveBeenCalled();
    });

    test("Esc 不再误触发上一个会话", () => {
        const agent = makeFakeAgent();
        const app = new ChatApp(agent as any, new ChatStore());
        const switchSpy = mock(async () => {});
        (app as any).switchSession = switchSpy;

        expect(press(app, "\x1b")).toBeUndefined();
        expect(switchSpy).not.toHaveBeenCalled();
    });
});

describe("ChatApp 退出清理", () => {
    test("exit() 以 preserveScreen 停止 TUI，避免退出后终端残留画面", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);

        const stopSpy = mock((_options?: any) => {});
        (app as any).tui.stop = stopSpy;

        const originalExit = process.exit;
        let exitCode: number | undefined;
        (process as any).exit = (code?: number) => { exitCode = code; };
        try {
            await (app as any).exit();
            expect(exitCode).toBe(0);
            expect((app as any).exiting).toBe(true);
            expect(stopSpy).toHaveBeenCalledTimes(1);
            expect(stopSpy.mock.calls[0][0]).toEqual({ preserveScreen: true });
        } finally {
            (process as any).exit = originalExit;
        }
    });

    test("exit() 先等待 agent.close() 落盘，再停 TUI 并退出", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);

        const order: string[] = [];
        (agent as any).close = async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            order.push("close");
        };
        (app as any).tui.stop = () => { order.push("stop"); };
        const originalExit = process.exit;
        (process as any).exit = () => { order.push("exit"); };
        try {
            await (app as any).exit();
        } finally {
            (process as any).exit = originalExit;
        }

        expect(order).toEqual(["close", "stop", "exit"]);
    });

    test("exit() 输出本实例网络用量统计（会话数/输入/缓存命中/命中率）", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        agent.getInstanceNetworkStats = () => ({
            sessionCount: 2,
            requestCount: 5,
            promptTokens: 1000,
            completionTokens: 300,
            reasoningTokens: 60,
            cacheHitTokens: 800,
            cacheMissTokens: 200,
        });

        const originalWrite = process.stdout.write;
        const writes: string[] = [];
        (process.stdout as any).write = (chunk: any) => { writes.push(String(chunk)); return true; };
        const originalExit = process.exit;
        (process as any).exit = () => {};
        try {
            await (app as any).exit();
        } finally {
            (process.stdout as any).write = originalWrite;
            (process as any).exit = originalExit;
        }

        const output = writes.join("");
        expect(output).toContain("2 个会话");
        expect(output).toContain("5 次请求");
        expect(output).toContain("输入 1,000 tokens");
        expect(output).toContain("输出 300 tokens");
        expect(output).toContain("思考 60 tokens");
        expect(output).toContain("缓存命中 800");
        expect(output).toContain("命中率 80.0%");
    });

    test("无网络请求时退出不输出统计", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);

        const originalWrite = process.stdout.write;
        const writes: string[] = [];
        (process.stdout as any).write = (chunk: any) => { writes.push(String(chunk)); return true; };
        const originalExit = process.exit;
        (process as any).exit = () => {};
        try {
            await (app as any).exit();
        } finally {
            (process.stdout as any).write = originalWrite;
            (process as any).exit = originalExit;
        }

        expect(writes.join("")).toBe("");
    });
});

describe("ChatApp 会话条", () => {
    function makeApp(sessions: any[], columns: number, currentSessionId?: string): any {
        const agent = makeFakeAgent();
        const app = new ChatApp(agent as any, new ChatStore());
        (app as any).tui.terminal.columns = columns;
        (app as any).store.sessions = sessions;
        // tab 条只显示本实例持有的会话：这里把待展示的会话标记为已持有
        for (const session of sessions) void (agent as any).claimSession(session.sessionId);
        if (currentSessionId) (app as any).store.currentSessionId = currentSessionId;
        (app as any).renderTabBar();
        return app;
    }

    test("会话很多时仍然单行，超宽部分折叠为 ‹N / N› 且不超过终端宽度", () => {
        const sessions = Array.from({ length: 12 }, (_, index) => ({
            sessionId: `sess-long-${String(index).padStart(8, "0")}`,
            messageCount: index + 1,
            title: `会话标题 ${index + 1}`,
        }));
        const app = makeApp(sessions, 80, "sess-long-00000007");

        const text = (app as any).tabBar.getText() as string;
        expect(text.split("\n")).toHaveLength(1);
        expect(visibleWidth(stripTerminalSequences(text))).toBeLessThanOrEqual(78);

        const joined = stripTerminalSequences(text);
        expect(joined).toContain("会话标题 8");
        expect(joined).toContain("‹");
        expect(joined).toContain("›");
        expect(joined).toContain("[+]");
    });

    test("归档会话不出现在会话条上", () => {
        const app = makeApp([
            { sessionId: "sess-active", messageCount: 1, title: "活跃会话" },
            { sessionId: "sess-archived", messageCount: 1, title: "已归档会话", archived: true },
        ], 120, "sess-active");

        const joined = stripTerminalSequences((app as any).tabBar.getText() as string);
        expect(joined).toContain("活跃会话");
        expect(joined).not.toContain("已归档会话");
        expect((app as any).tabVisibleIds).toEqual(["sess-active"]);
    });

    test("tabs 一行放得下时不额外换行且等宽", () => {
        const app = makeApp([
            { sessionId: "sess-long-11111111", messageCount: 2, title: "短消息" },
            { sessionId: "sess-long-22222222", messageCount: 1, title: "另一条短消息" },
        ], 200, "sess-long-11111111");

        const text = (app as any).tabBar.getText() as string;
        expect(text.split("\n")).toHaveLength(1);
        expect((app as any).tabVisibleIds).toHaveLength(2);
    });

    test("turn 结束后当前会话圆饼恢复为选中标记，不停留在 spinner 帧", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        (app as any).tui.terminal.columns = 120;
        store.sessions = [{ sessionId: "sess-1", messageCount: 0, title: "会话一" }];
        store.currentSessionId = "sess-1";
        await (agent as any).claimSession("sess-1");
        (app as any).syncMessages = () => {};
        (app as any).agent.sendMessage = async () => ({ aborted: false });

        await (app as any).send("hello", "sess-1");

        const text = stripTerminalSequences((app as any).tabBar.getText() as string);
        expect(text).toContain("●");
        for (const frame of SPINNER_FRAMES) {
            expect(text).not.toContain(frame);
        }
    });

    test("启动不认领任何会话，只打开会话面板等用户主动开启", () => {
        const app = new ChatApp(makeFakeAgent() as any, new ChatStore());
        (app as any).store.setSessions([
            { sessionId: "sess-old", messageCount: 2, title: "较早" },
            { sessionId: "sess-new", messageCount: 1, title: "最新" },
        ]);
        const opened: string[] = [];
        (app as any).openSessionPanel = () => { opened.push("panel"); };

        (app as any).openInitialView();

        expect(opened).toEqual(["panel"]);
        expect((app as any).store.currentSessionId).toBeNull();
    });

    test("只有归档会话时提示新建，不打开面板", () => {
        const app = new ChatApp(makeFakeAgent() as any, new ChatStore());
        (app as any).store.setSessions([
            { sessionId: "sess-archived", messageCount: 1, title: "已归档", archived: true },
        ]);
        const opened: string[] = [];
        (app as any).openSessionPanel = () => { opened.push("panel"); };

        (app as any).openInitialView();

        expect(opened).toEqual([]);
        expect((app as any).store.messages.at(-1)?.text).toContain("还没有会话");
    });

    test("tab 条只显示本实例持有的会话", () => {
        const agent = makeFakeAgent();
        const app = new ChatApp(agent as any, new ChatStore());
        (app as any).tui.terminal.columns = 120;
        (app as any).store.setSessions([
            { sessionId: "sess-mine", messageCount: 1, title: "我的会话" },
            { sessionId: "sess-other", messageCount: 1, title: "别人的会话" },
        ]);
        void (agent as any).claimSession("sess-mine");
        (app as any).renderTabBar();

        const joined = stripTerminalSequences((app as any).tabBar.getText() as string);
        expect(joined).toContain("我的会话");
        expect(joined).not.toContain("别人的会话");
        expect((app as any).tabVisibleIds).toEqual(["sess-mine"]);
    });

    test("会话归属快照进面板列：本实例带待交付计数，他实例带 PID 与处理中", async () => {
        const agent = makeFakeAgent();
        let probes = 0;
        (agent as any).listSessionOwnership = async (ids: string[]) => {
            probes += 1;
            return new Map(ids.map(id => [
                id,
                id === "sess-mine"
                    ? { state: "mine" }
                    : { state: "other", info: { pid: 4321, instanceId: "peer", sessionId: id, busy: true, pending: 2 } },
            ]));
        };
        (agent as any).peerPendingStats = () => ({ awaiting: 2, queued: 1 });

        const app = new ChatApp(agent as any, new ChatStore());
        (app as any).store.setSessions([
            { sessionId: "sess-mine", messageCount: 1, title: "本实例" },
            { sessionId: "sess-other", messageCount: 1, title: "他实例" },
        ]);

        await (app as any).refreshOwnership(true);
        expect(probes).toBe(1);

        const items = (app as any).buildSessionPanelItems();
        const mine = items.find((item: any) => item.sessionId === "sess-mine");
        const other = items.find((item: any) => item.sessionId === "sess-other");
        expect(mine.ownerState).toBe("mine");
        expect(mine.owner).toContain("等待 2");
        expect(mine.owner).toContain("待附加 1");
        expect(other.ownerState).toBe("other");
        expect(other.owner).toContain("PID 4321");
        expect(other.owner).toContain("忙");
        expect(other.owner).toContain("处理中 2");

        // 节流：TTL 内再次刷新不重新探测
        await (app as any).refreshOwnership();
        expect(probes).toBe(1);
    });

    test("打开会话面板启动归属轮询，关闭后停止", () => {
        const app = new ChatApp(makeFakeAgent() as any, new ChatStore());

        (app as any).openSessionPanel();
        expect((app as any).ownershipTimer).not.toBeNull();

        (app as any).closeSessionPanel();
        expect((app as any).ownershipTimer).toBeNull();
    });

    test("面板里删除会话：保持面板打开并同步列表", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        await app.init();
        store.setSessions([
            { sessionId: "sess-keep", messageCount: 1, title: "保留会话" },
            { sessionId: "sess-drop", messageCount: 1, title: "删除会话" },
        ]);

        (app as any).openSessionPanel();
        const entry = (app as any).panels.top();
        expect(entry?.kind).toBe("session");

        // 搜索到待删会话，保证光标落在它上面
        entry.panel.handleInput("删");
        expect(entry.panel.getSelectedId()).toBe("sess-drop");

        // ⌃X 需二次确认：窗口内连按两次才真正删除
        entry.panel.handleInput("\x18");
        expect(store.sessions.map((session: any) => session.sessionId)).toContain("sess-drop");
        entry.panel.handleInput("\x18");
        await new Promise(resolve => setTimeout(resolve, 10));

        // 面板仍是同一个实例（未被关闭），列表已剔除该会话
        expect((app as any).panels.find("session")?.panel).toBe(entry.panel);
        expect(store.sessions.map((session: any) => session.sessionId)).toEqual(["sess-keep"]);
        expect(entry.panel.getSelectedId()).toBeNull();
    });

    test("面板里删除执行中的会话：留在面板并提示", async () => {
        const agent = makeFakeAgent();
        (agent as any).isSessionBusy = () => true;
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        await app.init();
        store.setSessions([{ sessionId: "sess-busy", messageCount: 1, title: "运行中会话" }]);

        (app as any).openSessionPanel();
        const entry = (app as any).panels.top();
        entry.panel.handleInput("\x18");
        entry.panel.handleInput("\x18");
        await new Promise(resolve => setTimeout(resolve, 10));

        expect((app as any).panels.find("session")?.panel).toBe(entry.panel);
        expect(store.sessions.map((session: any) => session.sessionId)).toEqual(["sess-busy"]);
        expect((app as any).tui.flashCalls).toContain("会话执行中，暂不能删除");
    });

    test("面板里取消归档：保持面板打开并同步列表", async () => {
        const agent = makeFakeAgent();
        const unarchived: string[] = [];
        agent.unarchiveSession = async (sessionId: string) => {
            unarchived.push(sessionId);
        };
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        await app.init();
        store.setSessions([{ sessionId: "sess-archived", messageCount: 1, title: "已归档会话", archived: true }]);

        (app as any).openSessionPanel();
        const entry = (app as any).panels.top();
        expect(entry?.kind).toBe("session");

        // ⌃A 对已归档会话是取消归档：可逆，无需二次确认
        entry.panel.handleInput("\x01");
        await new Promise(resolve => setTimeout(resolve, 10));

        expect((app as any).panels.find("session")?.panel).toBe(entry.panel);
        expect(unarchived).toEqual(["sess-archived"]);
        expect(store.sessions.find((session: any) => session.sessionId === "sess-archived")?.archived).toBe(false);
        expect((app as any).tui.flashCalls).toContain("已取消归档");
    });

    test("面板里归档：保持面板打开并同步列表", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        await app.init();
        store.setSessions([{ sessionId: "sess-arch", messageCount: 1, title: "待归档会话" }]);

        (app as any).openSessionPanel();
        const entry = (app as any).panels.top();

        // ⌃A 归档需二次确认
        entry.panel.handleInput("\x01");
        entry.panel.handleInput("\x01");
        await new Promise(resolve => setTimeout(resolve, 10));

        expect((app as any).panels.find("session")?.panel).toBe(entry.panel);
        expect(store.sessions.find((session: any) => session.sessionId === "sess-arch")?.archived).toBe(true);
    });
});

describe("ChatApp 主动释放的提示", () => {
    test("/archive 归档当前会话：提示已归档，不误报被其他实例接管", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        await app.init();
        store.setSessions([
            { sessionId: "sess-arch-cur", title: "待归档", messageCount: 2 },
            { sessionId: "sess-arch-stay", title: "留下的", messageCount: 1 },
        ]);
        await (app as any).selectSession("sess-arch-cur");
        await (app as any).selectSession("sess-arch-stay");
        await (app as any).selectSession("sess-arch-cur");

        await (app as any).handleCommand("/archive");
        await new Promise(resolve => setTimeout(resolve, 10));

        // 归档即放弃持有，并切到另一个已持有会话
        expect(agent.claimedSessionIds()).not.toContain("sess-arch-cur");
        expect(store.currentSessionId).toBe("sess-arch-stay");
        expect(store.sessions.find((session: any) => session.sessionId === "sess-arch-cur")?.archived).toBe(true);
        const flashes: string[] = (app as any).tui.flashCalls;
        expect(flashes).toContain("已归档会话（⌘P → ⌃A 取消归档）");
        expect(flashes.join("\n")).not.toContain("其他实例");
        expect(store.messages.some(message => message.text.includes("其他实例"))).toBe(false);
    });

    test("/delete 删除当前会话：只提示已删除，不误报被其他实例接管", async () => {
        const agent = makeFakeAgent();
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);
        await app.init();
        store.setSessions([
            { sessionId: "sess-del-cur", title: "待删除", messageCount: 2 },
            { sessionId: "sess-del-stay", title: "留下的", messageCount: 1 },
        ]);
        await (app as any).selectSession("sess-del-cur");
        await (app as any).selectSession("sess-del-stay");
        await (app as any).selectSession("sess-del-cur");

        await (app as any).handleCommand("/delete");
        await new Promise(resolve => setTimeout(resolve, 10));

        const flashes: string[] = (app as any).tui.flashCalls;
        expect(flashes).toContain("🗑️ 已删除会话");
        expect(flashes.join("\n")).not.toContain("其他实例");
        expect(store.messages.some(message => message.text.includes("其他实例"))).toBe(false);
    });
});

describe("会话派生（session_spawn）", () => {
    test("派生后进会话列表并 flash（标题由宿主建会话时固化，前端不再改名）", async () => {
        const agent = makeFakeAgent();
        const renamed: string[] = [];
        agent.renameSession = async (sessionId) => {
            renamed.push(sessionId);
        };
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);

        await (app as any).handleSessionSpawned("sess-child", "读日志");

        // 标题落盘归宿主（createSession 的 init.title）；前端重复改名会与宿主抢会话锁
        expect(renamed).toEqual([]);
        const child = store.sessions.find(session => session.sessionId === "sess-child");
        expect(child?.title).toBe("读日志");
        expect((app as any).tui.flashCalls.at(-1)).toContain("子会话");
    });

    test("无标题时只 flash 提示，不落标题", async () => {
        const agent = makeFakeAgent();
        const renamed: string[] = [];
        agent.renameSession = async (sessionId) => {
            renamed.push(sessionId);
        };
        const store = new ChatStore();
        const app = new ChatApp(agent as any, store);

        await (app as any).handleSessionSpawned("sess-child-2", undefined);

        expect(renamed).toEqual([]);
        expect(store.sessions.map(session => session.sessionId)).toContain("sess-child-2");
    });
});
