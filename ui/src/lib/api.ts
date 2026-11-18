import type {
    AgentEvent,
    EventPage,
    ImageAsset,
    Job,
    JobComment,
    JobSession,
    McpServer,
} from "./types";

const STORAGE_KEY = "zbot-token";

type AuthErrorListener = () => void;
const authErrorListeners = new Set<AuthErrorListener>();

/** 订阅 401 鉴权失败通知：任何 REST 或 SSE 收到 401 时立即回到登录页。 */
export function subscribeAuthError(listener: AuthErrorListener): () => void {
    authErrorListeners.add(listener);
    return () => {
        authErrorListeners.delete(listener);
    };
}

function notifyAuthError(): void {
    for (const listener of authErrorListeners) {
        listener();
    }
}

export class ApiError extends Error {
    status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = "ApiError";
        this.status = status;
    }
}

/**
 * 令牌只从 localStorage 读。
 *
 * 不再支持 `/?token=`：URL 会进浏览器缓存、历史记录、Referer 和反代日志，
 * 令牌出现在 URL 里等于泄漏。首次进入用页面上的令牌输入框。
 */
function initToken(): string {
    return localStorage.getItem(STORAGE_KEY) ?? "";
}

let token = initToken();

export function getToken(): string {
    return token;
}

export function saveToken(next: string): void {
    token = next;
    localStorage.setItem(STORAGE_KEY, next);
}

/** 退出登录：内存、localStorage 与缓存的 blob URL 一起清掉，避免泄漏。 */
export function clearToken(): void {
    token = "";
    localStorage.removeItem(STORAGE_KEY);
    for (const url of assetUrls.values()) {
        URL.revokeObjectURL(url);
    }
    assetUrls.clear();
}

async function requestResponse(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(path, {
        ...init,
        headers: {
            authorization: `Bearer ${token}`,
            ...(init.headers ?? {}),
        },
    });
    if (!res.ok) {
        if (res.status === 401) notifyAuthError();
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new ApiError(body.error ?? `HTTP ${res.status}`, res.status);
    }
    return res;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await requestResponse(path, init);
    return (await res.json()) as T;
}

function parseSeqHeader(res: Response, name: string): number | null {
    const raw = res.headers.get(name);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
}

function jsonInit(method: string, body: unknown): RequestInit {
    return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** 服务端推送的实时信号（只包含界面要渲染的东西）。 */
type LiveFrame =
    | { t: "text"; d: string }
    | { t: "think"; on: boolean }
    | { t: "end" };

export interface EventStreamOptions {
    onOpen?(): void;
    /** 连接失败或断开（会自动重连）；`status` 只在服务端明确拒绝时给（如 401 不再重连） */
    onError?(info?: { status?: number }): void;
    /** 普通消息帧（data 为原始字符串） */
    onMessage?(data: string, seq: number): void;
    /** 服务端要求重置时间轴：游标归零，调用方清空已有事件 */
    onReset?(): void;
    /** 实时信号：正在生成的正文 / 是否在思考 / 回合收尾（瞬态，不参与游标） */
    onLive?(frame: LiveFrame): void;
}

/**
 * 带 Authorization 的 SSE 客户端。
 *
 * 原生 EventSource 不能自定义请求头，只能把令牌塞进 URL —— 那会被缓存、写进历史、
 * 带进 Referer。这里用 fetch + ReadableStream 自己解析 SSE 帧，令牌照常走 header。
 * 断线后 1s 重连，用最后一次 `id:` 作 since 游标，语义与 EventSource 的 Last-Event-ID 一致。
 */
export function openEventStream(path: string, since: number, options: EventStreamOptions): { close(): void } {
    let closed = false;
    let cursor = since;
    let controller: AbortController | null = null;

    const dispatch = (frame: string): void => {
        let id = -1;
        let event = "message";
        const data: string[] = [];
        for (const line of frame.split("\n")) {
            if (line.startsWith(":")) continue; // 注释/心跳
            if (line.startsWith("id:")) id = Number(line.slice(3).trim());
            else if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (event === "reset") {
            cursor = 0;
            options.onReset?.();
            return;
        }
        if (event === "live") {
            try {
                options.onLive?.(JSON.parse(data.join("\n")) as LiveFrame);
            } catch {
                // 半帧：忽略即可
            }
            return;
        }
        // 没有 id: 的帧按 SSE 规范沿用上一个 id（服务端所有数据帧都带 id，这里只是兜底）
        if (id >= 0) cursor = Math.max(cursor, id);
        options.onMessage?.(data.join("\n"), id >= 0 ? id : cursor);
    };

    const run = async (): Promise<void> => {
        while (!closed) {
            controller = new AbortController();
            try {
                const url = `${path}${path.includes("?") ? "&" : "?"}since=${cursor}`;
                const res = await fetch(url, {
                    headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
                    signal: controller.signal,
                });
                if (res.status === 401) {
                    notifyAuthError();
                    options.onError?.({ status: 401 });
                    return; // 令牌不对，重连也没用；让上层弹登录框
                }
                if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
                options.onOpen?.();

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                while (!closed) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    let boundary = buffer.indexOf("\n\n");
                    while (boundary >= 0) {
                        dispatch(buffer.slice(0, boundary));
                        buffer = buffer.slice(boundary + 2);
                        boundary = buffer.indexOf("\n\n");
                    }
                }
            } catch {
                // abort 或网络错误：下面统一按断开处理
            }
            if (closed) return;
            options.onError?.();
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    };

    void run();
    return {
        close(): void {
            closed = true;
            controller?.abort();
        },
    };
}

/** 已取回的图片 blob URL：同一张图不重复下载。 */
const assetUrls = new Map<string, string>();

/** 用带 header 的 fetch 取图片，返回 blob URL（`<img>` 不能自带 Authorization）。 */
export async function fetchAssetUrl(id: string): Promise<string | undefined> {
    const cached = assetUrls.get(id);
    if (cached) return cached;
    const res = await fetch(`/api/assets/${encodeURIComponent(id)}`, {
        headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
        notifyAuthError();
        return undefined;
    }
    if (!res.ok) return undefined;
    const url = URL.createObjectURL(await res.blob());
    assetUrls.set(id, url);
    return url;
}

export const api = {
    listJobsWithSeq: async (includeArchived = false): Promise<{ jobs: Job[]; lastSeq: number }> => {
        const res = await requestResponse(`/api/jobs?limit=200${includeArchived ? "&archived=1" : ""}`);
        const jobs = (await res.json()) as Job[];
        const lastSeq = parseSeqHeader(res, "x-job-seq") ?? 0;
        return { jobs, lastSeq };
    },
    getJob: (id: string) => request<Job>(`/api/jobs/${id}`),
    createJob: (body: Record<string, unknown>) => request<Job>("/api/jobs", jsonInit("POST", body)),
    patchJob: (id: string, patch: Record<string, unknown>) =>
        request<Job>(`/api/jobs/${id}`, jsonInit("PATCH", patch)),
    moveJob: (id: string, column: string) =>
        request<Job>(`/api/jobs/${id}/move`, jsonInit("POST", { column })),
    /** 开始执行：授权调度器领走这个排队中的任务。 */
    startJob: (id: string) => request<Job>(`/api/jobs/${id}/start`, { method: "POST" }),
    archiveJob: (id: string) => request<Job>(`/api/jobs/${id}/archive`, { method: "POST" }),
    unarchiveJob: (id: string) => request<Job>(`/api/jobs/${id}/unarchive`, { method: "POST" }),
    deleteJob: (id: string) => request<{ deleted: boolean }>(`/api/jobs/${id}`, { method: "DELETE" }),
    /** 会话的 MCP 选中集：只影响下一个回合 */
    getMcpSelection: (id: string, sessionId?: string) => {
        const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
        return request<{ servers: string[]; initialized: boolean }>(`/api/jobs/${id}/mcp-selection${query}`);
    },
    setMcpSelection: (id: string, servers: string[], sessionId?: string) => {
        const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
        return request<{ servers: string[] }>(
            `/api/jobs/${id}/mcp-selection${query}`,
            jsonInit("POST", { servers, ...(sessionId ? { sessionId } : {}) }),
        );
    },

    listComments: (id: string) => request<JobComment[]>(`/api/jobs/${id}/comments`),
    addComment: (id: string, body: string, sessionId?: string) =>
        request<JobComment>(`/api/jobs/${id}/comments`, jsonInit("POST", { body, sessionId })),
    updateComment: (id: string, commentId: string, body: string) =>
        request<JobComment>(`/api/jobs/${id}/comments/${commentId}`, jsonInit("PATCH", { body })),
    deleteComment: (id: string, commentId: string) =>
        request<JobComment>(`/api/jobs/${id}/comments/${commentId}`, { method: "DELETE" }),

    listSessions: (id: string) => request<JobSession[]>(`/api/jobs/${id}/sessions`),
    createSession: (id: string, prompt?: string) =>
        request<{ sessionId: string }>(`/api/jobs/${id}/sessions`, jsonInit("POST", { prompt })),

    /** 分页拉取历史事件：从响应头读取首尾游标与是否还有更早记录。 */
    listEventPage: async (
        jobId: string,
        sessionId: string,
        options?: { since?: number; limit?: number; before?: number },
    ): Promise<EventPage> => {
        const params = new URLSearchParams({
            sessionId,
            since: String(options?.since ?? 0),
        });
        if (options?.limit !== undefined) params.set("limit", String(options.limit));
        if (options?.before !== undefined) params.set("before", String(options.before));
        const res = await requestResponse(`/api/jobs/${jobId}/events?${params.toString()}`);
        const events = (await res.json()) as AgentEvent[];
        const firstSeq = parseSeqHeader(res, "x-first-seq") ?? (events[0]?.seq ?? 0);
        const lastSeq = parseSeqHeader(res, "x-last-seq") ?? (events.at(-1)?.seq ?? 0);
        const hasMoreHeader = res.headers.get("x-has-more");
        const hasMore = hasMoreHeader !== null
            ? hasMoreHeader === "1"
            : (options?.limit !== undefined ? events.length >= options.limit : false);
        return { events, firstSeq, lastSeq, hasMore };
    },

    /** 长参数不在事件响应里：用户点开某次工具调用时再单独取一次原文。 */
    getToolArguments: (jobId: string, sessionId: string, seq: number, callId?: string) => {
        const query = `sessionId=${encodeURIComponent(sessionId)}&seq=${seq}${callId ? `&callId=${encodeURIComponent(callId)}` : ""}`;
        return request<{ name: string; arguments: string }>(`/api/jobs/${jobId}/tool-arguments?${query}`);
    },

    listMcpServers: () => request<McpServer[]>("/api/jobs/mcp/servers"),

    /** 取服务端信息：新建任务时用 cwd 当输入框 placeholder。 */
    getHealth: () =>
        request<{ ok: boolean; pid: number; cwd: string; home: string; sessions: number }>("/api/healthz"),

    /** 随时输入：空闲直接开跑，忙则按模式排队。 */
    /** 归档会话：等效 TUI 的 /archive（落 session_archived 事件、放弃持有） */
    archiveSession: (sessionId: string) =>
        request<{ sessionId: string; archived: boolean }>(`/api/sessions/${sessionId}/archive`, {
            method: "POST",
        }),
    /** 取消归档：追加 session_unarchived 事件，会话重新可写。 */
    unarchiveSession: (sessionId: string) =>
        request<{ sessionId: string; archived: boolean }>(`/api/sessions/${sessionId}/unarchive`, {
            method: "POST",
        }),
    sendInput: (sessionId: string, text: string, mode: "request" | "turn", images?: ImageAsset[]) =>
        request<{
            started: boolean;
            queued: boolean;
            /** 发送前会话是归档态：服务端已自动取消归档（界面据此刷新会话列表） */
            unarchived?: boolean;
            pending: { request: number; turn: number };
        }>(
            `/api/sessions/${sessionId}/inputs`,
            jsonInit("POST", { text, mode, ...(images?.length ? { images } : {}) }),
        ),
    getPendingInputs: (sessionId: string) =>
        request<{ request: number; turn: number }>(`/api/sessions/${sessionId}/inputs`),

    /** 上传图片：data URL 或纯 base64，落盘后返回引用（发送消息时带上）。 */
    uploadAsset: (data: string, filename: string) =>
        request<{ id: string; path: string; filename: string; mimeType: string; sizeBytes: number }>(
            "/api/assets",
            jsonInit("POST", { data, filename }),
        ),

    /** 目录补全：按输入前缀返回可选的子目录（最多 20 个）。 */
    listDirs: (path: string) => request<string[]>(`/api/fs/dirs?path=${encodeURIComponent(path)}`),
};
