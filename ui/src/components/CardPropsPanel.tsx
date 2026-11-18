/**
 * 卡片「属性」标签页：工作目录、任务描述、标签、MCP 选择与评论流。
 */

import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { abbreviateHome, formatTime } from "../lib/format";
import type { Job, JobComment, McpServer } from "../lib/types";
import { useInlineEdit } from "../lib/use-inline-edit";
import { cn, confirmAction } from "../lib/utils";
import { DirInput } from "./DirInput";
import { MarkdownBlock } from "./Markdown";
import { MdEditor } from "./MdEditor";
import { TagInput } from "./TagInput";
import { Button, Field } from "./ui";

export function CardPropsPanel({
    job,
    home,
    servers,
    activeSessionId,
    mcpSelection,
    selectionInitialized,
    comments,
    onPatch,
    onApplyMcp,
    onRefreshComments,
    onChanged,
    onError,
}: {
    job: Job;
    home: string;
    servers: McpServer[];
    activeSessionId: string | null;
    mcpSelection: string[] | null;
    selectionInitialized: boolean;
    comments: JobComment[];
    onPatch: (body: Record<string, unknown>) => Promise<void>;
    onApplyMcp: (next: string[]) => Promise<void>;
    onRefreshComments: () => Promise<void>;
    onChanged: () => Promise<unknown>;
    onError: (message: string | null) => void;
}) {
    const [commentDraft, setCommentDraft] = useState("");
    /** 正在内联编辑的评论 id 与草稿；null 表示没有在编辑 */
    const [editingComment, setEditingComment] = useState<{ id: string; body: string } | null>(null);

    useEffect(() => {
        setEditingComment(null);
    }, [job.id]);

    const workspaceDisplay = abbreviateHome(job.input.workspace, home);
    // 工作目录的 Enter 由 DirInput 自己处理（要区分补全态与编辑态），这里不开 commitOnEnter
    const workspaceEdit = useInlineEdit(workspaceDisplay, next => onPatch({ workspace: next }), { resetKey: job.id });
    const promptEdit = useInlineEdit(job.input.prompt, next => onPatch({ prompt: next }), { resetKey: job.id });

    const submitComment = async () => {
        const body = commentDraft.trim();
        if (!body) return;
        onError(null);
        try {
            await api.addComment(job.id, body, activeSessionId ?? undefined);
            setCommentDraft("");
            await onRefreshComments();
            await onChanged();
        } catch (cause) {
            onError(cause instanceof ApiError ? cause.message : String(cause));
        }
    };

    /** 删除评论：软删除保留历史，但界面上撤不回来，仍需确认（编辑态与展示态共用） */
    const removeComment = async (commentId: string) => {
        if (!confirmAction("删除这条评论？")) return;
        await api.deleteComment(job.id, commentId).catch(() => {});
        setEditingComment(null);
        await onRefreshComments();
        await onChanged();
    };

    const hasSession = Boolean(activeSessionId || job.sessionId);
    // 有执行会话时以会话选中集为准；未初始化（老会话）或还没跑过时按默认口径回退
    const fallbackMcp = servers.filter(item => !item.lazy).map(item => item.name);
    const currentMcp = mcpSelection !== null && selectionInitialized
        ? mcpSelection
        : (job.input.mcpServers ?? fallbackMcp);

    return (
        <div className="stable-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain text-sm">
            {/* 平时是普通文字，点一下才变成输入框：目录很少改，摊个输入框在那儿反而抢注意力 */}
            <Field label="工作目录（只影响新会话）">
                {workspaceEdit.editing ? (
                    <div {...workspaceEdit.editorProps}>
                        <DirInput
                            value={workspaceEdit.draft}
                            placeholder={workspaceDisplay}
                            onChange={workspaceEdit.setDraft}
                            onSubmit={value => workspaceEdit.commitWith(value)}
                            autoFocus
                        />
                    </div>
                ) : (
                    <button
                        type="button"
                        title={workspaceDisplay}
                        onClick={workspaceEdit.begin}
                        // 与 DirInput 里的 <input> 同盒模型：切换时只换边框，不产生位移
                        className="w-full cursor-text truncate rounded-md border border-transparent px-2.5 py-1.5 text-left text-base text-fg sm:text-sm hover:border-border hover:bg-col"
                    >
                        {workspaceDisplay}
                    </button>
                )}
            </Field>

            <Field label="任务描述">
                {promptEdit.editing ? (
                    <div className="flex flex-col gap-1.5" {...promptEdit.editorProps}>
                        <MdEditor value={promptEdit.draft} onChange={promptEdit.setDraft} rows={3} autoFocus />
                        <div className="flex items-center gap-1.5">
                            {/* 按钮抢焦点会让编辑器先失焦提交，mousedown 拦一下 */}
                            <Button
                                variant="primary"
                                onMouseDown={event => event.preventDefault()}
                                onClick={promptEdit.commit}
                            >
                                保存
                            </Button>
                            <Button onMouseDown={event => event.preventDefault()} onClick={promptEdit.cancel}>
                                取消
                            </Button>
                            <span className="text-xs text-muted">⌘/Ctrl+Enter 保存 · Esc 取消</span>
                        </div>
                    </div>
                ) : (
                    /* 点正文即可进入编辑；链接与复制按钮照旧生效 */
                    <div
                        className="cursor-text"
                        onClick={event => {
                            if ((event.target as HTMLElement).closest("a, button")) return;
                            promptEdit.begin();
                        }}
                    >
                        {/* min-h 与 MdEditor 的 min-h-[96px] 对齐：进编辑态时高度不变，下面不跳 */}
                        <MarkdownBlock content={job.input.prompt} className="min-h-[96px]" />
                    </div>
                )}
            </Field>

            <Field label="标签">
                <TagInput
                    value={job.input.labels ?? []}
                    onChange={next => void onPatch({ labels: next })}
                    placeholder="空格或回车添加"
                />
            </Field>

            <Field
                label={hasSession ? "选中的 MCP（下个回合生效）" : "允许的 MCP"}
                action={
                    servers.length > 0 && currentMcp.length > 0 ? (
                        <button
                            type="button"
                            onClick={() => void onApplyMcp([])}
                            className="rounded px-1.5 py-0.5 text-xs text-muted hover:bg-col hover:text-fg"
                        >
                            清空
                        </button>
                    ) : undefined
                }
            >
                <div className="flex flex-wrap gap-1.5">
                    {servers.length === 0 && <span className="text-xs text-muted">（没有可选的 MCP）</span>}
                    {servers.map(server => {
                        const checked = currentMcp.includes(server.name);
                        return (
                            <button
                                key={server.name}
                                type="button"
                                onClick={() => {
                                    const next = checked
                                        ? currentMcp.filter(item => item !== server.name)
                                        : [...currentMcp, server.name];
                                    void onApplyMcp(next);
                                }}
                                className={cn(
                                    "rounded-full border px-2.5 py-0.5 text-xs",
                                    checked ? "border-accent text-accent" : "border-border text-muted",
                                )}
                            >
                                {server.name} ({server.toolCount})
                            </button>
                        );
                    })}
                </div>
            </Field>

            <section className="flex flex-col gap-2 border-t border-border pt-3">
                <h3 className="text-xs text-muted">评论{comments.length > 0 ? ` · ${comments.length}` : ""}</h3>
                {comments.length === 0 && <p className="text-xs text-muted">还没有评论</p>}
                {comments.map(comment => (
                    <div key={comment.id} className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-2 text-xs text-muted">
                            <span>{comment.author === "agent" ? "agent" : "我"}</span>
                            <span>{formatTime(comment.createdAt)}</span>
                            {comment.editedAt && <span>已编辑</span>}
                        </div>
                        {editingComment?.id === comment.id ? (
                            /* Esc 先退出编辑（放弃改动），再按一次才轮到关闭卡片 */
                            <div
                                className="flex flex-col gap-1"
                                onKeyDown={event => {
                                    if (event.key !== "Escape") return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setEditingComment(null);
                                }}
                            >
                                <MdEditor
                                    value={editingComment.body}
                                    onChange={body => setEditingComment({ id: comment.id, body })}
                                    rows={4}
                                    autoFocus
                                />
                                <div className="flex gap-1">
                                    <Button
                                        variant="primary"
                                        onClick={async () => {
                                            const next = editingComment.body.trim();
                                            if (!next) return;
                                            await api.updateComment(job.id, comment.id, next).catch(() => {});
                                            setEditingComment(null);
                                            await onRefreshComments();
                                        }}
                                    >
                                        保存
                                    </Button>
                                    <Button variant="ghost" onClick={() => setEditingComment(null)}>
                                        取消
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        className="text-bad"
                                        onClick={() => void removeComment(comment.id)}
                                    >
                                        删除
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <MarkdownBlock content={comment.body} />
                                <div className="flex gap-1">
                                    <Button
                                        variant="ghost"
                                        onClick={() => setEditingComment({ id: comment.id, body: comment.body })}
                                    >
                                        编辑
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        className="text-bad"
                                        onClick={() => void removeComment(comment.id)}
                                    >
                                        删除
                                    </Button>
                                </div>
                            </>
                        )}
                    </div>
                ))}
                <MdEditor
                    value={commentDraft}
                    onChange={setCommentDraft}
                    rows={3}
                    placeholder="写评论…（Ctrl/⌘ + Enter 提交）"
                    onSubmit={() => void submitComment()}
                />
                <div>
                    <Button variant="primary" onClick={() => void submitComment()}>
                        发表评论
                    </Button>
                </div>
            </section>
        </div>
    );
}
