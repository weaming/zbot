/**
 * 切换会话时的空会话清理：
 * 启动即新建的空会话在用户打开历史会话后不该继续占着 tab 条；
 * 有未发送草稿、正在执行、或宿主判空未命中（有内容/已被接管）时一律保留。
 *
 * 独立文件：mock.module 需要独占进程。
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

const EMPTY = "sess-switch-empty";
const HISTORY = "sess-switch-history";

let tmpDir: string;
let originalStateDir: string | undefined;
let originalTuiCwd: string | undefined;
let restoreModelEnv: () => void;

interface FakeOptions {
    /** 宿主判空结果；false 表示会话有内容（删除不该发生）。 */
    empty?: boolean;
    /** 会话正忙：前端前置检查就该拦下，连判空都不问。 */
    busy?: boolean;
    /** 宿主判空/删除直接抛错：切换必须照常完成。 */
    failDelete?: boolean;
}

function makeAgent(options: FakeOptions = {}) {
    const claimed = new Set<string>();
    const state = {
        options: { empty: true, busy: false, failDelete: false, ...options },
        deleted: [] as string[],
        deleteIfEmptyCalls: [] as string[],
        agent: {} as any,
    };
    state.agent = {
        claimedSessionIds: () => [...claimed],
        isSessionClaimed: (sessionId: string) => claimed.has(sessionId),
        claimSession: async (sessionId: string) => {
            claimed.add(sessionId);
            return { ok: true as const };
        },
        releaseSession: (sessionId: string, options?: { cause?: string }) => {
            claimed.delete(sessionId);
            state.agent.onSessionReleased?.(sessionId, options?.cause ?? "peer");
        },
        isSessionBusy: () => state.options.busy,
        isSessionLockedByOther: () => false,
        listSessions: async () => [],
        readSessionEvents: async () => [],
        loadInputHistory: () => [],
        appendInputHistory: async () => {},
        getSessionCwd: async () => tmpDir,
        getSessionModelSelection: async () => undefined,
        setSessionModelSelection: async () => {},
        probeSession: async () => ({ state: "mine" as const }),
        listSessionOwnership: async () => new Map(),
        peerPendingStats: () => ({ awaiting: 0, queued: 0 }),
        takePeerResults: () => [],
        detachPeerWaits: () => 0,
        deleteSessionIfEmpty: async (sessionId: string) => {
            state.deleteIfEmptyCalls.push(sessionId);
            if (state.options.failDelete) throw new Error("会话锁被占用");
            if (!state.options.empty) return false;
            state.deleted.push(sessionId);
            return true;
        },
        deleteSession: async () => {},
        close: () => {},
    };
    return state;
}

async function makeApp(options: FakeOptions = {}) {
    const state = makeAgent(options);
    const store = new ChatStore();
    const app: any = new ChatApp(state.agent, store);
    await app.init(undefined, { skipInitialView: true, autoNewSession: false });
    store.setSessions([
        { sessionId: EMPTY, title: "空会话", messageCount: 0 },
        { sessionId: HISTORY, title: "历史", messageCount: 4 },
    ]);
    return { app, store, state };
}

/** 会话列表顺序由最近活跃时间决定，只关心成员时排序后再比对。 */
function sessionIds(store: any): string[] {
    return store.sessions.map((session: any) => session.sessionId).sort();
}

function flashCalls(app: any): string[] {
    return (app.tui as any).flashCalls;
}

beforeEach(() => {
    restoreModelEnv = isolateModelEnv();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-tui-empty-"));
    originalStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;
    originalTuiCwd = process.env.TUI_CWD;
    process.env.TUI_CWD = tmpDir;
});

afterEach(async () => {
    // 让「记录当前会话指针」这类 fire-and-forget 写盘先落地，避免删目录后报 ENOENT
    await new Promise(resolve => setTimeout(resolve, 10));
    restoreModelEnv();
    if (originalStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = originalStateDir;
    if (originalTuiCwd === undefined) delete process.env.TUI_CWD;
    else process.env.TUI_CWD = originalTuiCwd;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
    mock.restore();
});

describe("切换会话时清理空会话", () => {
    test("打开历史会话后删掉被替下的空会话", async () => {
        const { app, store, state } = await makeApp();
        await app.selectSession(EMPTY);
        expect(store.currentSessionId).toBe(EMPTY);

        await app.selectSession(HISTORY);

        expect(state.deleteIfEmptyCalls).toEqual([EMPTY]);
        expect(state.deleted).toEqual([EMPTY]);
        expect(sessionIds(store)).toEqual([HISTORY]);
        expect(store.currentSessionId).toBe(HISTORY);
        expect(flashCalls(app).at(-1)).toContain("空会话已自动删除");
    });

    test("空会话里有未发送的草稿时保留", async () => {
        const { app, store, state } = await makeApp();
        await app.selectSession(EMPTY);
        app.editor.setText("还没发出去的想法");

        await app.selectSession(HISTORY);

        expect(state.deleteIfEmptyCalls).toEqual([]);
        expect(sessionIds(store)).toEqual([EMPTY, HISTORY].sort());
    });

    test("宿主判空未命中（会话有内容）时保留", async () => {
        const { app, store, state } = await makeApp({ empty: false });
        await app.selectSession(EMPTY);

        await app.selectSession(HISTORY);

        expect(state.deleteIfEmptyCalls).toEqual([EMPTY]);
        expect(state.deleted).toEqual([]);
        expect(sessionIds(store)).toEqual([EMPTY, HISTORY].sort());
    });

    test("空会话正在执行时保留：前端前置检查拦下，不弹「暂不能删除」", async () => {
        const { app, store, state } = await makeApp({ busy: true });
        await app.selectSession(EMPTY);

        await app.selectSession(HISTORY);

        expect(state.deleteIfEmptyCalls).toEqual([]);
        expect(sessionIds(store)).toEqual([EMPTY, HISTORY].sort());
        expect(store.currentSessionId).toBe(HISTORY);
        // 前置检查生效时不走 deleteSessionById 的忙时提示（否则用户切个会话就被弹一句）
        expect(flashCalls(app).some(text => text.includes("暂不能删除"))).toBe(false);
    });

    test("删除失败不影响切换：只提示，会话留在列表里", async () => {
        const { app, store, state } = await makeApp({ failDelete: true });
        await app.selectSession(EMPTY);

        await app.selectSession(HISTORY);

        expect(state.deleteIfEmptyCalls).toEqual([EMPTY]);
        expect(state.deleted).toEqual([]);
        expect(store.currentSessionId).toBe(HISTORY);
        expect(sessionIds(store)).toEqual([EMPTY, HISTORY].sort());
        expect(store.messages.some((message: any) => message.text.includes("删除空会话失败"))).toBe(true);
    });
});
