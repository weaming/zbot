/**
 * 会话的「正在发生」信号：只推界面需要渲染的那点东西。
 *
 * 逐 token 的增量本身不进主事件日志（落在 pending 流文件，不占 seq），HTTP 也不推它——
 * 一个长回答几万个 token，全文推送会把响应撑爆，而界面要的只是：
 *   1. 正在生成的正文（用户看着它一个字一个字出来）
 *   2. 「正在思考」这个状态位（推理正文界面根本不渲染）
 *
 * 所以这里只做两件事：文本按 80ms 合批推送；推理只发"有没有"的布尔，不发内容。
 * 帧不带 id/seq：它是瞬态信号，断线重连后由持久化事件补齐，不参与游标。
 */

export type LiveFrame =
    | { t: "text"; d: string }
    | { t: "think"; on: boolean }
    /** 回合收尾（正常结束、报错、被中止）：界面清掉实时缓冲，交给持久化消息 */
    | { t: "end" };

type Listener = (frame: LiveFrame) => void;

/** 文本合批窗口：太小会把每帧都变成一次 write，太大又会显得卡顿。 */
const FLUSH_MS = 80;

interface SessionLive {
    listeners: Set<Listener>;
    pendingText: string;
    timer?: ReturnType<typeof setTimeout>;
    thinking: boolean;
}

const sessions = new Map<string, SessionLive>();

function stateOf(sessionId: string): SessionLive {
    let state = sessions.get(sessionId);
    if (!state) {
        state = { listeners: new Set(), pendingText: "", thinking: false };
        sessions.set(sessionId, state);
    }
    return state;
}

function emit(sessionId: string, frame: LiveFrame): void {
    const state = sessions.get(sessionId);
    if (!state?.listeners.size) return;
    for (const listener of state.listeners) {
        try {
            listener(frame);
        } catch {
            // 单个订阅者出错不该影响其他连接
        }
    }
}

function flushText(sessionId: string): void {
    const state = sessions.get(sessionId);
    if (!state) return;
    if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
    }
    if (!state.pendingText) return;
    const text = state.pendingText;
    state.pendingText = "";
    emit(sessionId, { t: "text", d: text });
}

/** 追加一小段正文；80ms 内的多次调用会被合并成一帧。 */
export function pushLiveText(sessionId: string, delta: string): void {
    if (!delta) return;
    const state = stateOf(sessionId);
    if (state.listeners.size === 0) return; // 没人看就别攒
    // 开始出正文说明这一轮思考结束了：先把「思考中」收掉，别让标记跟正文并排
    if (state.thinking) {
        state.thinking = false;
        emit(sessionId, { t: "think", on: false });
    }
    state.pendingText += delta;
    if (state.timer) return;
    state.timer = setTimeout(() => {
        state.timer = undefined;
        flushText(sessionId);
    }, FLUSH_MS);
    state.timer.unref?.();
}

/** 思考状态位：只在翻转时发一帧，推理正文一概不传。 */
export function pushLiveThinking(sessionId: string, thinking: boolean): void {
    const state = stateOf(sessionId);
    if (state.thinking === thinking) return;
    state.thinking = thinking;
    if (state.listeners.size === 0) return;
    emit(sessionId, { t: "think", on: thinking });
}

/** 回合收尾：把残留正文冲出去，然后通知界面清缓冲。 */
export function pushLiveEnd(sessionId: string): void {
    const state = sessions.get(sessionId);
    if (!state) return;
    flushText(sessionId);
    state.thinking = false;
    emit(sessionId, { t: "end" });
}

/** 订阅某会话的实时信号；返回退订函数（最后一个订阅者离开时释放状态）。 */
export function subscribeLive(sessionId: string, listener: Listener): () => void {
    const state = stateOf(sessionId);
    state.listeners.add(listener);
    return () => {
        state.listeners.delete(listener);
        if (state.listeners.size === 0) {
            if (state.timer) clearTimeout(state.timer);
            sessions.delete(sessionId);
        }
    };
}
