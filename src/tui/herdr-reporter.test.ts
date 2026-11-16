import { describe, expect, test } from "bun:test";
import { HerdrReporter, MAX_TAB_TOKENS, type HerdrContext, tabSessionToken } from "./herdr-reporter.js";

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

describe("tabs token", () => {
    test("按 tab 条顺序写各会话的 8 位后缀", () => {
        expect(tabSessionToken(["01M7JAF4E3TZHKKPF0GWKTPM37", "01M7H06AWVKPDBC5YMDC3RSX27"]))
            .toBe("GWKTPM37,DC3RSX27");
    });

    test("空列表与空 id 不当成一个 tab", () => {
        expect(tabSessionToken([])).toBeUndefined();
        expect(tabSessionToken(["", "   "])).toBeUndefined();
    });

    test("tab 太多就截断，不落到 herdr 的 80 字符截断里", () => {
        const many = Array.from({ length: MAX_TAB_TOKENS + 4 }, (_, index) => `01M7JAF4E3TZHKKPF0GWKTPM3${index}`);
        const token = tabSessionToken(many)!;
        expect(token.split(",")).toHaveLength(MAX_TAB_TOKENS);
        expect(token.length).toBeLessThanOrEqual(80);
    });
});
