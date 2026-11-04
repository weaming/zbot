/**
 * 会话间工具：session_spawn / session_send / session_status 的语义与下发条件。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MAX_SPAWNED_SESSIONS, SessionControl, type SessionControlHost } from "../../src/control/channel.js";
import type { PeerMessage } from "../../src/control/protocol.js";
import { forgetBound, locallyBoundSessionIds } from "../../src/control/registry.js";
import {
    registerSessionRuntime,
    type PeerResultRecord,
    type SessionDirectory,
} from "../../src/control/runtime.js";
import { getSessionToolNames, SESSION_TOOLS } from "../../src/tools/session-tools.js";
import { useTmpStateDir, type TmpStateDir } from "./test-env.js";

let stateDir: TmpStateDir;
let control: SessionControl;
/** 本文件注册的会话运行时（测试里等价于"唯一的宿主"）。 */
let unregisterRuntime: () => void;
const accepted: string[] = [];
const outbound: PeerMessage[] = [];
const busy = new Set<string>();
const spawned: string[] = [];
const closed: Array<{ sessionId: string; automatic: boolean }> = [];
const cancelled: Array<{ sessionId: string; close: boolean }> = [];
const woken: string[] = [];
/** 目标会话受理后自动回传的结果文本：设了才回，模拟对方跑完一轮。 */
const replies = new Map<string, string>();
/** 回传结果时的终态：默认 stop，设了 aborted 即模拟对方回合被取消。 */
const replyStopReasons = new Map<string, string>();
/** 各会话历史收到的会话间结果：模拟事件日志里的 peer_result。 */
const peerResults = new Map<string, PeerResultRecord[]>();

const SESSIONS = [
    { sessionId: "01JAAAAAAAAAAAAAAAAAAAAAA1", title: "重构 session 模块" },
    { sessionId: "01JAAAAAAAAAAAAAAAAAAAAAA2", title: "写测试" },
    { sessionId: "01JAAAAAAAAAAAAAAAAAAAAAA3" },
];
const ARCHIVED_SESSION = { sessionId: "01JAAAAAAAAAAAAAAAAAAAAAA4", title: "已归档 review" };

function makeHost(): SessionControlHost {
    return {
        title: (sessionId) => SESSIONS.find(item => item.sessionId === sessionId)?.title,
        isBusy: (sessionId) => busy.has(sessionId),
        createSession: async () => ({ sessionId: `01JSPAWN${String(spawned.length + 1).padStart(18, "0")}` }),
        sessionCwd: async (sessionId) => `/tmp/cwd-${sessionId.slice(-1)}`,
        onSessionSpawned: (sessionId, title) => {
            spawned.push(title ? `${sessionId}:${title}` : sessionId);
        },
        archiveSpawnedSession: async (sessionId, automatic) => {
            closed.push({ sessionId, automatic });
            control.release(sessionId);
        },
        cancelSpawnedSession: async (sessionId, close) => {
            if (!busy.has(sessionId)) return false;
            busy.delete(sessionId);
            cancelled.push({ sessionId, close });
            if (close) {
                closed.push({ sessionId, automatic: false });
                control.release(sessionId);
            }
            return true;
        },
        accept: (message) => {
            if (busy.has(message.to)) return { status: "busy" as const };
            accepted.push(message.id);
            const reply = replies.get(message.to);
            if (reply !== undefined) {
                setTimeout(() => {
                    control.completeInbound(message.to, message, {
                        msgId: message.id,
                        ok: true,
                        text: reply,
                        stopReason: replyStopReasons.get(message.to) ?? "stop",
                    });
                }, 0);
            }
            return { status: "accepted" as const };
        },
        onOutbound: (_from, message) => {
            outbound.push(message);
        },
        onResult: () => undefined,
        onLost: () => undefined,
        onReleased: () => undefined,
    };
}

function tool(name: string) {
    const found = SESSION_TOOLS.find(item => item.name === name);
    if (!found) throw new Error(`工具不存在: ${name}`);
    return found;
}

beforeEach(() => {
    stateDir = useTmpStateDir("zbot-session-tools-");
    for (const sessionId of locallyBoundSessionIds()) forgetBound(sessionId);
    accepted.length = 0;
    outbound.length = 0;
    busy.clear();
    spawned.length = 0;
    closed.length = 0;
    cancelled.length = 0;
    woken.length = 0;
    replies.clear();
    replyStopReasons.clear();
    peerResults.clear();

    control = new SessionControl(makeHost(), { probeTimeoutMs: 100, negotiateTimeoutMs: 200 });
    registerRuntime();
});

/** 目录能力：唤醒用（走 control.claim + adoptSpawnedSession）。 */
function defaultDirectory(): SessionDirectory {
    return {
        list: async options => options?.includeArchived ? [...SESSIONS, ARCHIVED_SESSION] : SESSIONS,
        wake: async sessionId => {
            if (sessionId !== ARCHIVED_SESSION.sessionId) throw new Error("目标会话未归档");
            const claimed = await control.claim(sessionId);
            if (!claimed.ok) throw new Error(claimed.error ?? "认领失败");
            if (!control.adoptSpawnedSession(sessionId)) {
                control.release(sessionId);
                throw new Error("子会话名额已满");
            }
            woken.push(sessionId);
        },
    };
}

/** 注册/重注册"唯一宿主"的能力；`omit` 精确去掉某项能力，模拟宿主没有它。 */
function registerRuntime(options: {
    directory?: SessionDirectory;
    omit?: Array<"control" | "directory" | "recentPeerResults">;
} = {}): void {
    unregisterRuntime?.();
    const omit = new Set(options.omit ?? []);
    unregisterRuntime = registerSessionRuntime({
        ownsSession: () => true,
        ...(omit.has("control") ? {} : { control }),
        ...(omit.has("directory") ? {} : { directory: options.directory ?? defaultDirectory() }),
        ...(omit.has("recentPeerResults")
            ? {}
            : { recentPeerResults: async (sessionId, limit) => (peerResults.get(sessionId) ?? []).slice(-limit) }),
    });
}

afterEach(() => {
    unregisterRuntime();
    control.close();
    for (const sessionId of locallyBoundSessionIds()) forgetBound(sessionId);
    stateDir.cleanup();
});

describe("下发条件", () => {
    test("没有会话上下文时不注入", () => {
        expect(getSessionToolNames(undefined)).toEqual([]);
    });

    test("有会话上下文即注入，不必已认领（回合运行期间持有权不会被释放）", () => {
        expect(getSessionToolNames(SESSIONS[0]!.sessionId)).toEqual([
            "session_spawn",
            "session_send",
            "session_status",
            "session_close",
            "session_cancel",
            "session_wake",
        ]);
    });

    test("进程未装配控制通道时不注入", () => {
        registerRuntime({ omit: ["control"] });
        expect(getSessionToolNames(SESSIONS[0]!.sessionId)).toEqual([]);
    });
});

describe("session_spawn", () => {
    test("缺少会话上下文时报错", async () => {
        const result = await tool("session_spawn").execute({});
        expect(result.isError).toBe(true);
    });

    test("派生 + 认领 + 通知宿主，并返回完整 id", async () => {
        const result = await tool("session_spawn").execute({
            title: "读日志",
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBeUndefined();
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("已派生并接管会话");
        expect(text).toContain("session_send");
        expect(spawned.length).toBe(1);
        expect(spawned[0]).toEndWith(":读日志");
        expect(control.spawnedCount).toBe(1);
    });

    test("可在派生时发送初次任务消息并请求结果回传", async () => {
        const result = await tool("session_spawn").execute({
            title: "初次任务",
            text: "检查这段日志",
            __sessionId: SESSIONS[0]!.sessionId,
        });

        const sessionId = /完整 id：(\S+)/.exec(result.content[0]?.text ?? "")?.[1];
        expect(result.isError).toBeUndefined();
        expect(sessionId).toBeDefined();
        expect(outbound).toHaveLength(1);
        expect(outbound[0]).toMatchObject({ to: sessionId, text: "检查这段日志", expectResult: true });
        expect(result.content[0]?.text).toContain("已发送初次任务消息");
    });

    test("auto_close=true 在首个期望结果回传后自动归档并释放", async () => {
        const spawn = await tool("session_spawn").execute({
            auto_close: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        const sessionId = /完整 id：(\S+)/.exec(spawn.content[0]?.text ?? "")?.[1] ?? "";
        replies.set(sessionId, "任务完成");

        const result = await tool("session_send").execute({
            session: sessionId,
            text: "执行任务",
            expect_result: true,
            wait_seconds: 1,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(result.isError).toBeUndefined();
        expect(closed).toEqual([{ sessionId, automatic: true }]);
        expect(control.spawnedCount).toBe(0);
    });

    test("auto_close 不会在未请求回传结果时关闭子会话", async () => {
        const spawn = await tool("session_spawn").execute({
            auto_close: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        const sessionId = /完整 id：(\S+)/.exec(spawn.content[0]?.text ?? "")?.[1] ?? "";
        replies.set(sessionId, "任务完成");

        await tool("session_send").execute({
            session: sessionId,
            text: "执行任务",
            __sessionId: SESSIONS[0]!.sessionId,
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(closed).toEqual([]);
        expect(control.spawnedCount).toBe(1);
    });

    test("session_close 只归档本实例派生子会话并保留历史", async () => {
        const spawn = await tool("session_spawn").execute({ __sessionId: SESSIONS[0]!.sessionId });
        const sessionId = /完整 id：(\S+)/.exec(spawn.content[0]?.text ?? "")?.[1] ?? "";

        const result = await tool("session_close").execute({
            session: sessionId,
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toContain("历史保留");
        expect(closed).toEqual([{ sessionId, automatic: false }]);
        expect(control.spawnedCount).toBe(0);
    });

    test("session_close 不允许归档普通会话", async () => {
        await control.claim(SESSIONS[1]!.sessionId);
        const result = await tool("session_close").execute({
            session: SESSIONS[1]!.sessionId,
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("只能关闭本实例派生");
        expect(closed).toEqual([]);
    });

    test("session_close 不允许归档正在执行的子会话", async () => {
        const spawn = await tool("session_spawn").execute({ __sessionId: SESSIONS[0]!.sessionId });
        const sessionId = /完整 id：(\S+)/.exec(spawn.content[0]?.text ?? "")?.[1] ?? "";
        busy.add(sessionId);

        const result = await tool("session_close").execute({
            session: sessionId,
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("正在执行");
        expect(closed).toEqual([]);
    });

    test("派生的子会话可直接派活（本进程直投）", async () => {
        const spawn = await tool("session_spawn").execute({ __sessionId: SESSIONS[0]!.sessionId });
        const sessionId = /完整 id：(\S+)/.exec(spawn.content[0]?.text ?? "")?.[1] ?? "";

        const send = await tool("session_send").execute({
            session: sessionId,
            text: "把日志读一遍",
            expect_result: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(send.isError).toBeUndefined();
        expect(accepted.length).toBe(1);
    });

    test("超出上限时报错并提示清理", async () => {
        for (let index = 0; index < MAX_SPAWNED_SESSIONS; index++) {
            const result = await tool("session_spawn").execute({ __sessionId: SESSIONS[0]!.sessionId });
            expect(result.isError).toBeUndefined();
        }

        const overflow = await tool("session_spawn").execute({ __sessionId: SESSIONS[0]!.sessionId });
        expect(overflow.isError).toBe(true);
        expect(overflow.content[0]?.text).toContain("上限");
    });

    test("释放后名额归还", async () => {
        const first = await tool("session_spawn").execute({ __sessionId: SESSIONS[0]!.sessionId });
        const sessionId = /完整 id：(\S+)/.exec(first.content[0]?.text ?? "")?.[1] ?? "";
        expect(control.spawnedCount).toBe(1);

        control.release(sessionId);
        expect(control.spawnedCount).toBe(0);
    });
});

describe("session_cancel", () => {
    test("取消本实例派生子会话并保持打开", async () => {
        const spawn = await tool("session_spawn").execute({ __sessionId: SESSIONS[0]!.sessionId });
        const sessionId = /完整 id：(\S+)/.exec(spawn.content[0]?.text ?? "")?.[1] ?? "";
        busy.add(sessionId);

        const result = await tool("session_cancel").execute({
            session: sessionId,
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toContain("仍保持打开");
        expect(cancelled).toEqual([{ sessionId, close: false }]);
        expect(closed).toEqual([]);
        expect(control.spawnedCount).toBe(1);
    });

    test("close=true 取消后归档并释放子会话", async () => {
        const spawn = await tool("session_spawn").execute({ __sessionId: SESSIONS[0]!.sessionId });
        const sessionId = /完整 id：(\S+)/.exec(spawn.content[0]?.text ?? "")?.[1] ?? "";
        busy.add(sessionId);

        const result = await tool("session_cancel").execute({
            session: sessionId,
            close: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toContain("归档");
        expect(cancelled).toEqual([{ sessionId, close: true }]);
        expect(closed).toEqual([{ sessionId, automatic: false }]);
        expect(control.spawnedCount).toBe(0);
    });

    test("空闲、非子会话与缺上下文时拒绝取消", async () => {
        const idle = await tool("session_spawn").execute({ __sessionId: SESSIONS[0]!.sessionId });
        const childId = /完整 id：(\S+)/.exec(idle.content[0]?.text ?? "")?.[1] ?? "";
        const idleResult = await tool("session_cancel").execute({ session: childId, __sessionId: SESSIONS[0]!.sessionId });
        const ordinaryResult = await tool("session_cancel").execute({
            session: SESSIONS[1]!.sessionId,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        const noContextResult = await tool("session_cancel").execute({ session: childId });

        expect(idleResult.isError).toBe(true);
        expect(ordinaryResult.content[0]?.text).toContain("只能取消");
        expect(noContextResult.isError).toBe(true);
        expect(cancelled).toEqual([]);
    });
});

describe("session_wake", () => {
    test("按短 id 唤醒归档会话", async () => {
        const result = await tool("session_wake").execute({
            session: ARCHIVED_SESSION.sessionId.slice(-8),
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toContain("已唤醒并认领");
        expect(woken).toEqual([ARCHIVED_SESSION.sessionId]);
    });

    test("带 text 唤醒后派发输入，并在结果回传后默认重新归档", async () => {
        replies.set(ARCHIVED_SESSION.sessionId, "继续任务已完成");

        const result = await tool("session_wake").execute({
            session: ARCHIVED_SESSION.sessionId,
            text: "继续上次的 review",
            __sessionId: SESSIONS[0]!.sessionId,
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toContain("发送输入");
        expect(result.content[0]?.text).toContain("自动重新归档");
        expect(outbound.at(-1)?.expectResult).toBe(true);
        expect(outbound.at(-1)?.closeOnResult).toBe(true);
        expect(closed).toEqual([{ sessionId: ARCHIVED_SESSION.sessionId, automatic: true }]);
    });

    test("close=false 带 text 唤醒后保留会话", async () => {
        replies.set(ARCHIVED_SESSION.sessionId, "继续任务已完成");

        const result = await tool("session_wake").execute({
            session: ARCHIVED_SESSION.sessionId,
            text: "继续工作",
            close: false,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toContain("保持打开");
        expect(outbound.at(-1)?.closeOnResult).toBeUndefined();
        expect(closed).toEqual([]);
        expect(control.spawnedCount).toBe(1);
    });

    test("唤醒输入发送失败不会遗留自动归档标记", async () => {
        busy.add(ARCHIVED_SESSION.sessionId);
        const wakeResult = await tool("session_wake").execute({
            session: ARCHIVED_SESSION.sessionId,
            text: "继续工作",
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(wakeResult.isError).toBe(true);
        busy.delete(ARCHIVED_SESSION.sessionId);

        replies.set(ARCHIVED_SESSION.sessionId, "后续任务结果");
        await control.send(SESSIONS[0]!.sessionId, ARCHIVED_SESSION.sessionId, "另一个普通任务", { expectResult: true });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(closed).toEqual([]);
        expect(control.spawnedCount).toBe(1);
    });

    test("非归档会话的唤醒请求被宿主拒绝", async () => {
        const result = await tool("session_wake").execute({
            session: SESSIONS[0]!.sessionId,
            __sessionId: SESSIONS[1]!.sessionId,
        });

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("目标会话未归档");
        expect(woken).toEqual([]);
    });

    test("缺少 TUI 恢复能力时返回明确错误", async () => {
        registerRuntime({ directory: { list: async () => [...SESSIONS, ARCHIVED_SESSION] } });
        const result = await tool("session_wake").execute({
            session: ARCHIVED_SESSION.sessionId,
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("仅在 TUI 内可用");
    });
});

describe("session_send", () => {
    test("未知 caller：严格拒绝，不把调用路由到本实例唯一的宿主", async () => {
        const unknown = "01JUNKNOWNCALLER0000000000";
        // 只负责 SESSIONS[0]：未知 caller 不在本实例上下文里
        unregisterRuntime();
        unregisterRuntime = registerSessionRuntime({
            ownsSession: sessionId => sessionId === SESSIONS[0]!.sessionId,
            control,
        });

        expect(getSessionToolNames(unknown)).toEqual([]);
        const result = await tool("session_send").execute({
            session: SESSIONS[1]!.sessionId,
            text: "hi",
            __sessionId: unknown,
        });

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("不在本实例的运行时上下文里");
    });

    test("缺少会话上下文时报错", async () => {
        const result = await tool("session_send").execute({ session: "…1", text: "hi" });
        expect(result.isError).toBe(true);
    });

    test("必填参数缺失时报错", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        const noSession = await tool("session_send").execute({ text: "hi", __sessionId: SESSIONS[0]!.sessionId });
        expect(noSession.isError).toBe(true);
        const noText = await tool("session_send").execute({ session: SESSIONS[1]!.sessionId, __sessionId: SESSIONS[0]!.sessionId });
        expect(noText.isError).toBe(true);
    });

    test("送达后返回 msgId，期望结果时提示稍后回传", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        await control.claim(SESSIONS[1]!.sessionId);

        const result = await tool("session_send").execute({
            session: SESSIONS[1]!.sessionId.slice(-8),
            text: "把日志读一遍",
            expect_result: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBeUndefined();
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("已发送到会话");
        expect(text).toContain("结果稍后自动回传");
        expect(accepted.length).toBe(1);
    });

    test("目标未认领时给出不可达错误", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        const result = await tool("session_send").execute({
            session: SESSIONS[1]!.sessionId,
            text: "在吗",
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("不可达");
    });

    test("目标忙时给出可重试的错误提示", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        await control.claim(SESSIONS[1]!.sessionId);
        busy.add(SESSIONS[1]!.sessionId);

        const result = await tool("session_send").execute({
            session: SESSIONS[1]!.sessionId,
            text: "插队",
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("正在执行中");
    });

    test("不能给自己发消息", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        const result = await tool("session_send").execute({
            session: SESSIONS[0]!.sessionId,
            text: "自问自答",
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(result.isError).toBe(true);
    });

    test("wait_seconds 命中时结果直接作为工具结果返回，且不入队", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        await control.claim(SESSIONS[1]!.sessionId);
        replies.set(SESSIONS[1]!.sessionId, "日志读完了");

        const result = await tool("session_send").execute({
            session: SESSIONS[1]!.sessionId.slice(-8),
            text: "把日志读一遍",
            wait_seconds: 5,
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toContain("日志读完了");
        // wait_seconds 隐含 expect_result
        expect(outbound[0]?.expectResult).toBe(true);
        expect(control.awaitingResults(SESSIONS[0]!.sessionId)).toBe(0);
        expect(control.queuedResults(SESSIONS[0]!.sessionId)).toBe(0);
    });

    test("wait_seconds 超时返回提示，等待项保留给自动附加", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        await control.claim(SESSIONS[1]!.sessionId);

        const result = await tool("session_send").execute({
            session: SESSIONS[1]!.sessionId,
            text: "慢慢来",
            wait_seconds: 0.05,
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toContain("未见结果");
        expect(control.awaitingResults(SESSIONS[0]!.sessionId)).toBe(1);
    });

    test("对方回合被取消时 wait_seconds 明确回报已取消", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        await control.claim(SESSIONS[1]!.sessionId);
        replies.set(SESSIONS[1]!.sessionId, "");
        replyStopReasons.set(SESSIONS[1]!.sessionId, "aborted");

        const result = await tool("session_send").execute({
            session: SESSIONS[1]!.sessionId,
            text: "跑一下再被取消",
            wait_seconds: 5,
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toContain("（已取消）");
        expect(result.content[0]?.text).toContain("本轮被取消");
    });

    test("wait_seconds 为零时发完即返回", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        await control.claim(SESSIONS[1]!.sessionId);
        replies.set(SESSIONS[1]!.sessionId, "不该被等到");

        const result = await tool("session_send").execute({
            session: SESSIONS[1]!.sessionId,
            text: "通知一下",
            wait_seconds: 0,
            __sessionId: SESSIONS[0]!.sessionId,
        });

        expect(result.content[0]?.text).not.toContain("不该被等到");
        expect(result.content[0]?.text).not.toContain("结果稍后自动回传");
        expect(outbound[0]?.expectResult).toBeUndefined();
    });

    test("等待被中止时报错", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        await control.claim(SESSIONS[1]!.sessionId);

        const controller = new AbortController();
        controller.abort();
        const result = await tool("session_send").execute(
            {
                session: SESSIONS[1]!.sessionId,
                text: "慢慢来",
                wait_seconds: 5,
                __sessionId: SESSIONS[0]!.sessionId,
            },
            controller.signal,
        );

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("被中止");
    });

    test("等待期间放入后台时立刻返回提示，结果仍会自动附加", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        await control.claim(SESSIONS[1]!.sessionId);

        const pending = tool("session_send").execute({
            session: SESSIONS[1]!.sessionId,
            text: "慢慢来",
            wait_seconds: 5,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        // 模拟用户按 ⌃B：等工具登记好等待项再放后台
        let detached = 0;
        for (let attempt = 0; attempt < 50 && detached === 0; attempt++) {
            await Bun.sleep(1);
            detached = control.detachWaits(SESSIONS[0]!.sessionId);
        }
        expect(detached).toBe(1);

        const result = await pending;
        expect(result.isError).toBeUndefined();
        expect(result.content[0]?.text).toContain("放入后台");
        expect(control.awaitingResults(SESSIONS[0]!.sessionId)).toBe(1);
    });
});

describe("session_status", () => {
    test("省略 session 时列出全部会话与归属", async () => {
        await control.claim(SESSIONS[0]!.sessionId);

        const result = await tool("session_status").execute({ __sessionId: SESSIONS[0]!.sessionId });
        const text = result.content[0]?.text ?? "";

        expect(result.isError).toBeUndefined();
        expect(text).toContain("重构 session 模块");
        expect(text).toContain("写测试");
        expect(text).toContain("本实例");
        expect(text).toContain("未认领");
        expect(text).toContain("← 你");
    });

    test("指定 session 时给出详情", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        const result = await tool("session_status").execute({
            session: SESSIONS[1]!.sessionId.slice(-8),
            __sessionId: SESSIONS[0]!.sessionId,
        });

        const text = result.content[0]?.text ?? "";
        expect(text).toContain("归属：未认领");
        expect(text).toContain("session_send");
    });

    test("查询自己时明确提示不能自发", async () => {
        await control.claim(SESSIONS[0]!.sessionId);
        const result = await tool("session_status").execute({
            session: SESSIONS[0]!.sessionId.slice(-8),
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(result.content[0]?.text).toContain("不能给自己发消息");
    });

    test("没有会话目录时报错", async () => {
        registerRuntime({ omit: ["directory"] });
        const result = await tool("session_status").execute({});
        expect(result.isError).toBe(true);
    });

    test("省略 session + include_result 时附上自己最近收到的结果原文", async () => {
        peerResults.set(SESSIONS[0]!.sessionId, [
            {
                peerId: SESSIONS[1]!.sessionId,
                peerTitle: "写测试",
                ok: true,
                text: "已完成：tests/unit/foo.test.ts 新增 3 例",
                stopReason: "stop",
                createdAt: "2026-02-03T10:00:00+08:00",
            },
        ]);

        const result = await tool("session_status").execute({
            include_result: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        const text = result.content[0]?.text ?? "";

        expect(result.isError).toBeUndefined();
        expect(text).toContain("重构 session 模块");
        expect(text).toContain("最近结果（来自");
        expect(text).toContain("写测试");
        expect(text).toContain("2026-02-03T10:00:00+08:00");
        expect(text).toContain("已完成：tests/unit/foo.test.ts 新增 3 例");
    });

    test("指定 session 时读的是该会话自己的结果日志", async () => {
        peerResults.set(SESSIONS[1]!.sessionId, [
            {
                peerId: SESSIONS[2]!.sessionId,
                ok: true,
                text: "对方会话作为请求方收到的结果",
                createdAt: "2026-02-03T09:00:00+08:00",
            },
        ]);

        const result = await tool("session_status").execute({
            session: SESSIONS[1]!.sessionId.slice(-8),
            include_result: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(result.content[0]?.text).toContain("对方会话作为请求方收到的结果");
    });

    test("默认不返回结果原文", async () => {
        peerResults.set(SESSIONS[0]!.sessionId, [
            {
                peerId: SESSIONS[1]!.sessionId,
                ok: true,
                text: "不该出现的结果原文",
                createdAt: "2026-02-03T10:00:00+08:00",
            },
        ]);

        const result = await tool("session_status").execute({
            session: SESSIONS[1]!.sessionId.slice(-8),
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(result.content[0]?.text).not.toContain("不该出现的结果原文");
    });

    test("没有历史结果时明确提示", async () => {
        const result = await tool("session_status").execute({
            session: SESSIONS[1]!.sessionId.slice(-8),
            include_result: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(result.content[0]?.text).toContain("最近结果：（无）");
    });

    test("未装配结果历史时提示不可查", async () => {
        registerRuntime({ omit: ["recentPeerResults"] });
        const result = await tool("session_status").execute({
            session: SESSIONS[1]!.sessionId.slice(-8),
            include_result: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        expect(result.content[0]?.text).toContain("未装配结果历史");
    });

    test("结果丢失时标记状态", async () => {
        peerResults.set(SESSIONS[0]!.sessionId, [
            {
                peerId: SESSIONS[2]!.sessionId,
                ok: false,
                lost: true,
                text: "等待会话的结果失败：对方未在期限内回传",
                createdAt: "2026-02-03T11:00:00+08:00",
            },
        ]);

        const result = await tool("session_status").execute({
            session: SESSIONS[0]!.sessionId.slice(-8),
            include_result: true,
            __sessionId: SESSIONS[0]!.sessionId,
        });
        const text = result.content[0]?.text ?? "";
        expect(text).toContain("已丢失");
        expect(text).toContain("对方未在期限内回传");
    });
});
