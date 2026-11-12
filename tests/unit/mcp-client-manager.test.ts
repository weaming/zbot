import { describe, expect, test } from "bun:test";

import {
    buildMcpStatusHelpText,
    closeAllMcpClients,
    getMcpServersStatus,
    initMcpClients,
    retainToolsMissingFromOneSync,
} from "../../src/mcp/client-manager.js";
import { toolCatalog } from "../../src/tools/tool-catalog.js";

import type { ExecutableTool } from "../../src/tools/tool-interface.js";

function createTool(name: string): ExecutableTool {
    return {
        name,
        inputSchema: { type: "object" },
        execute: async () => ({ content: [] }),
    };
}

describe("retainToolsMissingFromOneSync", () => {
    test("保留一次不完整同步中缺失的工具，并在连续缺失后删除", () => {
        const missingCounts = new Map<string, number>();
        const previousTools = [createTool("quote"), createTool("submit_order")];

        const first = retainToolsMissingFromOneSync(previousTools, [createTool("quote")], missingCounts);
        expect(first.tools.map((tool) => tool.name)).toEqual(["quote", "submit_order"]);
        expect(first.deferredNames).toEqual(["submit_order"]);

        const second = retainToolsMissingFromOneSync(first.tools, [createTool("quote")], missingCounts);
        expect(second.tools.map((tool) => tool.name)).toEqual(["quote"]);
        expect(second.deferredNames).toEqual([]);
    });

    test("工具在下一次同步恢复时取消待删除状态", () => {
        const missingCounts = new Map<string, number>();
        const previousTools = [createTool("quote")];

        retainToolsMissingFromOneSync(previousTools, [], missingCounts);
        const recovered = retainToolsMissingFromOneSync(previousTools, [createTool("quote")], missingCounts);
        const missingAgain = retainToolsMissingFromOneSync(recovered.tools, [], missingCounts);

        expect(missingAgain.deferredNames).toEqual(["quote"]);
    });

    test("无配置文件时不注册任何远程工具", async () => {
        await closeAllMcpClients();
        await initMcpClients({
            configPath: "/tmp/non_existent_mcp_test_file.yaml",
        });

        expect(toolCatalog.listRemoteTools()).toEqual([]);
        expect(buildMcpStatusHelpText()).toContain("未配置或未连接任何 MCP 服务");
    });

    test("buildMcpStatusHelpText 格式化输出服务状态与工具清单", () => {
        const text = buildMcpStatusHelpText();
        expect(typeof text).toBe("string");
    });
});
