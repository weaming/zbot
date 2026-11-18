/**
 * 会话级「等待作答」注册表。
 *
 * 提问原来只活在前端面板里（TUI 的 QuestionCoordinator），外部进程无从作答。
 * 这里在通道层再记一份：面板与外部（控制通道）谁先给答案就用谁的；
 * 外部先答时 abort 面板的信号，让它关掉让位。
 */

import type { UserAnswer, UserQuestion, UserQuestionRequest } from "../utils/user-question.js";

export interface PendingQuestion {
    sessionId: string;
    requestId: string;
    questions: UserQuestion[];
}

interface PendingEntry extends PendingQuestion {
    /** 外部作答入口：abort 面板并兑现等待。 */
    resolve: (answer: UserAnswer) => void;
}

type Listener = (event: { kind: "asked" | "closed"; question: PendingQuestion }) => void;

const pending = new Map<string, PendingEntry>();
const listeners = new Set<Listener>();

function emit(event: { kind: "asked" | "closed"; question: PendingQuestion }): void {
    for (const listener of listeners) {
        try {
            listener(event);
        } catch {
            // 单个订阅者出错不该影响提问本身
        }
    }
}

/** 订阅待答项变化：observe 通道据此推 `question` / `question_closed`。 */
export function subscribeQuestions(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** 某会话当前挂着的提问（没有则为 undefined）。 */
export function pendingQuestion(sessionId: string): PendingQuestion | undefined {
    const entry = pending.get(sessionId);
    return entry && { sessionId: entry.sessionId, requestId: entry.requestId, questions: entry.questions };
}

/**
 * 包一层前端通道：面板与外部作答共享同一份等待。
 * 前端面板收到 abort 会自行收尾，所以这里只负责「谁先到」。
 */
export function askWithRegistry(
    sessionId: string,
    request: UserQuestionRequest,
    signal: AbortSignal | undefined,
    ask: (request: UserQuestionRequest, signal?: AbortSignal) => Promise<UserAnswer>,
): Promise<UserAnswer> {
    return new Promise<UserAnswer>(resolve => {
        const panel = new AbortController();
        let settled = false;
        const question: PendingQuestion = {
            sessionId,
            requestId: request.requestId,
            questions: request.questions,
        };
        const settle = (answer: UserAnswer): void => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            if (pending.get(sessionId)?.requestId === request.requestId) pending.delete(sessionId);
            emit({ kind: "closed", question });
            resolve(answer);
        };
        const onAbort = (): void => {
            panel.abort();
            settle({ cancelled: true });
        };

        if (signal?.aborted) {
            resolve({ cancelled: true });
            return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });

        pending.set(sessionId, {
            ...question,
            // 外部先答：先让面板关掉，再把答案交出去。
            resolve: answer => {
                panel.abort();
                settle(answer);
            },
        });
        emit({ kind: "asked", question });
        // 同步进入面板：外部应答随时可能到，监听必须先挂上。
        let asked: Promise<UserAnswer>;
        try {
            asked = Promise.resolve(ask(request, panel.signal));
        } catch {
            settle({ cancelled: true });
            return;
        }
        void asked.then(settle, () => settle({ cancelled: true }));
    });
}

/** 外部作答：按请求 id 兑现等待中的提问；没有对应提问时如实报原因。 */
export function answerPendingQuestion(
    sessionId: string,
    requestId: string,
    answer: UserAnswer,
): { ok: true } | { ok: false; reason: "not_found" | "cancelled" } {
    const entry = pending.get(sessionId);
    if (!entry || entry.requestId !== requestId) return { ok: false, reason: "not_found" };
    entry.resolve(answer);
    return answer.cancelled ? { ok: false, reason: "cancelled" } : { ok: true };
}
