/**
 * Job 接口协议测试：真实 JobStore + 真实调度器（不触发执行），只 stub 宿主。
 * 关注校验、幂等语义、状态码与两条事件流的游标。
 */

import { describe, expect, test } from "bun:test";
import type { JobsApiHost } from "./jobs-api.js";
import { JobRunner } from "../jobs/runner.js";
import { JobStore } from "../jobs/store.js";
import { startHttpServer, type HttpServerHandle } from "./http-server.js";

const TOKEN = "job-token";
/** 必须是真实存在的目录：创建任务时会被校验。 */
const WORKSPACE = process.cwd();

/** 宿主侧的会话处置记录：谁被归档、谁被删除。 */
interface HostState {
    archived: string[];
    deleted: string[];
    /** /events?limit= 分页请求参数：验证接口把尾页语义传给了宿主。 */
    pages: Array<{ sessionId: string; before: number; count: number }>;
    /** listSessions 的返回值：由用例决定谁处于归档态。 */
    summaries: Array<{ sessionId: string; archived: boolean }>;
    /** 会话写操作的调用顺序：验证「取消归档 → 改 → 归档回去」的时序。 */
    calls: string[];
}

/** archived/deleted 收集会话处置结果；isBusy 模拟「会话正在跑一轮」。 */
function stubHost(
    state: HostState = { archived: [], deleted: [], pages: [], summaries: [], calls: [] },
    isBusy = false,
): JobsApiHost {
    return {
        listActiveSessionIds: () => [],
        createSession: async () => ({ sessionId: "s-1" }),
        claimSession: async () => ({ ok: true }),
        isSessionClaimed: () => true,
        renameSession: async () => {},
        sendMessage: async () => ({}),
        abortSession: async () => true,
        isSessionBusy: () => isBusy,
        isSessionArchived: async (sessionId: string) =>
            state.summaries.find(item => item.sessionId === sessionId)?.archived === true,
        listSessions: async () => state.summaries,
        unarchiveSession: async () => {
            state.calls.push("unarchive");
        },
        setSessionLazyMcpServers: async () => {
            state.calls.push("set");
        },
        readSessionLazyMcpServers: async () => {
            state.calls.push("read");
            return [];
        },
        getSessionLazyMcpServers: async () => [],
        closeSession: async (sessionId: string) => {
            state.calls.push("close");
            state.archived.push(sessionId);
        },
        deleteSession: async (sessionId: string) => {
            state.deleted.push(sessionId);
        },
        readSessionEventsSince: async () => [],
        readSessionEventsBefore: async (sessionId: string, before: number, count: number) => {
            state.pages.push({ sessionId, before, count });
            return [];
        },
        subscribeEvents: () => () => {},
    } as unknown as JobsApiHost;
}

function web(options: { isBusy?: boolean } = {}): {
    handle: HttpServerHandle;
    store: JobStore;
    runner: JobRunner;
    archived: string[];
    deleted: string[];
    pages: Array<{ sessionId: string; before: number; count: number }>;
    summaries: Array<{ sessionId: string; archived: boolean }>;
    calls: string[];
} {
    const state: HostState = { archived: [], deleted: [], pages: [], summaries: [], calls: [] };
    const store = new JobStore({ path: ":memory:" });
    const runner = new JobRunner({ store, host: stubHost(state), owner: "w1", tickMs: 60_000 });
    const handle = startHttpServer({
        host: stubHost(state),
        port: 0,
        token: TOKEN,
        heartbeatMs: 60_000,
        jobs: { store, runner, host: stubHost(state, options.isBusy), heartbeatMs: 60_000 },
    });
    return {
        handle,
        store,
        runner,
        archived: state.archived,
        deleted: state.deleted,
        pages: state.pages,
        summaries: state.summaries,
        calls: state.calls,
    };
}

async function call(handle: HttpServerHandle, path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${handle.url}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    });
}

function postBody(body: unknown): RequestInit {
    return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("jobs API 创建", () => {

    test("创建只入队不执行，点「开始」才授权调度", async () => {
        const { handle, store } = web();
        try {
            const res = await call(handle, "/api/jobs", postBody({ prompt: "跑测试", workspace: WORKSPACE }));
            const job = await res.json() as { id: string; state: string; input: { autoStart?: boolean } };
            expect(job.input.autoStart).toBe(false);
            expect(store.claimNext("w1", 30_000, new Set())).toBeUndefined();

            const started = await call(handle, `/api/jobs/${job.id}/start`, { method: "POST" });
            expect(started.status).toBe(200);
            const after = await started.json() as { input: { autoStart?: boolean } };
            expect(after.input.autoStart).toBe(true);
        } finally {
            await handle.stop();
        }
    });

    test("拖动卡片不会替用户点「开始」", async () => {
        const { handle, store } = web();
        try {
            const { job } = store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } });
            expect(store.get(job.id)?.input.autoStart).toBe(false);

            await call(handle, `/api/jobs/${job.id}/move`, postBody({ column: "doing" }));

            expect(store.get(job.id)?.input.autoStart).toBe(false);
            expect(store.claimNext("w1", 30_000, new Set())).toBeUndefined();
        } finally {
            await handle.stop();
        }
    });

    test("PATCH 可以改工作目录：目录必须存在，只影响之后的会话", async () => {
        const { handle, store } = web();
        try {
            const { job } = store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } });

            const patched = await call(handle, `/api/jobs/${job.id}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ workspace: process.cwd() }),
            });
            expect(patched.status).toBe(200);
            expect((await patched.json() as { input: { workspace: string } }).input.workspace).toBe(process.cwd());

            const bad = await call(handle, `/api/jobs/${job.id}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ workspace: "/no/such/dir/at/all" }),
            });
            expect(bad.status).toBe(400);
            // 校验失败不能落库半截
            expect(store.get(job.id)?.input.workspace).toBe(WORKSPACE);
        } finally {
            await handle.stop();
        }
    });

    test("创建返回 201 与 queued 任务", async () => {
        const { handle } = web();
        try {
            const res = await call(handle, "/api/jobs", postBody({ prompt: "跑测试", workspace: WORKSPACE }));
            const job = await res.json() as { id: string; state: string; input: { prompt: string } };

            expect(res.status).toBe(201);
            expect(job.state).toBe("queued");
            expect(job.input.prompt).toBe("跑测试");
        } finally {
            await handle.stop();
        }
    });

    test("同 idempotencyKey 第二次返回 200 且是同一个任务", async () => {
        const { handle } = web();
        try {
            const first = await call(handle, "/api/jobs", postBody({ prompt: "跑测试", workspace: WORKSPACE, idempotencyKey: "k1" }));
            const second = await call(handle, "/api/jobs", postBody({ prompt: "跑测试", workspace: WORKSPACE, idempotencyKey: "k1" }));
            const firstJob = await first.json() as { id: string };
            const secondJob = await second.json() as { id: string };

            expect(first.status).toBe(201);
            expect(second.status).toBe(200);
            expect(secondJob.id).toBe(firstJob.id);
        } finally {
            await handle.stop();
        }
    });

    test("prompt 缺失 400，工作目录不存在 400", async () => {
        const { handle } = web();
        try {
            const noPrompt = await call(handle, "/api/jobs", postBody({ workspace: WORKSPACE }));
            expect(noPrompt.status).toBe(400);
            expect((await noPrompt.json() as { error: string }).error).toContain("prompt");

            const badWorkspace = await call(
                handle,
                "/api/jobs",
                postBody({ prompt: "跑测试", workspace: "/no/such/dir/for/zbot" }),
            );
            expect(badWorkspace.status).toBe(400);
            expect((await badWorkspace.json() as { error: string }).error).toContain("工作目录");
        } finally {
            await handle.stop();
        }
    });
});

describe("jobs API 查询与取消", () => {
    test("拖拽只改卡片所在列，不碰任务状态", async () => {
        const { handle, store } = web();
        try {
            const job = store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } }).job;

            // 拖到已完成：任务仍是 queued（跑不跑、什么时候跑由调度器决定）
            const toDone = await call(handle, `/api/jobs/${job.id}/move`, postBody({ column: "done" }));
            expect(toDone.status).toBe(200);
            expect(store.get(job.id)?.input.column).toBe("done");
            expect(store.get(job.id)?.state).toBe("queued");

            // 已移除的列与乱填的列都是 400，不静默成功
            for (const column of ["manual", "review", "nope"]) {
                expect((await call(handle, `/api/jobs/${job.id}/move`, postBody({ column }))).status).toBe(400);
            }
        } finally {
            await handle.stop();
        }
    });

    test("拖到「已取消」列只是挪卡片，不取消任务", async () => {
        const { handle, store } = web();
        try {
            const job = store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } }).job;

            const res = await call(handle, `/api/jobs/${job.id}/move`, postBody({ column: "cancelled" }));

            expect(res.status).toBe(200);
            expect(store.get(job.id)?.input.column).toBe("cancelled");
            // 列只是摆放位置：任务仍在排队，跑不跑由状态决定
            expect(store.get(job.id)?.state).toBe("queued");
        } finally {
            await handle.stop();
        }
    });

    test("cancel 端点只改状态，不挪卡片", async () => {
        const { handle, store } = web();
        try {
            const job = store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } }).job;
            store.updateInput(job.id, { column: "doing" });

            const res = await call(handle, `/api/jobs/${job.id}/cancel`, { method: "POST" });
            const body = await res.json() as { cancelled: boolean; job: { input: { column?: string } } };

            expect(res.status).toBe(200);
            expect(store.get(job.id)?.state).toBe("cancelled");
            // 取消不再联动列归属
            expect(body.job.input.column).toBe("doing");
            expect(store.get(job.id)?.input.column).toBe("doing");
        } finally {
            await handle.stop();
        }
    });

    test("列表按状态过滤，未知状态 400", async () => {
        const { handle, store } = web();
        try {
            store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } });
            const queued = await call(handle, "/api/jobs?state=queued");
            const list = await queued.json() as unknown[];
            expect(list.length).toBe(1);

            expect((await call(handle, "/api/jobs?state=nope")).status).toBe(400);
        } finally {
            await handle.stop();
        }
    });

    test("查不存在的任务 404", async () => {
        const { handle } = web();
        try {
            expect((await call(handle, "/api/jobs/nope")).status).toBe(404);
        } finally {
            await handle.stop();
        }
    });

    test("取消排队任务后状态变 cancelled；重复取消 409", async () => {
        const { handle, store } = web();
        try {
            const job = store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } }).job;

            const cancelled = await call(handle, `/api/jobs/${job.id}/cancel`, { method: "POST" });
            expect(cancelled.status).toBe(200);
            expect(store.get(job.id)?.state).toBe("cancelled");

            expect((await call(handle, `/api/jobs/${job.id}/cancel`, { method: "POST" })).status).toBe(409);
        } finally {
            await handle.stop();
        }
    });
});

describe("jobs API 事件流", () => {
    test("列表状态：events 出 JSON、stream 出 SSE", async () => {
        const { handle, store } = web();
        try {
            const job = store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } }).job;
            const all = await call(handle, "/api/jobs/events?since=0");
            const events = await all.json() as Array<{ seq: number; type: string }>;

            expect(events.map(event => event.type)).toEqual(["job_created"]);

            const tail = await call(handle, `/api/jobs/events?since=${events[0]!.seq}&format=json`);
            expect(await tail.json()).toEqual([]);

            // 详情流在任务尚未开始时明确报 404，而不是空流
            expect((await call(handle, `/api/jobs/${job.id}/events?since=0`)).status).toBe(404);
        } finally {
            await handle.stop();
        }
    });

    test("详情流在任务绑定会话后可读（format=json）", async () => {
        const { handle, store } = web();
        try {
            const job = store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } }).job;
            store.attachSession(job.id, "s-1");

            const res = await call(handle, `/api/jobs/${job.id}/events?since=0&format=json`);
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual([]);
        } finally {
            await handle.stop();
        }
    });
});

describe("jobs API 其它端点", () => {

    test("已归档会话改 MCP 选中集：先取消归档，改完再归档回去", async () => {
        const { handle, store, summaries, calls } = web();
        try {
            const { job } = store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } });
            store.attachSession(job.id, "s-run");
            summaries.push({ sessionId: "s-run", archived: true });

            const res = await call(handle, `/api/jobs/${job.id}/mcp-selection`, postBody({ servers: ["b", "a", "a"] }));

            expect(res.status).toBe(200);
            // 去重 + 排序后再落盘，返回的就是最终生效的集合
            expect(await res.json()).toEqual({ servers: ["a", "b"] });
            expect(calls).toEqual(["unarchive", "set", "close"]);
        } finally {
            await handle.stop();
        }
    });

    test("未归档会话改 MCP 选中集不碰归档态", async () => {
        const { handle, store, calls } = web();
        try {
            const { job } = store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } });
            store.attachSession(job.id, "s-run");

            const res = await call(handle, `/api/jobs/${job.id}/mcp-selection`, postBody({ servers: ["a"] }));

            expect(res.status).toBe(200);
            expect(calls).toEqual(["set"]);
        } finally {
            await handle.stop();
        }
    });

    test("会话列表带上归档态（归档的会话仍留在列表里）", async () => {
        const { handle, store, summaries } = web();
        try {
            const { job } = store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } });
            store.addSession(job.id, "s-run", "run", 1);
            store.addSession(job.id, "s-branch", "branch", 0);
            summaries.push({ sessionId: "s-branch", archived: true });

            const res = await call(handle, `/api/jobs/${job.id}/sessions`);
            const list = await res.json() as Array<{ sessionId: string; archived: boolean }>;

            expect(list.map(item => [item.sessionId, item.archived])).toEqual([
                ["s-run", false],
                ["s-branch", true],
            ]);
        } finally {
            await handle.stop();
        }
    });

    test("归档卡片连带归档它名下的会话", async () => {
        const { handle, store, archived } = web();
        try {
            const { job } = store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } });
            store.addSession(job.id, "s-attempt", "attempt", 1);
            store.addSession(job.id, "s-branch", "branch", 0);

            const res = await call(handle, `/api/jobs/${job.id}/archive`, { method: "POST" });
            expect(res.status).toBe(200);
            expect(archived.sort()).toEqual(["s-attempt", "s-branch"]);
        } finally {
            await handle.stop();
        }
    });

    test("删除卡片连带删除它名下的会话", async () => {
        const { handle, store, archived, deleted } = web();
        try {
            const { job } = store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } });
            store.addSession(job.id, "s-attempt", "attempt", 1);
            store.addSession(job.id, "s-branch", "branch", 0);

            const res = await call(handle, `/api/jobs/${job.id}`, { method: "DELETE" });
            expect(res.status).toBe(200);
            expect(deleted.sort()).toEqual(["s-attempt", "s-branch"]);
            expect(archived).toEqual([]);
            expect(store.get(job.id)).toBeUndefined();
        } finally {
            await handle.stop();
        }
    });

    test("会话正在执行时卡片照常归档，只是跳过该会话", async () => {
        const { handle, store, archived } = web({ isBusy: true });
        try {
            const { job } = store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } });
            store.addSession(job.id, "s-busy", "attempt", 1);

            const res = await call(handle, `/api/jobs/${job.id}/archive`, { method: "POST" });
            expect(res.status).toBe(200);
            expect(archived).toEqual([]);
        } finally {
            await handle.stop();
        }
    });

    test("会话正在执行时拒绝删除卡片（不可逆操作不半途而废）", async () => {
        const { handle, store, deleted } = web({ isBusy: true });
        try {
            const { job } = store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } });
            store.addSession(job.id, "s-busy", "attempt", 1);

            const res = await call(handle, `/api/jobs/${job.id}`, { method: "DELETE" });
            expect(res.status).toBe(409);
            expect(deleted).toEqual([]);
            expect(store.get(job.id)).toBeDefined();
        } finally {
            await handle.stop();
        }
    });

    test("/events?limit= 取尾部一页，把 before 与条数交给宿主", async () => {
        const { handle, store, pages } = web();
        try {
            const { job } = store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } });
            store.attachSession(job.id, "s-run");

            const res = await call(handle, `/api/jobs/${job.id}/events?limit=2&before=99`);
            expect(res.status).toBe(200);
            expect(pages).toEqual([{ sessionId: "s-run", before: 99, count: 2 }]);
        } finally {
            await handle.stop();
        }
    });

    test("/events 的 limit 缺省时保持全量语义；非法值报 400", async () => {
        const { handle, store, pages } = web();
        try {
            const { job } = store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } });
            store.attachSession(job.id, "s-run");

            const all = await call(handle, `/api/jobs/${job.id}/events`);
            expect(all.status).toBe(200);
            expect(pages).toEqual([]);

            for (const query of ["limit=0", "limit=abc", "limit=2&before=-1"]) {
                expect((await call(handle, `/api/jobs/${job.id}/events?${query}`)).status).toBe(400);
            }
        } finally {
            await handle.stop();
        }
    });

    test("healthz 带上队列统计", async () => {
        const { handle, store } = web();
        try {
            store.create({ source: "t", input: { prompt: "a", workspace: WORKSPACE } });
            const res = await call(handle, "/api/healthz");
            const body = await res.json() as { jobs: { queued: number; running: number } };

            expect(body.jobs.queued).toBe(1);
            expect(body.jobs.running).toBe(0);
        } finally {
            await handle.stop();
        }
    });

    test("根路径返回界面 HTML，且不需要令牌（否则无法输入令牌）", async () => {
        const { handle } = web();
        try {
            const res = await fetch(`${handle.url}/`);
            expect(res.status).toBe(200);
            expect(res.headers.get("content-type")).toContain("text/html");
            // 不缓存：否则重启 web 后浏览器仍按旧 HTML 渲染，看上去像"改动没生效"
            expect(res.headers.get("cache-control")).toBe("no-cache");
            expect(await res.text()).toContain("<title>zbot 任务</title>");

            // /ui 保留为别名
            expect((await fetch(`${handle.url}/ui`)).status).toBe(200);
        } finally {
            await handle.stop();
        }
    });

    test("界面壳公开，但数据接口仍要令牌", async () => {
        const { handle } = web();
        try {
            expect((await fetch(`${handle.url}/api/jobs`)).status).toBe(401);
            expect((await fetch(`${handle.url}/api/endpoints`)).status).toBe(401);
            expect((await call(handle, "/api/endpoints")).status).toBe(200);
        } finally {
            await handle.stop();
        }
    });
});
