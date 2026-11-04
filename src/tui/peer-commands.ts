/**
 * 会话间消息里的 slash 命令执行：只做无 UI 依赖的部分，返回纯文本或模型指令。
 *
 * 解析与支持策略在 `commands/slash-command.ts`；host 只负责把 allow 命令转到这里，
 * 面板/会话生命周期强绑定的命令由 host 直接拒绝，不进入本模块。
 */

import { parseSlashCommand, REVIEW_PROMPT } from "../commands/slash-command.js";
import type { SessionHost, SlashCommandOutcome } from "../host/session-host-types.js";
import { getChatApiSettings } from "../services/chat-runtime.js";
import { backgroundTaskManager } from "../tools/background-tasks.js";
import { formatDisplayPath, resolveExistingDir } from "../tools/cwd-tool.js";
import { getReasoningEffortChoices, getReasoningProvider } from "../utils/reasoning-effort.js";
import { truncatePlain } from "../format/text.js";
import type { ChatModelSelection } from "../types/chat-model.js";
import { buildHelpText, buildSkillsHelpText } from "./slash-commands.js";
import { formatBackgroundTaskDetails, formatElapsed, MAX_SHOWN_BACKGROUND_TASKS, MAX_TASK_TEXT_COLUMNS } from "./task-format.js";

/** 执行一条会话间命令；未识别或未接入的命令返回 handled:false。 */
export async function executePeerSlashCommand(
    host: SessionHost,
    sessionId: string,
    text: string,
): Promise<SlashCommandOutcome> {
    const parsed = parseSlashCommand(text);
    if (parsed.kind !== "command") return { handled: false };

    switch (parsed.name) {
        case "/help":
            return { handled: true, output: buildHelpText() };
        case "/skills":
            return { handled: true, output: buildSkillsHelpText() };
        case "/system": {
            const prompt = await host.getSystemPrompt(sessionId);
            return { handled: true, output: `当前 system prompt：\n\n${prompt || "（空）"}` };
        }
        case "/cwd":
            return { handled: true, output: await peerCwd(host, sessionId, parsed.args[0]) };
        case "/ps":
            return { handled: true, output: formatRunningTasks(sessionId) };
        case "/tasks":
            return { handled: true, output: await peerTasks(sessionId, parsed.args) };
        case "/stop":
            return { handled: true, output: peerStop(sessionId, parsed.args[0]) };
        case "/effort":
        case "/thinking":
            return { handled: true, output: await peerEffort(host, sessionId, parsed.args[0]) };
        case "/reload": {
            // 执行命令的会话自己就被本次投递占着互斥，必须排除
            if (host.claimedSessionIds().some(id => id !== sessionId && host.isSessionBusy(id))) {
                return { handled: true, output: "有会话正在执行，暂不能重载运行时；空闲后再试。" };
            }
            const result = await host.reloadRuntime();
            return {
                handled: true,
                output: `已重新加载：技能 ${result.skillCount} 个，MCP ${result.mcpServerCount} 个服务 / ${result.mcpToolCount} 个工具。`,
            };
        }
        case "/review":
            return { handled: true, prompt: REVIEW_PROMPT };
        default:
            // 解析层只放行 allow 命令；未接入的实现明确回落成文本
            return { handled: false };
    }
}

async function peerCwd(host: SessionHost, sessionId: string, raw: string | undefined): Promise<string> {
    const current = await host.getSessionCwd(sessionId);
    if (!raw) return `当前工作目录：${formatDisplayPath(current)}`;

    const resolved = resolveExistingDir(raw, current);
    if ("error" in resolved) return resolved.error;
    await host.setSessionCwd(sessionId, resolved.cwd);
    return `工作目录已切换到：${formatDisplayPath(resolved.cwd)}`;
}

/** 仿 /ps：列出当前会话运行中的后台任务。 */
function formatRunningTasks(sessionId: string): string {
    const running = backgroundTaskManager.list(sessionId).filter(task => task.status === "running");
    if (running.length === 0) return "没有正在运行的后台任务";

    const lines = [`后台任务（${running.length} 个运行中）：`, ""];
    for (const task of running.slice(0, MAX_SHOWN_BACKGROUND_TASKS)) {
        const elapsed = formatElapsed(task.startedAt);
        lines.push(`  • ${task.id}${elapsed ? ` · ${elapsed}` : ""}  ${truncatePlain(task.command, MAX_TASK_TEXT_COLUMNS)}`);
    }
    if (running.length > MAX_SHOWN_BACKGROUND_TASKS) {
        lines.push(`  …还有 ${running.length - MAX_SHOWN_BACKGROUND_TASKS} 个任务`);
    }
    lines.push("", "使用 /stop <task_id> 终止指定任务，/stop 终止全部");
    return lines.join("\n");
}

/** 仿 /tasks：list / status / wait / stop。 */
async function peerTasks(sessionId: string, args: string[]): Promise<string> {
    const [rawAction, taskId, rawWaitSeconds] = args;
    const action = (rawAction ?? "list").toLowerCase();

    if (action === "list") {
        const tasks = backgroundTaskManager.list(sessionId);
        if (tasks.length === 0) return "当前没有后台任务";
        const lines = tasks.map(task =>
            `- ${task.id} [${task.status === "running" ? "运行中" : task.status}] ${task.command.replace(/\s+/g, " ").trim()}`);
        return `后台任务：\n${lines.join("\n")}\n\n用法：/tasks status|wait|stop <task_id>`;
    }

    if (action === "wait") {
        const parsedSeconds = Number(rawWaitSeconds);
        const waitSeconds = Number.isFinite(parsedSeconds) && parsedSeconds > 0
            ? Math.min(600, Math.round(parsedSeconds))
            : 10;
        const task = await backgroundTaskManager.wait(taskId!, waitSeconds * 1_000, sessionId);
        return task ? formatBackgroundTaskDetails(task) : `后台任务不存在或不属于当前会话：${taskId}`;
    }

    const task = backgroundTaskManager.get(taskId!, sessionId);
    if (!task) return `后台任务不存在或不属于当前会话：${taskId}`;

    if (action === "status") return formatBackgroundTaskDetails(task);

    const wasRunning = backgroundTaskManager.stop(taskId!, sessionId);
    return wasRunning ? `已请求终止后台任务 ${taskId}` : `后台任务 ${taskId} 当前状态：${task.status}`;
}

/** 仿 /stop：无参数或 all 终止全部，否则终止指定任务。 */
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
    const wasRunning = backgroundTaskManager.stop(target, sessionId);
    return wasRunning ? `已请求终止后台任务 ${target}` : `后台任务 ${target} 当前状态：${task.status}`;
}

/** 仿 /effort：查看或设置当前会话思考强度。 */
async function peerEffort(host: SessionHost, sessionId: string, raw: string | undefined): Promise<string> {
    const settings = getChatApiSettings();
    const selection = await host.getSessionModelSelection(sessionId);
    const protocol = selection?.protocol ?? settings.protocol ?? "chat_completions";
    const model = selection?.model ?? settings.model;
    const current = selection?.reasoningEffort ?? settings.reasoningEffort ?? "auto";

    if (!raw) return `当前思考强度：${current}\n用法：/effort <档位|auto>`;

    const input = raw.toLowerCase();
    const provider = getReasoningProvider(protocol, model, settings.apiBase);
    const choices = getReasoningEffortChoices(protocol, provider, settings.reasoningEfforts);
    if (input !== "auto" && !choices.some(value => value.toLowerCase() === input)) {
        return `未知思考强度：${raw}，可选值：${[...choices, "auto"].join(" | ")}`;
    }

    const next: ChatModelSelection = { protocol, model, reasoningEffort: input };
    await host.setSessionModelSelection(sessionId, next);
    return `当前会话思考强度已设为：${input}`;
}
