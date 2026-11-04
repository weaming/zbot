/**
 * cwd 工具：查看 / 切换当前会话的工作目录。
 *
 * - get（默认）：返回当前目录，HOME 前缀显示为 `~`
 * - set：接受 `~`、相对路径（相对当前目录）与绝对路径，目标必须是已存在的目录
 * - 切换落盘为 session_cwd_changed 事件：恢复会话后仍是新目录，其它工具也一起换基准
 *
 * 落盘入口按会话从运行时注册表解析（宿主注册），因此 TUI 与 serve 行为一致；
 * 没有会话上下文时（本地 CLI / 单测）退回进程级 TUI_CWD。
 */

import fs from "node:fs";
import type { ExecutableTool, ToolExecutionResult } from "./tool-interface.js";
import { err, ok } from "./tool-interface.js";
import { formatDisplayPath, getToolCwd, resolveCwdInput } from "../utils/runtime-paths.js";
import { getSessionCwdSetter, hasSessionCapabilityProvider } from "../control/runtime.js";

// 路径解析与展示在 utils/runtime-paths 实现（身份文件插值等非工具层也要用）；这里继续对外导出。
export { formatDisplayPath, resolveCwdInput };

/** 解析并校验目标目录：工具与 /cwd 命令共用，避免两处判定与文案漂移。 */
export type ResolvedDir = { cwd: string } | { error: string };

export function resolveExistingDir(input: string, base: string, home?: string): ResolvedDir {
    const target = resolveCwdInput(input, base, home);
    let stat: fs.Stats;
    try {
        stat = fs.statSync(target);
    } catch {
        return { error: `目录不存在：${formatDisplayPath(target, home)}（当前目录 ${formatDisplayPath(base, home)}）` };
    }
    if (!stat.isDirectory()) return { error: `不是目录：${formatDisplayPath(target, home)}` };
    return { cwd: target };
}

export const cwdTool: ExecutableTool = {
    name: "cwd",
    description: [
        "查看或切换当前会话的工作目录（bash、文件读写、grep 等相对路径都以此为基准）。",
        "action=get 查看（返回 HOME 缩写为 ~ 的路径）；action=set 配合 path 切换，支持 ~ 与相对当前目录的路径。",
        "切换会落盘到会话，恢复会话后仍是新目录。",
    ].join(" "),
    tags: ["core"],
    inputSchema: {
        type: "object",
        properties: {
            action: {
                type: "string",
                enum: ["get", "set"],
                description: "get：查看当前工作目录（默认）；set：切换工作目录，需要同时给 path",
            },
            path: {
                type: "string",
                description: "set 的目标目录：支持 ~、相对当前目录的路径与绝对路径",
            },
        },
    },
    execute: async (args: { action?: "get" | "set"; path?: string; __sessionId?: string }): Promise<ToolExecutionResult> => {
        const action = args.action ?? (args.path ? "set" : "get");
        const current = getToolCwd();

        if (action === "get") {
            return ok(formatDisplayPath(current));
        }

        const raw = args.path?.trim();
        if (!raw) return err("set 需要 path：例如 {\"action\":\"set\",\"path\":\"../infra\"}");

        const resolved = resolveExistingDir(raw, current);
        if ("error" in resolved) return err(resolved.error);
        const target = resolved.cwd;

        const sessionId = args.__sessionId;
        if (!sessionId) {
            // 没有会话上下文（本地 CLI / 单测）：只能改进程级目录，且不落盘
            process.env.TUI_CWD = target;
            return ok(`已切换工作目录：${formatDisplayPath(target)}（仅本进程生效，未落盘）`);
        }
        // 按会话解析落盘入口：多宿主同进程时不会切到别人的会话上
        const setter = getSessionCwdSetter(sessionId);
        if (!setter) {
            // 有会话却不落盘会成为"假切换"：恢复后回退，别让模型误以为生效
            return err(hasSessionCapabilityProvider("setSessionCwd")
                ? `会话 ${sessionId.slice(-8)} 不在本实例的运行时上下文里，无法切换工作目录`
                : "当前运行模式不支持切换会话目录（宿主未注册落盘入口）");
        }
        await setter(target);
        return ok(`已切换工作目录：${formatDisplayPath(target)}`);
    },
};
