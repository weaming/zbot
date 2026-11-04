/**
 * 带机器可读分类的应用错误：code 供脚本分流，exitCode 决定进程退出码，
 * details 原样并入 `--json` 错误对象。
 *
 * 放在 utils 而非 cli：宿主与 CLI 都会抛出同一种错误，调用方（cli/、tui/main）
 * 统一用 `writeCliError` 输出。
 */
export class AppError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly exitCode = 1,
        readonly details: Record<string, unknown> = {},
    ) {
        super(message);
        this.name = "AppError";
    }
}

/**
 * 把一个 CLI 失败写到终端：`--json` 输出结构化错误（stdout），否则输出人读文案（stderr）。
 * 只设置 process.exitCode、不调 process.exit，避免管道输出被截断。
 */
export function writeCliError(error: unknown, json: boolean): void {
    const message = error instanceof Error ? error.message : String(error);
    const shaped = error as { code?: unknown; exitCode?: unknown; details?: unknown } | null;
    const code = typeof shaped?.code === "string" ? shaped.code : "failed";
    const exitCode = typeof shaped?.exitCode === "number" ? shaped.exitCode : 1;
    const details = shaped?.details && typeof shaped.details === "object"
        ? shaped.details as Record<string, unknown>
        : {};
    process.exitCode = exitCode;
    if (json) {
        process.stdout.write(`${JSON.stringify({ error: { ...details, code, message } })}\n`);
    } else {
        process.stderr.write(`${message}\n`);
    }
}
