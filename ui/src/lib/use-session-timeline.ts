/**
 * 会话时间线状态管理：分页加载历史、SSE 增量同步、按 seq 去重合并、流式预览与排队计数。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, openEventStream } from "./api";
import type { AgentEvent } from "./types";

/** 时间线一页的事件条数：够铺几屏，又不至于为了首屏把整份日志传下来。 */
const EVENT_PAGE_SIZE = 200;

/** 按 seq 去重并升序合并事件，防止分页边界或重连回放产生重复项。 */
function mergeEvents(current: AgentEvent[], incoming: AgentEvent[]): AgentEvent[] {
    if (incoming.length === 0) return current;
    if (current.length > 0 && incoming.length === 1 && incoming[0]!.seq > current[current.length - 1]!.seq) {
        return [...current, incoming[0]!];
    }
    const bySeq = new Map<number, AgentEvent>();
    for (const event of current) bySeq.set(event.seq, event);
    for (const event of incoming) bySeq.set(event.seq, event);
    return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
}

export function useSessionTimeline(jobId: string, sessionId: string | null) {
    const [events, setEvents] = useState<AgentEvent[]>([]);
    /** 正在发生的回合：正文增量与"是否在思考"（回合收尾或断线即清空，交给持久化消息） */
    const [live, setLive] = useState<{ text: string; thinking: boolean }>({ text: "", thinking: false });
    /** 更早的事件还有没有、是不是正在拉：由服务端响应头精确告知 */
    const [older, setOlder] = useState({ hasMore: false, loading: false });
    const [pending, setPending] = useState({ request: 0, turn: 0 });

    const sessionIdRef = useRef<string | null>(sessionId);
    sessionIdRef.current = sessionId;
    const firstSeqRef = useRef(0);
    const hasMoreRef = useRef(false);
    const loadingOlderRef = useRef(false);
    const oldestSeqRef = useRef(0);
    oldestSeqRef.current = events[0]?.seq ?? 0;
    const generationRef = useRef(0);

    // 切换会话：重置状态，先拉排队数与最近一页历史，再接 SSE 增量流
    useEffect(() => {
        const gen = ++generationRef.current;
        firstSeqRef.current = 0;
        hasMoreRef.current = false;
        loadingOlderRef.current = false;
        setEvents([]);
        setLive({ text: "", thinking: false });
        setOlder({ hasMore: false, loading: false });

        if (!sessionId) {
            setPending({ request: 0, turn: 0 });
            return;
        }

        let cancelled = false;
        let stream: { close(): void } | null = null;
        let hasOpened = false;

        const refreshPending = (): void => {
            void api.getPendingInputs(sessionId)
                .then(stats => {
                    if (!cancelled) setPending(stats);
                })
                .catch(() => undefined);
        };

        refreshPending();

        void (async () => {
            const page = await api
                .listEventPage(jobId, sessionId, { since: 0, limit: EVENT_PAGE_SIZE })
                .catch(() => null);
            if (cancelled || generationRef.current !== gen) return;

            if (page) {
                firstSeqRef.current = page.firstSeq;
                hasMoreRef.current = page.hasMore;
                setEvents(page.events);
                setOlder({ hasMore: page.hasMore, loading: false });
            }

            const since = page ? (page.lastSeq || (page.events.at(-1)?.seq ?? 0)) : 0;

            stream = openEventStream(
                `/api/jobs/${jobId}/live?sessionId=${encodeURIComponent(sessionId)}`,
                since,
                {
                    onOpen: () => {
                        if (cancelled) return;
                        if (hasOpened) refreshPending();
                        hasOpened = true;
                    },
                    onError: () => {
                        if (cancelled) return;
                        setLive({ text: "", thinking: false });
                    },
                    onMessage: (data, seq) => {
                        if (cancelled) return;
                        try {
                            const parsed = JSON.parse(data) as AgentEvent;
                            const normalized: AgentEvent = { ...parsed, seq, sessionId };
                            setEvents(current => mergeEvents(current, [normalized]));

                            const phase = parsed.payload?.phase;
                            if (
                                (parsed.type === "turn_message" && parsed.payload?.message?.role === "assistant")
                                || parsed.type === "turn_commit"
                                || (parsed.type === "steer_update" && (phase === "completed" || phase === "steered"))
                            ) {
                                setLive({ text: "", thinking: false });
                            }

                            if (
                                parsed.type === "user_message"
                                || parsed.type === "steer_update"
                                || parsed.type === "turn_commit"
                            ) {
                                refreshPending();
                            }
                        } catch {
                            // 半帧或未知格式：丢掉一帧即可，不必打断整条时间线
                        }
                    },
                    onReset: () => {
                        if (cancelled) return;
                        firstSeqRef.current = 0;
                        hasMoreRef.current = false;
                        loadingOlderRef.current = false;
                        setEvents([]);
                        setOlder({ hasMore: false, loading: false });
                        setLive({ text: "", thinking: false });
                    },
                    onLive: frame => {
                        if (cancelled) return;
                        if (frame.t === "text") {
                            // 正文开始 = 这轮思考结束，标记同步收掉
                            setLive(current => ({ text: current.text + frame.d, thinking: false }));
                        } else if (frame.t === "think") {
                            setLive(current => ({ ...current, thinking: frame.on }));
                        } else {
                            setLive({ text: "", thinking: false });
                        }
                    },
                },
            );
        })();

        return () => {
            cancelled = true;
            stream?.close();
        };
    }, [jobId, sessionId]);

    /** 上翻一页：插入到已有事件之前；返回是否新增了事件。 */
    const loadOlder = useCallback(async (): Promise<boolean> => {
        const targetSessionId = sessionIdRef.current;
        const targetGen = generationRef.current;
        const before = firstSeqRef.current || oldestSeqRef.current;
        if (!targetSessionId || !before || loadingOlderRef.current || !hasMoreRef.current) return false;

        loadingOlderRef.current = true;
        setOlder(current => ({ ...current, loading: true }));
        try {
            const page = await api.listEventPage(jobId, targetSessionId, {
                since: 0,
                limit: EVENT_PAGE_SIZE,
                before,
            });
            if (sessionIdRef.current !== targetSessionId || generationRef.current !== targetGen) {
                return false;
            }
            if (page.firstSeq > 0) firstSeqRef.current = page.firstSeq;
            hasMoreRef.current = page.hasMore;
            loadingOlderRef.current = false;
            setOlder({ hasMore: page.hasMore, loading: false });
            if (page.events.length > 0) {
                setEvents(current => mergeEvents(page.events, current));
                return true;
            }
            return false;
        } catch {
            if (sessionIdRef.current !== targetSessionId || generationRef.current !== targetGen) {
                return false;
            }
            loadingOlderRef.current = false;
            setOlder(current => ({ ...current, loading: false }));
            return false;
        }
    }, [jobId]);

    return {
        events,
        live,
        older,
        pending,
        setPending,
        loadOlder,
    };
}
