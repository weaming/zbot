/**
 * 提问通道 + 底部提问区：`ask_user` 的会话级状态与面板显隐决策。
 *
 * 状态都收在这里：待答问题（按会话）、按会话缓存的面板实例、折叠集合、dock 当前挂的会话。
 * 界面构造与重绘通过窄接口注入（面板工厂、dock、重绘回调、按键判定），因此可以脱离
 * pi-tui 直接单测「切会话时弹/收、折叠后保留答案、结算后清干净、非当前会话只 flash」。
 *
 * 键盘交互不变：⌃⇧Q 折叠由面板层 intercept 消费，Esc/任意浮层关闭后由 sync() 重新露出。
 */

import {
    questionLabel,
    type UserAnswer,
    type UserQuestion,
    type UserQuestionAnswer,
    type UserQuestionRequest,
} from "../utils/user-question.js";
import type { PanelKind, PanelLayer } from "./panel-stack.js";

/** 挂着的提问（`ask_user` 工具在等用户作答）。 */
export interface PendingQuestion {
    requestId: string;
    sessionId: string;
    questions: UserQuestion[];
    /** 逐题作答（与面板共享引用，重开面板时据此回显进度）。 */
    answers: (UserQuestionAnswer | null)[];
    /** 结算（幂等）：作答 / 取消都走它，随后面板与 tab 标记一起收敛。 */
    settle(answer: UserAnswer): void;
}

/** 面板内容能力：真实实现是 QuestionPanel，测试用假的记录输入。 */
export interface QuestionPanelLike {
    handleInput(data: string): void;
}

/** 底部提问区：真实实现套 PanelFrame/Text 进 dock 容器。 */
export interface QuestionDockView {
    showPanel(panel: QuestionPanelLike): void;
    showCollapsed(text: string): void;
    clear(): void;
}

/** 面板栈里与提问相关的最小能力（结构上兼容 PanelStack）。 */
export interface QuestionPanelStack {
    readonly isEmpty: boolean;
    has(kind: PanelKind): boolean;
    find(kind: PanelKind): PanelLayer | undefined;
    remove(kind: PanelKind): void;
    push(layer: PanelLayer): void;
}

export interface QuestionCoordinatorDeps {
    panels: QuestionPanelStack;
    dock: QuestionDockView;
    currentSessionId(): string | null;
    sessionLabel(sessionId: string): string;
    isExiting(): boolean;
    restoreFocus(): void;
    requestRender(): void;
    /** 状态变化后的重绘：tab 标记、状态栏待答计数、herdr 阻塞态。 */
    onStateChange(): void;
    flash(message: string): void;
    /** ⌃⇧Q 判定由前端注入（coordinator 不依赖 pi-tui 的键位常量）。 */
    isCollapseKey(data: string): boolean;
    /** 按会话构造面板；reveal 用于把面板挂进 dock（真实实现顺带刷新渲染）。 */
    createPanel(input: {
        questions: UserQuestion[];
        answers: (UserQuestionAnswer | null)[];
        submit(): void;
        cancel(): void;
        collapse(): void;
    }): QuestionPanelLike;
}

export class QuestionCoordinator {
    private readonly pendingQuestions = new Map<string, PendingQuestion>();
    /** 面板实例按会话缓存：折叠/切走再回来时保留滚动位置与作答进度。 */
    private readonly panels = new Map<string, QuestionPanelLike>();
    private readonly collapsed = new Set<string>();
    private dockSessionId: string | null = null;

    constructor(private readonly deps: QuestionCoordinatorDeps) {}

    /** 工具侧入口：挂起一次提问，返回作答或取消。 */
    ask(request: UserQuestionRequest, signal?: AbortSignal): Promise<UserAnswer> {
        return new Promise<UserAnswer>((resolve) => {
            let settled = false;
            const settle = (answer: UserAnswer): void => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener("abort", onAbort);
                this.pendingQuestions.delete(request.sessionId);
                this.panels.delete(request.sessionId);
                this.collapsed.delete(request.sessionId);
                this.close(request.sessionId);
                this.notifyStateChanged();
                resolve(answer);
            };
            const onAbort = (): void => settle({ cancelled: true });

            if (signal?.aborted) {
                resolve({ cancelled: true });
                return;
            }
            signal?.addEventListener("abort", onAbort, { once: true });

            this.pendingQuestions.set(request.sessionId, {
                requestId: request.requestId,
                sessionId: request.sessionId,
                questions: request.questions,
                answers: request.questions.map(() => null),
                settle,
            });
            this.notifyStateChanged();

            if (request.sessionId === this.deps.currentSessionId()) {
                this.open(request.sessionId);
            } else {
                this.deps.flash(`❓ 有会话在等你作答：${this.deps.sessionLabel(request.sessionId)}（切过去作答）`);
            }
        });
    }

    /** 当前会话挂着未作答的提问就显示底部面板或折叠提示，否则收起。 */
    sync(): void {
        const sessionId = this.deps.currentSessionId();
        if (!sessionId || !this.pendingQuestions.has(sessionId)) {
            this.close();
            return;
        }
        this.open(sessionId);
    }

    /** ⌃⇧Q：展开/折叠当前会话的提问面板；有别的浮层在时不抢。 */
    toggle(): void {
        const sessionId = this.deps.currentSessionId();
        if (!sessionId || !this.pendingQuestions.has(sessionId) || !this.deps.panels.isEmpty) return;
        this.collapsed.delete(sessionId);
        this.open(sessionId);
    }

    /** 收起提问面板但不结算（Esc / 切走会话 / 会话释放）。 */
    close(sessionId?: string): void {
        const layer = this.deps.panels.find("question");
        if (sessionId && layer?.sessionId && layer.sessionId !== sessionId) return;
        if (sessionId && this.dockSessionId && this.dockSessionId !== sessionId) return;
        if (layer) this.deps.panels.remove("question");
        else this.clearDock(sessionId);
        if (this.deps.panels.isEmpty) this.deps.restoreFocus();
        this.deps.requestRender();
    }

    hasPending(sessionId: string): boolean {
        return this.pendingQuestions.has(sessionId);
    }

    pendingCount(): number {
        return this.pendingQuestions.size;
    }

    /** herdr 的阻塞文案：任意会话在等作答都优先于「运行中」。 */
    blockedMessage(): string | undefined {
        for (const pending of this.pendingQuestions.values()) {
            const first = pending.questions[0];
            return first ? questionLabel(first) : "等待用户作答";
        }
        return undefined;
    }

    /** 取某会话的待答项（结算入口；也为「切走后再结算」保留同一引用）。 */
    pending(sessionId: string): PendingQuestion | undefined {
        return this.pendingQuestions.get(sessionId);
    }

    private open(sessionId: string): void {
        if (this.deps.isExiting()) return;
        const pending = this.pendingQuestions.get(sessionId);
        if (!pending || sessionId !== this.deps.currentSessionId()) return;
        if (!this.deps.panels.isEmpty) return;

        if (this.collapsed.has(sessionId)) {
            this.showCollapsed(sessionId);
            return;
        }

        let panel = this.panels.get(sessionId);
        if (!panel) {
            panel = this.deps.createPanel({
                questions: pending.questions,
                answers: pending.answers,
                submit: () => pending.settle({
                    cancelled: false,
                    answers: pending.answers.filter((answer): answer is UserQuestionAnswer => answer !== null),
                }),
                cancel: () => pending.settle({ cancelled: true }),
                collapse: () => this.collapse(sessionId),
            });
            this.panels.set(sessionId, panel);
        }

        this.deps.dock.showPanel(panel);
        this.dockSessionId = sessionId;
        this.deps.panels.push({
            kind: "question",
            panel,
            sessionId,
            // ⌃⇧Q 折叠而不是关闭：这是提问面板独有的键位，声明在层上而非路由函数里
            intercept: (data) => {
                if (!this.deps.isCollapseKey(data)) return false;
                this.collapse(sessionId);
                return true;
            },
            onClose: () => this.clearDock(sessionId),
        });
        this.deps.restoreFocus();
        this.deps.requestRender();
    }

    /** 摘掉底部提问区但不改栈（栈内的 onClose 与外部收尾共用）。 */
    private clearDock(sessionId?: string): void {
        if (sessionId && this.dockSessionId && this.dockSessionId !== sessionId) return;
        this.deps.dock.clear();
        this.dockSessionId = null;
    }

    /** Esc 收起问题供阅读；⌃⇧Q 可重新打开。 */
    private collapse(sessionId: string): void {
        const layer = this.deps.panels.find("question");
        if (layer?.sessionId !== sessionId) return;
        // 折叠前先入集合，避免 onClose 清掉 dock 后又立刻按「未折叠」重开
        this.collapsed.add(sessionId);
        this.deps.panels.remove("question");
        this.showCollapsed(sessionId);
        this.deps.restoreFocus();
        this.deps.requestRender();
    }

    /** 折叠态只占一行，方便阅读正文期间知道仍有问题待答。 */
    private showCollapsed(sessionId: string): void {
        const pending = this.pendingQuestions.get(sessionId);
        if (!pending || sessionId !== this.deps.currentSessionId()) return;
        const current = pending.answers.findIndex(answer => answer === null);
        const step = current < 0 ? 1 : current + 1;
        this.deps.dock.showCollapsed(
            `❓ 等待回答 ${step}/${pending.questions.length} · ⌃⇧Q 展开 · ⌃C 取消`,
        );
        this.dockSessionId = sessionId;
        this.deps.requestRender();
    }

    private notifyStateChanged(): void {
        this.deps.onStateChange();
    }
}
