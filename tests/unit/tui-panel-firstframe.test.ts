/**
 * 浮层首帧滚轮命中判定：
 * 面板打开后、首次渲染前 `PanelOverlay.height()` 仍为 0，此时矩形未知。
 * 未就绪态一律不把滚轮交给面板（等价于吞掉），且不得把该态误读为「面板外」。
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

const { ChatApp } = await import("../../src/tui/app.js");
const { ChatStore } = await import("../../src/tui/store.js");

/** SGR 滚轮序列坐标是 1-based，parseWheelEvent 会减 1。 */
// 首帧退化矩形为 {row:11,col:4,width:72,height:1}（只覆盖 row=11）：
// - (39,11) 落在退化矩形内 → 当前实现误判为「面板内」而交给未渲染的面板
// - (39,15) 在退化矩形外、真实面板内 → 当前实现误判为「面板外」
const WHEEL_IN_DEGRADED_ROW = "\x1b[<65;40;12M"; // -> (x=39, y=11)
const WHEEL_IN_PANEL = "\x1b[<65;40;16M"; // -> (x=39, y=15)
const WHEEL_OUTSIDE_PANEL = "\x1b[<65;40;2M"; // -> (x=39, y=1)

let tmpDir: string;
let originalStateDir: string | undefined;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-tui-firstframe-"));
    originalStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;
});

afterEach(() => {
    if (originalStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = originalStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
    mock.restore();
});

function makeFakeAgent() {
    return {
        claimedSessionIds: () => [],
        listSessions: async () => [],
        readSessionEvents: async () => [],
        createSession: async () => ({ sessionId: "sess-firstframe" }),
        appendInputHistory: async () => {},
        loadInputHistory: () => [],
        isSessionBusy: () => false,
        isSessionLockedByOther: () => false,
        getSystemPrompt: async () => "",
        compactSession: async () => {},
        closeSession: async () => {},
        unarchiveSession: async () => {},
        abortSession: async () => false,
        getInstanceNetworkStats: () => ({ sessionCount: 0, requestCount: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }),
        clearSession: async () => {},
        deleteSession: async () => {},
        renameSession: async () => {},
        getSessionCwd: async () => tmpDir,
        resumeSession: async () => ({ resumed: true }),
        close: () => {},
    };
}

async function makeApp() {
    const app = new ChatApp(makeFakeAgent() as any, new ChatStore());
    await app.init();
    return app;
}

/** 注入「已渲染」状态：面板 16 行（80x24 下矩形为 row 4-19 / col 4-75）。 */
function injectRenderedPanel(app: any, height = 16) {
    // 面板栈是唯一数据源：压一个"已渲染 height 行"的假浮层等价于面板已就绪
    app.panels.push({
        kind: "session",
        panel: { handleInput: () => {}, updateItems: () => {}, dispose: () => {} },
        meta: {
            handle: { hide() {}, focus() {}, isFocused: () => true },
            height: () => height,
        },
    });
}

describe("浮层首帧滚轮命中判定", () => {
    test("未就绪：面板内滚轮被吞掉，不交给面板（退化行内）", async () => {
        const app = await makeApp();
        (app as any).openSessionPanel();

        const overlay = (app as any).panels.top().meta;
        expect(overlay.height()).toBe(0);
        expect((app as any).isWheelOutsidePanel(WHEEL_IN_DEGRADED_ROW)).toBe(true);
    });

    test("未就绪：面板内滚轮被吞掉，不交给面板（退化行外）", async () => {
        const app = await makeApp();
        (app as any).openSessionPanel();

        expect((app as any).isWheelOutsidePanel(WHEEL_IN_PANEL)).toBe(true);
    });

    test("未就绪：非滚轮输入不参与命中判定，仍交给面板", async () => {
        const app = await makeApp();
        (app as any).openSessionPanel();

        expect((app as any).isWheelOutsidePanel("a")).toBe(false);
        expect((app as any).isWheelOutsidePanel("\x1b")).toBe(false);
    });

    test("已就绪：面板内滚轮交给面板", async () => {
        const app = await makeApp();
        injectRenderedPanel(app);

        expect((app as any).isWheelOutsidePanel(WHEEL_IN_DEGRADED_ROW)).toBe(false);
        expect((app as any).isWheelOutsidePanel(WHEEL_IN_PANEL)).toBe(false);
    });

    test("已就绪：面板外滚轮不交给面板", async () => {
        const app = await makeApp();
        injectRenderedPanel(app);

        expect((app as any).isWheelOutsidePanel(WHEEL_OUTSIDE_PANEL)).toBe(true);
    });

    test("无面板时滚轮不参与判定", async () => {
        const app = await makeApp();

        expect((app as any).isWheelOutsidePanel(WHEEL_IN_PANEL)).toBe(false);
    });
});
