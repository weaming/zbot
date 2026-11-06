import { useState } from "react";
import { api, ApiError } from "../lib/api";
import type { McpServer } from "../lib/types";
import { cn, newIdempotencyKey } from "../lib/utils";
import { abbreviateHome } from "../lib/format";
import { Button, Dialog, Field, Input } from "./ui";
import { TagInput } from "./TagInput";
import { DirInput } from "./DirInput";
import { MdEditor } from "./MdEditor";

export function CreateDialog({
    open,
    servers,
    defaultCwd,
    home,
    onClose,
    onCreated,
}: {
    open: boolean;
    servers: McpServer[];
    /** 服务端的默认工作目录：留空时用它，也作为输入框提示 */
    defaultCwd: string;
    home: string;
    onClose: () => void;
    onCreated: () => Promise<unknown>;
}) {
    const [prompt, setPrompt] = useState("");
    const [title, setTitle] = useState("");
    const [workspace, setWorkspace] = useState("");
    const [labels, setLabels] = useState<string[]>([]);
    /**
     * 记「排除项」而不是「选中项」。默认排除 lazy 服务 —— 与后端 defaultMcpSelection()
     * 同一口径（lazy 只影响默认不选，选中与否才是下发判据）。
     * null = 用户还没动过，直接用默认值；动过之后以用户的选择为准。
     */
    const [excluded, setExcluded] = useState<string[] | null>(null);
    const defaultExcluded = servers.filter(server => server.lazy).map(server => server.name);
    const effectiveExcluded = excluded ?? defaultExcluded;
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const reset = () => {
        setPrompt("");
        setTitle("");
        setWorkspace("");
        setLabels([]);
        setExcluded(null);
        setError(null);
    };

    /** 创建只入队不执行：卡片落到「待办」，等用户在卡片里点「开始」。 */
    const submit = async () => {
        // 标题必填；任务描述同样必填（它才是发给模型的内容）
        if (!title.trim()) {
            setError("标题必填");
            return;
        }
        if (!prompt.trim()) {
            setError("任务描述必填");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await api.createJob({
                prompt: prompt.trim(),
                title: title.trim(),
                idempotencyKey: newIdempotencyKey(),
                ...(workspace.trim() ? { workspace: workspace.trim() } : {}),
                ...(labels.length > 0 ? { labels } : {}),
                // 明确传选中集：默认就是「非 lazy 的服务」，用户勾掉谁就少谁。
                // 不传会被后端当成「不限制」，反而把 lazy 全带上。
                ...(servers.length > 0
                    ? {
                          mcpServers: servers
                              .map(server => server.name)
                              .filter(name => !effectiveExcluded.includes(name)),
                      }
                    : {}),
            });
            reset();
            onClose();
            await onCreated();
        } catch (cause) {
            setError(cause instanceof ApiError ? cause.message : String(cause));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog open={open} title="新任务" onClose={() => { reset(); onClose(); }}>
            <div className="flex flex-col gap-2.5">
                <Field label="标题（必填）">
                    <Input
                        value={title}
                        autoFocus
                        placeholder="给这张卡片起个名字"
                        onChange={event => setTitle(event.target.value)}
                    />
                </Field>
                <Field label="任务描述">
                    <MdEditor
                        value={prompt}
                        onChange={setPrompt}
                        rows={4}
                        placeholder="要 zbot 做什么？"
                    />
                </Field>
                <Field label="工作目录">
                    <DirInput
                        value={workspace}
                        placeholder={
                            defaultCwd ? `留空用 ${abbreviateHome(defaultCwd, home)}` : "留空用服务端 cwd"
                        }
                        onChange={setWorkspace}
                    />
                </Field>
                <Field label="标签，逗号分隔">
                    <TagInput
                        value={labels}
                        onChange={setLabels}
                        placeholder="空格或回车添加"
                    />
                </Field>
                <Field label="选中的 MCP（lazy 默认不选）">
                    <div className="flex flex-wrap items-center gap-1.5">
                        {servers.length === 0 && <span className="text-xs text-muted">（没有可选的 MCP）</span>}
                        {servers.map(server => {
                            const checked = !effectiveExcluded.includes(server.name);
                            return (
                                <button
                                    key={server.name}
                                    type="button"
                                    onClick={() =>
                                        setExcluded(
                                            checked
                                                ? [...effectiveExcluded, server.name]
                                                : effectiveExcluded.filter(item => item !== server.name),
                                        )
                                    }
                                    className={cn(
                                        "rounded-full border px-2.5 py-0.5 text-xs",
                                        checked ? "border-accent text-accent" : "border-border text-muted",
                                    )}
                                >
                                    {server.name} ({server.toolCount})
                                </button>
                            );
                        })}
                        {servers.length > 0 && (
                            <button
                                type="button"
                                onClick={() => setExcluded(servers.map(server => server.name))}
                                className="ml-auto rounded-full px-2 py-0.5 text-xs text-muted underline-offset-2 hover:underline"
                            >
                                清空
                            </button>
                        )}
                    </div>
                </Field>
                {error && <p className="text-xs text-bad">{error}</p>}
                <div className="flex justify-end gap-2">
                    <Button onClick={() => { reset(); onClose(); }}>取消</Button>
                    <Button variant="primary" disabled={busy} onClick={() => void submit()}>
                        创建
                    </Button>
                </div>
            </div>
        </Dialog>
    );
}
