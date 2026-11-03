import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { EventLog } from "./event-log.js";
import { SessionReplay, createEmptySession } from "./session-replay.js";
import type { ChatMessage } from "../types/session.js";
import type { UsageInfo } from "../types/chat.js";
import { getSessionContextHistory } from "../utils/conversation-history.js";

let tmpDir: string;
let savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-events-"));
    // 隔离会话存储：宿主环境可能注入 ZBOT_STATE_DIR/TUI_CWD，统一指向临时目录避免写到真实会话目录。
    savedEnv = {
        ZBOT_STATE_DIR: process.env.ZBOT_STATE_DIR,
        TUI_CWD: process.env.TUI_CWD,
    };
    process.env.ZBOT_STATE_DIR = tmpDir;
    // 工具目录同样指向临时目录：会话 cwd 缺失时 getToolCwd() 的回退值才可预期
    process.env.TUI_CWD = tmpDir;
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
});

function usage(): UsageInfo {
    return { model: "m", promptTokens: 1, completionTokens: 1, totalTokens: 2, durationMs: 1 };
}

let turnCounter = 0;

/** 落盘一个完整回合：user_message + turn_message（逐条）+ turn_commit。 */
async function appendTurn(
    log: EventLog,
    sessionId: string,
    payload: {
        turnId?: string;
        userMessages?: string[];
        messages?: ChatMessage[];
        stopReason?: string;
        usage?: UsageInfo;
        interrupted?: boolean;
    },
): Promise<string> {
    turnCounter += 1;
    const turnId = payload.turnId ?? `T${turnCounter}`;
    for (const text of payload.userMessages ?? []) {
        await log.append(sessionId, "user_message", { text, turnId });
    }
    const seqs: number[] = [];
    for (const message of payload.messages ?? []) {
        const event = await log.append(sessionId, "turn_message", { turnId, message });
        seqs.push(event.seq);
    }
    await log.append(sessionId, "turn_commit", {
        turnId,
        events: seqs,
        userMessages: payload.userMessages ?? [],
        stopReason: payload.stopReason ?? "stop",
        usage: payload.usage ?? usage(),
        interrupted: payload.interrupted === true,
    });
    return turnId;
}

describe("EventLog", () => {
    it("重放历史修复事件后移除空助手消息并保留有效工具调用", async () => {
        const log = new EventLog();
        const sessionId = "repair-empty-assistant";
        await appendTurn(log, sessionId, {
            userMessages: ["问题"],
            messages: [
                { role: "assistant", content: null, reasoning_content: "思考" },
                { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }] },
                { role: "tool", tool_call_id: "call-1", content: "结果" },
            ],
        });
        await log.append(sessionId, "assistant_history_repaired", {});

        const { session } = await new SessionReplay(log).replayTo(sessionId);
        const assistants = session.turns[0]?.messages.filter(message => message.role === "assistant") ?? [];
        expect(assistants).toHaveLength(1);
        expect(assistants[0]?.tool_calls).toHaveLength(1);
        expect(getSessionContextHistory(session).some(message => message.role === "assistant" && !message.content && !message.tool_calls?.length)).toBe(false);
    });

    it("重放压缩边界时按持久化位置恢复保留消息", async () => {
        const log = new EventLog();
        const sessionId = "sess-compact-position";
        await log.append(sessionId, "session_created", { cwd: tmpDir });
        await appendTurn(log, sessionId, { userMessages: ["旧问题"], messages: [{ role: "assistant", content: "旧回答" }] });
        await appendTurn(log, sessionId, { userMessages: ["保留问题"], messages: [{ role: "assistant", content: "保留回答" }] });
        await log.append(sessionId, "context_compacted", {
            compactedContext: "摘要",
            keepFromMessageId: "重启前的消息 ID",
            keepFromPosition: { turnIndex: 1, messageIndex: 1 },
        });
        await appendTurn(log, sessionId, { userMessages: ["新问题"], messages: [{ role: "assistant", content: "新回答" }] });

        const replay = new SessionReplay(log);
        const first = await replay.replayTo(sessionId);
        const second = await replay.replayTo(sessionId);
        const expected = ["<conversation_summary", "已确认上述历史上下文", "保留回答", "新问题", "新回答"];
        for (const { session } of [first, second]) {
            const contents = getSessionContextHistory(session).map(message => String(message.content));
            expect(contents).toHaveLength(expected.length);
            for (const [index, prefix] of expected.entries()) {
                expect(contents[index]).toContain(prefix);
            }
            expect(contents.join("\n")).not.toContain("旧问题");
        }
    });

    it("回合内压缩：摘要折叠旧回合，并丢弃本回合压缩前的消息", async () => {
        const log = new EventLog();
        const sessionId = "sess-turn-compact";
        await log.append(sessionId, "session_created", { cwd: tmpDir });
        await appendTurn(log, sessionId, { userMessages: ["旧问题"], messages: [{ role: "assistant", content: "旧回答" }] });

        // 本回合：先产生一条将被摘要吸收的消息，压缩，再产生新消息
        const turnId = "T-turn-compact";
        await log.append(sessionId, "user_message", { text: "新问题", turnId });
        const absorbed = await log.append(sessionId, "turn_message", {
            turnId,
            message: { role: "assistant", content: "压缩前的中间输出" },
        });
        await log.append(sessionId, "context_compacted", {
            compactedContext: "本轮摘要",
            scope: "turn",
            turnId,
        });
        const kept = await log.append(sessionId, "turn_message", {
            turnId,
            message: { role: "assistant", content: "压缩后的最终输出" },
        });
        await log.append(sessionId, "turn_commit", {
            turnId,
            events: [absorbed.seq, kept.seq],
            userMessages: ["新问题"],
            stopReason: "stop",
            usage: usage(),
            interrupted: false,
        });

        const { session } = await new SessionReplay(log).replayTo(sessionId);
        const contents = getSessionContextHistory(session).map(message => String(message.content));
        expect(contents.join("\n")).toContain("本轮摘要");
        expect(contents.join("\n")).toContain("压缩后的最终输出");
        // 压缩前的消息属于被摘要吸收的范围，重放后不能回涨
        expect(contents.join("\n")).not.toContain("压缩前的中间输出");
        expect(contents.join("\n")).not.toContain("旧回答");
    });

    it("旧压缩事件的消息 ID 失效时保留压缩后的回合", async () => {
        const log = new EventLog();
        const sessionId = "sess-compact-legacy";
        await log.append(sessionId, "session_created", { cwd: tmpDir });
        await appendTurn(log, sessionId, { userMessages: ["旧问题"], messages: [{ role: "assistant", content: "旧回答" }] });
        await log.append(sessionId, "context_compacted", {
            compactedContext: "摘要",
            keepFromMessageId: "已失效的消息 ID",
        });
        await appendTurn(log, sessionId, { userMessages: ["新问题"], messages: [{ role: "assistant", content: "新回答" }] });

        const { session } = await new SessionReplay(log).replayTo(sessionId);
        const contents = getSessionContextHistory(session).map(message => String(message.content));
        expect(contents).toHaveLength(4);
        expect(contents[2]).toBe("新问题");
        expect(contents[3]).toBe("新回答");
    });

    it("append seq 递增，read 支持 fromSeq/limit", async () => {
        const log = new EventLog();
        const sessionId = "sess-1";

        const first = await log.append(sessionId, "session_created", {});
        const second = await log.append(sessionId, "user_message", { text: "hi", turnId: "T1", trigger: "user" });
        expect(first.seq).toBe(1);
        expect(second.seq).toBe(2);

        const all = await log.read(sessionId);
        expect(all).toHaveLength(2);
        expect(all[1].payload).toEqual({ text: "hi", turnId: "T1", trigger: "user" });

        const tail = await log.read(sessionId, 2);
        expect(tail).toHaveLength(1);
        expect(tail[0].seq).toBe(2);
    });

    it("重放重建 Session（turn_commit → appendCompletedTurn 投影）", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-2";

        await log.append(sessionId, "session_created", {});
        await appendTurn(log, sessionId, {
            turnId: "T1",
            userMessages: ["hi"],
            messages: [{ role: "assistant", content: "hello" } as ChatMessage],
        });

        const result = await replay.replayTo(sessionId);
        expect(result.lastSeq).toBe(4);
        expect(result.session.turns).toHaveLength(1);
        expect(result.session.turns[0].messages[0]).toMatchObject({ role: "user", content: "hi" });
        expect(result.session.turns[0].messages[1]).toMatchObject({ role: "assistant", content: "hello" });
    });

    it("interrupted 回合物化为 interrupted turn，同时保留在日志", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-3";

        await appendTurn(log, sessionId, {
            turnId: "T1",
            userMessages: ["hi"],
            messages: [{ role: "assistant", content: "partial" } as ChatMessage],
            stopReason: "aborted",
            usage: usage(),
            interrupted: true,
        });

        const result = await replay.replayTo(sessionId);
        expect(result.session.turns).toHaveLength(1);
        expect(result.session.turns[0].status).toBe("interrupted");
        expect(result.session.turns[0].messages[0]).toMatchObject({ role: "user", content: "hi" });
        expect(result.session.turns[0].messages[1]).toMatchObject({ role: "assistant", content: "partial" });
        expect((await log.read(sessionId))).toHaveLength(3);
    });

    it("重放保留较早未闭合回合的完整消息", async () => {
        const log = new EventLog();
        const sessionId = "sess-orphan-partials";
        await log.append(sessionId, "user_message", { text: "第一个问题", turnId: "T1", trigger: "user" });
        await log.append(sessionId, "turn_message", { turnId: "T1", message: { role: "assistant", content: "第一段输出" } });
        await appendTurn(log, sessionId, {
            turnId: "T2",
            userMessages: ["第二个问题"],
            messages: [{ role: "assistant", content: "第二段输出" }],
        });

        const { session } = await new SessionReplay(log).replayTo(sessionId);
        expect(session.turns.map(turn => turn.status)).toEqual(["interrupted", "completed"]);
        expect(session.turns[0]?.messages.map(message => message.content)).toEqual(["第一个问题", "第一段输出"]);
        expect(getSessionContextHistory(session).map(message => message.content)).toEqual([
            "第一个问题", "第一段输出", "第二个问题", "第二段输出",
        ]);
    });

    it("重放保留所有未闭合回合", async () => {
        const log = new EventLog();
        const sessionId = "sess-two-orphans";
        for (const turnId of ["T1", "T2"]) {
            await log.append(sessionId, "user_message", { text: turnId, turnId, trigger: "user" });
            await log.append(sessionId, "turn_message", { turnId, message: { role: "assistant", content: `${turnId} 输出` } });
        }

        const { session } = await new SessionReplay(log).replayTo(sessionId);
        expect(session.turns.map(turn => turn.messages.map(message => message.content))).toEqual([
            ["T1", "T1 输出"],
            ["T2", "T2 输出"],
        ]);
    });

    it("异常退出后从流式检查点恢复文字、思考与未完成工具参数", async () => {
        const log = new EventLog();
        const sessionId = "sess-stream-crash";
        const turnId = "T1";
        await log.append(sessionId, "user_message", { text: "查资料", turnId, trigger: "user" });
        await log.append(sessionId, "turn_stream_delta", { turnId, requestIndex: 1, delta: { text: "已找到" } });
        await log.append(sessionId, "turn_stream_delta", { turnId, requestIndex: 1, delta: { reasoning: "先检查" } });
        await log.append(sessionId, "turn_stream_delta", {
            turnId,
            requestIndex: 1,
            delta: { toolCalls: [{ index: 0, name: "search", arguments: '{"q":' }] },
        });

        const { session } = await new SessionReplay(log).replayTo(sessionId);
        expect(session.turns[0]?.status).toBe("interrupted");
        const partial = getSessionContextHistory(session)[1] as Extract<ChatMessage, { role: "assistant" }>;
        expect(partial.content).toContain("已找到");
        expect(partial.content).toContain('"q"');
        expect(partial.reasoning_content).toBe("先检查");
        expect(partial.tool_calls).toBeUndefined();
    });

    it("完整消息落盘后不重复恢复流式片段", async () => {
        const log = new EventLog();
        const sessionId = "sess-stream-complete";
        const turnId = "T1";
        await log.append(sessionId, "user_message", { text: "问题", turnId, trigger: "user" });
        await log.append(sessionId, "turn_stream_delta", { turnId, requestIndex: 1, delta: { text: "部分" } });
        await log.append(sessionId, "turn_message", { turnId, message: { role: "assistant", content: "完整答复" } });

        const { session } = await new SessionReplay(log).replayTo(sessionId);
        expect(getSessionContextHistory(session).map(message => message.content)).toEqual(["问题", "完整答复"]);
    });

    it("快照 + 增量重放（回合闭合的第 100 个事件写快照）", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-4";

        // session_created + 33 个完整回合（每回合 3 事件）= 100 个事件，第 100 个正好是 turn_commit
        await log.append(sessionId, "session_created", {});
        for (let index = 0; index < 33; index += 1) {
            await appendTurn(log, sessionId, {
                turnId: `T${index}`,
                userMessages: [`msg-${index}`],
                messages: [{ role: "assistant", content: `reply-${index}` } as ChatMessage],
            });
        }

        const snapshotSession = (await replay.replayTo(sessionId)).session;
        await replay.writeSnapshotIfDue(sessionId, snapshotSession);
        expect(fs.existsSync(path.join(tmpDir, "sessions", "events", "sess-4.snapshot.json"))).toBe(true);

        await appendTurn(log, sessionId, {
            turnId: "T-final",
            userMessages: ["final"],
            messages: [{ role: "assistant", content: "done" } as ChatMessage],
        });

        const result = await replay.replayTo(sessionId);
        expect(result.lastSeq).toBe(103);
        expect(result.session.turns).toHaveLength(34);
        expect(result.session.turns.at(-1)?.messages[1]).toMatchObject({ role: "assistant", content: "done" });
    });

    it("快照按距上次快照的增量写，不要求 seq 整除间隔", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-snapshot-delta";

        // 40 个完整回合 = 120 个事件，落点不整除 SNAPSHOT_INTERVAL
        await log.append(sessionId, "session_created", {});
        for (let index = 0; index < 40; index += 1) {
            await appendTurn(log, sessionId, {
                turnId: `D${index}`,
                userMessages: [`msg-${index}`],
                messages: [{ role: "assistant", content: `reply-${index}` } as ChatMessage],
            });
        }

        const session = (await replay.replayTo(sessionId)).session;
        await replay.writeSnapshotIfDue(sessionId, session);

        const snapshotPath = path.join(tmpDir, "sessions", "events", `${sessionId}.snapshot.json`);
        expect(fs.existsSync(snapshotPath)).toBe(true);
        const raw = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
        expect(raw.lastSeq).toBe(121);
        expect(raw.lastSeq % 100).not.toBe(0);
    });

    it("距上次快照不足间隔、或尾部不是安全事件时不写快照", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-snapshot-unsafe-tail";
        const snapshotPath = path.join(tmpDir, "sessions", "events", `${sessionId}.snapshot.json`);

        await appendTurn(log, sessionId, { turnId: "U1", userMessages: ["a"], messages: [{ role: "assistant", content: "b" } as ChatMessage] });
        const early = (await replay.replayTo(sessionId)).session;
        await replay.writeSnapshotIfDue(sessionId, early);
        expect(fs.existsSync(snapshotPath)).toBe(false);

        // 累计到超过间隔，但尾巴停在 user_message（回合未闭合）上
        for (let index = 0; index < 40; index += 1) {
            await appendTurn(log, sessionId, {
                turnId: `U-${index}`,
                userMessages: [`msg-${index}`],
                messages: [{ role: "assistant", content: `reply-${index}` } as ChatMessage],
            });
        }
        await log.append(sessionId, "user_message", { text: "未闭合", turnId: "U-open" });
        const open = (await replay.replayTo(sessionId)).session;
        await replay.writeSnapshotIfDue(sessionId, open);
        expect(fs.existsSync(snapshotPath)).toBe(false);

        // 回合闭合后补写
        await log.append(sessionId, "turn_commit", {
            turnId: "U-open",
            events: [],
            userMessages: ["未闭合"],
            stopReason: "stop",
            usage: usage(),
            interrupted: false,
        });
        const closed = (await replay.replayTo(sessionId)).session;
        await replay.writeSnapshotIfDue(sessionId, closed);
        expect(fs.existsSync(snapshotPath)).toBe(true);
    });

    it("快照只写会话事实：system prompt 与工具定义不落盘", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-snapshot-whitelist";

        await log.append(sessionId, "session_created", {});
        for (let index = 0; index < 33; index += 1) {
            await appendTurn(log, sessionId, {
                turnId: `W${index}`,
                userMessages: [`msg-${index}`],
                messages: [{ role: "assistant", content: `reply-${index}` } as ChatMessage],
            });
        }

        const session = (await replay.replayTo(sessionId)).session;
        // 模拟运行时内容混入：system prompt 缓存与工具定义都不该进快照
        (session as any).cachedSystemPrompt = "旧 system prompt";
        (session as any).cachedSystemPromptCwd = "/old/cwd";
        (session as any).tools = [{ type: "function", function: { name: "bash" } }];
        await replay.writeSnapshotIfDue(sessionId, session);

        const snapshotPath = path.join(tmpDir, "sessions", "events", `${sessionId}.snapshot.json`);
        const raw = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
        expect(raw.session.sessionId).toBe(sessionId);
        expect(Array.isArray(raw.session.turns)).toBe(true);
        expect(raw.session.cachedSystemPrompt).toBeUndefined();
        expect(raw.session.cachedSystemPromptCwd).toBeUndefined();
        expect(raw.session.tools).toBeUndefined();
    });

    it("旧快照里的 system prompt 缓存字段在重放时被丢弃", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-legacy-snapshot";

        await log.append(sessionId, "session_created", {});
        await appendTurn(log, sessionId, {
            turnId: "L1",
            userMessages: ["hello"],
            messages: [{ role: "assistant", content: "hi" } as ChatMessage],
        });

        const snapshotPath = path.join(tmpDir, "sessions", "events", `${sessionId}.snapshot.json`);
        fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
        fs.writeFileSync(snapshotPath, JSON.stringify({
            lastSeq: 1,
            ts: new Date().toISOString(),
            session: {
                ...createEmptySession(sessionId),
                cachedSystemPrompt: "旧缓存 prompt",
                cachedSystemPromptIncludesMemory: false,
                cachedSystemPromptCwd: "/legacy/cwd",
                cachedSystemPromptRuntimeFingerprint: "legacy",
                sentSkillsMtime: { alpha: 1 },
            },
        }), "utf8");

        const replayed = await replay.replayTo(sessionId);
        const restored = replayed.session as Record<string, unknown>;
        expect(replayed.session.turns).toHaveLength(1);
        expect(restored.cachedSystemPrompt).toBeUndefined();
        expect(restored.cachedSystemPromptCwd).toBeUndefined();
        expect(restored.cachedSystemPromptRuntimeFingerprint).toBeUndefined();
        expect(restored.sentSkillsMtime).toBeUndefined();
    });

    it("turn 进行中（最后事件为 user_message）不写快照，避免该用户消息被排除在重放之外", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-mid-turn";

        await log.append(sessionId, "session_created", {});
        for (let index = 0; index < 98; index += 1) {
            await log.append(sessionId, "user_message", { text: `msg-${index}`, turnId: "T-pending", trigger: "user" });
        }
        // 第 100 个事件是 user_message：请求已发出但 turn_commit 未落盘
        await log.append(sessionId, "user_message", { text: "进行中", turnId: "T-pending", trigger: "user" });

        const session = (await replay.replayTo(sessionId)).session;
        await replay.writeSnapshotIfDue(sessionId, session);
        expect(fs.existsSync(path.join(tmpDir, "sessions", "events", "sess-mid-turn.snapshot.json"))).toBe(false);

        // 进程被强杀：仅剩 user_message，重放时物化为 interrupted 回合，上下文不丢
        const result = await replay.replayTo(sessionId);
        expect(result.session.turns).toHaveLength(1);
        expect(result.session.turns[0].status).toBe("interrupted");
        expect(result.session.turns[0].messages).toHaveLength(99);
        expect(result.session.turns[0].messages.at(-1)).toMatchObject({ role: "user", content: "进行中" });
    });

    it("孤儿 user_message 在后续回合前按顺序物化，且不被后续 turn_commit 吞掉", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-orphan";

        await log.append(sessionId, "session_created", {});
        // 第一轮：user_message 落盘后进程被强杀，turn_commit 缺失
        await log.append(sessionId, "user_message", { text: "崩溃前的消息", turnId: "T1", trigger: "user" });
        // 重启后继续对话
        await appendTurn(log, sessionId, {
            turnId: "T2",
            userMessages: ["新消息"],
            messages: [{ role: "assistant", content: "回复" } as ChatMessage],
        });

        const result = await replay.replayTo(sessionId);
        expect(result.session.turns).toHaveLength(2);
        // 孤儿消息按发生顺序排在新回合之前，不丢失也不重复
        expect(result.session.turns[0].status).toBe("interrupted");
        expect(result.session.turns[0].messages.map(message => (message as any).content)).toEqual(["崩溃前的消息"]);
        expect(result.session.turns[1].status).toBe("completed");
        expect(result.session.turns[1].messages.map(message => (message as any).content)).toEqual(["新消息", "回复"]);
    });

    it("执行中并入的 pending 消息（出现在 messages）不重复物化", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-pending";

        await log.append(sessionId, "user_message", { text: "第一问", turnId: "T1" });
        await log.append(sessionId, "user_message", { text: "补充问题", turnId: "T1", trigger: "pending" });
        const seqs: number[] = [];
        for (const message of [
            { role: "user", content: "补充问题" } as ChatMessage,
            { role: "assistant", content: "合并回复" } as ChatMessage,
        ]) {
            seqs.push((await log.append(sessionId, "turn_message", { turnId: "T1", message })).seq);
        }
        await log.append(sessionId, "turn_commit", {
            turnId: "T1",
            events: seqs,
            userMessages: ["第一问"],
            stopReason: "stop",
            usage: usage(),
            interrupted: false,
        });

        const result = await replay.replayTo(sessionId);
        expect(result.session.turns).toHaveLength(1);
        expect(result.session.turns[0].messages.map(message => (message as any).content)).toEqual([
            "第一问",
            "补充问题",
            "合并回复",
        ]);
    });

    it("turn_message 是内容唯一来源，终态只存关系", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-turnmsg";

        await log.append(sessionId, "session_created", {});
        await log.append(sessionId, "user_message", { text: "查行情", turnId: "T1", trigger: "user" });
        await log.append(sessionId, "turn_message", {
            turnId: "T1",
            message: { role: "assistant", content: null, tool_calls: [{ id: "c1" }] } as ChatMessage,
        });
        await log.append(sessionId, "turn_message", {
            turnId: "T1",
            message: { role: "tool", tool_call_id: "c1", name: "bash", content: "结果" } as ChatMessage,
        });
        await log.append(sessionId, "turn_message", {
            turnId: "T1",
            message: { role: "assistant", content: "最终答案" } as ChatMessage,
        });
        await log.append(sessionId, "turn_commit", {
            turnId: "T1",
            events: [3, 4, 5],
            userMessages: ["查行情"],
            stopReason: "stop",
            usage: usage(),
            interrupted: false,
        });

        const result = await replay.replayTo(sessionId);
        expect(result.session.turns).toHaveLength(1);
        expect(result.session.turns[0].status).toBe("completed");
        // user + 终态三条：增量不重复投影
        expect(result.session.turns[0].messages).toHaveLength(4);
    });

    it("未闭合的 turn_message 物化为 interrupted 回合（只有 call 也保留）", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-turnmsg-abort";

        await log.append(sessionId, "session_created", {});
        await log.append(sessionId, "user_message", { text: "查行情", turnId: "T1", trigger: "user" });
        await log.append(sessionId, "turn_message", {
            turnId: "T1",
            message: { role: "assistant", content: null, tool_calls: [{ id: "c1" }] } as ChatMessage,
        });

        const result = await replay.replayTo(sessionId);
        expect(result.session.turns).toHaveLength(1);
        expect(result.session.turns[0].status).toBe("interrupted");
        expect(result.session.turns[0].messages[0]).toMatchObject({ role: "user", content: "查行情" });
        expect(result.session.turns[0].messages[1]).toMatchObject({ role: "assistant" });
    });

    it("续跑回合（userMessages 为空）投影为无用户消息的 turn，工具消息紧跟上一条 assistant", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-resume";

        await log.append(sessionId, "session_created", {});
        // T1 未闭合：只有用户消息与 call
        await log.append(sessionId, "user_message", { text: "查行情", turnId: "T1", trigger: "user" });
        await log.append(sessionId, "turn_message", {
            turnId: "T1",
            message: { role: "assistant", content: null, tool_calls: [{ id: "c1" }] } as ChatMessage,
        });
        // T2 续跑：无 user_message，从补跑工具开始
        await log.append(sessionId, "turn_message", {
            turnId: "T2",
            message: { role: "tool", tool_call_id: "c1", name: "bash", content: "重跑结果" } as ChatMessage,
        });
        await log.append(sessionId, "turn_message", {
            turnId: "T2",
            message: { role: "assistant", content: "完成" } as ChatMessage,
        });
        await log.append(sessionId, "turn_commit", {
            turnId: "T2",
            events: [4, 5],
            userMessages: [],
            stopReason: "stop",
            usage: usage(),
            interrupted: false,
        });

        const result = await replay.replayTo(sessionId);
        expect(result.session.turns).toHaveLength(2);
        expect(result.session.turns[0].status).toBe("interrupted");
        expect(result.session.turns[1].status).toBe("completed");
        expect(result.session.turns[1].messages).toHaveLength(2);
        expect(result.session.turns[1].messages.map(message => message.role)).toEqual(["tool", "assistant"]);
        expect(result.session.totalUserTurnCount).toBe(1);
    });

    it("损坏尾行不影响后续 seq", async () => {
        const log = new EventLog();
        const sessionId = "sess-corrupt-tail";
        await log.append(sessionId, "session_created", {});
        const filePath = path.join(tmpDir, "sessions", "events", "sess-corrupt-tail.jsonl");
        fs.appendFileSync(filePath, '{"seq":999,"broken\\n', "utf8");

        const next = await log.append(sessionId, "user_message", { text: "after", turnId: "T1", trigger: "user" });
        expect(next.seq).toBe(2);
    });

    it("并发追加保持 seq 唯一递增", async () => {
        const log = new EventLog();
        const sessionId = "sess-concurrent";
        const events = await Promise.all(
            Array.from({ length: 10 }, (_, index) => log.append(sessionId, "user_message", { text: String(index), turnId: "T1", trigger: "user" })),
        );
        expect(events.map(event => event.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
    });

    it("损坏行容错：跳过坏行不阻断读取", async () => {
        const log = new EventLog();
        const sessionId = "sess-5";
        await log.append(sessionId, "session_created", {});
        await log.append(sessionId, "user_message", { text: "hi", turnId: "T1", trigger: "user" });

        const filePath = path.join(tmpDir, "sessions", "events", "sess-5.jsonl");
        const text = fs.readFileSync(filePath, "utf8");
        fs.writeFileSync(filePath, text + '{"seq":999,"broken\n', "utf8");

        const events = await log.read(sessionId);
        expect(events).toHaveLength(2);
        expect(events[1].payload).toEqual({ text: "hi", turnId: "T1", trigger: "user" });
    });

    it("truncate 截断到目标 seq，后续事件作废", async () => {
        const log = new EventLog();
        const sessionId = "sess-6";
        await log.append(sessionId, "session_created", {});
        await log.append(sessionId, "user_message", { text: "first", turnId: "T1", trigger: "user" });
        await appendTurn(log, sessionId, {
            turnId: "T1",
            messages: [{ role: "assistant", content: "one" } as ChatMessage],
        });
        await log.append(sessionId, "user_message", { text: "second", turnId: "T2", trigger: "user" });

        await log.truncate(sessionId, 2);
        expect(await log.lastSeq(sessionId)).toBe(2);
        const events = await log.read(sessionId);
        expect(events).toHaveLength(2);

        const next = await log.append(sessionId, "user_message", { text: "rewritten", turnId: "T1", trigger: "user" });
        expect(next.seq).toBe(3);
    });
});

describe("EventLog 逆序分页（时间线首屏）", () => {
    /** 造 n 个回合：每回合 user_message + assistant 正文 + turn_commit，正文够长以跨读窗口。 */
    async function seedTurns(log: EventLog, sessionId: string, n: number): Promise<void> {
        await log.append(sessionId, "session_created", { cwd: tmpDir });
        for (let index = 0; index < n; index++) {
            const turnId = `T${index}`;
            await log.append(sessionId, "user_message", { text: `问题 ${index}`, turnId, trigger: "user" });
            await log.append(sessionId, "turn_message", {
                turnId,
                message: { role: "assistant", content: `回答 ${index} `.repeat(20) },
            } as never);
            await log.append(sessionId, "turn_commit", {
                turnId,
                messageIds: [],
                interrupted: false,
                usage: usage(),
            } as never);
        }
    }

    it("取最后 count 条，按 seq 升序，且顶部落在回合边界", async () => {
        const log = new EventLog();
        const sessionId = "page-tail";
        await seedTurns(log, sessionId, 60);

        const page = await log.readBefore(sessionId, Number.MAX_SAFE_INTEGER, 5);

        expect(page.length).toBeGreaterThanOrEqual(5);
        // 升序
        expect(page.map(event => event.seq)).toEqual([...page.map(event => event.seq)].sort((a, b) => a - b));
        // 页首必须是某个回合的起点（前一页的 turn_commit 之后），不能是半截回合
        expect(["user_message", "session_created"]).toContain(page[0]!.type);
    });

    it("before 游标取更早一页，且与上一页不重叠", async () => {
        const log = new EventLog();
        const sessionId = "page-before";
        await seedTurns(log, sessionId, 40);

        const firstPage = await log.readBefore(sessionId, Number.MAX_SAFE_INTEGER, 5);
        const secondPage = await log.readBefore(sessionId, firstPage[0]!.seq, 5);

        expect(secondPage.length).toBeGreaterThan(0);
        expect(secondPage[secondPage.length - 1]!.seq).toBeLessThan(firstPage[0]!.seq);
        // 文件头：再往前应当是空页，而不是重复内容
        const empty = await log.readBefore(sessionId, secondPage[0]!.seq, 1000);
        expect(empty.length).toBeLessThanOrEqual(1000);
        expect(empty.every(event => event.seq < secondPage[0]!.seq)).toBe(true);
    });

    it("日志不存在时返回空数组", async () => {
        expect(await new EventLog().readBefore("missing-session", Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
    });

    it("日志超过单个读窗口时跨越窗口拼接仍然正确", async () => {
        const log = new EventLog();
        const sessionId = "page-cross-window";
        // 每回合 ~700 字节，400 回合约 280 KB，跨多个 64 KB 读窗口
        await seedTurns(log, sessionId, 400);

        const page = await log.readBefore(sessionId, Number.MAX_SAFE_INTEGER, 10);
        const seqs = page.map(event => event.seq);

        expect(page.length).toBeGreaterThanOrEqual(10);
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
        expect(new Set(seqs).size).toBe(seqs.length);
        expect(["user_message", "session_created"]).toContain(page[0]!.type);
    });
});

describe("EventLog 正向读取（尾部窗口）", () => {
    it("从指定 seq 起读到日志末尾，limit 截断", async () => {
        const log = new EventLog();
        const sessionId = "sess-read-tail";

        await log.append(sessionId, "session_created", {});
        for (let index = 0; index < 5; index += 1) {
            await appendTurn(log, sessionId, {
                turnId: `R${index}`,
                userMessages: [`q${index}`],
                messages: [{ role: "assistant", content: `a${index}` } as ChatMessage],
            });
        }

        expect((await log.read(sessionId, 1)).map(event => event.seq)).toEqual(
            Array.from({ length: 16 }, (_, index) => index + 1),
        );
        expect((await log.read(sessionId, 13)).map(event => event.seq)).toEqual([13, 14, 15, 16]);
        expect((await log.read(sessionId, 13, 2)).map(event => event.seq)).toEqual([13, 14]);
        expect((await log.read(sessionId, 16)).map(event => event.seq)).toEqual([16]);
    });

    it("单个事件超过读取窗口时跨窗口拼接仍然正确", async () => {
        const log = new EventLog();
        const sessionId = "sess-read-big-window";

        await log.append(sessionId, "session_created", {});
        await log.append(sessionId, "turn_message", {
            turnId: "B1",
            message: { role: "assistant", content: "x".repeat(200_000) },
        });
        await log.append(sessionId, "turn_message", {
            turnId: "B1",
            message: { role: "assistant", content: "tail-after-big" },
        });

        expect((await log.read(sessionId, 3)).map(event => event.seq)).toEqual([3]);
        const middle = await log.read(sessionId, 2);
        expect(middle.map(event => event.seq)).toEqual([2, 3]);
        expect((middle[0].payload as any).message.content.length).toBe(200_000);
        expect((middle[1].payload as any).message.content).toBe("tail-after-big");
    });

    it("窗口边界跨多字节字符时内容不被破坏", async () => {
        const log = new EventLog();
        const sessionId = "sess-read-multibyte";

        await log.append(sessionId, "session_created", {});
        const texts: string[] = [];
        for (let index = 0; index < 60; index += 1) {
            // 每条约 3.6KB 中文，读取窗口（64KB 起翻倍）必然落在某个字符中间
            const text = `第${index}条：` + "中文内容测试".repeat(200);
            texts.push(text);
            await log.append(sessionId, "turn_message", {
                turnId: "M1",
                message: { role: "assistant", content: text },
            });
        }

        const all = await log.read(sessionId, 1);
        expect(all).toHaveLength(61);
        const contents = all
            .filter(event => event.type === "turn_message")
            .map(event => (event.payload as any).message.content);
        expect(contents).toEqual(texts);

        // 尾部读同样不能把跨窗口的字符解码坏
        const tail = await log.read(sessionId, 61);
        expect((tail[0].payload as any).message.content).toBe(texts.at(-1));
    });

    it("尾部被写入更早的 seq（日志被改动）时退化为整文件扫描，不漏事件", async () => {
        const log = new EventLog();
        const sessionId = "sess-read-tampered";

        await log.append(sessionId, "session_created", {});
        for (let index = 0; index < 3; index += 1) {
            await log.append(sessionId, "user_message", { text: `q${index}`, turnId: "T1" });
        }

        const filePath = path.join(tmpDir, "sessions", "events", `${sessionId}.jsonl`);
        fs.appendFileSync(filePath, `${JSON.stringify({
            seq: 2,
            ts: new Date().toISOString(),
            sessionId,
            type: "user_message",
            payload: { text: "rewound", turnId: "T1" },
        })}\n`, "utf8");

        const events = await log.read(sessionId, 3);
        // 全量扫描后仍按 fromSeq 过滤：被插到尾部的那条（seq=2）不该出现
        expect(events.map(event => event.seq)).toEqual([3, 4]);
    });

    it("fromSeq 越过末尾时返回空，尾部半行不影响读取", async () => {
        const log = new EventLog();
        const sessionId = "sess-read-past-end";

        await log.append(sessionId, "session_created", {});
        await log.append(sessionId, "user_message", { text: "q", turnId: "T1" });

        const filePath = path.join(tmpDir, "sessions", "events", `${sessionId}.jsonl`);
        fs.appendFileSync(filePath, '{"seq":3,"type":"turn_me', "utf8");

        expect(await log.read(sessionId, 3)).toEqual([]);
        expect((await log.read(sessionId, 2)).map(event => event.seq)).toEqual([2]);
    });
});

describe("standalone_turn replay", () => {
    it("standalone_turn 投影为独立 completed turn", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-standalone";

        await log.append(sessionId, "session_created", {});
        await log.append(sessionId, "standalone_turn", {
            messages: [
                { role: "user", content: "[图片提问] 分析 (ID: img_1)" } as ChatMessage,
                { role: "assistant", content: "[图片分析结果] (ID: img_1) 一只猫" } as ChatMessage,
            ],
        });

        const result = await replay.replayTo(sessionId);
        expect(result.session.turns).toHaveLength(1);
        const turn = result.session.turns[0];
        expect(turn.status).toBe("completed");
        expect(turn.messages.map((m) => m.content)).toEqual([
            "[图片提问] 分析 (ID: img_1)",
            "[图片分析结果] (ID: img_1) 一只猫",
        ]);
    });

    it("standalone_turn 与普通回合交错重放保持一致", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-mixed";

        await log.append(sessionId, "session_created", {});
        await appendTurn(log, sessionId, {
            turnId: "T1",
            userMessages: ["你好"],
            messages: [{ role: "assistant", content: "你好！" } as ChatMessage],
        });
        await log.append(sessionId, "standalone_turn", {
            messages: [
                { role: "user", content: "[图片提问] (ID: img_2)" } as ChatMessage,
                { role: "assistant", content: "[图片分析结果] (ID: img_2) 内容" } as ChatMessage,
            ],
        });

        const result = await replay.replayTo(sessionId);
        expect(result.session.turns).toHaveLength(2);
        expect(result.session.turns[1].status).toBe("completed");
        expect(result.session.turns[1].messages[1].content).toContain("img_2");
    });
});

describe("会话 cwd 持久化", () => {
    const commitPayload = {
        turnId: "T-cwd",
        events: [],
        userMessages: ["hi"],
        stopReason: "stop",
        usage: usage(),
        interrupted: false,
    };

    it("appendAgentEvent 自动补的 session_created 记录会话 cwd，重放可恢复", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-cwd-1";
        const session = { ...createEmptySession(sessionId), cwd: "/proj/alpha" };

        await replay.appendAgentEvent(session, "turn_commit", commitPayload);

        const events = await log.read(sessionId);
        expect(events[0].type).toBe("session_created");
        expect(events[0].payload).toEqual({ cwd: "/proj/alpha" });

        const result = await replay.replayTo(sessionId);
        expect(result.session.cwd).toBe("/proj/alpha");
    });

    it("session.cwd 缺失时用当前工具目录补齐", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-cwd-2";
        const session = createEmptySession(sessionId);

        await replay.appendAgentEvent(session, "turn_commit", commitPayload);

        const events = await log.read(sessionId);
        expect(events[0].type).toBe("session_created");
        expect(events[0].payload).toEqual({ cwd: path.resolve(tmpDir) });
        const result = await replay.replayTo(sessionId);
        expect(result.session.cwd).toBe(path.resolve(tmpDir));
    });

    it("旧事件无 cwd 时归一到当前工具目录，不阻塞重放", async () => {
        const log = new EventLog();
        const replay = new SessionReplay(log);
        const sessionId = "sess-cwd-3";

        await log.append(sessionId, "session_created", {} as never);
        await log.append(sessionId, "turn_commit", commitPayload);

        const result = await replay.replayTo(sessionId);
        expect(result.session.cwd).toBe(path.resolve(tmpDir));
        expect(result.session.turns).toHaveLength(1);
    });
});

describe("流式片段 pending 文件", () => {
    const eventFile = (sessionId: string) =>
        path.join(tmpDir, "sessions", "events", `${sessionId}.jsonl`);
    const streamFile = (sessionId: string) =>
        path.join(tmpDir, "sessions", "events", `${sessionId}.stream.jsonl`);

    it("流式片段不落主日志，异常退出后从 pending 恢复文字、思考与工具参数", async () => {
        const log = new EventLog();
        const sessionId = "sess-stream-pending";
        const turnId = "T1";
        await log.append(sessionId, "user_message", { text: "查资料", turnId, trigger: "user" });
        await log.appendStreamDelta(sessionId, turnId, 1, { text: "已找到" });
        await log.appendStreamDelta(sessionId, turnId, 1, { reasoning: "先检查" });
        await log.appendStreamDelta(sessionId, turnId, 1, {
            toolCalls: [{ index: 0, name: "search", arguments: '{"q":' }],
        });
        await log.flushStream(sessionId);

        expect(fs.readFileSync(eventFile(sessionId), "utf8")).not.toContain("turn_stream_delta");
        expect(fs.existsSync(streamFile(sessionId))).toBe(true);

        // 模拟进程重启：新实例只靠磁盘恢复
        const { session } = await new SessionReplay(new EventLog()).replayTo(sessionId);
        expect(session.turns[0]?.status).toBe("interrupted");
        const partial = getSessionContextHistory(session)[1] as Extract<ChatMessage, { role: "assistant" }>;
        expect(partial.content).toContain("已找到");
        expect(partial.reasoning_content).toBe("先检查");
        expect(partial.content).toContain('"q"');
    });

    it("回合提交后剔除该回合片段，其他未闭合回合的片段保留", async () => {
        const log = new EventLog();
        const sessionId = "sess-stream-drop";
        await log.append(sessionId, "user_message", { text: "旧问题", turnId: "T-old", trigger: "user" });
        await log.appendStreamDelta(sessionId, "T-old", 1, { text: "旧片段" });
        await log.append(sessionId, "user_message", { text: "新问题", turnId: "T-new", trigger: "user" });
        await log.appendStreamDelta(sessionId, "T-new", 1, { text: "新片段" });

        await log.dropStream(sessionId, "T-new");

        const text = fs.readFileSync(streamFile(sessionId), "utf8");
        expect(text).toContain("旧片段");
        expect(text).not.toContain("新片段");
    });

    it("片段聚合落盘：批量行数远少于 delta 条数，且不推进主日志 seq", async () => {
        const log = new EventLog();
        const sessionId = "sess-stream-batch";
        const turnId = "T1";
        await log.append(sessionId, "user_message", { text: "问题", turnId, trigger: "user" });
        const seqBefore = await log.lastSeq(sessionId);
        for (let index = 0; index < 200; index += 1) {
            await log.appendStreamDelta(sessionId, turnId, 1, { text: "字" });
        }
        await log.flushStream(sessionId);

        const lines = fs.readFileSync(streamFile(sessionId), "utf8").split("\n").filter(Boolean);
        expect(lines.length).toBeLessThan(20);
        const deltas = lines.flatMap(line => JSON.parse(line).deltas);
        expect(deltas).toHaveLength(200);
        // seq 是会话状态时间轴：逐 token 片段不能抬高它，否则按 seq 尾部窗口回查的逻辑会失准
        expect(await log.lastSeq(sessionId)).toBe(seqBefore);

        const commit = await log.append(sessionId, "turn_commit", {
            turnId,
            events: [],
            userMessages: [],
            stopReason: "stop",
            usage: usage(),
            interrupted: false,
        });
        expect(commit.seq).toBe(seqBefore + 1);
        expect(fs.readFileSync(eventFile(sessionId), "utf8")).not.toContain("turn_stream_delta");
    });

    it("未落盘的缓冲也能被 read 读到（同进程即时可见）", async () => {
        const log = new EventLog();
        const sessionId = "sess-stream-memory";
        await log.appendStreamDelta(sessionId, "T1", 1, { text: "在线" });

        const events = await log.read(sessionId);
        expect(events.filter(event => event.type === "turn_stream_delta")).toHaveLength(1);
    });

    it("truncate 与 delete 一并清掉 pending 片段", async () => {
        const log = new EventLog();
        const sessionId = "sess-stream-truncate";
        await log.append(sessionId, "user_message", { text: "问题", turnId: "T1", trigger: "user" });
        await log.appendStreamDelta(sessionId, "T1", 1, { text: "片段" });
        await log.flushStream(sessionId);
        expect(fs.existsSync(streamFile(sessionId))).toBe(true);

        await log.truncate(sessionId, 1);
        expect(fs.existsSync(streamFile(sessionId))).toBe(false);

        await log.appendStreamDelta(sessionId, "T2", 1, { text: "片段" });
        await log.flushStream(sessionId);
        await log.delete(sessionId);
        expect(fs.existsSync(streamFile(sessionId))).toBe(false);
    });
});

describe("EventLog 事件订阅与对外读口径", () => {
    it("append 后推送给订阅者，取消订阅后不再推送", async () => {
        const log = new EventLog();
        const sessionId = "sess-subscribe";
        const received: Array<{ sessionId: string; seq: number }> = [];
        const unsubscribe = log.subscribe((id, event) => {
            if (event) received.push({ sessionId: id, seq: event.seq });
        });

        const saved = await log.append(sessionId, "session_created", { cwd: tmpDir });
        expect(received).toEqual([{ sessionId, seq: saved.seq }]);

        unsubscribe();
        await log.append(sessionId, "user_message", { text: "问题", turnId: "T1", trigger: "user" });
        expect(received).toHaveLength(1);
    });

    it("订阅者抛错不影响写入与其它订阅者", async () => {
        const log = new EventLog();
        const sessionId = "sess-subscribe-throw";
        const seen: number[] = [];
        // 这条用例故意让订阅者抛错，静音宿主打的错误日志以免污染测试输出
        const originalError = console.error;
        console.error = () => {};
        log.subscribe(() => {
            throw new Error("订阅者内部错误");
        });
        log.subscribe((_id, event) => {
            if (event) seen.push(event.seq);
        });

        let saved;
        try {
            saved = await log.append(sessionId, "session_created", { cwd: tmpDir });
        } finally {
            console.error = originalError;
        }

        expect(seen).toEqual([saved.seq]);
        expect((await log.read(sessionId)).map(event => event.seq)).toEqual([saved.seq]);
    });

    it("truncate 广播重置信号（event 为 null）", async () => {
        const log = new EventLog();
        const sessionId = "sess-subscribe-reset";
        const signals: Array<number | null> = [];
        log.subscribe((_id, event) => {
            signals.push(event ? event.seq : null);
        });

        await log.append(sessionId, "session_created", { cwd: tmpDir });
        await log.append(sessionId, "user_message", { text: "问题", turnId: "T1", trigger: "user" });
        await log.truncate(sessionId, 1);

        expect(signals).toEqual([1, 2, null]);
    });

    it("persistedOnly 读法剔除 pending 流片段（对外游标必须唯一）", async () => {
        const log = new EventLog();
        const sessionId = "sess-persisted-only";
        await log.append(sessionId, "user_message", { text: "问题", turnId: "T1", trigger: "user" });
        await log.appendStreamDelta(sessionId, "T1", 1, { text: "片段" });
        await log.flushStream(sessionId);

        const full = await log.read(sessionId);
        expect(full.some(event => event.type === "turn_stream_delta")).toBe(true);
        // 片段 seq 全等于日志末尾：混进对外接口会让客户端按 seq 去重时丢帧
        expect(new Set(full.map(event => event.seq)).size).toBeLessThan(full.length);

        const persisted = await log.read(sessionId, 1, undefined, { persistedOnly: true });
        expect(persisted.map(event => event.seq)).toEqual([1]);
        expect(persisted.some(event => event.type === "turn_stream_delta")).toBe(false);
    });

    it("lazy MCP 事件投影到 Session.lazyMcpServers，末条决定当前启用集", async () => {
        const log = new EventLog();
        const sessionId = "sess-lazy-mcp";
        await log.append(sessionId, "session_created", { cwd: tmpDir });
        await log.append(sessionId, "lazy_mcp_changed", { servers: ["mcp-hub", "rea"] });
        await log.append(sessionId, "lazy_mcp_changed", { servers: ["rea"] });

        const replayed = await new SessionReplay(log).replayTo(sessionId);

        expect(replayed.session.lazyMcpServers).toEqual(["rea"]);
    });
});
