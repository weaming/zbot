/**
 * 卡片「会话」标签页：会话切换与分支/归档菜单、可滚动时间线、以及隔离的输入编辑器。
 *
 * 将输入草稿与附件状态隔离在 SessionComposer 内部，避免打字时重渲染时间线与整张卡片。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { formatShortTime } from "../lib/format";
import type { ImageAsset, JobSession } from "../lib/types";
import { useSessionTimeline } from "../lib/use-session-timeline";
import { useTimelineScroll } from "../lib/use-timeline-scroll";
import { cn } from "../lib/utils";
import { AssetImage } from "./AssetImage";
import { Timeline } from "./Timeline";
import { Button, OverflowMenu, Textarea } from "./ui";

/** 会话下拉的选项文案：窄屏只留「#短 id · 用途」，时间挤不下就算了。 */
function sessionOptionLabel(item: JobSession, narrow: boolean): string {
    const head = `#${item.sessionId.slice(-8)} · ${item.purpose === "branch" ? "分支" : "执行"}`;
    const archived = item.archived ? " · 已归档" : "";
    if (narrow) return `${head}${archived}`;
    const time = formatShortTime(item.createdAt);
    return time ? `${head} · ${time}${archived}` : `${head}${archived}`;
}

function SessionComposer({
    active,
    sessionId,
    archived,
    pending,
    narrow,
    errorText,
    onImmersiveChange,
    onPendingChange,
    onUnarchived,
    onUnarchiveSession,
    onChanged,
    onError,
}: {
    active: boolean;
    sessionId: string;
    archived: boolean;
    pending: { request: number; turn: number };
    narrow: boolean;
    errorText: string | null;
    onImmersiveChange: (immersive: boolean) => void;
    onPendingChange: (pending: { request: number; turn: number }) => void;
    onUnarchived: () => Promise<void>;
    onUnarchiveSession: () => Promise<void>;
    onChanged: () => Promise<unknown>;
    onError: (message: string | null) => void;
}) {
    const [inputDraft, setInputDraft] = useState("");
    /** 窄屏下底部输入区是否展开：不聚焦时收成一行，把高度让给历史 */
    const [composerFocus, setComposerFocus] = useState(false);
    const [attachments, setAttachments] = useState<ImageAsset[]>([]);
    const [uploading, setUploading] = useState(false);
    const composerRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const composerExpanded = !narrow || composerFocus || attachments.length > 0;
    const immersive = active && narrow && composerExpanded;

    useEffect(() => {
        onImmersiveChange(immersive);
    }, [immersive, onImmersiveChange]);

    useEffect(() => () => onImmersiveChange(false), [onImmersiveChange]);

    /**
     * 向当前会话随时输入。两种「切入时机」用按钮表达：
     * request = 下一次请求前带上（默认），turn = 等当前对话结束后再开始。
     */
    const sendInput = async (mode: "request" | "turn" = "request") => {
        const text = inputDraft.trim();
        if (!text) return;
        onError(null);
        try {
            const result = await api.sendInput(sessionId, text, mode, attachments);
            setInputDraft("");
            setAttachments([]);
            onPendingChange(result.pending);
            // 归档会话发送时服务端会自动取消归档：把「已归档」标记刷掉
            if (result.unarchived) await onUnarchived();
            await onChanged();
        } catch (cause) {
            onError(cause instanceof ApiError ? cause.message : String(cause));
        }
    };

    /** 选图/粘贴都走这里：先落到服务端资产目录，拿到引用再随消息发送。 */
    const uploadImage = async (file: File) => {
        if (!file.type.startsWith("image/")) {
            onError("只支持图片文件");
            return;
        }
        setUploading(true);
        onError(null);
        try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result ?? ""));
                reader.onerror = () => reject(new Error("读取图片失败"));
                reader.readAsDataURL(file);
            });
            const asset = await api.uploadAsset(dataUrl, file.name || "paste.png");
            setAttachments(current => [...current, asset]);
        } catch (cause) {
            onError(cause instanceof ApiError ? cause.message : String(cause));
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="flex shrink-0 flex-col gap-2 border-t border-border pt-2">
            {immersive && errorText && <p className="text-xs text-bad">{errorText}</p>}
            <div className={cn("flex gap-1.5", composerExpanded ? "flex-col" : "items-end")}>
                <Textarea
                    ref={composerRef}
                    rows={composerExpanded ? 3 : 1}
                    // 收起态压成一行：标签页里的历史能多露出两三行；一行的高度没什么可拖的
                    className={composerExpanded ? undefined : "min-h-0 resize-none py-1.5"}
                    value={inputDraft}
                    placeholder="你的创意灵感（可直接粘贴图片）"
                    onFocus={() => setComposerFocus(true)}
                    onBlur={() => setComposerFocus(false)}
                    onChange={event => setInputDraft(event.target.value)}
                    onPaste={event => {
                        const file = Array.from(event.clipboardData.files)[0];
                        if (!file) return;
                        event.preventDefault();
                        void uploadImage(file);
                    }}
                    onKeyDown={event => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            void sendInput("request");
                        }
                    }}
                />
                {/* 收起态在输入框旁留一个发送键：发一句话犯不上先展开整排按钮 */}
                {!composerExpanded && (
                    <Button
                        variant="primary"
                        className="shrink-0"
                        disabled={archived}
                        onMouseDown={event => event.preventDefault()}
                        onClick={() => void sendInput("request")}
                    >
                        发送
                    </Button>
                )}
            </div>
            {/* 展开态的一排按钮：点按时别让输入框失焦，否则这一排刚点上去就自己收起来了 */}
            {composerExpanded && (
                <div onMouseDown={event => event.preventDefault()} className="flex flex-col gap-2">
                    {attachments.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                            {attachments.map(asset => (
                                <div key={asset.id} className="relative">
                                    <AssetImage
                                        id={asset.id}
                                        alt={asset.filename}
                                        className="h-16 w-16 rounded-md border border-border object-cover"
                                    />
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setAttachments(current =>
                                                current.filter(item => item.id !== asset.id),
                                            )
                                        }
                                        className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-panel text-xs text-muted hover:text-bad"
                                        aria-label="移除图片"
                                    >
                                        ×
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={event => {
                                const file = event.target.files?.[0];
                                event.target.value = "";
                                if (file) void uploadImage(file);
                            }}
                        />
                        <Button
                            variant="ghost"
                            disabled={uploading}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            {uploading ? "上传中…" : "图片"}
                        </Button>
                        <span className="flex-1" />
                        {(pending.request > 0 || pending.turn > 0) && (
                            <span>
                                排队中 请求 {pending.request} · 回合 {pending.turn}
                            </span>
                        )}
                        {archived && (
                            <Button onClick={() => void onUnarchiveSession()}>
                                取消归档
                            </Button>
                        )}
                        <Button disabled={archived} onClick={() => void sendInput("turn")}>
                            排队
                        </Button>
                        <Button
                            variant="primary"
                            disabled={archived}
                            onClick={() => void sendInput("request")}
                        >
                            尽快处理
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}

export function SessionPanel({
    active,
    jobId,
    sessions,
    sessionsReady,
    activeSessionId,
    narrow,
    immersive,
    errorText,
    onSelectSession,
    onOpenBranch,
    onArchiveSession,
    onUnarchiveSession,
    onRefreshSessions,
    onChanged,
    onError,
    onImmersiveChange,
}: {
    active: boolean;
    jobId: string;
    sessions: JobSession[];
    sessionsReady: boolean;
    activeSessionId: string | null;
    narrow: boolean;
    immersive: boolean;
    errorText: string | null;
    onSelectSession: (sessionId: string) => void;
    onOpenBranch: () => Promise<void>;
    onArchiveSession: () => Promise<void>;
    onUnarchiveSession: () => Promise<void>;
    onRefreshSessions: () => Promise<unknown>;
    onChanged: () => Promise<unknown>;
    onError: (message: string | null) => void;
    onImmersiveChange: (immersive: boolean) => void;
}) {
    const { events, live, older, pending, setPending, loadOlder } = useSessionTimeline(jobId, activeSessionId);

    const timelineRef = useTimelineScroll({
        active,
        sessionId: activeSessionId,
        events,
        live,
        hasMore: older.hasMore,
        loadingOlder: older.loading,
        loadOlder,
    });

    const loadArguments = useCallback(
        (seq: number, callId?: string) => {
            if (!activeSessionId) return Promise.reject(new Error("没有执行会话"));
            return api.getToolArguments(jobId, activeSessionId, seq, callId)
                .then(result => result.arguments);
        },
        [jobId, activeSessionId],
    );

    const activeSessionArchived = sessions.find(item => item.sessionId === activeSessionId)?.archived === true;

    const handleUnarchived = useCallback(async () => {
        await onRefreshSessions();
    }, [onRefreshSessions]);

    return (
        <div className={cn("flex min-h-0 flex-1 flex-col gap-1.5 md:gap-2", !active && "hidden")}>
            {/* 沉浸态连会话下拉一起让出去：切会话先退出输入即可，不值当占着两行高度 */}
            {/* 行高固定：下拉框是网络回来才有的，别让它把整列顶下去 */}
            <div className={cn("flex h-9 shrink-0 items-center gap-1.5", immersive && "hidden")}>
                {sessions.length === 0 ? (
                    <span className="flex-1 text-xs text-muted">
                        {sessionsReady ? "还没有执行会话" : ""}
                    </span>
                ) : (
                    <select
                        value={activeSessionId ?? ""}
                        onChange={event => onSelectSession(event.target.value)}
                        className="h-full min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-sm"
                    >
                        {sessions.map(item => (
                            <option key={item.sessionId} value={item.sessionId}>
                                {sessionOptionLabel(item, narrow)}
                            </option>
                        ))}
                    </select>
                )}
                {/* 「+ 新会话」最常用，桌面直接摆出来；窄屏连它一起收进「⋯」，下拉才腾得出宽度 */}
                <Button className="hidden md:inline-flex" onClick={() => void onOpenBranch()}>
                    + 新会话
                </Button>
                <OverflowMenu>
                    <Button className="md:hidden" onClick={() => void onOpenBranch()}>
                        + 新会话
                    </Button>
                    {activeSessionId && (
                        <Button
                            variant="danger"
                            disabled={activeSessionArchived}
                            onClick={() => void onArchiveSession()}
                        >
                            归档会话
                        </Button>
                    )}
                    {activeSessionArchived && (
                        <Button onClick={() => void onUnarchiveSession()}>取消归档</Button>
                    )}
                </OverflowMenu>
            </div>
            <div
                ref={timelineRef}
                className="stable-scroll flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pr-1"
            >
                <Timeline
                    events={events}
                    live={live}
                    onLoadArguments={loadArguments}
                />
            </div>
            {activeSessionId && (
                <SessionComposer
                    active={active}
                    sessionId={activeSessionId}
                    archived={activeSessionArchived}
                    pending={pending}
                    narrow={narrow}
                    errorText={errorText}
                    onImmersiveChange={onImmersiveChange}
                    onPendingChange={setPending}
                    onUnarchived={handleUnarchived}
                    onUnarchiveSession={onUnarchiveSession}
                    onChanged={onChanged}
                    onError={onError}
                />
            )}
        </div>
    );
}
