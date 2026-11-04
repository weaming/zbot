/**
 * 端到端（进程内）：远端 MCP 服务要求 OAuth 时的完整链路。
 * 覆盖 401 → PRM/AS 发现 → 动态注册 → 授权链接 → 回环回调 → PKCE 换令牌 → 重连 → tools/list，
 * 以及令牌复用（第二次连接不再需要用户授权）。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import {
    closeAllMcpClients,
    getMcpServersStatus,
    initMcpClients,
    type McpNotice,
} from "../../src/mcp/client-manager.js";
import { registerSessionRuntime } from "../../src/control/runtime.js";
import { toolCatalog } from "../../src/tools/tool-catalog.js";

interface MockState {
    base: string;
    codeChallenge?: string;
    registeredRedirectUri?: string;
    tokenRequests: number;
    accessToken: string;
}

/** 极简 OAuth 授权服务器 + 受保护 MCP 服务（legacy 协议） */
function startMockServer() {
    const state: MockState = { base: "", tokenRequests: 0, accessToken: "access-token-1" };

    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
            const url = new URL(req.url);
            const json = (body: unknown, status = 200) =>
                new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
            const form = new URLSearchParams();

            switch (`${req.method} ${url.pathname}`) {
                case "GET /.well-known/oauth-protected-resource/mcp":
                    return json({
                        resource: `${state.base}/mcp`,
                        authorization_servers: [state.base],
                        scopes_supported: ["read"],
                        bearer_methods_supported: ["header"],
                    });

                case "GET /.well-known/oauth-authorization-server":
                    return json({
                        issuer: state.base,
                        authorization_endpoint: `${state.base}/authorize`,
                        token_endpoint: `${state.base}/token`,
                        registration_endpoint: `${state.base}/register`,
                        response_types_supported: ["code"],
                        grant_types_supported: ["authorization_code", "refresh_token"],
                        token_endpoint_auth_methods_supported: ["none"],
                        code_challenge_methods_supported: ["S256"],
                    });

                case "POST /register": {
                    const body: any = await req.json();
                    state.registeredRedirectUri = body.redirect_uris?.[0];
                    return json({
                        client_id: `client-${crypto.randomUUID().slice(0, 8)}`,
                        redirect_uris: body.redirect_uris,
                    });
                }

                case "POST /token": {
                    const parsed = new URLSearchParams(await req.text());
                    state.tokenRequests += 1;

                    if (parsed.get("grant_type") !== "authorization_code") {
                        return json({ error: "unsupported_grant_type" }, 400);
                    }

                    const verifier = parsed.get("code_verifier") || "";
                    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
                    if (parsed.get("code") !== "good-code" || challenge !== state.codeChallenge) {
                        return json({ error: "invalid_grant", error_description: "code verification failed" }, 400);
                    }

                    return json({
                        access_token: state.accessToken,
                        token_type: "Bearer",
                        expires_in: 3600,
                        refresh_token: "refresh-1",
                        scope: "read",
                    });
                }

                case "POST /mcp": {
                    if (req.headers.get("authorization") !== `Bearer ${state.accessToken}`) {
                        return new Response(JSON.stringify({ error: { message: "Missing Authorization" } }), {
                            status: 401,
                            headers: {
                                "content-type": "application/json",
                                "www-authenticate":
                                    `Bearer realm="mcp", resource_metadata="${state.base}/.well-known/oauth-protected-resource/mcp", scope="read"`,
                            },
                        });
                    }

                    const message: any = await req.json();
                    const reply = (result: unknown) => json({ jsonrpc: "2.0", id: message.id, result });
                    if (message.method === "initialize") {
                        return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0.0" } });
                    }
                    if (message.method === "tools/list") {
                        return reply({ tools: [{ name: "echo", description: "回显", inputSchema: { type: "object", properties: {} } }] });
                    }
                    if (message.method === "notifications/initialized") {
                        return new Response(null, { status: 202 });
                    }
                    return json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } }, 200);
                }

                default:
                    void form;
                    return new Response("Not Found", { status: 404 });
            }
        },
    });

    state.base = `http://127.0.0.1:${server.port}`;
    return { server, state };
}

describe("mcp oauth 端到端", () => {
    const mock = startMockServer();
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-mcp-oauth-flow-"));
    const storePath = path.join(tmpRoot, "mock-oauth.json");
    const configPath = path.join(tmpRoot, "mcp-servers.yaml");
    const notices: McpNotice[] = [];
/** 本文件注册的通知接收者（等价于"有一个终端界面在场"）。 */
let unregisterNotices: (() => void) | undefined;

    beforeAll(() => {
        fs.writeFileSync(
            configPath,
            [
                "---",
                "- name: mock-oauth",
                "  type: http",
                `  url: ${mock.state.base}/mcp`,
                "  legacy: true",
                "  oauth:",
                `    storePath: ${storePath}`,
                "    authTimeoutSec: 20",
                "",
            ].join("\n"),
        );
    });

    afterAll(async () => {
        unregisterNotices?.();
        await closeAllMcpClients();
        mock.server.stop(true);
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    test("401 触发授权，回环回调完成 PKCE 换令牌后自动重连并同步工具", async () => {
        unregisterNotices = registerSessionRuntime({
            ownsSession: () => false,
            notifyMcpNotice: (notice) => notices.push(notice),
        });

        await initMcpClients({ configPath }).catch(() => undefined);

        // 连接失败（等待授权），状态应为 authorizing 并给出授权链接
        const pending = notices.find((notice) => notice.url?.includes("/authorize"));
        expect(pending?.server).toBe("mock-oauth");
        const authorizeUrl = new URL(pending!.url!);
        expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(mock.state.registeredRedirectUri);
        expect(authorizeUrl.searchParams.get("scope")).toBe("read");

        const status = getMcpServersStatus().find((item) => item.name === "mock-oauth");
        expect(status?.status).toBe("authorizing");
        expect(status?.oauth?.hasTokens).toBe(false);

        // 扮演浏览器：回调到回环 redirect_uri，带上授权码
        mock.state.codeChallenge = authorizeUrl.searchParams.get("code_challenge")!;
        const callbackUrl = new URL(mock.state.registeredRedirectUri!);
        callbackUrl.searchParams.set("code", "good-code");
        callbackUrl.searchParams.set("state", authorizeUrl.searchParams.get("state") || "");
        const callbackRes = await fetch(callbackUrl);
        expect(callbackRes.status).toBe(200);

        // 等待授权后的重连与工具同步
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline && !toolCatalog.listRemoteTools().some((tool) => tool.fromServer === "mock-oauth")) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        expect(toolCatalog.listRemoteTools().filter((tool) => tool.fromServer === "mock-oauth").map((tool) => tool.name))
            .toEqual(["mock-oauth__echo"]);
        expect(notices.some((notice) => notice.level === "info" && /授权成功/.test(notice.text))).toBe(true);
        expect(getMcpServersStatus().find((item) => item.name === "mock-oauth")?.status).toBe("connected");

        // 凭据落盘且权限收敛
        expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);
        expect(JSON.parse(fs.readFileSync(storePath, "utf-8")).tokens.access_token).toBe("access-token-1");
    });

    test("凭据复用：重启后直接连接，不再要求用户授权", async () => {
        const before = mock.state.tokenRequests;
        notices.length = 0;

        await closeAllMcpClients();
        await initMcpClients({ configPath });

        expect(notices.filter((notice) => notice.url)).toEqual([]);
        expect(mock.state.tokenRequests).toBe(before);
        expect(toolCatalog.listRemoteTools().some((tool) => tool.fromServer === "mock-oauth")).toBe(true);
    });
});
