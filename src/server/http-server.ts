/**
 * HTTP 前端：把会话宿主（与可选的 Job 调度）暴露成可编程接口（REST + SSE）。
 *
 * 与 TUI 并列：不 import tui/，只依赖 host 契约与持久化事件的 seq 游标。
 * 事件流推的是持久化事实源（带唯一 seq），瞬态的逐 token 片段不在本接口范围内。
 */

import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeClaimFailure } from "../control/channel.js";
import {
    SessionArchivedError,
    SessionBusyError,
    SessionNotFoundError,
    type SessionEventSource,
    type SessionLifecycle,
    type SessionQuery,
    type SessionTurnHost,
} from "../host/session-host-types.js";
import { handleJobsRoute, type JobsApiContext } from "./jobs-api.js";
import { parseEventPage } from "./page-params.js";
import { enqueueInput, pendingStats, removeInput, takeInputs } from "./pending-inputs.js";
import { fail, json, readJson } from "./respond.js";
import { toLiveEventPayload, toSessionEventView, toSessionEventViews } from "./event-view.js";
import { subscribeLive as subscribeLiveFrames } from "./live-stream.js";
import { openSseStream, parseSseCursor, type SseSource } from "./sse.js";
import { renderUiPage } from "./ui.js";
import { createImageAsset } from "../utils/image-assets.js";
import { getStateDir } from "../utils/runtime-paths.js";
import type { ImageAssetRef } from "../types/image.js";

/** 默认心跳间隔：远小于任何中间层空闲超时，避免长连接被静默掐断。 */
const DEFAULT_HEARTBEAT_MS = 15_000;

/**
 * 空闲超时关闭：SSE 需要无限期驻留，Bun 的 0 表示禁用。
 * 代价是 REST 路由同样失去空闲超时——本服务只绑回环、请求体有上限，可以接受。
 */
const IDLE_TIMEOUT_SECONDS = 0;
/** 单个请求体上限：任务文本与图片引用都不该很大，超过多半是误用。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * HTTP 前端需要的宿主能力：事件流、只读视图、会话生命周期与回合驱动。
 * 宿主运行态（reloadRuntime / close）与会话间投递由进程装配层负责，不在这里暴露。
 */
export type SessionApiHost = SessionEventSource & SessionQuery & SessionLifecycle & SessionTurnHost;

export interface HttpServerOptions {
    host: SessionApiHost;
    /** 监听端口；0 表示由系统分配（测试用）。 */
    port: number;
    /** 监听地址，默认只绑本机回环。 */
    bind?: string;
    /** 访问令牌：所有 /api 请求都必须带 `Authorization: Bearer <token>`。 */
    token: string;
    heartbeatMs?: number;
    /** 传入后启用 /jobs 路由（Job 调度由调用方装配）。 */
    jobs?: JobsApiContext;
}

export interface HttpServerHandle {
    readonly url: string;
    readonly port: number;
    stop(): Promise<void>;
}

/** 定长比较：避免用 `===` 逐字节短路泄露令牌前缀。 */
function safeEqual(left: string, right: string): boolean {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * 只认 `Authorization: Bearer`。
 *
 * 不接受 `?token=`：URL 会被浏览器缓存、写进历史、带进 Referer 与反代日志，
 * 令牌一旦出现在 URL 里就等于泄漏。SSE 与图片都改成带 header 的 fetch 实现。
 */
function isAuthorized(req: Request, token: string): boolean {
    const header = req.headers.get("authorization");
    if (!header?.startsWith("Bearer ")) return false;
    return safeEqual(header.slice("Bearer ".length).trim(), token);
}

/**
 * 宿主可判别错误 → HTTP 状态码。
 * 按类型分流而不是匹配文案：文案属于展示层，改词不该影响协议行为。
 */
function mapHostError(error: unknown): Response | undefined {
    if (error instanceof SessionNotFoundError) return fail("会话不存在", 404);
    if (error instanceof SessionArchivedError) return fail("会话已归档，请先取消归档", 409);
    if (error instanceof SessionBusyError) return fail("会话正在执行中", 409);
    return undefined;
}

/** 图片资源目录：createImageAsset 落盘的位置。 */
function imageAssetDir(): string {
    return getStateDir("assets", "images");
}

const IMAGE_ID_PATTERN = /^img_[a-f0-9]{20}$/;
const IMAGE_MIME_BY_EXT: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
};

/** 按 id 找落盘的图片文件（id 里不含扩展名，需要扫目录匹配）。 */
function findImageAsset(id: string): { path: string; mimeType: string } | undefined {
    const dir = imageAssetDir();
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return undefined;
    }
    const name = names.find(item => item.startsWith(`${id}.`));
    if (!name) return undefined;
    const mimeType = IMAGE_MIME_BY_EXT[path.extname(name).toLowerCase()];
    if (!mimeType) return undefined;
    return { path: path.join(dir, name), mimeType };
}

const DIR_SUGGEST_LIMIT = 20;

/** 展开 `~`，其余按当前工作目录解析。 */
function expandPathInput(input: string): string {
    const trimmed = input.trim();
    if (trimmed === "~") return os.homedir();
    if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
    return path.resolve(trimmed || ".");
}

/**
 * 目录补全：把输入拆成「父目录 + 前缀」，返回匹配的子目录。
 * 只读目录名，不碰文件内容；返回时把 home 前缀缩成 `~`，与用户输入保持一致。
 */
function suggestDirs(rawInput: string): string[] {
    const trimmed = rawInput.trim();
    const endsWithSep = /[\\/]$/.test(trimmed);
    const absolute = expandPathInput(trimmed);
    const base = endsWithSep || trimmed === "~" ? absolute : path.dirname(absolute);
    const prefix = endsWithSep || trimmed === "~" ? "" : path.basename(absolute);

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
        return [];
    }

    const home = os.homedir();
    return entries
        .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
        .map(entry => entry.name)
        .sort()
        .slice(0, DIR_SUGGEST_LIMIT)
        .map(name => {
            const full = path.join(base, name);
            return full === home ? "~" : full.startsWith(`${home}/`) ? `~${full.slice(home.length)}` : full;
        });
}

/** 会话执行事件流：转发某个会话的持久化事件（重置信号原样透传）。 */
function sessionEventSource(host: SessionApiHost, sessionId: string): SseSource {
    return {
        label: `会话 ${sessionId}`,
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

export function startHttpServer(options: HttpServerOptions): HttpServerHandle {
    const { host, port, bind = "127.0.0.1", token, heartbeatMs = DEFAULT_HEARTBEAT_MS, jobs } = options;

    const server = Bun.serve({
        port,
        hostname: bind,
        idleTimeout: IDLE_TIMEOUT_SECONDS,
        maxRequestBodySize: MAX_BODY_BYTES,
        async fetch(req) {
            const url = new URL(req.url);
            const segments = url.pathname.split("/").filter(Boolean);

            // 界面壳不校验令牌：否则没有令牌的人打不开「输入令牌」的页面。
            // 页面本身不含任何数据，数据请求仍要令牌。
            if (segments.length === 0 || segments[0] === "ui") {
                if (req.method !== "GET") return fail("不支持的方法", 405);
                if (!jobs) return fail("Job 接口未启用", 404);
                // 单页内联：没有静态资源、没有构建产物，随 serve 一起分发
                return new Response(renderUiPage(), {
                    headers: {
                        "content-type": "text/html; charset=utf-8",
                        "x-content-type-options": "nosniff",
                        // 界面随 serve 一起分发，重启即换新；没有这个头时浏览器会按启发式
                        // 缓存整页 HTML，重启 serve 后仍显示旧界面，排查时极易误判
                        "cache-control": "no-cache",
                    },
                });
            }

            // 接口统一在 /api 下：界面壳与数据接口在路径上就能分开，代理/反代配置也更简单
            if (segments[0] !== "api") return fail("接口统一在 /api 下", 404);
            const apiPath = segments.slice(1);

            if (!isAuthorized(req, token)) return fail("未授权：缺少或错误的访问令牌", 401);

            const endpoints = [
                "GET  /（Web 界面）",
                "GET  /api（端点清单）",
                "GET  /api/healthz",
                "GET  /api/sessions",
                "POST /api/sessions {cwd?, title?}",
                "GET  /api/sessions/:id",
                "GET  /api/sessions/:id/events?since=<seq>（一次性 JSON）",
                "GET  /api/sessions/:id/events?limit=<n>&before=<seq>（取尾部一页，回落回合边界）",
                "GET  /api/sessions/:id/live?since=<seq>（SSE；data 省略 seq 与 sessionId）",
                "POST /api/sessions/:id/messages {text, wait?}",
                "POST /api/sessions/:id/cancel",
                ...(jobs
                    ? [
                          "GET  /api/jobs?state=&limit=",
                          "POST /api/jobs {prompt, workspace?, idempotencyKey?, priority?, timeoutSec?}",
                          "GET  /api/jobs/:id",
                          "GET  /api/jobs/events?since=<seq>（列表状态流）",
                          "GET  /api/jobs/:id/events?since=<seq>（执行流）",
                          "POST /api/jobs/:id/cancel",
                      ]
                    : []),
            ];

            if (apiPath.length === 0 || apiPath[0] === "endpoints") {
                return json({ name: "zbot serve", prefix: "/api", endpoints });
            }

            if (apiPath[0] === "healthz") {
                if (req.method !== "GET") return fail("不支持的方法", 405);
                return json({
                    ok: true,
                    pid: process.pid,
                    // 新建任务的默认工作目录：TUI_CWD 就是 serve 启动时定的任务基准
                    // （用原始入参而不是 chdir 后的值，macOS 上 /tmp 会被解析成 /private/tmp）
                    cwd: process.env.TUI_CWD ?? process.cwd(),
                    // 界面用它把 home 前缀缩成 ~（只影响展示，数据仍是绝对路径）
                    home: process.env.HOME ?? "",
                    sessions: host.listActiveSessionIds().length,
                    ...(jobs ? { jobs: jobs.runner.stats() } : {}),
                });
            }

            // 图片：上传走 base64，读取由前端 fetch 成 blob（带 Authorization，不用 URL 令牌）
            if (apiPath[0] === "assets") {
                if (req.method === "POST" && !apiPath[1]) {
                    const body = await readJson(req);
                    // 兼容前端直接给 data URL
                    const data = typeof body?.data === "string" ? body.data.replace(/^data:[^;]+;base64,/, "") : "";
                    if (!data) return fail("data 必填（base64）", 400);
                    try {
                        const buffer = Buffer.from(data, "base64");
                        if (buffer.length === 0) return fail("图片内容为空", 400);
                        const filename = typeof body?.filename === "string" && body.filename.trim()
                            ? body.filename.trim()
                            : "paste.png";
                        return json(await createImageAsset(buffer, filename), 201);
                    } catch (error) {
                        return fail((error as Error)?.message ?? "图片保存失败", 400);
                    }
                }
                if (req.method === "GET" && apiPath[1]) {
                    if (!IMAGE_ID_PATTERN.test(apiPath[1])) return fail("非法图片 id", 400);
                    const found = findImageAsset(apiPath[1]);
                    if (!found) return fail("图片不存在", 404);
                    return new Response(fs.readFileSync(found.path), {
                        headers: { "content-type": found.mimeType, "cache-control": "private, max-age=86400" },
                    });
                }
                return fail("不支持的方法", 405);
            }

            // 目录补全：新建任务的工作目录输入框用
            if (apiPath[0] === "fs" && apiPath[1] === "dirs") {
                if (req.method !== "GET") return fail("不支持的方法", 405);
                return json(suggestDirs(url.searchParams.get("path") ?? ""));
            }

            if (apiPath[0] === "jobs") {
                if (!jobs) return fail("Job 接口未启用", 404);
                return handleJobsRoute(jobs, req, url, apiPath);
            }

            if (apiPath[0] !== "sessions") return fail("未知路径", 404);

            try {
                if (apiPath.length === 1) {
                    if (req.method === "GET") return json(await host.listSessions());
                    if (req.method === "POST") {
                        const body = (await readJson(req)) ?? {};
                        const { sessionId } = await host.createSession(
                            typeof body.cwd === "string" ? body.cwd : undefined,
                            { origin: "web" },
                        );
                        if (typeof body.title === "string" && body.title.trim()) {
                            await host.renameSession(sessionId, body.title);
                        }
                        // 认领即成为持有者（bind 控制 socket）：命令行 zbot session send 也能投递。
                        const claim = await host.claimSession(sessionId);
                        if (!claim.ok) return fail(describeClaimFailure(claim), 409);
                        return json({ sessionId }, 201);
                    }
                    return fail("不支持的方法", 405);
                }

                // Bun 会在进入 handler 前拒绝非法百分号编码，这里不再重复校验
                const sessionId = decodeURIComponent(apiPath[1]!);
                const action = apiPath[2];

                if (!action && req.method === "GET") {
                    const summary = (await host.listSessions()).find(item => item.sessionId === sessionId);
                    return summary ? json(summary) : fail("会话不存在", 404);
                }

                // 会话事件：一次性 JSON 用 /events，长连接用 /live —— 名字上就分开
                // /events 支持 ?limit=&before= 取尾部一页（首屏与上翻），不带 limit 则仍是全量
                if (action === "events" && req.method === "GET") {
                    const cursor = parseSseCursor(req, url);
                    if ("error" in cursor) return fail(cursor.error, 400);
                    const page = parseEventPage(url);
                    if ("error" in page) return fail(page.error, 400);
                    if (page.limit !== undefined) {
                        const events = await host.readSessionEventsBefore(sessionId, page.before, page.limit);
                        return json(toSessionEventViews(events));
                    }
                    return json(toSessionEventViews(await host.readSessionEventsSince(sessionId, cursor.since)));
                }

                if (action === "live" && req.method === "GET") {
                    const cursor = parseSseCursor(req, url);
                    if ("error" in cursor) return fail(cursor.error, 400);
                    return openSseStream(
                        sessionEventSource(host, sessionId),
                        cursor.since,
                        heartbeatMs,
                        req.signal,
                    );
                }

                if (action === "messages" && req.method === "POST") {
                    const body = await readJson(req);
                    const text = typeof body?.text === "string" ? body.text.trim() : "";
                    if (!text) return fail("text 必填", 400);
                    if (host.isSessionBusy(sessionId)) return fail("会话正在执行中", 409);

                    // 未持有才认领；被别的实例持有则拒绝，绝不做协商式夺权（那会把会话从对方 TUI 里挤掉）
                    if (!host.isSessionClaimed(sessionId)) {
                        const ownership = await host.probeSession(sessionId);
                        if (ownership.state === "other") {
                            return fail("会话由其他实例持有，请先释放或归档后再投递", 409);
                        }
                        // noNegotiate：即使探测与绑定之间有窗口，也不会协商式夺权
                        const claim = await host.claimSession(sessionId, { noNegotiate: true });
                        if (!claim.ok) {
                            // 用宿主给的说明（含对方 PID），但语义上仍是「被别人持有」
                            return fail(`${describeClaimFailure(claim)}；本接口不做协商式接管`, 409);
                        }
                    }

                    const turn = host.sendMessage(sessionId, text);
                    if (body?.wait !== true) {
                        // 202 只代表已受理：后台失败只落日志
                        turn.catch(error => console.error(`[serve] 会话 ${sessionId} 回合失败:`, error));
                        return json({ accepted: true, sessionId }, 202);
                    }
                    try {
                        const result = await turn;
                        return json({ ok: !result.aborted, aborted: result.aborted === true, sessionId });
                    } catch (error) {
                        // 预检与真正抢锁之间可能有竞态：这里把 busy 收敛成 409，而不是 500
                        const mapped = mapHostError(error);
                        if (mapped) return mapped;
                        throw error;
                    }
                }

                if (action === "cancel" && req.method === "POST") {
                    const cancelled = await host.abortSession(sessionId);
                    return json({ cancelled, sessionId });
                }

                // 归档 / 取消归档：与 TUI 的 /archive 同义（落 session_archived 事件、放弃持有）
                if (action === "archive" && req.method === "POST") {
                    if (host.isSessionBusy(sessionId)) return fail("会话执行中，暂不能归档", 409);
                    await host.closeSession(sessionId);
                    return json({ sessionId, archived: true });
                }

                if (action === "unarchive" && req.method === "POST") {
                    await host.unarchiveSession(sessionId);
                    return json({ sessionId, archived: false });
                }

                // 随时输入：空闲就直接开跑，忙就按模式排队
                if (action === "inputs") {
                    if (req.method === "GET") return json(pendingStats(sessionId));
                    if (req.method === "POST") {
                        const body = await readJson(req);
                        const text = typeof body?.text === "string" ? body.text.trim() : "";
                        if (!text) return fail("text 必填", 400);
                        // request：下一次请求前带上（默认）；turn：等当前回合结束后再开始新一轮
                        const mode = body?.mode === "turn" ? "turn" : "request";
                        const images = Array.isArray(body?.images) ? (body.images as ImageAssetRef[]) : undefined;

                        // 已归档的会话写不进去：用户既然要发消息，就等于要激活它——
                        // 自动取消归档再发送，别让他先去点一次「取消归档」
                        let unarchived = false;
                        if (await host.isSessionArchived(sessionId)) {
                            if (host.isSessionBusy(sessionId)) return fail("会话执行中，暂不能取消归档", 409);
                            await host.unarchiveSession(sessionId);
                            unarchived = true;
                        }

                        if (!host.isSessionBusy(sessionId)) {
                            const turn = host.sendMessage(sessionId, text, {
                                ...(images && images.length > 0 ? { images } : {}),
                                consumePendingMessages: () => takeInputs(sessionId, "request"),
                            });
                            turn.catch(error =>
                                console.error(`[serve] 会话 ${sessionId} 回合失败:`, error),
                            );
                            return json({ started: true, queued: false, mode, unarchived, pending: pendingStats(sessionId) }, 202);
                        }

                        // 排队只存文本：图片引用要跟着具体请求走，混进队列会跨回合串味
                        if (images && images.length > 0) {
                            return fail("当前回合进行中，带图片的消息请等它结束后再发", 409);
                        }
                        const pendingInput = enqueueInput(sessionId, text, mode);
                        if (mode === "request") {
                            void host.steerResponse?.(sessionId, text, () => {
                                if (pendingInput) removeInput(sessionId, pendingInput, mode);
                            }).catch(error => {
                                console.error(`[serve] 会话 ${sessionId} steer 失败，保留待发消息:`, error);
                            });
                        }
                        return json({ started: false, queued: true, mode, unarchived, pending: pendingStats(sessionId) }, 202);
                    }
                    return fail("不支持的方法", 405);
                }

                return fail("未知路径", 404);
            } catch (error) {
                const mapped = mapHostError(error);
                if (mapped) return mapped;
                console.error("[serve] 请求处理失败:", error);
                // 只回通用文案：内部错误信息可能带会话 id、路径等实现细节
                return fail("服务端内部错误，详见服务端日志", 500);
            }
        },
    });

    return {
        url: `http://${bind}:${server.port}`,
        port: server.port,
        stop: async () => {
            await server.stop(true);
        },
    };
}
