/**
 * 会话间 slash 命令（宿主执行）：全部命令都有文本/JSON 视图或动作，未知命令按文本、
 * 参数非法明确报错，命令分支不残留 busy。
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
const { REVIEW_PROMPT, SLASH_COMMAND_SPECS } = await import("../../src/commands/slash-command.js");

let tmpDir: string;
let originalStateDir: string | undefined;
let originalModel: string | undefined;
let agent: InstanceType<typeof LocalSessionHost>;
let sessionA: string;
let sessionB: string;

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-peer-command-"));
    originalStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;
    // 固定一个可切换模型，/model 才有可校验的目标
    originalModel = process.env.OPENAI_CHAT_MODEL;
    process.env.OPENAI_CHAT_MODEL = "stub-model";

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
    if (originalModel === undefined) delete process.env.OPENAI_CHAT_MODEL;
    else process.env.OPENAI_CHAT_MODEL = originalModel;
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

function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
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

/** 只统计目标会话（sessionB）的模型回合：请求方收到结果后也会跑一轮，不能混算。 */
function targetQueries(): string[] {
    return queries.filter(item => item.sessionId === sessionB).map(item => item.query);
}

async function sendAndWait(text: string) {
    const outcome = await agent.sessionControl.send(sessionA, sessionB, text, { expectResult: true });
    const resultOf = () => readEvents(sessionA)
        .filter(event => event.type === "peer_result" && event.payload.msgId === outcome.message.id)
        .at(-1)?.payload;
    await waitFor(() => resultOf() !== undefined);
    const result = resultOf();
    if (!result) throw new Error("等待结果超时");
    return result as { ok: boolean; text: string; stopReason: string };
}

describe("会话间命令：解析与视图", () => {
    test("未知 /xxx 与前导空格按普通文本交给模型", async () => {
        await sendAndWait("/nope 这是什么");
        expect(targetQueries()).toHaveLength(1);
        expect(targetQueries()[0]).toContain("/nope 这是什么");

        await sendAndWait(" /help");
        expect(targetQueries()[1]).toContain("/help");
    });

    test("已识别命令参数非法给明确错误，既不跑模型也不当文本", async () => {
        for (const [text, hint] of [
            ["/help extra", "参数过多"],
            ["/tasks status", "需要 task_id"],
            // 协议只能是两项：非法协议（含已删除的 use 子命令）都按协议错误报
            ["/model foo", "协议需要是"],
            ["/model grpc gpt", "协议需要是"],
            ["/model use chat_completions stub-model", "协议需要是"],
            ["/mcp enable", "需要服务名"],
        ] as const) {
            const result = await sendAndWait(text);
            expect(result.ok).toBe(false);
            expect(result.stopReason).toBe("invalid_command");
            expect(result.text).toContain(hint);
        }
        expect(targetQueries()).toEqual([]);
        expect(agent.isSessionBusy(sessionB)).toBe(false);
    });

    test("/review 附加说明拼在固定指令之后送模型", async () => {
        const result = await sendAndWait("/review 重点检查并发竞态");

        expect(result.ok).toBe(true);
        expect(result.stopReason).toBe("stop");
        expect(targetQueries()).toHaveLength(1);
        expect(targetQueries()[0]).toContain(REVIEW_PROMPT);
        expect(targetQueries()[0]).toContain("重点检查并发竞态");
    });

    test("只读视图命令直接返回内容，不跑模型", async () => {
        const help = await sendAndWait("/help");
        expect(help.stopReason).toBe("command");
        expect(help.text).toContain("可用命令");

        expect((await sendAndWait("/keys")).text).toContain("快捷键");
        expect((await sendAndWait("/skills")).text).toContain("可用技能");
        expect((await sendAndWait("/system")).text).toContain("system prompt");
        expect(targetQueries()).toEqual([]);
        expect(agent.isSessionBusy(sessionB)).toBe(false);
    });

    test("--json 给出机器可读结构，与文本表达同一事实", async () => {
        const help = JSON.parse((await sendAndWait("/help --json")).text);
        expect(help.commands.map((command: any) => command.name)).toEqual(SLASH_COMMAND_SPECS.map(spec => spec.name));

        const skills = JSON.parse((await sendAndWait("/skills --json")).text);
        expect(Array.isArray(skills.skills)).toBe(true);

        const keys = JSON.parse((await sendAndWait("/keys --json")).text);
        expect(keys.shortcuts.length).toBeGreaterThan(0);

        const cwd = JSON.parse((await sendAndWait("/cwd --json")).text);
        expect(typeof cwd.cwd).toBe("string");
        expect(targetQueries()).toEqual([]);
    });

    test("/sessions 列表、过滤与 JSON", async () => {
        const list = await sendAndWait("/sessions");
        expect(list.text).toContain(sessionB);

        const filtered = JSON.parse((await sendAndWait(`/sessions ${sessionA} --json`)).text);
        expect(filtered.sessions.map((item: any) => item.sessionId)).toEqual([sessionA]);

        const noMatch = await sendAndWait("/sessions 不存在的关键词");
        expect(noMatch.text).toContain("没有匹配");

        const json = JSON.parse((await sendAndWait("/sessions --json")).text);
        expect(json.sessions.map((item: any) => item.sessionId)).toContain(sessionB);
    });

    test("/cwd 可查看与切换", async () => {
        const sub = path.join(tmpDir, "sub");
        fs.mkdirSync(sub);

        const switched = await sendAndWait(`/cwd ${sub}`);
        expect(switched.text).toContain("工作目录已切换到");
        expect(await agent.getSessionCwd(sessionB)).toBe(sub);

        expect((await sendAndWait("/cwd")).text).toContain(sub);
    });

    test("/model effort 查看与设置（唯一强度入口）", async () => {
        const viewed = await sendAndWait("/model effort");
        expect(viewed.text).toContain("当前思考强度");

        const invalid = await sendAndWait("/model effort definitely-not-an-effort");
        expect(invalid.text).toContain("未知思考强度");
        expect((await sendAndWait("/model effort auto")).text).toContain("已设为：auto");
        expect((await sendAndWait("/model effort low")).text).toContain("已设为：low");
        expect((await sendAndWait("/model effort")).text).toContain("low");
        expect(agent.isSessionBusy(sessionB)).toBe(false);
    });

    test("已合并的 /effort /thinking /reasoning 不再被识别：按普通文本交给模型", async () => {
        for (const command of ["/effort high", "/thinking auto", "/reasoning on"]) {
            const result = await sendAndWait(command);
            expect(result.stopReason).toBe("stop");
            expect(targetQueries().at(-1)).toContain(command);
        }
        expect(agent.isSessionBusy(sessionB)).toBe(false);
    });

    test("/model 查看与设置：不可用组合明确报错", async () => {
        const viewed = await sendAndWait("/model");
        expect(viewed.text).toContain("当前模型");
        expect(viewed.text).toContain("思考强度");

        const failed = await sendAndWait("/model responses not-configured-model");
        expect(failed.ok).toBe(false);
        expect(failed.text).toContain("不可用的模型组合");

        const badEffort = await sendAndWait("/model chat_completions stub-model turbo");
        expect(badEffort.ok).toBe(false);
        expect(badEffort.text).toContain("未知思考强度");
        expect(agent.isSessionBusy(sessionB)).toBe(false);
    });

    test("/model 按目标模型的档位校验并归一化（与 TUI 同口径）", async () => {
        const saved = {
            chatModel: process.env.OPENAI_CHAT_MODEL,
            responsesModel: process.env.OPENAI_RESPONSES_MODEL,
            chatBase: process.env.OPENAI_CHAT_BASE_URL,
            responsesBase: process.env.OPENAI_RESPONSES_BASE_URL,
        };
        // 当前模型 deepseek 系（none/low/high/max），目标 responses 系（含 medium、没有 max）
        process.env.OPENAI_CHAT_MODEL = "deepseek-chat";
        process.env.OPENAI_CHAT_BASE_URL = "https://api.deepseek.com/v1";
        process.env.OPENAI_RESPONSES_MODEL = "gpt-5";
        process.env.OPENAI_RESPONSES_BASE_URL = "https://api.openai.com/v1";
        try {
            // 先把当前选择设成 deepseek/max
            expect((await sendAndWait("/model chat_completions deepseek-chat max")).ok).toBe(true);

            // 目标模型支持 medium：成功并落盘
            const medium = await sendAndWait("/model responses gpt-5 medium");
            expect(medium.ok).toBe(true);
            const afterMedium = JSON.parse((await sendAndWait("/model --json")).text);
            expect(afterMedium.current).toMatchObject({
                protocol: "responses",
                model: "gpt-5",
                reasoningEffort: "medium",
            });

            // 归一化：大写 HIGH → high
            expect((await sendAndWait("/model responses gpt-5 HIGH")).text).toContain("思考强度 high");

            // 目标模型不支持 max：明确报错
            const max = await sendAndWait("/model responses gpt-5 max");
            expect(max.ok).toBe(false);
            expect(max.text).toContain("未知思考强度");

            // 省略强度：原档位（deepseek/max）在目标模型不支持 → 回落 auto
            expect((await sendAndWait("/model chat_completions deepseek-chat max")).ok).toBe(true);
            expect((await sendAndWait("/model responses gpt-5")).text).toContain("思考强度 auto");
            expect(agent.isSessionBusy(sessionB)).toBe(false);
        } finally {
            for (const [key, value] of Object.entries({
                OPENAI_CHAT_MODEL: saved.chatModel,
                OPENAI_RESPONSES_MODEL: saved.responsesModel,
                OPENAI_CHAT_BASE_URL: saved.chatBase,
                OPENAI_RESPONSES_BASE_URL: saved.responsesBase,
            })) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });

    test("/mcp 视图可用（无 MCP 配置时如实说明）", async () => {
        const viewed = await sendAndWait("/mcp");
        expect(viewed.ok).toBe(true);
        expect(viewed.text).toMatch(/MCP 服务|没有配置 MCP 服务/);
        expect(agent.isSessionBusy(sessionB)).toBe(false);
    });

    test("连续命令后仍可再次投递（互斥不泄漏）", async () => {
        for (const text of ["/help", "/keys", "/cwd", "/help extra", "/sessions"]) {
            await sendAndWait(text);
            expect(agent.isSessionBusy(sessionB)).toBe(false);
        }
        expect((await sendAndWait("/help")).ok).toBe(true);
    });
});
