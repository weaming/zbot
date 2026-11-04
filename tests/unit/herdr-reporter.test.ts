/** herdr 上报器单测：环境探测、状态/metadata 参数、seq、串行顺序、错误与 release。 */

import { afterEach, describe, expect, test } from "bun:test";
import { HerdrReporter, readHerdrContext, type HerdrRunner } from "../../src/tui/herdr-reporter.js";

const CONTEXT = { binPath: "/usr/local/bin/herdr", paneId: "w1:p1" };

interface Recorder {
    calls: string[][];
    runner: HerdrRunner;
}

function recordRunner(): Recorder {
    const calls: string[][] = [];
    return {
        calls,
        runner: (_binPath, args) => {
            calls.push(args);
        },
    };
}

async function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("等待 herdr 调用超时");
        await new Promise(resolve => setTimeout(resolve, 1));
    }
}

describe("readHerdrContext", () => {
    const saved = {
        env: process.env.HERDR_ENV,
        binPath: process.env.HERDR_BIN_PATH,
        paneId: process.env.HERDR_PANE_ID,
    };

    afterEach(() => {
        const restore = [
            ["HERDR_ENV", saved.env],
            ["HERDR_BIN_PATH", saved.binPath],
            ["HERDR_PANE_ID", saved.paneId],
        ] as const;
        for (const [name, value] of restore) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    test("不在 herdr 内时返回 undefined", () => {
        delete process.env.HERDR_ENV;
        expect(readHerdrContext()).toBeUndefined();
    });

    test("HERDR_ENV=1 但缺 pane id 时返回 undefined", () => {
        process.env.HERDR_ENV = "1";
        process.env.HERDR_BIN_PATH = "/usr/local/bin/herdr";
        delete process.env.HERDR_PANE_ID;
        expect(readHerdrContext()).toBeUndefined();
    });

    test("环境变量齐全时返回上下文", () => {
        process.env.HERDR_ENV = "1";
        process.env.HERDR_BIN_PATH = "/usr/local/bin/herdr";
        process.env.HERDR_PANE_ID = "w1:p1";
        expect(readHerdrContext()).toEqual(CONTEXT);
    });
});

describe("HerdrReporter 状态上报", () => {
    test("无 herdr 上下文时全部 no-op", () => {
        const { calls, runner } = recordRunner();
        const reporter = new HerdrReporter(undefined, { runner });
        reporter.report("working");
        reporter.reportMetadata({ title: "T" });
        reporter.release();
        expect(calls).toEqual([]);
        expect(reporter.supported).toBe(false);
    });

    test("report 生成协议参数，seq 按时钟微秒递增", async () => {
        const { calls, runner } = recordRunner();
        let clock = 1000;
        const reporter = new HerdrReporter(CONTEXT, { runner, now: () => clock });
        reporter.report("working");
        clock = 1001;
        reporter.report("idle");
        await waitFor(() => calls.length === 2);

        expect(calls[0]).toEqual([
            "pane", "report-agent", "w1:p1",
            "--source", "custom:zbot", "--agent", "zbot",
            "--state", "working", "--seq", "1000000",
        ]);
        expect(calls[1]).toEqual([
            "pane", "report-agent", "w1:p1",
            "--source", "custom:zbot", "--agent", "zbot",
            "--state", "idle", "--seq", "1001000",
        ]);
    });

    test("强杀重启后 seq 仍大于上次上报", async () => {
        const first = recordRunner();
        new HerdrReporter(CONTEXT, { runner: first.runner, now: () => 1000 }).report("working");
        await waitFor(() => first.calls.length === 1);

        const second = recordRunner();
        // 真实重启至少晚 1ms：seq 以时钟微秒为下界，晚于上次进程即可
        new HerdrReporter(CONTEXT, { runner: second.runner, now: () => 1001 }).report("idle");
        await waitFor(() => second.calls.length === 1);
        expect(Number(second.calls[0].at(-1))).toBeGreaterThan(Number(first.calls[0].at(-1)));
    });

    test("状态与 message 都未变化时跳过；message 变化仍上报", async () => {
        const { calls, runner } = recordRunner();
        const reporter = new HerdrReporter(CONTEXT, { runner, now: () => 1000 });
        reporter.report("blocked", "provider 配置无效");
        reporter.report("blocked", "provider 配置无效");
        reporter.report("blocked", "等待用户作答");
        await waitFor(() => calls.length === 2);

        expect(calls[0].slice(-2)).toEqual(["--message", "provider 配置无效"]);
        expect(calls[1].slice(-2)).toEqual(["--message", "等待用户作答"]);
    });

    test("message 折成单行并截断", async () => {
        const { calls, runner } = recordRunner();
        new HerdrReporter(CONTEXT, { runner, now: () => 1000 })
            .report("blocked", `第一行\n第二行\t${"长".repeat(200)}`);
        await waitFor(() => calls.length === 1);
        const message = calls[0][calls[0].indexOf("--message") + 1];
        expect(message).not.toContain("\n");
        expect(message.length).toBeLessThanOrEqual(120);
    });
});

describe("HerdrReporter metadata", () => {
    test("首报带标题、显示名、token 与 seq", async () => {
        const { calls, runner } = recordRunner();
        const reporter = new HerdrReporter(CONTEXT, { runner, now: () => 2000 });
        reporter.reportMetadata({
            title: "修一下 lint",
            displayAgent: "zbot",
            tokens: { model: "deepseek-chat", session: "abcd1234" },
        });
        await waitFor(() => calls.length === 1);
        expect(calls[0]).toEqual([
            "pane", "report-metadata", "w1:p1",
            "--source", "custom:zbot",
            "--agent", "zbot",
            "--title", "修一下 lint",
            "--display-agent", "zbot",
            "--token", "model=deepseek-chat",
            "--token", "session=abcd1234",
            "--seq", "2000000",
        ]);
    });

    test("展示字段整组重发：只更新 token 时标题不会丢", async () => {
        const { calls, runner } = recordRunner();
        const reporter = new HerdrReporter(CONTEXT, { runner, now: () => 1000 });
        reporter.reportMetadata({ title: "会话标题" });
        reporter.reportMetadata({ tokens: { model: "m" } });
        await waitFor(() => calls.length === 2);
        expect(calls[1]).toContain("--title");
        expect(calls[1]).toContain("会话标题");
        expect(calls[1]).toContain("model=m");
    });

    test("内容未变化的 metadata 不重复上报；token 置 null 时改为清除", async () => {
        const { calls, runner } = recordRunner();
        const reporter = new HerdrReporter(CONTEXT, { runner, now: () => 1000 });
        reporter.reportMetadata({ title: "T", tokens: { model: "m" } });
        reporter.reportMetadata({ title: "T", tokens: { model: "m" } });
        reporter.reportMetadata({ tokens: { model: null } });
        await waitFor(() => calls.length === 2);
        expect(calls[1]).toContain("--clear-token");
        expect(calls[1]).toContain("model");
    });

    test("标题去掉控制字符并截断到 80 字符", async () => {
        const { calls, runner } = recordRunner();
        new HerdrReporter(CONTEXT, { runner, now: () => 1000 }).reportMetadata({
            title: `a\nb\t${"长".repeat(100)}`,
        });
        await waitFor(() => calls.length === 1);
        const title = calls[0][calls[0].indexOf("--title") + 1];
        expect(title).not.toContain("\n");
        expect(title.length).toBeLessThanOrEqual(80);
    });

    test("非法 token 名报错且不产生调用", async () => {
        const errors: unknown[] = [];
        const { calls, runner } = recordRunner();
        const reporter = new HerdrReporter(CONTEXT, {
            runner,
            now: () => 1000,
            onError: error => errors.push(error),
        });
        reporter.reportMetadata({ tokens: { "bad name": "x" } });
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(calls).toEqual([]);
        expect(errors).toHaveLength(1);
    });
});

describe("HerdrReporter release", () => {
    test("先清展示元数据再交还生命周期权威", async () => {
        const { calls, runner } = recordRunner();
        const reporter = new HerdrReporter(CONTEXT, { runner, now: () => 1000 });
        reporter.reportMetadata({ title: "T", tokens: { model: "m", session: "s" } });
        reporter.report("working");
        reporter.release();
        await waitFor(() => calls.length === 4);

        expect(calls[2]).toEqual([
            "pane", "report-metadata", "w1:p1",
            "--source", "custom:zbot",
            "--agent", "zbot",
            "--clear-title",
            "--clear-display-agent",
            "--clear-token", "model",
            "--clear-token", "session",
            "--seq", "1000002",
        ]);
        expect(calls[3]).toEqual([
            "pane", "release-agent", "w1:p1",
            "--source", "custom:zbot", "--agent", "zbot",
            "--seq", "1000003",
        ]);
    });

    test("release 幂等，之后不再上报", async () => {
        const { calls, runner } = recordRunner();
        const reporter = new HerdrReporter(CONTEXT, { runner, now: () => 1000 });
        reporter.release();
        reporter.release();
        reporter.report("idle");
        reporter.reportMetadata({ title: "T" });
        await waitFor(() => calls.length === 2);
        expect(reporter.supported).toBe(false);
        expect(calls.every(args => args[1] !== "report-agent")).toBe(true);
    });

    test("releaseSync 同步发送清理与释放（强退路径）", () => {
        const syncCalls: string[][] = [];
        const { runner } = recordRunner();
        const reporter = new HerdrReporter(CONTEXT, {
            runner,
            syncRunner: (_binPath, args) => syncCalls.push(args),
            now: () => 1000,
        });
        reporter.reportMetadata({ title: "T", tokens: { model: "m" } });
        reporter.releaseSync();

        expect(syncCalls).toHaveLength(2);
        expect(syncCalls[0]).toEqual([
            "pane", "report-metadata", "w1:p1",
            "--source", "custom:zbot",
            "--agent", "zbot",
            "--clear-title",
            "--clear-display-agent",
            "--clear-token", "model",
            "--seq", "1000001",
        ]);
        expect(syncCalls[1]).toEqual([
            "pane", "release-agent", "w1:p1",
            "--source", "custom:zbot", "--agent", "zbot",
            "--seq", "1000002",
        ]);
        expect(reporter.supported).toBe(false);
    });
});

describe("HerdrReporter 串行与错误", () => {
    test("async runner 按提交顺序串行执行", async () => {
        const calls: string[][] = [];
        const resolvers: Array<() => void> = [];
        const runner: HerdrRunner = (_binPath, args) => {
            calls.push(args);
            return new Promise<void>(resolve => resolvers.push(resolve));
        };
        const reporter = new HerdrReporter(CONTEXT, { runner, now: () => 1000 });
        reporter.report("working");
        reporter.report("idle");

        await waitFor(() => calls.length === 1);
        expect(calls).toHaveLength(1);
        resolvers[0]();
        await waitFor(() => calls.length === 2);
        expect(calls[1]).toContain("idle");
    });

    test("runner 抛错只回调一次且不阻断后续上报", async () => {
        const errors: unknown[] = [];
        const calls: string[][] = [];
        let fail = true;
        const runner: HerdrRunner = (_binPath, args) => {
            calls.push(args);
            if (fail) throw new Error("herdr 不存在");
        };
        const reporter = new HerdrReporter(CONTEXT, {
            runner,
            now: () => 1000,
            onError: error => errors.push(error),
        });
        reporter.report("working");
        reporter.report("idle");
        await waitFor(() => calls.length === 2);
        fail = false;
        reporter.report("working");
        await waitFor(() => calls.length === 3);
        expect(errors).toHaveLength(1);
    });

    test("失败后同状态与同 metadata 允许重试", async () => {
        const errors: unknown[] = [];
        const calls: string[][] = [];
        let fail = true;
        const runner: HerdrRunner = (_binPath, args) => {
            calls.push(args);
            if (fail) throw new Error("pane 暂不可用");
        };
        const reporter = new HerdrReporter(CONTEXT, {
            runner,
            now: () => 1000,
            onError: error => errors.push(error),
        });

        reporter.report("idle");
        reporter.reportMetadata({ title: "T", tokens: { model: "m" } });
        await waitFor(() => calls.length === 2);
        // 相同错误文案只回调一次；这里只关心两次调用都失败并允许重试
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(errors).toHaveLength(1);

        fail = false;
        reporter.report("idle");
        reporter.reportMetadata({ title: "T", tokens: { model: "m" } });
        await waitFor(() => calls.length === 4);
        expect(calls[2]).toContain("--state");
        expect(calls[3]).toContain("--title");
    });
});
