import { execFile } from "node:child_process";

const REWRITE_TIMEOUT_MS = 2_000;
const MAX_REWRITE_BYTES = 1024 * 1024;

/** 解析已通过简单脚本检查的参数，仅用于白名单判断，不重新生成命令。 */
function parseSimpleArgs(command: string): string[] {
    const args: string[] = [];
    let quote = "";
    let word = "";
    let hasWord = false;

    for (let index = 0; index < command.length; index++) {
        const char = command[index]!;
        if (char === "\\" && quote !== "'") {
            const next = command[index + 1]!;
            if (quote === '"' && !'"\\$`'.includes(next)) word += char;
            word += next;
            hasWord = true;
            index++;
        } else if (quote) {
            if (char === quote) quote = "";
            else word += char;
        } else if (char === "'" || char === '"') {
            quote = char;
            hasWord = true;
        } else if (/\s/.test(char)) {
            if (hasWord) args.push(word);
            word = "";
            hasWord = false;
        } else {
            word += char;
            hasWord = true;
        }
    }
    if (hasWord) args.push(word);
    return args;
}

/** Bun 仅允许测试路径、测试名筛选与超时；未知参数保持原样。 */
function isPlainBunTest(command: string): boolean {
    if (!/^bun\s+test(?:\s|$)/.test(command)) return false;
    const args = parseSimpleArgs(command).slice(2);

    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!;
        if (arg === "-t" || arg === "--test-name-pattern" || arg === "--timeout") {
            const value = args[++index];
            if (value === undefined || value.startsWith("-")) return false;
            if (arg === "--timeout" && !/^\d+$/.test(value)) return false;
            continue;
        }
        if (/^--timeout=\d+$/.test(arg) || /^--test-name-pattern=.+/.test(arg)) continue;
        if (arg.startsWith("-") || /[*?\[\]~]/.test(arg)) return false;
    }
    return true;
}

/** 只拆分简单命令链；无法确定 shell 语义时保留整段脚本。 */
function splitSimpleCommands(command: string): string[] | undefined {
    const parts: string[] = [];
    let quote = "";
    let start = 0;

    for (let index = 0; index < command.length; index++) {
        const char = command[index]!;
        if (quote === "'") {
            if (char === "'") quote = "";
            continue;
        }
        if (char === "$" || char === "`") return;
        if (char === "\\") {
            if (index + 1 >= command.length || command[index + 1] === "\n") return;
            index++;
            continue;
        }
        if (quote === '"') {
            if (char === '"') quote = "";
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }
        if ("|<>(){}#".includes(char)) return;
        if (char === "&" && command[index + 1] !== "&") return;
        if (char !== ";" && char !== "\n" && char !== "&") continue;

        const separatorEnd = char === "&" ? index + 2 : index + 1;
        parts.push(command.slice(start, index), command.slice(index, separatorEnd));
        start = separatorEnd;
        index = separatorEnd - 1;
    }

    if (quote) return;
    parts.push(command.slice(start));
    return parts;
}

/** 重写阶段不执行用户命令；不可用时回退原命令，取消则交给调用方处理。 */
async function rewriteCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
    const expectedPrefix = /^git\s+/.test(command) ? "git" : isPlainBunTest(command) ? "bun test" : undefined;
    if (!expectedPrefix) return command;

    return new Promise((resolve, reject) => {
        execFile("rtk", ["rewrite", command], {
            cwd,
            env,
            signal,
            timeout: REWRITE_TIMEOUT_MS,
            maxBuffer: MAX_REWRITE_BYTES,
            encoding: "utf8",
        }, (error, stdout) => {
            if (signal?.aborted) {
                reject(new DOMException("The operation was aborted", "AbortError"));
                return;
            }
            const canRewrite = !error || (error.code === 3 && !error.killed);
            const rewritten = stdout.trim();
            const actualPrefix = rewritten.match(/^rtk\s+(git|bun\s+test)(?:\s|$)/)?.[1]?.replace(/\s+/g, " ");
            if (canRewrite && actualPrefix === expectedPrefix) {
                resolve(rewritten);
                return;
            }
            if (error && error.code !== "ENOENT" && error.code !== 1 && error.code !== 2) {
                const reason = error.killed ? "超时或输出超限" : `状态码 ${error.code ?? "未知"}`;
                console.warn(`[rtk] 命令重写失败，使用原命令：${reason}`);
            }
            resolve(command);
        });
    });
}

/** 仅对简单命令链中的 git 与普通 bun test 启用 RTK，其余内容逐字保留。 */
export async function rewriteShellCommand(
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal,
): Promise<string> {
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    if (env.RTK_DISABLED === "1") return command;

    const parts = splitSimpleCommands(command);
    if (!parts) return command;

    for (let index = 0; index < parts.length; index += 2) {
        const part = parts[index]!;
        if (!/^\s*(?:git\s+|bun\s+test(?:\s|$))/.test(part)) continue;
        const leadingSpace = part.match(/^\s*/)?.[0] ?? "";
        const trailingSpace = part.match(/\s*$/)?.[0] ?? "";
        const rewritten = await rewriteCommand(part.trim(), cwd, env, signal);
        parts[index] = `${leadingSpace}${rewritten}${trailingSpace}`;
    }
    return parts.join("");
}
