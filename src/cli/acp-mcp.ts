/** ACP 客户端传入的 MCP 服务只在所属会话内注册，关闭时撤销工具并释放连接。 */
import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpServer } from "@agentclientprotocol/sdk";
import { buildProxyToolFromRemoteDefinition } from "../mcp/tooling.js";
import { toolCatalog } from "../tools/tool-catalog.js";

export interface AcpMcpScope {
    servers: string[];
    close(): Promise<void>;
}

export async function connectAcpMcp(
    sessionId: string, cwd: string, servers: McpServer[], signal: AbortSignal,
): Promise<AcpMcpScope> {
    if (servers.length > 16 || new Set(servers.map(server => server.name)).size !== servers.length) {
        throw new Error("MCP 服务名称必须唯一，最多 16 个服务");
    }
    const clients: Client[] = [];
    const names: string[] = [];
    const close = async (): Promise<void> => {
        for (const name of names) toolCatalog.removeRemoteServer(name);
        const results = await Promise.allSettled(clients.splice(0).map(client => client.close()));
        const failures = results.filter(result => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), "ACP MCP 连接关闭失败");
    };
    try {
        for (const [index, server] of servers.entries()) {
            signal.throwIfAborted();
            const name = `acp_${createHash("sha256").update(sessionId).digest("hex").slice(0, 10)}_${index}`;
            const client = new Client({ name: "zbot-acp", version: "1.0.0" }, { capabilities: {} });
            clients.push(client);
            const transport = "type" in server
                ? server.type === "http"
                    ? new StreamableHTTPClientTransport(new URL(server.url), {
                        requestInit: { headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) },
                    })
                    : new SSEClientTransport(new URL(server.url), {
                        requestInit: { headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) },
                    })
                : new StdioClientTransport({
                    command: server.command, args: server.args, cwd, stderr: "pipe",
                    env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
                        ...Object.fromEntries(server.env.map(env => [env.name, env.value])) },
                });
            if (transport instanceof StdioClientTransport) {
                transport.stderr?.on("data", chunk => console.debug(`[ACP MCP:${server.name}] ${String(chunk).slice(0, 2000)}`));
            }
            await client.connect(transport, { signal, timeout: 15_000 });
            const definitions = await client.listTools({}, { signal, timeout: 15_000 });
            if (definitions.tools.length > 256) throw new Error(`MCP ${server.name} 工具数超过 256`);
            const tools = definitions.tools.map(def => {
                const suffix = createHash("sha256").update(def.name).digest("hex").slice(0, 10);
                const toolName = `${name}__${def.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 27)}_${suffix}`;
                const tool = buildProxyToolFromRemoteDefinition({
                    toolDef: { ...def, name: toolName }, serverName: name,
                    executeRemote: (args, toolSignal) => client.callTool({ name: def.name, arguments: args }, { signal: toolSignal }),
                });
                const execute = tool.execute;
                tool.execute = (args, toolSignal) => {
                    if (args?.__sessionId !== sessionId) throw new Error("禁止跨 ACP 会话调用 MCP 工具");
                    return execute(args, toolSignal);
                };
                return tool;
            });
            names.push(name);
            toolCatalog.syncRemoteTools(name, tools);
        }
        return { servers: names, close };
    } catch (error) {
        try { await close(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "ACP MCP 初始化与清理失败"); }
        throw error;
    }
}
