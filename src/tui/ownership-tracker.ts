/**
 * 会话归属快照：探测（谁持有会话）、节流、在途去重、面板打开期间的轮询，以及展示文案。
 *
 * 归属只是列表上的辅助信息，探测要走 socket，所以：
 * - 快照按 TTL 节流，认领/释放后可以 force 立即校正；
 * - 同一时刻只有一个在途探测（重复调用复用同一个 promise）；
 * - 探测失败保留旧快照，不打断主流程；
 * - 轮询只在会话面板打开时跑，且定时器 unref（不阻止进程退出）。
 *
 * 这里不碰渲染与宿主实现：列表、面板状态、重绘都由调用方以窄接口注入。
 */

import { describeOwnership, type PeerOwnership } from "../control/registry.js";
import type { SessionOwnerState } from "./session-marker.js";

export interface OwnershipTrackerDeps {
    /** 归属探测（宿主能力，缺省/抛错时按"无快照"处理）。 */
    probeOwnership(sessionIds: string[]): Promise<Map<string, PeerOwnership>>;
    /** 参与探测的会话 id（来自当前会话列表）。 */
    sessionIds(): string[];
    /** 快照更新后重绘列表（tab 条 / 面板）。 */
    onChange(): void;
    /** 轮询开关：会话面板打开时才需要。 */
    isPanelOpen(): boolean;
    /** 本实例在会话上的待交付计数（实时取自控制通道，不进快照）。 */
    pendingStats?(sessionId: string): { awaiting: number; queued: number };
    ttlMs?: number;
    now?: () => number;
}

const DEFAULT_TTL_MS = 1_500;

export class OwnershipTracker {
    private snapshot = new Map<string, PeerOwnership>();
    private refreshedAt = 0;
    private refreshPromise: Promise<void> | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private readonly ttlMs: number;
    private readonly now: () => number;

    constructor(private readonly deps: OwnershipTrackerDeps) {
        this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
        this.now = deps.now ?? Date.now;
    }

    /** 归属快照（可能比真实状态旧一个 TTL；只用于展示）。 */
    get(sessionId: string): PeerOwnership | undefined {
        return this.snapshot.get(sessionId);
    }

    /** 刷新快照（节流 + 在途去重）；force 用于认领/释放后立即校正。 */
    refresh(force = false): Promise<void> {
        if (this.refreshPromise) return this.refreshPromise;
        if (!force && this.now() - this.refreshedAt < this.ttlMs) return Promise.resolve();

        let probe: Promise<Map<string, PeerOwnership>>;
        try {
            probe = Promise.resolve(this.deps.probeOwnership(this.deps.sessionIds()));
        } catch {
            // 宿主没有归属探测能力（精简替身）：归属列留空，不影响面板其它功能
            return Promise.resolve();
        }
        this.refreshPromise = probe
            .then((map) => {
                this.snapshot = map;
                this.refreshedAt = this.now();
            })
            .catch(() => {
                // 探测失败保留旧快照：归属只是展示辅助
            })
            .finally(() => {
                this.refreshPromise = null;
                this.deps.onChange();
            });
        return this.refreshPromise;
    }

    /** 面板打开期间轮询归属：他实例的忙闲/认领变化要反映到列表上。幂等。 */
    startPolling(): void {
        if (this.timer) return;
        this.timer = setInterval(() => {
            if (!this.deps.isPanelOpen()) return;
            void this.refresh();
        }, this.ttlMs);
        // 轮询只是展示辅助：不应阻止进程退出（也不该卡住测试）
        this.timer.unref?.();
    }

    /** 是否正在轮询（诊断用：面板打开期间才该为 true）。 */
    isPolling(): boolean {
        return this.timer !== null;
    }

    stopPolling(): void {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    }

    /**
     * 展示文案与状态：本实例的待交付计数实时取，他实例的忙闲与处理中条数来自 who 握手。
     * 没有快照（未探测过 / 宿主不支持）时返回 null，列表留空。
     */
    describe(sessionId: string): { state: SessionOwnerState; text: string } | null {
        const ownership = this.snapshot.get(sessionId);
        if (!ownership) return null;

        if (ownership.state === "mine") {
            const { awaiting, queued } = this.deps.pendingStats?.(sessionId) ?? { awaiting: 0, queued: 0 };
            const parts = ["本实例"];
            if (awaiting > 0) parts.push(`等待 ${awaiting}`);
            if (queued > 0) parts.push(`待附加 ${queued}`);
            return { state: "mine", text: parts.join(" · ") };
        }
        if (ownership.state === "free") return { state: "free", text: describeOwnership(sessionId, ownership) };

        const info = ownership.info;
        if (!info) return { state: "other", text: describeOwnership(sessionId, ownership) };
        const parts = [describeOwnership(sessionId, ownership)];
        if (info.pending > 0) parts.push(`处理中 ${info.pending}`);
        return { state: "other", text: parts.join(" · ") };
    }
}
