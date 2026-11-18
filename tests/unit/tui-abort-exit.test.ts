/**
 * 中断与退出的协作：Esc/⌃C 中止回合后立刻退出，turn 不能丢。
 *
 * 这里验证的是跨模块契约，而不是单个函数：
 *   abortCurrent() 只发信号就返回 —— 落盘发生在其后的 catch/finally 里。
 *   因此"中断后立即退出"的安全性，完全依赖 exit() 等待 agent.close()，
 *   而 agent.close() 必须（a）先 abort 再等 inflight、（b）有上限不会挂死。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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

const SESSION = "sess-abort-exit";
let stateDir: string;
let previousStateDir: string | undefined;
let restoreModelEnv: () => void;

beforeEach(() => {
    restoreModelEnv = isolateModelEnv();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-abort-exit-"));
    previousStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = stateDir;
});

afterEach(() => {
    restoreModelEnv();
    if (previousStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = previousStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
});

function makeAgent(overrides: Record<string, unknown> = {}) {
    const agent: any = {
        claimedSessionIds: () => [SESSION],
        isSessionBusy: () => false,
        isSessionClaimed: () => true,
        isSessionLockedByOther: () => false,
        abortSession: async () => true,
        close: async () => {},
        listSessions: async () => [],
        readSessionEvents: async () => [],
        getSessionModelSelection: async () => undefined,
        setSessionModelSelection: async () => {},
        detachPeerWaits: () => 0,
        takePeerResults: () => [],
        peerPendingStats: () => ({ awaiting: 0, queued: 0 }),
        loadInputHistory: () => [],
        appendInputHistory: async () => {},
        getSessionCwd: async () => process.cwd(),
        getInstanceNetworkStats: () => ({
            sessionCount: 0,
            requestCount: 0,
            promptTokens: 0,
            completionTokens: 0,
            reasoningTokens: 0,
            cacheHitTokens: 0,
            cacheMissTokens: 0,
        }),
        ...overrides,
    };
    return agent;
}

function makeApp(agent = makeAgent()) {
    const store = new ChatStore();
    store.setCurrentSession(SESSION);
    const app: any = new ChatApp(agent, store);
    return { app, store, agent };
}

/** 拦截 process.exit，避免测试真的退出进程。 */
async function runExit(app: any): Promise<{ order: string[] }> {
    const order: string[] = [];
    app.discardTerminalInput = async () => { order.push("drain"); };
    app.tui.stop = () => { order.push("stop"); };
    const originalExit = process.exit;
    (process as any).exit = () => { order.push("exit"); };
    try {
        await app.exit(0);
    } finally {
        (process as any).exit = originalExit;
    }
    return { order };
}

describe("Esc/⌃C 中断", () => {
    test("abortCurrent 向 agent 发出该会话的中止请求", async () => {
        const aborted: string[] = [];
        const { app } = makeApp(makeAgent({
            isSessionBusy: () => true,
            abortSession: async (sessionId: string) => {
                aborted.push(sessionId);
                return true;
            },
        }));

        await app.abortCurrent();
        expect(aborted).toEqual([SESSION]);
    });

    test("无会话时不调用 agent", async () => {
        const aborted: string[] = [];
        const store = new ChatStore();
        store.setCurrentSession(null);
        const app: any = new ChatApp(makeAgent({ abortSession: async (s: string) => { aborted.push(s); return true; } }), store);

        await app.abortCurrent();
        expect(aborted).toEqual([]);
    });

    test("中断只发信号就返回，不等待落盘（落盘在 send 的收尾里）", async () => {
        let resolveAbort: (() => void) | undefined;
        const { app } = makeApp(makeAgent({
            isSessionBusy: () => true,
            abortSession: () => new Promise<boolean>(resolve => {
                resolveAbort = () => resolve(true);
            }),
        }));

        // 未 resolve 的情况下也必须能返回，否则 Esc 会把界面卡住
        const pending = app.abortCurrent();
        expect(resolveAbort).toBeDefined();
        resolveAbort!();
        await pending;
    });
});

describe("agent.close 的落盘等待有上限", () => {
    // 直接验证 LocalSessionHost 的超时保护：turn 永不结束时，close 不能挂死退出。
    // 用固定 3s 常量不现实，这里验证的是"race 结构存在且生效"，用极短的可控 promise。

    test("inflight turn 永不结束时，close 仍在超时后返回", async () => {
        const { LocalSessionHost } = await import("../../src/host/session-host.js");
        const agent: any = new LocalSessionHost(Promise.resolve());
        // 塞一个永不 resolve 的 turn
        agent.inflightTurns.add(new Promise(() => {}));
        agent.activeSessions.set(SESSION, { abortController: new AbortController() });

        const started = Date.now();
        const closePromise = agent.close();

        // 必须能返回；这里不等满 3s，用 race 检查它确实在等而不是立刻返回
        const quick = await Promise.race([
            closePromise.then(() => "closed"),
            new Promise(resolve => setTimeout(() => resolve("still-waiting"), 50)),
        ]);

        expect(quick).toBe("still-waiting");

        // 再验证另一半：超时窗口过后必须真的返回，而不是永远挂着
        const settled = await Promise.race([
            closePromise.then(() => "closed"),
            new Promise(resolve => setTimeout(() => resolve("timeout"), 5_000)),
        ]);
        expect(settled).toBe("closed");

        // 收尾：清掉挂起的 turn，避免测试进程残留
        agent.inflightTurns.clear();
    }, 10_000);
});

describe("中断后立即退出", () => {
    test("exit 先等 agent.close 落盘，再停 TUI、最后退出", async () => {
        const { app } = makeApp();
        const order: string[] = [];
        app.agent.close = async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            order.push("close");
        };

        const result = await runExit(app);
        // 先复位终端的 stop()（顺带弹出 kitty 协议栈），再排空队列，最后退出
        expect([...order, ...result.order]).toEqual(["close", "stop", "drain", "exit"]);
    });

    test("close 抛错也要继续退出，不能挂在异常上", async () => {
        const { app } = makeApp();
        app.agent.close = async () => {
            throw new Error("落盘失败");
        };

        const originalError = console.error;
        console.error = () => {};
        try {
            const { order } = await runExit(app);
            expect(order).toEqual(["stop", "drain", "exit"]);
        } finally {
            console.error = originalError;
        }
    });

    test("中断后退出：agent 仍然收到 close，turn 有机会落盘", async () => {
        let closed = false;
        const { app } = makeApp(makeAgent({
            isSessionBusy: () => true,
            close: async () => {
                closed = true;
            },
        }));

        await app.abortCurrent();
        await runExit(app);

        expect(closed).toBe(true);
    });

    test("重复调用 exit 只执行一次收尾", async () => {
        const { app } = makeApp();
        let closeCount = 0;
        app.agent.close = async () => {
            closeCount += 1;
        };

        const { order } = await runExit(app);
        // 第二次进入应被 exiting 守卫挡住
        await app.exit(0).catch(() => {});

        expect(closeCount).toBe(1);
        expect(order).toEqual(["stop", "drain", "exit"]);
    });
});
