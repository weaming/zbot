/**
 * GitHub CLI 工具
 * 在容器内执行 gh 命令，AI 自行决定子命令和参数
 */

import { execFile } from "child_process";
import { promisify } from "util";
import type { ExecutableTool, ToolExecutionResult } from "./tool-interface.js";
import { buildExecutionEnv } from "../utils/skill-env.js";
import { getNetworkProxy } from "../utils/proxy.js";
import { getToolCwd } from "../utils/runtime-paths.js";

const execFileAsync = promisify(execFile);

export function buildGhArgs(args: string[]): string[] {
    return [...args];
}

async function executeGh(
    commandArgs: string[],
    enableProxy: boolean = true,
    signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
    const env = buildExecutionEnv();

    const proxyUrl = getNetworkProxy();
    if (enableProxy && proxyUrl) {
        env.HTTP_PROXY = proxyUrl;
        env.HTTPS_PROXY = proxyUrl;
        env.http_proxy = proxyUrl;
        env.https_proxy = proxyUrl;
    }

    const { stdout, stderr } = await execFileAsync("gh", commandArgs, {
        cwd: getToolCwd(),
        env,
        signal,
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr };
}

export const ghTool: ExecutableTool = {
    name: "gh",
    description: "执行 GitHub CLI (gh) 命令。用于查询 PR、Issue、Workflow、Repo 信息等。将子命令和每个参数分别放入 args 数组。",
    tags: ["code", "github"],
    inputSchema: {
        type: "object",
        properties: {
            args: {
                type: "array",
                items: { type: "string" },
                description: "gh 子命令与参数数组，如 [\"pr\", \"list\", \"--repo\", \"owner/repo\", \"--state\", \"open\", \"--limit\", \"10\"]",
            },
            enable_proxy: {
                type: "boolean",
                description: "是否启用代理（默认 true）",
                default: true,
            },
        },
        required: ["args"],
    },
    execute: async (
        input: { args: string[]; enable_proxy?: boolean },
        signal?: AbortSignal,
    ): Promise<ToolExecutionResult> => {
        const { args, enable_proxy = true } = input;

        if (!Array.isArray(args) || args.length === 0 || args.some((argument) => typeof argument !== "string" || !argument.trim())) {
            return {
                content: [{ type: "text", text: "错误：请提供非空的 gh 参数数组" }],
                isError: true,
            };
        }

        try {
            const { stdout, stderr } = await executeGh(buildGhArgs(args), enable_proxy, signal);

            if (stderr && !stdout) {
                return {
                    content: [{ type: "text", text: `gh 命令错误: ${stderr}` }],
                    isError: true,
                };
            }

            return {
                content: [{ type: "text", text: stdout || stderr || "命令执行完成，无输出" }],
            };
        } catch (err: any) {
            const message = err.message || String(err);

            if (message.includes("not logged in") || message.includes("auth")) {
                return {
                    content: [{ type: "text", text: `GitHub 未认证，请先运行 'gh auth login' 登录。错误信息: ${message}` }],
                    isError: true,
                };
            }

            return {
                content: [{ type: "text", text: `gh 命令执行失败: ${message}` }],
                isError: true,
            };
        }
    },
};
