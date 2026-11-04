/**
 * 特征测试：浮面板的路由与互斥。
 *
 * Phase 3 会把"互斥至多一个 + 每种面板一套 open/close"改造成 PanelStack。
 * 这里先锁住用户可感知的行为，改造后必须仍然成立：
 *   1. 同一时刻至多一个面板处于激活态
 *   2. 面板打开时输入被它独占，不再落到输入框
 *   3. 关闭面板后焦点回到输入框
 *   4. 面板打开期间本地会话归属仍会被轮询刷新
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { tuiStub } from "./tui-stub.js";
import { isolateModelEnv } from "./test-env.js";

mock.module("@earendil-works/pi-tui", () => tuiStub);

const realChatRuntime = await import("../../src/services/chat-runtime.js");
mock.module("../../src/services/chat-runtime.js", () => ({
    ...realChatRuntime,
    runChatQuery: async () => ({ content: "stub", toolCalls: 0, messages: [] }),
}));

const { ChatApp } = await import("../../src/tui/app.js");
const { ChatStore } = await import("../../src/tui/store.js");

let tmpDir: string;
let originalStateDir: string | undefined;
let restoreModelEnv: () => void;

beforeEach(() => {
    restoreModelEnv = isolateModelEnv();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-tui-panels-"));
    originalStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;
});

afterEach(() => {
    restoreModelEnv();
    if (originalStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = originalStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
    mock.restore();
});

function makeApp() {
    const agent = {
        listSessions: async () => [],
        readSessionEvents: async () => [],
        createSession: async () => ({ sessionId: "sess-panel" }),
        getSessionCwd: async () => tmpDir,
        getSessionModelSelection: async () => undefined,
        setSessionModelSelection: async () => {},
        detachPeerWaits: () => 0,
        takePeerResults: () => [],
        peerPendingStats: () => ({ awaiting: 0, queued: 0 }),
        isSessionBusy: () => false,
        isSessionLockedByOther: () => false,
        claimSession: async () => ({ ok: true as const }),
        releaseSession: () => {},
        isSessionClaimed: () => true,
        claimedSessionIds: () => ["sess-panel"],
        probeSession: async () => ({ state: "mine" as const }),
        listSessionOwnership: async () => new Map(),
        loadInputHistory: () => [],
        appendInputHistory: async () => {},
        getSystemPrompt: async () => "",
        getInstanceNetworkStats: () => ({}),
        appendPeerMessage: async () => {},
    };
    const store = new ChatStore();
    store.setSessions([{ sessionId: "sess-panel", messageCount: 0, title: "面板会话" }]);
    store.setCurrentSession("sess-panel");
    const app = new ChatApp(agent as any, store);
    return { app: app as any, store };
}

/** 当前激活的面板 kind；无面板时为 null。 */
function activeKind(app: any): string | null {
    return app.panels.top()?.kind ?? null;
}

describe("特征：面板互斥", () => {
    test("未打开任何面板时没有激活项", () => {
        const { app } = makeApp();
        expect(activeKind(app)).toBeNull();
    });

    test("打开会话面板后激活项为 session", () => {
        const { app } = makeApp();
        app.openSessionPanel();
        expect(activeKind(app)).toBe("session");
    });

    test("打开快捷键面板后激活项为 shortcut", () => {
        const { app } = makeApp();
        app.openShortcutPanel();
        expect(activeKind(app)).toBe("shortcut");
    });

    test("关闭面板后回到无面板状态", () => {
        const { app } = makeApp();
        app.openSessionPanel();
        app.closeActivePanel();
        expect(activeKind(app)).toBeNull();
    });

    test("连续切换面板时同一时刻只有一个激活项", () => {
        const { app } = makeApp();
        app.openSessionPanel();
        const first = activeKind(app);

        // 再开另一个面板：先关旧的，结果仍是单值
        app.closeActivePanel();
        app.openShortcutPanel();
        const second = activeKind(app);

        expect(first).toBe("session");
        expect(second).toBe("shortcut");
        expect(activeKind(app)).toBe("shortcut");
    });
});

describe("特征：输入独占", () => {
    test("无面板时输入不被面板消费", () => {
        const { app } = makeApp();
        expect(app.handlePanelInput("x")).toBe(false);
    });

    test("面板打开时输入被面板消费", () => {
        const { app } = makeApp();
        app.openSessionPanel();
        expect(app.handlePanelInput("x")).toBe(true);
    });

    test("关闭面板后输入重新回到输入框", () => {
        const { app } = makeApp();
        app.openSessionPanel();
        app.closeActivePanel();
        expect(app.handlePanelInput("x")).toBe(false);
    });
});

describe("特征：归属轮询生命周期", () => {
    test("打开会话面板启动归属轮询，关闭后停止", () => {
        const { app } = makeApp();
        app.openSessionPanel();
        expect(app.ownership.isPolling()).toBe(true);

        app.closeActivePanel();
        expect(app.ownership.isPolling()).toBe(false);
    });

    test("非会话面板不启动归属轮询", () => {
        const { app } = makeApp();
        app.openShortcutPanel();
        expect(app.ownership.isPolling()).toBe(false);
    });
});
