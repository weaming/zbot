/**
 * 运行时改标题：会话被 TUI/serve 持有时，`zbot session rename` 交给持有者落盘，
 * 不再因为「有实例持有」直接失败；没人持有时仍走原来的直接写日志路径。
 *
 * 独立文件：mock.module 需要独占进程。
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

const queries: Array<{ sessionId?: string; query: string }> = [];
/** 非空时上游请求挂住，用来制造“回合执行中”。 */
let turnGate: Promise<void> | null = null;

/** 让下一次上游请求挂住，返回放行函数。 */
function holdQuery(): () => void {
    let release!: () => void;
    turnGate = new Promise<void>(resolve => { release = resolve; });
    return () => {
        turnGate = null;
        release();
    };
}

const realChatRuntime = await import("../../src/services/chat-runtime.js");
mock.module("../../src/services/chat-runtime.js", () => ({
    ...realChatRuntime,
    runChatQuery: async (options: any) => {
        queries.push({ sessionId: options.sessionId, query: options.query ?? "" });
        if (turnGate) await turnGate;
        const message = { role: "assistant", content: "桩回复" };
        await options.onTurnMessage?.(message);
        options.onEvent?.({ type: "message_end", content: "桩回复", stopReason: "stop" });
        return { content: "桩回复", toolCalls: 0, messages: [message] };
    },
}));

const { LocalSessionHost } = await import("../../src/host/session-host.js");
const { runSessionCli } = await import("../../src/cli/session.js");

let tmpDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-cli-rename-"));
    previousStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;
    turnGate = null;
    queries.length = 0;
});

afterEach(() => {
    turnGate = null;
    if (previousStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = previousStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
    mock.restore();
});

/** 跑一次 `zbot session <argv>`，收集它的 stdout。 */
async function cli(argv: string[]): Promise<string> {
    const chunks: string[] = [];
    await runSessionCli(argv, { write: text => chunks.push(text), readStdin: async () => "" });
    return chunks.join("");
}

function readEvents(sessionId: string): any[] {
    const eventsPath = path.join(tmpDir, "sessions", "events", `${sessionId}.jsonl`);
    if (!fs.existsSync(eventsPath)) return [];
    return fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}

function titleEvents(sessionId: string): string[] {
    return readEvents(sessionId)
        .filter(event => event.type === "session_renamed")
        .map(event => event.payload.title);
}

function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            if (check()) return resolve();
            if (Date.now() - started > timeoutMs) return reject(new Error("等待条件超时"));
            setTimeout(tick, 10);
        };
        tick();
    });
}

/** 建一个已落盘的会话并交给 owner 持有（等价于 TUI 里打开）。 */
async function openSession(owner: InstanceType<typeof LocalSessionHost>, title: string): Promise<string> {
    const { sessionId } = await owner.createSession();
    await owner.claimSession(sessionId);
    // 先落一条 session_created，CLI 才能按 id 找到它
    await owner.renameSession(sessionId, title);
    return sessionId;
}

describe("会话被持有时改标题", () => {
    test("交给持有者落盘，不再报 held", async () => {
        const owner = new LocalSessionHost();
        const target = await openSession(owner, "初始标题");

        const out = await cli(["rename", target, "运行时标题"]);
        expect(out).toContain("已重命名");
        expect(out).toContain("运行时标题");
        expect(titleEvents(target)).toEqual(["初始标题", "运行时标题"]);

        // 持有者内存里的标题同步更新（who / 会话列表读的是它）
        const held = await owner.listSessions();
        expect(held.find(item => item.sessionId === target)?.title).toBe("运行时标题");

        await owner.close();
    }, 20_000);

    test("回合执行中也能改，且不吃掉正在跑的回合", async () => {
        const owner = new LocalSessionHost();
        const target = await openSession(owner, "初始标题");

        const release = holdQuery();
        const occupying = owner.sendMessage(target, "占用会话");
        await waitFor(() => queries.some(item => item.sessionId === target && item.query.includes("占用会话")));
        expect(owner.isSessionBusy(target)).toBe(true);

        const applied = JSON.parse(await cli(["rename", target, "忙时标题", "--json"]));
        expect(applied.title).toBe("忙时标题");
        expect(owner.isSessionBusy(target)).toBe(true);

        release();
        await occupying;
        await waitFor(() => !owner.isSessionBusy(target));
        expect(titleEvents(target).at(-1)).toBe("忙时标题");
        // 忙时改名与回合共用同一个 append 串行器：seq 必须严格递增且不重复
        const seqs = readEvents(target).map(event => event.seq);
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
        expect(new Set(seqs).size).toBe(seqs.length);

        const held = await owner.listSessions();
        expect(held.find(item => item.sessionId === target)?.title).toBe("忙时标题");
        await owner.close();
    }, 20_000);

    test("改名后回调宿主，让 TUI 的 tab 栏跟着刷新", async () => {
        const owner = new LocalSessionHost();
        const renamed: Array<{ sessionId: string; title: string }> = [];
        owner.onSessionRenamed = (sessionId, title) => renamed.push({ sessionId, title });
        const target = await openSession(owner, "初始标题");
        renamed.length = 0;

        await cli(["rename", target, "控制通道标题"]);
        expect(renamed).toEqual([{ sessionId: target, title: "控制通道标题" }]);

        await owner.close();
    }, 20_000);

    test("没人持有时仍直接写日志，标题上限统一截断", async () => {
        const owner = new LocalSessionHost();
        const target = await openSession(owner, "初始标题");
        await owner.close();

        const applied = JSON.parse(await cli(["rename", target, "空闲标题", "--json"]));
        expect(applied.title).toBe("空闲标题");
        expect(titleEvents(target).at(-1)).toBe("空闲标题");

        const long = "x".repeat(260);
        const truncated = JSON.parse(await cli(["rename", target, long, "--json"]));
        expect(truncated.title).toHaveLength(200);
        expect(titleEvents(target).at(-1)).toHaveLength(200);
    }, 20_000);

    test("持有者退出后（无人持有）仍可改名，不因探测失败报错", async () => {
        const owner = new LocalSessionHost();
        const target = await openSession(owner, "初始标题");
        await owner.close();

        expect(await cli(["rename", target, "关掉之后"])).toContain("已重命名");
        expect(titleEvents(target).at(-1)).toBe("关掉之后");
    }, 20_000);
});
