/**
 * 看板全局状态与 /api/jobs/live 事件流同步。
 *
 * 将「静态引导（healthz / mcp servers）」「看板列表拉取（按 requestSeq 防乱序）」
 * 与「长连接 SSE（仅依赖 authorized，不随含归档切换重连）」拆开，
 * 并按 jobId 分发事件给已打开的卡片详情，避免评论类事件触发全量列表重拉。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, openEventStream } from "./api";
import type { Job, JobEvent, JobEventType, McpServer } from "./types";

/** 事件流状态：还没连上不算异常，只有连上又断了才值得报红 */
export type ConnState = "connecting" | "live" | "down";

const BOARD_REFRESH_EVENTS = new Set<JobEventType>([
    "job_created",
    "job_state",
    "job_attempt",
    "job_updated",
    "session_added",
]);

const BOARD_REFRESH_DEBOUNCE_MS = 150;

export function useBoardStore(authorized: boolean) {
    const [jobs, setJobs] = useState<Job[]>([]);
    const [servers, setServers] = useState<McpServer[]>([]);
    const [defaultCwd, setDefaultCwd] = useState("");
    const [home, setHome] = useState("");
    const [showArchived, setShowArchived] = useState(false);
    const [conn, setConn] = useState<ConnState>("connecting");
    const [error, setError] = useState<string | null>(null);

    const showArchivedRef = useRef(showArchived);
    showArchivedRef.current = showArchived;
    const requestSeqRef = useRef(0);
    const jobListenersRef = useRef(new Map<string, Set<(event: JobEvent) => void>>());

    const refresh = useCallback(async (includeArchived = showArchivedRef.current): Promise<{ jobs: Job[]; lastSeq: number } | null> => {
        if (!authorized) return null;
        const reqSeq = ++requestSeqRef.current;
        try {
            const page = await api.listJobsWithSeq(includeArchived);
            if (reqSeq !== requestSeqRef.current) return null;
            setJobs(page.jobs);
            setError(null);
            return page;
        } catch (cause) {
            if (reqSeq !== requestSeqRef.current) return null;
            if (!(cause instanceof ApiError && cause.status === 401)) {
                setError(cause instanceof Error ? cause.message : String(cause));
            }
            return null;
        }
    }, [authorized]);

    // 静态引导：仅在鉴权生效后拉一次，切换「含归档」不重拉
    useEffect(() => {
        if (!authorized) {
            setServers([]);
            setDefaultCwd("");
            setHome("");
            return;
        }
        let cancelled = false;
        void api.getHealth()
            .then(health => {
                if (cancelled) return;
                setDefaultCwd(health.cwd);
                setHome(health.home);
            })
            .catch(() => undefined);
        void api.listMcpServers()
            .then(list => {
                if (cancelled) return;
                setServers(list);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [authorized]);

    // 切换「含归档」只刷新看板列表，不重建 SSE
    const prevShowArchivedRef = useRef(showArchived);
    useEffect(() => {
        if (!authorized) {
            prevShowArchivedRef.current = showArchived;
            return;
        }
        if (prevShowArchivedRef.current === showArchived) return;
        prevShowArchivedRef.current = showArchived;
        void refresh(showArchived);
    }, [authorized, showArchived, refresh]);

    // 全局任务事件流：仅依赖 authorized；初始游标取自首次 listJobsWithSeq 的 x-job-seq
    useEffect(() => {
        if (!authorized) {
            requestSeqRef.current += 1;
            setJobs([]);
            setError(null);
            setConn("connecting");
            return;
        }

        let cancelled = false;
        let stream: { close(): void } | null = null;
        let refreshTimer: ReturnType<typeof setTimeout> | null = null;
        let wasDown = false;
        setConn("connecting");

        const scheduleRefresh = (): void => {
            if (refreshTimer) clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => {
                refreshTimer = null;
                void refresh(showArchivedRef.current);
            }, BOARD_REFRESH_DEBOUNCE_MS);
        };

        void (async () => {
            const initial = await refresh(showArchivedRef.current);
            if (cancelled) return;
            const since = initial?.lastSeq ?? 0;

            stream = openEventStream("/api/jobs/live", since, {
                onOpen: () => {
                    if (cancelled) return;
                    setConn("live");
                    if (wasDown) {
                        wasDown = false;
                        void refresh(showArchivedRef.current);
                    }
                },
                onError: info => {
                    if (cancelled || info?.status === 401) return;
                    wasDown = true;
                    setConn("down");
                },
                onReset: () => {
                    if (cancelled) return;
                    void refresh(showArchivedRef.current);
                },
                onMessage: data => {
                    if (cancelled) return;
                    let event: JobEvent;
                    try {
                        event = JSON.parse(data) as JobEvent;
                    } catch {
                        return;
                    }
                    if (!event || typeof event.jobId !== "string" || typeof event.type !== "string") return;

                    const listeners = jobListenersRef.current.get(event.jobId);
                    if (listeners) {
                        for (const listener of listeners) {
                            listener(event);
                        }
                    }

                    if (BOARD_REFRESH_EVENTS.has(event.type)) {
                        scheduleRefresh();
                    }
                },
            });
        })();

        return () => {
            cancelled = true;
            stream?.close();
            if (refreshTimer) clearTimeout(refreshTimer);
        };
    }, [authorized, refresh]);

    const subscribeJobEvents = useCallback(
        (jobId: string, listener: (event: JobEvent) => void): (() => void) => {
            let set = jobListenersRef.current.get(jobId);
            if (!set) {
                set = new Set();
                jobListenersRef.current.set(jobId, set);
            }
            set.add(listener);
            return () => {
                const current = jobListenersRef.current.get(jobId);
                if (!current) return;
                current.delete(listener);
                if (current.size === 0) {
                    jobListenersRef.current.delete(jobId);
                }
            };
        },
        [],
    );

    return {
        jobs,
        setJobs,
        servers,
        defaultCwd,
        home,
        showArchived,
        setShowArchived,
        conn,
        error,
        setError,
        refresh,
        subscribeJobEvents,
    };
}
