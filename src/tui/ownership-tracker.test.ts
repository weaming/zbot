import { describe, expect, test } from "bun:test";
import type { PeerOwnership } from "../control/registry.js";
import { OwnershipTracker } from "./ownership-tracker.js";

/** 归属 tracker 的纯单测：探测节流、在途去重、失败保留旧快照、轮询开关与展示文案。 */

function trackerOf(options: {
    probe: (ids: string[]) => Promise<Map<string, PeerOwnership>>;
    ids?: string[];
    panelOpen?: boolean;
    pending?: { awaiting: number; queued: number };
    ttlMs?: number;
    now?: () => number;
    onChange?: () => void;
}) {
    const state = { probes: 0, changes: 0, ids: options.ids ?? ["s1", "s2"], panelOpen: options.panelOpen ?? false };
    const tracker = new OwnershipTracker({
        probeOwnership: (ids) => {
            state.probes += 1;
            return options.probe(ids);
        },
        sessionIds: () => state.ids,
        onChange: () => {
            state.changes += 1;
            options.onChange?.();
        },
        isPanelOpen: () => state.panelOpen,
        ...(options.pending ? { pendingStats: () => options.pending! } : {}),
        ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
        ...(options.now ? { now: options.now } : {}),
    });
    return { tracker, state };
}

const mine = (): Map<string, PeerOwnership> => new Map([["s1", { state: "mine" } as PeerOwnership]]);

/** 等条件成立：真实定时器在负载下会漂移，固定 sleep 会偶发失败。 */
async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) await Bun.sleep(2);
}

describe("OwnershipTracker", () => {
    test("快照更新后触发重绘；TTL 内不重复探测，force 立即探测", async () => {
        let clock = 10_000;
        const { tracker, state } = trackerOf({ probe: async () => mine(), now: () => clock });

        await tracker.refresh();
        expect(state.probes).toBe(1);
        expect(state.changes).toBe(1);
        expect(tracker.get("s1")?.state).toBe("mine");

        clock += 500;
        await tracker.refresh();
        expect(state.probes).toBe(1);

        clock += 1_500;
        await tracker.refresh();
        expect(state.probes).toBe(2);

        await tracker.refresh(true);
        expect(state.probes).toBe(3);
    });

    test("并发刷新复用同一个在途探测", async () => {
        let release!: (value: Map<string, PeerOwnership>) => void;
        const { tracker, state } = trackerOf({
            probe: () => new Promise<Map<string, PeerOwnership>>((resolve) => { release = resolve; }),
        });

        const first = tracker.refresh();
        const second = tracker.refresh();
        expect(state.probes).toBe(1);

        release(mine());
        await Promise.all([first, second]);
        expect(tracker.get("s1")?.state).toBe("mine");
    });

    test("探测同步抛错或异步失败都不打断主流程，且保留旧快照", async () => {
        let fail = false;
        const { tracker } = trackerOf({
            probe: async () => {
                if (fail) throw new Error("socket 挂了");
                return mine();
            },
        });
        await tracker.refresh(true);

        fail = true;
        await tracker.refresh(true);
        // 旧快照还在：归属只是展示辅助，不该因为一次探测失败就清空
        expect(tracker.get("s1")?.state).toBe("mine");

        const thrown = trackerOf({
            probe: () => {
                throw new Error("宿主没有归属探测能力");
            },
        });
        await expect(thrown.tracker.refresh(true)).resolves.toBeUndefined();
        expect(thrown.tracker.get("s1")).toBeUndefined();
    });

    test("轮询只在会话面板打开时探测，stop 后不再探测", async () => {
        const { tracker, state } = trackerOf({
            probe: async () => mine(),
            ttlMs: 5,
            panelOpen: false,
        });
        tracker.startPolling();
        expect(tracker.isPolling()).toBe(true);

        await Bun.sleep(30);
        expect(state.probes).toBe(0);

        state.panelOpen = true;
        await waitFor(() => state.probes > 0);
        expect(state.probes).toBeGreaterThan(0);

        tracker.stopPolling();
        expect(tracker.isPolling()).toBe(false);
        const probesWhenStopped = state.probes;
        await Bun.sleep(30);
        expect(state.probes).toBe(probesWhenStopped);
    });

    test("展示文案：本实例带实时待交付计数，他实例带 PID 与处理中，无快照返回 null", async () => {
        const ownership: PeerOwnership[] = [
            { state: "mine" } as PeerOwnership,
            { state: "other", info: { pid: 4321, instanceId: "peer", sessionId: "s2", busy: true, pending: 2 } } as PeerOwnership,
            { state: "free" } as PeerOwnership,
        ];
        const { tracker } = trackerOf({
            probe: async () => new Map([["s1", ownership[0]!], ["s2", ownership[1]!], ["s3", ownership[2]!]]),
            ids: ["s1", "s2", "s3"],
            pending: { awaiting: 2, queued: 1 },
        });
        await tracker.refresh(true);

        const own = tracker.describe("s1");
        expect(own?.state).toBe("mine");
        expect(own?.text).toContain("等待 2");
        expect(own?.text).toContain("待附加 1");

        const other = tracker.describe("s2");
        expect(other?.state).toBe("other");
        expect(other?.text).toContain("PID 4321");
        expect(other?.text).toContain("处理中 2");

        expect(tracker.describe("s3")?.state).toBe("free");
        expect(tracker.describe("ghost")).toBeNull();
    });
});
