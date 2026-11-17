/** 用于 stdio MCP 联调的最小服务，所有内容留在本地测试进程。 */
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
    const request = JSON.parse(line);
    if (!("id" in request)) continue;
    let result: unknown;
    switch (request.method) {
        case "initialize":
            result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } };
            break;
        case "tools/list":
            result = { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] };
            break;
        case "tools/call":
            result = { content: [{ type: "text", text: request.params.arguments.text }] };
            break;
        default:
            process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unknown method" } })}\n`);
            continue;
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
}
