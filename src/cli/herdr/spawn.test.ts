import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HerdrCliError, parseHerdrArgs, type SpawnCommand } from "./args.js";
import type { CreateTabInput, CreatedTab, HerdrCli, HerdrPaneMeta, HerdrTabMeta } from "./client.js";
import { runSpawn, type FirstInputDelivery, type SpawnDeps } from "./spawn.js";

const SESSION_ID = "01JVZ0J8V0RZ8Q3P9Y4W1Z6K2B";
const MSG_ID = "01JVZ0J8V0RZ8Q3P9Y4W1Z6K2Z";

const HERDR_ENV = {
    HERDR_ENV: "1",
    HERDR_BIN_PATH: "/opt/homebrew/bin/herdr",
    HERDR_WORKSPACE_ID: "w24",
    HERDR_TAB_ID: "w24:t5",
    HERDR_PANE_ID: "w24:p6",
} as NodeJS.ProcessEnv;

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-herdr-spawn-"));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface FakeHerdr {
    cli: HerdrCli;
    created?: CreateTabInput;
    ran?: { paneId: string; command: string };
}

function fakeHerdr(overrides: Partial<HerdrCli> = {}): FakeHerdr {
    const calls: FakeHerdr = {
        cli: {
            async createTab(input): Promise<CreatedTab> {
                calls.created = input;
                return { tabId: "w24:t9", paneId: "w24:p9" };
            },
            async runInPane(paneId, command): Promise<void> {
                calls.ran = { paneId, command };
            },
            async getTab(): Promise<HerdrTabMeta> {
                return {
                    tabId: "w24:t9",
                    workspaceId: "w24",
                    label: "复审",
                    number: 9,
                    paneCount: 1,
                    focused: false,
                    agentStatus: "idle",
                };
            },
            async getPane(): Promise<HerdrPaneMeta> {
                return {
                    paneId: "w24:p9",
                    tabId: "w24:t9",
                    workspaceId: "w24",
                    cwd: tmpDir,
                    foregroundCwd: tmpDir,
                    focused: false,
                    agent: "zbot",
                    agentStatus: "idle",
                    title: "复审",
                    tokens: { session: "1Z6K2B" },
                };
            },
            async listPanes(): Promise<HerdrPaneMeta[]> {
                return [];
            },
            async closeTab(): Promise<void> {
                // spawn 不关标签页
            },
            ...overrides,
        },
    };
    return calls;
}

function spawnCommand(overrides: Partial<SpawnCommand> = {}): SpawnCommand {
    return {
        kind: "spawn",
        text: "",
        title: "复审",
        cwd: tmpDir,
        focus: false,
        readyTimeoutSeconds: 30,
        json: true,
        ...overrides,
    };
}

/** 完整依赖：除了 herdr 与投递，其它都用桩，不碰磁盘与真实 socket。 */
function baseDeps(overrides: SpawnDeps = {}): { deps: SpawnDeps; herdr: FakeHerdr; writes: string[] } {
    const herdr = fakeHerdr();
    const writes: string[] = [];
    const deps: SpawnDeps = {
        env: HERDR_ENV,
        cwd: tmpDir,
        herdr: herdr.cli,
        createSession: async () => SESSION_ID,
        waitForClaim: async () => true,
        deliver: async (): Promise<FirstInputDelivery> => ({ msgId: MSG_ID, status: "delivered" }),
        write: (text) => { writes.push(text); },
        ...overrides,
    };
    return { deps, herdr, writes };
}

async function runJson(command: SpawnCommand, deps: SpawnDeps): Promise<Record<string, any>> {
    const writes: string[] = [];
    await runSpawn(command, { ...deps, write: (text) => { writes.push(text); } });
    return JSON.parse(writes.join("")) as Record<string, any>;
}

describe("parseHerdrArgs spawn", () => {
    test("--title 与 --cwd 必填", () => {
        expect(() => parseHerdrArgs(["spawn"])).toThrow(/需要 --title/);
        expect(() => parseHerdrArgs(["spawn", "文本", "--title=复审"])).toThrow(/需要 --cwd/);
        expect(() => parseHerdrArgs(["spawn", "--cwd", tmpDir])).toThrow(/需要 --title/);
    });

    test("默认值：不投递、不抢焦点、等 30s", () => {
        expect(parseHerdrArgs(["spawn", "--title", "复审", "--cwd", tmpDir])).toEqual(
            spawnCommand({ json: false }),
        );
    });

    test("首条输入与选项", () => {
        const parsed = parseHerdrArgs([
            "spawn", "修复", "lint", "--title=复审", "--label", "复审页", "--cwd", tmpDir,
            "--workspace", "w25", "--focus", "--ready-timeout=5", "--json",
        ]);

        expect(parsed).toEqual(spawnCommand({
            text: "修复 lint",
            title: "复审",
            label: "复审页",
            workspace: "w25",
            focus: true,
            readyTimeoutSeconds: 5,
        }));
    });

    test("-- 之后的正文允许以 - 开头", () => {
        expect(parseHerdrArgs(["spawn", "--title=复审", "--cwd", tmpDir, "--", "-p 看看这条"])).toEqual(
            spawnCommand({ text: "-p 看看这条", json: false }),
        );
    });

    test("空 --ready-timeout= 是用法错误而不是 0", () => {
        expect(() => parseHerdrArgs(["spawn", "--title=复审", "--cwd", tmpDir, "--ready-timeout="])).toThrow(/非负整数/);
    });

    test("未知参数与未知子命令报 usage", () => {
        expect(() => parseHerdrArgs(["spawn", "--title=复审", "--cwd", tmpDir, "--nope"])).toThrow(HerdrCliError);
        expect(() => parseHerdrArgs(["tab"])).toThrow(/未知子命令/);
    });
});

describe("runSpawn", () => {
    test("建标签页 → 认领 → 投递，并回传会话与 herdr 元数据", async () => {
        const { deps, herdr } = baseDeps();
        const delivered: { sessionId: string; text: string }[] = [];
        const result = await runJson(
            spawnCommand({ text: "只读复审一次" }),
            {
                ...deps,
                deliver: async (input) => {
                    delivered.push(input);
                    return { msgId: MSG_ID, status: "delivered" };
                },
            },
        );

        expect(herdr.created).toEqual({ workspaceId: "w24", cwd: tmpDir, label: "复审", focus: false });
        expect(herdr.ran).toEqual({ paneId: "w24:p9", command: `zbot resume ${SESSION_ID}` });
        expect(delivered).toEqual([{ sessionId: SESSION_ID, text: "只读复审一次" }]);

        expect(result.sessionId).toBe(SESSION_ID);
        expect(result.title).toBe("复审");
        expect(result.delivered).toBe(true);
        expect(result.msgId).toBe(MSG_ID);
        expect(result.commands).toEqual({
            wait: `zbot session wait ${SESSION_ID} --msg=${MSG_ID}`,
            send: `zbot session send ${SESSION_ID} "<文本>"`,
            show: `zbot session show ${SESSION_ID}`,
            archive: `zbot session send ${SESSION_ID} "/archive"`,
            close: `zbot session send ${SESSION_ID} "/close"`,
            closeTab: "herdr tab close w24:t9",
            teardown: `zbot herdr teardown ${SESSION_ID} --tab w24:t9`,
            sendAndWait: `zbot session send ${SESSION_ID} "<文本>" --wait`,
        });
        expect(result.hints.current).toContain("--msg=");
        expect(result.hints.later).toContain("--wait");
        expect(result.hints.observe).toContain(`zbot session show ${SESSION_ID}`);
        expect(result.hints.observe).toContain("herdr pane read w24:p9");
        expect(result.hints.observe).toContain("herdr pane get w24:p9");

        expect(result.herdr).toMatchObject({
            workspaceId: "w24",
            tabId: "w24:t9",
            paneId: "w24:p9",
            tab: { label: "复审", number: 9, paneCount: 1, agentStatus: "idle" },
            pane: { agent: "zbot", agentStatus: "idle", cwd: tmpDir, tokens: { session: "1Z6K2B" } },
            caller: { workspaceId: "w24", tabId: "w24:t5", paneId: "w24:p6" },
        });
    });

    test("把状态目录转发给新 pane（新 pane 继承的是 herdr server 的环境）", async () => {
        const { deps, herdr } = baseDeps({
            env: { ...HERDR_ENV, ZBOT_STATE_DIR: "/tmp/state-x", ZBOT_CONFIG_FILE: "/tmp/config-x.yaml" },
        });
        await runJson(spawnCommand(), deps);

        expect(herdr.created?.env).toEqual({ ZBOT_STATE_DIR: "/tmp/state-x", ZBOT_CONFIG_FILE: "/tmp/config-x.yaml" });
    });

    test("没有首条输入：不投递，命令里没有死掉的 wait", async () => {
        const { deps } = baseDeps({ deliver: async () => { throw new Error("不该投递"); } });
        const result = await runJson(spawnCommand({ label: "zbot 复审" }), deps);

        expect(result.delivered).toBe(false);
        expect(result.msgId).toBeNull();
        expect(result.commands.wait).toBeUndefined();
        expect(result.hints.current).toBeUndefined();
        expect(result.hints.later).toContain("--wait");
    });

    test("--ready-timeout=0 且有正文：不轮询认领，投递失败要带上 tab/pane 与接手命令", async () => {
        const claim = () => { throw new Error("不该等认领"); };
        const { deps } = baseDeps({
            waitForClaim: claim,
            deliver: async () => {
                const error = new Error("no holder") as Error & { code?: string };
                error.code = "no_holder";
                throw error;
            },
        });

        const error = await runSpawn(spawnCommand({ text: "跑一下", readyTimeoutSeconds: 0 }), deps)
            .catch((caught: unknown) => caught);
        expect((error as HerdrCliError).code).toBe("not_ready");
        expect((error as HerdrCliError).details).toMatchObject({
            sessionId: SESSION_ID,
            tabId: "w24:t9",
            paneId: "w24:p9",
            delivered: false,
            cause: "no_holder",
            teardownCommand: `zbot herdr teardown ${SESSION_ID} --tab=w24:t9`,
        });
    });

    test("投递被拒（busy 等）：错误里同样带 tab/pane 与收尾命令", async () => {
        const { deps } = baseDeps({
            deliver: async () => {
                const error = new Error("会话忙") as Error & { code?: string };
                error.code = "busy";
                throw error;
            },
        });

        const error = await runSpawn(spawnCommand({ text: "跑一下" }), deps).catch((caught: unknown) => caught);
        expect((error as HerdrCliError).code).toBe("busy");
        expect((error as HerdrCliError).details).toMatchObject({
            delivered: false,
            cause: "busy",
            tabId: "w24:t9",
            teardownCommand: `zbot herdr teardown ${SESSION_ID} --tab=w24:t9`,
        });
    });

    test("不在 herdr 里：报 herdr_unavailable 且不建会话", async () => {
        let created = false;
        const { deps } = baseDeps({
            env: { HERDR_ENV: "0" } as NodeJS.ProcessEnv,
            createSession: async () => {
                created = true;
                return SESSION_ID;
            },
        });

        const error = await runSpawn(spawnCommand(), deps).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(HerdrCliError);
        expect((error as HerdrCliError).code).toBe("herdr_unavailable");
        expect(created).toBe(false);
    });

    test("标签页建不起来：错误里给接手/清理命令", async () => {
        const { deps } = baseDeps({
            herdr: fakeHerdr({
                createTab: async () => { throw new HerdrCliError("herdr_failed", "boom"); },
            }).cli,
        });

        const error = await runSpawn(spawnCommand(), deps).catch((caught: unknown) => caught);
        expect((error as HerdrCliError).code).toBe("herdr_failed");
        expect((error as HerdrCliError).details).toMatchObject({
            sessionId: SESSION_ID,
            resumeCommand: `zbot resume ${SESSION_ID}`,
            deleteCommand: `zbot session delete ${SESSION_ID}`,
        });
    });

    test("pane 里起不了 zbot：错误里带标签页与 teardown", async () => {
        const { deps } = baseDeps({
            herdr: fakeHerdr({
                runInPane: async () => { throw new HerdrCliError("herdr_failed", "pane run 失败"); },
            }).cli,
        });

        const error = await runSpawn(spawnCommand(), deps).catch((caught: unknown) => caught);
        expect((error as HerdrCliError).code).toBe("herdr_failed");
        expect((error as HerdrCliError).details).toMatchObject({
            tabId: "w24:t9",
            paneId: "w24:p9",
            teardownCommand: `zbot herdr teardown ${SESSION_ID} --tab=w24:t9`,
            closeTabCommand: "herdr tab close w24:t9",
        });
    });

    test("TUI 迟迟不认领：not_ready 带标签页与重投提示", async () => {
        const { deps } = baseDeps({ waitForClaim: async () => false });

        const error = await runSpawn(spawnCommand({ text: "跑一下" }), deps).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(HerdrCliError);
        expect((error as HerdrCliError).code).toBe("not_ready");
        expect((error as HerdrCliError).details).toMatchObject({
            sessionId: SESSION_ID,
            tabId: "w24:t9",
            paneId: "w24:p9",
            delivered: false,
        });
    });

    test("herdr 元数据读不到不影响结果", async () => {
        const { deps } = baseDeps();
        const result = await runJson(spawnCommand(), {
            ...deps,
            herdr: {
                ...(deps.herdr as HerdrCli),
                getTab: async () => { throw new Error("tab get 失败"); },
                getPane: async () => { throw new Error("pane get 失败"); },
            },
        });

        expect(result.herdr.tab).toBeNull();
        expect(result.herdr.pane).toBeNull();
    });
});
