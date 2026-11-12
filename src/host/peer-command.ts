/**
 * 会话间命令执行：`session send <id> "/xxx"` 在目标会话里执行 slash 命令。
 *
 * 设计要点（与 TUI 的分工）：
 * - TUI 的面板类命令在这里都有等价的文本视图 + 非交互参数，视图支持 `--json`；
 * - 业务能力全部复用宿主/服务层（压缩、续跑、清空、MCP 选择、模型选择…），不复制 UI 实现；
 * - 整个命令在本回合已占住的会话互斥里执行（`alreadyReserved`），不重抢、不代释；
 * - 归档/关闭/删除会拆掉回传链路，因此交给宿主在结果送达后再执行（见 `deferred`）。
 */

import { getMcpServersStatus } from "../mcp/client-manager.js";
import { SLASH_COMMAND_SPECS, type SlashCommandParse } from "../commands/slash-command.js";
import {
    buildHelpText,
    buildShortcutsJson,
    buildShortcutsText,
    buildSkillsHelpText,
    buildSkillsJson,
} from "../commands/slash-help.js";
import { getChatApiSettings } from "../services/chat-runtime.js";
import { backgroundTaskManager } from "../tools/background-tasks.js";
import { formatDisplayPath, resolveExistingDir } from "../tools/cwd-tool.js";
import { isToolSearchEnabled } from "../tools/orchestrator/turn-request.js";
import { describeModelView, resolveEffort, resolveModelUse } from "../commands/slash-model.js";
import { truncatePlain } from "../format/text.js";
import {
    formatBackgroundTaskDetails,
    formatElapsed,
    MAX_SHOWN_BACKGROUND_TASKS,
    MAX_TASK_TEXT_COLUMNS,
} from "../format/task-format.js";
import type { PeerOwnership } from "../control/registry.js";
import type { ChatModelSelection } from "../types/chat-model.js";
import type { SessionSummary } from "./session-host-types.js";

/** 回合结果送达后才能执行的动作：它们会把结果回传链路（socket / 会话视图）拆掉。 */
export type PeerDeferredAction = "archive" | "close" | "delete";

export interface PeerCommandResult {
    output: string;
    deferred?: PeerDeferredAction;
    /**
     * 命令内部已经跑过一轮（如 /continue）：那一轮自己释放了会话互斥，
     * 调用方不能再释放一次，否则会误删刚被排队消息抢到的互斥。
     */
    ranTurn?: boolean;
}

/** 命令执行所需的宿主能力（结构化子集，便于测试注入）。 */
export interface PeerCommandHost {
    listSessions(): Promise<SessionSummary[]>;
    listSessionOwnership(sessionIds: string[]): Promise<Map<string, PeerOwnership>>;
    claimedSessionIds(): string[];
    isSessionBusy(sessionId: string): boolean;
    getSessionCwd(sessionId: string): Promise<string>;
    setSessionCwd(sessionId: string, cwd: string): Promise<void>;
    getSystemPrompt(sessionId: string): Promise<string>;
    getSessionModelSelection(sessionId: string): Promise<ChatModelSelection | undefined>;
    /** 立即落盘（会话间命令跑在一次性/持有进程里，不能留在内存 pending）。 */
    setSessionModelSelection(
        sessionId: string,
        selection: ChatModelSelection,
        options?: { alreadyReserved?: boolean },
    ): Promise<void>;
    getSessionLazyMcpServers(sessionId: string): Promise<string[]>;
    setSessionLazyMcpServers(
        sessionId: string,
        servers: string[],
        options?: { alreadyReserved?: boolean },
    ): Promise<void>;
    compactSession(sessionId: string, instruction?: string, options?: { alreadyReserved?: boolean }): Promise<void>;
    resumeSession(
        sessionId: string,
        options?: { alreadyReserved?: boolean },
    ): Promise<{ resumed: boolean; reason?: string; aborted?: boolean }>;
    clearSession(sessionId: string, options?: { alreadyReserved?: boolean }): Promise<void>;
    unarchiveSession(sessionId: string, options?: { alreadyReserved?: boolean }): Promise<void>;
    reloadRuntime(): Promise<{ skillCount: number; mcpServerCount: number; mcpToolCount: number }>;
    spawnPeerSession(
        parentSessionId: string,
        title?: string,
    ): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
}

/** 归档态会话只接受这些命令：它们不要求可写的会话视图，且不往目标时间线写事件。 */
export function isPeerCommandAllowedOnArchived(parsed: Extract<SlashCommandParse, { kind: "command" }>): boolean {
    return parsed.spec.archived === true;
}

/** 执行一条会话间命令；`parsed` 已由解析层保证是已知命令且参数合法。 */
export async function executePeerCommand(
    host: PeerCommandHost,
    sessionId: string,
    parsed: Extract<SlashCommandParse, { kind: "command" }>,
): Promise<PeerCommandResult> {
    const run = async (): Promise<PeerCommandResult> => {
        switch (parsed.name) {
            case "/new":
                return { output: await peerNew(host, sessionId, parsed.args[0], parsed.json) };
            case "/sessions":
                return { output: await peerSessions(host, parsed.args[0], parsed.json) };
            case "/keys":
                return { output: view(parsed.json, buildShortcutsText(), () => ({ shortcuts: buildShortcutsJson() })) };
            case "/skills":
                return { output: view(parsed.json, buildSkillsHelpText(), () => ({ skills: buildSkillsJson() })) };
            case "/help":
                return {
                    output: view(parsed.json, buildHelpText(), () => ({ commands: SLASH_COMMAND_SPECS })),
                };
            case "/system": {
                const prompt = await host.getSystemPrompt(sessionId);
                return { output: view(parsed.json, `当前 system prompt：\n\n${prompt || "（空）"}`, () => ({ systemPrompt: prompt })) };
            }
            case "/ps":
                return { output: peerPs(sessionId, parsed.json) };
            case "/tasks":
                return { output: await peerTasks(sessionId, parsed.args, parsed.json) };
            case "/stop":
                return { output: peerStop(sessionId, parsed.args[0]) };
            case "/reload":
                return { output: await peerReload(host, sessionId) };
            case "/cwd":
                return { output: await peerCwd(host, sessionId, parsed.args[0], parsed.json) };
            case "/model":
                return { output: await peerModel(host, sessionId, parsed.args, parsed.json) };
            case "/mcp":
                return { output: await peerMcp(host, sessionId, parsed.args, parsed.json) };
            case "/compact": {
                const instruction = parsed.args[0];
                await host.compactSession(sessionId, instruction, { alreadyReserved: true });
                return {
                    output: view(parsed.json, `🗜️ 已压缩会话上下文${instruction ? `（附加要求：${instruction}）` : ""}`, () => ({ compacted: true, instruction: instruction ?? null })),
                };
            }
            case "/continue": {
                const result = await host.resumeSession(sessionId, { alreadyReserved: true });
                if (!result.resumed) {
                    return { output: view(parsed.json, `ℹ️ ${result.reason ?? "没有可继续的内容"}`, () => ({ resumed: false, reason: result.reason ?? null })) };
                }
                return {
                    output: view(parsed.json, result.aborted ? "⏩ 继续已中止" : "⏩ 已继续执行", () => ({ resumed: true, aborted: result.aborted === true })),
                    ranTurn: true,
                };
            }
            case "/clear": {
                requireConfirm(parsed.name, parsed.args[0]);
                await host.clearSession(sessionId, { alreadyReserved: true });
                return { output: view(parsed.json, "🗑️ 已清空会话历史", () => ({ cleared: true })) };
            }
            case "/archive":
                return {
                    output: view(parsed.json, "📦 已归档会话，本实例随即释放持有（可在会话列表查看）", () => ({ archived: true, released: true })),
                    deferred: "archive",
                };
            case "/unarchive": {
                await host.unarchiveSession(sessionId, { alreadyReserved: true });
                return { output: view(parsed.json, "📂 已取消归档", () => ({ archived: false })) };
            }
            case "/close":
                return {
                    output: view(parsed.json, "🚪 已关闭会话（释放本实例持有，数据保留）", () => ({ closed: true, released: true })),
                    deferred: "close",
                };
            case "/delete": {
                requireConfirm(parsed.name, parsed.args[0]);
                return {
                    output: view(parsed.json, "🗑️ 已删除会话（数据一并清除）", () => ({ deleted: true })),
                    deferred: "delete",
                };
            }
            default:
                throw new Error(`命令 ${parsed.name} 还没有接入会话间执行`);
        }
    };

    return run();
}

/** `--json` 时给出结构化结果，否则用文本；两种口径必须表达同一事实。 */
function view(json: boolean, text: string, build: () => unknown): string {
    return json ? JSON.stringify(build(), null, 2) : text;
}

/** 破坏性命令在会话间必须显式确认：把"手滑"挡在删除之前。 */
function requireConfirm(name: string, token: string | undefined): void {
    if (token === "confirm") return;
    throw new Error(`${name} 会破坏会话数据，远程执行必须显式确认：${name} confirm`);
}

async function peerNew(
    host: PeerCommandHost,
    sessionId: string,
    title: string | undefined,
    json: boolean,
): Promise<string> {
    const spawned = await host.spawnPeerSession(sessionId, title);
    if (!spawned.ok) throw new Error(spawned.error);

    const cleanTitle = title?.trim();
    const cwd = await host.getSessionCwd(spawned.sessionId);
    return view(
        json,
        `✚ 已创建会话 ${spawned.sessionId}${cleanTitle ? `（${cleanTitle}）` : ""}\n工作目录：${formatDisplayPath(cwd)}`,
        () => ({ sessionId: spawned.sessionId, title: cleanTitle ?? null, cwd }),
    );
}

async function peerSessions(host: PeerCommandHost, query: string | undefined, json: boolean): Promise<string> {
    const sessions = await host.listSessions();
    const ownership = await host.listSessionOwnership(sessions.map(item => item.sessionId));
    const keyword = query?.trim().toLowerCase();
    const matched = keyword
        ? sessions.filter(item => [item.sessionId, item.title ?? "", item.cwd ?? ""]
            .some(field => field.toLowerCase().includes(keyword)))
        : sessions;

    const rows = matched.map((item) => {
        const state = describeOwnership(ownership.get(item.sessionId));
        return {
            sessionId: item.sessionId,
            title: item.title ?? null,
            cwd: item.cwd ?? null,
            turns: item.messageCount,
            archived: item.archived === true,
            busy: host.isSessionBusy(item.sessionId),
            holder: state,
            updatedAt: item.updatedAt ?? null,
        };
    });
    if (json) return JSON.stringify({ sessions: rows }, null, 2);
    if (rows.length === 0) return keyword ? `没有匹配「${query}」的会话` : "当前没有会话";

    const lines = rows.map(row => [
        `- ${row.sessionId}`,
        // 标题可能来自多行 prompt：文本视图压成一行，JSON 里保留原文
        row.title ? `「${row.title.replace(/\s+/g, " ")}」` : "",
        `· ${row.turns} 轮`,
        `· ${row.archived ? "已归档" : "未归档"}`,
        `· ${row.holder}${row.busy ? "（执行中）" : ""}`,
        row.cwd ? `· ${formatDisplayPath(row.cwd)}` : "",
    ].filter(Boolean).join(" "));
    return `会话（${rows.length} 个）：\n${lines.join("\n")}`;
}

function describeOwnership(ownership: PeerOwnership | undefined): string {
    if (!ownership) return "未知";
    if (ownership.state === "mine") return "本实例持有";
    if (ownership.state === "other") return ownership.info?.pid ? `其他实例持有（pid ${ownership.info.pid}）` : "其他实例持有";
    return "无持有";
}

function formatTaskLine(task: { id: string; status: string; command: string; startedAt: string }, withStatus: boolean): string {
    const elapsed = formatElapsed(task.startedAt);
    const status = withStatus ? `[${task.status === "running" ? "运行中" : task.status}] ` : "";
    return `- ${task.id} ${status}${elapsed ? `${elapsed} ` : ""}${truncatePlain(task.command, MAX_TASK_TEXT_COLUMNS)}`;
}

function peerPs(sessionId: string, json: boolean): string {
    const running = backgroundTaskManager.list(sessionId).filter(task => task.status === "running");
    if (json) return JSON.stringify({ tasks: running }, null, 2);
    if (running.length === 0) return "没有正在运行的后台任务";

    const lines = [`后台任务（${running.length} 个运行中）：`, ""];
    for (const task of running.slice(0, MAX_SHOWN_BACKGROUND_TASKS)) lines.push(formatTaskLine(task, false));
    if (running.length > MAX_SHOWN_BACKGROUND_TASKS) {
        lines.push(`…还有 ${running.length - MAX_SHOWN_BACKGROUND_TASKS} 个任务`);
    }
    lines.push("", "使用 /stop <task_id> 终止指定任务，/stop 终止全部");
    return lines.join("\n");
}

async function peerTasks(sessionId: string, args: string[], json: boolean): Promise<string> {
    const [rawAction, taskId, rawWaitSeconds] = args;
    const action = (rawAction ?? "list").toLowerCase();

    if (action === "list") {
        const tasks = backgroundTaskManager.list(sessionId);
        if (json) return JSON.stringify({ tasks }, null, 2);
        if (tasks.length === 0) return "当前没有后台任务";
        return `后台任务：\n${tasks.map(task => formatTaskLine(task, true)).join("\n")}\n\n用法：${"/tasks status|wait|stop <task_id>"}`;
    }

    if (action === "wait") {
        const waitSeconds = Number(rawWaitSeconds);
        const seconds = Number.isFinite(waitSeconds) && waitSeconds > 0 ? Math.min(600, Math.round(waitSeconds)) : 10;
        const task = await backgroundTaskManager.wait(taskId!, seconds * 1_000, sessionId);
        if (!task) return `后台任务不存在或不属于当前会话：${taskId}`;
        return json ? JSON.stringify({ task }, null, 2) : formatBackgroundTaskDetails(task);
    }

    const task = backgroundTaskManager.get(taskId!, sessionId);
    if (!task) return `后台任务不存在或不属于当前会话：${taskId}`;
    if (action === "status") return json ? JSON.stringify({ task }, null, 2) : formatBackgroundTaskDetails(task);

    const stopped = backgroundTaskManager.stop(taskId!, sessionId);
    const text = stopped ? `已请求终止后台任务 ${taskId}` : `后台任务 ${taskId} 当前状态：${task.status}`;
    return json ? JSON.stringify({ stopped, task }, null, 2) : text;
}

function peerStop(sessionId: string, rawTarget: string | undefined): string {
    const target = rawTarget?.trim().toLowerCase();
    if (!target || target === "all") {
        const running = backgroundTaskManager.list(sessionId).filter(task => task.status === "running");
        if (running.length === 0) return "没有正在运行的后台任务";
        let stopped = 0;
        for (const task of running) {
            if (backgroundTaskManager.stop(task.id, sessionId)) stopped += 1;
        }
        return `已请求终止 ${stopped} 个后台任务`;
    }

    const task = backgroundTaskManager.get(target, sessionId);
    if (!task) return `后台任务不存在或不属于当前会话：${target}`;
    const stopped = backgroundTaskManager.stop(target, sessionId);
    return stopped ? `已请求终止后台任务 ${target}` : `后台任务 ${target} 当前状态：${task.status}`;
}

async function peerReload(host: PeerCommandHost, sessionId: string): Promise<string> {
    // 执行命令的会话自己就被本次投递占着互斥，必须排除
    if (host.claimedSessionIds().some(id => id !== sessionId && host.isSessionBusy(id))) {
        return "有会话正在执行，暂不能重载运行时；空闲后再试。";
    }
    const result = await host.reloadRuntime();
    return `已重新加载：技能 ${result.skillCount} 个，MCP ${result.mcpServerCount} 个服务 / ${result.mcpToolCount} 个工具。`;
}

async function peerCwd(
    host: PeerCommandHost,
    sessionId: string,
    raw: string | undefined,
    json: boolean,
): Promise<string> {
    const current = await host.getSessionCwd(sessionId);
    if (!raw) {
        return view(json, `当前工作目录：${formatDisplayPath(current)}`, () => ({ cwd: current }));
    }

    const resolved = resolveExistingDir(raw, current);
    if ("error" in resolved) throw new Error(resolved.error);
    await host.setSessionCwd(sessionId, resolved.cwd);
    return view(json, `工作目录已切换到：${formatDisplayPath(resolved.cwd)}`, () => ({ cwd: resolved.cwd, previous: current }));
}

/**
 * `/model`：查看 / `use <协议> <模型> [强度|auto]` / `effort [档位|auto]`。
 * 模型与思考强度只有这一处设置入口（没有 /effort /thinking 等第二入口）。
 */
async function peerModel(
    host: PeerCommandHost,
    sessionId: string,
    args: string[],
    json: boolean,
): Promise<string> {
    const selection = await host.getSessionModelSelection(sessionId);
    const modelView = describeModelView(selection);
    const [action, first, second, third] = args;

    if (action === undefined) {
        const selected = modelView.options.find(option =>
            option.provider === modelView.current.provider && option.model === modelView.current.model);
        const text = [
            `当前模型：${modelView.current.provider} · ${modelView.current.model}（${modelView.current.protocol}）`,
            ...(modelView.isTemporary ? ["（临时模型：不在配置的 models 里，仅本会话生效）"] : []),
            `思考强度：${modelView.current.reasoningEffort}`,
            modelView.options.length > 0
                ? "可切换模型："
                : "配置里没有列出可切换模型（config.yaml 的 providers.<name>.models）",
            ...modelView.options.map(option =>
                `  ${option === selected ? "*" : " "} ${option.provider}/${option.model}`),
            "",
            `可选思考强度：${modelView.efforts.join(" | ")}`,
            "用法：/model <provider> <模型> [强度|auto] · /model effort [档位|auto]",
        ];
        return view(json, text.join("\n"), () => ({
            current: modelView.current,
            options: modelView.options,
            efforts: modelView.efforts,
        }));
    }

    if (action !== "effort") {
        const settings = getChatApiSettings();
        // 与 TUI 同一条解析：按目标模型的档位校验并归一化强度
        const resolved = resolveModelUse(
            modelView.options,
            action,
            first!,
            second,
            selection?.reasoningEffort ?? settings.reasoningEffort,
        );
        if (!resolved.ok) throw new Error(resolved.error);
        const next = resolved.selection;
        await host.setSessionModelSelection(sessionId, next, { alreadyReserved: true });
        return view(
            json,
            `当前会话模型已设为：${next.provider} · ${next.model}（${next.protocol}），思考强度 ${next.reasoningEffort}，下一回合生效`,
            () => ({ ...next, effective: "next_turn" }),
        );
    }

    // action === "effort"（parse 层已保证只剩这个分支）
    const choices = modelView.efforts;
    if (first === undefined) {
        return view(
            json,
            `当前思考强度：${modelView.current.reasoningEffort}\n可选值：${choices.join(" | ")}`,
            () => ({ reasoningEffort: modelView.current.reasoningEffort, efforts: choices }),
        );
    }
    const resolved = resolveEffort(first, choices);
    if (!resolved.ok) throw new Error(resolved.error);
    const next: ChatModelSelection = {
        provider: modelView.current.provider,
        protocol: modelView.current.protocol as ChatModelSelection["protocol"],
        model: modelView.current.model,
        reasoningEffort: resolved.effort,
    };
    await host.setSessionModelSelection(sessionId, next, { alreadyReserved: true });
    return view(json, `当前会话思考强度已设为：${resolved.effort}`, () => ({ reasoningEffort: resolved.effort }));
}

async function peerMcp(
    host: PeerCommandHost,
    sessionId: string,
    args: string[],
    json: boolean,
): Promise<string> {
    const servers = getMcpServersStatus();
    const enabled = await host.getSessionLazyMcpServers(sessionId);
    const settings = getChatApiSettings();
    const toolSearch = isToolSearchEnabled({
        protocol: settings.protocol ?? "chat_completions",
        model: settings.model,
        baseURL: settings.apiBase,
        hostedTools: settings.hostedTools,
    });

    const action = args[0];
    if (action === "enable" || action === "disable") {
        const name = args[1]!;
        if (!servers.some(server => server.name === name)) {
            throw new Error(`没有这个 MCP 服务：${name}。可选：${servers.map(server => server.name).join(" | ") || "（无）"}`);
        }
        const next = action === "enable"
            ? [...new Set([...enabled, name])]
            : enabled.filter(server => server !== name);
        await host.setSessionLazyMcpServers(sessionId, next, { alreadyReserved: true });
        const text = action === "enable" ? `已为本会话启用 lazy MCP：${name}` : `已为本会话停用 lazy MCP：${name}`;
        return view(json, text, () => ({ enabled: next, changed: name }));
    }

    const rows = servers.map(server => ({
        name: server.name,
        status: server.status,
        lazy: server.lazy === true,
        toolCount: server.toolNames.length,
        sessionEnabled: enabled.includes(server.name),
    }));
    const lines = [
        `MCP 服务（${rows.length} 个）${toolSearch ? " · tool_search 已启用" : " · tool_search 未启用（用 /mcp enable 显式放行）"}`,
        ...rows.map(row => `  ${row.sessionEnabled ? "✓" : " "} ${row.name} [${row.status}]${row.lazy ? " lazy" : ""} ${row.toolCount} 个工具`),
        "",
        "用法：/mcp enable <服务名> | /mcp disable <服务名>",
    ];
    return view(json, rows.length > 0 ? lines.join("\n") : "没有配置 MCP 服务", () => ({ toolSearch, servers: rows }));
}
