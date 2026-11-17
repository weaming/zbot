import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const ROOT = path.resolve(import.meta.dir, "../..");

describe("真实 ACP CLI 与本地模型/MCP", () => {
    test("流式回合、MCP 授权与执行、跨进程历史恢复，stdout 保持纯 JSON-RPC", async () => {
        const dir = await fs.mkdtemp(path.join(process.env.CANBAN_RUN_DIR ?? os.tmpdir(), "acp-integration-"));
        const requests: Record<string, any>[] = [];
        const server = Bun.serve({
            port: 0, hostname: "127.0.0.1",
            async fetch(request) {
                const body = await request.json() as Record<string, any>;
                requests.push(body);
                const hasToolResult = body.messages.some((message: any) => message.role === "tool");
                const toolName = body.tools?.map((tool: any) => tool.function?.name).find((name: string) => name.startsWith("acp_"));
                const message = hasToolResult || !toolName
                    ? { role: "assistant", content: "完成：本地回声" }
                    : { role: "assistant", content: null, tool_calls: [{ id: "call-local", type: "function", function: {
                        name: toolName, arguments: JSON.stringify({ text: "本地回声" }),
                    } }] };
                const finishReason = "tool_calls" in message ? "tool_calls" : "stop";
                const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 };
                if (!body.stream) return Response.json({
                    id: "local", object: "chat.completion", created: 1, model: "test", choices: [{ index: 0, message, finish_reason: finishReason }], usage,
                });
                const delta = "tool_calls" in message
                    ? { ...message, tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) }
                    : message;
                const chunks = [
                    { choices: [{ index: 0, delta, finish_reason: null }] },
                    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage },
                ].map(chunk => `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "test", ...chunk })}\n\n`);
                return new Response(`${chunks.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
            },
        });
        const configFile = path.join(dir, "config.json");
        const mcpFile = path.join(dir, "mcp.json");
        const identityFile = path.join(dir, "identity.txt");
        await fs.writeFile(mcpFile, JSON.stringify({ servers: [] }));
        await fs.writeFile(identityFile, "你是本地测试助手。");
        await fs.writeFile(configFile, JSON.stringify({
            providers: { local: { protocol: "chat_completions", baseUrl: `${server.url}v1`, apiKey: "local-test", models: ["test"] } },
            runtime: { tokenizer: false, identityFile }, mcp: { serversFile: mcpFile },
        }));
        const start = () => {
            const child = spawn(process.execPath, ["src/tui/main.ts", "acp", "--cwd", ROOT], {
                cwd: ROOT, stdio: ["pipe", "pipe", "pipe"],
                env: { ...process.env, ZBOT_STATE_DIR: path.join(dir, "state"), ZBOT_CONFIG_FILE: configFile,
                    HC_TERMINAL_ID: "test-no-osc-on-pipe", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" },
            });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", chunk => { stdout += chunk.toString(); });
            child.stderr.on("data", chunk => { stderr += chunk.toString(); });
            const exited = new Promise<number | null>((resolve, reject) => {
                child.once("error", reject);
                child.once("exit", code => resolve(code));
            });
            const updates: acp.SessionNotification[] = [];
            const permissions: acp.RequestPermissionRequest[] = [];
            const connection = acp.client({ name: "integration" })
                .onNotification("session/update", context => { updates.push(context.params); })
                .onRequest("session/request_permission", context => {
                    permissions.push(context.params);
                    return { outcome: { outcome: "selected", optionId: "allow" } };
                })
                .connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
            return { child, connection, updates, permissions, stdout: () => stdout, stderr: () => stderr, exited };
        };
        const first = start();
        let second: ReturnType<typeof start> | undefined;
        try {
            await first.connection.agent.request("initialize", { protocolVersion: 1 });
            const created = await first.connection.agent.request("session/new", { cwd: ROOT, mcpServers: [{
                name: "local", command: process.execPath, args: [path.join(ROOT, "tests/integration/helpers/acp-mcp-server.ts")], env: [],
            }] });
            const result = await first.connection.agent.request("session/prompt", {
                sessionId: created.sessionId, prompt: [{ type: "text", text: "调用本地回声工具" }],
            });
            expect(result.stopReason).toBe("end_turn");
            expect(first.permissions).toHaveLength(1);
            expect(first.permissions[0]?.toolCall.toolCallId).toBe("call-local");
            expect(first.updates.some(frame => frame.update.sessionUpdate === "tool_call_update" && frame.update.status === "completed")).toBe(true);
            expect(requests.some(request => request.messages.some((message: any) => message.role === "tool" && message.content.includes("本地回声")))).toBe(true);
            first.child.stdin.end();
            expect(await first.exited).toBe(0);
            expect(first.stderr()).toBe("");
            expect(first.stdout()).not.toContain("\x1b");
            expect(first.stdout().trim().split("\n").every(line => JSON.parse(line).jsonrpc === "2.0")).toBe(true);
            const requestCount = requests.length;
            second = start();
            await second.connection.agent.request("initialize", { protocolVersion: 1 });
            await second.connection.agent.request("session/load", { sessionId: created.sessionId, cwd: ROOT, mcpServers: [] });
            expect(second.updates.some(frame => frame.update.sessionUpdate === "agent_message_chunk" && frame.update.content.type === "text" && frame.update.content.text.includes("完成"))).toBe(true);
            expect(second.updates.some(frame => frame.update.sessionUpdate === "user_message_chunk")).toBe(true);
            expect(requests).toHaveLength(requestCount);
            await second.connection.agent.request("session/close", { sessionId: created.sessionId });
            second.child.stdin.end();
            expect(await second.exited).toBe(0);
        } finally {
            first.connection.close();
            first.child.kill();
            if (second) { second.connection.close(); second.child.kill(); }
            server.stop(true);
            await fs.rm(dir, { recursive: true, force: true });
        }
    }, 25_000);
});
