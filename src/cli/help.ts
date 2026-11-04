/**
 * CLI 用法文本：集中一处，避免实现与文档漂移。
 *
 * 这里只放字符串与纯函数，除 mcp/help.ts 这类零逻辑的文本模块外不 import 任何
 * 运行时模块 —— TUI 入口在初始化宿主环境之前就静态依赖它，帮助输出不该把
 * provider / MCP 客户端之类的重模块拉进 TUI 的静态图。
 */

import { MCP_CLI_USAGE } from "../mcp/help.js";

export const MAIN_CLI_USAGE = [
    "用法：zbot [子命令] [参数]",
    "",
    "  zbot                       启动 TUI 聊天界面（默认）",
    "  zbot -p <文本>             单次问答，回答后退出",
    "  zbot resume <id>           载入旧会话：默认进 TUI，加 -p 则无 UI 续聊",
    "  zbot session <子命令>      会话管理：list/show/new/run/rename/archive/send/queue/delete",
    "  zbot serve                 启动 Web 任务看板与 HTTP 接口",
    "  zbot mcp <子命令>          配置 MCP 服务：list/add/remove",
    "  zbot help [子命令]         查看用法",
    "",
    "每个子命令都支持 -h / --help，例如 `zbot serve --help`。",
].join("\n");

export const SERVE_CLI_USAGE = [
    "用法：zbot serve [选项]",
    "",
    "  --port <端口>    监听端口，默认 8787",
    "  --bind <地址>    监听地址，默认 127.0.0.1",
    "  --cwd <目录>     任务与会话的默认工作目录，默认当前目录",
    "  --token <令牌>   访问令牌；缺省取 ZBOT_SERVE_TOKEN，再取 ~/.zbot/serve/token",
    "",
    "首次启动生成令牌并落盘（0600）。启动后用浏览器打开 http://127.0.0.1:<端口>/，",
    "页面壳不需要令牌；数据接口需带 Authorization: Bearer <令牌>（SSE 与图片用 ?token=）。",
].join("\n");

export const PRINT_CLI_USAGE = [
    "用法：zbot -p <文本> [选项]",
    "",
    "  -p, --print      单次问答模式，必须作为首个参数",
    "  --cwd <目录>     工作目录，默认当前目录",
    "  --model <名称>   本次覆盖使用的模型",
    "  --json           输出 {\"content\",\"toolCalls\"} 结构化结果",
    "",
    "不给文本时从 stdin 读取任务。",
].join("\n");

export const SESSION_CLI_USAGE = [
    "用法：zbot session <子命令> [参数]",
    "",
    "  list [--all] [--json]                     列出会话（默认不含归档）",
    "  show <id> [--turns N|--all] [--full] [--json]",
    "                                            查看会话与消息（默认最近 3 轮）",
    "  new [--title 标题] [--cwd 目录] [--json]  新建会话",
    "  run <文本> [--title 标题] [--cwd 目录] [--json]",
    "                                            新建会话并立即执行（原子认领）",
    "  rename <id> <标题>                        重命名会话",
    "  archive <id> / unarchive <id>             归档 / 取消归档",
    "  delete <id>                               彻底删除会话的全部落盘数据",
    "  send <id> <文本> [--wait[=秒]] [--json]   向运行中的会话投递消息（秒数写成 --wait=秒）",
    "       [--no-queue] [--expires=秒]          目标忙时默认排队；--no-queue 立即失败",
    "       [--cancel=<msgId>]                    撤销排队中的消息",
    "  queue <id> [--json]                       查看排队中的投递",
    "",
    "id 支持完整 id、唯一前缀或末几位；写操作要求会话未被其他实例持有。",
].join("\n");

export const RESUME_CLI_USAGE = [
    "用法：zbot resume <id> [选项]",
    "",
    "  <id>              会话 id：完整 id、唯一前缀或末几位",
    "  -p, --print       无 UI 续聊：把本回合最终输出写到 stdout（不给文本时读 stdin）",
    "  --json            与 -p 一起用：输出 {sessionId,content,aborted,toolCalls}",
    "  --unarchive       目标会话已归档时先恢复再进入",
    "",
    "开关要写在续聊文本之前（正文开始后不再解析开关）；文本本身以 - 开头时用 `--` 分隔。",
    "不带 -p 时载入旧会话并打开 TUI。会话被其他实例持有时直接失败；",
    "如需让运行中的实例继续处理，请改用 `zbot session send` 投递消息。",
].join("\n");

const HELP_FLAGS = new Set(["-h", "--help"]);

function usageFor(topic: string): string {
    switch (topic) {
        case "serve":
            return SERVE_CLI_USAGE;
        case "-p":
        case "--print":
            return PRINT_CLI_USAGE;
        case "session":
        case "sessions":
            return SESSION_CLI_USAGE;
        case "resume":
            return RESUME_CLI_USAGE;
        case "mcp":
            return MCP_CLI_USAGE;
        case "print":
            return PRINT_CLI_USAGE;
        default:
            // 未知主题（含 `zbot help foo`）回落到总览，别让用户停在纠结里
            return MAIN_CLI_USAGE;
    }
}

/**
 * 命中帮助请求就打印并返回 true，调用方据此跳过宿主初始化。
 *
 * 认三种写法：`zbot help [子命令]`、`zbot -h [子命令]`、`zbot <子命令> ... -h`；
 * 帮助开关可以出现在子命令参数之后（`zbot session list --help`）。
 * `--` 之后是字面量（如 `session send <id> -- --help`），不参与判定。
 */
export function printCliHelp(argv: string[]): boolean {
    const literalAt = argv.indexOf("--");
    const scan = literalAt === -1 ? argv : argv.slice(0, literalAt);
    if (scan[0] !== "help" && !scan.some(value => HELP_FLAGS.has(value))) return false;

    const words = scan[0] === "help" ? scan.slice(1) : scan;
    const topic = words.find(value => value !== "help" && !HELP_FLAGS.has(value)) ?? "";
    process.stdout.write(`${usageFor(topic)}\n`);
    return true;
}
