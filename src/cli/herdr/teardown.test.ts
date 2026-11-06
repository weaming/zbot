import { describe, expect, test } from "bun:test";
import { HerdrCliError, parseHerdrArgs, type TeardownCommand } from "./args.js";
import type { HerdrCli, HerdrPaneMeta } from "./client.js";
import { runTeardown, type TeardownDeps } from "./teardown.js";

const SESSION_ID = "01JVZ0J8V0RZ8Q3P9Y4W1Z6K2B";
const HERDR_ENV = {
    HERDR_ENV: "1",
    HERDR_BIN_PATH: "/opt/homebrew/bin/herdr",
    HERDR_WORKSPACE_ID: "w24",
} as NodeJS.ProcessEnv;

function pane(overrides: Partial<HerdrPaneMeta> = {}): HerdrPaneMeta {
    return {
        paneId: "w24:p9",
        tabId: "w24:t9",
        workspaceId: "w24",
        cwd: "/tmp",
        foregroundCwd: "/tmp",
        focused: false,
        agent: "zbot",
        agentStatus: "idle",
        title: "复审",
        tokens: { session: "1Z6K2B" },
        ...overrides,
    };
}

interface Harness {
    deps: TeardownDeps;
    calls: { archiveViaHolder: number; archiveLocally: number; closedTabs: string[] };
}

function harness(overrides: TeardownDeps = {}, panes: HerdrPaneMeta[] = [pane()]): Harness {
    const calls = { archiveViaHolder: 0, archiveLocally: 0, closedTabs: [] as string[] };
    const herdr: HerdrCli = {
        createTab: async () => { throw new Error("不该建标签页"); },
        runInPane: async () => { throw new Error("不该跑命令"); },
        getTab: async () => undefined,
        getPane: async paneId => panes.find(item => item.paneId === paneId),
        listPanes: async () => panes,
        closeTab: async (tabId) => { calls.closedTabs.push(tabId); },
    };
    const deps: TeardownDeps = {
        env: HERDR_ENV,
        herdr,
        ownership: async () => ({
            state: "other",
            info: { pid: 1, instanceId: "x", sessionId: SESSION_ID, busy: false, pending: 0, queued: 0 },
        }),
        resolveId: async () => SESSION_ID,
        // 默认「已归档」：持有者路径不必等确认窗口
        readMeta: async () => ({ title: "复审", archived: true }),
        archiveViaHolder: async () => { calls.archiveViaHolder += 1; },
        archiveLocally: async () => { calls.archiveLocally += 1; },
        ...overrides,
    };
    return { deps, calls };
}

function cmd(overrides: Partial<TeardownCommand> = {}): TeardownCommand {
    return { kind: "teardown", id: SESSION_ID, json: true, ...overrides };
}

async function runJson(command: TeardownCommand, deps: TeardownDeps): Promise<Record<string, any>> {
    const writes: string[] = [];
    await runTeardown(command, { ...deps, write: (text) => { writes.push(text); } });
    return JSON.parse(writes.join("")) as Record<string, any>;
}

describe("parseHerdrArgs teardown", () => {
    test("id 与 --tab / --pane / --workspace / --json", () => {
        expect(parseHerdrArgs(["teardown", SESSION_ID, "--json"])).toEqual(cmd());
        expect(parseHerdrArgs(["teardown", SESSION_ID, "--tab=w24:t9"])).toEqual(
            cmd({ tab: "w24:t9", json: false }),
        );
        expect(parseHerdrArgs(["teardown", SESSION_ID, "--pane", "w24:p9", "--json"])).toEqual(
            cmd({ pane: "w24:p9" }),
        );
        expect(parseHerdrArgs(["teardown", SESSION_ID, "--workspace=w25", "--json"])).toEqual(
            cmd({ workspace: "w25" }),
        );
    });

    test("缺 id / 多 id / 未知参数都报 usage", () => {
        expect(() => parseHerdrArgs(["teardown"])).toThrow(/用法/);
        expect(() => parseHerdrArgs(["teardown", SESSION_ID, "extra"])).toThrow(/只接受一个/);
        expect(() => parseHerdrArgs(["teardown", SESSION_ID, "--nope"])).toThrow(HerdrCliError);
    });
});

describe("runTeardown", () => {
    test("有持有者：投递 /archive 后关标签页，归档状态回传为已确认", async () => {
        const { deps, calls } = harness();
        const result = await runJson(cmd(), deps);

        expect(calls.archiveViaHolder).toBe(1);
        expect(calls.archiveLocally).toBe(0);
        expect(calls.closedTabs).toEqual(["w24:t9"]);
        expect(result).toMatchObject({
            sessionId: SESSION_ID,
            delivered: true,
            archived: true,
            herdr: { tabId: "w24:t9", paneId: "w24:p9", tabClosed: true },
            commands: { show: `zbot session show ${SESSION_ID}` },
        });
    });

    test("确认窗口内看不到归档落盘：archived 为 null，人读文案不谎称已归档", async () => {
        const writes: string[] = [];
        const { deps } = harness({ readMeta: async () => ({ title: "复审", archived: false }) });
        await runTeardown(cmd({ json: false }), { ...deps, write: (text) => { writes.push(text); } });

        const text = writes.join("");
        expect(text).toContain("未在本轮确认");
        expect(text).not.toContain("会话已归档并释放");
    });

    test("持有者刚好退出（no_holder）：退回自己落盘归档，不整条失败", async () => {
        const { deps, calls } = harness({
            archiveViaHolder: async () => {
                const error = new Error("no holder") as Error & { code?: string };
                error.code = "no_holder";
                throw error;
            },
            // 基线未归档，确认窗口里变成已归档（模拟持有者把 archived 写进日志）
            readMeta: async () => ({ title: "复审", archived: calls.archiveLocally > 0 }),
        });
        const result = await runJson(cmd(), deps);

        expect(calls.archiveLocally).toBe(1);
        expect(result).toMatchObject({ delivered: false, archived: true, herdr: { tabClosed: true } });
    });

    test("正在执行回合：拒绝，不投递也不关标签页", async () => {
        const { deps, calls } = harness({
            ownership: async () => ({
                state: "other",
                info: { pid: 1, instanceId: "x", sessionId: SESSION_ID, busy: true, pending: 1, queued: 0 },
            }),
        });

        const error = await runTeardown(cmd(), deps).catch((caught: unknown) => caught);
        expect((error as HerdrCliError).code).toBe("busy");
        expect(calls.archiveViaHolder).toBe(0);
        expect(calls.closedTabs).toEqual([]);
    });

    test("无人持有且未归档：CLI 自己落盘归档，再关标签页", async () => {
        const { deps, calls } = harness({
            ownership: async () => ({ state: "free" }),
            readMeta: async () => ({ title: "复审", archived: false }),
        });
        const result = await runJson(cmd(), deps);

        expect(calls.archiveLocally).toBe(1);
        expect(result).toMatchObject({ delivered: false, archived: true, herdr: { tabClosed: true } });
    });

    test("无人持有且已归档：不重复写盘", async () => {
        const { deps, calls } = harness({ ownership: async () => ({ state: "free" }) });
        await runTeardown(cmd(), deps);

        expect(calls.archiveLocally).toBe(0);
        expect(calls.closedTabs).toEqual(["w24:t9"]);
    });

    test("--tab 优先，不再扫 pane；--pane 反查 tab", async () => {
        const byTab = await runJson(cmd({ tab: "w24:tA" }), harness({}, []).deps);
        expect(byTab.herdr).toMatchObject({ tabId: "w24:tA", tabClosed: true });

        const byPane = await runJson(cmd({ pane: "w24:p9" }), harness().deps);
        expect(byPane.herdr).toMatchObject({ tabId: "w24:t9", paneId: "w24:p9", tabClosed: true });
    });

    test("workspace 严格匹配：别的 workspace 的同名 tab 不会被误关", async () => {
        const result = await runJson(
            cmd(),
            harness({}, [pane({ workspaceId: "w25", tokens: null, title: "复审" })]).deps,
        );

        expect(result.herdr.tabClosed).toBe(false);
        expect(result.herdr.note).toContain("--tab");
    });

    test("--workspace 可指定匹配范围（spawn --workspace 到别的 workspace 时用）", async () => {
        const result = await runJson(
            cmd({ workspace: "w25" }),
            harness({}, [pane({ workspaceId: "w25" })]).deps,
        );

        expect(result.herdr).toMatchObject({ tabId: "w24:t9", tabClosed: true });
    });

    test("标签页关不掉：归档成果照样回传，note 说明原因", async () => {
        const herdr = {
            ...harness().deps.herdr as HerdrCli,
            closeTab: async () => { throw new Error("tab 已不存在"); },
        } as HerdrCli;
        const result = await runJson(cmd(), harness({ herdr }).deps);

        expect(result).toMatchObject({ delivered: true, archived: true, herdr: { tabClosed: false } });
        expect(result.herdr.note).toContain("tab 已不存在");
    });

    test("不在 herdr 里：herdr_unavailable，且不归档也不关标签页", async () => {
        const { deps, calls } = harness({ env: { HERDR_ENV: "0" } as NodeJS.ProcessEnv });

        const error = await runTeardown(cmd(), deps).catch((caught: unknown) => caught);
        expect((error as HerdrCliError).code).toBe("herdr_unavailable");
        expect(calls.archiveViaHolder + calls.archiveLocally).toBe(0);
        expect(calls.closedTabs).toEqual([]);
    });
});
