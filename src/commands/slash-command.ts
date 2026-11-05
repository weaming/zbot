/**
 * 斜杠命令的统一解析层：TUI 输入与会话间投递共用同一份命令清单与参数协议。
 *
 * 语义（契约）：
 * - 只有**原文第一个字符**就是 `/` 才尝试识别；前导空格、空串都按普通文本处理；
 * - 只认完整命令名（大小写敏感），`/helpx`、`/` 都不会误判成 `/help`；
 * - 未识别的 `/xxx` 一律按普通纯文本交给模型（TUI 与 session send 一致）；
 * - 已识别的命令按 `usage` 逐项校验参数，非法参数返回明确错误，绝不静默吞掉。
 */

import { CHAT_API_PROTOCOLS, type ChatApiProtocol } from "../types/chat-model.js";

/**
 * 会话间消息（peer）里各命令的执行方式。
 *
 * 不存在"不能远程执行"的命令：面板类命令在这里都有等价的文本/JSON 视图与参数，
 * 差别只在由谁执行、以及是否转成模型指令。
 */
export type SlashCommandPeerPolicy =
    /** 转成一段模型指令执行（如 /review）。 */
    | "prompt"
    /** 宿主原生控制命令：在目标会话里由宿主直接执行，结果文本回传调用方。 */
    | "host";

export interface SlashCommandSpec {
    /** 不含 `/` 的命令名。 */
    name: string;
    description: string;
    /** 用法示例（错误文案与帮助共用）。 */
    usage: string;
    peer: SlashCommandPeerPolicy;
    /** 归档态会话也能执行：这类命令不要求会话可写（不需要活动会话视图）。 */
    archived?: boolean;
    /** 支持 `--json`：输出机器可读的结构化结果。 */
    json?: boolean;
    /** 最多参数个数，缺省 0。 */
    maxArgs?: number;
    /** 剩余文本整体作为第一个参数（路径可含空格）。 */
    remainder?: boolean;
    /** 参数取值校验：返回错误文案表示非法。 */
    validate?: (args: string[]) => string | undefined;
}

/** /review 发送的固定指令：dev-review → 修复循环，通过后再暂存并提交。 */
/** 固定评审指令；带附加说明时追加在后面，TUI 与会话间投递共用。 */
export function buildReviewPrompt(extra?: string): string {
    const trimmed = extra?.trim();
    return trimmed ? `${REVIEW_PROMPT}\n\n${trimmed}` : REVIEW_PROMPT;
}

export const REVIEW_PROMPT = [
    "Do dev-review-fix loop，until review pass, then commit.",
    "Reuse same subagent, close(archive) it after review pass.",
    "Keep content to be reviewed unstaged, stage them after each review, then fix, next review; so each review can read less diff.",
    "Don't auto start this loop after your commit.",
].join("\n");

const TASK_ACTIONS = ["list", "status", "wait", "stop"] as const;

/**
 * /model 两种写法：`<协议> <模型> [强度|auto]` 与 `effort [档位|auto]`。
 * 协议只能是固定两项，所以 `effort` 这个子命令与"模型名"不会互相误判。
 */
function validateModelArgs(args: string[]): string | undefined {
    const [first, second, third] = args;
    if (first === undefined) return undefined;

    if (first === "effort") {
        if (third !== undefined) return "effort 只接受一个取值。用法：/model effort [档位|auto]";
        if (second !== undefined && !second.trim()) return "思考强度不能为空。用法：/model effort [档位|auto]";
        return undefined;
    }

    if (!CHAT_API_PROTOCOLS.includes(first as ChatApiProtocol)) {
        return `协议需要是 ${CHAT_API_PROTOCOLS.join(" | ")}：${first}。用法：/model <协议> <模型> [强度|auto]`;
    }
    if (!second) return `/model ${first} 需要模型名。用法：/model ${first} <模型> [强度|auto]`;
    if (third !== undefined && !third.trim()) return "思考强度不能为空。用法：/model <协议> <模型> [强度|auto]";
    return undefined;
}

const MCP_ACTIONS = ["enable", "disable"] as const;

function validateMcpArgs(args: string[]): string | undefined {
    const [action, server] = args;
    if (action === undefined) return undefined;
    if (!MCP_ACTIONS.includes(action as typeof MCP_ACTIONS[number])) {
        return `未知子命令：${action}。用法：/mcp 或 /mcp enable|disable <服务名>`;
    }
    if (!server) return `/mcp ${action} 需要服务名。用法：/mcp ${action} <服务名>`;
    return undefined;
}

function validateTasksArgs(args: string[]): string | undefined {
    const [rawAction, taskId, rawWaitSeconds] = args;
    const action = (rawAction ?? "list").toLowerCase();
    if (!TASK_ACTIONS.includes(action as typeof TASK_ACTIONS[number])) {
        return `未知子命令：${rawAction}。用法：/tasks [list|status|wait|stop] [task_id] [wait_seconds]`;
    }
    if (action === "list" && args.length > 1) {
        return "list 不接受额外参数。用法：/tasks [list|status|wait|stop] [task_id] [wait_seconds]";
    }
    if (action !== "list" && !taskId) {
        return `/tasks ${action} 需要 task_id。用法：/tasks ${action} <task_id>${action === "wait" ? " [秒]" : ""}`;
    }
    if (action !== "wait" && rawWaitSeconds !== undefined) {
        return "只有 wait 接受秒数参数。用法：/tasks [list|status|wait|stop] [task_id] [wait_seconds]";
    }
    if (action === "wait" && rawWaitSeconds !== undefined && !/^\d+$/.test(rawWaitSeconds)) {
        return `等待秒数需要非负整数：${rawWaitSeconds}`;
    }
    return undefined;
}

/** 命令矩阵：参数协议与会话间支持策略的唯一事实源。 */
export const SLASH_COMMAND_SPECS: SlashCommandSpec[] = [
    { name: "new", description: "新建会话（在本实例创建并认领，返回会话 id）", usage: "/new [标题]", peer: "host", maxArgs: 1, remainder: true },
    { name: "review", description: "发起 dev-review → 修复循环，通过后暂存并提交", usage: "/review [附加说明]", peer: "prompt", maxArgs: 1, remainder: true },
    {
        name: "sessions",
        description: "列出会话（会话面板的文本视图，可按 id / 标题 / 目录过滤）",
        usage: "/sessions [查询] [--json]",
        peer: "host",
        archived: true,
        json: true,
        maxArgs: 1,
        remainder: true,
    },
    {
        name: "tasks",
        description: "查看或管理后台 shell 任务（list/status/wait/stop）",
        usage: "/tasks [list|status|wait|stop] [task_id] [wait_seconds] [--json]",
        peer: "host",
        json: true,
        maxArgs: 3,
        validate: validateTasksArgs,
    },
    { name: "ps", description: "列出当前会话正在运行的后台任务", usage: "/ps [--json]", peer: "host", json: true },
    {
        name: "stop",
        description: "终止当前会话运行中的后台任务（可指定 id）",
        usage: "/stop [task_id|all]",
        peer: "host",
        maxArgs: 1,
    },
    { name: "reload", description: "重新加载磁盘技能与 MCP 工具", usage: "/reload", peer: "host" },
    {
        name: "keys",
        description: "显示全部快捷键（Ctrl+/ / F1）",
        usage: "/keys [--json]",
        peer: "host",
        archived: true,
        json: true,
    },
    { name: "continue", description: "继续执行未完成的任务（补跑中断的工具或下一次请求）", usage: "/continue", peer: "host" },
    {
        name: "clear",
        description: "清空当前会话（事件日志截断重建）；远程需带 confirm",
        usage: "/clear [confirm]",
        peer: "host",
        maxArgs: 1,
    },
    { name: "archive", description: "归档当前会话（可在会话面板查看）", usage: "/archive", peer: "host" },
    { name: "unarchive", description: "取消归档当前会话", usage: "/unarchive", peer: "host", archived: true },
    {
        name: "delete",
        description: "彻底删除当前会话；远程需带 confirm",
        usage: "/delete [confirm]",
        peer: "host",
        archived: true,
        maxArgs: 1,
    },
    { name: "close", description: "关闭当前会话（释放持有；从未用过的空会话会删除）", usage: "/close", peer: "host" },
    {
        name: "compact",
        description: "压缩当前会话上下文",
        usage: "/compact [附加要求]",
        peer: "host",
        maxArgs: 1,
        remainder: true,
    },
    {
        name: "cwd",
        description: "查看或切换当前会话工作目录（支持 ~ 与相对路径）",
        usage: "/cwd [路径] [--json]",
        peer: "host",
        json: true,
        maxArgs: 1,
        remainder: true,
    },
    {
        name: "model",
        description: "查看/设置模型与思考强度（唯一的模型与强度入口）",
        usage: "/model [--json] | /model <协议> <模型> [强度|auto] | /model effort [档位|auto]",
        peer: "host",
        json: true,
        maxArgs: 3,
        validate: validateModelArgs,
    },

    { name: "system", description: "显示当前 system prompt", usage: "/system [--json]", peer: "host", json: true },
    { name: "skills", description: "显示可用技能", usage: "/skills [--json]", peer: "host", archived: true, json: true },
    {
        name: "mcp",
        description: "MCP 服务状态与 lazy 工具的会话级启用",
        usage: "/mcp [--json] | /mcp enable|disable <服务名>",
        peer: "host",
        json: true,
        maxArgs: 2,
        validate: validateMcpArgs,
    },
    { name: "help", description: "显示帮助", usage: "/help [--json]", peer: "host", archived: true, json: true },
];

export type SlashCommandParse =
    /** 不是命令：原文按普通文本处理。 */
    | { kind: "text" }
    | { kind: "command"; spec: SlashCommandSpec; name: string; args: string[]; json: boolean }
    /** 已识别命令但参数非法：调用方必须报错，不能当文本（但仍带 spec 供 peer 策略分流）。 */
    | { kind: "invalid"; spec: SlashCommandSpec; name: string; message: string; json: boolean };

/** 按契约解析一段原始输入。 */
export function parseSlashCommand(text: string): SlashCommandParse {
    if (!text.startsWith("/")) return { kind: "text" };

    const match = /^\/([^\s]*)/.exec(text);
    const rawName = match?.[1] ?? "";
    const spec = SLASH_COMMAND_SPECS.find(item => item.name === rawName);
    if (!spec) return { kind: "text" };

    // `--json` 是全局开关：独立 token 就算（其余文本原样保留，路径里的空格不能被折叠）
    let tail = text.slice(1 + rawName.length).trim();
    let json = false;
    if (spec.json && /(^|\s)--json(?=\s|$)/.test(tail)) {
        tail = tail.replace(/(^|\s)--json(?=\s|$)/g, " ").trim();
        json = true;
    }
    const args = tail === "" ? [] : (spec.remainder ? [tail] : tail.split(/\s+/));
    const name = `/${rawName}`;

    if (args.length > (spec.maxArgs ?? 0)) {
        return { kind: "invalid", spec, name, json, message: `${name} 参数过多。用法：${spec.usage}` };
    }
    const error = spec.validate?.(args);
    if (error) return { kind: "invalid", spec, name, json, message: error };

    return { kind: "command", spec, name, args, json };
}

/**
 * 给自动补全/高亮用：文本是否落在命令语境（允许 trimStart 后以 `/` 开头）。
 * 只影响提示，不代表可执行；执行口径一律是 `parseSlashCommand` 的“原文首字符”。
 */
export function isKnownSlashCommand(text: string): boolean {
    const parsed = parseSlashCommand(text);
    return parsed.kind === "command" || parsed.kind === "invalid";
}
