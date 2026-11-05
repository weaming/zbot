/**
 * `zbot session` 的输入输出注入点：stdout 与 stdin。
 * 测试用它们替换真实 IO，命令逻辑不直接摸 process。
 */

import { readStdinText as readPipeStdin } from "../../utils/stdin.js";

export interface SessionCliIO {
    /** 标准输出：默认写 process.stdout。 */
    write?: (text: string) => void;
    /** 读取 stdin（send 未给文本时用）；默认读到 EOF。 */
    readStdin?: () => Promise<string>;
}


/** 默认 stdin 读取：交互式终端下不等 stdin（没有正文应立刻报用法错误，而不是挂住进程）。 */
export function readSessionStdin(): Promise<string> {
    return readPipeStdin({ tty: "empty" });
}

/** 会话摘要 + 真实创建时间（取首条事件 ts；Session.createdAt 是重放时刻，不能代表创建时间）。 */
