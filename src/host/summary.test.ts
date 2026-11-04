import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent } from "../events/agent-events.js";
import { EventLog } from "../events/event-log.js";
import type { UsageInfo } from "../types/chat.js";
import { sortSessions } from "../utils/session-order.js";
import { getSessionsDir } from "../utils/runtime-paths.js";
import { sanitizeSessionId } from "../utils/session-id.js";
import type { AgentEventType } from "../events/agent-events.js";
import {
    aggregateInstanceUsage,
    SUMMARY_DECODE_TYPES,
    SUMMARY_PAYLOAD_FIELDS,
    SessionDigestReader,
    summarizeEvents,
} from "./summary.js";

const usageOf = (partial: Partial<UsageInfo> = {}): UsageInfo => ({
    model: "deepseek-v4-flash",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    durationMs: 1000,
    requestCount: 1,
    ...partial,
});

describe("aggregateInstanceUsage", () => {
    test("空输入返回全零", () => {
        expect(aggregateInstanceUsage([])).toEqual({
            sessionCount: 0,
            requestCount: 0,
            promptTokens: 0,
            completionTokens: 0,
            reasoningTokens: 0,
            cacheHitTokens: 0,
            cacheMissTokens: 0,
        });
    });

    test("跳过未发起过网络请求的会话", () => {
        const stats = aggregateInstanceUsage([usageOf(), usageOf({ requestCount: 0 })]);

        expect(stats.sessionCount).toBe(1);
        expect(stats.requestCount).toBe(1);
    });

    test("累加各字段，可选项缺失按 0 计", () => {
        const stats = aggregateInstanceUsage([
            usageOf({ requestCount: 2, promptTokens: 10, completionTokens: 5, cacheHitTokens: 3, cacheMissTokens: 7 }),
            usageOf({ requestCount: 1, promptTokens: 20, completionTokens: 8, reasoningTokens: 4 }),
        ]);

        expect(stats).toEqual({
            sessionCount: 2,
            requestCount: 3,
            promptTokens: 30,
            completionTokens: 13,
            reasoningTokens: 4,
            cacheHitTokens: 3,
            cacheMissTokens: 7,
        });
    });
});

describe("summarizeEvents 会话更新时间", () => {
    const at = (minute: number): string => `2026-09-10T10:${String(minute).padStart(2, "0")}:00.000Z`;
    const eventOf = (type: string, ts: string, payload: Record<string, unknown> = {}): AgentEvent =>
        ({ type, seq: 1, ts, sessionId: "s", payload } as unknown as AgentEvent);
    const created = (minute: number): AgentEvent => eventOf("session_created", at(minute), { cwd: "/tmp" });
    /** 群聊状态更新注入：落在事件日志里，但不是用户活动。 */
    const injected = (minute: number): AgentEvent =>
        eventOf("standalone_turn", at(minute), { messages: [{ role: "system", content: "[群聊状态更新：已加入群]" }], injected: true });

    test("自动注入的群聊状态不顶掉 updatedAt（否则闲置会话被挤到 tab 条最前）", () => {
        const summary = summarizeEvents("s", [
            created(0),
            eventOf("user_message", at(5), { text: "你好", turnId: "t1", trigger: "user" }),
            injected(30),
            injected(31),
        ]);

        expect(summary.updatedAt).toBe(at(5));
        expect(summary.messageCount).toBe(0);
    });

    test("旧事件（没有 injected 标记）按内容兜底识别，同样不顶掉 updatedAt", () => {
        const legacyInjection: AgentEvent = eventOf("standalone_turn", at(40), {
            messages: [{ role: "system", content: "[群聊状态更新：已加入群]\n你现在以 agent 身份「s」参与群聊，已加入：#general。" }],
        });
        const summary = summarizeEvents("s", [
            created(0),
            eventOf("user_message", at(5), { text: "你好", turnId: "t1", trigger: "user" }),
            legacyInjection,
        ]);

        expect(summary.updatedAt).toBe(at(5));
    });

    test("只有 system 消息但不是群聊状态更新的独立回合仍计入更新时间", () => {
        const summary = summarizeEvents("s", [
            created(0),
            eventOf("standalone_turn", at(40), { messages: [{ role: "system", content: "系统提示" }] }),
        ]);

        expect(summary.updatedAt).toBe(at(40));
    });

    test("真实的独立回合仍计入更新时间", () => {
        const summary = summarizeEvents("s", [
            created(0),
            eventOf("standalone_turn", at(30), { messages: [{ role: "assistant", content: "图片内容" }] }),
        ]);

        expect(summary.updatedAt).toBe(at(30));
    });

    test("日志里只有建会话 + 注入时，updatedAt 取建会话时间（不会掉进\"未落盘优先\"那一档）", () => {
        const summary = summarizeEvents("s", [created(0), injected(20)]);

        expect(summary.updatedAt).toBe(at(0));
    });

    test("摘要带出会话的工作目录（面板目录列的数据来源）", () => {
        const summary = summarizeEvents("s", [created(0), eventOf("user_message", at(5), { text: "你好", turnId: "t1", trigger: "user" })]);

        expect(summary.cwd).toBe("/tmp");
    });

    test("旧事件没有 cwd 字段时摘要不带 cwd（面板留空列，由宿主回退）", () => {
        const summary = summarizeEvents("s", [eventOf("session_created", at(0), {})]);

        expect(summary.cwd).toBeUndefined();
    });

    test("cwd 变更事件覆盖 session_created 的目录（面板显示最新目录）", () => {
        const summary = summarizeEvents("s", [
            eventOf("session_created", at(0), { cwd: "/tmp" }),
            eventOf("session_cwd_changed", at(10), { cwd: "/opt/work" }),
        ]);

        expect(summary.cwd).toBe("/opt/work");
    });

    test("来源取自 session_created；老日志没有该字段时摘要不带 origin", () => {
        expect(summarizeEvents("s", [eventOf("session_created", at(0), { cwd: "/tmp", origin: "job" })]).origin).toBe("job");
        expect(summarizeEvents("s", [eventOf("session_created", at(0), { cwd: "/tmp" })]).origin).toBeUndefined();
    });

    test("注水多但无用户活动的会话不会排到活跃会话前面", () => {
        const idle = summarizeEvents("idle", [created(0), injected(50), injected(55)]);
        const active = summarizeEvents("active", [created(0), eventOf("user_message", at(30), { text: "在跑", turnId: "t1", trigger: "user" })]);

        expect(sortSessions([idle, active]).map(session => session.sessionId)).toEqual(["active", "idle"]);
    });
});

describe("SessionDigestReader 缓存", () => {
    const reader0 = (log: EventLog): SessionDigestReader => new SessionDigestReader(log);

    let tmpDir: string;
    let savedStateDir: string | undefined;
    let savedTuiCwd: string | undefined;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-digest-"));
        savedStateDir = process.env.ZBOT_STATE_DIR;
        savedTuiCwd = process.env.TUI_CWD;
        process.env.ZBOT_STATE_DIR = tmpDir;
        process.env.TUI_CWD = tmpDir;
    });

    afterAll(() => {
        if (savedStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
        else process.env.ZBOT_STATE_DIR = savedStateDir;
        if (savedTuiCwd === undefined) delete process.env.TUI_CWD;
        else process.env.TUI_CWD = savedTuiCwd;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /** 计数包装：缓存命中时不应再触发一次事件日志读取（轻量扫描或回退的全量读取）。 */
    function countReads(log: EventLog): { reads: () => number } {
        const originalScan = log.scan.bind(log);
        const originalRead = log.read.bind(log);
        let count = 0;
        log.scan = (async (...args: Parameters<EventLog["scan"]>) => {
            count += 1;
            return originalScan(...args);
        }) as EventLog["scan"];
        log.read = (async (...args: Parameters<EventLog["read"]>) => {
            count += 1;
            return originalRead(...args);
        }) as EventLog["read"];
        return { reads: () => count };
    }

    test("seq 未变时复用缓存，不再读事件日志", async () => {
        const log = new EventLog();
        const sessionId = "01DIGESTCACHE000000000000AA";
        await log.append(sessionId, "session_created", { cwd: tmpDir });
        const reader = new SessionDigestReader(log);
        const counter = countReads(log);

        const first = await reader.read(sessionId);
        const second = await reader.read(sessionId);

        expect(first?.summary.sessionId).toBe(sessionId);
        expect(second).toEqual(first);
        expect(counter.reads()).toBe(1);
    });

    test("追加事件后 seq 变化，摘要跟着更新", async () => {
        const log = new EventLog();
        const sessionId = "01DIGESTINVALIDATE0000000AA";
        await log.append(sessionId, "session_created", { cwd: tmpDir });
        const reader = new SessionDigestReader(log);

        expect((await reader.read(sessionId))?.summary.title).toBeUndefined();
        await log.append(sessionId, "session_renamed", { title: "改名后的标题" });

        const updated = await reader.read(sessionId);
        expect(updated?.summary.title).toBe("改名后的标题");
        expect(updated?.createdAt).toBeDefined();
    });

    test("日志被截断后不会返回截断前的摘要", async () => {
        const log = new EventLog();
        const sessionId = "01DIGESTTRUNCATE00000000AA";
        const created = await log.append(sessionId, "session_created", { cwd: tmpDir });
        await log.append(sessionId, "session_renamed", { title: "将来的标题" });
        const reader = new SessionDigestReader(log);
        expect((await reader.read(sessionId))?.summary.title).toBe("将来的标题");

        await log.truncate(sessionId, created.seq);

        expect((await reader.read(sessionId))?.summary.title).toBeUndefined();
    });

    test("pending 流片段不进摘要：缓存命中与未命中同源", async () => {
        const log = new EventLog();
        const sessionId = "01DIGESTSTREAM0000000000AA";
        await log.append(sessionId, "session_created", { cwd: tmpDir });
        await log.append(sessionId, "user_message", { text: "在跑", turnId: "T1", trigger: "user" });
        // 与上一条持久化事件岔开时间戳，才能看出摘要取的是哪一方的 ts
        await Bun.sleep(10);
        await log.appendStreamDelta(sessionId, "T1", 0, { text: "流式片段" });

        // 前提：宽松读取确实把 pending 片段并了进来，且它的 ts 更晚（会改写 updatedAt）
        const lenient = await log.read(sessionId);
        const persisted = await log.read(sessionId, 1, undefined, { persistedOnly: true });
        expect(lenient.at(-1)?.type).toBe("turn_stream_delta");
        expect(lenient.at(-1)?.ts).not.toBe(persisted.at(-1)?.ts);

        const digest = await reader0(log).read(sessionId);
        expect(digest?.summary.updatedAt).toBe(persisted.at(-1)?.ts);
        expect(summarizeEvents(sessionId, lenient).updatedAt).toBe(lenient.at(-1)?.ts);
    });

    test("只有流片段变化时摘要保持不变，持久化事件仍能刷新", async () => {
        const log = new EventLog();
        const sessionId = "01DIGESTSTREAMCACHE000000AA";
        await log.append(sessionId, "session_created", { cwd: tmpDir });
        const reader = new SessionDigestReader(log);
        const before = await reader.read(sessionId);

        await log.appendStreamDelta(sessionId, "T1", 0, { text: "还在流" });

        expect(await reader.read(sessionId)).toEqual(before);

        await log.append(sessionId, "session_renamed", { title: "流完改名" });
        expect((await reader.read(sessionId))?.summary.title).toBe("流完改名");
    });

    test("没有任何事件的会话返回 null", async () => {
        const reader = new SessionDigestReader(new EventLog());

        expect(await reader.read("01DIGESTEMPTY00000000000AA")).toBeNull();
    });

    test("clear 后重新解析磁盘", async () => {
        const log = new EventLog();
        const sessionId = "01DIGESTCLEAR00000000000AA";
        await log.append(sessionId, "session_created", { cwd: tmpDir });
        const reader = new SessionDigestReader(log);
        const counter = countReads(log);

        await reader.read(sessionId);
        reader.clear(sessionId);
        await reader.read(sessionId);

        expect(counter.reads()).toBe(2);
    });
});

describe("轻量扫描摘要", () => {
    let tmpDir: string;
    let savedStateDir: string | undefined;
    let savedTuiCwd: string | undefined;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-scan-digest-"));
        savedStateDir = process.env.ZBOT_STATE_DIR;
        savedTuiCwd = process.env.TUI_CWD;
        process.env.ZBOT_STATE_DIR = tmpDir;
        process.env.TUI_CWD = tmpDir;
    });

    afterAll(() => {
        if (savedStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
        else process.env.ZBOT_STATE_DIR = savedStateDir;
        if (savedTuiCwd === undefined) delete process.env.TUI_CWD;
        else process.env.TUI_CWD = savedTuiCwd;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /** 全量读取（persistedOnly）得到的摘要：轻量扫描必须与之逐字段相等。 */
    async function fullDigest(log: EventLog, sessionId: string): Promise<unknown> {
        const events = await log.read(sessionId, 1, undefined, { persistedOnly: true });
        if (events.length === 0) return null;
        return { summary: summarizeEvents(sessionId, events), ...(events[0] ? { createdAt: events[0].ts } : {}) };
    }

    /** 造一份"各类事件都有"的日志：标题、改名、归档、模型、cwd、注水、peer、大 payload 噪音。 */
    async function seedRichLog(log: EventLog, sessionId: string): Promise<void> {
        await log.append(sessionId, "session_created", { cwd: tmpDir, origin: "job" });
        await log.append(sessionId, "user_message", { text: "第一条用户消息", turnId: "T1", trigger: "user" });
        await log.append(sessionId, "turn_message", {
            turnId: "T1",
            messages: [{ role: "assistant", content: "x".repeat(5000) }],
        } as any);
        await log.append(sessionId, "turn_segment_start", { turnId: "T1", requestIndex: 1 } as any);
        await log.append(sessionId, "standalone_turn", {
            turnId: "T2",
            messages: [{ role: "system", content: "[群聊状态更新] 有人在等" }],
            injected: false,
        } as any);
        await log.append(sessionId, "turn_commit", {
            turnId: "T1",
            events: [3],
            userMessages: ["第一条用户消息"],
            stopReason: "stop",
            usage: { model: "m", promptTokens: 1, completionTokens: 1, totalTokens: 2, durationMs: 1 },
            interrupted: false,
        } as any);
        await log.append(sessionId, "peer_message", { msgId: "m1", direction: "in", from: "other", text: "你好" } as any);
        await log.append(sessionId, "model_selected", { protocol: "responses", model: "gpt-x" } as any);
        await log.append(sessionId, "session_cwd_changed", { cwd: "/opt/work" });
        await log.append(sessionId, "turn_commit", {
            turnId: "T3",
            events: [],
            userMessages: ["被打断"],
            stopReason: "abort",
            usage: { model: "m", promptTokens: 1, completionTokens: 1, totalTokens: 2, durationMs: 1 },
            interrupted: true,
        } as any);
        await log.append(sessionId, "session_archived", {});
        await log.append(sessionId, "session_unarchived", {});
        await log.append(sessionId, "session_renamed", { title: "改名后的标题" });
    }

    test("各类事件齐备时，轻量扫描摘要与全量读取逐字段相等", async () => {
        const log = new EventLog();
        const sessionId = "01SCANDIGESTEQUIV00000000AA";
        await seedRichLog(log, sessionId);

        const digest = await new SessionDigestReader(log).read(sessionId);

        expect(digest).toEqual(await fullDigest(log, sessionId));
    });

    test("行首形状不认识时回退全量读取，摘要不缺字段", async () => {
        const log = new EventLog();
        const sessionId = "01SCANDIGESTFALLBACK0000AA";
        await log.append(sessionId, "session_created", { cwd: tmpDir });
        const file = path.join(getSessionsDir("events"), `${sanitizeSessionId(sessionId)}.jsonl`);
        // 键序与 append 不同：扫描会放弃，全量读取仍然读得到
        fs.appendFileSync(file, `${JSON.stringify({
            type: "session_renamed",
            payload: { title: "乱序写入的标题" },
            seq: 2,
            ts: "2026-01-01T00:00:02.000Z",
            sessionId,
        })}\n`, "utf8");

        const digest = await new SessionDigestReader(log).read(sessionId);

        expect(digest?.summary.title).toBe("乱序写入的标题");
        expect(digest).toEqual(await fullDigest(log, sessionId));
    });

    test("半行日志不参与摘要：与全量读取一致地跳过", async () => {
        const log = new EventLog();
        const sessionId = "01SCANDIGESTHALFLINE0000AA";
        await log.append(sessionId, "session_created", { cwd: tmpDir });
        await log.append(sessionId, "session_renamed", { title: "完整行" });
        const file = path.join(getSessionsDir("events"), `${sanitizeSessionId(sessionId)}.jsonl`);
        fs.appendFileSync(file, '{"seq":3,"ts":"2026-01-01T00:00:03.000Z","sessionId":"x","type":"session_renamed","payload":{"title":"半', "utf8");

        const digest = await new SessionDigestReader(log).read(sessionId);

        expect(digest?.summary.title).toBe("完整行");
        expect(digest?.createdAt).toBeDefined();
    });

    test("降解析量：200 条大事件只读行首，不做整行 JSON.parse", async () => {
        const log = new EventLog();
        const sessionId = "01SCANDIGESTLIGHTCOST0000AA";
        await log.append(sessionId, "session_created", { cwd: tmpDir });
        for (let index = 0; index < 200; index += 1) {
            await log.append(sessionId, "turn_message", {
                turnId: `T${index}`,
                messages: [{ role: "assistant", content: "x".repeat(5000) }],
            } as any);
        }
        await log.append(sessionId, "session_renamed", { title: "轻扫结果" });

        const realParse = JSON.parse;
        let parses = 0;
        (JSON as { parse: typeof JSON.parse }).parse = ((text: string, reviver?: any) => {
            parses += 1;
            return realParse(text, reviver);
        }) as typeof JSON.parse;
        let digestTitle: string | undefined;
        try {
            digestTitle = (await new SessionDigestReader(log).read(sessionId))?.summary.title;
        } finally {
            (JSON as { parse: typeof JSON.parse }).parse = realParse;
        }

        expect(digestTitle).toBe("轻扫结果");
        // 202 行里只有 2 条在解码集合内（session_created / session_renamed）
        expect(parses).toBeLessThanOrEqual(4);
    });

    /**
     * 每个事件类型都过一遍：声明"不读 payload"的类型，payload 一被访问就抛错。
     * 类型全集来自 SUMMARY_PAYLOAD_FIELDS（源侧用 Record<AgentEventType, …> 编译期穷举），
     * 因此新增事件类型不会漏测。
     */
    test("声明为不读 payload 的事件类型，摘要确实不碰 payload", () => {
        const types = Object.keys(SUMMARY_PAYLOAD_FIELDS) as AgentEventType[];
        expect(types.length).toBeGreaterThan(0);

        for (const type of types) {
            const event = {
                seq: 1,
                ts: "2026-01-01T00:00:00.000Z",
                sessionId: "s",
                type,
                payload: SUMMARY_DECODE_TYPES.has(type) ? SAFE_PAYLOAD : guardedPayload(type),
            } as unknown as AgentEvent;
            expect(() => summarizeEvents("s", [event])).not.toThrow();
        }
    });
});

/** 已声明解码类型的 payload：字段齐全，避免 summarizeEvents 内部取值报错。 */
const SAFE_PAYLOAD = {
    text: "x",
    title: "t",
    cwd: "/tmp",
    interrupted: false,
    messages: [],
    injected: false,
};

/**
 * 未声明解码类型的 payload：任何属性访问都抛错。
 * 于是「摘要偷偷读了某个未解码类型的 payload」会立刻失败，而不是在真机上静默少字段。
 */
function guardedPayload(type: string): unknown {
    const trap = (action: string) => () => {
        throw new Error(`摘要读了未解码类型的 payload.${action}（type=${type}）`);
    };
    return new Proxy({}, {
        get: (_target, key) => trap(String(key))(),
        has: () => trap("has")(),
        ownKeys: () => trap("ownKeys")(),
    });
}
