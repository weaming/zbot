/**
 * Job HTTP 接口：提交、查询、取消，以及两条事件流。
 *
 * 两条流分开是刻意的：
 * - `/jobs/events` 只推状态变迁（轻量），驱动列表徽标与排序；
 * - `/jobs/:id/events` 转发该 Job 绑定会话的执行事件（重），只给当前详情页看。
 * 合成一条会让某个任务的执行细节淹没整个列表。
 */

import fs from "node:fs";
import path from "node:path";
import { expandHomePath } from "../utils/runtime-paths.js";
import type {
    SessionEventSource,
    SessionLifecycle,
    SessionQuery,
    SessionSettings,
    SessionTurnHost,
} from "../host/session-host-types.js";
import type { JobRunner } from "../jobs/runner.js";
import type { JobStore } from "../jobs/store.js";
import {
    BOARD_COLUMNS,
    isBoardColumn,
    isJobState,
    JobConflictError,
    JobNotFoundError,
    type BoardColumn,
    type CreateJobRequest,
    type JobInput,
    type JobRecord,
    type JobState,
} from "../jobs/types.js";
import { defaultMcpSelection, getMcpServersStatus } from "../mcp/client-manager.js";
import { readMcpSelection } from "../tools/session-mcp-selection.js";
import { toolCatalog } from "../tools/tool-catalog.js";
import { fail, json, readJson } from "./respond.js";
import { parseEventPage } from "./page-params.js";
import { readToolCall, toLiveEventPayload, toSessionEventView, toSessionEventViews } from "./event-view.js";
import { subscribeLive as subscribeLiveFrames } from "./live-stream.js";
import { openSseStream, parseSseCursor, type SseSource } from "./sse.js";

/**
 * Job 看板接口需要的宿主能力：事件流、会话生命周期、查询与设置写入。
 * 任务执行走 JobRunner，这里只用 `sendMessage` 给分支会话补一轮对话。
 */
export type JobsApiHost = SessionEventSource
    & SessionLifecycle
    & SessionQuery
    & SessionSettings
    & Pick<SessionTurnHost, "sendMessage">;

export interface JobsApiContext {
    store: JobStore;
    runner: JobRunner;
    host: JobsApiHost;
    heartbeatMs: number;
}

const DEFAULT_SOURCE = "http";
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
/** 评论正文上限：超过基本是误贴文件，挡在入口比存进库更省事。 */
const MAX_COMMENT_CHARS = 10_000;

/** 看板列 → 语义动作。拖拽只表达「我要它去哪一列」，具体怎么变由这里决定。 */

/** Job 状态流：所有任务的状态变迁，作为列表页数据源。 */
function jobListSource(store: JobStore): SseSource {
    return {
        label: "Job 状态流",
        readSince: async since => store.eventsSince(since).map(event => ({ seq: event.seq, payload: event })),
        subscribe: listener => store.subscribe(event => listener({ seq: event.seq, payload: event })),
    };
}

/** 详情执行流：转发该 Job 绑定会话的事件（重置信号原样透传）。 */
function sessionEventSource(host: JobsApiHost, sessionId: string, jobId: string): SseSource {
    return {
        label: `任务 ${jobId} 执行流`,
        readSince: async since =>
            toSessionEventViews(await host.readSessionEventsSince(sessionId, since))
                .map(view => ({ seq: view.seq, payload: toLiveEventPayload(view) })),
        subscribeLive: listener =>
            subscribeLiveFrames(sessionId, frame => listener({ event: "live", data: JSON.stringify(frame) })),
        subscribe: listener =>
            host.subscribeEvents((changedSessionId, event) => {
                if (changedSessionId !== sessionId) return;
                if (event === null) {
                    listener(null);
                    return;
                }
                const view = toSessionEventView(event);
                if (view) listener({ seq: view.seq, payload: toLiveEventPayload(view) });
            }),
    };
}

/** 收集卡片名下的所有会话（历次执行 + 手动分支），卡片删除后 job_sessions 表就没了，须先取。 */
function collectBoundSessionIds(ctx: JobsApiContext, jobId: string): string[] {
    const ids = new Set<string>();
    const job = ctx.store.get(jobId);
    if (job?.sessionId) ids.add(job.sessionId);
    for (const item of ctx.store.listSessions(jobId)) ids.add(item.sessionId);
    return [...ids];
}

/**
 * 对卡片名下的每个会话执行一次 action。
 * 正在执行或锁在别处的会话跳过——卡片操作不能因为某个会话忙就整体失败。
 */
async function applyToBoundSessions(
    ctx: JobsApiContext,
    sessionIds: string[],
    action: (sessionId: string) => Promise<void>,
    label: string,
): Promise<void> {
    for (const sessionId of sessionIds) {
        if (ctx.host.isSessionBusy(sessionId)) {
            console.warn(`⚠️ [web] 会话 ${sessionId} 正在执行，跳过${label}`);
            continue;
        }
        try {
            await action(sessionId);
        } catch (error) {
            console.warn(`⚠️ [web] ${label}会话失败 ${sessionId}:`, error instanceof Error ? error.message : error);
        }
    }
}

function isDirectory(target: string): boolean {
    try {
        return fs.statSync(target).isDirectory();
    } catch {
        return false;
    }
}

/**
 * 拖拽：只记录卡片放在哪一列。
 * 列与任务状态完全解耦——移动卡片不启动、不取消，任务跑完也不会自动跳列。
 */
async function moveJob(ctx: JobsApiContext, job: JobRecord, column: BoardColumn): Promise<Response> {
    return json(ctx.store.updateInput(job.id, { column }));
}

function positiveInt(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * 把请求体里允许的卡片属性合并进 input（创建与 PATCH 共用同一套校验）。
 * 校验失败只回错误文案，不抛错——HTTP 层统一映射 400。
 */
function applyInputFields(target: JobInput, body: Record<string, unknown>): { ok: true } | { error: string } {
    if (typeof body.prompt === "string") {
        const next = body.prompt.trim();
        if (!next) return { error: "prompt 不能为空" };
        target.prompt = next.slice(0, 20_000);
    }
    if (typeof body.title === "string") target.title = body.title.trim().slice(0, 200);
    if (typeof body.description === "string") target.description = body.description.slice(0, 20_000);

    // 工作目录：只影响之后新建的执行会话，已有会话的 cwd 不跟着变
    if (typeof body.workspace === "string") {
        const raw = body.workspace.trim();
        if (!raw) return { error: "workspace 不能为空" };
        const resolved = path.resolve(expandHomePath(raw));
        if (!isDirectory(resolved)) return { error: `工作目录不存在或不是目录: ${resolved}` };
        target.workspace = resolved;
    }

    if (body.labels !== undefined) {
        if (!Array.isArray(body.labels)) return { error: "labels 必须是字符串数组" };
        target.labels = body.labels
            .filter((item): item is string => typeof item === "string")
            .map(item => item.trim())
            .filter(Boolean)
            .slice(0, 20);
    }

    if (typeof body.dueAt === "string" && body.dueAt.trim()) {
        const parsed = Date.parse(body.dueAt);
        if (Number.isNaN(parsed)) return { error: "dueAt 不是合法时间" };
        target.dueAt = new Date(parsed).toISOString();
    }

    if (body.meta !== undefined) {
        if (!body.meta || typeof body.meta !== "object" || Array.isArray(body.meta)) {
            return { error: "meta 必须是对象" };
        }
        const meta: Record<string, string> = {};
        for (const [key, value] of Object.entries(body.meta as Record<string, unknown>)) {
            if (typeof value === "string") meta[key] = value;
        }
        target.meta = meta;
    }

    if (typeof body.model === "string" && body.model.trim()) target.model = body.model.trim();

    if (body.mcpServers !== undefined) {
        if (!Array.isArray(body.mcpServers)) return { error: "mcpServers 必须是字符串数组" };
        const servers = body.mcpServers
            .filter((item): item is string => typeof item === "string")
            .map(item => item.trim())
            .filter(Boolean)
            .slice(0, 50);
        // 空数组表示「不用任何 MCP」；undefined 才表示「不限制」，两者语义不同
        target.mcpServers = servers;
    }

    if (typeof body.priority === "number" && Number.isFinite(body.priority)) target.priority = Math.trunc(body.priority);
    const timeoutSec = positiveInt(body.timeoutSec);
    if (timeoutSec) target.timeoutSec = timeoutSec;
    const maxAttempts = positiveInt(body.maxAttempts);
    if (maxAttempts) target.maxAttempts = maxAttempts;
    if (body.freshSession === true) target.freshSession = true;

    return { ok: true };
}

/** 解析并校验创建参数：非法输入在入队前就拒绝，别等执行时才炸。 */
function parseCreateRequest(body: Record<string, unknown>): { input: JobInput; source: string; key?: string } | { error: string } {
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return { error: "prompt 必填" };

    const workspaceRaw = typeof body.workspace === "string" && body.workspace.trim() ? body.workspace.trim() : process.cwd();
    const workspace = path.resolve(expandHomePath(workspaceRaw));
    if (!isDirectory(workspace)) return { error: `工作目录不存在或不是目录: ${workspace}` };

    const input: JobInput = { prompt, workspace };
    const applied = applyInputFields(input, body);
    if ("error" in applied) return applied;

    const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : DEFAULT_SOURCE;
    const key = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim() ? body.idempotencyKey.trim() : undefined;
    return { input, source, ...(key ? { key } : {}) };
}

/**
 * 处理 `/jobs` 下的所有路由；调用方已确认 segments[0] === "jobs"。
 * 返回 Response，不抛错（内部错误转 500）。
 */
export async function handleJobsRoute(
    ctx: JobsApiContext,
    req: Request,
    url: URL,
    segments: string[],
): Promise<Response> {
    try {
        const action = segments[1];

        // 可勾选的 MCP 来源：给「本任务允许哪些 MCP」提供选项，按 server 聚合工具数
        if (action === "mcp" && segments[2] === "servers" && req.method === "GET") {
            const counts = new Map<string, number>();
            for (const tool of toolCatalog.listRemoteTools()) {
                const name = tool.fromServer ?? "unknown";
                counts.set(name, (counts.get(name) ?? 0) + 1);
            }
            // 带上 lazy：前端据此决定"默认选中哪些"（lazy 默认不选）
            const statuses = getMcpServersStatus();
            const known = new Set(statuses.map(item => item.name));
            const list = statuses.map(item => ({
                name: item.name,
                toolCount: counts.get(item.name) ?? 0,
                ...(item.lazy === true ? { lazy: true } : {}),
            }));
            // 目录里存在但状态快照没覆盖的服务兜底列出来，避免"工具有、界面上没有"
            for (const [name, toolCount] of counts) {
                if (!known.has(name)) list.push({ name, toolCount });
            }
            return json(list);
        }

        // 列表状态：/jobs/events 一次性 JSON，/jobs/live 长连接
        // （都必须排在 /jobs/:id 之前，否则 "events"/"live" 会被当成 id）
        if ((action === "events" || action === "live") && req.method === "GET") {
            const cursor = parseSseCursor(req, url);
            if ("error" in cursor) return fail(cursor.error, 400);
            if (action === "events") return json(ctx.store.eventsSince(cursor.since));
            return openSseStream(jobListSource(ctx.store), cursor.since, ctx.heartbeatMs, req.signal);
        }

        if (!action) {
            if (req.method === "GET") {
                const stateParam = url.searchParams.get("state");
                const states = stateParam ? stateParam.split(",").map(item => item.trim()).filter(Boolean) : [];
                const invalid = states.find(item => !isJobState(item));
                if (invalid) return fail(`state 非法: ${invalid}`, 400);

                const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
                const limit = Number.isFinite(rawLimit) && rawLimit > 0
                    ? Math.min(rawLimit, MAX_LIST_LIMIT)
                    : DEFAULT_LIST_LIMIT;
                // 归档的默认不出现在看板上，需要时带 ?archived=1
                const includeArchived = url.searchParams.get("archived") === "1";
                return json(
                    ctx.store.list({ states: states.length ? (states as never) : undefined, limit, includeArchived }),
                );
            }

            if (req.method === "POST") {
                const body = await readJson(req);
                if (!body) return fail("请求体必须是 JSON 对象", 400);

                const parsed = parseCreateRequest(body);
                if ("error" in parsed) return fail(parsed.error, 400);

                const request: CreateJobRequest = { source: parsed.source, input: parsed.input };
                if (parsed.key) request.idempotencyKey = parsed.key;
                if (typeof body.retriedFrom === "string" && body.retriedFrom.trim()) {
                    request.retriedFrom = body.retriedFrom.trim();
                }

                const outcome = ctx.store.create(request);
                // 新建才唤醒调度；幂等命中说明它已在队列里或已结束
                if (outcome.created) ctx.runner.kick();
                return json(outcome.job, outcome.created ? 201 : 200);
            }

            return fail("不支持的方法", 405);
        }

        const jobId = decodeURIComponent(action);
        const sub = segments[2];

        if (!sub && req.method === "GET") {
            const job = ctx.store.get(jobId);
            return job ? json(job) : fail("任务不存在", 404);
        }

        if (!sub && req.method === "PATCH") {
            const body = await readJson(req);
            if (!body) return fail("请求体必须是 JSON 对象", 400);

            const job = ctx.store.get(jobId);
            if (!job) return fail("任务不存在", 404);
            if (job.state === "running" || job.state === "leased") {
                return fail("任务正在执行，先取消或等它结束再改属性", 409);
            }

            const merged: JobInput = { ...job.input };
            const applied = applyInputFields(merged, body);
            if ("error" in applied) return fail(applied.error, 400);
            return json(ctx.store.updateInput(jobId, merged));
        }

        if (sub === "archive" && req.method === "POST") {
            const job = ctx.store.archiveJob(jobId);
            // 归档卡片连带归档会话：会话是资产，只归档不删除
            await applyToBoundSessions(ctx, collectBoundSessionIds(ctx, jobId), id => ctx.host.closeSession(id), "归档");
            return json(job);
        }

        if (sub === "unarchive" && req.method === "POST") {
            return json(ctx.store.unarchiveJob(jobId));
        }

        if (!sub && req.method === "DELETE") {
            const sessionIds = collectBoundSessionIds(ctx, jobId);
            // 删除会话不可逆：有一个还在跑就整体拒绝，避免「卡片没了、会话还在」
            if (sessionIds.some(id => ctx.host.isSessionBusy(id))) {
                return fail("任务名下的会话仍在执行，先取消再删除", 409);
            }
            ctx.store.deleteJob(jobId);
            // 删除卡片连带删除会话（日志、快照、图片资产一并清掉）；卡片已删，失败只记日志
            await applyToBoundSessions(ctx, sessionIds, id => ctx.host.deleteSession(id), "删除");
            return json({ deleted: true, id: jobId });
        }

        if (sub === "move" && req.method === "POST") {
            const body = await readJson(req);
            const column = typeof body?.column === "string" ? body.column : "";
            if (!isBoardColumn(column)) {
                return fail(`column 必须是 ${BOARD_COLUMNS.join(" / ")}`, 400);
            }
            const job = ctx.store.get(jobId);
            if (!job) return fail("任务不存在", 404);
            return moveJob(ctx, job, column);
        }

        // 开始执行：授权调度器领走（新建任务默认停在这里，等用户显式点开始）
        if (sub === "start" && req.method === "POST") {
            const job = ctx.store.get(jobId);
            if (!job) return fail("任务不存在", 404);
            if (job.state !== "queued") {
                return fail(`任务当前是 ${job.state}，只有排队中的任务能开始`, 409);
            }
            const started = ctx.store.updateInput(jobId, { autoStart: true });
            ctx.runner.kick();
            return json(started);
        }

        if (sub === "comments") {
            const job = ctx.store.get(jobId);
            if (!job) return fail("任务不存在", 404);

            const commentId = segments[3] ? decodeURIComponent(segments[3]) : undefined;
            if (!commentId && req.method === "GET") return json(ctx.store.listComments(jobId));

            if (!commentId && req.method === "POST") {
                const body = await readJson(req);
                const text = typeof body?.body === "string" ? body.body.trim() : "";
                if (!text) return fail("body 必填", 400);
                if (text.length > MAX_COMMENT_CHARS) return fail(`评论过长（上限 ${MAX_COMMENT_CHARS} 字）`, 400);
                const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined;
                return json(ctx.store.addComment({ jobId, body: text, author: "user", sessionId }), 201);
            }

            if (commentId && req.method === "PATCH") {
                const body = await readJson(req);
                const text = typeof body?.body === "string" ? body.body.trim() : "";
                if (!text) return fail("body 必填", 400);
                return json(ctx.store.updateComment(jobId, commentId, text));
            }

            if (commentId && req.method === "DELETE") {
                return json(ctx.store.deleteComment(jobId, commentId));
            }

            return fail("不支持的方法", 405);
        }

        if (sub === "sessions") {
            const job = ctx.store.get(jobId);
            if (!job) return fail("任务不存在", 404);

            if (req.method === "GET") {
                // 带上归档态：界面要在列表里区分已归档会话，并提供取消归档
                const archived = new Map(
                    (await ctx.host.listSessions()).map(item => [item.sessionId, item.archived === true]),
                );
                return json(
                    ctx.store.listSessions(jobId).map(item => ({ ...item, archived: archived.get(item.sessionId) === true })),
                );
            }

            if (req.method === "POST") {
                // 手动开一个新会话：同一张卡片下换思路继续，不新建卡片
                const body = await readJson(req);
                const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";

                // 与调度器建会话保持同一口径：勾选的 MCP 直接生效，没勾就把 lazy 服务全加载
                const selection = job.input.mcpServers ?? defaultMcpSelection();
                const created = await ctx.host.createSession(job.input.workspace, {
                    selectedServers: selection,
                    origin: "job",
                });
                const claim = await ctx.host.claimSession(created.sessionId, { noNegotiate: true });
                if (!claim.ok) return fail("会话认领失败，请稍后重试", 409);

                const title = prompt || job.input.title || job.input.prompt;
                await ctx.host.renameSession(created.sessionId, title.slice(0, 40));
                ctx.store.addSession(jobId, created.sessionId, "branch", 0);

                if (prompt) {
                    void ctx.host
                        .sendMessage(created.sessionId, prompt)
                        .catch(error => console.error("[web] 分支会话回合失败:", error));
                }
                return json({ sessionId: created.sessionId }, 201);
            }

            return fail("不支持的方法", 405);
        }

        // 会话的 MCP 选中集：只落事件、下一回合生效（本回合的工具集在回合开始时就快照了）
        if (sub === "mcp-selection") {
            const job = ctx.store.get(jobId);
            if (!job) return fail("任务不存在", 404);
            if (!job.sessionId) return fail("任务尚未开始，暂无执行会话", 409);
            if (req.method === "GET") {
                // initialized=false：该会话还没有选中集（老会话）→ 运行期等于"不限制"，
                // 界面据此回退成"全选"，而不是显示"一个都没选"
                const initialized = readMcpSelection(job.sessionId) !== undefined;
                return json({
                    // 只读接口：已归档的会话也要能查，否则归档后界面连当前选中集都显示不出来
                    servers: await ctx.host.readSessionLazyMcpServers(job.sessionId),
                    initialized,
                });
            }
            if (req.method === "POST") {
                const body = await readJson(req);
                if (!Array.isArray(body?.servers)) return fail("servers 必须是字符串数组", 400);
                const servers = body.servers
                    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
                    .map(item => item.trim());
                const next = [...new Set(servers)].sort();
                // 归档会话不可写：临时取消归档，改完按原状归档回去（用户看到的仍是归档态）
                const archived = await ctx.host.isSessionArchived(job.sessionId);
                if (archived) {
                    if (ctx.host.isSessionBusy(job.sessionId)) return fail("会话执行中，暂不能修改", 409);
                    await ctx.host.unarchiveSession(job.sessionId);
                }
                try {
                    await ctx.host.setSessionLazyMcpServers(job.sessionId, next);
                } finally {
                    if (archived) await ctx.host.closeSession(job.sessionId);
                }
                return json({ servers: next });
            }
            return fail("方法不支持", 405);
        }

        if (sub === "cancel" && req.method === "POST") {
            const cancelled = await ctx.runner.cancel(jobId);
            if (!cancelled) return fail("任务不存在或已结束", 409);
            // 只改任务状态：卡片放在哪一列由用户自己拖，取消不再联动列归属
            return json({ cancelled: true, job: ctx.store.get(jobId) });
        }

        if ((sub === "events" || sub === "live") && req.method === "GET") {
            const job = ctx.store.get(jobId);
            if (!job) return fail("任务不存在", 404);

            // 卡片可以有多个执行会话：默认看最近一个，也可用 sessionId 指定
            const requested = url.searchParams.get("sessionId")?.trim();
            const sessionId = requested || job.sessionId;
            if (!sessionId) return fail("任务尚未开始，暂无执行事件", 404);
            if (requested) {
                const owned = ctx.store.listSessions(jobId).some(item => item.sessionId === requested);
                if (!owned) return fail("该会话不属于此任务", 404);
            }

            const cursor = parseSseCursor(req, url);
            if ("error" in cursor) return fail(cursor.error, 400);
            // 名字区分职责：/events 一次性 JSON，/live 长连接（含实时增量）
            if (sub === "events") {
                // 带 limit 时取尾部一页（首屏与上翻），否则维持全量
                const page = parseEventPage(url);
                if ("error" in page) return fail(page.error, 400);
                if (page.limit !== undefined) {
                    const events = await ctx.host.readSessionEventsBefore(sessionId, page.before, page.limit);
                    return json(toSessionEventViews(events));
                }
                return json(toSessionEventViews(await ctx.host.readSessionEventsSince(sessionId, cursor.since)));
            }
            return openSseStream(
                sessionEventSource(ctx.host, sessionId, jobId),
                cursor.since,
                ctx.heartbeatMs,
                req.signal,
            );
        }

        // 工具参数按需拉取：长参数不进事件响应，用户点开「参数」时再单独取一次
        if (sub === "tool-arguments" && req.method === "GET") {
            const job = ctx.store.get(jobId);
            if (!job) return fail("任务不存在", 404);

            const sessionId = url.searchParams.get("sessionId")?.trim() || job.sessionId;
            if (!sessionId) return fail("任务尚未开始，暂无执行事件", 404);
            if (!ctx.store.listSessions(jobId).some(item => item.sessionId === sessionId)) {
                return fail("该会话不属于此任务", 404);
            }

            const seq = Number(url.searchParams.get("seq"));
            if (!Number.isInteger(seq) || seq <= 0) return fail("seq 无效", 400);
            const callId = url.searchParams.get("callId")?.trim() ?? "";

            // readBefore 会回落到回合边界，可能带出多条：按 seq 取那一条即可
            const event = (await ctx.host.readSessionEventsBefore(sessionId, seq + 1, 1)).at(-1);
            if (!event || event.seq !== seq) return fail("事件不存在", 404);

            const message = (event.payload as { message?: { tool_calls?: any[] } }).message;
            const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
            const call = callId
                ? calls.find(item => item?.id === callId)
                : calls[0];
            if (!call) return fail("工具调用不存在", 404);

            const { name, rawArguments } = readToolCall(call);
            return json({ name, arguments: rawArguments });
        }

        return fail("未知路径", 404);
    } catch (error) {
        if (error instanceof JobNotFoundError) return fail("任务不存在", 404);
        if (error instanceof JobConflictError) return fail(error.message, 409);
        console.error("[web] Job 请求处理失败:", error);
        return fail("服务端内部错误，详见服务端日志", 500);
    }
}
