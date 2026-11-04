import { todoTool } from "./todo-tool.js";
import { getUseSkillTool, getUseSkillToolWithFreshSchema } from "./use-skill.js";
import { executeShellTool } from "./execute-shell.js";
import { backgroundTaskTool } from "./background-task-tool.js";
import { ghTool } from "./gh-tool.js";
import { url2mdTool } from "./url2md-tool.js";
import { jobCommentTool } from "./job-comment-tool.js";
import { cwdTool } from "./cwd-tool.js";
import { readMediaFileTool } from "./read-media-file.js";
import { toolResultToText } from "./tool-interface.js";
import { toolCatalog } from "./tool-catalog.js";
import { formatToolDef } from "./tool-schema.js";
import { readMcpSelection, readTurnMcpSelectionSnapshot } from "./session-mcp-selection.js";
import { appendSessionToolLog } from "./session-log.js";

import type { ExecutableTool, ToolExecutionResult } from "./tool-interface.js";
export type { ToolExecutionResult };

const coreTools: ExecutableTool[] = [
    todoTool,
    readMediaFileTool,
    backgroundTaskTool,
];

let useSkillToolInstance: ExecutableTool | null = null;
function getUseSkillToolCached(): ExecutableTool {
    if (!useSkillToolInstance) {
        useSkillToolInstance = getUseSkillTool();
    }
    return useSkillToolInstance;
}

const getUseSkillToolDef = () => getUseSkillToolWithFreshSchema();

const localRegisteredTools: ExecutableTool[] = [
    ...coreTools,
    executeShellTool,
    cwdTool,
    ghTool,
    url2mdTool,
    jobCommentTool,
];

toolCatalog.reserveNames(["use_skill"]);
toolCatalog.registerLocalTools(localRegisteredTools);

export interface ToolDefinitionOptions {
    /** 任务级 MCP 白名单：只保留这些 server 的工具（undefined 表示不限制）。 */
    mcpServers?: string[];
    /** 接入端是否支持 tool_search：只影响 Responses 的 defer_loading，不影响这里筛工具。 */
    toolSearch?: boolean;
    /** 会话的工具集来源（/mcp 或任务勾选）；缺省按会话缓存取。 */
    sessionId?: string;
    /** 本会话选中的 server：选中就下发，没选中就不下发。 */
    selectedServers?: string[];
}

/**
 * 所有非会话工具始终下发；会话工具仅在对应会话显式启用时下发。
 * MCP 工具按「会话选中集」下发：配置里的 lazy 只决定默认选中，执行期不再参与判断，
 * 也不再看接入端是否支持 tool_search。
 */
export const getOpenAIToolDefinitions = (
    extraToolNames: string[] = [],
    options: ToolDefinitionOptions = {},
) => {
    // 空数组 = 一个都不允许；undefined = 不限制。两者必须区分开
    const allowedServers = options.mcpServers ? new Set(options.mcpServers) : undefined;
    // 优先级：调用方显式传入 → 本回合开始时的快照 → 会话实时选中集。
    // 快照这一层保证"中途增删只影响下一个回合"：一回合内的多个请求工具集不变。
    // undefined = 没初始化过（老会话 / 未指定会话）→ 不限制；空数组 = 一个都不选。
    const selection = options.selectedServers
        ?? readTurnMcpSelectionSnapshot()
        ?? readMcpSelection(options.sessionId);
    const selectedServers = selection ? new Set(selection) : undefined;
    const tools = toolCatalog.listAllTools().filter((tool) => {
        if (tool.sessionScoped && !extraToolNames.includes(tool.name)) return false;
        // 选中集是唯一判据：任务勾选的白名单与它会话内选中集取交集
        if (tool.fromServer && allowedServers && !allowedServers.has(tool.fromServer)) return false;
        if (tool.fromServer && selectedServers && !selectedServers.has(tool.fromServer)) return false;
        return true;
    });
    return [getUseSkillToolDef(), ...tools].map(formatToolDef);
};

const validateToolLimits = () => {
    const tools = getOpenAIToolDefinitions();
    if (tools.length > 100) {
        console.warn(`🚨 TOOL LIMIT WARNING: ${tools.length} tools, exceeding 100!`);
    }
};

// 只做一次开发期告警；unref 后不阻塞进程退出（CLI 子命令加载本模块后应立即结束）
setTimeout(validateToolLimits, 5000).unref();

export const executeMcpTool = async (name: string, args: any, signal?: AbortSignal): Promise<ToolExecutionResult> => {
    const tool = name === "use_skill" ? getUseSkillToolCached() : toolCatalog.getTool(name);

    if (!tool) {
        console.warn(`❌ [Tool] Unknown: ${name}`);
        appendSessionToolLog(`❌ [Tool] Unknown: ${name}`);
        return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
        };
    }

    try {
        const result = await tool.execute(args, signal);
        if (result.isError) {
            console.warn(`⚠️ [Tool] ${name} returned error`);
            appendSessionToolLog(`⚠️ [Tool] ${name} returned error`);
        } else {
            const preview = (toolResultToText(result) || "empty").slice(0, 100);
            const line = `✅ [Tool] ${name} success: ${preview}${preview.length >= 100 ? "..." : ""}`;
            console.log(line);
            appendSessionToolLog(line);
        }
        if (!result.contextPolicy && tool.contextPolicy) {
            result.contextPolicy = tool.contextPolicy;
        }
        return result;
    } catch (error: any) {
        console.error(`❌ [Tool] ${name} failed:`, error.message);
        appendSessionToolLog(`❌ [Tool] ${name} failed: ${error.message}`);
        return {
            content: [{ type: "text", text: `Tool execution failed: ${error.message}` }],
            isError: true,
        };
    }
};
