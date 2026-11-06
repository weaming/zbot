/**
 * 待发输入队列：回合进行中用户继续输入时先排队，再按模式附加给模型。
 *
 * - `request`：下一次 LLM 请求前附加（TUI 的默认行为，模型当前回合就能看到）
 * - `turn`：等当前回合结束后作为新回合的第一条消息（不打断正在跑的推理）
 *
 * 放在服务端而不是浏览器：刷新页面/换设备后排队内容还在，
 * 而且由 runner 驱动的回合也能消费（浏览器侧队列做不到这一点）。
 */

export type PendingMode = "request" | "turn";

export interface PendingStats {
    request: number;
    turn: number;
}

export interface PendingInput {
    text: string;
}

const queues = new Map<string, Record<PendingMode, PendingInput[]>>();

function stateOf(sessionId: string): Record<PendingMode, PendingInput[]> {
    let state = queues.get(sessionId);
    if (!state) {
        state = { request: [], turn: [] };
        queues.set(sessionId, state);
    }
    return state;
}

export function enqueueInput(sessionId: string, text: string, mode: PendingMode): PendingInput | undefined {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    const input = { text: trimmed };
    stateOf(sessionId)[mode].push(input);
    return input;
}

/** 移除已提交的 steering 消息，避免下一请求再次附加。 */
export function removeInput(sessionId: string, input: PendingInput, mode: PendingMode): boolean {
    const inputs = queues.get(sessionId)?.[mode];
    const index = inputs?.indexOf(input) ?? -1;
    if (!inputs || index < 0) return false;
    inputs.splice(index, 1);
    return true;
}

/** 原子取走某模式的全部输入（消费即清空，避免重复带到多个请求）。 */
export function takeInputs(sessionId: string, mode: PendingMode): string[] | undefined {
    const state = queues.get(sessionId);
    if (!state || state[mode].length === 0) return undefined;
    const taken = state[mode];
    state[mode] = [];
    return taken.map(input => input.text);
}

export function pendingStats(sessionId: string): PendingStats {
    const state = queues.get(sessionId);
    if (!state) return { request: 0, turn: 0 };
    return { request: state.request.length, turn: state.turn.length };
}

export function clearInputs(sessionId: string): void {
    queues.delete(sessionId);
}

/** 把多条排队输入合成一条消息：同一回合里连续输入视为一段，而不是多个回合。 */
export function joinInputs(inputs: string[]): string {
    return inputs.join("\n\n");
}
