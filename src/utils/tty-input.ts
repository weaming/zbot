/**
 * tty 输入队列清理：把"已经到达但没人读"的字节读掉。
 *
 * 为什么要这一步：终端对查询（设备属性、背景色、光标位置……）的回包如果落在输入
 * 队列里没人取，canonical 模式下没有换行就永远读不出来，于是它们会一直躺着，等到
 * 下一个读 stdin 的进程（通常是 shell）才被当成用户输入回显成一串 `^[[?62;22;52c`。
 * 这条队列属于终端设备、不属于进程，进程退出不会清空 —— 只能由"占着终端又从不读
 * stdin"的那个程序在退出前主动读走。
 *
 * 本模块只读 stdin 并丢弃，不写任何字节，也不认识键盘协议、备用屏幕这类前端语义，
 * 因此前端（web）与 TUI 都可以用；终端模式复位那种 TUI 专属逻辑在 src/tui/。
 */

/** 排空所需的最小 stdin 接口：抽象出来是为了可测（生产就是 process.stdin）。 */
export interface InputDrainStream {
    isTTY?: boolean;
    isRaw?: boolean;
    setRawMode?(mode: boolean): void;
    on(event: "data", listener: (chunk?: { length?: number }) => void): unknown;
    off?(event: "data", listener: (chunk?: { length?: number }) => void): unknown;
    removeListener?(event: "data", listener: (chunk?: { length?: number }) => void): unknown;
    resume?(): void;
    pause?(): void;
}

export interface DiscardInputOptions {
    /** 最长总耗时，默认 300ms。 */
    maxMs?: number;
    /** 连续这么久没有新字节就认为队列已空，默认 60ms。 */
    idleMs?: number;
    /** 默认 `process.stdin`。 */
    stdin?: InputDrainStream;
    /** 默认取 `stdin.isTTY`；非终端没有队列可排。 */
    isTTY?: boolean;
}

/**
 * 丢弃 stdin 里已到达但没人读的字节，返回丢掉的字节数。
 *
 * 队列在 canonical 模式下要等到换行才可读，所以先切 raw 再读，读完复原原本的 raw 状态。
 */
export async function discardPendingInput(options: DiscardInputOptions = {}): Promise<number> {
    const stdin = options.stdin ?? (process.stdin as unknown as InputDrainStream);
    if (!(options.isTTY ?? Boolean(stdin.isTTY))) return 0;

    const maxMs = options.maxMs ?? 300;
    const idleMs = options.idleMs ?? 60;
    const wasRaw = Boolean(stdin.isRaw);
    let lastDataAt = Date.now();
    let discarded = 0;

    const onData = (chunk?: { length?: number }): void => {
        discarded += chunk?.length ?? 0;
        lastDataAt = Date.now();
    };

    try {
        stdin.setRawMode?.(true);
        stdin.on("data", onData);
        stdin.resume?.();
        const deadline = lastDataAt + maxMs;
        while (Date.now() - lastDataAt < idleMs && Date.now() < deadline) {
            await new Promise<void>(resolve => setTimeout(resolve, Math.min(idleMs, 10)));
        }
    } catch {
        // stdin 已关闭（管道断开、SSH 掉线）：没有队列可排
    } finally {
        if (stdin.off) stdin.off("data", onData);
        else stdin.removeListener?.("data", onData);
        stdin.pause?.();
        try {
            stdin.setRawMode?.(wasRaw);
        } catch {
            // 终端已关闭：无人可复原
        }
    }
    return discarded;
}
