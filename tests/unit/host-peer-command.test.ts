/**
 * 会话间投递的 slash 命令：解析层放行/拒绝、前端执行器回传、未知命令回落文本、
 * 非法参数与不支持命令给明确结果。
 *
 * 独立文件：mock.module 需要独占进程。
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

const queries: Array<{ sessionId?: string; query: string }> = [];
const realChatRuntime = await import("../../src/services/chat-runtime.js");
mock.module("../../src/services/chat-runtime.js", () => ({
    ...realChatRuntime,
    runChatQuery: async (options: any) => {
        queries.push({ sessionId: options.sessionId, query: options.query ?? "" });
        options.onEvent?.({ type: "message_end", content: "模型输出", stopReason: "stop" });
        return { content: "模型输出", toolCalls: 0, messages: [] };
    },
}));

const { LocalSessionHost } = await import("../../src/host/session-host.js");
const { setSessionControl, setSessionDirectory } = await import("../../src/control/runtime.js");
const { REVIEW_PROMPT } = await import("../../src/commands/slash-command.js");
const { executePeerSlashCommand } = await import("../../src/tui/peer-commands.js");

let tmpDir: string;
let originalStateDir: string | undefined;
let agent: InstanceType<typeof LocalSessionHost>;
let sessionA: string;
let sessionB: string;

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-peer-command-"));
    originalStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;

    agent = new LocalSessionHost();
    sessionA = (await agent.createSession()).sessionId;
    sessionB = (await agent.createSession()).sessionId;
    await agent.claimSession(sessionA);
    await agent.claimSession(sessionB);
    queries.length = 0;
});

afterEach(async () => {
    await agent.close();
    setSessionControl(undefined);
    setSessionDirectory(undefined);
    if (originalStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = originalStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
    mock.restore();
});

function readEvents(sessionId: string): any[] {
    const eventsPath = path.join(tmpDir, "sessions", "events", `${sessionId}.jsonl`);
    if (!fs.existsSync(eventsPath)) return [];
    return fs
        .readFileSync(eventsPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            if (check()) return resolve();
            if (Date.now() - started > timeoutMs) return reject(new Error("等待条件超时"));
            setTimeout(tick, 5);
        };
        tick();
    });
}

/** 发一条 peer 消息并等结果（命令可能在 send 返回前就完成，所以读事件而不是 waitForResult）。 */
/** 只统计目标会话（sessionB）自己的模型回合：请求方收到结果后会被驱动一轮，不能混算。 */
function targetQueries(): string[] {
    return queries.filter(item => item.sessionId === sessionB).map(item => item.query);
}

/** 用真实的 TUI 执行器，覆盖命令实现本身（而不是只测注入契约）。 */
function useRealHandler(): void {
    agent.setSlashCommandHandler((sessionId, text) => executePeerSlashCommand(agent, sessionId, text));
}

async function sendAndWait(text: string) {
    const outcome = await agent.sessionControl.send(sessionA, sessionB, text, { expectResult: true });
    const resultOf = () => readEvents(sessionA)
        .filter(event => event.type === "peer_result" && event.payload.msgId === outcome.message.id)
        .at(-1)?.payload;
    await waitFor(() => resultOf() !== undefined);
    const result = resultOf();
    if (!result) throw new Error("等待结果超时");
    return result as { ok: boolean; text: string; stopReason: string; error?: string };
}

describe("会话间 slash 命令", () => {
    test("已识别命令交给前端执行器，不跑模型", async () => {
        agent.setSlashCommandHandler((sessionId, text) => ({
            handled: true,
            output: `handled:${sessionId.slice(-4)}:${text}`,
        }));

        const result = await sendAndWait("/help");

        expect(result.ok).toBe(true);
        expect(result.stopReason).toBe("command");
        expect(result.text).toContain("handled:");
        expect(targetQueries()).toEqual([]);
    });

    test("/review 转成模型指令执行", async () => {
        const result = await sendAndWait("/review");

        expect(result.ok).toBe(true);
        expect(targetQueries()).toHaveLength(1);
        expect(targetQueries()[0]).toContain(REVIEW_PROMPT);
    });

    test("非法参数给明确错误，既不跑模型也不当文本", async () => {
        const result = await sendAndWait("/help extra");

        expect(result.ok).toBe(false);
        expect(result.stopReason).toBe("invalid_command");
        expect(result.text).toContain("参数过多");
        expect(targetQueries()).toEqual([]);
    });

    test("不支持从会话间执行的命令明确拒绝", async () => {
        const result = await sendAndWait("/model");

        expect(result.ok).toBe(false);
        expect(result.stopReason).toBe("unsupported_command");
        expect(result.text).toContain("不支持从会话间消息执行");
        expect(targetQueries()).toEqual([]);
    });

    test("未知 /xxx 与前导空格按普通文本交给模型", async () => {
        await sendAndWait("/nope 这是什么");
        expect(targetQueries()).toHaveLength(1);
        expect(targetQueries()[0]).toContain("/nope 这是什么");

        await sendAndWait(" /help");
        expect(targetQueries()).toHaveLength(2);
        expect(targetQueries()[1]).toContain("/help");
    });

    test("未注册执行器时命令回落成文本（无 UI 宿主边界）", async () => {
        const result = await sendAndWait("/help");

        expect(result.ok).toBe(true);
        expect(targetQueries()).toHaveLength(1);
        expect(targetQueries()[0]).toContain("/help");
    });

    test("真实执行器：只读命令返回内容，命令分支不残留 busy", async () => {
        useRealHandler();

        const help = await sendAndWait("/help");
        expect(help.ok).toBe(true);
        expect(help.stopReason).toBe("command");
        expect(help.text).toContain("可用命令");
        expect(agent.isSessionBusy(sessionB)).toBe(false);

        const ps = await sendAndWait("/ps");
        expect(ps.text).toContain("没有正在运行的后台任务");

        const tasks = await sendAndWait("/tasks");
        expect(tasks.text).toContain("当前没有后台任务");

        const cwd = await sendAndWait("/cwd");
        expect(cwd.text).toContain("当前工作目录");

        const effort = await sendAndWait("/effort definitely-not-an-effort");
        expect(effort.text).toContain("未知思考强度");

        expect((await sendAndWait("/tasks status nope")).text).toContain("后台任务不存在");
        expect(agent.isSessionBusy(sessionB)).toBe(false);
    });

    test("真实执行器：/cwd 可切换目录", async () => {
        useRealHandler();
        const sub = path.join(tmpDir, "sub");
        fs.mkdirSync(sub);

        const switched = await sendAndWait(`/cwd ${sub}`);
        expect(switched.text).toContain("工作目录已切换到");
        expect(await agent.getSessionCwd(sessionB)).toBe(sub);
    });

    test("真实执行器：/reload 不被自身 busy 误拦", async () => {
        useRealHandler();
        // 重载会连真实 MCP：测试里只验证命令路径与守卫，不真的重载
        (agent as any).reloadRuntime = async () => ({ skillCount: 1, mcpServerCount: 2, mcpToolCount: 3 });

        const result = await sendAndWait("/reload");
        expect(result.ok).toBe(true);
        expect(result.text).toContain("已重新加载");
        expect(agent.isSessionBusy(sessionB)).toBe(false);
    });

    test("真实执行器：需要空闲会话的命令明确拒绝（compact/archive 等）", async () => {
        useRealHandler();
        for (const command of ["/compact", "/archive", "/unarchive"]) {
            const result = await sendAndWait(command);
            expect(result.ok).toBe(false);
            expect(result.stopReason).toBe("unsupported_command");
            expect(agent.isSessionBusy(sessionB)).toBe(false);
        }
    });

    test("命令分支不残留 busy：连续命令与非法/不支持命令后仍可再次投递", async () => {
        agent.setSlashCommandHandler(() => ({ handled: true, output: "ok" }));

        expect((await sendAndWait("/help")).ok).toBe(true);
        expect(agent.isSessionBusy(sessionB)).toBe(false);

        expect((await sendAndWait("/skills")).ok).toBe(true);
        expect(agent.isSessionBusy(sessionB)).toBe(false);

        expect((await sendAndWait("/help extra")).ok).toBe(false);
        expect(agent.isSessionBusy(sessionB)).toBe(false);

        expect((await sendAndWait("/model")).ok).toBe(false);
        expect(agent.isSessionBusy(sessionB)).toBe(false);

        // 收尾后仍能正常执行命令（没有被永久占住）
        expect((await sendAndWait("/help")).ok).toBe(true);
    });
});
