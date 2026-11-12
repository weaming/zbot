import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
    buildConversationHistory,
    buildSystemPrompt,
    formatChatProviderError,
    getChatApiSettings,
    buildSystemPrompt,
    validateChatApiSettings,
} from "../../src/services/chat-runtime.js";
import { setEmbeddedIdentity } from "../../src/skills/base-skill.js";
import { skillRegistry } from "../../src/skills/skill-registry.js";
import { appendCompletedTurn, getSessionContextHistory } from "../../src/utils/conversation-history.js";
import type { Session } from "../../src/types/session.js";
import { isolateModelEnv, useTmpStateDir, type TmpStateDir } from "./test-env.js";
import { toolCatalog } from "../../src/tools/tool-catalog.js";

let tmpDir: string;
let stateDir: TmpStateDir;
let previousTuiCwd: string | undefined;

async function resetSkillRegistryToEmptyState(): Promise<void> {
    const previousStateDir = process.env.ZBOT_STATE_DIR;
    const emptyStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-chat-runtime-empty-"));
    process.env.ZBOT_STATE_DIR = emptyStateDir;
    await skillRegistry.load();
    if (previousStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = previousStateDir;
    fs.rmSync(emptyStateDir, { recursive: true, force: true });
}

function expectNextRequestToReusePrefix(completedTranscript: any[], nextRequest: any[]): void {
    expect(JSON.stringify(nextRequest.slice(0, completedTranscript.length))).toBe(JSON.stringify(completedTranscript));
}

beforeEach(async () => {
    stateDir = useTmpStateDir("zbot-chat-runtime-test-");
    tmpDir = stateDir.dir;
    previousTuiCwd = process.env.TUI_CWD;
    await resetSkillRegistryToEmptyState();
    process.env.TUI_CWD = tmpDir;
});

afterEach(async () => {
    await resetSkillRegistryToEmptyState();
    if (previousTuiCwd === undefined) delete process.env.TUI_CWD;
    else process.env.TUI_CWD = previousTuiCwd;
    stateDir.cleanup();
});

describe("chat runtime", () => {
    test("keeps the completed request transcript as the next request's byte-identical prefix", () => {
        const session: Session = {
            sessionId: "01J00000000000000000000000",
            cwd: path.resolve(tmpDir),
            contextEpochId: "01J00000000000000000000001",
            turns: [],
            contextState: { startedAt: "2026-01-01T00:00:00+08:00", reason: "session_start", sourceUserTurnCount: 0, retainedUserTurnCount: 0 },
            totalUserTurnCount: 0,
            hardTrimCount: 0,
            compactCount: 0,
        };
        const systemMessage = { role: "system", content: "stable system prompt" };
        const assistantMessage = {
            role: "assistant" as const,
            content: "",
            reasoning_content: "reasoning",
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "tool", arguments: "{}" } }],
        };
        const toolMessage = { role: "tool" as const, tool_call_id: "call_1", name: "tool", content: "result" };
        // 上行形态：name 属本地渲染元数据，请求里只留 content/role/tool_call_id
        const promptToolMessage = { role: "tool" as const, tool_call_id: "call_1", content: "result" };
        const finalMessage = { role: "assistant" as const, content: "answer", reasoning_content: "final reasoning" };
        appendCompletedTurn(session, ["first question"], [assistantMessage, toolMessage, finalMessage], true);

        const completedTranscript = [systemMessage, { role: "user", content: "first question" }, assistantMessage, promptToolMessage, finalMessage];
        const nextRequest = [systemMessage, ...getSessionContextHistory(session), { role: "user", content: "second question" }];

        expectNextRequestToReusePrefix(completedTranscript, nextRequest);
    });

    test("buildConversationHistory preserves session history and appends pending messages before the query", () => {
        const history = buildConversationHistory(
            {
                turns: [{
                    id: "t1",
                    status: "completed",
                    messages: [{ id: "m1", createdAt: "2026-01-01T00:00:00+08:00", role: "assistant", content: "already there" }],
                }],
            } as any,
            ["first", "second"],
        );

        // 历史消息带内部 id（token / 投影缓存按它记账）；待发的 pending 消息不需要
        expect(history.map(({ id: _id, ...rest }: any) => rest)).toEqual([
            { role: "assistant", content: "already there" },
            { role: "user", content: "first" },
        ]);
        expect(typeof (history[0] as any).id).toBe("string");
    });

    test("buildSystemPrompt includes identity and the complete skill listing", async () => {
        fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "你是测试身份。", "utf-8");
        const skillDir = path.join(tmpDir, "skills", "alpha");
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
            path.join(skillDir, "SKILL.md"),
            `---
name: alpha
description: Alpha skill
---
Alpha prompt body`,
            "utf-8",
        );

        await skillRegistry.load();

        const prompt = buildSystemPrompt();

        expect(prompt).toContain("你是测试身份");
        expect(prompt).toContain("## 可用技能");
        expect(prompt).toContain("Alpha skill");
        // 技能正文只经 use_skill 注入，不进 system prompt
        expect(prompt).not.toContain("Alpha prompt body");
        expect(prompt.indexOf("你是测试身份")).toBeLessThan(prompt.indexOf("## 可用技能"));
    });

    test("buildSystemPrompt appends the optional extra identity file", () => {
        const identityFile = path.join(tmpDir, "tui-AGENTS.md");
        const extraIdentityFile = path.join(tmpDir, "user-AGENTS.md");
        fs.writeFileSync(identityFile, "TUI 身份", "utf-8");
        fs.writeFileSync(extraIdentityFile, "用户级补充规则", "utf-8");

        const previousIdentityFile = process.env.ZBOT_IDENTITY_FILE;
        const previousExtraIdentityFile = process.env.ZBOT_EXTRA_IDENTITY_FILE;
        process.env.ZBOT_IDENTITY_FILE = identityFile;
        process.env.ZBOT_EXTRA_IDENTITY_FILE = extraIdentityFile;

        try {
            const prompt = buildSystemPrompt();
            expect(prompt.indexOf("TUI 身份")).toBeGreaterThanOrEqual(0);
            expect(prompt.indexOf("用户级补充规则")).toBeGreaterThan(prompt.indexOf("TUI 身份"));
        } finally {
            if (previousIdentityFile === undefined) delete process.env.ZBOT_IDENTITY_FILE;
            else process.env.ZBOT_IDENTITY_FILE = previousIdentityFile;
            if (previousExtraIdentityFile === undefined) delete process.env.ZBOT_EXTRA_IDENTITY_FILE;
            else process.env.ZBOT_EXTRA_IDENTITY_FILE = previousExtraIdentityFile;
        }
    });

    test("buildSystemPrompt uses the embedded identity before the optional extra file", () => {
        const extraIdentityFile = path.join(tmpDir, "user-AGENTS.md");
        fs.writeFileSync(extraIdentityFile, "用户级补充规则", "utf-8");
        const previousExtraIdentityFile = process.env.ZBOT_EXTRA_IDENTITY_FILE;
        const previousTuiCwd = process.env.TUI_CWD;
        process.env.ZBOT_EXTRA_IDENTITY_FILE = extraIdentityFile;
        process.env.TUI_CWD = "/tmp/tui-working-directory";
        setEmbeddedIdentity("内置 TUI 身份\n当前目录（pwd）：{{TUI_CWD}}");

        try {
            const prompt = buildSystemPrompt();
            expect(prompt.indexOf("内置 TUI 身份")).toBeGreaterThanOrEqual(0);
            expect(prompt).toContain("当前目录（pwd）：/tmp/tui-working-directory");
            expect(prompt.indexOf("用户级补充规则")).toBeGreaterThan(prompt.indexOf("内置 TUI 身份"));
        } finally {
            setEmbeddedIdentity();
            if (previousExtraIdentityFile === undefined) delete process.env.ZBOT_EXTRA_IDENTITY_FILE;
            else process.env.ZBOT_EXTRA_IDENTITY_FILE = previousExtraIdentityFile;
            if (previousTuiCwd === undefined) delete process.env.TUI_CWD;
            else process.env.TUI_CWD = previousTuiCwd;
        }
    });

    test("身份文件里注入的路径把 HOME 前缀显示为 ~", () => {
        const home = os.homedir();
        const extraIdentityFile = path.join(tmpDir, "user-AGENTS.md");
        fs.writeFileSync(extraIdentityFile, "用户级补充规则", "utf-8");
        const previousExtraIdentityFile = process.env.ZBOT_EXTRA_IDENTITY_FILE;
        process.env.ZBOT_EXTRA_IDENTITY_FILE = extraIdentityFile;
        setEmbeddedIdentity("当前目录：{{TUI_CWD}}；源码：{{TUI_SRC_ROOT}}");

        try {
            const prompt = buildSystemPrompt(path.join(home, "src", "zbot"));
            expect(prompt).toContain("当前目录：~/src/zbot");
            expect(prompt).not.toContain(`${home}/src/zbot`);
        } finally {
            setEmbeddedIdentity();
            if (previousExtraIdentityFile === undefined) delete process.env.ZBOT_EXTRA_IDENTITY_FILE;
            else process.env.ZBOT_EXTRA_IDENTITY_FILE = previousExtraIdentityFile;
        }
    });

    test("buildSystemPrompt always includes the complete skill listing", async () => {
        const skillDir = path.join(tmpDir, "skills", "beta");
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(
            path.join(skillDir, "SKILL.md"),
            `---
name: beta
description: Beta skill
---
Beta prompt body`,
            "utf-8",
        );

        await skillRegistry.load();

        const prompt = buildSystemPrompt();

        expect(prompt).toContain("## 可用技能");
        expect(prompt).toContain("- beta: Beta skill");
    });

    test("buildSystemPrompt sorts the skill listing by name", async () => {
        for (const skillName of ["zeta", "alpha"]) {
            const skillDir = path.join(tmpDir, "skills", skillName);
            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(
                path.join(skillDir, "SKILL.md"),
                `---\nname: ${skillName}\ndescription: ${skillName} skill\n---\nbody`,
                "utf-8",
            );
        }
        await skillRegistry.load();

        const prompt = buildSystemPrompt();

        expect(prompt.indexOf("- alpha: alpha skill")).toBeLessThan(
            prompt.indexOf("- zeta: zeta skill"),
        );
    });

    test("session system prompt 逐次构建，身份文件改动立即生效", () => {
        const session = { cwd: tmpDir };

        fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "初始 TUI 规则", "utf-8");
        const initialPrompt = buildSystemPrompt(session.cwd);
        fs.writeFileSync(path.join(tmpDir, "AGENTS.md"), "更新后的 TUI 规则", "utf-8");
        const laterPrompt = buildSystemPrompt(session.cwd);

        expect(initialPrompt).toContain("初始 TUI 规则");
        expect(laterPrompt).toContain("更新后的 TUI 规则");
        expect(laterPrompt).not.toBe(initialPrompt);
        expect(Object.keys(session)).toEqual(["cwd"]);
    });

    test("技能集合变化后 session system prompt 跟着变", async () => {
        const skillPath = path.join(tmpDir, "skills", "reloadable", "SKILL.md");
        fs.mkdirSync(path.dirname(skillPath), { recursive: true });
        fs.writeFileSync(skillPath, "---\nname: reloadable\ndescription: 初始描述\n---\n初始指令", "utf-8");
        await skillRegistry.load();

        const session = { cwd: tmpDir };
        const initialPrompt = buildSystemPrompt(session.cwd);

        fs.writeFileSync(skillPath, "---\nname: reloadable\ndescription: 更新描述\n---\n更新指令", "utf-8");
        fs.utimesSync(skillPath, new Date(), new Date(Date.now() + 1_000));
        await skillRegistry.load();

        const reloadedPrompt = buildSystemPrompt(session.cwd);
        expect(reloadedPrompt).not.toBe(initialPrompt);
        expect(reloadedPrompt).toContain("更新描述");
    });

});

describe("system prompt PWD 与会话绑定目录一致", () => {
    const identityTemplate = "## 当前环境\n- 当前目录（`PWD`）：`{{TUI_CWD}}`";

    function makeSession(cwd: string) {
        return {
            sessionId: "01J00000000000000000000000",
            cwd,
            contextEpochId: "01J00000000000000000000001",
            turns: [],
            contextState: { startedAt: "2026-01-01T00:00:00+08:00", reason: "session_start" as const, sourceUserTurnCount: 0, retainedUserTurnCount: 0 },
            totalUserTurnCount: 0,
            hardTrimCount: 0,
            compactCount: 0,
        };
    }

    beforeEach(() => {
        setEmbeddedIdentity(identityTemplate);
        process.env.TUI_CWD = "/global/activated/cwd";
    });

    afterEach(() => {
        setEmbeddedIdentity(undefined);
        delete process.env.TUI_CWD;
    });

    test("PWD 取自各会话绑定 cwd，不被全局 TUI_CWD 污染", () => {
        const sessionA = makeSession("/sessions/a");
        const sessionB = makeSession("/sessions/b");

        const promptA = buildSystemPrompt(sessionA.cwd);
        expect(promptA).toContain("/sessions/a");
        expect(promptA).not.toContain("/global/activated/cwd");

        const promptB = buildSystemPrompt(sessionB.cwd);
        expect(promptB).toContain("/sessions/b");
        expect(promptA).toContain("/sessions/a");
    });

    test("全局 TUI_CWD 变化不改变会话绑定目录的 PWD", () => {
        const sessionA = makeSession("/sessions/a");
        const first = buildSystemPrompt(sessionA.cwd);

        process.env.TUI_CWD = "/switched/to/other";
        const second = buildSystemPrompt(sessionA.cwd);

        expect(first).toContain("/sessions/a");
        expect(second).toContain("/sessions/a");
        expect(second).not.toContain("/switched/to/other");
    });

    test("会话 cwd 改变后 prompt 跟着换 PWD", () => {
        const sessionA = makeSession("/sessions/a");
        const before = buildSystemPrompt(sessionA.cwd);

        sessionA.cwd = "/sessions/b";
        const after = buildSystemPrompt(sessionA.cwd);

        expect(before).toContain("/sessions/a");
        expect(after).toContain("/sessions/b");
        expect(after).not.toContain("/sessions/a");
    });
});

describe("chat provider settings", () => {
    test("接受有效的 OpenAI 兼容配置", () => {
        expect(validateChatApiSettings({
            apiKey: "key",
            apiBase: "https://example.com/v1",
            model: "model",
        })).toBeUndefined();
    });

    test("允许省略模型，由服务端选择默认模型", () => {
        expect(validateChatApiSettings({
            apiKey: "key",
            apiBase: "http://127.0.0.1:3030/v1",
            model: "",
        })).toBeUndefined();
    });

    test("拒绝缺少密钥、模型和非法地址", () => {
        expect(validateChatApiSettings({
            apiKey: "",
            apiBase: "https://example.com/v1",
            model: "model",
        })).toContain("OPENAI_API_KEY");

        expect(validateChatApiSettings({
            apiKey: "key",
            apiBase: "not-a-url",
            model: "model",
        })).toContain("OPENAI_BASE_URL");

    });

    test("密钥写成 $NAME 时取被引用的环境变量", () => {
        const restore = isolateModelEnv();
        process.env.ZBOT_TEST_KEY_TARGET = "sk-referenced";
        process.env.OPENAI_CHAT_API_KEY = "$ZBOT_TEST_KEY_TARGET";
        process.env.OPENAI_CHAT_MODEL = "gpt-5";
        try {
            const settings = getChatApiSettings();

            expect(settings.apiKey).toBe("sk-referenced");
            expect(validateChatApiSettings(settings)).toBeUndefined();
        } finally {
            delete process.env.ZBOT_TEST_KEY_TARGET;
            restore();
        }
    });

    test("引用落空时报错点明指向的变量", () => {
        const restore = isolateModelEnv();
        process.env.OPENAI_CHAT_API_KEY = "${ZBOT_TEST_KEY_MISSING}";
        process.env.OPENAI_CHAT_MODEL = "gpt-5";
        try {
            expect(validateChatApiSettings(getChatApiSettings()))
                .toContain("OPENAI_CHAT_API_KEY=$ZBOT_TEST_KEY_MISSING 引用的环境变量 ZBOT_TEST_KEY_MISSING 未设置");
        } finally {
            restore();
        }
    });

    test("将限流错误转换为可操作提示", () => {
        const error = Object.assign(new Error("Monthly usage limit reached"), { status: 429 });
        const message = formatChatProviderError(error);

        expect(message).toContain("HTTP 429");
        expect(message).toContain("额度已用尽");
        expect(message).toContain("Monthly usage limit reached");
    });

    test("从 provider 原始错误文本识别 HTTP 状态", () => {
        const message = formatChatProviderError("429 Weekly usage limit reached");

        expect(message).toContain("HTTP 429");
        expect(message).toContain("额度已用尽");
    });

    test("为其他 HTTP 错误保留状态码", () => {
        const message = formatChatProviderError(Object.assign(new Error("upstream failure"), { status: 500 }));

        expect(message).toBe("LLM provider 请求失败（HTTP 500）：upstream failure");
    });
});
