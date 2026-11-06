/**
 * `zbot herdr` 的命令解析：字符串 → 命令结构，不碰 herdr、也不碰会话存储。
 */

import { AppError } from "../../utils/app-error.js";
import { HERDR_CLI_USAGE } from "../help.js";

/** 等新 TUI 认领会话的默认上限：冷启动通常 1-3 秒。 */
const DEFAULT_READY_TIMEOUT_SECONDS = 30;

/** 带机器可读分类与退出码的 CLI 错误：`--json` 调用方靠 code 判断下一步。 */
export class HerdrCliError extends AppError {
    constructor(code: string, message: string, exitCode = 1, details: Record<string, unknown> = {}) {
        super(code, message, exitCode, details);
        this.name = "HerdrCliError";
    }
}

export function usageError(message: string): HerdrCliError {
    return new HerdrCliError("usage", message);
}

export interface SpawnCommand {
    kind: "spawn";
    /** 首条用户输入；空串表示只建标签页与会话，不投递。 */
    text: string;
    /** 会话标题：必填，同时是新标签页的默认标签。 */
    title: string;
    /** 标签页标签；缺省取 title。 */
    label?: string;
    /** 新标签页与会话的工作目录：必填（相对路径按调用方 cwd 解析）。 */
    cwd: string;
    /** 目标 workspace；缺省用 $HERDR_WORKSPACE_ID。 */
    workspace?: string;
    /** 新建后切换过去；默认不抢焦点。 */
    focus: boolean;
    /** 等 TUI 认领会话的上限，0 表示不等待。 */
    readyTimeoutSeconds: number;
    json: boolean;
}

export interface TeardownCommand {
    kind: "teardown";
    /** 会话 id：完整 ULID、唯一前缀或末几位。 */
    id: string;
    /** 目标标签页；缺省按 pane 的 metadata token / 标题自动匹配。 */
    tab?: string;
    /** 明确指定 pane（与 --tab 二选一即可）。 */
    pane?: string;
    /** 匹配 pane 用的 workspace；缺省用 $HERDR_WORKSPACE_ID。 */
    workspace?: string;
    json: boolean;
}

export type HerdrCommand = { kind: "help" } | SpawnCommand | TeardownCommand;

export function parseHerdrArgs(argv: string[]): HerdrCommand {
    const [command, ...rest] = argv;
    switch (command) {
        case undefined:
        case "help":
        case "-h":
        case "--help":
            return { kind: "help" };
        case "spawn":
            return parseSpawnArgs(rest);
        case "teardown":
            return parseTeardownArgs(rest);
        default:
            throw usageError(`未知子命令：${command}\n\n${HERDR_CLI_USAGE}`);
    }
}

function parseSpawnArgs(args: string[]): SpawnCommand {
    const command: SpawnCommand = {
        kind: "spawn",
        text: "",
        title: "",
        cwd: "",
        focus: false,
        readyTimeoutSeconds: DEFAULT_READY_TIMEOUT_SECONDS,
        json: false,
    };
    const textParts: string[] = [];
    // `--` 之后一律当首条输入，允许正文以 - 开头
    let literal = false;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (!literal && arg === "--") {
            literal = true;
            continue;
        }
        if (!literal) {
            if (arg === "--json") { command.json = true; continue; }
            if (arg === "--focus") { command.focus = true; continue; }
            if (arg === "--title") {
                command.title = requireValue(args[index + 1], "--title");
                index += 1;
                continue;
            }
            if (arg.startsWith("--title=")) {
                command.title = requireValue(arg.slice("--title=".length), "--title");
                continue;
            }
            if (arg === "--label") {
                command.label = requireValue(args[index + 1], "--label");
                index += 1;
                continue;
            }
            if (arg.startsWith("--label=")) {
                command.label = requireValue(arg.slice("--label=".length), "--label");
                continue;
            }
            if (arg === "--cwd") {
                command.cwd = requireValue(args[index + 1], "--cwd");
                index += 1;
                continue;
            }
            if (arg.startsWith("--cwd=")) {
                command.cwd = requireValue(arg.slice("--cwd=".length), "--cwd");
                continue;
            }
            if (arg === "--workspace") {
                command.workspace = requireValue(args[index + 1], "--workspace");
                index += 1;
                continue;
            }
            if (arg.startsWith("--workspace=")) {
                command.workspace = requireValue(arg.slice("--workspace=".length), "--workspace");
                continue;
            }
            if (arg === "--ready-timeout") {
                command.readyTimeoutSeconds = parseNonNegativeInt(args[index + 1], "--ready-timeout");
                index += 1;
                continue;
            }
            if (arg.startsWith("--ready-timeout=")) {
                command.readyTimeoutSeconds = parseNonNegativeInt(
                    arg.slice("--ready-timeout=".length),
                    "--ready-timeout",
                );
                continue;
            }
            if (arg.startsWith("-") && arg !== "-") {
                throw usageError(`spawn 不支持参数：${arg}（正文以 - 开头时用 -- 分隔）`);
            }
        }
        textParts.push(arg);
    }
    command.text = textParts.join(" ").trim();
    // 标题与目录都不猜：猜错会把会话开到别的目录、标签页也认不出来
    if (!command.title.trim()) throw usageError("spawn 需要 --title（同时作为标签页标签）");
    if (!command.cwd.trim()) throw usageError("spawn 需要 --cwd（新标签页与会话的工作目录）");
    return command;
}

function requireValue(value: string | undefined, flag: string): string {
    if (!value || value.startsWith("-")) throw usageError(`${flag} 需要取值`);
    return value;
}

function parseNonNegativeInt(value: string | undefined, flag: string): number {
    // 空串会被 Number 当成 0：`--ready-timeout=` 是用法错误，不是「不等待」
    if (!value || !value.trim()) throw usageError(`${flag} 需要非负整数`);
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) throw usageError(`${flag} 需要非负整数`);
    return parsed;
}

function parseTeardownArgs(args: string[]): TeardownCommand {
    const command: TeardownCommand = { kind: "teardown", id: "", json: false };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (arg === "--json") { command.json = true; continue; }
        if (arg === "--tab") {
            command.tab = requireValue(args[index + 1], "--tab");
            index += 1;
            continue;
        }
        if (arg.startsWith("--tab=")) {
            command.tab = requireValue(arg.slice("--tab=".length), "--tab");
            continue;
        }
        if (arg === "--pane") {
            command.pane = requireValue(args[index + 1], "--pane");
            index += 1;
            continue;
        }
        if (arg.startsWith("--pane=")) {
            command.pane = requireValue(arg.slice("--pane=".length), "--pane");
            continue;
        }
        if (arg === "--workspace") {
            command.workspace = requireValue(args[index + 1], "--workspace");
            index += 1;
            continue;
        }
        if (arg.startsWith("--workspace=")) {
            command.workspace = requireValue(arg.slice("--workspace=".length), "--workspace");
            continue;
        }
        if (arg.startsWith("-") && arg !== "-") throw usageError(`teardown 不支持参数：${arg}`);
        if (command.id) throw usageError("teardown 只接受一个会话 id");
        command.id = arg;
    }
    if (!command.id) throw usageError("用法：zbot herdr teardown <会话 id> [--tab=<tabId>] [--json]");
    return command;
}
