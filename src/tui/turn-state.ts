/**
 * 会话级运行态：把「谁在忙、忙到哪一步」从 ChatApp 的进程级字段里拿出来。
 *
 * 原来的 `busy` 是单个布尔，却同时承担两种互不相干的语义：
 *   - 当前会话正在跑 turn（应当按会话区分，后台会话也应算忙）
 *   - UI 层临时占位（清空、压缩、运行时重载期间禁止输入）
 *
 * 混在一起导致 `send()` 里遍布 `store.currentSessionId === sessionId` 分支，
 * 且复位顺序（先 busy 再 phase）成为调用方必须记住的隐式纪律。
 * 这里把两者显式区分，并把顺序约束收进实现。
 */

/** 回合阶段：只描述「模型侧正在做什么」，不含 UI 占位。 */
export type TurnPhase = "waiting" | "reasoning" | "tool" | "generating" | "compacting";

export interface SessionPhaseState {
    phase: TurnPhase;
    toolName?: string;
    /** 阶段起始时间（跨阶段保留，用于展示总耗时）。 */
    startTime: number;
    /** 工具阶段起点（只有 tool 阶段有）。 */
    toolStartTime?: number;
    /** 进度文案（压缩等长耗时阶段使用）。 */
    message?: string;
}

/** UI 占位原因：都是「这一刻不许输入」，但语义不同，便于诊断与展示。 */
export type UiLockReason = "clearing" | "compacting" | "reloading" | "switching" | "resuming";

export class TurnStateStore {
    /** 每个会话的模型侧阶段。 */
    private readonly phases = new Map<string, SessionPhaseState>();
    /** 每个会话的 UI 占位原因集合（同一会话可能短暂叠加，例如切换中又开始重载）。 */
    private readonly locks = new Map<string, Set<UiLockReason>>();

    // ── 模型侧阶段 ──────────────────────────────────────────────

    phase(sessionId: string | null | undefined): SessionPhaseState | undefined {
        return sessionId ? this.phases.get(sessionId) : undefined;
    }

    setPhase(sessionId: string, phase: TurnPhase, toolName?: string): void {
        const now = Date.now();
        const current = this.phases.get(sessionId);
        this.phases.set(sessionId, {
            phase,
            ...(toolName ? { toolName } : {}),
            startTime: current?.startTime ?? now,
            // 进入工具阶段才记工具起点；离开工具阶段时清掉
            ...(phase === "tool"
                ? { toolStartTime: current?.phase === "tool" ? current.toolStartTime ?? now : now }
                : {}),
        });
    }

    /** 更新阶段但保留进度文案（工具名变化时用）。 */
    touch(sessionId: string, patch: Partial<SessionPhaseState>): void {
        const current = this.phases.get(sessionId);
        if (!current) return;
        this.phases.set(sessionId, { ...current, ...patch });
    }

    clearPhase(sessionId: string): void {
        this.phases.delete(sessionId);
    }

    hasPhase(sessionId: string): boolean {
        return this.phases.has(sessionId);
    }

    get activeSessionIds(): string[] {
        return [...this.phases.keys()];
    }

    // ── UI 占位 ────────────────────────────────────────────────

    lock(sessionId: string, reason: UiLockReason): void {
        const reasons = this.locks.get(sessionId) ?? new Set<UiLockReason>();
        reasons.add(reason);
        this.locks.set(sessionId, reasons);
    }

    unlock(sessionId: string, reason: UiLockReason): void {
        const reasons = this.locks.get(sessionId);
        if (!reasons) return;
        reasons.delete(reason);
        if (reasons.size === 0) this.locks.delete(sessionId);
    }

    isLocked(sessionId: string | null | undefined): boolean {
        if (!sessionId) return false;
        return (this.locks.get(sessionId)?.size ?? 0) > 0;
    }

    lockReasons(sessionId: string): UiLockReason[] {
        return [...(this.locks.get(sessionId) ?? [])];
    }

    // ── 组合查询 ───────────────────────────────────────────────

    /** 该会话是否正在占用模型（有阶段或 UI 占位）。 */
    isBusy(sessionId: string | null | undefined): boolean {
        if (!sessionId) return false;
        return this.phases.has(sessionId) || this.isLocked(sessionId);
    }

    /** 本实例是否有任何会话在跑（用于决定是否继续 spinner 心跳）。 */
    hasAnyActivity(): boolean {
        return this.phases.size > 0 || this.locks.size > 0;
    }

    /**
     * 是否有模型侧活动：回合阶段，或压缩/续跑这类占着模型的 UI 占位。
     * clearing/switching/reloading 只是本端界面占位，不代表模型在工作。
     */
    hasModelActivity(): boolean {
        if (this.phases.size > 0) return true;
        for (const reasons of this.locks.values()) {
            if (reasons.has("compacting") || reasons.has("resuming")) return true;
        }
        return false;
    }

    /** 会话结束时清理：阶段与占位一起复位，避免残留让 tab 停在 spinner 上。 */
    reset(sessionId: string): void {
        this.phases.delete(sessionId);
        this.locks.delete(sessionId);
    }

    clear(): void {
        this.phases.clear();
        this.locks.clear();
    }
}
