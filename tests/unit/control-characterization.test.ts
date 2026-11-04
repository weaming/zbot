/**
 * 特征测试：control 层的时序不变量。
 *
 * 现有 control-channel.test.ts 覆盖了"每种操作的结果对不对"；
 * 这里补的是"任意操作序列下都不该被破坏的不变量"——
 * 重构（出站消息实体化、归属状态机化）后这些不变量必须仍然成立。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { describeClaimFailure, SessionControl, type SessionControlHost } from "../../src/control/channel.js";
import type { PeerMessage, PeerResult } from "../../src/control/protocol.js";
import { forgetBound, locallyBoundSessionIds } from "../../src/control/registry.js";
import { useTmpStateDir, type TmpStateDir } from "./test-env.js";

let stateDir: TmpStateDir;
const controls: SessionControl[] = [];

beforeEach(() => {
    stateDir = useTmpStateDir("zbot-control-invariants-");
    for (const sessionId of locallyBoundSessionIds()) forgetBound(sessionId);
});

afterEach(() => {
    for (const control of controls.splice(0)) control.close();
    for (const sessionId of locallyBoundSessionIds()) forgetBound(sessionId);
    stateDir.cleanup();
});

interface Recorder extends SessionControlHost {
    accepted: PeerMessage[];
    results: Array<{ requester: string; result: PeerResult }>;
    lost: Array<{ requester: string; msgIds: string[] }>;
    busy: Set<string>;
}

function makeHost(): Recorder {
    const host: Recorder = {
        accepted: [],
        results: [],
        lost: [],
        busy: new Set<string>(),
        title: (sessionId) => sessionId,
        isBusy: (sessionId) => host.busy.has(sessionId),
        createSession: async () => ({ sessionId: "spawned-1" }),
        sessionCwd: async (sessionId) => `/cwd/${sessionId}`,
        onSessionSpawned: () => {},
        accept: (message) => {
            if (host.busy.has(message.to)) return { status: "busy" as const };
            host.accepted.push(message);
            return { status: "accepted" as const };
        },
        onOutbound: () => {},
        onResult: (requester, _message, result) => host.results.push({ requester, result }),
        onLost: (requester, msgIds) => host.lost.push({ requester, msgIds }),
        onReleased: () => {},
    };
    return host;
}

function makeControl(host: Recorder): SessionControl {
    const control = new SessionControl(host, {
        probeTimeoutMs: 100,
        negotiateTimeoutMs: 200,
        resultTimeoutMs: 60_000,
    });
    controls.push(control);
    return control;
}

/** 极简外部持有者：只用于让目标是"外部会话"，以便走 socket 路径。 */

describe("不变量：认领互斥", () => {
    test("重复认领同一会话幂等，不会产生第二个监听者", async () => {
        const host = makeHost();
        const control = makeControl(host);

        const first = await control.claim("sess-a");
        const second = await control.claim("sess-a");

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        expect(control.claimedSessionIds).toEqual(["sess-a"]);
    });

    test("释放后不再持有，且可被再次认领", async () => {
        const host = makeHost();
        const control = makeControl(host);

        await control.claim("sess-b");
        control.release("sess-b");
        expect(control.isClaimed("sess-b")).toBe(false);

        const again = await control.claim("sess-b");
        expect(again.ok).toBe(true);
    });

    test("close 之后不残留任何持有", async () => {
        const host = makeHost();
        const control = makeControl(host);

        await control.claim("sess-c");
        await control.claim("sess-d");
        control.close();

        expect(control.claimedSessionIds).toEqual([]);
        controls.splice(controls.indexOf(control), 1);
    });
});

describe("不变量：结果四态互斥", () => {
    test("正常完成的消息不再留在待取队列", async () => {
        const host = makeHost();
        const control = makeControl(host);
        // 目标必须是本实例持有的会话，投递才走进程内路径
        await control.claim("sess-to");

        const { message } = await control.send("sess-from", "sess-to", "干活", { expectResult: true });
        expect(control.awaitingResults("sess-from")).toBe(1);

        control.completeInbound("sess-to", message, { msgId: message.id, ok: true, text: "完成", stopReason: "stop" });

        // 结果进入待附加队列，等待项清除
        expect(control.awaitingResults("sess-from")).toBe(0);
        expect(control.queuedResults("sess-from")).toBe(1);
        expect(control.takeResults("sess-from")).toHaveLength(1);
        // 取走即清
        expect(control.queuedResults("sess-from")).toBe(0);
    });

    test("同一结果重复回传不会重复入队", async () => {
        const host = makeHost();
        const control = makeControl(host);
        // 目标必须是本实例持有的会话，投递才走进程内路径
        await control.claim("sess-to");

        const { message } = await control.send("sess-from", "sess-to", "干活", { expectResult: true });
        const result = { msgId: message.id, ok: true, text: "完成", stopReason: "stop" };

        control.completeInbound("sess-to", message, result);
        control.completeInbound("sess-to", message, result);

        // 第一次已消耗等待项，第二次找不到对应记录，不应再入队
        expect(control.queuedResults("sess-from")).toBe(1);
    });

    test("未期望结果的消息不产生等待项", async () => {
        const host = makeHost();
        const control = makeControl(host);
        await control.claim("sess-to");

        await control.send("sess-from", "sess-to", "通知");
        expect(control.awaitingResults("sess-from")).toBe(0);
        expect(control.queuedResults("sess-from")).toBe(0);
    });
});

describe("不变量：失败不产生副作用", () => {
    test("目标忙时报错，且不留下等待项", async () => {
        const host = makeHost();
        const control = makeControl(host);
        host.busy.add("sess-to");

        await expect(control.send("sess-from", "sess-to", "hi", { expectResult: true })).rejects.toThrow();

        expect(control.awaitingResults("sess-from")).toBe(0);
        expect(host.accepted).toHaveLength(0);
    });

    test("给自己发消息被拒绝", async () => {
        const host = makeHost();
        const control = makeControl(host);

        await expect(control.send("same", "same", "hi")).rejects.toThrow();
        expect(control.awaitingResults("same")).toBe(0);
    });

    test("远端不可达时报 unreachable，不留下等待项", async () => {
        const host = makeHost();
        const control = makeControl(host);

        await expect(control.send("sess-from", "no-such-session", "hi", { expectResult: true })).rejects.toThrow();
        expect(control.awaitingResults("sess-from")).toBe(0);
    });
});

describe("不变量：认领失败必须归因准确", () => {
    test("忙碌持有者 → busy，且带 PID", () => {
        const text = describeClaimFailure({ ok: false, reason: "busy", pid: 1234 });
        expect(text).toContain("PID 1234");
        expect(text).toContain("执行中");
    });

    test("持有者无应答 → unresponsive，措辞不含「被抢先」", () => {
        const text = describeClaimFailure({ ok: false, reason: "unresponsive" });
        expect(text).toContain("未应答");
        expect(text).not.toContain("抢先");
    });

    test("协商成功但被抢先 → raced，不再误报为无应答", () => {
        const text = describeClaimFailure({ ok: false, reason: "raced", winnerPid: 4321 });
        expect(text).toContain("抢先");
        expect(text).toContain("PID 4321");
        expect(text).not.toContain("未应答");
    });

    test("raced 无 PID 时仍给出可操作文案", () => {
        const text = describeClaimFailure({ ok: false, reason: "raced" });
        expect(text).toContain("抢先");
        expect(text).toContain("重试");
    });

    test("成功时无文案", () => {
        expect(describeClaimFailure({ ok: true })).toBe("");
    });
});

describe("不变量：登记表不泄漏", () => {
    test("超时后条目与等待项都被清理", async () => {
        const host = makeHost();
        const control = new SessionControl(host, {
            probeTimeoutMs: 100,
            negotiateTimeoutMs: 200,
            resultTimeoutMs: 30,
        });
        controls.push(control);
        await control.claim("sess-to");

        await control.send("sess-from", "sess-to", "hi", { expectResult: true });
        expect(control.awaitingResults("sess-from")).toBe(1);

        // 等超时触发
        await new Promise(resolve => setTimeout(resolve, 60));

        expect(control.awaitingResults("sess-from")).toBe(0);
        expect(host.lost).toHaveLength(1);
    });

    test("close 时未兑现的等待全部结束，不留悬挂", async () => {
        const host = makeHost();
        const control = makeControl(host);
        await control.claim("sess-to");

        const { message } = await control.send("sess-from", "sess-to", "hi", { expectResult: true });
        const waiting = control.waitForResult(message.id, 60_000);

        control.close();
        controls.splice(controls.indexOf(control), 1);

        const outcome = await waiting;
        expect(outcome.ok).toBe(false);
        expect((outcome as any).reason).toBe("aborted");
    });
});
