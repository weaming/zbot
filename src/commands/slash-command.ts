/**
 * 斜杠命令的统一解析层：TUI 输入与会话间投递共用同一份命令清单与参数协议。
 *
 * 语义（契约）：
 * - 只有**原文第一个字符**就是 `/` 才尝试识别；前导空格、空串都按普通文本处理；
 * - 只认完整命令名（大小写敏感），`/helpx`、`/` 都不会误判成 `/help`；
 * - 未识别的 `/xxx` 一律按普通纯文本交给模型（TUI 与 session send 一致）；
 * - 已识别的命令按 `usage` 逐项校验参数，非法参数返回明确错误，绝不静默吞掉。
 */

/** 会话间消息（peer）里各命令的支持策略。 */
export type SlashCommandPeerPolicy =
    /** 可直接执行，输出文本作为结果回传。 */
    | "allow"
    /** 转成一段模型指令执行（如 /review）。 */
    | "prompt"
    /** 依赖 TUI 面板/会话生命周期，从会话间消息执行时明确拒绝。 */
    | "deny";

export interface SlashCommandSpec {
    /** 不含 `/` 的命令名。 */
    name: string;
    description: string;
    /** 用法示例（错误文案与帮助共用）。 */
    usage: string;
    peer: SlashCommandPeerPolicy;
    /** 最多参数个数，缺省 0。 */
    maxArgs?: number;
    /** 剩余文本整体作为第一个参数（路径可含空格）。 */
    remainder?: boolean;
    /** 参数取值校验：返回错误文案表示非法。 */
    validate?: (args: string[]) => string | undefined;
}

/** /review 发送的固定指令：dev-review → 修复循环，通过后再暂存并提交。 */
export const REVIEW_PROMPT = [
    "Do dev-review-fix loop，until review pass, then commit.",
    "Reuse same subagent, close(archive) it after review pass.",
    "Keep content to be reviewed unstaged, stage them after each review, then fix, next review; so each review can read less diff.",
    "Don't auto start this loop after your commit.",
].join("\n");

const TASK_ACTIONS = ["list", "status", "wait", "stop"] as const;

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
    { name: "new", description: "新建会话", usage: "/new", peer: "deny" },
    { name: "review", description: "发起 dev-review → 修复循环，通过后暂存并提交", usage: "/review", peer: "prompt" },
    { name: "sessions", description: "打开会话面板（搜索 / 切换 / 管理）", usage: "/sessions", peer: "deny" },
    {
        name: "tasks",
        description: "查看或管理后台 shell 任务（list/status/wait/stop）",
        usage: "/tasks [list|status|wait|stop] [task_id] [wait_seconds]",
        peer: "allow",
        maxArgs: 3,
        validate: validateTasksArgs,
    },
    { name: "ps", description: "列出当前会话正在运行的后台任务", usage: "/ps", peer: "allow" },
    {
        name: "stop",
        description: "终止当前会话运行中的后台任务（可指定 id）",
        usage: "/stop [task_id|all]",
        peer: "allow",
        maxArgs: 1,
    },
    { name: "reload", description: "重新加载磁盘技能与 MCP 工具", usage: "/reload", peer: "allow" },
    { name: "keys", description: "显示全部快捷键（Ctrl+/ / F1）", usage: "/keys", peer: "deny" },
    { name: "continue", description: "继续执行未完成的任务", usage: "/continue", peer: "deny" },
    { name: "clear", description: "清空当前会话", usage: "/clear", peer: "deny" },
    { name: "archive", description: "归档当前会话（可在会话面板查看）", usage: "/archive", peer: "deny" },
    { name: "unarchive", description: "取消归档当前会话", usage: "/unarchive", peer: "deny" },
    { name: "delete", description: "彻底删除当前会话", usage: "/delete", peer: "deny" },
    { name: "close", description: "关闭当前会话（释放持有，数据保留）", usage: "/close", peer: "deny" },
    { name: "compact", description: "压缩当前会话上下文", usage: "/compact", peer: "deny" },
    { name: "cwd", description: "查看或切换当前会话工作目录（支持 ~ 与相对路径）", usage: "/cwd [路径]", peer: "allow", maxArgs: 1, remainder: true },
    { name: "effort", description: "查看或设置当前会话思考强度 [配置档位|auto]", usage: "/effort [档位|auto]", peer: "allow", maxArgs: 1 },
    { name: "thinking", description: "查看或设置思考强度 (/effort 别名)", usage: "/thinking [档位|auto]", peer: "allow", maxArgs: 1 },
    { name: "model", description: "选择当前会话的协议与模型", usage: "/model", peer: "deny" },
    { name: "reasoning", description: "展开 / 收起思考过程显示", usage: "/reasoning", peer: "deny" },
    { name: "system", description: "显示当前 system prompt", usage: "/system", peer: "allow" },
    { name: "skills", description: "显示可用技能", usage: "/skills", peer: "allow" },
    { name: "mcp", description: "MCP 服务状态与 lazy 工具的会话级启用", usage: "/mcp", peer: "deny" },
    { name: "help", description: "显示帮助", usage: "/help", peer: "allow" },
];

export type SlashCommandParse =
    /** 不是命令：原文按普通文本处理。 */
    | { kind: "text" }
    | { kind: "command"; spec: SlashCommandSpec; name: string; args: string[] }
    /** 已识别命令但参数非法：调用方必须报错，不能当文本。 */
    | { kind: "invalid"; name: string; message: string };

/** 按契约解析一段原始输入。 */
export function parseSlashCommand(text: string): SlashCommandParse {
    if (!text.startsWith("/")) return { kind: "text" };

    const match = /^\/([^\s]*)/.exec(text);
    const rawName = match?.[1] ?? "";
    const spec = SLASH_COMMAND_SPECS.find(item => item.name === rawName);
    if (!spec) return { kind: "text" };

    const tail = text.slice(1 + rawName.length).trim();
    const args = tail === "" ? [] : (spec.remainder ? [tail] : tail.split(/\s+/));
    const name = `/${rawName}`;

    if (args.length > (spec.maxArgs ?? 0)) {
        return { kind: "invalid", name, message: `${name} 参数过多。用法：${spec.usage}` };
    }
    const error = spec.validate?.(args);
    if (error) return { kind: "invalid", name, message: error };

    return { kind: "command", spec, name, args };
}

/**
 * 给自动补全/高亮用：文本是否落在命令语境（允许 trimStart 后以 `/` 开头）。
 * 只影响提示，不代表可执行；执行口径一律是 `parseSlashCommand` 的“原文首字符”。
 */
export function isKnownSlashCommand(text: string): boolean {
    const parsed = parseSlashCommand(text);
    return parsed.kind === "command" || parsed.kind === "invalid";
}
