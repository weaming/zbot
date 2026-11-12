/**
 * url2md 工具：将网页内容转换为纯 Markdown 格式
 */

import { execFile } from "child_process";
import { promisify } from "util";
import type { ExecutableTool, ToolExecutionResult } from "./tool-interface.js";
import { buildExecutionEnv } from "../utils/skill-env.js";
import { getNetworkProxy } from "../utils/proxy.js";
import { getToolCwd } from "../utils/runtime-paths.js";

const execFileAsync = promisify(execFile);

export function validateHttpUrl(value: string): string {
    const parsedUrl = new URL(value);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error("URL 仅支持 http 或 https 协议");
    }
    return parsedUrl.toString();
}

export function buildUrl2mdArgs(url: string, proxyUrl?: string): string[] {
    return ["-raw", url, ...(proxyUrl ? ["--proxy", proxyUrl] : [])];
}

async function executeUrl2md(url: string, signal?: AbortSignal): Promise<string> {
    const commandArgs = buildUrl2mdArgs(url, getNetworkProxy());
    const { stdout, stderr } = await execFileAsync("url2md", commandArgs, {
        cwd: getToolCwd(),
        env: buildExecutionEnv(),
        signal,
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
    });
    if (stderr) {
        console.warn(`[url2md] stderr: ${stderr}`);
    }
    return stdout.trim();
}

export const url2mdTool: ExecutableTool = {
    name: "url2md",
    description: "将网页 URL 转换为纯 Markdown 格式。使用 url2md 命令获取不带样式的原始内容，适合 AI 处理网页内容。",
    tags: ["core"],
    inputSchema: {
        type: "object",
        properties: {
            url: {
                type: "string",
                description: "要转换为 Markdown 的网页 URL",
            },
        },
        required: ["url"],
    },
    execute: async (args: { url: string }, signal?: AbortSignal): Promise<ToolExecutionResult> => {
        const { url } = args;

        if (!url.trim()) {
            return {
                content: [{ type: "text", text: "错误：未提供 URL" }],
                isError: true,
            };
        }

        try {
            const validatedUrl = validateHttpUrl(url);
            const result = await executeUrl2md(validatedUrl, signal);
            return {
                content: [{ type: "text", text: result }],
            };
        } catch (err: any) {
            return {
                content: [{ type: "text", text: `url2md 执行失败: ${err.message}` }],
                isError: true,
            };
        }
    },
};
