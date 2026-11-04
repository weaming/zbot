/**
 * `zbot session` 的输入输出注入点：stdout、stdin 与「无持有者时的一次性宿主」。
 * 测试用它们替换真实 IO，命令逻辑不直接摸 process。
 */

import { readStdinText as readPipeStdin } from "../../utils/stdin.js";

/** 一次性本地宿主的装配形态（send 无持有者时临时接管用）。 */
export interface LocalSendHost {
    createSessionForCli(cwd: string, init?: { origin?: "user" | "web" | "job" | "tool"; title?: string }): Promise<{ sessionId: string }>;
    claimSession(sessionId: string, options?: { noNegotiate?: boolean }): Promise<{ ok: boolean; reason?: string; message?: string }>;
    executePeerCommandLocally(
        sessionId: string,
        text: string,
    ): Promise<
        | { kind: "command"; ok: boolean; output: string; stopReason: string; finish: () => Promise<void> }
        | { kind: "prompt"; prompt: string }
    >;
    sendMessage(sessionId: string, text: string): Promise<{ aborted?: boolean }>;
    subscribeEvents(...args: any[]): () => void;
    abortSession(sessionId: string): Promise<boolean>;
    close(): Promise<void>;
}

export interface SessionCliIO {
    /** 标准输出：默认写 process.stdout。 */
    write?: (text: string) => void;
    /** 读取 stdin（send 未给文本时用）；默认读到 EOF。 */
    readStdin?: () => Promise<string>;
    /** send 无持有者时的一次性宿主（测试注入；默认创建真实 LocalSessionHost + 运行时）。 */
    createLocalSendHost?: (startupCwd: string) => Promise<LocalSendHost>;
}


/** 默认 stdin 读取：交互式终端下不等 stdin（没有正文应立刻报用法错误，而不是挂住进程）。 */
export function readSessionStdin(): Promise<string> {
    return readPipeStdin({ tty: "empty" });
}

/** 会话摘要 + 真实创建时间（取首条事件 ts；Session.createdAt 是重放时刻，不能代表创建时间）。 */
