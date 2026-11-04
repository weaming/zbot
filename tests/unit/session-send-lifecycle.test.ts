/**
 * 归档生命周期回归：/archive 会释放持有，`session send /unarchive` 必须仍然可达，
 * 之后同一条会话再次 send 也要能用（由本进程临时接管执行）。
 *
 * 用真实 LocalSessionHost + 桩上游驱动，命令解析/执行/收尾全部走生产路径。
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
        const message = { role: "assistant", content: "桩回复" };
        await options.onTurnMessage?.(message);
        options.onEvent?.({ type: "message_end", content: "桩回复", stopReason: "stop" });
        return { content: "桩回复", toolCalls: 0, messages: [message] };
    },
}));

const { LocalSessionHost } = await import("../../src/host/session-host.js");
const { setSessionControl, setSessionDirectory } = await import("../../src/control/runtime.js");
const { runSessionCli } = await import("../../src/cli/session.js");
const { REVIEW_PROMPT } = await import("../../src/commands/slash-command.js");

let tmpDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-send-lifecycle-"));
    previousStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;
    queries.length = 0;
});

afterEach(() => {
    setSessionControl(undefined);
    setSessionDirectory(undefined);
    if (previousStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = previousStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
    mock.restore();
});

/** 每次 CLI 调用注入一个新的真实宿主，模拟"临时接管执行后进程退出"。 */
function createHostFactory() {
    return async () => {
        const host = new LocalSessionHost();
        return {
            createSessionForCli: (cwd: string, init?: any) => host.createSession(cwd, init),
            claimSession: (sessionId: string, options?: { noNegotiate?: boolean }) => host.claimSession(sessionId, options),
            executePeerCommandLocally: (sessionId: string, text: string) => host.executePeerCommandLocally(sessionId, text),
            sendMessage: (sessionId: string, text: string) => host.sendMessage(sessionId, text),
            subscribeEvents: (listener: any) => host.subscribeEvents(listener),
            abortSession: (sessionId: string) => host.abortSession(sessionId),
            close: async () => { await host.close(); },
        };
    };
}

function workdirOf(sessionId: string): string {
    return readEvents(sessionId).find(event => event.type === "session_created")?.payload.cwd;
}

async function runWithStartupDirs(argv: string[], startupDirs: string[]): Promise<string> {
    const chunks: string[] = [];
    await runSessionCli(argv, {
        write: text => chunks.push(text),
        readStdin: async () => "",
        createLocalSendHost: async (startupCwd) => {
            startupDirs.push(startupCwd);
            return createHostFactory()();
        },
    });
    return chunks.join("");
}

async function cli(argv: string[]): Promise<string> {
    const chunks: string[] = [];
    await runSessionCli(argv, {
        write: text => chunks.push(text),
        readStdin: async () => "",
        createLocalSendHost: createHostFactory(),
    });
    return chunks.join("");
}

function readEvents(sessionId: string): any[] {
    const eventsPath = path.join(tmpDir, "sessions", "events", `${sessionId}.jsonl`);
    if (!fs.existsSync(eventsPath)) return [];
    return fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
    const started = Date.now();
    while (!check()) {
        if (Date.now() - started > timeoutMs) throw new Error("等待条件超时");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

describe("本地接管的命令路径", () => {
    test("/review 走 prompt 分支（附加说明拼在固定指令之后），不会报未接入", async () => {
        const owner = new LocalSessionHost();
        const { sessionId: target } = await owner.createSession();
        await owner.claimSession(target);
        await owner.renameSession(target, "review-local");
        await owner.close();
        setSessionControl(undefined);
        setSessionDirectory(undefined);

        const startupDirs: string[] = [];
        const out = await runWithStartupDirs(["send", target, "/review 重点看并发", "--wait=5"], startupDirs);
        // 一次性宿主的启动目录取自会话自己的 cwd
        expect(startupDirs[0]).toBe(workdirOf(target));
        expect(out).toContain("桩回复");
        const query = queries.find(item => item.sessionId === target)?.query ?? "";
        expect(query).toContain(REVIEW_PROMPT);
        expect(query).toContain("重点看并发");
    }, 20_000);

    test("/clear confirm 保留会话自己的 cwd", async () => {
        const owner = new LocalSessionHost();
        const { sessionId: target } = await owner.createSession();
        await owner.claimSession(target);
        const workdir = fs.mkdtempSync(path.join(process.env.ZBOT_STATE_DIR!, "cwd-"));
        await owner.setSessionCwd(target, workdir);
        await owner.renameSession(target, "clear-cwd");
        await owner.close();
        setSessionControl(undefined);
        setSessionDirectory(undefined);

        expect(await cli(["send", target, "/clear confirm", "--wait=5"])).toContain("已清空");
        const probe = JSON.parse(await cli(["show", target, "--json"]));
        expect(probe.cwd).toBe(workdir);
    }, 20_000);
});

describe("一次性宿主的模型设置", () => {
    test("/model 立即落盘：换一个进程再读仍是新值", async () => {
        const owner = new LocalSessionHost();
        const { sessionId: target } = await owner.createSession();
        await owner.claimSession(target);
        // 先落盘一个事实（空会话只在内存里，换进程后就查不到）
        await owner.renameSession(target, "model-set-test");
        await owner.close();
        setSessionControl(undefined);
        setSessionDirectory(undefined);

        const savedModels = {
            chat: process.env.OPENAI_CHAT_MODEL,
            base: process.env.OPENAI_CHAT_BASE_URL,
        };
        process.env.OPENAI_CHAT_MODEL = "stub-model";
        process.env.OPENAI_CHAT_BASE_URL = "https://api.openai.com/v1";
        try {
            expect(await cli(["send", target, "/model chat_completions stub-model HIGH", "--wait=5"]))
                .toContain("思考强度 high");

            // 全新进程只读：pending 若还留在内存里，这里会退回 auto
            const view = JSON.parse(await cli(["send", target, "/model --json", "--wait=5"]));
            expect(view.current).toMatchObject({
                protocol: "chat_completions",
                model: "stub-model",
                reasoningEffort: "high",
            });
        } finally {
            if (savedModels.chat === undefined) delete process.env.OPENAI_CHAT_MODEL;
            else process.env.OPENAI_CHAT_MODEL = savedModels.chat;
            if (savedModels.base === undefined) delete process.env.OPENAI_CHAT_BASE_URL;
            else process.env.OPENAI_CHAT_BASE_URL = savedModels.base;
        }
    }, 20_000);
});

describe("归档生命周期里的 send", () => {
    test("archive 释放持有后，/unarchive 经 send 可达，随后再次 send 也成功", async () => {
        // 1) 起一个真实宿主（等价 TUI），认领会话并执行 /archive
        const owner = new LocalSessionHost();
        const { sessionId: requester } = await owner.createSession();
        const { sessionId: target } = await owner.createSession();
        await owner.claimSession(requester);
        await owner.claimSession(target);

        const archived = await owner.sessionControl.send(requester, target, "/archive", { expectResult: true });
        expect(archived.queued).toBe(false);
        await waitFor(() => !owner.isSessionClaimed(target));
        expect(await owner.isSessionArchived(target)).toBe(true);

        // 2) 模拟 TUI 退出：会话无人持有
        await owner.close();
        setSessionControl(undefined);
        setSessionDirectory(undefined);

        // 3) send /unarchive：本进程临时接管执行
        expect(await cli(["send", target, "/unarchive", "--wait=5"])).toContain("已取消归档");
        expect(JSON.parse(await cli(["show", target, "--json"])).archived).toBe(false);
        expect(readEvents(target).at(-1)?.type).toBe("session_unarchived");

        // 4) 再次 send：无人持有也能执行命令
        expect(await cli(["send", target, "/help", "--wait=5"])).toContain("可用命令");

        // 5) 再次 send：普通文本由本进程跑一轮
        expect(await cli(["send", target, "继续干活", "--wait=5"])).toContain("桩回复");
        expect(queries.some(item => item.sessionId === target && item.query.includes("继续干活"))).toBe(true);
        expect(readEvents(target).some(event => event.type === "user_message"
            && event.payload.text.includes("继续干活"))).toBe(true);
    }, 20_000);
});
