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
    "  zbot herdr <子命令>        在 herdr 里开新标签页并启动新会话：spawn",
    "  zbot mcp <子命令>          配置 MCP 服务：list/add/remove",
    "  zbot help [子命令]         查看用法",
    "",
    "每个子命令都支持 -h / --help，例如 `zbot session --help`。",
].join("\n");

export const WEB_CLI_USAGE = [
    "用法：zbot web [选项]",
    "",
    "  --port <端口>    监听端口，默认 8787",
    "  --bind <地址>    监听地址，默认 127.0.0.1",
    "  --cwd <目录>     任务与会话的默认工作目录，默认当前目录",
    "  --token <令牌>   访问令牌；缺省取 ZBOT_WEB_TOKEN，再取 ~/.zbot/web/token",
    "",
    "首次启动生成令牌并落盘（0600）。启动后用浏览器打开 http://127.0.0.1:<端口>/，",
    "页面壳不需要令牌；数据接口（含 SSE 与图片）一律带 Authorization: Bearer <令牌>。",
].join("\n");

export const PRINT_CLI_USAGE = [
    "用法：zbot -p <文本> [选项]（已禁用）",
    "",
    "CLI 不会在没有 TUI 或后台持有者时直接启动模型回合。",
    "",
    "请启动 zbot TUI 后用 `zbot session send <id> <文本> --wait` 投递任务。",
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

export const HERDR_CLI_USAGE = [
    "用法：zbot herdr <子命令> [参数]",
    "",
    "  spawn [文本] [选项]        新建 herdr 标签页并启动一个新 zbot 会话",
    "  teardown <id> [选项]       收尾：归档会话 + 关掉它的标签页（投递成功即返回）",
    "",
    "  --title 标题               会话标题（必填）；也作为新标签页的默认标签",
    "  --label 标签               标签页标签（默认同 --title）",
    "  --cwd 目录                 新标签页与会话的工作目录（必填，相对路径按当前目录）",
    "  --workspace id             目标 herdr workspace，默认 $HERDR_WORKSPACE_ID",
    "  --focus                    新标签页建好后切换过去（默认不抢焦点）",
    "  --ready-timeout=秒         等新 TUI 认领会话的上限，默认 30；0 表示不等",
    "  --json                     输出会话元数据、herdr 元数据与后续命令（commands/hints）",
    "  -h, --help                 查看用法",
    "",
    "只能在 herdr 内运行（HERDR_ENV=1），否则直接报 herdr_unavailable。",
    "位置参数是首条用户输入，正文以 - 开头时用 -- 分隔；不给正文就只建标签页与会话。",
    "返回里的 commands 覆盖后续动作：wait 等结果、send 继续发、show 看进度、",
    "archive 归档、close 让 TUI 释放会话、closeTab 关标签页、teardown 归档+关标签页。",
    "",
    "teardown 选项：--tab=<tabId> / --pane=<paneId> / --workspace=<id> 指定目标",
    "（缺省在同一 workspace 内按 pane 元数据自动匹配），",
    "--json 输出结构化结果。会话正在执行回合时拒绝，先等这一轮结束。",
].join("\n");

const HELP_FLAGS = new Set(["-h", "--help"]);

function usageFor(topic: string): string {
    switch (topic) {
        case "web":
            return WEB_CLI_USAGE;
        case "-p":
        case "--print":
            return PRINT_CLI_USAGE;
        case "session":
        case "sessions":
            return SESSION_CLI_USAGE;
        case "herdr":
            return HERDR_CLI_USAGE;
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
