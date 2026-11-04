/**
 * 读到 EOF 的 stdin 文本读取。
 *
 * 交互式终端下先给一行提示：不带文本的 `-p` 会等 EOF，没有提示时用户容易以为卡死。
 */
export async function readStdinText(
    options: { hint?: string; tty?: "block" | "empty" } = {},
): Promise<string> {
    // tty=empty：交互式终端下不等 stdin（调用方要的是立刻报用法错误，而不是挂住进程）
    if (options.tty === "empty" && process.stdin.isTTY) return "";
    if (options.hint && process.stdin.isTTY) {
        process.stderr.write(`${options.hint}\n`);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
}
