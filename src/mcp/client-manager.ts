/**
 * MCP 客户端管理器
 * 支持多 Server 管理、通用工具过滤 (include/exclude/prefix/rename)、
 * MCP 协议版本 (2026-07-28 / 2025-11-25) 以及 stdio / streamable-http / sse 传输协议，
 * 远端服务支持 OAuth（授权码 + PKCE，见 oauth.ts）
 */

import { Client, StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { toolCatalog } from "../tools/tool-catalog.js";
import { buildProxyToolFromRemoteDefinition, summarizeAddedToolsByNamePrefix } from "./tooling.js";
import { filterAndTransformTools } from "./filter.js";
import { loadMcpServersConfig, resolveMcpOAuthConfig, type McpServerConfig, type McpTransportType, type LoadMcpConfigOptions } from "./config.js";
import { McpOAuthClient } from "./oauth.js";

import type { ExecutableTool } from "../tools/tool-interface.js";
import type { McpNotice } from "../types/mcp.js";
import { notifyMcpNotice, onSessionRuntimeRegistered } from "../control/runtime.js";

const PERIODIC_SYNC_INTERVAL_MS = 15 * 1000;
const RECONNECT_INITIAL_DELAY_MS = 5 * 1000;
const RECONNECT_MAX_DELAY_MS = 60 * 1000;
/** 等待用户在浏览器完成授权时的重检间隔 */
const AUTH_PENDING_RETRY_MS = 30 * 1000;

interface McpClientContext {
    serverConfig: McpServerConfig;
    client: Client | null;
    transport: any | null;
    lastSyncTime: number;
    lastError?: string;
    missingToolSyncCounts: Map<string, number>;
    pendingToolSync: Promise<void> | null;
    pendingConnection: Promise<void> | null;
    maintenanceTimer: ReturnType<typeof setTimeout> | null;
    reconnectAttempt: number;
    /** OAuth 会话（仅配置了 oauth 的远端服务） */
    oauthClient: McpOAuthClient | null;
    pendingOAuthClient: Promise<McpOAuthClient> | null;
    /** 进行中的用户授权流程（等待回调 → 换令牌 → 重连） */
    pendingAuth: Promise<void> | null;
    lastAuthUrl?: string;
    authError?: string;
}

const activeContexts = new Map<string, McpClientContext>();
/** 界面注册前积压的通知（TUI 启动阶段早于界面就绪）；按界面可用性补发。 */
const pendingNotices: McpNotice[] = [];
let shutdownHookInstalled = false;

export type { McpNotice };

/** 有界面注册时补发积压通知：通知是会话无关的展示事件，走运行时注册表广播。 */
onSessionRuntimeRegistered((caps) => {
    if (!caps.notifyMcpNotice) return;
    while (pendingNotices.length > 0) {
        const notice = pendingNotices.shift()!;
        try {
            caps.notifyMcpNotice(notice);
        } catch (error) {
            console.error(`⚠️ [MCP] 补发通知失败 (${notice.server}):`, error);
        }
    }
});

function emitNotice(notice: McpNotice): void {
    console.log(`[MCP:${notice.server}] ${notice.text}${notice.url ? ` ${notice.url}` : ""}`);

    if (notifyMcpNotice(notice) > 0) return;

    pendingNotices.push(notice);
    // 界面注册前只保留最近若干条，避免无限堆积
    while (pendingNotices.length > 20) pendingNotices.shift();
}

function isUnauthorizedError(error: any): boolean {
    return error?.name === "UnauthorizedError" || error?.code === "CLIENT_HTTP_AUTHENTICATION"
        || /unauthorized|missing authorization/i.test(error?.message ?? "");
}

export function retainToolsMissingFromOneSync(
    previousTools: ExecutableTool[],
    latestTools: ExecutableTool[],
    missingCounts: Map<string, number>,
): { tools: ExecutableTool[]; deferredNames: string[] } {
    const latestNames = new Set(latestTools.map((tool) => tool.name));
    const deferredTools: ExecutableTool[] = [];
    const deferredNames: string[] = [];

    for (const tool of latestTools) {
        missingCounts.delete(tool.name);
    }

    for (const tool of previousTools) {
        if (latestNames.has(tool.name)) {
            continue;
        }

        const missingCount = (missingCounts.get(tool.name) || 0) + 1;
        if (missingCount === 1) {
            missingCounts.set(tool.name, missingCount);
            deferredTools.push(tool);
            deferredNames.push(tool.name);
            continue;
        }

        missingCounts.delete(tool.name);
    }

    return { tools: [...latestTools, ...deferredTools], deferredNames };
}

async function createMcpClientInstance(
    serverConfig: McpServerConfig,
    oauthClient: McpOAuthClient | null = null,
): Promise<{ client: Client; transport: any }> {
    let transport: any;
    const { type, name } = serverConfig;

    if (type === "stdio") {
        if (!serverConfig.command) {
            throw new Error(`MCP stdio server '${name}' missing required 'command' field`);
        }
        const safeEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (v !== undefined) safeEnv[k] = v;
        }
        if (serverConfig.env) {
            for (const [k, v] of Object.entries(serverConfig.env)) {
                if (v !== undefined) safeEnv[k] = v;
            }
        }

        transport = new StdioClientTransport({
            command: serverConfig.command,
            args: serverConfig.args,
            env: safeEnv,
            cwd: serverConfig.cwd,
            stderr: "pipe",
        });

        if (transport.stderr) {
            transport.stderr.on("data", (chunk: Buffer) => {
                const text = chunk.toString().trim();
                if (text) {
                    console.debug(`[MCP:${name}:stderr] ${text}`);
                }
            });
        }
    } else if (type === "sse") {
        const rawUrl = serverConfig.url || serverConfig.serverUrl;
        if (!rawUrl) {
            throw new Error(`MCP SSE server '${name}' missing 'url'`);
        }
        transport = new SSEClientTransport(new URL(rawUrl), {
            requestInit: serverConfig.headers ? { headers: serverConfig.headers } : undefined,
            authProvider: oauthClient?.provider,
        });
    } else {
        // http 或 streamable-http (默认)
        const rawUrl = serverConfig.url || serverConfig.serverUrl;
        if (!rawUrl) {
            throw new Error(`MCP HTTP server '${name}' missing 'url'`);
        }
        transport = new StreamableHTTPClientTransport(new URL(rawUrl), {
            requestInit: serverConfig.headers ? { headers: serverConfig.headers } : undefined,
            authProvider: oauthClient?.provider,
        });
    }

    const isLegacy = serverConfig.legacy === true || serverConfig.protocolVersion === "2025-11-25";
    const client = new Client(
        { name: `zbot-${name}`, version: "1.0.0" },
        isLegacy
            ? { versionNegotiation: { mode: "legacy" } }
            : {
                versionNegotiation: { mode: { pin: "2026-07-28" } },
                defaultCacheTtlMs: 0,
            },
    );

    await client.connect(transport).catch(async (error) => {
        // 连接失败（含 401 等待授权）时释放 transport，避免残留的 abort controller / 子进程
        try {
            await transport.close();
        } catch {
            // 关闭失败忽略
        }
        throw error;
    });
    return { client, transport };
}

async function syncServerToolsInternal(ctx: McpClientContext): Promise<void> {
    if (!ctx.client) return;
    const { client, serverConfig } = ctx;
    const serverName = serverConfig.name;

    const result = await client.listTools();
    const rawTools = result.tools || [];

    // 应用过滤器 (includeTools, excludeTools, prefix, rename)，未配 prefix 时加 `<server>__` 前缀
    const filteredTools = filterAndTransformTools(rawTools, serverConfig, serverName);

    const proxyTools = filteredTools.map(({ rawName, toolDef }) =>
        buildProxyToolFromRemoteDefinition({
            toolDef,
            serverName,
            deferLoading: serverConfig.defer === true,
            lazy: serverConfig.lazy === true,
            executeRemote: async (args: any, signal?: AbortSignal) => {
                if (!ctx.client) {
                    return {
                        content: [{ type: "text", text: `Tool ${toolDef.name} unavailable: ${serverName} not connected` }],
                        isError: true,
                    };
                }

                return await ctx.client.callTool(
                    { name: rawName, arguments: args },
                    { signal },
                );
            },
        }),
    );

    const previousTools = toolCatalog.listRemoteTools()
        .filter((tool) => tool.fromServer === serverName);
    const stableTools = retainToolsMissingFromOneSync(previousTools, proxyTools, ctx.missingToolSyncCounts);
    const syncResult = toolCatalog.syncRemoteTools(serverName, stableTools.tools);

    if (stableTools.deferredNames.length > 0) {
        console.warn(`⚠️ [MCP:${serverName}] Deferred removal after incomplete sync: ${stableTools.deferredNames.join(", ")}`);
    }
    if (syncResult.removed.length > 0) {
        console.log(`🗑️  [MCP:${serverName}] Removed stale tools: ${syncResult.removed.join(", ")}`);
    }
    if (syncResult.skipped.length > 0) {
        console.log(`ℹ️  [MCP:${serverName}] Skipped conflicting tools: ${syncResult.skipped.join(", ")}`);
    }
    if (syncResult.added.length > 0) {
        const summary = summarizeAddedToolsByNamePrefix(syncResult.added);
        console.log(`✅ [MCP:${serverName}] Tools synced: ${summary}`);
    }

    ctx.lastSyncTime = Date.now();
}

async function syncServerTools(ctx: McpClientContext): Promise<void> {
    if (ctx.pendingToolSync) {
        await ctx.pendingToolSync;
        return;
    }

    const syncPromise = syncServerToolsInternal(ctx);
    ctx.pendingToolSync = syncPromise;
    try {
        await syncPromise;
    } finally {
        if (ctx.pendingToolSync === syncPromise) {
            ctx.pendingToolSync = null;
        }
    }
}

/** 取（或创建）server 的 OAuth 会话；未配置 oauth 时返回 null */
async function ensureOAuthClient(ctx: McpClientContext): Promise<McpOAuthClient | null> {
    const oauthConfig = resolveMcpOAuthConfig(ctx.serverConfig);
    if (!oauthConfig) return null;
    if (ctx.oauthClient) return ctx.oauthClient;
    if (ctx.pendingOAuthClient) return await ctx.pendingOAuthClient;

    const serverUrl = ctx.serverConfig.url || ctx.serverConfig.serverUrl;
    if (!serverUrl) throw new Error(`MCP server '${ctx.serverConfig.name}' 启用 oauth 但缺少 url`);

    const creating = McpOAuthClient.create({
        ...oauthConfig,
        serverName: ctx.serverConfig.name,
        serverUrl,
        onEvent: (event) => {
            if (event.url) ctx.lastAuthUrl = event.url;
            console.log(`[MCP:${ctx.serverConfig.name}] ${event.text}${event.url ? ` ${event.url}` : ""}`);
        },
    });
    ctx.pendingOAuthClient = creating;
    try {
        ctx.oauthClient = await creating;
    } finally {
        ctx.pendingOAuthClient = null;
    }

    return ctx.oauthClient;
}

/**
 * 后台完成用户授权：等待浏览器回调 → 换取令牌 → 重连。
 * 同一时刻每个 server 只允许一个授权流程。
 */
function startAuthorization(ctx: McpClientContext, oauthClient: McpOAuthClient): Promise<void> {
    if (ctx.pendingAuth) return ctx.pendingAuth;

    emitNotice({
        level: "warn",
        server: ctx.serverConfig.name,
        text: "需要完成 OAuth 授权，请在浏览器打开链接",
        url: oauthClient.pendingAuthorizationUrl || ctx.lastAuthUrl,
    });

    const flow = (async () => {
        const params = await oauthClient.waitForCallback();
        await oauthClient.completeAuthorization(params);
        ctx.authError = undefined;
        ctx.lastAuthUrl = undefined;
        emitNotice({ level: "info", server: ctx.serverConfig.name, text: "授权成功，正在重连 MCP 服务" });
        await connectServer(ctx);
        ctx.reconnectAttempt = 0;
    })()
        .catch((error: any) => {
            ctx.authError = error?.message ?? String(error);
            ctx.lastAuthUrl = oauthClient.pendingAuthorizationUrl || ctx.lastAuthUrl;
            emitNotice({
                level: "error",
                server: ctx.serverConfig.name,
                text: `授权失败：${ctx.authError}（可重新加载 MCP 触发新链接）`,
            });
        })
        .finally(() => {
            ctx.pendingAuth = null;
        });

    ctx.pendingAuth = flow;
    return flow;
}

async function connectServer(ctx: McpClientContext): Promise<void> {
    if (ctx.pendingConnection) {
        await ctx.pendingConnection;
        return;
    }

    const connectionPromise = (async () => {
        const oauthClient = await ensureOAuthClient(ctx);
        let client: Client | null = null;

        try {
            const instance = await createMcpClientInstance(ctx.serverConfig, oauthClient);
            client = instance.client;
            ctx.client = client;
            ctx.transport = instance.transport;

            await syncServerTools(ctx);
            ctx.reconnectAttempt = 0;
            ctx.lastError = undefined;
            ctx.authError = undefined;
            ctx.lastAuthUrl = undefined;
            console.log(`✅ [MCP:${ctx.serverConfig.name}] Connected successfully.`);
        } catch (error: any) {
            ctx.lastError = error?.message ?? String(error);
            if (client) {
                try {
                    await client.close();
                } catch {
                    // 关闭失败忽略
                }
            }
            ctx.client = null;
            ctx.transport = null;

            // 401：启动（或复用）用户授权流程，不阻塞调用方
            if (oauthClient && isUnauthorizedError(error) && !ctx.pendingAuth) {
                void startAuthorization(ctx, oauthClient);
            }

            throw error;
        }
    })();

    ctx.pendingConnection = connectionPromise;
    try {
        await connectionPromise;
    } finally {
        if (ctx.pendingConnection === connectionPromise) {
            ctx.pendingConnection = null;
        }
    }
}

function scheduleMaintenance(ctx: McpClientContext, delayMs: number = PERIODIC_SYNC_INTERVAL_MS): void {
    if (ctx.maintenanceTimer) {
        clearTimeout(ctx.maintenanceTimer);
    }

    ctx.maintenanceTimer = setTimeout(async () => {
        ctx.maintenanceTimer = null;

        // 等待用户在浏览器完成授权：不重复探测，等流程结束后自然会重连
        if (ctx.pendingAuth) {
            scheduleMaintenance(ctx, AUTH_PENDING_RETRY_MS);
            return;
        }

        try {
            if (!ctx.client) {
                await connectServer(ctx);
            } else {
                await syncServerTools(ctx);
            }
            ctx.reconnectAttempt = 0;
            scheduleMaintenance(ctx);
        } catch (error: any) {
            ctx.lastError = error?.message ?? String(error);
            const currentClient = ctx.client;
            if (currentClient) {
                try {
                    await currentClient.close();
                } catch {
                    // ignore
                }
                ctx.client = null;
                ctx.transport = null;
            }

            const delay = Math.min(
                RECONNECT_INITIAL_DELAY_MS * 2 ** ctx.reconnectAttempt,
                RECONNECT_MAX_DELAY_MS,
            );
            ctx.reconnectAttempt += 1;
            console.warn(`⚠️ [MCP:${ctx.serverConfig.name}] Tool sync failed: ${error.message}; retrying in ${delay}ms`);
            scheduleMaintenance(ctx, delay);
        }
    }, delayMs);
}

/**
 * 关闭所有活跃的 MCP 连接、OAuth 回调服务与子进程
 */
export async function closeAllMcpClients(): Promise<void> {
    for (const [name, ctx] of activeContexts.entries()) {
        if (ctx.maintenanceTimer) {
            clearTimeout(ctx.maintenanceTimer);
            ctx.maintenanceTimer = null;
        }

        if (ctx.client) {
            try {
                await ctx.client.close();
            } catch {
                // ignore
            }
            ctx.client = null;
            ctx.transport = null;
        }

        if (ctx.oauthClient) {
            await ctx.oauthClient.close().catch(() => undefined);
            ctx.oauthClient = null;
        }

        toolCatalog.removeRemoteServer(name);
    }
    activeContexts.clear();
}

function installProcessShutdownHook(): void {
    if (shutdownHookInstalled) return;
    shutdownHookInstalled = true;

    const cleanup = () => {
        for (const ctx of activeContexts.values()) {
            if (ctx.maintenanceTimer) {
                clearTimeout(ctx.maintenanceTimer);
                ctx.maintenanceTimer = null;
            }
            if (ctx.client) {
                try {
                    ctx.client.close();
                } catch {
                    // ignore
                }
            }
            if (ctx.oauthClient) {
                // 回调服务为 unref 状态，同步关闭避免退出阶段挂起
                void ctx.oauthClient.close().catch(() => undefined);
            }
        }
    };

    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
}

/**
 * 初始化 MCP Clients
 * 支持配置加载策略与 tools filter
 */
export const initMcpClients = async (options: LoadMcpConfigOptions | unknown = {}): Promise<void> => {
    installProcessShutdownHook();

    const configOptions: LoadMcpConfigOptions =
        options && typeof options === "object" ? (options as LoadMcpConfigOptions) : {};

    const serverConfigs = loadMcpServersConfig(configOptions);
    if (serverConfigs.length === 0) {
        return;
    }

    console.log(`🧩 MCP Services: Initializing ${serverConfigs.length} server(s)...`);

    const connections = serverConfigs.map(async (config) => {
        let ctx = activeContexts.get(config.name);
        if (!ctx) {
            ctx = {
                serverConfig: config,
                client: null,
                transport: null,
                lastSyncTime: 0,
                missingToolSyncCounts: new Map<string, number>(),
                pendingToolSync: null,
                pendingConnection: null,
                maintenanceTimer: null,
                reconnectAttempt: 0,
                oauthClient: null,
                pendingOAuthClient: null,
                pendingAuth: null,
            };
            activeContexts.set(config.name, ctx);
        } else {
            ctx.serverConfig = config;
        }

        try {
            await connectServer(ctx);
            scheduleMaintenance(ctx);
        } catch (error: any) {
            ctx.lastError = error?.message ?? String(error);
            console.warn(`⚠️ [MCP:${config.name}] Initial connection failed: ${error.message}`);
            scheduleMaintenance(ctx, 0);
        }
    });

    await Promise.all(connections);
};

/** 重新读取配置并重建所有 MCP 连接与远程工具目录。 */
export async function reloadMcpClients(options: LoadMcpConfigOptions = { mode: "tui" }): Promise<void> {
    await closeAllMcpClients();
    await initMcpClients(options);
}

export interface McpServerStatus {
    name: string;
    type: McpTransportType;
    target: string;
    protocol: string;
    status: "connected" | "disconnected" | "connecting" | "authorizing" | "error";
    toolNames: string[];
    lastSyncTime?: number;
    error?: string;
    /** MCP 配置 lazy=true：不支持 tool_search 的模型默认不下发。 */
    lazy?: boolean;
    /** OAuth 状态：仅在 server 启用 oauth 时存在 */
    oauth?: {
        /** 等待用户完成的授权链接 */
        authorizationUrl?: string;
        /** 最近一次授权失败原因 */
        error?: string;
        /** 是否已持有令牌 */
        hasTokens: boolean;
    };
}

export function getMcpServersStatus(): McpServerStatus[] {
    const list: McpServerStatus[] = [];
    for (const [name, ctx] of activeContexts.entries()) {
        const config = ctx.serverConfig;
        const target = config.type === "stdio"
            ? (config.command || "")
            : (config.url || config.serverUrl || "");
        const isLegacy = config.legacy === true || config.protocolVersion === "2025-11-25";
        const protocol = isLegacy ? "legacy" : (config.protocolVersion || "2026-07-28");

        let status: "connected" | "disconnected" | "connecting" | "authorizing" | "error" = "disconnected";
        if (ctx.client) {
            status = "connected";
        } else if (ctx.pendingConnection) {
            status = "connecting";
        } else if (ctx.pendingAuth) {
            status = "authorizing";
        } else if (ctx.lastError) {
            status = "error";
        }

        const tools = toolCatalog.listRemoteTools()
            .filter((tool) => tool.fromServer === name)
            .map((tool) => tool.name)
            .sort((a, b) => a.localeCompare(b));

        const oauthConfig = resolveMcpOAuthConfig(config);

        list.push({
            name,
            type: config.type,
            target,
            protocol,
            status,
            toolNames: tools,
            ...(config.lazy === true ? { lazy: true } : {}),
            lastSyncTime: ctx.lastSyncTime > 0 ? ctx.lastSyncTime : undefined,
            error: ctx.lastError,
            ...(oauthConfig
                ? {
                    oauth: {
                        authorizationUrl: ctx.pendingAuth ? ctx.lastAuthUrl : undefined,
                        error: ctx.authError,
                        hasTokens: ctx.oauthClient?.hasStoredTokens() ?? false,
                    },
                }
                : {}),
        });
    }
    return list;
}

/**
 * 新建会话的默认 MCP 选中集：配置里没标 `lazy` 的服务。
 *
 * `lazy: true` 只影响"默认不选中"这一件事；选中与否才是下发的唯一判据（见 tool-registry）。
 * 所以这里就是把 lazy 的服务从默认集合里去掉，其余全选。
 */
export function defaultMcpSelection(): string[] {
    return getMcpServersStatus()
        .filter(item => item.lazy !== true)
        .map(item => item.name)
        .sort();
}

export function buildMcpStatusHelpText(): string {
    const statuses = getMcpServersStatus();
    if (statuses.length === 0) {
        return "🔌 MCP 服务：未配置或未连接任何 MCP 服务。";
    }

    const totalTools = statuses.reduce((sum, s) => sum + s.toolNames.length, 0);
    const lines: string[] = [
        `🔌 MCP 服务状态 (共 ${statuses.length} 个服务，${totalTools} 个工具)：`,
        "",
    ];

    for (const item of statuses) {
        const statusIcon = item.status === "connected"
            ? "●"
            : (item.status === "connecting" || item.status === "authorizing" ? "◌" : "✕");
        const statusLabel = item.status === "connected"
            ? "已连接"
            : (item.status === "connecting"
                ? "连接中..."
                : (item.status === "authorizing"
                    ? "等待浏览器授权..."
                    : (item.status === "error" ? `连接错误: ${item.error || "未知错误"}` : "已断开")));

        lines.push(`${statusIcon} ${item.name} (${item.type}) [${item.protocol}]`);
        lines.push(`  - 目标: ${item.target || "（未指定）"}`);
        lines.push(`  - 状态: ${statusLabel} (${item.toolNames.length} 个工具)`);
        if (item.oauth) {
            const authLabel = item.oauth.authorizationUrl
                ? "待完成：请在浏览器打开下方链接"
                : (item.oauth.error ? `上次失败: ${item.oauth.error}` : (item.oauth.hasTokens ? "已授权（凭据已缓存）" : "未授权（首次连接时会给出授权链接）"));
            lines.push(`  - OAuth: ${authLabel}`);
            if (item.oauth.authorizationUrl) {
                lines.push(`    ${item.oauth.authorizationUrl}`);
            }
        }
        if (item.toolNames.length > 0) {
            lines.push(`  - 工具清单:`);
            lines.push(`    ${item.toolNames.join(", ")}`);
        }
        lines.push("");
    }

    return lines.join("\n").trimEnd();
}
