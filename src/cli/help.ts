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
    "  zbot                       启动 TUI（默认）：自动新建空会话并进入",
    "  zbot -p <文本>             已禁用：模型回合必须由 TUI 或后台实例执行",
    "  zbot resume <id>           载入旧会话并进入 TUI（无 UI 续聊已禁用）",
    "  zbot session <子命令>      会话管理：list/show/new/run/rename/archive/send/wait/queue/delete",
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
    "用法：zbot -p <文本> [选项]（已禁用）",
    "",
    "CLI 不会在没有 TUI 或后台持有者时直接启动模型回合。",
    "",
    "请启动 zbot TUI 后用 `zbot session send <id> <文本> --wait`，或通过 `zbot serve` 提交后台任务。",
].join("\n");

export const SESSION_CLI_USAGE = [
    "用法：zbot session <子命令> [参数]",
    "",
    "  list [--all] [--held] [-n N] [--json]     列出会话（默认不含归档，最近更新在前）",
    "  show [id] [--last] [--turns N|--all] [--full] [--lite] [--json]",
    "                                            查看会话与消息（默认当前会话，最近 3 轮）",
    "  new [--title 标题] [--cwd 目录] [--json]  新建会话",
    "  run <文本> [--title 标题] [--cwd 目录] [--json]",
    "                                            已禁用：请使用 TUI 或后台任务服务",
    "  rename <id> <标题>                        重命名会话",
    "  archive <id> / unarchive <id>             归档 / 取消归档",
    "  delete <id>                               彻底删除会话的全部落盘数据",
    "  send <id> <文本> [--wait[=秒]] [--json]   向会话投递消息；--wait 一直等到回合终态",
    "       [--no-queue] [--expires=秒]          目标忙时默认排队；--no-queue 立即失败",
    "       [--cancel=<msgId>]                    撤销排队中的消息",
    "       目标必须由 TUI 或后台实例持有；无人持有时拒绝执行",
    "  wait [id] [--msg=<msgId>|--turn=<turnId>] [--timeout=秒] [--json]",
    "                                            等回合进入终态并输出最终结果/错误",
    "  queue <id> [--json]                       查看排队中的投递",
    "",
    "id 可省略表示「当前会话」（TUI 最近进入的会话，或 ZBOT_SESSION_ID）。",
    "id 支持完整 id、唯一前缀或末几位；写操作要求会话未被其他实例持有。",
    "",
    "等待语义：--wait 不带秒数 = 一直等到 succeeded/failed/cancelled；--wait=秒 或",
    "--timeout=秒 是显式上限（超时退出码 2，消息已投递，不要重发）。Ctrl-C 只停止等待，",
    "不取消目标回合；之后可用 `zbot session wait <id> --msg=<msgId>` 继续等。",
].join("\n");

export const RESUME_CLI_USAGE = [
    "用法：zbot resume <id> [选项]",
    "",
    "  <id>              会话 id：完整 id、唯一前缀或末几位",
    "  -p, --print       已禁用：CLI 不会自行启动模型回合",
    "  --unarchive       目标会话已归档时先恢复再进入",
    "",
    "载入旧会话并打开 TUI。需要从 CLI 发消息时，目标会话必须由 TUI 或后台实例持有，",
    "使用 `zbot session send <id> <文本> --wait` 投递并等待结果。",
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
