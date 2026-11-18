import { describe, expect, test } from "bun:test";
import { HcReporter, readHcContext, resolveHcBinPath, type HcContext, type HcRunner } from "./hc-reporter.js";
import { tabSessionToken } from "./herdr-reporter.js";

const CONTEXT: HcContext = { terminalId: "t7", binPath: "/mock/bin/hc" };

async function settle(ticks = 3): Promise<void> {
    for (let index = 0; index < ticks; index += 1) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

function createFixture(context: HcContext | null = CONTEXT, clock = { now: 1_000 }) {
    const calls: Array<{ binPath: string; args: string[] }> = [];
    const syncCalls: Array<{ binPath: string; args: string[] }> = [];
    const errors: unknown[] = [];
    const reporter = new HcReporter(context ?? undefined, {
        runner: (binPath, args) => {
            calls.push({ binPath, args });
        },
        syncRunner: (binPath, args) => {
            syncCalls.push({ binPath, args });
        },
        now: () => clock.now,
        onError: (error) => {
            errors.push(error);
        },
    });
    return { calls, syncCalls, errors, reporter, clock };
}

describe("readHcContext 与 resolveHcBinPath", () => {
    test("无 HC_TERMINAL_ID 或空白时返回 undefined", () => {
        expect(readHcContext({})).toBeUndefined();
        expect(readHcContext({ HC_TERMINAL_ID: "   " })).toBeUndefined();
    });

    test("按优先级解析可执行文件：HC_BIN_PATH > PATH > ~/.local/bin/hc > Sheprd", () => {
        const execSet = new Set<string>([
            "/usr/local/bin/hc",
            "/Users/test/.local/bin/hc",
            "/Applications/Sheprd.app/Contents/MacOS/herdr-core",
        ]);
        const options = {
            homedir: "/Users/test",
            isExecutable: (filePath: string) => execSet.has(filePath),
        };

        expect(resolveHcBinPath({
            HC_BIN_PATH: " /opt/custom/hc ",
            PATH: "/usr/local/bin",
        }, options)).toBe("/opt/custom/hc");

        expect(resolveHcBinPath({
            PATH: "/bin:/usr/local/bin",
        }, options)).toBe("/usr/local/bin/hc");

        execSet.delete("/usr/local/bin/hc");
        expect(resolveHcBinPath({ PATH: "/bin:/usr/local/bin" }, options))
            .toBe("/Users/test/.local/bin/hc");

        execSet.delete("/Users/test/.local/bin/hc");
        expect(resolveHcBinPath({ PATH: "/bin" }, options))
            .toBe("/Applications/Sheprd.app/Contents/MacOS/herdr-core");

        execSet.clear();
        expect(resolveHcBinPath({ PATH: "/bin" }, options)).toBeUndefined();
    });

    test("找不到二进制时保留 terminalId 且 CLI 调用静默跳过", async () => {
        const ctx = readHcContext(
            { HC_TERMINAL_ID: " t9 ", PATH: "/empty" },
            { homedir: "/Users/none", isExecutable: () => false },
        );
        expect(ctx).toEqual({ terminalId: "t9", binPath: undefined });

        const f = createFixture(ctx);
        expect(f.reporter.supported).toBe(true);
        f.reporter.reportMetadata({ title: "标题", tokens: { session: "ABC12345" } });
        await settle();
        f.clock.now += 6_000;
        expect(f.reporter.refreshMetadata()).toBe(true);
        f.reporter.release();
        expect(f.calls).toEqual([]);
        expect(f.syncCalls).toEqual([]);
        expect(f.errors).toEqual([]);
    });
});

describe("HcReporter 元数据标签上报与清理", () => {
    test("无 HC_TERMINAL_ID 上下文时完全 no-op", async () => {
        const f = createFixture(null);
        expect(f.reporter.supported).toBe(false);
        f.reporter.reportMetadata({ title: "T", tokens: { session: "ABC12345" } });
        f.reporter.reassert();
        expect(f.reporter.refreshMetadata()).toBe(false);
        f.reporter.release();
        await settle();
        expect(f.calls).toEqual([]);
        expect(f.syncCalls).toEqual([]);
    });

    test("合并上报 agent=zbot、title、session、tabs、model 并按内容去重", async () => {
        const f = createFixture();
        const tabs = tabSessionToken(["01M7JAF4E3TZHKKPF0GWKTPM37", "01M7H06AWVKPDBC5YMDC3RSX27"])!;

        f.reporter.reportMetadata({
            title: `第一行\n第二行\t${"长".repeat(90)}`,
            displayAgent: "zbot",
            tokens: {
                session: "GWKTPM37",
                tabs,
                model: "deepseek-chat",
            },
        });
        await settle();
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]?.binPath).toBe("/mock/bin/hc");

        const firstArgs = f.calls[0]!.args;
        expect(firstArgs[0]).toBe("label");
        expect(firstArgs[1]).toBe("t7");
        expect(firstArgs[2]).toBe("agent=zbot");
        expect(firstArgs[3]?.startsWith("title=第一行 第二行 ")).toBe(true);
        expect(firstArgs[3]!.slice("title=".length).length).toBeLessThanOrEqual(80);
        expect(firstArgs.slice(4)).toEqual([
            "session=GWKTPM37",
            "tabs=GWKTPM37,DC3RSX27",
            "model=deepseek-chat",
        ]);

        // 相同内容不重复调用
        f.reporter.reportMetadata({
            tokens: {
                session: "GWKTPM37",
                tabs,
                model: "deepseek-chat",
            },
        });
        await settle();
        expect(f.calls).toHaveLength(1);

        // undefined 保持原值，null 清空对应键
        f.reporter.reportMetadata({
            title: null,
            tokens: { tabs: null },
        });
        await settle();
        expect(f.calls).toHaveLength(2);
        expect(f.calls[1]!.args).toEqual([
            "label",
            "t7",
            "agent=zbot",
            "title=",
            "session=GWKTPM37",
            "tabs=",
            "model=deepseek-chat",
        ]);
    });

    test("reassert 强制重发，refreshMetadata 按间隔节流且首报前不空发", async () => {
        const f = createFixture();
        expect(f.reporter.refreshMetadata()).toBe(false);
        f.reporter.reassert();
        await settle();
        expect(f.calls).toHaveLength(0);

        f.reporter.reportMetadata({ title: "会话", tokens: { session: "GWKTPM37" } });
        await settle();
        expect(f.calls).toHaveLength(1);

        f.reporter.reassert();
        await settle();
        expect(f.calls).toHaveLength(2);
        expect(f.calls[1]!.args).toEqual(f.calls[0]!.args);

        f.clock.now += 6_000;
        expect(f.reporter.refreshMetadata()).toBe(true);
        expect(f.reporter.refreshMetadata()).toBe(false);
        await settle();
        expect(f.calls).toHaveLength(3);
    });

    test("异步串行执行，单次失败后允许同内容重试", async () => {
        const started: string[][] = [];
        const resolvers: Array<() => void> = [];
        let shouldFail = true;
        const errors: unknown[] = [];

        const runner: HcRunner = (_bin, args) => {
            started.push(args);
            if (shouldFail) throw new Error("hc 暂不可用");
            return new Promise<void>(resolve => resolvers.push(resolve));
        };
        const reporter = new HcReporter(CONTEXT, {
            runner,
            onError: error => errors.push(error),
        });

        reporter.reportMetadata({ title: "A", tokens: { session: "S1" } });
        reporter.reportMetadata({ title: "A", tokens: { session: "S1" } });
        await settle();
        expect(started).toHaveLength(1);
        expect(errors).toHaveLength(1);

        // 失败后去重键已清空，同内容可重试；并发提交保持严格串行
        shouldFail = false;
        reporter.reportMetadata({ title: "A", tokens: { session: "S1" } });
        reporter.reportMetadata({ title: "B", tokens: { session: "S2" } });
        await settle();
        expect(started).toHaveLength(2);

        resolvers[0]!();
        await settle();
        expect(started).toHaveLength(3);
        expect(started[2]).toContain("title=B");
    });

    test("非法或保留键报错且不中断有效键上报", async () => {
        const f = createFixture();
        f.reporter.reportMetadata({
            title: "有效标题",
            tokens: {
                "bad key": "x",
                agent: "spoof",
                session: "GWKTPM37",
            },
        });
        await settle();
        expect(f.errors).toHaveLength(2);
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]!.args).toEqual([
            "label",
            "t7",
            "agent=zbot",
            "title=有效标题",
            "session=GWKTPM37",
        ]);
    });

    test("release 同步清空全部标签，阻止未执行的异步队列反写且幂等", async () => {
        const f = createFixture();
        f.reporter.reportMetadata({
            title: "待清理",
            tokens: {
                session: "GWKTPM37",
                tabs: "GWKTPM37,DC3RSX27",
                model: "deepseek-chat",
                extra: "v1",
            },
        });
        // 不 await settle，直接同步 release：排队的异步上报不得在清理后反写
        f.reporter.release();
        f.reporter.release();
        await settle();

        expect(f.calls).toEqual([]);
        expect(f.syncCalls).toEqual([{
            binPath: "/mock/bin/hc",
            args: [
                "label",
                "t7",
                "agent=",
                "title=",
                "session=",
                "tabs=",
                "model=",
                "extra=",
            ],
        }]);
        expect(f.reporter.supported).toBe(false);

        f.reporter.reportMetadata({ title: "后续忽略", tokens: { session: "NEW12345" } });
        f.reporter.reassert();
        await settle();
        expect(f.calls).toEqual([]);
    });
});
