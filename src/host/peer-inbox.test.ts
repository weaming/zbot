import { describe, expect, test } from "bun:test";
import type { PeerMessage, PeerResult } from "../control/protocol.js";
import { MAX_QUEUED_PEER_MESSAGES, PeerInbox } from "./peer-inbox.js";

/**
 * 入站投递状态机的纯单测：不建宿主、不碰事件日志与控制通道。
 * 这里覆盖的是宿主难以稳定复现的边界——同 msgId 并发占位、结果淘汰后重执、
 * 队列上限回滚、过期边界、取消与终态。
 */

const AT = "2026-01-01T00:00:00.000Z";

function messageOf(overrides: Partial<PeerMessage> & { id?: string; to?: string } = {}): PeerMessage {
    return {
        id: overrides.id ?? "m1",
        from: "peer-a",
        to: overrides.to ?? "sess-1",
        text: "hi",
        createdAt: AT,
        ...overrides,
    };
}

function resultOf(msgId: string, overrides: Partial<PeerResult> = {}): PeerResult {
    return { msgId, ok: true, text: "done", stopReason: "stop", ...overrides };
}

describe("PeerInbox 排队与位次", () => {
    test("FIFO：head/shift 按入队顺序，位次从 1 起，空队列不留键", () => {
        const inbox = new PeerInbox();
        expect(inbox.begin(messageOf({ id: "a" }))).toEqual({ kind: "new" });
        expect(inbox.enqueue(messageOf({ id: "a" }), "t1")).toEqual({ position: 1 });
        inbox.begin(messageOf({ id: "b" }));
        expect(inbox.enqueue(messageOf({ id: "b" }), "t2")).toEqual({ position: 2 });

        expect(inbox.head("sess-1")?.message.id).toBe("a");
        expect(inbox.snapshot("sess-1").map(entry => [entry.msgId, entry.position, entry.queuedAt])).toEqual([
            ["a", 1, "t1"],
            ["b", 2, "t2"],
        ]);

        expect(inbox.shift("sess-1")?.message.id).toBe("a");
        expect(inbox.snapshot("sess-1").map(entry => [entry.msgId, entry.position])).toEqual([["b", 1]]);
        expect(inbox.shift("sess-1")?.message.id).toBe("b");
        expect(inbox.shift("sess-1")).toBeUndefined();
        expect(inbox.sessionIds()).toEqual([]);
    });

    test("抢互斥失败时不移动队首：消息留在原位等下一轮，重投仍按原位次应答", () => {
        const inbox = new PeerInbox();
        for (const id of ["a", "b"]) {
            inbox.begin(messageOf({ id }));
            inbox.enqueue(messageOf({ id }), "t");
        }

        // 宿主只 peek，抢不到互斥就直接 break：队首与位次都不变
        expect(inbox.head("sess-1")?.message.id).toBe("a");
        expect(inbox.snapshot("sess-1").map(entry => [entry.msgId, entry.position])).toEqual([["a", 1], ["b", 2]]);
        expect(inbox.begin(messageOf({ id: "a" }))).toEqual({ kind: "queued", position: 1 });
    });

    test("队列有界：超过上限回 full 并回滚占位，重投可按新消息处理", () => {
        const inbox = new PeerInbox({ maxQueued: 2 });
        for (const id of ["a", "b"]) {
            inbox.begin(messageOf({ id }));
            inbox.enqueue(messageOf({ id }), "t");
        }

        expect(inbox.begin(messageOf({ id: "c" }))).toEqual({ kind: "new" });
        expect(inbox.enqueue(messageOf({ id: "c" }), "t")).toBe("full");

        // 占位已回滚：同 msgId 的后续投递仍然算新消息，不会卡在"已受理却永不执行"
        expect(inbox.begin(messageOf({ id: "c" }))).toEqual({ kind: "new" });
        expect(inbox.snapshot("sess-1")).toHaveLength(2);
        expect(MAX_QUEUED_PEER_MESSAGES).toBe(8);
    });

    test("会话之间互不影响：同一个 msgId 在不同会话是两条消息", () => {
        const inbox = new PeerInbox();
        expect(inbox.begin(messageOf({ id: "m", to: "sess-1" }))).toEqual({ kind: "new" });
        expect(inbox.begin(messageOf({ id: "m", to: "sess-2" }))).toEqual({ kind: "new" });
        expect(inbox.enqueue(messageOf({ id: "m", to: "sess-2" }), "t")).toEqual({ position: 1 });
        expect(inbox.begin(messageOf({ id: "m", to: "sess-2" }))).toEqual({ kind: "queued", position: 1 });
    });
});

describe("PeerInbox 幂等", () => {
    test("同 msgId 并发重投：只有第一个拿到 new，其余按已受理应答", () => {
        const inbox = new PeerInbox();

        expect(inbox.begin(messageOf({ id: "m" }))).toEqual({ kind: "new" });
        expect(inbox.begin(messageOf({ id: "m" }))).toEqual({ kind: "accepted" });
        expect(inbox.begin(messageOf({ id: "m" }))).toEqual({ kind: "accepted" });
    });

    test("入队后重投回原位次；出队执行后转为已受理", () => {
        const inbox = new PeerInbox();
        inbox.begin(messageOf({ id: "m" }));
        inbox.enqueue(messageOf({ id: "m" }), "t");
        expect(inbox.begin(messageOf({ id: "m" }))).toEqual({ kind: "queued", position: 1 });

        const entry = inbox.shift("sess-1")!;
        // 已出队但还没标执行：队列里找不到位次，按已受理应答
        expect(inbox.begin(messageOf({ id: "m" }))).toEqual({ kind: "accepted" });

        inbox.markRunning(entry.message);
        expect(inbox.begin(messageOf({ id: "m" }))).toEqual({ kind: "accepted" });
    });

    test("终态结果在缓存里时重投重推结果，不重复执行", () => {
        const inbox = new PeerInbox();
        const message = messageOf({ id: "m", expectResult: true });
        inbox.begin(message);
        const result = resultOf("m");

        inbox.rememberResult(message, result);

        expect(inbox.begin(message)).toEqual({ kind: "replay", result });
    });

    test("没有等待方的终态不缓存结果，重投按新消息处理（宁可重执也不空等）", () => {
        const inbox = new PeerInbox();
        const message = messageOf({ id: "m", expectResult: false });
        inbox.begin(message);
        inbox.rememberResult(message, resultOf("m"));

        expect(inbox.begin(message)).toEqual({ kind: "new" });
    });

    test("结果缓存有上限：最早的被淘汰后重投按新消息处理", () => {
        const inbox = new PeerInbox({ maxCompletedResults: 1 });
        const first = messageOf({ id: "a", expectResult: true });
        const second = messageOf({ id: "b", expectResult: true });
        for (const message of [first, second]) {
            inbox.begin(message);
            inbox.rememberResult(message, resultOf(message.id));
        }

        expect(inbox.begin(second)).toEqual({ kind: "replay", result: resultOf("b") });
        expect(inbox.begin(first)).toEqual({ kind: "new" });
    });

    test("幂等窗口有上限：窗口外的 msgId 不再占用内存，也不会被误判为已受理", () => {
        const inbox = new PeerInbox({ maxSeen: 2 });
        for (const id of ["a", "b", "c"]) inbox.begin(messageOf({ id }));

        // a 已被窗口淘汰：重投按新消息处理，不会永远拿不到结果
        expect(inbox.begin(messageOf({ id: "a" }))).toEqual({ kind: "new" });
        expect(inbox.begin(messageOf({ id: "b" }))).toEqual({ kind: "new" });
    });

    test("rollback 移出队列并清占位：重投按新消息处理", () => {
        const inbox = new PeerInbox();
        const message = messageOf({ id: "m" });
        inbox.begin(message);
        inbox.enqueue(message, "t");

        inbox.rollback(message);

        expect(inbox.sessionIds()).toEqual([]);
        expect(inbox.begin(message)).toEqual({ kind: "new" });
    });
});

describe("PeerInbox 过期与取消", () => {
    test("过期边界：无 expiresAt 或非法时间戳不过期，到点即过期", () => {
        const now = Date.parse("2026-01-01T00:00:10.000Z");
        const inbox = new PeerInbox({ now: () => now });

        expect(inbox.isExpired(messageOf({ id: "a" }))).toBe(false);
        expect(inbox.isExpired(messageOf({ id: "b", expiresAt: "not-a-date" }))).toBe(false);
        expect(inbox.isExpired(messageOf({ id: "c", expiresAt: "2026-01-01T00:00:09.000Z" }))).toBe(true);
        // 恰好到期也算过期（不执行）
        expect(inbox.isExpired(messageOf({ id: "d", expiresAt: "2026-01-01T00:00:10.000Z" }))).toBe(true);
        expect(inbox.isExpired(messageOf({ id: "e", expiresAt: "2026-01-01T00:00:11.000Z" }))).toBe(false);
    });

    test("过期丢弃：生成 expired 终态并出队，同 msgId 重投拿到同一结果", () => {
        const inbox = new PeerInbox();
        const message = messageOf({ id: "m", expectResult: true, expiresAt: "2026-01-01T00:00:00.000Z" });
        inbox.begin(message);
        inbox.enqueue(message, "t");

        const result = inbox.drop(message, "expired");

        expect(result).toEqual({
            msgId: "m",
            ok: false,
            text: "",
            stopReason: "expired",
            error: "排队超时未执行",
        });
        expect(inbox.head("sess-1")).toBeUndefined();
        expect(inbox.begin(message)).toEqual({ kind: "replay", result });
    });

    test("取消：排队中可取消；出队执行后返回 running；未知 msgId 返回 not_found", () => {
        const inbox = new PeerInbox();
        const message = messageOf({ id: "m" });
        inbox.begin(message);
        inbox.enqueue(message, "t");

        expect(inbox.cancel("sess-1", "m")).toEqual({ ok: true, message });
        // 取消即终态：再取消已经没有排队项，也不会误判成 running
        expect(inbox.cancel("sess-1", "m")).toEqual({ ok: false, reason: "not_found" });
        expect(inbox.cancel("sess-1", "ghost")).toEqual({ ok: false, reason: "not_found" });

        const running = messageOf({ id: "r" });
        inbox.begin(running);
        inbox.enqueue(running, "t");
        inbox.shift("sess-1");
        inbox.markRunning(running);
        expect(inbox.cancel("sess-1", "r")).toEqual({ ok: false, reason: "running" });
    });

    test("takeAll 清空队列但保留终态能力：会话释放时逐条按 cancelled 收尾", () => {
        const inbox = new PeerInbox();
        for (const id of ["a", "b"]) {
            const message = messageOf({ id, expectResult: true });
            inbox.begin(message);
            inbox.enqueue(message, "t");
        }

        const taken = inbox.takeAll("sess-1");

        expect(taken.map(entry => entry.message.id)).toEqual(["a", "b"]);
        expect(inbox.sessionIds()).toEqual([]);
        const result = inbox.drop(taken[0]!.message, "cancelled");
        expect(result.stopReason).toBe("cancelled");
        expect(result.error).toBe("排队消息已取消");
        expect(inbox.begin(taken[0]!.message)).toEqual({ kind: "replay", result });
    });

    test("forgetResults 只清目标会话；clear 清空全部状态", () => {
        const inbox = new PeerInbox();
        const mine = messageOf({ id: "a", to: "sess-1", expectResult: true });
        const other = messageOf({ id: "b", to: "sess-2", expectResult: true });
        for (const message of [mine, other]) {
            inbox.begin(message);
            inbox.rememberResult(message, resultOf(message.id));
        }

        inbox.forgetResults("sess-1");
        expect(inbox.begin(mine)).toEqual({ kind: "new" });
        expect(inbox.begin(other)).toEqual({ kind: "replay", result: resultOf("b") });

        inbox.clear();
        expect(inbox.begin(other)).toEqual({ kind: "new" });
        expect(inbox.sessionIds()).toEqual([]);
    });
});
