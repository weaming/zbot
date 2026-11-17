import { describe, expect, test } from "bun:test";
import path from "node:path";
import { connectAcpMcp } from "./acp-mcp.js";
import { toolCatalog } from "../tools/tool-catalog.js";

const SERVER = path.resolve(import.meta.dir, "../../tests/integration/helpers/acp-mcp-server.ts");

describe("ACP MCP 会话隔离", () => {
    test("真实 stdio 子进程可调用，同名服务按会话隔离，关闭撤销工具", async () => {
        const params = [{ name: "test", command: process.execPath, args: [SERVER], env: [] }];
        const first = await connectAcpMcp("session-a", process.cwd(), params, new AbortController().signal);
        const second = await connectAcpMcp("session-b", process.cwd(), params, new AbortController().signal);
        try {
            const firstTools = toolCatalog.listRemoteTools().filter(tool => first.servers.includes(tool.fromServer!));
            const secondTools = toolCatalog.listRemoteTools().filter(tool => second.servers.includes(tool.fromServer!));
            expect(firstTools).toHaveLength(1);
            expect(secondTools).toHaveLength(1);
            expect(firstTools[0]!.name).not.toBe(secondTools[0]!.name);
            const tool = firstTools[0]!;
            const result = await tool.execute({ text: "本地回声", __sessionId: "session-a" });
            expect(result.content).toEqual([{ type: "text", text: "本地回声" }]);
            expect(() => tool.execute({ text: "非法", __sessionId: "session-b" })).toThrow("禁止跨 ACP 会话");
        } finally {
            await first.close();
            await second.close();
        }
        expect(toolCatalog.listRemoteTools().filter(tool => [...first.servers, ...second.servers].includes(tool.fromServer!))).toEqual([]);
    });

    test("部分连接失败时清理已经启动的子进程和工具", async () => {
        const before = toolCatalog.listRemoteTools().map(tool => tool.name);
        await expect(connectAcpMcp("rollback", process.cwd(), [
            { name: "first", command: process.execPath, args: [SERVER], env: [] },
            { name: "bad", command: "/nonexistent/acp-server", args: [], env: [] },
        ], new AbortController().signal)).rejects.toThrow();
        expect(toolCatalog.listRemoteTools().map(tool => tool.name)).toEqual(before);
    });

    test("重复服务名在连接前被拒绝", async () => {
        const server = { name: "same", command: process.execPath, args: [SERVER], env: [] };
        await expect(connectAcpMcp("duplicate", process.cwd(), [server, server], new AbortController().signal)).rejects.toThrow("名称必须唯一");
    });
});
