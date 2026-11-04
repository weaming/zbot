import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import type { TurnOutcome } from "../services/run-turn.js";
import { createEmptySession } from "../events/session-replay.js";
import type { TurnHost } from "./turn.js";
import type { ActiveSession } from "./session-host-types.js";

/**
 * turn 执行器单测：只替换 runTurnCore（唯一的外部 LLM 骨架），
 * 宿主能力用假实现注入，因此不需要真事件日志、真重放或真网络。
 */
type RunTurnImpl = (spec: any, hooks: any) => Promise<TurnOutcome>;

// mock 注册前先取真实实现：mock.module 是进程级的，同进程后续测试文件会继续拿到它。
// 因此每个用例结束后必须把注入点还原成真实骨架，否则后面的测试文件会拿到本文件的假实现。
const realRunTurn = await import("../services/run-turn.js");

const delegateRealRunTurn: RunTurnImpl = (spec, hooks) => realRunTurn.runTurnCore(spec, hooks);

let runTurnCoreImpl: RunTurnImpl = async () => {
    throw new Error("runTurnCore 未在测试中设置");
};

mock.module("../services/run-turn.js", () => ({
    ...realRunTurn,
    runTurnCore: (spec: any, hooks: any) => runTurnCoreImpl(spec, hooks),
}));

const { runSessionTurn, compactSessionContext } = await import("./turn.js");

const SESSION_ID = "sess-1";

interface HostHarness {
    host: TurnHost;
    ops: string[];
    appended: { type: string; payload: any }[];
    usageRecords: { sessionId: string; usage: any }[];
    persisted: string[];
    active: Map<string, ActiveSession>;
    session: ReturnType<typeof createEmptySession>;
}

/** 构造假宿主：记录生命周期与落盘调用，事件日志只需支持 lastSeq/append。 */
function makeHost(overrides: Partial<TurnHost> = {}): HostHarness {
    const ops: string[] = [];
    const appended: { type: string; payload: any }[] = [];
    const usageRecords: { sessionId: string; usage: any }[] = [];
    const persisted: string[] = [];
    const session = createEmptySession(SESSION_ID, undefined, process.cwd());
    const active = new Map<string, ActiveSession>([[SESSION_ID, { session, lastSeq: 0 }]]);

    const host: TurnHost = {
        eventLog: {
            lastSeq: async () => 0,
            append: async (_sessionId: string, type: string, payload: any) => {
                appended.push({ type, payload });
                return { seq: appended.length };
            },
        } as any,
        replay: {
            appendAgentEvent: async () => {},
            writeSnapshotIfDue: async () => {},
        } as any,
        activeSessions: active,
        allocateRequestId: () => 7,
        notify: () => {},
        requireActiveSession: async () => session,
        updateActiveSeq: () => {},
        accumulateInstanceUsage: (sessionId, usage) => usageRecords.push({ sessionId, usage }),
        finishAndPersist: async current => {
            persisted.push(current.sessionId);
            const entry = active.get(current.sessionId);
            if (entry) delete entry.abortController;
        },
        releaseSessionLockSafely: async () => {},
        beginSessionOperation: () => ops.push("begin"),
        endSessionOperation: () => ops.push("end"),
        appendSegmentStart: async (_sessionId, payload) => {
            appended.push({ type: "turn_segment_start", payload });
        },
        ...overrides,
    };
    return { host, ops, appended, usageRecords, persisted, active, session };
}

const outcomeOf = (partial: Partial<TurnOutcome> = {}): TurnOutcome => ({
    usage: {
        model: "deepseek-v4-flash",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        durationMs: 100,
        requestCount: 1,
    },
    stopReason: "stop",
    aborted: false,
    ...partial,
});

const SPEC = { turnId: "turn-1", userMessages: [{ text: "你好" }], query: "你好" };

let tmpDir: string;
let originalStateDir: string | undefined;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-agent-turn-"));
    originalStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;
});

afterEach(() => {
    runTurnCoreImpl = delegateRealRunTurn;
    if (originalStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = originalStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runSessionTurn 生命周期", () => {
    test("成功路径返回空对象，并成对开关会话操作", async () => {
        runTurnCoreImpl = async () => outcomeOf();
        const { host, ops, usageRecords, persisted } = makeHost();

        const result = await runSessionTurn(host, SESSION_ID, SPEC);

        expect(result).toEqual({});
        expect(ops).toEqual(["begin", "end"]);
        expect(usageRecords).toHaveLength(1);
        expect(persisted).toEqual([SESSION_ID]);
    });

    test("空助手消息修复在回合结束后落事件并更新会话历史", async () => {
        runTurnCoreImpl = async spec => {
            spec.session.turns.push({
                id: "turn-1",
                status: "completed",
                messages: [
                    { role: "assistant", content: null, reasoning_content: "思考", id: "message-1", createdAt: "2026-01-01" },
                ],
            });
            return outcomeOf({ hasInvalidAssistantHistory: true });
        };
        const { host, appended, session } = makeHost();

        await runSessionTurn(host, SESSION_ID, SPEC);

        expect(appended.map(item => item.type)).toEqual(["assistant_history_repaired"]);
        expect(session.turns[0]?.messages).toHaveLength(0);
    });

    test("中断路径返回 aborted，仍走完收尾", async () => {
        runTurnCoreImpl = async () => outcomeOf({ aborted: true });
        const { host, ops, persisted } = makeHost();

        expect(await runSessionTurn(host, SESSION_ID, SPEC)).toEqual({ aborted: true });
        expect(ops).toEqual(["begin", "end"]);
        expect(persisted).toEqual([SESSION_ID]);
    });

    test("错误路径抛出原错误，且会话操作不泄漏", async () => {
        runTurnCoreImpl = async () => outcomeOf({ error: new Error("provider 挂了") });
        const { host, ops } = makeHost();

        await expect(runSessionTurn(host, SESSION_ID, SPEC)).rejects.toThrow("provider 挂了");
        expect(ops).toEqual(["begin", "end"]);
    });

    test("非 Error 的失败值包装为 Error", async () => {
        runTurnCoreImpl = async () => outcomeOf({ error: "字符串错误" });
        const { host } = makeHost();

        await expect(runSessionTurn(host, SESSION_ID, SPEC)).rejects.toThrow("字符串错误");
    });

    test("turn 执行期间 abortController 挂到内存会话，收尾时清除", async () => {
        let seenSignal: AbortSignal | undefined;
        runTurnCoreImpl = async spec => {
            seenSignal = spec.signal;
            return outcomeOf();
        };
        const { host, active } = makeHost();

        await runSessionTurn(host, SESSION_ID, SPEC);

        expect(seenSignal).toBeInstanceOf(AbortSignal);
        expect(active.get(SESSION_ID)?.abortController).toBeUndefined();
    });
});

describe("runSessionTurn 落盘钩子", () => {
    test("空会话首次落盘先补 session_created，再写 user_message", async () => {
        runTurnCoreImpl = async (_spec, hooks) => {
            await hooks.persistUserMessages(["你好"], "turn-1");
            return outcomeOf();
        };
        const { host, appended } = makeHost();

        await runSessionTurn(host, SESSION_ID, SPEC);

        expect(appended.map(item => item.type)).toEqual(["session_created", "user_message"]);
        expect(appended[1]!.payload).toMatchObject({ text: "你好", turnId: "turn-1", trigger: "user" });
    });


    test("pending 与 turn_message 分别落盘", async () => {
        runTurnCoreImpl = async (_spec, hooks) => {
            await hooks.persistPendingMessage("插队", "turn-1");
            await hooks.persistSegmentStart({ turnId: "turn-1", kind: "user" });
            await hooks.persistTurnMessage({ role: "assistant", content: "回复" }, "turn-1");
            return outcomeOf();
        };
        const { host, appended } = makeHost();

        await runSessionTurn(host, SESSION_ID, SPEC);

        // pending 消息同时落 user_message 与 user 段边界，随后是 turn_message
        expect(appended.map(item => item.type)).toEqual(["user_message", "turn_segment_start", "turn_message"]);
        expect(appended[0]!.payload).toMatchObject({ trigger: "pending" });
        expect(appended[1]!.payload).toMatchObject({ turnId: "turn-1", kind: "user" });
        expect(appended[2]!.payload).toMatchObject({ turnId: "turn-1" });
    });
});

describe("compactSessionContext", () => {
    test("无可压缩历史时抛错，且会话操作与锁正常收尾", async () => {
        const { host, ops } = makeHost();

        await expect(compactSessionContext(host, SESSION_ID)).rejects.toThrow("当前没有可压缩的对话历史");
        expect(ops).toEqual(["begin", "end"]);
    });

    test("alreadyReserved：借用调用方的会话互斥，既不重抢也不代为释放", async () => {
        const { host, ops } = makeHost();

        await expect(compactSessionContext(host, SESSION_ID, undefined, { alreadyReserved: true }))
            .rejects.toThrow("当前没有可压缩的对话历史");
        expect(ops).toEqual([]);
    });
});
