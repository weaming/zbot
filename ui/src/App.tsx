import { useCallback, useEffect, useRef, useState } from "react";
import { Board, COLUMNS } from "./components/Board";
import { CardDetail } from "./components/CardDetail";
import { CreateDialog } from "./components/CreateDialog";
import { Button, Field, Input } from "./components/ui";
import { api, ApiError, clearToken, getToken, openEventStream, saveToken } from "./lib/api";
import type { BoardColumnKey, Job, McpServer } from "./lib/types";
import { useScrollLock } from "./lib/use-scroll-lock";
import { useVisualViewport } from "./lib/use-viewport";
import { confirmAction } from "./lib/utils";

/** 事件流状态：还没连上不算异常，只有连上又断了才值得报红 */
type ConnState = "connecting" | "live" | "down";

const CONN_DOT: Record<ConnState, string> = {
    connecting: "bg-muted/40",
    live: "bg-ok",
    down: "bg-bad",
};

const CONN_TITLE: Record<ConnState, string> = {
    connecting: "正在连接事件流",
    live: "事件流已连接",
    down: "事件流断开，正在重连",
};

export default function App() {
    // 手机软键盘：整页按可视区排布，详情浮层才能停在键盘上沿
    useVisualViewport();
    // 键盘弹起时别让手指把整页拖走（iOS 上只靠 CSS 拦不住）
    useScrollLock();
    const [token, setToken] = useState(getToken());
    const [jobs, setJobs] = useState<Job[]>([]);
    const [servers, setServers] = useState<McpServer[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    /** 键盘焦点：箭头/hjkl 移动，Enter 打开详情；与 selectedId（详情已打开）分开 */
    const [focusId, setFocusId] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [showArchived, setShowArchived] = useState(false);
    const [defaultCwd, setDefaultCwd] = useState("");
    const [home, setHome] = useState("");
    const [conn, setConn] = useState<ConnState>("connecting");
    const [authError, setAuthError] = useState<string | null>(null);
    const [tokenDraft, setTokenDraft] = useState("");
    const [error, setError] = useState<string | null>(null);
    const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const authorized = token.length > 0 && authError === null;
    // 退出后 token 为空，直接回到登录页（没有"取消返回"：已经登出了）
    const showAuth = !authorized;

    const refresh = useCallback(async () => {
        try {
            const list = await api.listJobs(showArchived);
            setJobs(list);
            setError(null);
            return list;
        } catch (cause) {
            if (cause instanceof ApiError && cause.status === 401) {
                setAuthError("令牌无效，请重新输入");
            } else {
                setError(cause instanceof Error ? cause.message : String(cause));
            }
            return [];
        }
    }, [showArchived]);

    // 首屏：列表 + MCP 选项 + 全局状态流
    useEffect(() => {
        if (!token) return;
        let stream: { close(): void } | null = null;
        let cancelled = false;

        void (async () => {
            await refresh();
            if (cancelled) return;
            const health = await api.getHealth().catch(() => null);
            setDefaultCwd(health?.cwd ?? "");
            setHome(health?.home ?? "");
            setServers(await api.listMcpServers().catch(() => []));

            const history = await api.listJobEvents(0).catch(() => []);
            if (cancelled) return;
            const since = history.length > 0 ? history[history.length - 1].seq : 0;

            stream = openEventStream("/api/jobs/live", since, {
                onOpen: () => setConn("live"),
                onError: info => {
                    // 401 重连也没用：直接回登录页，别留一个永远红的灯
                    if (info?.status === 401) {
                        setAuthError("令牌已失效，请重新输入");
                        return;
                    }
                    setConn("down");
                },
                onMessage: () => {
                    // 状态流只用来触发刷新：卡片数少，重拉全量比增量合并更不容易出错
                    if (refreshTimer.current) return;
                    refreshTimer.current = setTimeout(() => {
                        refreshTimer.current = null;
                        void refresh();
                    }, 200);
                },
            });
        })();

        return () => {
            cancelled = true;
            stream?.close();
            if (refreshTimer.current) clearTimeout(refreshTimer.current);
        };
    }, [token, refresh]);

    const move = async (id: string, column: BoardColumnKey) => {
        // 乐观更新列归属：拖拽只改卡片放哪儿，状态由任务自己决定（取消是唯一例外，服务端也会落列）
        setJobs(current =>
            current.map(job => (job.id === id ? { ...job, input: { ...job.input, column } } : job)),
        );
        try {
            await api.moveJob(id, column);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
        await refresh();
    };

    const selected = jobs.find(job => job.id === selectedId) ?? null;

    // 看板键盘导航：hjkl / 方向键移动焦点，Enter 打开，Esc 退回
    useEffect(() => {
        const NAV: Record<string, "up" | "down" | "left" | "right"> = {
            ArrowUp: "up",
            ArrowDown: "down",
            ArrowLeft: "left",
            ArrowRight: "right",
            k: "up",
            j: "down",
            h: "left",
            l: "right",
        };

        const moveFocus = (dir: "up" | "down" | "left" | "right") => {
            const groups = COLUMNS.map(column => ({
                key: column.key,
                jobs: jobs.filter(column.match),
            }));
            const gi = groups.findIndex(group => group.jobs.some(job => job.id === focusId));

            if (gi === -1) {
                const first = groups.findIndex(group => group.jobs.length > 0);
                if (first >= 0) setFocusId(groups[first]!.jobs[0]!.id);
                return;
            }

            const index = groups[gi]!.jobs.findIndex(job => job.id === focusId);
            if (dir === "up" || dir === "down") {
                const next = index + (dir === "down" ? 1 : -1);
                if (next >= 0 && next < groups[gi]!.jobs.length) setFocusId(groups[gi]!.jobs[next]!.id);
                return;
            }

            // 左右跨列：跳过空列，落到目标列里离原位置最近的一张
            const step = dir === "right" ? 1 : -1;
            for (let i = gi + step; i >= 0 && i < groups.length; i += step) {
                if (groups[i]!.jobs.length === 0) continue;
                const pos = Math.min(index, groups[i]!.jobs.length - 1);
                setFocusId(groups[i]!.jobs[pos]!.id);
                return;
            }
        };

        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            // 输入类元素里的按键不抢（否则编辑器里没法打 j/k）
            if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
                return;
            }

            if (event.key === "Escape") {
                if (selectedId) setSelectedId(null);
                else setFocusId(null);
                return;
            }
            if (event.key === "Enter") {
                if (focusId) {
                    event.preventDefault();
                    setSelectedId(focusId);
                }
                return;
            }

            const dir = NAV[event.key] ?? (event.key.length === 1 ? NAV[event.key.toLowerCase()] : undefined);
            if (!dir) return;
            event.preventDefault();
            moveFocus(dir);
        };

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [jobs, focusId, selectedId]);
    if (showAuth) {
        return (
            <div className="mx-auto mt-[10dvh] w-[min(420px,92vw)] rounded-xl border border-border bg-panel p-5">
                <h1 className="text-base font-semibold">输入访问令牌</h1>
                <p className="mt-1 text-xs text-muted">
                    令牌在 <code className="rounded bg-col px-1">~/.zbot/web/token</code>，
                    粘贴后记在本机 localStorage；令牌只走 Authorization 请求头，不再出现在 URL 里。
                </p>
                <form
                    className="mt-3 flex flex-col gap-2"
                    onSubmit={event => {
                        event.preventDefault();
                        const next = tokenDraft.trim();
                        if (!next) return;
                        saveToken(next);
                        setAuthError(null);
                        setToken(next);
                        setTokenDraft("");
                    }}
                >
                    <Field label="令牌">
                        <Input
                            type="password"
                            value={tokenDraft}
                            autoFocus
                            autoComplete="off"
                            onChange={event => setTokenDraft(event.target.value)}
                        />
                    </Field>
                    <Button variant="primary" type="submit">
                        进入
                    </Button>
                </form>
                {authError && <p className="mt-2 text-xs text-bad">{authError}</p>}
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            <header className="flex items-center gap-2 border-b border-border bg-panel px-3 py-2">
                <h1 className="text-base font-semibold">zbot 任务</h1>
                {/* 刷新时灯是灰的（还在连），连上转绿，断了才红——红色只留给真异常 */}
                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${CONN_DOT[conn]}`} title={CONN_TITLE[conn]} />
                {conn === "down" && <span className="shrink-0 text-xs text-bad">断线重连中</span>}
                {error && <span className="text-xs text-bad">{error}</span>}
                <span className="flex-1" />
                {/* 与相邻按钮同尺寸；选中靠描边高亮，不用勾选框 */}
                <Button
                    className={showArchived ? "border-accent text-accent" : undefined}
                    onClick={() => setShowArchived(current => !current)}
                >
                    含归档
                </Button>
                <Button variant="primary" onClick={() => setCreating(true)}>
                    + 新任务
                </Button>
                <Button
                    variant="ghost"
                    onClick={() => {
                        // 清掉本机令牌就回不去了：要重新从 token 文件里粘一次，先问一句
                        if (!confirmAction("退出登录？令牌需要重新粘贴。")) return;
                        // 退出即清干净：令牌、列表、打开的卡片都不留在页面上
                        clearToken();
                        setToken("");
                        setJobs([]);
                        setSelectedId(null);
                        setFocusId(null);
                        setTokenDraft("");
                        setAuthError(null);
                        setError(null);
                        setConn("connecting");
                    }}
                >
                    退出
                </Button>
            </header>

            <div className="relative flex min-h-0 flex-1">
                <div className="min-w-0 flex-1">
                    <Board
                        jobs={jobs}
                        selectedId={selectedId}
                        focusId={focusId}
                        onSelect={id => {
                            setFocusId(id);
                            setSelectedId(id);
                        }}
                        onMove={(id, column) => void move(id, column)}
                    />
                </div>
                {selected && (
                    // 窄屏铺满整个视口（连顶部的应用栏一起盖住）：少一层头部就多一行历史。
                    // vv-shell 贴可视区而不是布局视口：键盘弹起时高度自己收，不用浏览器把整页顶上移
                    <aside className="vv-shell z-30 flex w-full flex-col bg-panel md:w-[520px] md:shrink-0 md:border-l md:border-border">
                        <CardDetail
                            // 换卡片必须换实例：标题/超时是 defaultValue，复用实例会把上一张卡的值写回去
                            key={selected.id}
                            job={selected}
                            servers={servers}
                            home={home}
                            onChanged={refresh}
                            onClose={() => setSelectedId(null)}
                        />
                    </aside>
                )}
            </div>

            <CreateDialog
                open={creating}
                servers={servers}
                defaultCwd={defaultCwd}
                home={home}
                onClose={() => setCreating(false)}
                onCreated={refresh}
            />
        </div>
    );
}
