/**
 * 会话间工具：开子会话、发消息、查状态。
 *
 * 会话级下发（sessionScoped）：注入条件是「有会话上下文 + 进程已装配控制通道」。
 * 会话运行期间持有权不可能被释放（归档/删除/协商释放都要求空闲），所以无须再判断是否已认领；
 * 没有会话上下文时根本不注入。
 *
 * 任务不是独立实体，全部通过消息表达：下发 = 发一条消息，交付 = 对方回合结束时自动回传的结果。
 * 结果默认异步回传（对方一轮结束后由宿主驱动下一轮），`wait_seconds` 时改为前台阻塞等待。
 */

import {
    formatResultText,
    MAX_SPAWNED_SESSIONS,
    PeerSendFailure,
    type SessionControl,
} from "../control/channel.js";
import { describeOwnership } from "../control/registry.js";
import { isCancelledStopReason } from "../control/protocol.js";
import { isSameSession, isUlid, shortSessionId } from "../utils/session-id.js";
import {
    getPeerResultHistory,
    getSessionControl,
    getSessionDirectory,
    hasSessionCapabilityProvider,
} from "../control/runtime.js";
import { err, ok, type ExecutableTool, type ToolExecutionResult } from "./tool-interface.js";
import { toolCatalog } from "./tool-catalog.js";

/** 会话间工具的控制通道：按 caller 会话严格解析，区分"进程没装配"与"会话不归本实例"。 */
function requireControl(sessionId?: string): { control: SessionControl } | { error: ToolExecutionResult } {
    const control = getSessionControl(sessionId);
    if (control) return { control };
    if (sessionId && hasSessionCapabilityProvider("control")) {
        return { error: err(`会话 ${shortSessionId(sessionId)} 不在本实例的运行时上下文里，无法使用会话间工具`) };
    }
    return { error: err("会话间通信未启用") };
}

const SESSION_TOOL_NAMES = ["session_spawn", "session_send", "session_status", "session_close", "session_cancel", "session_wake"];

/** `wait_seconds` 的上限：别让一次工具调用把回合占死太久。 */
const MAX_WAIT_SECONDS = 600;
/** 工具排队投递的有效期：短于结果等待上限，避免等待先被判丢失。 */
const QUEUE_EXPIRES_MS = 270_000;

interface SessionSpawnArgs {
    title?: string;
    text?: string;
    auto_close?: boolean;
    __sessionId?: string;
}

interface SessionSendArgs {
    session?: string;
    text?: string;
    expect_result?: boolean;
    wait_seconds?: number;
    reply_to?: string;
    queue_if_busy?: boolean;
    __sessionId?: string;
}

interface SessionStatusArgs {
    session?: string;
    include_result?: boolean;
    __sessionId?: string;
}

interface SessionCloseArgs {
    session?: string;
    __sessionId?: string;
}

interface SessionCancelArgs {
    session?: string;
    close?: boolean;
    __sessionId?: string;
}

interface SessionWakeArgs {
    session?: string;
    text?: string;
    close?: boolean;
    __sessionId?: string;
}

const sessionSpawnTool: ExecutableTool = {
    name: "session_spawn",
    description: [
        "开一个子会话并与之协作：子会话立即创建、由本实例持有，并出现在用户的会话条里。",
        "可选 text 会作为首条任务消息立即发送，并请求结果自动回传。",
        "返回的 sessionId 用 session_send 派活（expect_result=true 时结果会自动回传）。",
        "auto_close=true 时，本实例内 session_send 派发的首个 expect_result=true 任务完成并回传后自动归档；历史保留。",
        "跨进程 session_send 暂不自动关闭（结果推送尚无可靠 ACK），需用 session_close 手动归档。",
        `本实例管理的子会话数有上限（${MAX_SPAWNED_SESSIONS} 个），到上限后要先关闭不再需要的会话。`,
        "默认不自动回收；用完可用 session_close 归档（保留历史），或提示用户删除（⌃X）。",
    ].join(""),
    tags: ["chat"],
    sessionScoped: true,
    inputSchema: {
        type: "object",
        properties: {
            title: { type: "string", description: "子会话标题（便于用户辨认；省略则由首条消息推导）" },
            text: { type: "string", description: "可选的初次任务消息；创建后立即发送，并请求结果自动回传" },
            auto_close: {
                type: "boolean",
                description: "本实例内 session_send 的首个期望结果回传后自动归档（保留历史）；跨进程发送不会自动关闭；默认 false",
            },
        },
    },
    execute: async (args: SessionSpawnArgs) => {
        const from = args.__sessionId;
        if (!from) return err("session_spawn 需要会话上下文（缺少 __sessionId）");
        const resolvedControl = requireControl(from);
        if ("error" in resolvedControl) return resolvedControl.error;
        const control = resolvedControl.control;

        const title = (args.title ?? "").trim();
        const text = (args.text ?? "").trim();
        const autoClose = args.auto_close === true;
        let result;
        try {
            result = await control.spawnSession(from, title || undefined, { autoClose });
        } catch (error) {
            return err(`派生会话失败：${(error as Error)?.message ?? error}`);
        }
        if (!result.ok) return err(result.error);

        if (text) {
            try {
                await control.send(from, result.sessionId, text, {
                    expectResult: true,
                    ...(autoClose ? { closeOnResult: true } : {}),
                });
            } catch (error) {
                return err(
                    `已创建会话 ${result.sessionId}，但初次消息发送失败：${(error as Error)?.message ?? error}`,
                );
            }
        }

        return ok(
            [
                `已派生并接管会话 ${shortSessionId(result.sessionId)}`,
                `完整 id：${result.sessionId}`,
                ...(autoClose ? ["任务完成回传后会自动归档（保留历史）。"] : []),
                ...(text ? ["已发送初次任务消息，结果会自动回传。"] : []),
                ...(!text ? [`用 session_send(session="${result.sessionId}", text=…, expect_result=true) 派活。`] : []),
            ].join("\n"),
        );
    },
};

const sessionSendTool: ExecutableTool = {
    name: "session_send",
    description: [
        "给另一个会话发消息：可以让它做一件事、与它讨论，或回答它发来的消息。",
        "expect_result=true 表示你在等它这轮的产出：它会自动把回合结束时的最终输出回传给你，",
        "结果会作为新消息回到你这里（你空闲时会直接继续一轮），所以不要等待、也不要反复轮询。",
        `wait_seconds>0 时本次调用就地等待对方这轮的结果（隐含 expect_result，最长 ${MAX_WAIT_SECONDS} 秒）：`,
        "命中即作为本次工具结果返回，超时先返回提示、结果到了仍会自动继续一轮。",
        "等待期间用户可以按 ⌃B 把等待放入后台，你会立刻拿到提示、继续做别的。",
        "对方未认领或正在执行时默认直接失败；queue_if_busy=true 时改为排队（有界、按 msgId 幂等），",
        "空闲后自动执行。",
        "回应别人的消息时用 reply_to 填那条消息的 id。",
    ].join(""),
    tags: ["chat"],
    sessionScoped: true,
    inputSchema: {
        type: "object",
        properties: {
            session: { type: "string", description: "目标会话 id（可用末几位；session_status 可列出）" },
            text: { type: "string", description: "消息正文" },
            expect_result: {
                type: "boolean",
                description: "是否等待对方的产出作为结果回传（默认 false，纯通知/讨论用 false）",
            },
            wait_seconds: {
                type: "number",
                description: [
                    "就地等待对方本轮结果的最长秒数（默认 0 = 发完即返回）。",
                    `>0 时隐含 expect_result，命中即返回结果文本；超时先返回提示，结果到达后仍会自动继续。上限 ${MAX_WAIT_SECONDS} 秒。`,
                ].join(""),
            },
            reply_to: { type: "string", description: "在回应哪条消息的 id（回信时填）" },
            queue_if_busy: {
                type: "boolean",
                description: "目标正在执行时是否排队等待（默认 false：直接报错）。排队上限 8 条/会话。",
            },
        },
        required: ["session", "text"],
    },
    execute: async (args: SessionSendArgs, signal?: AbortSignal) => {
        const from = args.__sessionId;
        if (!from) return err("session_send 需要会话上下文（缺少 __sessionId）");
        const resolvedControl = requireControl(from);
        if ("error" in resolvedControl) return resolvedControl.error;
        const control = resolvedControl.control;

        const target = (args.session ?? "").trim();
        if (!target) return err("session 必填：填目标会话 id，可用末几位");
        const text = (args.text ?? "").trim();
        if (!text) return err("text 必填");

        const resolved = await resolveSessionId(target, {}, args.__sessionId);
        if (!resolved.ok) return err(resolved.error);
        if (isSameSession(resolved.sessionId, from)) {
            return err(`会话 ${shortSessionId(from)} 就是你所在的会话，不能给自己发消息：直接在本轮输出即可`);
        }

        const waitSeconds = normalizeWaitSeconds(args.wait_seconds);
        const expectResult = args.expect_result === true || waitSeconds > 0;

        try {
            const outcome = await control.send(from, resolved.sessionId, text, {
                ...(expectResult ? { expectResult: true } : {}),
                ...(args.reply_to ? { replyTo: args.reply_to } : {}),
                ...(args.queue_if_busy === true
                    ? { queueIfBusy: true, expiresAt: new Date(Date.now() + QUEUE_EXPIRES_MS).toISOString() }
                    : {}),
            });
            const sent = outcome.queued
                ? `已排队到会话 ${shortSessionId(resolved.sessionId)}（第 ${outcome.position ?? "?"} 位，msgId=${outcome.message.id}）`
                : `已发送到会话 ${shortSessionId(resolved.sessionId)}（msgId=${outcome.message.id}）`;
            if (waitSeconds === 0) {
                return ok(`${sent}${expectResult ? "，结果稍后自动回传" : ""}`);
            }

            const wait = await control.waitForResult(outcome.message.id, Math.round(waitSeconds * 1000), signal);
            if (wait.ok) return ok(formatResultText(resolved.sessionId, wait.result));
            if (wait.reason === "timeout") {
                return ok(`${sent}，等待 ${waitSeconds}s 未见结果；结果到达后会自动继续，不要重复发送`);
            }
            if (wait.reason === "none") {
                return ok(`${sent}，结果已就绪，会在后续自动附加`);
            }
            if (wait.reason === "detached") {
                return ok(`${sent}，等待已由用户放入后台：先继续手头的事，结果到达后会自动继续一轮`);
            }
            if (wait.reason === "aborted") return err(`${sent}，但等待结果被中止`);
            return err(`${sent}，但结果已丢失（会话 ${shortSessionId(resolved.sessionId)} 不可达），不要重复发送`);
        } catch (error) {
            if (error instanceof PeerSendFailure) return err(error.message);
            return err(`发送到会话 ${shortSessionId(resolved.sessionId)} 失败：${(error as Error)?.message ?? error}`);
        }
    },
};

/** 归一化 `wait_seconds`：非法或不大于 0 视为不等待，超上限按上限截断。 */
function normalizeWaitSeconds(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
    return Math.min(value, MAX_WAIT_SECONDS);
}

const sessionStatusTool: ExecutableTool = {
    name: "session_status",
    description: [
        "查看会话状态：省略 session 时列出全部会话及其归属、忙闲与等待中的结果；",
        "指定 session 时给出该会话的详情，include_result 时附上它最近收到的会话间结果原文。",
        "用于确认对方在不在、忙不忙，以及回顾对方回合的产出。",
    ].join(""),
    tags: ["chat"],
    sessionScoped: true,
    inputSchema: {
        type: "object",
        properties: {
            session: { type: "string", description: "会话 id；省略则列出全部会话" },
            include_result: {
                type: "boolean",
                description: "同时返回该会话最近收到的会话间结果原文（默认 false）",
            },
        },
    },
    execute: async (args: SessionStatusArgs) => {
        const caller = args.__sessionId;
        const resolvedControl = requireControl(caller);
        if ("error" in resolvedControl) return resolvedControl.error;
        const control = resolvedControl.control;

        const target = (args.session ?? "").trim();
        if (!target) return describeAll(control, caller, args.include_result === true);
        if (target === caller || (caller ?? "").endsWith(target)) {
            return describeOne(control, caller ?? target, caller, args.include_result === true);
        }

        const resolved = await resolveSessionId(target, {}, args.__sessionId);
        if (!resolved.ok) return err(resolved.error);
        return describeOne(control, resolved.sessionId, caller, args.include_result === true);
    },
};

const sessionCloseTool: ExecutableTool = {
    name: "session_close",
    description: [
        "关闭本实例用 session_spawn 派生或 session_wake 恢复并接管的空闲子会话。",
        "关闭会归档并释放会话，不删除历史；不能关闭普通用户会话、其他实例持有的会话或正在执行的会话。",
        "若 session_spawn 使用 auto_close=true，本实例内 session_send 的首个 expect_result=true 任务回传后会自动完成此操作；跨进程任务需手动关闭。",
    ].join(""),
    tags: ["chat"],
    sessionScoped: true,
    inputSchema: {
        type: "object",
        properties: {
            session: { type: "string", description: "session_spawn/session_wake 返回的完整 id 或末几位 id" },
        },
        required: ["session"],
    },
    execute: async (args: SessionCloseArgs) => {
        if (!args.__sessionId) return err("session_close 需要会话上下文（缺少 __sessionId）");
        const resolvedControl = requireControl(args.__sessionId);
        if ("error" in resolvedControl) return resolvedControl.error;
        const control = resolvedControl.control;

        const target = (args.session ?? "").trim();
        if (!target) return err("session 必填：填 session_spawn 返回的会话 id");
        const resolved = await resolveSessionId(target, {}, args.__sessionId);
        if (!resolved.ok) return err(resolved.error);

        const result = await control.closeSpawnedSession(resolved.sessionId);
        if (!result.ok) return err(result.error);
        return ok(`已归档并关闭子会话 ${shortSessionId(resolved.sessionId)}；历史保留，可从会话面板重新打开。`);
    },
};

const sessionCancelTool: ExecutableTool = {
    name: "session_cancel",
    description: [
        "向本实例派生或唤醒后接管的子会话发送取消信号，并等待当前 turn 完成收尾。",
        "close=true 时，收尾后归档并释放会话（保留历史）；默认只取消当前任务，子会话继续保持打开。",
        "只能取消本实例持有且正在运行的子会话；其他实例的会话不能被本地强制中止。",
    ].join(""),
    tags: ["chat"],
    sessionScoped: true,
    inputSchema: {
        type: "object",
        properties: {
            session: { type: "string", description: "session_spawn/session_wake 返回的完整 id 或末几位 id" },
            close: { type: "boolean", description: "中止并等待收尾后归档、释放子会话；默认 false" },
        },
        required: ["session"],
    },
    execute: async (args: SessionCancelArgs) => {
        if (!args.__sessionId) return err("session_cancel 需要会话上下文（缺少 __sessionId）");
        const resolvedControl = requireControl(args.__sessionId);
        if ("error" in resolvedControl) return resolvedControl.error;
        const control = resolvedControl.control;

        const target = (args.session ?? "").trim();
        if (!target) return err("session 必填：填子会话 id");
        const resolved = await resolveSessionId(target, {}, args.__sessionId);
        if (!resolved.ok) return err(resolved.error);

        const result = await control.cancelSpawnedSession(resolved.sessionId, { close: args.close === true });
        if (!result.ok) return err(result.error);
        return ok(result.closed
            ? `已取消并归档子会话 ${shortSessionId(resolved.sessionId)}；历史保留。`
            : `已取消子会话 ${shortSessionId(resolved.sessionId)} 的当前任务；会话仍保持打开，可继续用 session_send。`);
    },
};

const sessionWakeTool: ExecutableTool = {
    name: "session_wake",
    description: [
        "唤醒已归档的会话：取消归档并由本实例认领，使其可以继续接收 session_send。",
        "可选提供 text，唤醒后立即发送为新的用户输入并期望结果回传；任务完成后默认重新归档。",
        "close=false 时任务完成后保持打开；不提供 text 时只恢复会话并保持打开，后续可用 session_send。",
        "仅限本地 TUI 会话目录中的归档会话；其他实例仍持有或正在运行时不会强行接管。",
    ].join(""),
    tags: ["chat"],
    sessionScoped: true,
    inputSchema: {
        type: "object",
        properties: {
            session: { type: "string", description: "归档会话的完整 id 或末几位 id" },
            text: { type: "string", description: "可选：恢复后立即作为新的用户输入发送" },
            close: {
                type: "boolean",
                description: "有 text 时，收到任务结果后是否自动重新归档（默认 true）",
            },
        },
        required: ["session"],
    },
    execute: async (args: SessionWakeArgs) => {
        if (!args.__sessionId) return err("session_wake 需要会话上下文（缺少 __sessionId）");
        const resolvedControl = requireControl(args.__sessionId);
        if ("error" in resolvedControl) return resolvedControl.error;
        const control = resolvedControl.control;
        const target = (args.session ?? "").trim();
        if (!target) return err("session 必填：填要恢复的归档会话 id");

        const directory = getSessionDirectory(args.__sessionId);
        if (!directory?.wake) return err("当前环境未提供唤醒归档会话的能力（仅在 TUI 内可用）");
        const resolved = await resolveSessionId(target, { includeArchived: true }, args.__sessionId);
        if (!resolved.ok) return err(resolved.error);
        if (isSameSession(resolved.sessionId, args.__sessionId)) {
            return err(`会话 ${shortSessionId(resolved.sessionId)} 就是你所在的会话，不需要唤醒自己`);
        }

        try {
            await directory.wake(resolved.sessionId);
        } catch (error) {
            return err(`唤醒会话失败：${(error as Error)?.message ?? error}`);
        }

        const text = (args.text ?? "").trim();
        if (!text) return ok(`已唤醒并认领会话 ${shortSessionId(resolved.sessionId)}；用 session_send 继续工作。`);

        try {
            const sent = await control.send(args.__sessionId, resolved.sessionId, text, {
                expectResult: true,
                ...(args.close !== false ? { closeOnResult: true } : {}),
            });
            return ok([
                `已唤醒会话 ${shortSessionId(resolved.sessionId)} 并发送输入（msgId=${sent.message.id}）。`,
                "任务结果稍后会自动回传。",
                ...(args.close === false ? ["收到结果后会话保持打开。"] : ["收到结果后会自动重新归档。"]),
            ].join("\n"));
        } catch (error) {
            return err(`会话已唤醒，但发送输入失败：${(error as Error)?.message ?? error}`);
        }
    },
};

/** 列出全部会话：归属 + 忙闲，附本实例的等待/待附加计数。 */
async function describeAll(
    control: SessionControl,
    caller?: string,
    includeResult = false,
): Promise<ToolExecutionResult> {
    const directory = getSessionDirectory(caller);
    if (!directory) return err("当前环境没有会话目录（仅在 TUI 内可用）");

    const entries = await directory.list();
    if (entries.length === 0) return ok("当前没有会话");

    const ownership = await control.listOwnership(entries.map(entry => entry.sessionId));
    const lines = entries.map((entry) => {
        const state = ownership.get(entry.sessionId) ?? { state: "free" as const };
        const marker = state.state === "mine" ? "●" : state.state === "free" ? "○" : "👁";
        const title = entry.title ? `「${entry.title}」` : "";
        const current = entry.sessionId === caller ? " ← 你" : "";
        return `${marker} ${shortSessionId(entry.sessionId)} ${title} ${describeOwnership(entry.sessionId, state)}${current}`;
    });

    const summary = [`会话（本实例 PID ${process.pid}）：`, ...lines];
    if (caller) {
        const awaiting = control.awaitingResults(caller);
        const queued = control.queuedResults(caller);
        summary.push(
            "",
            `等待别人回传的结果：${awaiting} 条 · 已就绪待附加：${queued} 条`,
            `本实例管理的子会话：${control.spawnedCount}/${MAX_SPAWNED_SESSIONS}`,
        );
        if (includeResult) summary.push(...(await recentResultLines(caller)));
    }
    summary.push("", "● 本实例持有 · 👁 其他实例持有 · ○ 未认领");
    return ok(summary.join("\n"));
}

/** 单个会话详情：归属、忙闲、本实例的等待与待附加计数。 */
async function describeOne(
    control: SessionControl,
    sessionId: string,
    caller?: string,
    includeResult = false,
): Promise<ToolExecutionResult> {
    const ownership = await control.probe(sessionId);
    const lines = [
        `会话 ${shortSessionId(sessionId)}`,
        `归属：${describeOwnership(sessionId, ownership)}`,
    ];

    if (ownership.state === "other" && ownership.info) {
        lines.push(`对端标题：${ownership.info.title ?? "（无）"}`);
        lines.push(`处理中：${ownership.info.pending} 条`);
    }
    if (sessionId === caller) {
        lines.push("这是你所在的会话，不能给自己发消息。");
    } else {
        lines.push(`你可以用 session_send(session="${sessionId.slice(-8)}") 给它发消息。`);
    }
    if (includeResult) lines.push(...(await recentResultLines(sessionId)));
    return ok(lines.join("\n"));
}

/** 最近收到的会话间结果原文（include_result 时附带）。 */
async function recentResultLines(sessionId: string): Promise<string[]> {
    const history = getPeerResultHistory(sessionId);
    if (!history) return ["", "最近结果：本实例未装配结果历史"];

    const latest = (await history.recentResults(sessionId, 1)).at(-1);
    if (!latest) return ["", "最近结果：（无）"];

    const peer = latest.peerTitle
        ? `${shortSessionId(latest.peerId)}「${latest.peerTitle}」`
        : shortSessionId(latest.peerId);
    const status = latest.lost
        ? "已丢失"
        : latest.late
            ? "迟到结果"
            : isCancelledStopReason(latest.stopReason)
                ? "已取消"
                : latest.ok ? "ok" : "失败";
    return ["", `最近结果（来自 ${peer} · ${latest.createdAt} · ${status}）：`, latest.text];
}

/**
 * 把末几位 id 补全为完整会话 id；匹配不到时用原文（可能是尚未列入目录的会话）。
 * 比对按大写口径（ULID 是 Crockford Base32），返回的始终是目录里的原样 id。
 */
async function resolveSessionId(
    input: string,
    options: { includeArchived?: boolean } = {},
    caller?: string,
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
    const directory = getSessionDirectory(caller);
    if (!directory) return { ok: true, sessionId: canonicalFallback(input) };

    const wanted = input.toUpperCase();
    const entries = await directory.list({ includeArchived: options.includeArchived === true });
    const exact = entries.find(entry => entry.sessionId.toUpperCase() === wanted);
    if (exact) return { ok: true, sessionId: exact.sessionId };

    const matched = entries.filter(entry => entry.sessionId.toUpperCase().endsWith(wanted));
    if (matched.length === 0) {
        // 目录里没有：可能是别的实例刚建的会话，按原样尝试，由通道给出不可达错误
        return { ok: true, sessionId: canonicalFallback(input) };
    }
    if (matched.length > 1) {
        return { ok: false, error: `会话 ${input} 匹配到多个候选，请写更长的 id` };
    }
    return { ok: true, sessionId: matched[0]!.sessionId };
}

/** 目录里查不到时的兜底：完整 ULID 统一成大写，避免大小写写法落到另一个 socket 上。 */
function canonicalFallback(input: string): string {
    return isUlid(input.toUpperCase()) ? input.toUpperCase() : input;
}

export const SESSION_TOOLS: ExecutableTool[] = [
    sessionSpawnTool,
    sessionSendTool,
    sessionStatusTool,
    sessionCloseTool,
    sessionCancelTool,
    sessionWakeTool,
];

// 注册到工具目录供 executeMcpTool 查找；sessionScoped 保证默认不下发
toolCatalog.registerLocalTools(SESSION_TOOLS);

/**
 * 会话当前可用的会话间工具名。
 * 有会话上下文且进程装配了控制通道就注入：回合运行期间持有权不可能被释放，无须再看是否已认领。
 */
export function getSessionToolNames(sessionId?: string): string[] {
    if (!sessionId) return [];
    return getSessionControl(sessionId) ? [...SESSION_TOOL_NAMES] : [];
}
