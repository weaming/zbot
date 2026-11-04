/**
 * `zbot resume`：进入旧会话。
 * - 不带 -p：由 TUI 载入该会话（入口在 tui/main.ts 里装配）。
 * - 带 -p：无 UI 续聊，把本回合最终输出写到 stdout，供 AI/脚本调用。
 *
 * 所有权规则：恢复前必须不协商地认领会话；被其他实例持有直接失败并提示
 * `session send`，避免两个进程同时写同一份事件日志。
 */

import { listSavedSessionIds } from "../events/session-files.js";
import { redirectLogsToFile } from "../host/runtime-context.js";
import { prepareSessionResume } from "../host/session-resume.js";
import { LocalSessionHost, initializeSessionHostRuntime } from "../host/session-host.js";
import type { SessionHost } from "../host/session-host-types.js";
import { AppError } from "../utils/app-error.js";
import { readStdinText } from "../utils/stdin.js";
import { extractTurnResult, runHostTurn } from "./session-turn.js";
import { resolveSessionIdFrom } from "./session.js";

export interface ResumeArgs {
    id: string;
    print: boolean;
    prompt: string[];
    json: boolean;
    unarchive: boolean;
}

export interface ResumeCliIO {
    /** 默认写 process.stdout。 */
    write?: (text: string) => void;
    /** -p 未给文本时读 stdin；默认读到 EOF。 */
    readStdin?: () => Promise<string>;
    /** 测试注入：会话 id 解析（默认走磁盘会话列表）。 */
    resolveId?: (input: string) => string;
    /** 测试注入：宿主工厂；默认创建真实的 LocalSessionHost + MCP 客户端。 */
    createHost?: () => Promise<{ host: ResumeSessionHost; close: () => Promise<void> }>;
}

type ResumeSessionHost = Pick<
    SessionHost,
    | "isSessionArchived"
    | "claimSession"
    | "unarchiveSession"
    | "releaseSession"
    | "subscribeEvents"
    | "sendMessage"
    | "abortSession"
>;

export function parseResumeArgs(argv: string[]): ResumeArgs {
    const args: ResumeArgs = { id: "", print: false, prompt: [], json: false, unarchive: false };
    const positionals: string[] = [];
    let literal = false;
    // 正文开始后不再解析开关：正文里出现 `--json` 之类不能把请求文本静默吞掉
    let promptMode = false;
    for (const value of argv) {
        if (literal || promptMode) {
            positionals.push(value);
            continue;
        }
        switch (value) {
            case "--":
                literal = true;
                break;
            case "-p":
            case "--print":
                args.print = true;
                break;
            case "--json":
                args.json = true;
                break;
            case "--unarchive":
                args.unarchive = true;
                break;
            default:
                if (value.startsWith("-") && value !== "-") {
                    throw new AppError("usage", `未知参数：${value}（正文以 - 开头时用 -- 分隔）`);
                }
                positionals.push(value);
                if (args.print && positionals.length > 1) promptMode = true;
        }
    }

    const [id, ...prompt] = positionals;
    if (!id) {
        throw new AppError("usage", "需要会话 id；可用 `zbot session list` 查看");
    }
    if (!args.print && prompt.length > 0) {
        throw new AppError("usage", "只有 -p/--print 模式接受续聊文本");
    }
    if (args.json && !args.print) {
        throw new AppError("usage", "--json 只能与 -p/--print 一起使用");
    }
    return { ...args, id, prompt };
}

/** 复用 session 子命令的 id 规则：完整 id / 唯一前缀 / 唯一后缀。 */
export function resolveResumeId(input: string): string {
    return resolveSessionIdFrom(input, listSavedSessionIds());
}

/** 保留旧导出名：测试与其他调用方沿用它。 */
export const extractResumeResult = extractTurnResult;

/** 交互式终端下等待 stdin 时给一行提示，避免用户以为命令卡住。 */
const readStdin = (): Promise<string> => readStdinText({ hint: "从 stdin 读取续聊文本，^D 结束" });

/**
 * 无 UI 恢复：认领 → 续聊一轮 → 输出结果。
 * 退出码：0 成功；130/143 信号中止；其它失败由 AppError.exitCode 决定。
 */
export async function runResumeCli(args: ResumeArgs, io: ResumeCliIO = {}): Promise<void> {
    const write = io.write ?? ((text: string) => { process.stdout.write(text); });
    const prompt = (args.prompt.length > 0 ? args.prompt.join(" ") : await (io.readStdin ?? readStdin)()).trim();
    if (!prompt) throw new AppError("usage", "请提供续聊文本，或通过 stdin 输入");

    const sessionId = (io.resolveId ?? resolveResumeId)(args.id);
    if (io.createHost) {
        const injected = await io.createHost();
        try {
            await prepareSessionResume(injected.host, sessionId, { unarchive: args.unarchive });
            await runHostTurn({ host: injected.host, sessionId, prompt, json: args.json, write });
        } finally {
            await injected.close();
        }
        return;
    }

    const restoreConsole = redirectLogsToFile();
    try {
        const mcp = await import("../mcp/client-manager.js");
        // 归档/占用检查先于 MCP 初始化：失败路径不必拉起客户端，命令能立刻退出
        let openRuntime!: () => void;
        let failRuntime!: (error: unknown) => void;
        const runtimeGate = new Promise<void>((resolve, reject) => {
            openRuntime = resolve;
            failRuntime = reject;
        });
        const host = new LocalSessionHost(runtimeGate, { startupCwd: process.cwd() });
        // 运行时初始化失败时 gate 会被 reject；没人接的话 Bun 会打出崩溃报告
        void runtimeGate.catch(() => undefined);
        try {
            await prepareSessionResume(host, sessionId, { unarchive: args.unarchive });
            // 一次性命令：不挂技能文件监听，否则监听句柄会让进程用完不退出
            const runtimeReady = initializeSessionHostRuntime({ watchSkills: false });
            runtimeReady.then(openRuntime, failRuntime);
            void runtimeReady.catch(() => undefined);
            await runtimeReady;
            await runHostTurn({ host, sessionId, prompt, json: args.json, write });
        } finally {
            await host.close().catch((error) => {
                console.error("⚠️ [resume] 关闭会话宿主失败:", error);
            });
            await mcp.closeAllMcpClients().catch((error) => {
                console.error("⚠️ [resume] 关闭 MCP 客户端失败:", error);
            });
        }
    } finally {
        restoreConsole();
    }
}
