import { describe, expect, test } from "bun:test";
import { HerdrReporter, type HerdrContext } from "./herdr-reporter.js";

const context: HerdrContext = { binPath: "herdr", paneId: "w1:p1" };

function fixture(clock = { now: 1_000 }) {
    const calls: string[][] = [];
    const reporter = new HerdrReporter(context, {
        runner: (_bin, args) => { calls.push(args); },
        now: () => clock.now,
    });
    return { calls, reporter, clock };
}

async function settle(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
}

function metadataCalls(calls: string[][]): string[][] {
    return calls.filter(args => args[1] === "report-metadata");
}

describe("herdr 元数据上报", () => {
    test("内容没变不重复上报，状态兜底会强制补一次", async () => {
        const f = fixture();
        f.reporter.reportMetadata({ title: "标题", displayAgent: "zbot", tokens: { session: "ABC12345" } });
        await settle();
        expect(metadataCalls(f.calls)).toHaveLength(1);

        // 同样内容再来一次：去重，不产生 CLI 调用。
        f.reporter.reportMetadata({ title: "标题", displayAgent: "zbot", tokens: { session: "ABC12345" } });
        await settle();
        expect(metadataCalls(f.calls)).toHaveLength(1);

        // 别的进程 release 清掉 metadata 后，只靠去重永远补不回来：强制重发。
        f.clock.now += 6_000;
        f.reporter.refreshMetadata();
        await settle();
        const calls = metadataCalls(f.calls);
        expect(calls).toHaveLength(2);
        expect(calls[1]).toContain("session=ABC12345");
    });

    test("强制重发按最小间隔节流", async () => {
        const f = fixture();
        f.reporter.reportMetadata({ title: "标题", tokens: { session: "ABC12345" } });
        await settle();
        f.clock.now += 6_000;
        f.reporter.refreshMetadata();
        await settle();
        // 同一时间窗口内的第二次强制重发被节流掉。
        f.reporter.refreshMetadata();
        await settle();
        expect(metadataCalls(f.calls)).toHaveLength(2);

        f.clock.now += 6_000;
        f.reporter.refreshMetadata();
        await settle();
        expect(metadataCalls(f.calls)).toHaveLength(3);
    });

    test("release 之后不再上报", async () => {
        const f = fixture();
        f.reporter.reportMetadata({ title: "标题", tokens: { session: "ABC12345" } });
        await settle();
        f.reporter.release();
        await settle();
        const before = metadataCalls(f.calls).length;
        f.clock.now += 6_000;
        f.reporter.refreshMetadata();
        await settle();
        expect(metadataCalls(f.calls)).toHaveLength(before);
    });
});
