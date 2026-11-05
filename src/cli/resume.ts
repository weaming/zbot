/**
 * `zbot resume`：进入旧会话。
 * - 不带 -p：由 TUI 载入该会话（入口在 tui/main.ts 里装配）。
 * - 带 -p：旧无 UI 执行模式，保留参数解析但明确拒绝。
 *
 * 所有权规则：恢复前必须不协商地认领会话；被其他实例持有直接失败并提示
 * `session send`，避免两个进程同时写同一份事件日志。
 */

import type { AgentEvent } from "../events/agent-events.js";
import { listSavedSessionIds } from "../events/session-files.js";
import { AppError } from "../utils/app-error.js";
import { resolveSessionIdFrom } from "./session.js";

export interface ResumeArgs {
    id: string;
    print: boolean;
    prompt: string[];
    json: boolean;
    unarchive: boolean;
}

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

/** 兼容旧入口名，但不再允许 CLI 自建宿主执行回合。 */
export async function runResumeCli(_args: ResumeArgs): Promise<void> {
    throw new AppError(
        "tui_or_backend_required",
        "resume -p 已禁用：CLI 不会自行启动模型。请使用 `zbot resume <id>` 打开 TUI 后发送消息，或通过 `zbot serve` 提交后台任务。",
    );
}

/** 从历史事件取最后一条有正文的 assistant 消息及工具调用数。 */
export function extractResumeResult(events: AgentEvent[]): { content: string; toolCalls: number } {
    let content = "";
    let toolCalls = 0;
    for (const event of events) {
        if (event.type !== "turn_message" || event.payload.message.role !== "assistant") continue;
        const message = event.payload.message;
        if (typeof message.content === "string" && message.content.trim()) content = message.content;
        toolCalls += message.tool_calls?.length ?? 0;
    }
    return { content, toolCalls };
}
