import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { getResponsesBaselineFile } from "../../src/utils/state-paths.js";
import { getSessionLogFile } from "../../src/utils/state-paths.js";
import { getSessionExchangeLogFile } from "../../src/utils/logger.js";
import { getSessionTodosFile } from "../../src/utils/runtime-paths.js";

/** 断言送 LLM 的内容时忽略内部消息 id（只服务本地缓存，构造请求体前会剥掉）。 */
function stripMessageIds<T>(messages: T[]): Array<Omit<T, "id">> {
    return messages.map(message => {
        const { id: _id, ...rest } = message as T & { id?: string };
        return rest as Omit<T, "id">;
    });
}

/**
 * 多 TUI 实例协同测试：
 * 1. 实例 A 完成 Turn 1 并落盘后，实例 B 能够检测到磁盘版本更新，重放最新历史并无缝接力 Turn 2；
 * 2. 实例 A 正在运行时，实例 B 尝试向同一 Session 发送消息会被会话锁拦截，防止双写和分叉。
 */

let tmpDir: string;
let originalStateDir: string | undefined;

let queriedHistories: any[] = [];

// mock chat-runtime 透传
const realChatRuntime = await import("../../src/services/chat-runtime.js");
mock.module("../../src/services/chat-runtime.js", () => ({
    ...realChatRuntime,
    runChatQuery: async (opts: any) => {
        queriedHistories.push(opts.history);
        opts.onEvent?.({
            type: "usage",
            usage: {
                model: "test-model",
                promptTokens: 100,
                cacheHitTokens: 40,
                cacheMissTokens: 60,
                completionTokens: 20,
                reasoningTokens: 5,
                totalTokens: 120,
                durationMs: 5,
                requestCount: 1,
            },
        });
        const content = `reply to: ${opts.query}`;
        await opts.onTurnMessage?.({ role: "assistant", content });
        return {
            content,
            toolCalls: 0,
            messages: [{ role: "assistant", content }],
        };
    },
}));

const { LocalSessionHost } = await import("../../src/host/session-host.js");
const { getSessionLockFilePath } = await import("../../src/utils/session-lock.js");
const { createToolImageAsset } = await import("../../src/utils/image-assets.js");

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-tui-multi-test-"));
    originalStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;
    queriedHistories = [];
});

afterEach(() => {
    if (originalStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = originalStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * 注意：本文件依赖进程级的 `mock.module`（bun 无法撤回），必须**单独运行**：
 * 与其他测试文件同进程时会因模块抢先加载导致 mock 失效，进而真发上游请求把整轮挂住。
 * 全量测试用 `--path-ignore-patterns` 排除它，见 package.json 的 test / test:multi-instance。
 */
describe("LocalSessionHost 多实例并发协同", () => {
    test("实例 A 完成 Turn 1 后，实例 B 自动检测落盘版本并无缝接力 Turn 2", async () => {
        const agentA = new LocalSessionHost();
        const agentB = new LocalSessionHost();

        const { sessionId } = await agentA.createSession();

        // 实例 A 发送 Turn 1
        await agentA.sendMessage(sessionId, "Turn 1 question");
        expect(queriedHistories.length).toBe(1);
        expect(queriedHistories[0]).toEqual([]);

        // 此时实例 B 发送 Turn 2，即使实例 B 内存中尚未加载或只有旧缓存
        await agentB.sendMessage(sessionId, "Turn 2 question");
        expect(queriedHistories.length).toBe(2);

        // 验证实例 B 发送 Turn 2 时构建的对话历史包含了 Turn 1 的问答！
        const turn2History = queriedHistories[1];
        expect(stripMessageIds(turn2History)).toEqual([
            { role: "user", content: "Turn 1 question" },
            { role: "assistant", content: "reply to: Turn 1 question" },
        ]);

        // 实例 A 再次接力 Turn 3
        await agentA.sendMessage(sessionId, "Turn 3 question");
        expect(queriedHistories.length).toBe(3);

        const turn3History = queriedHistories[2];
        expect(stripMessageIds(turn3History)).toEqual([
            { role: "user", content: "Turn 1 question" },
            { role: "assistant", content: "reply to: Turn 1 question" },
            { role: "user", content: "Turn 2 question" },
            { role: "assistant", content: "reply to: Turn 2 question" },
        ]);
    });

    test("其他存活进程占用会话时拦截并发发送", async () => {
        const agent = new LocalSessionHost();
        const { sessionId } = await agent.createSession();

        // 模拟其他存活进程（PID 1）持有该 session 的锁
        const lockPath = getSessionLockFilePath(sessionId);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, JSON.stringify({
            pid: 1,
            sessionId,
            lockedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }), "utf8");

        expect(agent.isSessionBusy(sessionId)).toBe(true);
        await expect(agent.sendMessage(sessionId, "并发输入")).rejects.toThrow("PID: 1");
    });

    test("其他实例持锁时 isSessionLockedByOther 为 true，锁释放后为 false", async () => {
        const agent = new LocalSessionHost();
        const { sessionId } = await agent.createSession();

        const lockPath = getSessionLockFilePath(sessionId);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, JSON.stringify({
            pid: 1,
            sessionId,
            lockedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }), "utf8");

        expect(agent.isSessionLockedByOther(sessionId)).toBe(true);

        // 持锁进程退出后（锁文件被清理），本实例不再视为被其他实例锁定
        fs.rmSync(lockPath, { force: true });
        expect(agent.isSessionLockedByOther(sessionId)).toBe(false);
    });

    test("同一实例并发发送时只允许一个请求进入会话", async () => {
        const agent = new LocalSessionHost();
        const { sessionId } = await agent.createSession();

        const first = agent.sendMessage(sessionId, "第一条");
        await expect(agent.sendMessage(sessionId, "第二条")).rejects.toThrow("busy");
        await first;
    });

    test("实例级统计只累计本实例真实网络请求（会话数/输入/缓存命中）", async () => {
        const agent = new LocalSessionHost();
        const { sessionId: s1 } = await agent.createSession();
        const { sessionId: s2 } = await agent.createSession();

        await agent.sendMessage(s1, "Q1");
        await agent.sendMessage(s2, "Q2");
        await agent.sendMessage(s1, "Q3");

        const stats = agent.getInstanceNetworkStats();
        expect(stats.sessionCount).toBe(2);
        expect(stats.requestCount).toBe(3);
        expect(stats.promptTokens).toBe(300);
        expect(stats.cacheHitTokens).toBe(120);
        expect(stats.cacheMissTokens).toBe(180);
        expect(stats.completionTokens).toBe(60);
        expect(stats.reasoningTokens).toBe(15);
        expect((stats.cacheHitTokens / stats.promptTokens) * 100).toBeCloseTo(40);

        // 未发起网络请求的会话不计入统计
        expect(new LocalSessionHost().getInstanceNetworkStats().sessionCount).toBe(0);
    });

    test("归档后取消归档：会话恢复可写并带完整历史继续对话", async () => {
        const agent = new LocalSessionHost();
        const { sessionId } = await agent.createSession();
        await agent.sendMessage(sessionId, "归档前的问题");

        await agent.closeSession(sessionId);
        expect((await agent.listSessions()).find(session => session.sessionId === sessionId)?.archived).toBe(true);

        await agent.unarchiveSession(sessionId);
        expect((await agent.listSessions()).find(session => session.sessionId === sessionId)?.archived).toBe(false);

        // 取消归档后重放事件重建会话，历史完整且可继续对话
        await agent.sendMessage(sessionId, "归档后的问题");
        // history 是请求前的上下文：包含归档前那一整轮，说明重放正确
        expect(stripMessageIds(queriedHistories.at(-1))).toEqual([
            { role: "user", content: "归档前的问题" },
            { role: "assistant", content: "reply to: 归档前的问题" },
        ]);
    });

    test("清空和删除会话时清理各自的工具图片", async () => {
        const agent = new LocalSessionHost();
        const { sessionId } = await agent.createSession();
        await agent.sendMessage(sessionId, "创建会话");

        const first = await createToolImageAsset(Buffer.from("first"), "first.png", "image/png", sessionId);
        const baselineFile = getResponsesBaselineFile(sessionId);
        fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
        fs.writeFileSync(baselineFile, "{}");
        await agent.clearSession(sessionId);
        expect(fs.existsSync(first.path)).toBe(false);
        expect(fs.existsSync(baselineFile)).toBe(false);

        const second = await createToolImageAsset(Buffer.from("second"), "second.png", "image/png", sessionId);
        fs.writeFileSync(baselineFile, "{}");
        const sessionFiles = [getSessionLogFile(sessionId), getSessionExchangeLogFile(sessionId), getSessionTodosFile(sessionId)];
        for (const file of sessionFiles) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, "session data");
        }
        await agent.deleteSession(sessionId);
        expect(fs.existsSync(second.path)).toBe(false);
        expect(fs.existsSync(baselineFile)).toBe(false);
        for (const file of sessionFiles) expect(fs.existsSync(file)).toBe(false);
    });
});

// mock.module 是进程级全局：本文件跑完必须恢复，否则同 worker 的后续文件会拿到假实现
afterAll(() => {
    mock.restore();
});
