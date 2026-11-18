/**
 * 卡片详情：协调卡片头、属性页（CardPropsPanel）与会话页（SessionPanel）。
 *
 * 订阅全局任务流中属于本卡片的 JobEvent：评论与会话列表变动自动刷新，
 * 首次产生执行会话时自动选中并切到「会话」页。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { formatTime } from "../lib/format";
import type { Job, JobComment, JobEvent, JobSession, McpServer } from "../lib/types";
import { useInlineEdit } from "../lib/use-inline-edit";
import { useNarrow } from "../lib/use-narrow";
import { confirmAction } from "../lib/utils";
import { cn } from "../lib/utils";
import { CardPropsPanel } from "./CardPropsPanel";
import { SessionPanel } from "./SessionPanel";
import { Button, Input, OverflowMenu, Segmented } from "./ui";

type TabKey = "props" | "sessions";

/**
 * 打开卡片时的会话占位：`job.sessionId` 本来就知道，
 * 先用它撑住下拉框、分段计数与输入区，别等网络回来才让界面「长」出来。
 */
function placeholderSessions(job: Job): JobSession[] {
    if (!job.sessionId) return [];
    return [{
        jobId: job.id,
        sessionId: job.sessionId,
        purpose: "run",
        attempt: 1,
        createdAt: "",
    }];
}

export function CardDetail({
    job,
    servers,
    home,
    onChanged,
    onClose,
    subscribeJobEvents,
}: {
    job: Job;
    servers: McpServer[];
    /** 服务端的 home 目录：展示时把前缀缩成 ~ */
    home: string;
    onChanged: () => Promise<unknown>;
    onClose: () => void;
    subscribeJobEvents: (jobId: string, listener: (event: JobEvent) => void) => () => void;
}) {
    /** 默认停在会话：跑过的卡片十次有九次是来看历史的，别再让用户先点一次 tab */
    const [tab, setTab] = useState<TabKey>(() => (job.sessionId ? "sessions" : "props"));
    const narrow = useNarrow();
    const [immersive, setImmersive] = useState(false);

    const [comments, setComments] = useState<JobComment[]>([]);
    const [sessions, setSessions] = useState<JobSession[]>(() => placeholderSessions(job));
    /** 会话列表是否到手：没到手前不显示"还没有执行会话"，免得先空后有 */
    const [sessionsReady, setSessionsReady] = useState(false);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(job.sessionId ?? null);
    const activeSessionIdRef = useRef<string | null>(activeSessionId);
    activeSessionIdRef.current = activeSessionId;

    /** 会话的 MCP 选中集（有执行会话时以它为准）；null = 还没拉/任务尚未开始 */
    const [mcpSelection, setMcpSelection] = useState<string[] | null>(null);
    /** 会话是否已落过选中集：false 时运行期等于"不限制"，界面回退成全选 */
    const [selectionInitialized, setSelectionInitialized] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refreshComments = useCallback(async () => {
        setComments(await api.listComments(job.id).catch(() => []));
    }, [job.id]);

    const refreshSessions = useCallback(async (): Promise<JobSession[] | null> => {
        // 拉失败就保持现状：占位会话是已知事实，别被当成"没有会话"清掉
        const list = await api.listSessions(job.id).catch(() => null);
        if (!list) return null;
        setSessionsReady(true);
        setSessions(list);
        setActiveSessionId(current => {
            if (current && list.some(item => item.sessionId === current)) return current;
            return list.length > 0 ? list[list.length - 1].sessionId : (job.sessionId ?? null);
        });
        return list;
    }, [job.id, job.sessionId]);

    useEffect(() => {
        void refreshComments();
        void refreshSessions();
    }, [refreshComments, refreshSessions]);

    // 拉取当前会话的 MCP 选中集
    const targetMcpSessionId = activeSessionId ?? job.sessionId ?? null;
    useEffect(() => {
        if (!targetMcpSessionId) {
            setMcpSelection(null);
            setSelectionInitialized(false);
            return;
        }
        let cancelled = false;
        void api
            .getMcpSelection(job.id, activeSessionId ?? undefined)
            .then(res => {
                if (cancelled) return;
                setMcpSelection(res.servers);
                setSelectionInitialized(res.initialized);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [job.id, activeSessionId, targetMcpSessionId]);

    // 订阅属于本卡片的 JobEvent：评论与会话自动同步
    useEffect(() => {
        return subscribeJobEvents(job.id, event => {
            if (
                event.type === "comment_added"
                || event.type === "comment_updated"
                || event.type === "comment_deleted"
            ) {
                void refreshComments();
                return;
            }
            if (event.type === "session_added" || event.type === "job_attempt") {
                const hadSession = activeSessionIdRef.current !== null;
                void refreshSessions().then(list => {
                    if (!hadSession && list && list.length > 0) {
                        setTab("sessions");
                    }
                });
            }
        });
    }, [job.id, refreshComments, refreshSessions, subscribeJobEvents]);

    const patch = useCallback(async (body: Record<string, unknown>) => {
        setError(null);
        try {
            await api.patchJob(job.id, body);
            await onChanged();
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : String(cause));
        }
    }, [job.id, onChanged]);

    const titleText = job.input.title || job.input.prompt;
    const titleEdit = useInlineEdit(titleText, next => patch({ title: next }), {
        resetKey: job.id,
        commitOnEnter: true,
    });

    /**
     * 改 MCP 选中集：有执行会话时改会话的（落事件、下个回合生效），
     * 还没跑过就改任务入参，作为首次建会话的初值。
     */
    const applyMcpSelection = useCallback(async (next: string[]) => {
        setError(null);
        if (!activeSessionId && !job.sessionId) {
            await patch({ mcpServers: next });
            return;
        }
        const previous = mcpSelection;
        const previousInit = selectionInitialized;
        setMcpSelection(next); // 乐观更新：网络往返期间不卡手感
        try {
            const saved = await api.setMcpSelection(job.id, next, activeSessionId ?? undefined);
            setMcpSelection(saved.servers);
            setSelectionInitialized(true);
        } catch (cause) {
            setMcpSelection(previous);
            setSelectionInitialized(previousInit);
            setError(cause instanceof ApiError ? cause.message : String(cause));
        }
    }, [activeSessionId, job.id, job.sessionId, mcpSelection, patch, selectionInitialized]);

    const start = async () => {
        // 交给调度器就开始改文件、烧额度，界面上收不回来，先问一句
        if (!confirmAction("开始执行？跑起来就撤不回来了。")) return;
        setError(null);
        try {
            await api.startJob(job.id);
            await onChanged();
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : String(cause));
        }
    };

    /** 在同一个任务下新开会话：换思路继续，不新建卡片。 */
    const openBranch = useCallback(async () => {
        const prompt = window.prompt("在这个新会话里做什么？（留空只建空会话）");
        if (prompt === null) return;
        // 填了内容就等于当场开跑，界面上收不回来；留空建的空会话随便删
        if (prompt.trim() && !confirmAction("会立刻开跑，撤不回来。继续？")) return;
        try {
            const created = await api.createSession(job.id, prompt || undefined);
            setActiveSessionId(created.sessionId);
            setTab("sessions");
            await refreshSessions();
            await onChanged();
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : String(cause));
        }
    }, [job.id, onChanged, refreshSessions]);

    /** 归档执行会话：历史仍保留，只是从默认列表隐藏。 */
    const archiveSession = useCallback(async () => {
        if (!activeSessionId) return;
        if (!confirmAction("归档这个会话？历史仍保留。")) return;
        try {
            await api.archiveSession(activeSessionId);
            // 归档后仍留在列表里（标「已归档」），否则取消归档的入口就没了
            await refreshSessions();
            await onChanged();
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : String(cause));
        }
    }, [activeSessionId, onChanged, refreshSessions]);

    const unarchiveSession = useCallback(async () => {
        if (!activeSessionId) return;
        try {
            await api.unarchiveSession(activeSessionId);
            await refreshSessions();
            await onChanged();
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : String(cause));
        }
    }, [activeSessionId, onChanged, refreshSessions]);

    const isActive = job.state === "running" || job.state === "leased";
    const errorText = job.error ?? error;
    const errorBar = errorText ? <p className="text-xs text-bad">{errorText}</p> : null;

    // 桌面铺成一行按钮，窄屏塞进「⋯」菜单：两处共用同一批动作，免得两套状态机各自演进
    const actionNodes = (
        <>
            {job.state === "queued" && job.input.autoStart !== true && (
                <Button variant="primary" onClick={() => void start()}>
                    开始
                </Button>
            )}
            {!isActive &&
                (job.input.archivedAt ? (
                    <Button
                        title="卡片回到看板（默认列表仍隐藏归档卡片，需要「含归档」才看得到）"
                        onClick={async () => {
                            try {
                                await api.unarchiveJob(job.id);
                                await onChanged();
                            } catch (cause) {
                                setError(cause instanceof ApiError ? cause.message : String(cause));
                            }
                        }}
                    >
                        取消归档
                    </Button>
                ) : (
                    <Button
                        title="卡片从看板隐藏，运行过的会话也一并归档"
                        onClick={async () => {
                            try {
                                await api.archiveJob(job.id);
                                onClose();
                                await onChanged();
                            } catch (cause) {
                                setError(cause instanceof ApiError ? cause.message : String(cause));
                            }
                        }}
                    >
                        归档
                    </Button>
                ))}
            {!isActive && (
                <Button
                    variant="danger"
                    onClick={async () => {
                        if (!confirmAction("删除卡片？评论、执行记录、会话都会一起删除，不可恢复。")) return;
                        try {
                            await api.deleteJob(job.id);
                            onClose();
                            await onChanged();
                        } catch (cause) {
                            setError(cause instanceof ApiError ? cause.message : String(cause));
                        }
                    }}
                >
                    删除
                </Button>
            )}
        </>
    );

    /** 标题：只读是按钮、点击原地变输入框，两个头部布局共用 */
    const titleNode = titleEdit.editing ? (
        <Input
            autoFocus
            value={titleEdit.draft}
            onChange={event => titleEdit.setDraft(event.target.value)}
            {...titleEdit.editorProps}
            // flex-1 让输入框和只读文字占据同一份宽度，否则会把右侧的关闭按钮挤走
            className="h-9 min-w-0 flex-1 font-medium"
        />
    ) : (
        <button
            type="button"
            title={titleText}
            onClick={titleEdit.begin}
            // 盒模型与编辑态的 <Input> 完全一致（含移动端 16px 字号断点）：
            // 切换只换边框颜色，不改变尺寸，下面一行不会跟着上下跳
            className="h-9 min-w-0 flex-1 cursor-text truncate rounded-md border border-transparent px-2.5 text-left text-base font-medium sm:text-sm hover:border-border hover:bg-col"
        >
            {titleText}
        </button>
    );

    /** 属性 / 会话的分段切换：塞进头部，省掉一整行 tab 的高度 */
    const viewSwitch = (
        <Segmented
            options={[
                { key: "props", label: "属性" },
                { key: "sessions", label: "会话", count: sessions.length },
            ]}
            value={tab}
            onChange={setTab}
        />
    );

    return (
        <div
            className="flex h-full flex-col"
            onKeyDown={event => {
                if (event.key !== "Escape") return;
                // 编辑态（描述 / 工作目录 / 评论）的 Esc 已在自己的容器里处理并停掉冒泡；
                // 走到这里说明焦点在普通输入框里——先失焦退出，别让 window 那层 Esc 直接关掉卡片
                const target = event.target as HTMLElement | null;
                const isField = target?.tagName === "INPUT"
                    || target?.tagName === "TEXTAREA"
                    || target?.isContentEditable === true;
                if (!isField) return;
                target!.blur();
                event.stopPropagation();
            }}
        >
            {/* 窄屏：一行完事——标题、属性/会话、⋯、关闭。卡片铺满整屏，纵向空间全给会话历史；
                沉浸态（正在输入）整条让位，把高度让给历史区 */}
            {!immersive && (
                <header className="flex flex-col gap-1 border-b border-border px-2 py-1.5 md:hidden">
                    <div className="flex items-center gap-1">
                        {titleNode}
                        {viewSwitch}
                        <OverflowMenu triggerClassName="h-9">
                            {actionNodes}
                            <div className="mt-0.5 border-t border-border px-2 py-1 text-xs text-muted">
                                #{job.id.slice(-8)} · {formatTime(job.createdAt)}
                            </div>
                        </OverflowMenu>
                        <Button variant="ghost" className="h-9" onClick={onClose} aria-label="关闭">
                            ×
                        </Button>
                    </div>
                    {errorBar}
                </header>
            )}

            {/* 桌面：标题 / 元信息 / 动作三行，宽度够用不必收 */}
            <header className="hidden flex-col gap-2 border-b border-border p-3 md:flex">
                <div className="flex items-center gap-2">
                    {titleNode}
                    {viewSwitch}
                    <Button variant="ghost" className="h-9" onClick={onClose} aria-label="关闭">
                        ×
                    </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span className="font-mono">{job.id.slice(-8)}</span>
                    <span>{formatTime(job.createdAt)}</span>
                    {job.error && <span className="text-bad">{job.error}</span>}
                </div>
                <div className="flex flex-wrap gap-2">{actionNodes}</div>
                {error && <p className="text-xs text-bad">{error}</p>}
            </header>

            {/* 外层只负责给高度：各 tab 自己决定滚动，会话历史才能吃满剩余空间 */}
            <div
                className={cn(
                    "flex min-h-0 flex-1 flex-col overflow-hidden",
                    // 沉浸态没有 header，顶部内边距一起去掉，历史区一直顶到面板上沿
                    immersive ? "px-2 pb-2" : "p-2 md:p-3",
                )}
            >
                {tab === "props" && (
                    <CardPropsPanel
                        job={job}
                        home={home}
                        servers={servers}
                        activeSessionId={activeSessionId}
                        mcpSelection={mcpSelection}
                        selectionInitialized={selectionInitialized}
                        comments={comments}
                        onPatch={patch}
                        onApplyMcp={applyMcpSelection}
                        onRefreshComments={refreshComments}
                        onChanged={onChanged}
                        onError={setError}
                    />
                )}

                <SessionPanel
                    active={tab === "sessions"}
                    jobId={job.id}
                    sessions={sessions}
                    sessionsReady={sessionsReady}
                    activeSessionId={activeSessionId}
                    narrow={narrow}
                    immersive={immersive}
                    errorText={errorText}
                    onSelectSession={setActiveSessionId}
                    onOpenBranch={openBranch}
                    onArchiveSession={archiveSession}
                    onUnarchiveSession={unarchiveSession}
                    onRefreshSessions={refreshSessions}
                    onChanged={onChanged}
                    onError={setError}
                    onImmersiveChange={setImmersive}
                />
            </div>
        </div>
    );
}
