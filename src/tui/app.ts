/**
 * TUI 应用：布局（会话栏 + 消息区 + 输入区）、事件流渲染、快捷键。
 * assistant 消息按思考、工具调用和文本的时间线渲染，Ctrl+O 展开/收起详细内容。
 */

import fs from "node:fs";
import path from "node:path";

import {
    CombinedAutocompleteProvider,
    Container,
    Key,
    KeybindingsManager,
    ProcessTerminal,
    ScrollView,
    setKeybindings,
    Text,
    TUI_KEYBINDINGS,
    TuiAltScreen,
    matchesKey,
    truncateToWidth,
    visibleWidth,
} from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { describeClaimFailure } from "../control/channel.js";
import { cleanupStaleSockets } from "../control/registry.js";
import { cleanupArchivedSessions } from "../events/session-cleanup.js";
import type { SessionHost } from "../host/session-host.js";
import type { SessionReleaseCause } from "../host/session-host-types.js";
import { openExternalUrl } from "./app-helpers.js";
import {
    buildHelpText,
    buildSkillsHelpText,
    EXIT_CONFIRM_MS,
    SESSION_NEW_URL,
    SESSION_PANEL_URL,
    SHORTCUT_PANEL_URL,
    SLASH_COMMANDS,
    TAB_LINK_PREFIX,
    truncateInline,
    wrapAppLink,
} from "./slash-commands.js";
import {
    describeModelView,
    effectiveReasoningEffort,
    preserveEffort,
    resolveEffort,
    resolveModelUse,
} from "../commands/slash-model.js";
import { buildReviewPrompt, parseSlashCommand } from "../commands/slash-command.js";
import { MAX_SESSION_TITLE_LENGTH } from "../types/session.js";
import {
    formatBackgroundTaskDetails,
    formatElapsed,
    MAX_SHOWN_BACKGROUND_TASKS,
    MAX_TASK_TEXT_COLUMNS,
} from "../format/task-format.js";
import { bindGlobalKeys, type GlobalKeyHost } from "./keybindings.js";
import { buildStatusBarModel } from "./status-bar-model.js";
import { protocolStatusLabel } from "../utils/responses-transport.js";
import { writeCurrentSessionPointer } from "../utils/session-pointer.js";
import { ChatLayout } from "./chat-layout.js";
import { TurnStateStore } from "./turn-state.js";
import {
    isInsideBounds,
    openPanelOverlay,
    overlayBounds,
    panelBounds,
    panelContentRows,
    type OverlayBounds,
    type PanelOverlay,
} from "./panel-overlay.js";
import { PanelStack } from "./panel-stack.js";
import { OwnershipTracker } from "./ownership-tracker.js";
import { QuestionCoordinator } from "./question-coordinator.js";
import { ModelMcpPanels } from "./model-mcp-panels.js";
import { PendingQueue, type PendingMessage } from "./pending-queue.js";
import { truncatePlain } from "../format/text.js";
import { parseWheelEvent, type WheelEvent } from "./panel-input.js";
import { PromptEditor } from "./prompt-editor.js";
import { StatusBar } from "./status-bar.js";
import { TodoBar } from "./todo-bar.js";
import { buildSessionBar, type SessionBarStyles, type SessionBarTab } from "./session-bar.js";
import { SPINNER_FRAMES } from "./session-marker.js";
import { SessionPanel, type SessionPanelItem } from "./session-panel.js";
import { QuestionPanel } from "./question-panel.js";
import { isAskUserTool } from "./tool-block-parse.js";
import { PanelFrame } from "./panel-frame.js";
import { ShortcutPanel } from "./shortcut-panel.js";
import { ModelPanel } from "./model-panel.js";


import { getWheelLogFile } from "../utils/state-paths.js";
import { discardPendingInput } from "../utils/tty-input.js";
import { installTerminalExitGuard } from "./terminal-state.js";
import { ChatStore } from "./store.js";
import { editorTheme, theme } from "./theme.js";
import { setLogSession } from "../host/runtime-context.js";
import { DraftStore, loadRichDrafts, persistRichDrafts } from "./draft-store.js";
import { isCmdDown, isCmdGateSupported } from "./cmd-modifier.js";
import { herdrReporter } from "./herdr-reporter.js";
import { notifyTurnResult } from "./notifier.js";
import {
    getChatApiSettings,
    getChatModelOptions,
    setDefaultChatModelOption,
    validateChatApiSettings,
} from "../services/chat-runtime.js";
import type { ChatModelSelection } from "../types/chat-model.js";
import { readSessionTodos, type TodoItem } from "../tools/todo-tool.js";
import { deepSeekPhaseInfo, endpointHost, normalizeDeepSeekModel, resolvePricingMode } from "../pricing/deepseek.js";
import { getContextWindowForModel } from "../utils/token-budget.js";
import {
    buildMcpStatusHelpText,
    defaultMcpSelection,
    getMcpServersStatus,
    type McpNotice,
} from "../mcp/client-manager.js";
import { registerSessionRuntime } from "../control/runtime.js";
import { isToolSearchEnabled } from "../tools/orchestrator/turn-request.js";
import { McpPanel } from "./mcp-panel.js";
import { formatDisplayPath, resolveExistingDir } from "../tools/cwd-tool.js";
import {
    createMessageComponent,
    messageRenderKey,
    renderSystemText,
    updateMessageComponent,
    type MessageComponents,
    type RenderContext,
} from "./render/messages.js";
import type { ImageAssetRef, UserMessageInput } from "../types/image.js";
import { backgroundTaskManager, type BackgroundTaskSummary } from "../tools/background-tasks.js";

/** 需要当前会话才能执行的命令（无会话时直接提示，不静默失败）。 */
const SESSION_REQUIRED_COMMANDS = new Set(["/clear", "/archive", "/unarchive", "/delete", "/close", "/compact", "/continue", "/system", "/model", "/cwd"]);

/** ⌃T 改动详情：初始展开的 turn 数，也是向上滚动时每批加载的 turn 数。 */
const DIFF_TURN_BATCH = 2;

/**
 * 释放会话后的提示：按发起方区分，避免把本实例的主动操作说成"被其他实例拿走"。
 * `delete` 不在表里 —— 删除由 deleteSessionById 自己提示，重复闪没有意义。
 */
const RELEASE_FLASH: Partial<Record<SessionReleaseCause, string>> = {
    user: "已关闭会话（⌘P 可重新打开）",
    archive: "已归档会话（⌘P → ⌃A 取消归档）",
    tool: "子会话已归档（历史保留）",
    auto: "子会话已自动归档（历史保留）",
};

const GLOBAL_RUNTIME_RELOAD_KEY = "__global__";

function formatBackgroundTaskNotification(task: BackgroundTaskSummary): string {
    return JSON.stringify({
        type: "background_task_completed",
        instruction: "请结合任务结果继续推进原请求；如需更多信息，可调用 background_task 查询任务。",
        task_id: task.id,
        status: task.status,
        command: task.command,
        exit_code: task.exitCode ?? null,
        signal: task.signal ?? null,
        reason: task.reason ?? null,
        stdout: task.stdout ?? "",
        stderr: task.stderr ?? "",
        output_truncated: task.outputTruncated ?? false,
    }, null, 2);
}

/** 输入框：左侧 ❯ 提示符（前缀占 2 列，渲染宽度相应缩减）。 */
type SessionPhaseType = "waiting" | "reasoning" | "tool" | "generating" | "compacting";

interface SessionPhaseState {
    phase: SessionPhaseType;
    toolName?: string;
    startTime: number;
    toolStartTime?: number;
    message?: string;
}

export class ChatApp {
    private readonly tui: TuiAltScreen;
    private readonly messagesContainer = new Container();
    private readonly scrollView: ScrollView;
    private readonly tabBar = new Text("", 1, 0);
    /** 会话条样式；宽度上限在 session-bar 内固定，保证等宽。 */
    private readonly sessionBarStyles: SessionBarStyles = {
        active: theme.tabActive,
        inactive: theme.tabInactive,
        overflow: theme.dim,
        add: theme.dim,
    };
    /** 当前可见 tab 的会话 id，顺序即 Ctrl+1..9 的顺序。 */
    private tabVisibleIds: string[] = [];
    /**
     * 浮层面板栈：唯一的数据源。
     * 输入路由、关闭动作、同类互斥都由它维护，app 只负责装配各层的面板实例。
     */
    private readonly panels = new PanelStack((data) => this.isScrollKey(data));

    private currentModelSelection?: ChatModelSelection;
    private readonly statusBar = new StatusBar();
    /** 提问区位于聊天视口之后、输入框之前，不覆盖对话正文；显隐由 QuestionCoordinator 决策。 */
    private readonly questionDock = new Container();
    /** 底部常驻任务清单条：有未完成 todo 时占位，替代事件流里的 todo 块。 */
    private readonly todoBar = new TodoBar();
    private readonly editor: PromptEditor;
    private readonly layout: ChatLayout;
    private readonly pendingList = new Container();
    private terminalStarted = false;
    /** pending 列表一次最多显示的消息行数（不含 header），超出时窗口化。 */
    private static readonly PENDING_MAX_VISIBLE = 5;
    /** 按会话隔离的入队消息队列与选中索引。 */
    private readonly pending = new PendingQueue();
    /** 只在现有回合仍运行时注入的后台任务完成通知。 */
    private readonly activeTurnSessions = new Set<string>();
    private readonly pendingBackgroundResults = new Map<string, Array<{ text: string; trigger: "pending" }>>();
    /** 启动期阻断原因（provider 配置无效等）：herdr 语义状态保持 blocked。 */
    private herdrBlock: string | undefined;
    private readonly unsubscribeBackgroundTaskCompletion: () => void;
    private readonly unsubscribeBackgroundTaskStart: () => void;
    /** 按会话隔离的未发送输入草稿：暂存、防抖与落盘由 DraftStore 统一承担。 */
    private readonly drafts = new DraftStore({
        // marker 展开依赖编辑器持有的 paste 缓存；实例化时编辑器尚未就绪，故延迟到调用时解析
        expand: (sessionId, text) => this.editor.expandSessionDraft(sessionId, text),
        persist: richDrafts => persistRichDrafts(richDrafts),
    });
    /** 按会话记录当前的实时执行阶段与开始时间。 */
    private readonly turnState = new TurnStateStore();
    /**
     * 提问通道与底部提问区：待答问题、按会话缓存的面板、折叠态与显隐决策都在 coordinator 内，
     * 这里只提供 tui/面板栈/重绘等窄接口。
     */
    private readonly questions: QuestionCoordinator;
    /** 运行时能力注册的注销函数：退出时按身份注销，不留指向已退出前端的引用。 */
    private readonly unregisterRuntime: () => void;
    /**
     * 会话归属快照（探测/节流/在途去重/面板期间轮询 + 展示文案都在 tracker 内）。
     * 面板与切换入口必须让用户看得见归属，这里只负责把它接上宿主能力。
     */
    private readonly ownership = new OwnershipTracker({
        probeOwnership: ids => this.agent.listSessionOwnership(ids),
        sessionIds: () => this.store.sessions.map(session => session.sessionId),
        onChange: () => this.renderTabBar(),
        isPanelOpen: () => this.hasSessionPanelOpen(),
        pendingStats: sessionId => this.agent.peerPendingStats(sessionId),
    });
    /** 标题重命名（⌘R）锁定的会话；null 表示非重命名态。 */
    private renameSessionId: string | null = null;
    /** 进入标题重命名前的输入框原文快照（Esc/切走时还原，避免标题混入草稿）。 */
    private renameDraft = "";
    private spinnerTimer: ReturnType<typeof setInterval> | null = null;
    /** 官方 DeepSeek 峰谷倒计时刷新（分钟精度，30s 心跳） */
    private peakCountdownTimer: ReturnType<typeof setInterval> | null = null;
    private spinnerIndex = 0;
    private readonly messageComponents = new Map<number, MessageComponents>();
    /** 待执行的运行时重载请求按会话去重；运行时本身是进程级的，执行时会合并它们。 */
    private readonly pendingRuntimeReloads = new Set<string>();
    /** 进程级 UI 占位：只覆盖与具体会话无关的操作（重载、切会话）。会话自身的忙闲在 turnState。 */
    private runtimeReloading = false;
    private switching = false;
    /** 模型 / MCP 浮层的装配与 lazy 启用集串行落盘（状态与决策在 ModelMcpPanels）。 */
    private readonly modelMcp: ModelMcpPanels;
    private detailed = false;
    /** ⌃T：正常模式下也展开历史 turn 的改动详情。 */
    private diffDetail = false;
    /** 已展开详情的 turn 数：向上滚动到顶端时按批增加。 */
    private diffTurnWindow = DIFF_TURN_BATCH;
    private exiting = false;
    /** 高危操作的待确认状态：同一标签在 2 秒内再按一次才执行。 */
    private pendingConfirm: { label: string; run: () => void; armedAt: number } | null = null;
    /** todo 读取 TTL 缓存：spinner 120ms 高频重绘期间避免反复 stat 文件。 */
    private todoCache: { sessionId: string | null; atMs: number; todos: TodoItem[] } | null = null;
    private static readonly TODO_CACHE_TTL_MS = 500;

    /** 读取当前会话 todo（带 TTL 缓存）；tool 事件会强制失效。 */
    private getSessionTodos(sessionId: string | null): TodoItem[] {
        const now = Date.now();
        const cached = this.todoCache;
        if (cached && cached.sessionId === sessionId && now - cached.atMs < ChatApp.TODO_CACHE_TTL_MS) {
            return cached.todos;
        }
        const todos = readSessionTodos(sessionId ?? undefined);
        this.todoCache = { sessionId, atMs: now, todos };
        return todos;
    }

    /** 需要当前会话的操作：无会话时提示并返回 false。 */
    private requireSession(): boolean {
        if (this.store.currentSessionId) return true;
        this.tui.flash("没有打开的会话：直接输入消息即新建，或 ⌃N");
        return false;
    }

    get pendingMessages(): string[] {
        return this.pending.messages(this.store.currentSessionId).map(message => this.formatPendingInput(message));
    }

    set pendingMessages(messages: string[]) {
        this.pending.replace(this.store.currentSessionId, [...messages]);
    }

    get pendingIndex(): number {
        return this.pending.index(this.store.currentSessionId);
    }

    set pendingIndex(index: number) {
        this.pending.setIndex(this.store.currentSessionId, index);
    }

    constructor(
        private readonly agent: SessionHost,
        private readonly store: ChatStore,
    ) {
        // 弹窗激活时 Enter 走 tab 分支（填入不发送）；非弹窗 Enter 仍为提交
        setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {
            "tui.input.tab": ["tab", "enter"],
            // ↑/↓ / ⌃R 浏览最近输入历史（Editor 内置，上限 100 条）；多行内移动光标由 PromptEditor 处理
            "tui.editor.historyPrevious": ["up", "ctrl+r"],
            "tui.editor.historyNext": ["down"],
            // cursorUp/cursorDown 会被 historyPrevious/historyNext 遮蔽（Editor 里历史分支在前），清空以免误导
            "tui.editor.cursorUp": [],
            "tui.editor.cursorDown": [],
            // Home/End 归输入框（行首 / 行尾）：视口顶 / 底不再抢这两个键，用 PgUp / PgDn 或滚轮
            "tui.altScreen.top": [],
            "tui.altScreen.bottom": [],
            // 跳提问只保留 ⌃⇧↑ / ⌃⇧↓：否则 ⌃↑ / ⌃↓ 会静默抢占（面板未列，用户以为无功能）
            "tui.altScreen.previousPrompt": ["ctrl+shift+up"],
            "tui.altScreen.nextPrompt": ["ctrl+shift+down"],
            // ⌃] 归全局「下一个会话」，不再保留编辑器的 jumpForward（跳到指定字符）
            "tui.editor.jumpForward": [],
            // ⌃D 归全局退出：前向删除字符只保留 Delete
            "tui.editor.deleteCharForward": ["delete"],
        }));

        const terminal = new ProcessTerminal();
        this.tui = new TuiAltScreen(terminal, undefined, undefined, {
            openUrl: (url: string) => this.handleOpenUrl(url),
        });

        this.scrollView = new ScrollView(this.messagesContainer, {
            follow: "end",
            scrollbar: "auto",
        });
        this.editor = new PromptEditor(this.tui, editorTheme);
        this.editor.setAutocompleteProvider(
            new CombinedAutocompleteProvider(SLASH_COMMANDS, process.cwd()),
        );
        this.editor.onChange = (text: string) => {
            const isCommand = text.trimStart().startsWith("/");
            this.editor.borderColor = isCommand
                ? theme.commandBorder
                : (line: string): string => editorTheme.borderColor(line);
            if (this.store.currentSessionId && !this.switching) {
                this.setDraft(this.store.currentSessionId, text, this.editor.getImageAttachments());
            }
        };
        this.editor.onImagesChanged = () => {
            if (this.store.currentSessionId && !this.switching) {
                this.setDraft(this.store.currentSessionId, this.editor.getText(), this.editor.getImageAttachments());
            }
        };

        this.layout = new ChatLayout([
            { component: this.tabBar, shrink: 0 },
            { component: this.scrollView, grow: 1, shrink: 1 },
            { component: this.todoBar, shrink: 0, minSize: 0 },
            { component: this.pendingList, shrink: 0, minSize: 0 },
            { component: this.questionDock, shrink: 0, minSize: 0 },
            { component: this.editor, shrink: 0, minSize: 3 },
            { component: this.statusBar, shrink: 0, minSize: 2 },
        ], { gap: 0 });
        this.tui.setLayoutRoot(this.layout);

        this.questions = new QuestionCoordinator({
            panels: this.panels,
            dock: {
                showPanel: (panel) => {
                    this.questionDock.clear();
                    this.questionDock.addChild(new PanelFrame(panel as unknown as Component, theme.question));
                },
                showCollapsed: (text) => {
                    this.questionDock.clear();
                    this.questionDock.addChild(new Text(theme.question(text), 1, 0));
                },
                clear: () => this.questionDock.clear(),
            },
            currentSessionId: () => this.store.currentSessionId,
            sessionLabel: sessionId => this.sessionLabel(sessionId),
            isExiting: () => this.exiting,
            restoreFocus: () => this.restoreFocus(),
            requestRender: () => this.tui.requestRender(),
            // 待答状态影响 tab 标记、状态栏计数与 herdr 阻塞态，三处一起收敛
            onStateChange: () => {
                this.renderTabBar();
                this.renderStatusBar();
                this.syncHerdrState();
            },
            flash: message => this.tui.flash(message),
            isCollapseKey: data => matchesKey(data, Key.ctrlShift("q")),
            createPanel: ({ questions, answers, submit, cancel, collapse }) => {
                const terminalRows = this.tui.terminal.rows || 24;
                const visibleRows = Math.max(3, Math.min(8, Math.floor(terminalRows * 0.3) - 2));
                return new QuestionPanel({ tui: this.tui, questions, answers, visibleRows, submit, cancel, collapse });
            },
        });

        // 终端前端提供的能力：提问通道 + MCP 通知（会话无关的通知按注册表广播）
        this.unregisterRuntime = registerSessionRuntime({
            ownsSession: sessionId => this.store.currentSessionId === sessionId
                || this.store.hasSessionView(sessionId)
                || this.store.sessions.some(session => session.sessionId === sessionId),
            askUser: (request, signal) => this.questions.ask(request, signal),
            notifyMcpNotice: notice => this.handleMcpNotice(notice),
        });

        this.modelMcp = new ModelMcpPanels({
            panels: this.panels,
            isExiting: () => this.exiting,
            currentSessionId: () => this.store.currentSessionId,
            isSessionBusy: sessionId => this.agent.isSessionBusy(sessionId),
            contentRows: () => panelContentRows(this.tui),
            openOverlay: (panel, kind) => openPanelOverlay(this.tui, panel, kind),
            afterPanelClosed: overlay => this.afterPanelClosed(overlay),
            requestRender: () => this.tui.requestRender(),
            logWheel: line => this.writeWheelLog(line),
            notify: (message, sessionId) => this.store.pushSystemMessage(message, sessionId),
            currentSelection: () => this.currentModelSelection,
            modelOptions: () => getChatModelOptions(),
            applyModel: (sessionId, selection, makeDefault) =>
                this.applyModelSelection(sessionId, selection, makeDefault),
            mcpServers: () => ({ servers: getMcpServersStatus(), helpText: buildMcpStatusHelpText() }),
            supportsToolSearch: () => {
                const settings = getChatApiSettings(this.currentModelSelection);
                return isToolSearchEnabled({
                    protocol: settings.protocol ?? "chat_completions",
                    model: settings.model,
                    baseURL: settings.apiBase,
                    hostedTools: settings.hostedTools,
                });
            },
            readLazyServers: sessionId => this.agent.getSessionLazyMcpServers(sessionId),
            saveLazyServers: (sessionId, servers) => this.agent.setSessionLazyMcpServers(sessionId, servers),
            createModelPanel: ({ options, current, visibleRows, close, complete }) => {
                const settings = getChatApiSettings(current);
                return new ModelPanel({
                    options,
                    // 强度也交给面板做默认高亮：目标模型支持就沿用，否则 auto
                    current: {
                        protocol: settings.protocol!,
                        model: settings.model,
                        reasoningEffort: effectiveReasoningEffort(current),
                    },
                    visibleRows,
                    close,
                    complete,
                });
            },
            createMcpPanel: input => new McpPanel(input),
        });

        this.restoreFocus();
        this.bindEditor();
        bindGlobalKeys(this.tui, this.createKeyHost());
        this.agent.onTurnFinished = (sessionId) => this.onAgentTurnFinished(sessionId);
        // 任务管理器是进程级单例：它的回调可能在 app 已退出后仍被触发，
        // 因此每个回调都先自查生命周期，绝不假定自身仍然有效。
        this.unsubscribeBackgroundTaskStart = backgroundTaskManager.onTaskStarted(() => {
            if (!this.isLive()) return;
            // 任务数变化要立刻可见，否则状态栏只在 spinner 心跳时才刷新
            this.renderStatusBar();
        });
        this.unsubscribeBackgroundTaskCompletion = backgroundTaskManager.onTaskCompleted(task => {
            if (!this.isLive()) return;
            // 回调运行在任务管理器的异步边界上，任何异常都会逃逸成未处理拒绝，
            // 进而打乱宿主（尤其是测试）的后续流程，因此整体兜底。
            try {
                this.handleBackgroundTaskCompleted(task);
            } catch (error) {
                console.error("⚠️ [TUI] 处理后台任务完成通知失败:", error);
            }
        });
    }

    /**
     * `skipInitialView` 供 CLI 恢复会话：启动时不弹会话选择面板、不推「请选择会话」提示，
     * 由 `openResumedSession` 直接切到目标会话。
     * `autoNewSession` 供普通启动：直接新建一个空会话并进入（历史会话仍可用 ⌘P 打开）。
     */
    async init(
        startupMessage?: string,
        options: { skipInitialView?: boolean; autoNewSession?: boolean } = {},
    ): Promise<void> {
        // 恢复上次退出前各会话的输入草稿（切回对应会话时填回输入框）
        for (const [sessionId, draft] of loadRichDrafts()) {
            this.drafts.set(sessionId, typeof draft === "string" ? draft : draft.text, typeof draft === "string" ? [] : draft.images);
        }
        this.agent.onEvent = (requestId, sessionId, event) => {
            this.store.applyEvent(requestId, sessionId, event);

            switch (event.type) {
                case "steer_update":
                    if (event.phase === "accepted" || event.phase === "failed") {
                        if (this.pending.updateSteerStatus(sessionId, event.responseId, event.phase)
                            && sessionId === this.store.currentSessionId) this.renderPending();
                    }
                    break;
                case "turn_start":
                    this.setSessionPhase(sessionId, "waiting");
                    // 群消息/续跑等不经 send() 的回合也要让 herdr 立刻看到 working
                    this.syncHerdrState();
                    break;
                case "progress":
                    if (event.message) this.setSessionProgress(sessionId, event.message);
                    else this.clearSessionPhase(sessionId);
                    break;
                case "reasoning_delta":
                    this.setSessionPhase(sessionId, "reasoning");
                    break;
                case "text_delta":
                    this.setSessionPhase(sessionId, "generating");
                    break;
                case "tool_start":
                    this.setSessionPhase(sessionId, "tool", event.name);
                    break;
                case "tool_result":
                    this.setSessionPhase(sessionId, "waiting");
                    if (this.detailed && sessionId === this.store.currentSessionId && isAskUserTool(event.name)) {
                        this.scheduleSyncMessages();
                    }
                    // todo 工具写盘后强制失效缓存，避免状态栏进度滞后
                    if (event.name === "todo") this.todoCache = null;
                    break;
                case "message_end":
                    this.clearSessionPhase(sessionId);
                    break;
                case "aborted":
                case "error":
                    this.clearSessionPhase(sessionId);
                    break;
            }
        };

        // listeners 与 TUI 提前就位：异步加载会话期间输入立即可用、渲染立即生效
        this.store.setListeners({
            onMessagesChanged: () => {
                // 展开模式（Ctrl+O）下若正在生成，不频繁刷新后续流式更新，避免大规模重绘导致终端卡顿
                if (this.detailed && this.turnState.phase(this.store.currentSessionId)) return;
                this.scheduleSyncMessages();
            },
            onSessionsChanged: () => this.renderTabBar(),
            onStatusChanged: () => this.renderStatusBar(),
        });
        this.terminalStarted = true;
        // 钩子必须在 start() 之前挂：start() 中途抛错时终端同样已被改过模式
        installTerminalExitGuard();
        this.tui.start();

        this.renderStatusBar();
        try {
            await this.refreshSessions();
            // 先取一份归属快照，面板首帧就能显示 ●/◎/◌ 与他实例的忙闲
            void this.ownership.refresh(true);
            if (!options.skipInitialView) {
                if (options.autoNewSession) await this.startInitialSession();
                else this.openInitialView();
            }
            this.renderStatusBar();
        } catch (error: any) {
            this.store.pushSystemMessage(`⚠️ TUI 初始化失败：${error?.message ?? error}`);
            this.renderStatusBar();
        }

        this.agent.onSessionReleased = (sessionId, cause) => {
            void this.handleSessionReleased(sessionId, cause);
        };
        this.agent.onSessionSpawned = (sessionId, title) => {
            void this.handleSessionSpawned(sessionId, title);
        };
        // cwd 工具 / /cwd 改写会话目录：状态栏与工具基准一起换，会话面板的目录列也跟着刷新
        this.agent.onSessionCwdChanged = (sessionId, cwd) => {
            this.handleSessionCwdChanged(sessionId, cwd);
        };
        // 标题可能由控制通道（命令行 rename）改写：回调里补上 tab 栏与 herdr 元数据
        this.agent.onSessionRenamed = (sessionId, title) => {
            this.handleSessionRenamed(sessionId, title);
        };
        this.agent.onSessionWoken = sessionId => {
            void this.handleSessionWoken(sessionId);
        };

        if (startupMessage) {
            this.store.pushSystemMessage(startupMessage);
        }

        this.syncHerdrState();
        this.syncHerdrMetadata();
    }

    /**
     * 启动期阻断（provider 配置无效等）：herdr 侧一直显示 blocked 并带原因。
     * 该阻断不会在运行期解除，后续 sync 会优先保持 blocked。
     */
    setHerdrBlocked(reason: string): void {
        this.herdrBlock = reason;
        this.syncHerdrState();
    }

    /** 是否有任何会话在跑：turn 阶段、压缩/续跑与 send 中的回合一起算（不含 clearing/switching 等纯 UI 占位）。 */
    private hasActiveTurn(): boolean {
        return this.activeTurnSessions.size > 0 || this.turnState.hasModelActivity();
    }

    /**
     * 把本实例的聚合状态上报给 herdr：阻塞 > 运行中 > 空闲。
     * herdr 的 agent 状态是 pane 级，多会话并行时必须看全体而不是刚结束的那个会话。
     */
    private syncHerdrState(): void {
        const block = this.herdrBlock ?? this.questions.blockedMessage();
        if (block) {
            herdrReporter.report("blocked", block);
            return;
        }
        herdrReporter.report(this.hasActiveTurn() ? "working" : "idle");
    }

    /** 当前会话的展示元数据：标题 + 显示名 + model/session token。 */
    private syncHerdrMetadata(): void {
        const sessionId = this.store.currentSessionId;
        const session = sessionId
            ? this.store.sessions.find(item => item.sessionId === sessionId)
            : undefined;
        const model = this.currentModelSelection?.model
            ?? getChatApiSettings(this.currentModelSelection).model;
        herdrReporter.reportMetadata({
            title: session?.title ?? null,
            displayAgent: "zbot",
            tokens: {
                model: model || null,
                session: sessionId ? sessionId.slice(-8) : null,
            },
        });
    }

    private bindEditor(): void {
        this.editor.onSubmitWithImages = (value: string, images: ImageAssetRef[]) => {
            if (this.exiting) return;
            const renameTarget = this.renameSessionId;
            if (renameTarget) {
                void this.commitRename(renameTarget, value);
                return;
            }

            // 命令判定看原文：前导空格、空串都按普通文本处理（契约与 session send 一致）
            const isCommand = value.startsWith("/");
            const text = value.trim() || (images.length > 0 ? "请分析所附图片。" : "");
            if (this.store.currentSessionId) {
                this.dropDraft(this.store.currentSessionId);
            }
            if (!text) return;
            if (isCommand) {
                void this.handleCommand(value, images);
                return;
            }
            this.enqueueOrSend(text, images);
        };
    }

    /** busy 时把消息入队待发（在下次迭代请求前附加消费）；空闲时直接 send。无会话时先新建再发。 */
    enqueueOrSend(text: string, images: ImageAssetRef[] = []): void {
        const sessionId = this.store.currentSessionId;
        if (!sessionId) {
            void this.startSessionWith(text, images);
            return;
        }
        if (this.isSessionArchived(sessionId)) return;
        this.recordSubmittedInput(sessionId, text);
        const isBusy = this.runtimeReloading
            || this.switching
            || this.turnState.isBusy(sessionId)
            || (sessionId ? this.agent.isSessionBusy(sessionId) : false);
        const message: PendingMessage = {
            text,
            images,
            ...(images.length === 0 && this.agent.steerResponse ? { steer: { state: "sending" as const } } : {}),
        };
        if (isBusy) {
            this.pending.push(sessionId, message);
            if (images.length === 0) {
                void this.agent.steerResponse?.(sessionId, text, () => {
                    if (!this.pending.removeMessage(sessionId, message)) return;
                    this.store.addPendingUserMessage(text, sessionId);
                    if (sessionId === this.store.currentSessionId) {
                        this.renderPending();
                        if (!this.detailed) this.scrollView.scrollToEnd();
                    }
                }).then(accepted => {
                    if (!accepted && typeof message !== "string" && message.steer?.state === "sending") {
                        message.steer.state = "queued";
                        if (sessionId === this.store.currentSessionId) this.renderPending();
                    }
                }).catch(error => {
                    if (typeof message !== "string" && message.steer) message.steer.state = "failed";
                    if (sessionId === this.store.currentSessionId) this.renderPending();
                    this.tui.flash(`⚠️ Steer 失败，消息仍在待发队列：${error instanceof Error ? error.message : String(error)}`);
                });
            }
            if (!sessionId || sessionId === this.store.currentSessionId) {
                this.renderPending();
            }
            return;
        }
        if (!this.pending.isEmpty(sessionId)) {
            this.pending.push(sessionId, message);
            this.sendNextPending(sessionId);
            return;
        }
        void this.send(text, sessionId, images);
    }

    private recordSubmittedInput(sessionId: string, text: string): void {
        this.editor.addToHistory(text);
        void this.agent.appendInputHistory(sessionId, text, new Date().toISOString()).catch((error: unknown) => {
            this.tui.flash(`⚠️ 保存输入历史失败：${error instanceof Error ? error.message : String(error)}`);
        });
    }

    /**
     * 渲染 pending 堆栈：空队列时清空；否则第一行 header ⏵ N pending (i/N) · 提示，
     * 之后每条消息独占一行，选中行用 > 前缀和高亮样式；超出 PENDING_MAX_VISIBLE 时
     * 仅围绕 pendingIndex 居中窗口化显示。
     */
    renderPending(): void {
        this.pendingList.clear();
        const sessionId = this.store.currentSessionId;
        const total = this.pending.count(sessionId);
        if (total === 0) {
            this.layout.setMinSize(this.pendingList, 0);
            this.tui.requestRender();
            return;
        }
        const views = this.pendingRowViews();
        const width = process.stdout.columns > 0 ? process.stdout.columns : 80;
        const header = `⏵ ${total} pending (${this.pending.index(sessionId) + 1}/${total})  ·  ⌥↑/⌥↓ 选择  ⌥⌫ 删除`;
        this.pendingList.addChild(new Text(theme.dim(truncateToWidth(header, width, "…")), 0, 0));
        for (const view of views) {
            const status = view.status ? {
                sending: "切入中",
                accepted: "已接收",
                failed: "切入失败",
                queued: "待发",
            }[view.status] : "";
            const textWidth = Math.max(0, width - visibleWidth(view.prefix) - visibleWidth(status) - (status ? 2 : 1));
            const preview = truncatePlain(view.text, textWidth);
            const left = `${view.prefix} ${preview}`;
            const line = status
                ? `${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(status)))}${status}`
                : left;
            const styled = view.selected
                ? theme.tabActive(truncateToWidth(line, width, "…"))
                : theme.dim(truncateToWidth(line, width, "…"));
            this.pendingList.addChild(new Text(styled, 0, 0));
        }
        // 可见行 = header + 实际显示的消息行数（窗口化后取可见行数）
        this.layout.setMinSize(this.pendingList, 1 + views.length);
        this.tui.requestRender();
    }

    /** 计算 pending 队列当前可见行的视图（窗口化规则在 PendingQueue 内）。 */
    private pendingRowViews(): Array<{ prefix: string; selected: boolean; text: string; status?: "sending" | "accepted" | "failed" | "queued" }> {
        const sessionId = this.store.currentSessionId;
        const messages = this.pending.messages(sessionId);
        return this.pending
            .window(sessionId, ChatApp.PENDING_MAX_VISIBLE, message => this.formatPendingInput(message))
            .map(view => ({
                prefix: view.selected ? `> ${view.ordinal})` : `  ${view.ordinal})`,
                selected: view.selected,
                text: view.text,
                status: typeof messages[view.ordinal - 1] === "string"
                    ? undefined
                    : (messages[view.ordinal - 1] as Exclude<PendingMessage, string>)?.steer?.state,
            }));
    }

    /** 清空 pending 队列（会话清空/新建/关闭/删除/退出时使用）。 */
    clearPending(sessionId: string | null = this.store.currentSessionId): void {
        if (this.pending.isEmpty(sessionId)) return;
        this.pending.clear(sessionId);
        if (!sessionId || sessionId === this.store.currentSessionId) {
            this.renderPending();
        }
    }

    /** 按索引删除 pending 消息（越界返回 false），由 Backspace 键调用。 */
    deletePending(index: number, sessionId: string | null = this.store.currentSessionId): boolean {
        if (!this.pending.removeAt(sessionId, index)) return false;
        if (!sessionId || sessionId === this.store.currentSessionId) {
            this.renderPending();
        }
        return true;
    }
    /**
     * 斜杠命令：先经共享解析层判定（完整命令名 + 参数校验）。
     * 未知 `/xxx` 按普通文本交给模型；已识别但参数非法则报明确错误。
     */
    private async handleCommand(raw: string, images: ImageAssetRef[] = []): Promise<void> {
        const parsed = parseSlashCommand(raw);
        if (parsed.kind === "text") {
            // 普通文本与编辑器提交口径一致：去掉首尾空白后再交给模型
            this.enqueueOrSend(raw.trim(), images);
            return;
        }
        if (parsed.kind === "invalid") {
            const sessionId = this.store.currentSessionId;
            if (sessionId) this.recordSubmittedInput(sessionId, raw.trim());
            else this.editor.addToHistory(raw.trim());
            this.store.pushSystemMessage(parsed.message, sessionId ?? undefined);
            this.editor.setText("");
            this.restoreFocus();
            return;
        }

        const sessionId = this.store.currentSessionId;
        const { name, args } = parsed;
        // /review 等价于用户直接输入评审指令：附加说明拼在固定指令后面一起送给模型
        if (name === "/review") {
            this.editor.setText("");
            this.enqueueOrSend(buildReviewPrompt(args[0]));
            this.restoreFocus();
            return;
        }
        if (sessionId) this.recordSubmittedInput(sessionId, raw.trim());
        else this.editor.addToHistory(raw.trim());
        if (!sessionId && SESSION_REQUIRED_COMMANDS.has(name)) {
            this.editor.setText("");
            this.tui.flash("没有打开的会话：直接输入消息即新建，或 ⌃N");
            return;
        }
        switch (name) {
            case "/new":
                await this.newSession();
                break;
            case "/sessions":
                if (args[0]) this.showSessionMatches(args[0]);
                else this.openSessionPanel();
                break;
            case "/tasks":
                await this.showBackgroundTasks(args, sessionId);
                break;
            case "/ps":
                this.showProcesses(sessionId);
                break;
            case "/stop":
                await this.stopWork(args, sessionId);
                break;
            case "/reload":
                await this.requestRuntimeReload(sessionId);
                break;
            case "/keys":
                this.openShortcutPanel();
                break;
            case "/clear":
                await this.clearCurrentSession();
                break;
            case "/delete":
                await this.deleteCurrentSession();
                break;
            case "/close":
                await this.closeCurrentSession();
                break;
            case "/archive":
                await this.archiveCurrentSession();
                break;
            case "/unarchive":
                await this.unarchiveCurrentSession();
                break;
            case "/compact":
                await this.compactCurrent(args[0]);
                break;
            case "/cwd":
                await this.changeCwd(args[0] ?? "");
                break;
            case "/continue":
                await this.continueCurrent();
                break;
            case "/system":
                await this.showSystemPrompt();
                break;
            case "/skills":
                this.store.pushSystemMessage(buildSkillsHelpText(), sessionId ?? undefined);
                break;
            case "/mcp":
                if (args.length > 0) {
                    await this.applyMcpToggle(args, sessionId ?? undefined);
                } else if (sessionId) {
                    this.modelMcp.openMcp(sessionId);
                } else {
                    this.store.pushSystemMessage(buildMcpStatusHelpText());
                }
                break;
            case "/model":
                if (args.length === 0) {
                    this.modelMcp.openModel(sessionId!);
                } else if (args[0] === "effort") {
                    await this.handleEffortCommand(args.slice(1), sessionId ?? undefined);
                } else {
                    await this.applyModelCommand(args, sessionId ?? undefined);
                }
                break;
            case "/help":
                this.store.pushSystemMessage(buildHelpText(), sessionId ?? undefined);
                break;
            default:
                // 解析层只放行已知命令；这里兜底未接入的实现
                this.store.pushSystemMessage(`命令 ${name} 尚未接入 TUI。`, sessionId ?? undefined);
        }
        if (sessionId) {
            this.dropDraft(sessionId);
        }
        this.editor.setText("");
        this.restoreFocus();
    }

    private async handleEffortCommand(args: string[], sessionId?: string): Promise<void> {
        const raw = args[0];
        const view = describeModelView(this.currentModelSelection);
        const choices = view.efforts;
        const currentEffort = effectiveReasoningEffort(this.currentModelSelection);

        if (raw === undefined) {
            this.store.pushSystemMessage([
                `当前思考强度: ${currentEffort}`,
                `用法: /model effort <${choices.join("|")}>`,
                "说明:",
                "  - auto: 不传思考强度参数，由上游服务端按默认配置处理",
                "  - 其他值会按当前协议和厂家直接发送给上游",
            ].join("\n"), sessionId);
            return;
        }

        const resolved = resolveEffort(raw, choices);
        if (!resolved.ok) {
            this.store.pushSystemMessage(`⚠️ ${resolved.error}`, sessionId);
            return;
        }
        const normalized = resolved.effort;
        if (sessionId) {
            const selection: ChatModelSelection = {
                protocol: view.current.protocol as ChatModelSelection["protocol"],
                model: view.current.model,
                reasoningEffort: normalized,
            };
            try {
                await this.persistModelSelection(sessionId, selection);
                this.currentModelSelection = selection;
                const sessionSummary = this.store.sessions.find(session => session.sessionId === sessionId);
                if (sessionSummary) sessionSummary.modelSelection = selection;
                this.store.pushSystemMessage(normalized === "auto"
                    ? "🧠 当前会话思考强度已设为 auto（不传参数，使用服务端默认）"
                    : `🧠 当前会话思考强度已设置为: ${normalized}`,
                sessionId);
            } catch (error: any) {
                this.store.pushSystemMessage(`思考强度设置保存失败：${error?.message ?? String(error)}`, sessionId);
            }
        } else if (normalized === "auto") {
            delete process.env.REASONING_EFFORT;
            delete process.env.OPENAI_REASONING_EFFORT;
            delete process.env.DEEPSEEK_REASONING_EFFORT;
            this.store.pushSystemMessage("🧠 思考强度已重置为 auto（不传思考强度参数，走服务端默认）", sessionId);
        } else {
            process.env.REASONING_EFFORT = normalized;
            this.store.pushSystemMessage(`🧠 思考强度已设置为: ${normalized}`, sessionId);
        }

        this.renderStatusBar();
    }

    /** 模型/强度落盘：优先立即写事件（进程退出不丢），前端替身退回 pending 语义。 */
    private async persistModelSelection(sessionId: string, selection: ChatModelSelection): Promise<void> {
        if (this.agent.setSessionModelSelectionNow) {
            await this.agent.setSessionModelSelectionNow(sessionId, selection);
            return;
        }
        await this.agent.setSessionModelSelection(sessionId, selection);
    }

    private async applyModelSelection(
        sessionId: string,
        selection: ChatModelSelection,
        makeDefault: boolean,
    ): Promise<void> {
        const previousEffort = effectiveReasoningEffort(this.currentModelSelection);
        // 与命令行同一条保留规则：新模型支持原档位才保留，否则回落 auto（含环境变量里的档位）
        const selected: ChatModelSelection = {
            ...selection,
            reasoningEffort: selection.reasoningEffort
                ?? preserveEffort(previousEffort, selection.protocol, selection.model),
        };
        try {
            await this.persistModelSelection(sessionId, selected);
        } catch (error: any) {
            this.modelMcp.closeModel();
            this.store.pushSystemMessage(`模型设置保存失败：${error?.message ?? String(error)}`, sessionId);
            return;
        }

        this.currentModelSelection = selected;
        const sessionSummary = this.store.sessions.find(session => session.sessionId === sessionId);
        if (sessionSummary) sessionSummary.modelSelection = selected;
        this.syncHerdrMetadata();
        // 换到可用模型后解除启动期阻断，否则 herdr 会一直显示 blocked
        if (this.herdrBlock && !validateChatApiSettings(getChatApiSettings(selected))) {
            this.herdrBlock = undefined;
            this.syncHerdrState();
        }
        let defaultFailure: string | undefined;
        if (makeDefault) {
            try {
                await setDefaultChatModelOption(selected);
            } catch (error: any) {
                defaultFailure = error?.message ?? String(error);
            }
        }

        this.modelMcp.closeModel();
        this.renderStatusBar();
        const effortLabel = selected.reasoningEffort ? `，思考强度 ${selected.reasoningEffort}` : "";
        this.store.pushSystemMessage(defaultFailure
            ? `当前会话模型已切换为 ${selected.protocol} · ${selected.model}${effortLabel}；设置默认模型失败：${defaultFailure}`
            : `当前会话模型已切换为 ${selected.protocol} · ${selected.model}${effortLabel}${makeDefault ? "，并设为默认" : ""}`,
        sessionId);
    }

    /** /model <协议> <模型> [强度|auto]：与面板走同一条落盘路径（不复制业务逻辑）。 */
    private async applyModelCommand(args: string[], sessionId?: string): Promise<void> {
        if (!sessionId) {
            this.tui.flash("没有打开的会话");
            return;
        }
        const [protocol, model, effort] = args;
        // 与 session send 同一条解析：按**目标模型**的档位校验并归一化强度；
        // "当前档位"要含环境变量（否则切模型会把 REASONING_EFFORT 静默变成 auto）
        const resolved = resolveModelUse(
            getChatModelOptions(),
            protocol,
            model,
            effort,
            effectiveReasoningEffort(this.currentModelSelection),
        );
        if (!resolved.ok) {
            this.store.pushSystemMessage(resolved.error, sessionId);
            return;
        }
        await this.applyModelSelection(sessionId, resolved.selection, false);
    }

    /** /mcp enable|disable <服务名>：面板勾选的非交互等价入口。 */
    private async applyMcpToggle(args: string[], sessionId?: string): Promise<void> {
        const [action, name] = args;
        if (!sessionId) {
            this.tui.flash("没有打开的会话");
            return;
        }
        if (this.agent.isSessionBusy(sessionId)) {
            this.tui.flash("会话执行中，暂不能调整 lazy MCP 工具的下发");
            return;
        }
        const servers = getMcpServersStatus();
        if (!name || !servers.some(server => server.name === name)) {
            this.store.pushSystemMessage(
                `没有这个 MCP 服务：${name ?? "（缺失）"}。可选：${servers.map(server => server.name).join(" | ") || "（无）"}`,
                sessionId,
            );
            return;
        }
        try {
            const enabled = await this.agent.getSessionLazyMcpServers(sessionId);
            const next = action === "enable"
                ? [...new Set([...enabled, name])]
                : enabled.filter(server => server !== name);
            await this.agent.setSessionLazyMcpServers(sessionId, next);
            this.store.pushSystemMessage(
                action === "enable" ? `已为本会话启用 lazy MCP：${name}` : `已为本会话停用 lazy MCP：${name}`,
                sessionId,
            );
        } catch (error: any) {
            this.store.pushSystemMessage(`MCP 选择保存失败：${error?.message ?? String(error)}`, sessionId);
        }
    }

    /** /sessions <查询>：面板的文本视图（面板本身只按键盘搜索，参数不能被静默丢掉）。 */
    private showSessionMatches(query: string): void {
        const keyword = query.trim().toLowerCase();
        const matched = this.store.sessions.filter(session => [session.sessionId, session.title ?? "", session.cwd ?? ""]
            .some(field => field.toLowerCase().includes(keyword)));
        if (matched.length === 0) {
            this.store.pushSystemMessage(`没有匹配「${query}」的会话`);
            return;
        }
        const lines = matched.map(session => [
            `- ${session.sessionId}`,
            session.title ? `「${session.title}」` : "",
            `· ${session.messageCount} 轮`,
            session.archived ? "· 已归档" : "",
            session.cwd ? `· ${formatDisplayPath(session.cwd)}` : "",
        ].filter(Boolean).join(" "));
        this.store.pushSystemMessage(`匹配「${query}」的会话（${matched.length} 个）：\n${lines.join("\n")}`);
    }

    private async showSystemPrompt(): Promise<void> {
        const sessionId = this.store.currentSessionId;
        if (!sessionId) return;

        try {
            const systemPrompt = await this.agent.getSystemPrompt(sessionId);
            this.store.pushSystemMessage(`当前 system prompt：\n\n${systemPrompt || "（空）"}`, sessionId);
            this.scrollView.scrollToEnd();
        } catch (error: any) {
            this.store.pushSystemMessage(`⚠️ system prompt 读取失败: ${error.message}`, sessionId);
        }
    }

    private async clearCurrentSession(): Promise<void> {
        const sessionId = this.store.currentSessionId;
        if (!sessionId || this.agent.isSessionBusy(sessionId)) return;
        // 清空事件日志前丢弃 pending 和草稿，避免队列锚到已被截断的 turn。
        this.clearPending(sessionId);
        this.dropDraft(sessionId);
        this.editor.clearSessionPastes(sessionId);
        this.editor.setText("");
        const clearedSummary = this.store.sessions.find(session => session.sessionId === sessionId);
        if (clearedSummary) clearedSummary.title = undefined;
        this.turnState.lock(sessionId, "clearing");
        this.syncSubmitState();
        try {
            await this.agent.clearSession(sessionId);
            this.clearMessages();
            this.store.loadHistory([], sessionId);
            this.scrollView.scrollToEnd();
            this.store.pushSystemMessage("🗑️ 已清空当前会话", sessionId);
        } catch (error: any) {
            this.store.pushSystemMessage(`⚠️ 清空失败: ${error.message}`, sessionId);
        } finally {
            this.turnState.unlock(sessionId, "clearing");
            this.syncSubmitState();
            this.restoreFocus();
        }
    }

    /**
     * 彻底删除会话（任意会话）：删掉事件日志、快照与 console 日志；返回是否真的删掉。
     *
     * `onlyIfEmpty` 供 `/close` 用：先让宿主「判空 + 删除」一次完成，没命中（有内容/正忙/
     * 已被接管）就原样返回 false，UI 与持有权都不动，调用方继续走正常关闭流程。
     */
    private async deleteSessionById(
        sessionId: string,
        options: { flashText?: string; onlyIfEmpty?: boolean } = {},
    ): Promise<boolean> {
        if (this.agent.isSessionBusy(sessionId)) {
            this.tui.flash("会话执行中，暂不能删除");
            return false;
        }
        if (options.onlyIfEmpty) {
            const deleteIfEmpty = (this.agent as Partial<SessionHost>).deleteSessionIfEmpty;
            if (typeof deleteIfEmpty !== "function") return false;
            try {
                if (!await deleteIfEmpty.call(this.agent, sessionId)) return false;
            } catch (error: any) {
                this.store.pushSystemMessage(`⚠️ 删除空会话失败: ${error.message}`);
                return false;
            }
        }
        const isCurrent = this.store.currentSessionId === sessionId;
        let hasDeleted = false;
        this.pending.clear(sessionId);
        this.dropDraft(sessionId);
        this.editor.clearSessionPastes(sessionId);
        if (isCurrent) {
            this.turnState.lock(sessionId, "clearing");
            this.syncSubmitState();
            setLogSession(null);
        }
        try {
            // onlyIfEmpty 已在上面由宿主删掉；其余情况在这里删
            if (!options.onlyIfEmpty) await this.agent.deleteSession(sessionId);
            hasDeleted = true;
            this.agent.releaseSession(sessionId, { cause: "delete" });
            void this.ownership.refresh(true);
            this.store.removeSessionView(sessionId);
            this.store.sessions = this.store.sessions.filter(session => session.sessionId !== sessionId);
            this.store.setSessions(this.store.sessions);

            if (isCurrent) {
                await this.fallbackToClaimedSession();
            } else {
                this.renderTabBar();
            }
            this.tui.flash(options.flashText ?? "🗑️ 已删除会话");
            return true;
        } catch (error: any) {
            if (isCurrent && !hasDeleted) setLogSession(sessionId);
            this.store.pushSystemMessage(`⚠️ 删除失败: ${error.message}`);
            return false;
        } finally {
            if (isCurrent) {
                this.turnState.unlock(sessionId, "clearing");
                this.syncSubmitState();
                this.restoreFocus();
            }
        }
    }

    /** 当前会话消失（删除/归档/被接管）后的落点：优先切到另一个已持有会话，否则退回未选中。 */
    private async fallbackToClaimedSession(): Promise<void> {
        const next = this.claimedSessions().find(session => session.sessionId !== this.store.currentSessionId);
        if (next) {
            await this.selectSession(next.sessionId);
            return;
        }

        this.store.setCurrentSession(null);
        this.currentModelSelection = undefined;
        this.syncHerdrMetadata();
        this.clearMessages();
        this.renderTabBar();
        this.syncCurrentSessionState();
    }

    private async deleteCurrentSession(): Promise<void> {
        const sessionId = this.store.currentSessionId;
        if (!sessionId) return;
        await this.deleteSessionById(sessionId);
    }

    /** 全局快捷键宿主适配：把内部状态收敛成语义操作，交给 keybindings.ts 的键位表。 */
    private createKeyHost(): GlobalKeyHost {
        return {
            handlePanelInput: (data) => this.handlePanelInput(data),
            isRenaming: () => this.renameSessionId !== null,
            cancelRename: () => this.cancelRename(),
            openSessionPanel: () => this.openSessionPanel(),
            openShortcutPanel: () => this.openShortcutPanel(),
            toggleQuestionPanel: () => this.questions.toggle(),
            continueCurrent: () => { void this.continueCurrent(); },
            editorText: () => this.editor.getText(),
            pendingCount: () => this.pending.count(this.store.currentSessionId),
            pendingIndex: () => this.pending.index(this.store.currentSessionId),
            setPendingIndex: (index) => { this.pending.setIndex(this.store.currentSessionId, index); },
            renderPending: () => this.renderPending(),
            deletePending: (index) => { this.deletePending(index); },
            isDetailed: () => this.detailed,
            scrollPage: (direction) => {
                const page = Math.max(1, this.scrollView.viewportHeight - 1);
                this.tui.scrollBy(direction * page);
            },
            requestExitWithConfirm: (label) => this.requestExitWithConfirm(label),
            newSession: () => { void this.newSession(); },
            requestConfirm: (label, run) => this.requestConfirm(label, run),
            requireSession: () => this.requireSession(),
            deleteCurrentSession: () => { void this.deleteCurrentSession(); },
            selectSessionTab: (index) => this.selectSessionTab(index),
            renameCurrentSession: () => this.renameCurrentSession(),
            toggleDetailed: () => this.toggleDetailed(),
            toggleDiffDetail: () => this.toggleDiffDetail(),
            expandDiffDetail: () => this.expandDiffDetail(),
            switchSession: (delta, includeArchived) => { void this.switchSession(delta, includeArchived); },
            isInterruptible: () => this.isInterruptible(),
            detachCurrentWork: () => this.detachCurrentWork(),
            isCurrentBusy: () => this.isCurrentBusy(),
            abortCurrent: () => { void this.abortCurrent(); },
            flash: (text) => this.tui.flash(text),
        };
    }

    /** 面板打开时独占键盘输入；返回 true 表示已消费。 */
    private handlePanelInput(data: string): boolean {
        if (this.panels.isEmpty) return false;
        // 面板外的滚轮不转给面板：让视口继续滚动，避免误滚面板内容
        if (this.isWheelOutsidePanel(data)) {
            this.tui.requestRender();
            return true;
        }

        const consumed = this.panels.routeInput(data);
        this.tui.requestRender();
        return consumed;
    }

    /**
     * 交由聊天视口处置的输入。
     *
     * 翻页键一律下沉；滚轮只在下沉到"面板外"时才下沉——
     * 面板内的滚轮仍归面板（列表要能滚），面板外的滚轮不该带动面板。
     * isWheelOutsidePanel 已在前面处理过"面板外"的情况，能走到这里的滚轮都在面板内。
     */
    private isScrollKey(data: string): boolean {
        return matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown);
    }

    /** Ctrl+1..9：选中会话条上从左到右第 N 个可见 tab（所见即所得）。 */
    private selectSessionTab(index: number): void {
        const sessionId = this.tabVisibleIds[index];
        if (!sessionId) {
            this.tui.flash(`没有第 ${index + 1} 个会话（⌘P 打开会话面板）`);
        } else if (sessionId !== this.store.currentSessionId) {
            void this.selectSession(sessionId);
        }
    }

    /** ⌘R：重命名当前会话标题；无会话时提示。 */
    private renameCurrentSession(): void {
        const currentId = this.store.currentSessionId;
        if (currentId) void this.beginRename(currentId);
        else this.requireSession();
    }

    /** ⌃B：优先把当前 shell 放入后台，其次把会话间等待放入后台。 */
    private detachCurrentWork(): boolean {
        const sessionId = this.store.currentSessionId;
        if (!sessionId) return false;

        const detachedTasks = backgroundTaskManager.detachForeground(sessionId);
        if (detachedTasks > 0) {
            this.tui.flash(`已将 ${detachedTasks} 个 shell 命令放入后台：模型可用 background_task 查询、等待或终止`);
            return true;
        }

        if (this.agent.detachPeerWaits(sessionId) === 0) return false;

        this.tui.flash("已把等待中的结果放到后台：到达后自动继续");
        return true;
    }

    /** 列出当前会话运行中的后台 shell 任务。 */
    private showProcesses(sessionId: string | null): void {
        if (!sessionId) {
            this.store.pushSystemMessage("没有打开的会话，无法查看后台任务");
            return;
        }

        const running = backgroundTaskManager.list(sessionId).filter(task => task.status === "running");
        if (running.length === 0) {
            this.store.pushSystemMessage("没有正在运行的后台任务", sessionId);
            return;
        }

        const lines = [`后台任务（${running.length} 个运行中）：`, ""];
        for (const task of running.slice(0, MAX_SHOWN_BACKGROUND_TASKS)) {
            const command = truncatePlain(task.command, MAX_TASK_TEXT_COLUMNS);
            const elapsed = formatElapsed(task.startedAt);
            lines.push(`  • ${task.id}${elapsed ? ` · ${elapsed}` : ""}  ${command}`);

            const stdoutLine = task.stdout?.trim().split(/\r\n|\r|\n/).at(-1);
            const stderrLine = task.stderr?.trim().split(/\r\n|\r|\n/).at(-1);
            if (stdoutLine) lines.push(`    ↳ ${truncatePlain(stdoutLine, MAX_TASK_TEXT_COLUMNS)}`);
            if (stderrLine) lines.push(`    ↳ 错误：${truncatePlain(stderrLine, MAX_TASK_TEXT_COLUMNS - 6)}`);
        }

        if (running.length > MAX_SHOWN_BACKGROUND_TASKS) {
            lines.push(`  …还有 ${running.length - MAX_SHOWN_BACKGROUND_TASKS} 个任务`);
        }
        lines.push("", "使用 /stop <task_id> 终止指定任务，/stop 终止全部");
        this.store.pushSystemMessage(lines.join("\n"), sessionId);
    }

    /** 终止当前会话的后台任务；无参数或 all 终止全部运行中的任务。 */
    private async stopWork(args: string[], sessionId: string | null): Promise<void> {
        const target = args[0]?.trim().toLowerCase();
        if (!sessionId) {
            this.store.pushSystemMessage("没有打开的会话，无法终止后台任务");
            return;
        }

        if (!target || target === "all") {
            const running = backgroundTaskManager.list(sessionId).filter(task => task.status === "running");
            if (running.length === 0) {
                this.store.pushSystemMessage("没有正在运行的后台任务", sessionId);
                return;
            }
            let stopped = 0;
            for (const task of running) {
                if (backgroundTaskManager.stop(task.id, sessionId)) stopped += 1;
            }
            this.store.pushSystemMessage(`已请求终止 ${stopped} 个后台任务`, sessionId);
            return;
        }

        const task = backgroundTaskManager.get(target, sessionId);
        if (!task) {
            this.store.pushSystemMessage(`后台任务不存在或不属于当前会话：${target}`, sessionId);
            return;
        }
        const wasRunning = backgroundTaskManager.stop(target, sessionId);
        this.store.pushSystemMessage(
            wasRunning ? `已请求终止后台任务 ${target}` : `后台任务 ${target} 当前状态：${task.status}`,
            sessionId,
        );
    }

    private async showBackgroundTasks(args: string[], sessionId: string | null): Promise<void> {
        const [rawAction, taskId, rawWaitSeconds] = args;
        const action = (rawAction ?? "list").toLowerCase();
        const scope = sessionId ?? undefined;

        if (action === "list") {
            const tasks = backgroundTaskManager.list(scope);
            if (tasks.length === 0) {
                this.store.pushSystemMessage("当前没有后台任务", sessionId ?? undefined);
                return;
            }
            const lines = tasks.map(task => {
                const command = task.command.replace(/\s+/g, " ").trim();
                const suffix = task.status === "running" ? "运行中" : task.status;
                return `- ${task.id} [${suffix}] ${command}`;
            });
            this.store.pushSystemMessage(`后台任务：\n${lines.join("\n")}\n\n用法：/tasks status|wait|stop <task_id>`, sessionId ?? undefined);
            return;
        }

        if (!taskId) {
            this.store.pushSystemMessage(`/tasks ${action} 需要 task_id；用法：/tasks ${action} <task_id>`, sessionId ?? undefined);
            return;
        }

        if (action === "status") {
            const task = backgroundTaskManager.get(taskId, scope);
            this.store.pushSystemMessage(task ? formatBackgroundTaskDetails(task) : `后台任务不存在或不属于当前会话：${taskId}`, sessionId ?? undefined);
            return;
        }

        if (action === "wait") {
            const parsedSeconds = Number(rawWaitSeconds);
            const waitSeconds = Number.isFinite(parsedSeconds) && parsedSeconds > 0 ? Math.min(600, Math.round(parsedSeconds)) : 10;
            const task = await backgroundTaskManager.wait(taskId, waitSeconds * 1_000, scope);
            this.store.pushSystemMessage(task ? formatBackgroundTaskDetails(task) : `后台任务不存在或不属于当前会话：${taskId}`, sessionId ?? undefined);
            return;
        }

        if (action === "stop") {
            const wasRunning = backgroundTaskManager.stop(taskId, scope);
            const task = backgroundTaskManager.get(taskId, scope);
            const message = !task
                ? `后台任务不存在或不属于当前会话：${taskId}`
                : wasRunning
                    ? `已请求终止后台任务 ${taskId}`
                    : `后台任务 ${taskId} 当前状态：${task.status}`;
            this.store.pushSystemMessage(message, sessionId ?? undefined);
            return;
        }

        this.store.pushSystemMessage("用法：/tasks [list|status|wait|stop] [task_id] [wait_seconds]", sessionId ?? undefined);
    }

    /** 判断所有本实例会话是否都已结束当前回合。 */
    private hasBusyLocalTurns(): boolean {
        return this.agent.claimedSessionIds().some(sessionId => this.agent.isSessionBusy(sessionId));
    }

    /** 请求运行时重载：回合进行时排队，同一会话只保留一个请求。 */
    private async requestRuntimeReload(sessionId: string | null): Promise<void> {
        const queueKey = sessionId ?? GLOBAL_RUNTIME_RELOAD_KEY;
        if (this.runtimeReloading || this.hasBusyLocalTurns()) {
            if (this.pendingRuntimeReloads.has(queueKey)) {
                this.store.pushSystemMessage("🔄 reload 已在队列中，不再重复排队。", sessionId ?? undefined);
                return;
            }

            this.pendingRuntimeReloads.add(queueKey);
            this.store.pushSystemMessage("🔄 当前有运行中的回合，reload 已排队，将在回合结束或中断后执行。", sessionId ?? undefined);
            return;
        }

        await this.reloadRuntime(sessionId ? [sessionId] : []);
    }

    /** 重读磁盘技能与 MCP 工具，后续上游请求会使用新的运行时定义。 */
    private async reloadRuntime(targetSessionIds: string[]): Promise<void> {
        if (this.runtimeReloading) return;

        this.runtimeReloading = true;
        this.editor.disableSubmit = true;
        const sessionIds = [...new Set(targetSessionIds)];
        try {
            const result = await this.agent.reloadRuntime();
            const message = `🔄 已重新加载：${result.skillCount} 个技能，${result.mcpServerCount} 个 MCP 服务，${result.mcpToolCount} 个 MCP 工具。后续请求将使用新的 tools 和 system prompt。`;
            if (sessionIds.length === 0 && this.store.currentSessionId) {
                sessionIds.push(this.store.currentSessionId);
            }
            for (const sessionId of sessionIds) {
                this.store.pushSystemMessage(message, sessionId);
            }
        } catch (error: any) {
            const message = `⚠️ 重载失败：${error?.message ?? String(error)}`;
            if (sessionIds.length === 0 && this.store.currentSessionId) {
                sessionIds.push(this.store.currentSessionId);
            }
            for (const sessionId of sessionIds) {
                this.store.pushSystemMessage(message, sessionId);
            }
        } finally {
            this.runtimeReloading = false;
            this.syncSubmitState();
            this.restoreFocus();
            void this.flushPendingRuntimeReloads().then((reloadedSessionIds) => {
                for (const reloadedSessionId of reloadedSessionIds) {
                    this.sendNextPending(reloadedSessionId);
                }
            });
        }
    }

    /** 在所有本地回合空闲时执行合并后的重载，并继续各会话的输入队列。 */
    private async flushPendingRuntimeReloads(): Promise<string[]> {
        if (this.runtimeReloading || this.pendingRuntimeReloads.size === 0 || this.hasBusyLocalTurns()) {
            return [];
        }

        const queuedKeys = [...this.pendingRuntimeReloads];
        this.pendingRuntimeReloads.clear();
        const sessionIds = queuedKeys.filter(key => key !== GLOBAL_RUNTIME_RELOAD_KEY);
        await this.reloadRuntime(sessionIds);
        return sessionIds;
    }

    /** Ctrl+C 的中止判定：忙碌且未被其他实例锁定。 */
    private isInterruptible(): boolean {
        const sessionId = this.store.currentSessionId;
        const busy = this.turnState.isBusy(sessionId) || (sessionId ? this.agent.isSessionBusy(sessionId) : false);
        return busy && !(sessionId !== null && this.agent.isSessionLockedByOther(sessionId));
    }

    /** Esc 的中止判定：忙碌即中止（不排除被其他实例锁定）。 */
    private isCurrentBusy(): boolean {
        const sessionId = this.store.currentSessionId;
        return this.turnState.isBusy(sessionId) || (sessionId ? this.agent.isSessionBusy(sessionId) : false);
    }
    /** 面板打开时：鼠标滚轮落在面板矩形外则不交给面板，避免误滚面板内容。 */
    private isWheelOutsidePanel(data: string): boolean {
        const wheel = parseWheelEvent(data);
        // 非滚轮输入不参与面板命中判定，照常交给面板处理
        if (!wheel) return false;
        const overlay = this.activePanelOverlay();
        if (!overlay) return false;
        // 未知态（面板已打开但尚未渲染，height() 仍为 0）：矩形不可知，一律不交给面板。
        // 这不是「面板外」——面板此刻不可见，交给它会让滚动位置落在用户没看过的位置。
        if (overlay.height() <= 0) {
            this.logWheel(data, wheel, undefined, true);
            return true;
        }
        // OverlayHandle.getBounds() 实测长期为 undefined，故回退到按布局参数自算
        const bounds = overlayBounds(overlay.handle) ?? panelBounds(this.tui, overlay.height());
        const outside = !isInsideBounds(bounds, wheel.x, wheel.y);
        this.logWheel(data, wheel, bounds, outside);
        return outside;
    }

    /**
     * 滚轮诊断：记录原始序列、解析结果、浮层矩形与判定（默认关闭，排查"面板外滚动仍滚面板"用）。
     */
    private logWheel(data: string, wheel: WheelEvent | undefined, bounds: OverlayBounds | undefined, outside: boolean): void {
        const detail = `raw=${JSON.stringify(data)} parsed=${JSON.stringify(wheel)} `
            + `bounds=${JSON.stringify(bounds)} outside=${outside}`;
        this.writeWheelLog(`面板滚轮 ${detail}`);
    }

    /** 滚轮诊断写独立文件（ZBOT_TUI_DEBUG_WHEEL=1 时开启），便于 cat 复制、不混进会话日志。 */
    private writeWheelLog(line: string): void {
        if (process.env.ZBOT_TUI_DEBUG_WHEEL !== "1") return;
        try {
            const file = getWheelLogFile();
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, "utf8");
        } catch {
            // 诊断日志失败不影响 TUI。
        }
    }

    /** 栈顶若不是提问面板，返回它的浮层句柄（提问面板不是浮层，而是底部停靠区）。 */
    private activePanelOverlay(): PanelOverlay | null {
        const layer = this.panels.top();
        if (!layer || layer.kind === "question") return null;
        return (layer.meta as PanelOverlay | undefined) ?? null;
    }

    /** 记录会话草稿并调度落盘；图片附件也属于草稿。 */
    private setDraft(sessionId: string, text: string, images: ImageAssetRef[] = []): void {
        this.drafts.set(sessionId, text, images);
    }

    /** 清除会话草稿（发送成功、命令执行、删除会话）并调度落盘。 */
    private dropDraft(sessionId: string): void {
        this.drafts.delete(sessionId);
    }

    /** 立即落盘（退出前调用，保证最后一次输入不丢）。 */
    private async flushDrafts(): Promise<void> {
        await this.drafts.flush();
    }

    /**
     * 焦点归属：面板打开时聚焦面板浮层，否则回到输入框。
     * 直接 setFocus(editor) 会让面板失焦，而 TuiAltScreen 只在浮层聚焦时把滚轮透传出来，
     * 失焦后滚轮会被它消费去滚背景。
     */
    private restoreFocus(): void {
        const questionLayer = this.panels.find("question");
        if (questionLayer && this.panels.top() === questionLayer) {
            this.tui.setFocus(questionLayer.panel as any);
            return;
        }
        const overlay = this.activePanelOverlay();
        if (overlay) {
            overlay.handle.focus();
            return;
        }
        this.tui.setFocus(this.editor);
    }

    /**
     * 输入框可用性：只跟"当前会话"有关。
     * 后台会话跑 turn 不该锁住当前会话的输入，因此不再读进程级 busy。
     */
    private syncSubmitState(): void {
        const sessionId = this.store.currentSessionId;
        const blocked = this.runtimeReloading
            || this.switching
            || this.turnState.isLocked(sessionId)
            || (sessionId !== null && this.agent.isSessionBusy(sessionId));
        this.editor.disableSubmit = blocked;
    }

    private setSessionPhase(sessionId: string, phase: SessionPhaseType, toolName?: string): void {
        this.turnState.setPhase(sessionId, phase, toolName);
        this.startSpinnerTimer();
        if (sessionId === this.store.currentSessionId) {
            this.renderStatusBar();
        }
        this.renderTabBar();
    }

    private setSessionProgress(sessionId: string, message: string): void {
        const current = this.turnState.phase(sessionId);
        this.turnState.setPhase(sessionId, "compacting");
        this.turnState.touch(sessionId, {
            startTime: current?.startTime ?? Date.now(),
            message,
        });
        this.startSpinnerTimer();
        if (sessionId === this.store.currentSessionId) this.renderStatusBar();
        this.renderTabBar();
    }

    private clearSessionPhase(sessionId: string): void {
        this.turnState.clearPhase(sessionId);
        if (!this.hasActiveBusySession()) {
            this.stopSpinnerTimer();
        }
        if (sessionId === this.store.currentSessionId) {
            this.renderStatusBar();
        }
        this.renderTabBar();
    }

    private hasActiveBusySession(): boolean {
        return this.turnState.hasAnyActivity();
    }

    private startSpinnerTimer(): void {
        if (this.spinnerTimer) return;
        this.spinnerTimer = setInterval(() => {
            this.spinnerIndex++;
            if (this.hasActiveBusySession()) {
                this.renderStatusBar();
                this.renderTabBar();
                if (this.hasEmptyStreamingAssistant()) {
                    this.scheduleSyncMessages();
                }
            } else {
                this.stopSpinnerTimer();
                // 补一次重绘：停止瞬间的最后一帧 spinner 否则会残留在 tab 上
                this.renderTabBar();
            }
            // 四帧 spinner 的节奏：80ms 会显得闪烁，120ms 接近原十帧的观感
        }, 120);
    }

    private stopSpinnerTimer(): void {
        if (this.spinnerTimer) {
            clearInterval(this.spinnerTimer);
            this.spinnerTimer = null;
        }
    }

    /** 官方 DeepSeek 接入时维持峰谷倒计时刷新（分钟精度，30s 心跳；非 DeepSeek 时不启动）。 */
    private ensurePeakCountdownTimer(): void {
        if (this.peakCountdownTimer) return;
        this.peakCountdownTimer = setInterval(() => this.renderStatusBar(), 30_000);
    }

    private stopPeakCountdownTimer(): void {
        if (this.peakCountdownTimer) {
            clearInterval(this.peakCountdownTimer);
            this.peakCountdownTimer = null;
        }
    }

    private hasEmptyStreamingAssistant(): boolean {
        const messages = this.store.messages;
        const last = messages[messages.length - 1];
        return last?.role === "assistant" && last.streaming === true && (!last.timeline || last.timeline.length === 0);
    }

    /** 无会话时首次提交：先新建并选中一个会话，再把这条消息发进去。 */
    private async startSessionWith(text: string, images: ImageAssetRef[] = []): Promise<void> {
        if (this.switching) return;
        try {
            await this.newSession();
        } catch (error: any) {
            this.store.pushSystemMessage(`⚠️ 新建会话失败: ${error?.message ?? error}`);
            return;
        }
        const sessionId = this.store.currentSessionId;
        if (sessionId) {
            this.recordSubmittedInput(sessionId, text);
            await this.send(text, sessionId, images);
        }
    }

    /** 后台任务完成：回落状态栏计数，并把结果送到该会话（必要时驱动新一轮）。 */
    private handleBackgroundTaskCompleted(task: BackgroundTaskSummary): void {
        // 无论当前是否有回合在跑，都要先让状态栏的数字回落
        this.renderStatusBar();

        const sessionId = task.sessionId;
        if (!sessionId) return;

        const notification = formatBackgroundTaskNotification(task);
        if (this.activeTurnSessions.has(sessionId)) {
            // 回合进行中：结果随下一次请求带给模型，不额外驱动一轮
            const pending = this.pendingBackgroundResults.get(sessionId) ?? [];
            pending.push({ text: notification, trigger: "pending" });
            this.pendingBackgroundResults.set(sessionId, pending);
            return;
        }

        // 回合已结束：没有在跑的回合可挂靠，直接把结果当作新输入驱动一轮，
        // 否则结果只会留在内存里直到用户下次说话才被看到。
        void this.runBackgroundCompletionTurn(sessionId, notification);
    }

    /**
     * 本实例是否仍可安全执行副作用。
     * backgroundTaskManager 是进程级单例，其回调可能在 app 退出后仍被触发。
     */
    private isLive(): boolean {
        return !this.exiting;
    }

    /**
     * 回合已结束时把积压的后台任务结果驱动成新一轮。
     *
     * 结果以完整通知文本给模型（它需要结构化字段），时间线只显示一行摘要。
     * 会话正在跑或已归档时不动：前者会被 consumePendingMessages 捎上，后者是只读。
     */
    private async runBackgroundCompletionTurn(sessionId: string, notification: string): Promise<void> {
        await this.driveIdleSession(sessionId, [notification]);
    }

    /**
     * 在会话空闲时把一批"无回合可挂靠"的文本驱动成一轮。
     * 忙/归档/退出/切换中一律不动，等后续时机再送。
     */
    private async driveIdleSession(sessionId: string, texts: string[]): Promise<void> {
        if (texts.length === 0) return;
        if (!this.isLive() || this.switching || this.runtimeReloading) return;
        // 只驱动本实例已载入视图的会话：任务可能在 app 退出、会话被接管之后才完成，
        // 那时驱动本实例的 send 只会操作一份失效的视图。
        if (!this.store.hasSessionView(sessionId)) return;
        if (this.agent.isSessionBusy(sessionId)) return;
        if (this.isSessionArchived(sessionId)) return;

        const text = texts.join("\n");
        const display = this.backgroundCompletionDisplay(texts);
        await this.send(text, sessionId, [], display);
    }

    /** 后台任务结果在时间线上的展示摘要：不把整段 JSON 甩给用户。 */
    private backgroundCompletionDisplay(texts: string[]): string | undefined {
        const ids: string[] = [];
        const statuses: string[] = [];
        for (const text of texts) {
            const id = /"task_id":\s*"([^"]+)"/.exec(text)?.[1];
            const status = /"status":\s*"([^"]+)"/.exec(text)?.[1];
            if (id) ids.push(id);
            if (status) statuses.push(status);
        }
        if (ids.length === 0) return undefined;
        const labels: Record<string, string> = {
            completed: "已完成",
            failed: "失败",
            stopped: "已终止",
            timed_out: "超时",
        };
        const statusText = statuses.map(status => labels[status] ?? status).join("、");
        return `⚙ 后台任务 ${ids.join("、")} ${statusText}`;
    }

    private async send(
        text: string,
        targetSessionId?: string,
        images: ImageAssetRef[] = [],
        displayText?: string,
    ): Promise<void> {
        const sessionId = targetSessionId ?? this.store.currentSessionId;
        if (!sessionId) return;
        if (this.isSessionArchived(sessionId)) return;

        // 运行态由 turnState 的 phase 承担；这里只同步输入框可用性
        this.setSessionPhase(sessionId, "waiting");
        this.syncSubmitState();
        // displayText 只影响落盘与时间线：后台任务通知发给模型的是完整 JSON，
        // 但用户看到的那条消息应是可读摘要。
        this.store.addUserMessage(this.formatImageInput(displayText ?? text, images), sessionId);
        this.setSessionTitleIfAbsent(sessionId, displayText ?? text);
        if (this.store.currentSessionId === sessionId && !this.detailed) {
            this.scrollView.scrollToEnd();
        }
        const messageCountBeforeRequest = this.store.getMessages(sessionId).length;
        const sendStartTime = Date.now();
        let success = false;
        let turnError: string | undefined;
        this.activeTurnSessions.add(sessionId);
        this.syncHerdrState();
        try {
            const result = await this.agent.sendMessage(sessionId, text, {
                images,
                ...(displayText ? { displayText } : {}),
                consumePendingMessages: () => this.consumePendingMessages(sessionId),
            });
            success = result.aborted !== true;
        } catch (error: any) {
            const errorMessage = `⚠️ ${error.message}`;
            turnError = errorMessage;
            const errorWasRendered = this.store.getMessages(sessionId)
                .slice(messageCountBeforeRequest)
                .some(message => message.role === "system" && message.text === errorMessage);
            if (!errorWasRendered) {
                this.store.pushSystemMessage(errorMessage, sessionId);
            }
        } finally {
            this.activeTurnSessions.delete(sessionId);
            // 回合结束即"本会话不再有活跃回合"：此刻仍积压的后台任务结果，
            // 是在回合收尾瞬间到达的，没有回合可挂靠了，交给空闲驱动逻辑送出去。
            const leftover = this.pendingBackgroundResults.get(sessionId);
            if (leftover && leftover.length > 0) {
                this.pendingBackgroundResults.delete(sessionId);
                void this.driveIdleSession(sessionId, leftover.map(item => item.text));
            }
            const durationMs = Date.now() - sendStartTime;
            // 阶段清除即表示本会话空闲：turnState 内部不再有「先复位谁」的顺序问题
            this.clearSessionPhase(sessionId);
            this.syncHerdrState();
            if (this.store.currentSessionId === sessionId) {
                this.editor.disableSubmit = false;
                this.syncCurrentSessionState();
                this.restoreFocus();
            }
            // 展开模式下跳过了生成期间的流式刷新，在 turn 结束时全量同步一次
            if (this.detailed) {
                this.syncMessages();
            }
            // 发送终端通知（通知到 Ghostty 等终端代理的系统通知）
            const session = this.store.sessions.find(s => s.sessionId === sessionId);
            const sessionName = session?.lastUserMessage ? truncateInline(session.lastUserMessage, 20) : undefined;
            const isBackground = this.store.currentSessionId !== sessionId;
            if (turnError) {
                notifyTurnResult({
                    sessionId,
                    sessionName,
                    text: turnError,
                    durationMs,
                    isBackground,
                    isError: true,
                });
            } else if (success) {
                const messages = this.store.getMessages(sessionId);
                let replyText = "";
                for (let i = messages.length - 1; i >= 0; i--) {
                    const msg = messages[i];
                    if (msg?.role === "assistant") {
                        replyText = msg.text || "";
                        break;
                    }
                }
                notifyTurnResult({
                    sessionId,
                    sessionName,
                    text: replyText,
                    durationMs,
                    isBackground,
                    isError: false,
                });
            }

            this.sendNextPending(sessionId);
        }
    }

    private consumePendingMessages(sessionId: string): Array<string | UserMessageInput> | undefined {
        const peerResults = this.agent.takePeerResults(sessionId);
        const backgroundResults = this.pendingBackgroundResults.get(sessionId) ?? [];
        this.pendingBackgroundResults.delete(sessionId);
        if (this.pending.isEmpty(sessionId) && peerResults.length === 0 && backgroundResults.length === 0) return undefined;

        const consumed = this.pending.drain(sessionId);
        if (this.store.currentSessionId === sessionId) this.renderPending();
        for (const message of consumed) {
            this.store.addPendingUserMessage(this.formatPendingInput(message), sessionId);
        }
        if (consumed.length > 0 && this.store.currentSessionId === sessionId && !this.detailed) {
            this.scrollView.scrollToEnd();
        }

        const pendingInputs = consumed.map(message => this.toPendingMessage(message));
        return [
            ...peerResults,
            ...backgroundResults,
            ...pendingInputs.map(message => message.images.length > 0 ? message : message.text),
        ];
    }

    private async refreshSessions(): Promise<void> {
        // 清理无监听者的残留 socket（进程崩溃不会自动删）；连得上的一律保留
        await cleanupStaleSockets().catch(() => []);
        // 先回收过期归档会话，再列会话：列表现成于磁盘，已被删掉的会话不该出现（哪怕一瞬）
        await cleanupArchivedSessions({
            protectedIds: this.agent.listActiveSessionIds(),
            onRemoved: (sessionIds) => {
                for (const sessionId of sessionIds) this.agent.forgetSession(sessionId);
            },
        }).catch((error) => {
            console.warn("⚠️ [TUI] 归档会话清理失败:", (error as Error)?.message ?? error);
        });
        // 磁盘上没有、但界面里还留着的会话要保留：刚建的空会话尚未落盘，
        // 被这次刷新吞掉就等于把用户正在用的会话弄丢了。反向误差（别处删掉的会话
        // 短暂残留）由 release / delete 回调兜住，代价远小于丢会话。
        const fresh = await this.agent.listSessions();
        const diskIds = new Set(fresh.map(session => session.sessionId));
        const localOnly = this.store.sessions.filter(session => !diskIds.has(session.sessionId));
        this.store.setSessions([...fresh, ...localOnly]);
    }

    /**
     * 普通启动的落点：新建一个空会话并进入，不等用户先做选择。
     *
     * 每次启动都生成新的 ULID（见 createSessionSilently），不会复用或覆盖上一次的会话；
     * 历史会话仍可通过会话面板打开。新建失败时退回旧的「选择会话」视图，不至于卡住。
     */
    async startInitialSession(): Promise<void> {
        try {
            await this.newSession();
        } catch (error: any) {
            this.store.pushSystemMessage(`⚠️ 新建会话失败：${error?.message ?? error}`);
            this.openInitialView();
            return;
        }
        const sessionId = this.store.currentSessionId;
        this.store.pushSystemMessage(
            `👋 已新建空会话${sessionId ? ` ${sessionId.slice(-8)}` : ""}：⌘P 打开历史会话，⌃N 再新建。`,
        );
    }

    /**
     * 启动视图：不认领任何会话。
     * 已有会话时打开面板让用户主动开启；没有会话时提示新建。
     */
    private openInitialView(): void {
        const hasSession = this.store.sessions.some(session => !session.archived);
        if (hasSession) {
            this.openSessionPanel();
            this.store.pushSystemMessage("👋 选择要打开的会话（⌘P 可再次打开）：被其他实例占用时会先协商接管；⌃N 新建会话。");
            return;
        }
        this.store.pushSystemMessage("👋 还没有会话：⌃N 新建，或直接输入消息即新建。");
    }

    /**
     * CLI `zbot resume <id>`：会话的归档恢复与认领已在进入 TUI 前完成，
     * 这里关掉启动时的选择面板并切到目标会话。失败时留在 TUI 里提示，不弄脏终端。
     */
    async openResumedSession(sessionId: string): Promise<void> {
        this.closeActivePanel();
        try {
            await this.selectSession(sessionId);
        } catch (error: any) {
            this.store.pushSystemMessage(`⚠️ 恢复会话失败：${error?.message ?? error}`);
            this.openSessionPanel();
        }
    }

    /** 确保会话由本实例持有；被其他实例占用时协商接管，失败抛出可读错误。 */
    private async ensureClaimed(sessionId: string): Promise<void> {
        if (this.agent.isSessionClaimed(sessionId)) return;

        const result = await this.agent.claimSession(sessionId);
        if (!result.ok) throw new Error(describeClaimFailure(result));
        // 认领成功即归属变化（本实例 ●），立刻校正快照，别等下一次轮询
        void this.ownership.refresh(true);
    }

    /**
     * 会话被释放（本实例 /close 主动关闭 / 被其他实例协商拿走）：摘掉 tab 与内存状态；
     * 正显示时退回未选中（有别的已持有会话则切过去）。
     */
    private async handleSessionReleased(sessionId: string, cause: SessionReleaseCause = "peer"): Promise<void> {
        this.pending.clear(sessionId);
        this.questions.close(sessionId);
        this.store.removeSessionView(sessionId);
        if (cause === "tool" || cause === "auto") {
            const summary = this.store.sessions.find(session => session.sessionId === sessionId);
            if (summary) {
                summary.archived = true;
                this.store.setSessions(this.store.sessions);
            } else {
                // 子会话可能在 spawned 通知落入会话列表前就完成并自动归档
                void this.refreshSessions();
            }
        }
        void this.ownership.refresh(true);
        if (this.store.currentSessionId !== sessionId) {
            this.renderTabBar();
            return;
        }

        this.turnState.reset(sessionId);
        this.store.setCurrentSession(null);
        this.currentModelSelection = undefined;
        this.clearMessages();
        this.editor.disableSubmit = false;
        this.renderTabBar();
        if (cause === "peer") {
            this.tui.flash("会话已被其他实例接管");
            this.store.pushSystemMessage("⚠️ 当前会话已被其他实例接管：⌘P 重新选择或选别的会话。");
        } else {
            const notice = RELEASE_FLASH[cause];
            if (notice) this.tui.flash(notice);
        }

        const next = this.claimedSessions()[0];
        if (next) await this.selectSession(next.sessionId);
    }

    private async selectSession(sessionId: string): Promise<void> {
        // 打开前先取得持有权：认领成功才谈得上读写这个会话
        await this.ensureClaimed(sessionId);
        const modelSelection = await this.agent.getSessionModelSelection(sessionId);

        // 切换会话时退出标题重命名态（草稿由 DraftStore 保存，切回时恢复）
        this.cancelRename();

        // 恢复会话绑定的工作目录：工具执行、bash、路径渲染与 AGENTS PWD 都以此为基准。
        const sessionCwd = await this.agent.getSessionCwd(sessionId);
        this.activateSessionCwd(sessionCwd);

        // 新建会话前输入的队列搬到新会话（仅当新会话自己还是空的）
        if (this.pending.isEmpty(sessionId)) this.pending.adoptRoot(sessionId);
        else this.pending.clear(null);

        const currentId = this.store.currentSessionId;
        if (currentId && currentId !== sessionId) {
            // 草稿保存 marker 文本（保持输入框折叠显示）；切回时由 SessionPasteStore
            // （PromptEditor.setSessionContext / setText）恢复该会话的 pastes Map 与
            // pasteCounter，保证 marker 展开正确且 id 不与新粘贴冲突。
            this.setDraft(currentId, this.editor.getText(), this.editor.getImageAttachments());
            // 提问浮层只服务当前会话：切走先收起（问题本身仍挂在原会话上）
            this.questions.close();
        }

        const hasCachedView = this.store.hasSessionView(sessionId);
        this.switching = true;
        this.editor.disableSubmit = true;
        try {
            this.store.setCurrentSession(sessionId);
            // 命令行「无 id 的 show / wait」读这份指针；写失败只记日志，不影响切会话
            void writeCurrentSessionPointer(sessionId).catch((error: unknown) => {
                console.warn("⚠️ [TUI] 记录当前会话失败:", (error as Error)?.message ?? error);
            });
            this.currentModelSelection = modelSelection;
            // 切会话：todo 缓存按 sessionId 键控，但仍主动失效以立即反映目标会话
            this.todoCache = null;
            this.clearMessages();
            this.detailed = false;
            this.editor.setCompact(false);
            this.editor.setSessionContext(sessionId);
            // 恢复目标 session 的草稿内容（若无则置空）
            const draftValue = this.drafts.get(sessionId);
            const draft = typeof draftValue === "string"
                ? { text: draftValue, images: [] }
                : (draftValue ?? { text: "", images: [] });
            this.editor.setImageAttachments(draft.images);
            this.editor.setText(draft.text);
            // 输入历史按 session 区分：当前 session 优先，其他 session 按时间倒序补充。
            this.editor.setHistory(this.agent.loadInputHistory(sessionId));
            setLogSession(sessionId);
            this.layout.setMinSize(this.editor, 3);
            if (hasCachedView) {
                this.store.refreshView();
            } else {
                const events = await this.agent.readSessionEvents(sessionId);
                this.store.loadHistory(events, sessionId);
            }
            this.renderTabBar();
            this.scrollView.scrollToEnd();
        } finally {
            this.switching = false;
            this.syncCurrentSessionState();
            this.renderPending();
            this.sendNextPending(sessionId);
            // 目标会话挂着未作答的提问：切进来就把浮层弹出来
            this.questions.sync();
            this.syncHerdrMetadata();
        }
    }

    /**
     * 回合真正结束（agent 已释放会话锁）时的收尾。
     * 群消息驱动、回写追问、续跑这些非用户回合不经过 send()，所以：
     * - 重算当前会话的忙标记，否则 tab 的小圆点会一直转（clearSessionPhase 时 agent 仍持锁）；
     * - 放行排队的输入，否则要等用户切一次会话才发出去。
     */
    private onAgentTurnFinished(sessionId: string): void {
        // 回合真正结束：先摘掉外部忙闲占位，避免 tab 停在 spinner 上
        this.turnState.unlock(sessionId, "resuming");
        // 兜底落定流式标记：漏掉 message_end 时消息会一直显示为运行中
        this.store.finishStreaming(sessionId);
        this.syncHerdrState();
        if (this.store.currentSessionId === sessionId) {
            this.syncSubmitState();
            this.renderTabBar();
        }
        const hadPendingReload = this.pendingRuntimeReloads.has(sessionId);
        void this.flushPendingRuntimeReloads().then((reloadedSessionIds) => {
            for (const reloadedSessionId of reloadedSessionIds) {
                this.sendNextPending(reloadedSessionId);
            }
            if (!hadPendingReload || reloadedSessionIds.includes(sessionId)) {
                this.sendNextPending(sessionId);
            }
        });
    }

    private sendNextPending(targetSessionId?: string): void {
        const sessionId = targetSessionId ?? this.store.currentSessionId;
        if (!sessionId) return;
        if (this.exiting) return;
        if (this.switching) return;
        if (this.runtimeReloading || this.pendingRuntimeReloads.has(sessionId)) return;
        if (this.agent.isSessionBusy(sessionId)) return;
        if (this.isSessionArchived(sessionId)) return;

        if (this.pending.isEmpty(sessionId)) return;

        const allPending = this.pending.drain(sessionId).map(message => this.toPendingMessage(message));
        const combined = allPending.map(message => message.text).join("\n");
        const images = allPending.flatMap(message => message.images);

        if (this.store.currentSessionId === sessionId) {
            this.renderPending();
        }
        void this.send(combined, sessionId, images);
    }

    /** 将图片附件显示成紧凑的输入标记，不把本地路径暴露到会话内容。 */
    private formatImageInput(text: string, images: ImageAssetRef[] = []): string {
        if (images.length === 0) return text;
        const labels = images.map(image => `🖼 ${image.filename}`).join("  ");
        return text ? `${text}  ${labels}` : labels;
    }

    private formatPendingInput(message: { text: string; images?: ImageAssetRef[] } | string): string {
        if (typeof message === "string") return message;
        return this.formatImageInput(message.text, message.images ?? []);
    }

    private toPendingMessage(message: string | { text: string; images: ImageAssetRef[] }): { text: string; images: ImageAssetRef[] } {
        return typeof message === "string" ? { text: message, images: [] } : message;
    }

    /** 新建会话但不切换焦点：会话条由 setSessions 触发重绘。 */
    private async createSessionSilently(): Promise<string> {
        // 与 web 同一口径：默认选中集（= 配置里没标 lazy 的服务）在建会话时一次写好，
        // 之后 /mcp 的切换决定下发，执行期不再回头看 lazy 配置
        const { sessionId } = await this.agent.createSession(undefined, {
            selectedServers: defaultMcpSelection(),
            origin: "user",
        });
        // 新建即认领：自己的空会话不会与别的实例冲突，失败只可能是极端情况
        await this.agent.claimSession(sessionId);
        // 未落盘前 listSessions 看不到它，cwd 只能就地补上，否则面板目录列会缺一格
        this.store.sessions.unshift({ sessionId, cwd: await this.agent.getSessionCwd(sessionId), messageCount: 0 });
        this.store.setSessions(this.store.sessions);
        return sessionId;
    }

    /**
     * 模型派生了子会话（session_spawn）：立即进会话条与面板，让用户看得见协作动作。
     * 子会话不自动回收：用完由用户 ⌃X 删除或 ⌃A 归档。
     */
    private async handleSessionSpawned(sessionId: string, title?: string): Promise<void> {
        // 标题已由宿主在建会话时固化（createSession），这里只负责进会话条
        const cleanTitle = (title ?? "").trim();
        this.store.sessions.unshift({
            sessionId,
            cwd: await this.agent.getSessionCwd(sessionId),
            messageCount: 0,
            ...(cleanTitle ? { title: cleanTitle.slice(0, 200) } : {}),
        });
        this.store.setSessions(this.store.sessions);
        void this.ownership.refresh(true);
        this.tui.flash(cleanTitle ? `✚ 子会话：${truncateInline(cleanTitle, 20)}` : "✚ 已派生新的子会话");
    }

    private async handleSessionWoken(sessionId: string): Promise<void> {
        this.store.setSessions(await this.agent.listSessions());
        void this.ownership.refresh(true);
        this.renderTabBar();
        this.tui.flash(`已唤醒会话 ${sessionId.slice(-8)}，可继续派活`);
    }

    private async newSession(): Promise<void> {
        const sessionId = await this.createSessionSilently();
        await this.selectSession(sessionId);
    }

    /** 把 TUI_CWD 切到会话绑定目录：工具执行、shell 与路径渲染的相对化基准随会话恢复。不 process.chdir，避免影响同进程其它任务。 */
    private activateSessionCwd(cwd: string): void {
        process.env.TUI_CWD = cwd;
    }

    /** 当前生效的工作目录：会话绑定的 cwd（状态栏右下角展示的就是它）。 */
    private currentCwd(): string {
        return process.env.TUI_CWD || process.cwd();
    }

    /**
     * 会话工作目录被 cwd 工具 / /cwd 改写：
     * 属主会话若不刷新基准，状态栏与工具执行目录会各说各话。
     */
    private handleSessionCwdChanged(sessionId: string, cwd: string): void {
        const summary = this.store.sessions.find(session => session.sessionId === sessionId);
        if (summary) {
            summary.cwd = cwd;
            // 走 setSessions：tab 条与面板目录列的刷新统一由 onSessionsChanged 触发
            this.store.setSessions(this.store.sessions);
        }
        if (this.store.currentSessionId === sessionId) {
            this.activateSessionCwd(cwd);
            this.renderStatusBar();
        }
    }

    /** /cwd：无参显示当前目录（~ 缩写），有参切换并落盘到会话。 */
    private async changeCwd(raw: string): Promise<void> {
        const sessionId = this.store.currentSessionId;
        if (!sessionId) return;

        const current = this.currentCwd();
        if (!raw) {
            this.store.pushSystemMessage(`当前工作目录：${formatDisplayPath(current)}`, sessionId);
            return;
        }

        const resolved = resolveExistingDir(raw, current);
        if ("error" in resolved) {
            this.tui.flash(resolved.error);
            return;
        }
        if (resolved.cwd === current) {
            this.store.pushSystemMessage(`当前工作目录已经是 ${formatDisplayPath(current)}`, sessionId);
            return;
        }

        try {
            await this.agent.setSessionCwd(sessionId, resolved.cwd);
        } catch (error: any) {
            this.tui.flash(error?.message ?? String(error));
            return;
        }
        this.activateSessionCwd(resolved.cwd);
        this.renderStatusBar();
        this.tui.flash(`工作目录已切换：${formatDisplayPath(resolved.cwd)}`);
    }

    /** 归档会话：保留在列表（面板可见）但从会话条移除；归档当前会话时切到下一个。 */
    private async archiveSessionById(sessionId: string): Promise<void> {
        if (this.isSessionArchived(sessionId)) {
            this.tui.flash("会话已归档，用 ⌘P → ⌃A 取消归档");
            return;
        }
        if (this.agent.isSessionBusy(sessionId)) {
            this.tui.flash("会话执行中，暂不能归档");
            return;
        }
        const isCurrent = this.store.currentSessionId === sessionId;
        const summary = this.store.sessions.find(session => session.sessionId === sessionId);
        this.pending.clear(sessionId);
        // 归档不动草稿与 paste 缓存：切回来（或取消归档）时输入框内容原样恢复
        if (isCurrent) {
            this.turnState.lock(sessionId, "switching");
            this.syncSubmitState();
        }
        try {
            await this.agent.closeSession(sessionId);
            // 归档即放弃持有：别的实例可以接管它（只读查看）
            this.agent.releaseSession(sessionId, { cause: "archive" });
            void this.ownership.refresh(true);
            // 归档后清理内存缓存，重新打开时从事件日志重建，避免残留瞬态 UI 状态。
            this.store.removeSessionView(sessionId);
            if (summary) summary.archived = true;
            this.store.setSessions(this.store.sessions);

            if (isCurrent) {
                await this.fallbackToClaimedSession();
            } else {
                this.renderTabBar();
            }
        } catch (error: any) {
            this.store.pushSystemMessage(`⚠️ 归档失败: ${error.message}`);
        } finally {
            if (isCurrent) {
                this.turnState.unlock(sessionId, "switching");
                this.syncSubmitState();
                this.restoreFocus();
            }
        }
    }

    private async archiveCurrentSession(): Promise<void> {
        const sessionId = this.store.currentSessionId;
        if (!sessionId) return;
        await this.archiveSessionById(sessionId);
    }

    /** 取消归档：追加 session_unarchived 事件，会话回到会话条并恢复可写。 */
    private async unarchiveSessionById(sessionId: string): Promise<void> {
        if (!this.isSessionArchived(sessionId)) {
            this.tui.flash("该会话未归档");
            return;
        }
        if (this.agent.isSessionBusy(sessionId)) {
            this.tui.flash("会话执行中，暂不能取消归档");
            return;
        }
        try {
            await this.agent.unarchiveSession(sessionId);
            const summary = this.store.sessions.find(session => session.sessionId === sessionId);
            if (summary) summary.archived = false;
            // 重新排序：未归档会话回到按 updatedAt 排列的区段
            this.store.setSessions(this.store.sessions);

            if (this.store.currentSessionId === sessionId) {
                // 归档期间该会话是只读视图，丢弃缓存后重新加载以解除只读
                this.store.removeSessionView(sessionId);
                await this.selectSession(sessionId);
            } else {
                this.renderTabBar();
            }
            this.tui.flash("已取消归档");
        } catch (error: any) {
            this.store.pushSystemMessage(`⚠️ 取消归档失败: ${error.message}`);
        }
    }

    private async unarchiveCurrentSession(): Promise<void> {
        const sessionId = this.store.currentSessionId;
        if (!sessionId) return;
        await this.unarchiveSessionById(sessionId);
    }

    /**
     * 关闭当前会话：释放本实例持有（socket 交还，别的实例可立刻认领），会话从 tab 条
     * 与内存摘掉，事件日志与快照原样保留 —— ⌘P 面板里随时能重新打开。
     * 与归档（打标记、只读）和删除（清数据）区分：关闭只是「不看了」，不改任何落盘事实。
     * 草稿与 paste 缓存同样保留，重新认领后输入框内容原样恢复。
     */
    private async closeCurrentSession(): Promise<void> {
        const sessionId = this.store.currentSessionId;
        if (!sessionId) return;
        if (this.agent.isSessionBusy(sessionId)) {
            this.tui.flash("会话执行中，暂不能关闭（⎋ 中止后再试）");
            return;
        }
        // 从未用过、也没留下草稿的会话：关闭即删除，不留 0 轮垃圾。
        // 判空/归属/忙闲由宿主在删除前一起复查，与退出清理同一条路径。
        if (!this.hasUnsavedDraft(sessionId)
            && await this.deleteSessionById(sessionId, {
                flashText: "🗑️ 空会话已删除（从未发过消息）",
                onlyIfEmpty: true,
            })) {
            return;
        }

        this.pending.clear(sessionId);
        this.turnState.lock(sessionId, "switching");
        this.syncSubmitState();
        try {
            // 释放会同步触发 onSessionReleased：内存视图、tab 与当前选中一并收敛
            this.agent.releaseSession(sessionId, { cause: "user" });
        } catch (error: any) {
            this.store.pushSystemMessage(`⚠️ 关闭会话失败: ${error.message}`);
        } finally {
            this.turnState.unlock(sessionId, "switching");
            this.syncSubmitState();
            this.restoreFocus();
        }
    }

    /**
     * 退出时清理本实例持有的空会话（从未产生过内容、也没有未发送草稿）。
     *
     * 主要针对启动即新建的空会话：用过就退出不该在磁盘上越积越多。
     * 判空、归属与忙闲由宿主在删除前一起复查（缩小被别的实例接管的窗口）；
     * 有草稿的一律跳过——宁可留一个空会话，也不误删数据。
     */
    private async deleteEmptySessionsHeld(): Promise<void> {
        const removeIfEmpty = (this.agent as Partial<SessionHost>).deleteSessionIfEmpty;
        if (typeof removeIfEmpty !== "function") return; // 旧宿主/测试替身：不做清理
        for (const sessionId of this.agent.claimedSessionIds()) {
            if (this.hasUnsavedDraft(sessionId)) continue;
            try {
                if (!await removeIfEmpty.call(this.agent, sessionId)) continue;
                this.drafts.delete(sessionId);
                this.editor.clearSessionPastes(sessionId);
            } catch (error) {
                console.warn("⚠️ [TUI] 清理空会话失败:", (error as Error)?.message ?? error);
            }
        }
    }

    /** 有未发送的草稿（含当前输入框）时保留会话：草稿也是用户输入，不能跟着空会话一起删。 */
    private hasUnsavedDraft(sessionId: string): boolean {
        if (sessionId === this.store.currentSessionId) {
            if (this.editor.getText().trim()) return true;
            if (this.editor.getImageAttachments().length > 0) return true;
        }
        const draft = this.drafts.get(sessionId);
        if (!draft) return false;
        return typeof draft === "string"
            ? draft.trim().length > 0
            : draft.text.trim().length > 0 || draft.images.length > 0;
    }

    /**
     * 打开会话面板（⌘P / Ctrl+P / /sessions）：搜索、切换、重命名、删除、归档。
     * 面板先挂上、再重读磁盘：读盘（清理 socket、扫描会话事件）不该让快捷键卡顿，
     * 而显示启动时那份旧列表最容易误导人——新列表到了会原地刷新。
     */
    private openSessionPanel(): void {
        if (!this.panels.isEmpty || this.exiting) return;
        void this.refreshSessions().catch(() => undefined);
        const panel = new SessionPanel(this.buildSessionPanelItems(), {
            select: (sessionId) => {
                void this.openSessionFromPanel(sessionId);
            },
            rename: (sessionId) => {
                this.closeSessionPanel();
                void this.beginRename(sessionId);
            },
            remove: (sessionId) => {
                void this.deleteSessionFromPanel(sessionId);
            },
            archive: (sessionId) => {
                void this.archiveSessionFromPanel(sessionId);
            },
            unarchive: (sessionId) => {
                void this.unarchiveSessionFromPanel(sessionId);
            },
            close: () => this.closeSessionPanel(),
        }, {
            spinner: SPINNER_FRAMES[this.spinnerIndex % SPINNER_FRAMES.length],
            // 工作目录列按 home 缩写，避免长路径把副列撑开
            home: process.env.HOME,
            // 确认窗口到期后由面板主动请求重绘，清掉 footer 的“再按 ⌃X 确认”提示
            requestRender: () => this.tui.requestRender(),
        });

        const handle = openPanelOverlay(this.tui, panel, "session");
        this.panels.push({
            kind: "session",
            panel,
            meta: handle,
            onClose: () => {
                panel.dispose();
                this.ownership.stopPolling();
                this.afterPanelClosed(handle);
            },
        });
        // 打开时先校正一次归属，之后按节流轮询（他实例的认领/忙闲会变）
        void this.ownership.refresh(true);
        this.ownership.startPolling();
        this.writeWheelLog("打开面板 session");
        this.tui.requestRender();
    }

    /**
     * 面板里删除会话：删除后不关面板，只把最新列表推回去。
     * 连续清理多个会话时不必反复打开面板；失败（执行中/落盘报错）时同样留在列表里看提示。
     */
    private async deleteSessionFromPanel(sessionId: string): Promise<void> {
        await this.deleteSessionById(sessionId);
        this.syncSessionPanelItems();
    }

    /**
     * 面板里归档：归档只是把会话移出会话条（面板仍能看到），同样不关面板，只推回最新状态。
     */
    private async archiveSessionFromPanel(sessionId: string): Promise<void> {
        await this.archiveSessionById(sessionId);
        this.syncSessionPanelItems();
    }

    /**
     * 面板里取消归档：取消后不关面板，原地刷新列表（会话回到会话条），便于连续整理。
     */
    private async unarchiveSessionFromPanel(sessionId: string): Promise<void> {
        await this.unarchiveSessionById(sessionId);
        this.syncSessionPanelItems();
    }

    /**
     * 面板里选中会话：认领成功才关闭面板；
     * 失败（对方正在执行 / 无应答）时 flash 提示并留在列表里，用户可以继续选别的。
     */
    private async openSessionFromPanel(sessionId: string): Promise<void> {
        if (sessionId === this.store.currentSessionId) {
            this.closeSessionPanel();
            return;
        }

        try {
            await this.selectSession(sessionId);
        } catch (error: any) {
            // 认领失败往往是「对方正忙」：立刻刷新归属，让列表反映出最新状态
            void this.ownership.refresh(true);
            this.tui.flash(error?.message ?? String(error));
            return;
        }

        this.closeSessionPanel();
        if (this.isSessionArchived(sessionId)) {
            this.tui.flash("该会话已归档：只读，可 ⌃A 取消归档或 ⌃X 删除");
        }
    }

    private closeSessionPanel(): void {
        this.panels.remove("session");
    }

    /** 打开快捷键面板（Ctrl+/ / F1 / /keys）：只读展示全部键位，行数按终端高度推算。 */
    private openShortcutPanel(): void {
        if (!this.panels.isEmpty || this.exiting) return;
        const panel = new ShortcutPanel({
            visibleRows: panelContentRows(this.tui),
            close: () => this.closeShortcutPanel(),
        });
        const handle = openPanelOverlay(this.tui, panel, "shortcut");
        this.panels.push({
            kind: "shortcut",
            panel,
            meta: handle,
            onClose: () => this.afterPanelClosed(handle),
        });
        this.writeWheelLog("打开面板 shortcut");
        this.tui.requestRender();
    }

    private closeShortcutPanel(): void {
        this.panels.remove("shortcut");
    }

    // ── 用户提问（ask_user） ──────────────────────────────────────────────

    /**
     * 工具侧入口：把问题挂到会话上，等用户作答或取消。
     * 没有超时——`signal` 中止（⌃C 中止回合、退出、会话被释放）时按取消结算，
     * 所以工具不会永远悬着，而用户在场时可以慢慢想。
     */
    /** 会话展示名：标题优先，回退 id 末 8 位。 */
    private sessionLabel(sessionId: string): string {
        const title = this.store.sessions.find(session => session.sessionId === sessionId)?.title;
        return title || sessionId.slice(-8);
    }

    /** 关闭当前打开的任意面板（退出时统一收尾）；会话面板需 dispose 释放确认定时器。 */
    private closeActivePanel(): void {
        // 每层的关闭动作（隐藏浮层、dispose、停定时器、还原焦点）都由 onClose 承担
        this.panels.clear();
    }

    /** 任意浮层关闭后的统一收尾：还原焦点并让被压在下面的提问重新露出来。 */
    private afterPanelClosed(handle: PanelOverlay): void {
        handle.handle.hide();
        this.restoreFocus();
        this.tui.requestRender();
        this.questions.sync();
    }

    private buildSessionPanelItems(): SessionPanelItem[] {
        return this.store.sessions.map((session) => {
            const ownership = this.ownership.describe(session.sessionId);
            return {
                sessionId: session.sessionId,
                ...(session.origin ? { origin: session.origin } : {}),
                title: session.title,
                cwd: session.cwd,
                messageCount: session.messageCount,
                lastUserMessage: session.lastUserMessage,
                updatedAt: session.updatedAt,
                archived: session.archived,
                busy: this.turnState.isBusy(session.sessionId),
                active: session.sessionId === this.store.currentSessionId,
                question: this.questions.hasPending(session.sessionId),
                ...(ownership ? { ownerState: ownership.state, owner: ownership.text } : {}),
            };
        });
    }

    private hasSessionPanelOpen(): boolean {
        return this.panels.has("session");
    }

    private async switchSession(delta: number, includeArchived = false): Promise<void> {
        const sessions = includeArchived
            ? this.store.sessions
            : this.claimedSessions();
        const ids = sessions.map(session => session.sessionId);
        if (ids.length === 0) return;
        const index = ids.indexOf(this.store.currentSessionId ?? "");
        // 当前会话不在列表中（如已归档被过滤）时不再按余数循环，直接跳到列表首项，避免方向错乱。
        const next = index >= 0 ? ids[(index + delta + ids.length) % ids.length] : ids[0];
        if (next !== this.store.currentSessionId) {
            await this.selectSession(next);
        }
    }

    private isSessionArchived(sessionId: string | null): boolean {
        return sessionId !== null
            && this.store.sessions.find(session => session.sessionId === sessionId)?.archived === true;
    }

    /** MCP 通知：授权链接等落入当前会话，链接可用 ⌘+点击打开 */
    private handleMcpNotice(notice: McpNotice): void {
        const icon = notice.level === "error" ? "⚠️" : (notice.level === "warn" ? "🔐" : "🔌");
        const lines = [`${icon} [MCP:${notice.server}] ${notice.text}`];
        if (notice.url) {
            lines.push("");
            lines.push(`🔗 ${wrapAppLink("点此完成授权", notice.url)}（macOS 按住 ⌘ 点击）`);
            lines.push(notice.url);
            lines.push("授权完成后会自动重连；/mcp 可查看状态与链接。");
        }

        this.store.pushSystemMessage(lines.join("\n"));
        if (notice.url) this.tui.flash("MCP 需要浏览器授权：请打开会话中的链接");
    }

    /** 处理点击链接：zbot:// 内部动作（切会话 / 会话面板 / 新建）在本进程处理；外链 macOS 按住 Cmd 才打开（与 Ghostty 原生一致），其他平台保持单击打开。 */
    private handleOpenUrl(url: string): void {
        if (url === SESSION_PANEL_URL) {
            this.openSessionPanel();
            return;
        }
        if (url === SESSION_NEW_URL) {
            void this.newSession();
            return;
        }
        if (url === SHORTCUT_PANEL_URL) {
            this.openShortcutPanel();
            return;
        }
        if (url.startsWith(TAB_LINK_PREFIX)) {
            let sessionId: string;
            try {
                sessionId = decodeURIComponent(url.slice(TAB_LINK_PREFIX.length));
            } catch {
                return;
            }
            if (!this.store.sessions.some(session => session.sessionId === sessionId)) return;
            if (sessionId === this.store.currentSessionId) return;
            void this.selectSession(sessionId);
            return;
        }

        // macOS：仅 Cmd+点击打开外链，避免单击误触；单击给提示。
        if (isCmdGateSupported()) {
            if (!isCmdDown()) {
                this.tui.flash("按住 ⌘ 点击打开链接");
                return;
            }
        }
        openExternalUrl(url);
    }

    private async abortCurrent(): Promise<void> {
        const sessionId = this.store.currentSessionId;
        if (!sessionId) return;
        await this.agent.abortSession(sessionId);
    }

    /** /compact [附加要求]：附加要求作为压缩提示的一部分，不静默丢弃。 */
    private async compactCurrent(instruction?: string): Promise<void> {
        const sessionId = this.store.currentSessionId;
        if (!sessionId) return;
        if (this.agent.isSessionBusy(sessionId)) {
            this.tui.flash("会话正在执行，暂不能压缩");
            return;
        }
        this.turnState.lock(sessionId, "compacting");
        this.syncSubmitState();
        this.syncHerdrState();
        try {
            await this.agent.compactSession(sessionId, instruction);
            this.store.pushSystemMessage("🗜️ 已压缩上下文", sessionId);
        } catch (error: any) {
            this.store.pushSystemMessage(`⚠️ 压缩失败: ${error.message}`, sessionId);
        } finally {
            this.turnState.unlock(sessionId, "compacting");
            this.syncHerdrState();
            this.syncSubmitState();
            this.restoreFocus();
        }
    }

    /**
     * /continue（⌥+Enter）：按续跑点补跑缺失的工具调用或直接发下一次请求。
     * 不产生用户消息，上游看到的请求与中断前一致。
     */
    private async continueCurrent(): Promise<void> {
        const sessionId = this.store.currentSessionId;
        if (this.exiting) return;
        if (!this.requireSession() || !sessionId) return;
        if (this.isSessionArchived(sessionId)) {
            this.tui.flash("会话已归档，不能继续");
            return;
        }
        if (this.turnState.isBusy(sessionId) || this.agent.isSessionBusy(sessionId)) {
            this.tui.flash("当前会话处理中，先 Esc 中止或等待结束");
            return;
        }

        if (this.store.currentSessionId === sessionId) {
            this.turnState.lock(sessionId, "resuming");
            this.syncSubmitState();
        }
        this.syncHerdrState();
        try {
            const result = await this.agent.resumeSession(sessionId, {
                consumePendingMessages: () => this.consumePendingMessages(sessionId),
            });
            if (!result.resumed) {
                this.store.pushSystemMessage(`ℹ️ ${result.reason ?? "没有可继续的内容"}`, sessionId);
            } else if (result.aborted) {
                this.store.pushSystemMessage("⏩ 继续已中止", sessionId);
            }
        } catch (error: any) {
            this.store.pushSystemMessage(`⚠️ 继续失败: ${error.message}`, sessionId);
        } finally {
            this.turnState.unlock(sessionId, "resuming");
            this.clearSessionPhase(sessionId);
            this.syncHerdrState();
            if (this.store.currentSessionId === sessionId) {
                this.editor.disableSubmit = false;
                this.syncCurrentSessionState();
                this.restoreFocus();
            }
            if (this.detailed) this.syncMessages();
            this.sendNextPending(sessionId);
        }
    }

    /** Ctrl+O：全局展开/收起详细内容（reasoning 全文 + 全部工具块）。 */
    private toggleDetailed(): void {
        this.detailed = !this.detailed;
        this.editor.setCompact(this.detailed);
        this.layout.setMinSize(this.editor, this.detailed ? 1 : 3);

        // 取消 pending 中的批量定时器，避免重复无意义渲染
        if (this.syncTimer) {
            clearTimeout(this.syncTimer);
            this.syncTimer = null;
        }

        // 仅在内存中批量翻转 block.expanded，不触发多余的异步 notify 回调
        this.store.setAllToolBlocksExpanded(this.detailed, false);

        // 精准局部更新：assistant 走时间线；群消息等 system 文本要按折叠态重排，
        // 否则 Ctrl+O 展开后群消息仍停留在"只有第一行"的折叠形态。
        const ctx = this.renderContext();
        for (const entry of this.messageComponents.values()) {
            const message = this.store.getMessageById(entry.messageId);
            if (!message) continue;

            if (entry.timeline) {
                if (message.role === "assistant") {
                    updateMessageComponent(entry, message, ctx);
                    entry.renderKey = messageRenderKey(message, ctx);
                }
                continue;
            }
            if (entry.body && message.role !== "user") {
                entry.body.setText(renderSystemText(message));
                entry.body.invalidate();
            }
        }
        this.tui.requestRender();
    }

    /** 底部状态栏（双行）：
     * 第 1 行：模型信息 + 思考强度 + 生成速率 ······ 实时执行阶段 + 当前目录
     * 第 2 行：Token 统计与容量比  ······  当前会话 ID
     */
    private renderStatusBar(): void {
        const modelSettings = getChatApiSettings(this.currentModelSelection);
        const protocolName = protocolStatusLabel(modelSettings.protocol, modelSettings.model);
        const modelName = `${modelSettings.model || "default"} (${protocolName})`;
        const sessionId = this.store.currentSessionId;
        const pricing = resolvePricingMode(endpointHost(modelSettings.apiBase), modelSettings);
        const isDeepSeekPriced = pricing !== undefined
            && normalizeDeepSeekModel(modelSettings.model, pricing.looseModel) !== undefined;

        // 峰谷倒计时定时器按 provider 启停（副作用留在 app 层，模型只负责排版）
        if (isDeepSeekPriced) this.ensurePeakCountdownTimer();
        else this.stopPeakCountdownTimer();

        // 任务清单：供底部常驻条使用（带 TTL 缓存）
        const todos = this.getSessionTodos(sessionId);
        this.todoBar.setTodos(todos);
        this.layout.setMinSize(this.todoBar, this.todoBar.lineCount());

        const model = buildStatusBarModel({
            modelName,
            effort: modelSettings.reasoningEffort
                ?? this.currentModelSelection?.reasoningEffort
                ?? process.env.REASONING_EFFORT
                ?? process.env.OPENAI_REASONING_EFFORT
                ?? process.env.DEEPSEEK_REASONING_EFFORT
                ?? "auto",
            sessionId,
            phase: this.turnState.phase(sessionId),
            spinnerIndex: this.spinnerIndex,
            now: Date.now(),
            contextTokens: this.store.contextTokens,
            contextSource: this.store.contextSource,
            awaitingAnswer: this.questions.pendingCount(),
            backgroundRunning: sessionId ? backgroundTaskManager.runningCount(sessionId) : 0,
            totalTokens: this.store.totalTokens,
            promptTokens: this.store.promptTokens,
            completionTokens: this.store.completionTokens,
            reasoningTokens: this.store.reasoningTokens,
            cacheHitTokens: this.store.cacheHitTokens,
            cacheMissTokens: this.store.cacheMissTokens,
            costYuan: this.store.costYuan,
            lastRate: this.store.lastRate,
            cwd: this.currentCwd(),
            home: process.env.HOME,
            isDeepSeekPriced,
            deepSeek: isDeepSeekPriced ? deepSeekPhaseInfo() : undefined,
            contextWindow: getContextWindowForModel(modelName),
        });

        this.statusBar.setStatus(model.line1, model.line2);
        this.statusBar.invalidate();
        this.tui.requestRender();
    }
    private syncCurrentSessionState(): void {
        const sessionId = this.store.currentSessionId;
        const isArchived = this.isSessionArchived(sessionId);
        this.syncExternalBusy(sessionId);
        this.syncSubmitState();
        this.editor.setReadOnly(isArchived);
        if (isArchived) this.editor.setText("");
    }

    /**
     * 把「不由 ChatApp.send 驱动」的回合状态同步进 turnState。
     *
     * 群消息驱动、回写追问、续跑这些回合不经过 send()，agent 的会话锁才是唯一信号；
     * 不在这里落到 turnState，tab 就不会显示 spinner，退出时也会误判为空闲。
     * 反向复位同样重要：回合结束后 agent 不再忙，残留的占位必须撤掉。
     */
    private syncExternalBusy(sessionId: string | null): void {
        if (!sessionId) return;
        if (this.agent.isSessionBusy(sessionId)) {
            this.turnState.lock(sessionId, "resuming");
        } else {
            this.turnState.unlock(sessionId, "resuming");
        }
    }

    /** 会话条：单行等宽，超宽时以 ‹N / N› 折叠，归档会话不进 tab 条（只出现在面板）。 */
    private renderTabBar(): void {
        const tabs = this.buildSessionBarTabs();
        // Text 左右各留 1 列内边距，预算要先扣掉，否则最后一段会被换行。
        const width = Math.max(1, (this.tui.terminal.columns || 80) - 2);
        const spinner = SPINNER_FRAMES[this.spinnerIndex % SPINNER_FRAMES.length];
        // 面板里的状态标记与 tab 条同源：打开期间 busy/active/archived 变化必须同步
        this.syncSessionPanelItems(spinner);
        const bar = buildSessionBar(tabs, width, this.sessionBarStyles, spinner);

        this.tabVisibleIds = bar.visibleIds;
        this.tabBar.setText(bar.line);
        this.tabBar.invalidate();
        this.tui.requestRender();
    }

    /** 面板打开时把最新会话列表推回面板；未打开则空操作。 */
    private syncSessionPanelItems(spinner?: string): void {
        const layer = this.panels.find("session");
        if (!layer) return;
        const frame = spinner ?? SPINNER_FRAMES[this.spinnerIndex % SPINNER_FRAMES.length];
        (layer.panel as SessionPanel).updateItems(this.buildSessionPanelItems(), frame);
    }

    /** 本实例持有的会话：tab 条与切换范围都以此为准（未持有的一律不出现在 tab 条）。 */
    private claimedSessions() {
        const claimed = new Set(this.agent.claimedSessionIds());
        return this.store.sessions.filter(session => !session.archived && claimed.has(session.sessionId));
    }

    private buildSessionBarTabs(): SessionBarTab[] {
        return this.claimedSessions()
            .map((session) => ({
                sessionId: session.sessionId,
                ...(session.origin ? { origin: session.origin } : {}),
                title: session.title,
                messageCount: session.messageCount,
                busy: this.turnState.isBusy(session.sessionId),
                active: session.sessionId === this.store.currentSessionId,
                question: this.questions.hasPending(session.sessionId),
            }));
    }

    /** 会话首次提问后固化标题（后续消息不覆盖；显式重命名后亦不覆盖）。 */
    private setSessionTitleIfAbsent(sessionId: string, text: string): void {
        const summary = this.store.sessions.find(session => session.sessionId === sessionId);
        if (!summary || summary.title) return;
        const firstLine = text.trim().split("\n")[0].trim().slice(0, 200);
        if (!firstLine) return;
        summary.title = firstLine;
        this.renderTabBar();
        this.syncHerdrMetadata();
    }

    /** 标题被改写（本实例 ⌘R，或控制通道的 rename）：同步会话列表、tab 栏与 herdr 元数据。 */
    private handleSessionRenamed(sessionId: string, title: string): void {
        const summary = this.store.sessions.find(session => session.sessionId === sessionId);
        if (summary) summary.title = title;
        this.renderTabBar();
        this.syncHerdrMetadata();
    }

    /** 落盘新标题：落盘后由 handleSessionRenamed 统一刷新 UI，这里只负责错误提示。 */
    private async applySessionTitle(sessionId: string, rawTitle: string): Promise<void> {
        const cleanTitle = rawTitle.trim();
        if (!cleanTitle) {
            this.tui.flash("标题不能为空");
            return;
        }
        const summary = this.store.sessions.find(session => session.sessionId === sessionId);
        if (summary?.title === cleanTitle) {
            this.tui.flash("标题未变化");
            return;
        }
        try {
            await this.agent.renameSession(sessionId, cleanTitle);
            // 宿主回调已刷新过一次；这里再调一次是幂等的，覆盖 agent 未回调的场景（如测试桩）
            this.handleSessionRenamed(sessionId, cleanTitle.slice(0, MAX_SESSION_TITLE_LENGTH));
            this.tui.flash(`✎ 标题已更新: ${truncateInline(cleanTitle, 20)}`);
        } catch (error: any) {
            this.tui.flash(`⚠️ 重命名失败: ${error.message}`);
        }
    }

    /**
     * ⌘R：当前会话进入标题重命名（输入框预填当前标题，回车保存 / Esc 取消）。
     * 标题是元数据，回合执行中也允许改；草稿会被暂存并在 commit/cancel 时还原。
     */
    private async beginRename(sessionId: string): Promise<void> {
        const target = this.store.sessions.find(session => session.sessionId === sessionId);
        if (!target || target.archived) return;
        if (this.switching) {
            this.tui.flash("会话切换中，稍后再试");
            return;
        }
        if (this.renameSessionId === sessionId) return;

        if (this.store.currentSessionId !== sessionId) {
            await this.selectSession(sessionId);
        }
        // 快照输入框原文。预填标题会触发 onChange 把文本写进草稿，
        // 若不单独保存原文，Esc 取消会把标题当草稿恢复回来。
        this.renameDraft = this.editor.getText();

        const currentTitle = this.store.sessions.find(session => session.sessionId === sessionId)?.title;
        this.renameSessionId = sessionId;
        this.editor.setRenaming(true);
        this.editor.setText(currentTitle ?? "");
        this.restoreFocus();
        this.tui.flash("✎ 编辑会话标题：回车保存 / Esc 取消");
    }

    /** 退出重命名态，输入框还原为进入前的原文（草稿或空）。 */
    private cancelRename(): void {
        if (!this.renameSessionId) return;
        this.renameSessionId = null;
        const draft = this.renameDraft;
        this.renameDraft = "";
        this.editor.setRenaming(false);
        this.editor.setText(draft);
    }

    private async commitRename(sessionId: string, value: string): Promise<void> {
        const cleanTitle = value.trim();
        const draft = this.renameDraft;
        this.renameSessionId = null;
        this.renameDraft = "";
        this.editor.setRenaming(false);
        // 还原进入重命名前的草稿：重命名只消耗标题，不动未发送内容
        this.editor.setText(draft);
        this.setDraft(sessionId, draft, this.editor.getImageAttachments());

        if (!cleanTitle) {
            this.tui.flash("标题为空，已取消重命名");
            return;
        }
        await this.applySessionTitle(sessionId, cleanTitle);
    }

    /** 流式 delta 高频触发时按帧合并同步，避免每 token 全量重建组件。 */
    private syncTimer: ReturnType<typeof setTimeout> | null = null;

    private scheduleSyncMessages(): void {
        if (this.syncTimer) return;
        this.syncTimer = setTimeout(() => {
            this.syncTimer = null;
            this.syncMessages();
        }, 16);
    }

    /** 清空消息树；详情窗口一并复位，换会话后不沿用上一批的展开量。 */
    private clearMessages(): void {
        this.messagesContainer.clear();
        this.messageComponents.clear();
        this.diffTurnWindow = DIFF_TURN_BATCH;
    }

    /** 把 store 的消息投影成组件树；逐条按内容指纹决定是否重建。 */
    private syncMessages(): void {
        const ctx = this.renderContext();
        const ordered: Component[] = [];
        const seen = new Set<number>();

        for (const message of this.store.messages) {
            seen.add(message.id);
            let entry = this.messageComponents.get(message.id);
            if (!entry) {
                entry = createMessageComponent(message);
                this.messageComponents.set(message.id, entry);
            }
            // 内容未变化则跳过重建：流式消息每帧指纹都会变，仅重建活跃消息；
            // 已封口的历史消息指纹稳定，不再重复 new Markdown / ToolBlock。
            const key = messageRenderKey(message, ctx);
            if (entry.renderKey !== key) {
                updateMessageComponent(entry, message, ctx);
                entry.renderKey = key;
            }
            ordered.push(entry.root);
        }

        // 群消息可插入到任意位置：按消息顺序重建子节点，避免新消息只能追加到末尾
        for (const id of [...this.messageComponents.keys()]) {
            if (!seen.has(id)) this.messageComponents.delete(id);
        }
        this.messagesContainer.children = ordered;
        this.tui.requestRender();
    }

    /** 渲染器需要的显示开关快照（渲染层不持有 ChatApp 状态）。 */
    private renderContext(): RenderContext {
        return {
            detailed: this.detailed,
            spinnerIndex: this.spinnerIndex,
            columns: this.tui.terminal.columns,
            diffDetail: this.diffDetail,
            diffMessageIds: this.diffWindowIds(),
            activeTurnMessageId: this.activeTurnMessageId() ?? null,
        };
    }

    /**
     * 当前真正在跑的 assistant 消息：以回合阶段为准，而不是消息上的 streaming 标记。
     * 标记可能因事件缺失而残留，阶段则由回合生命周期统一清理。
     */
    private activeTurnMessageId(): number | undefined {
        const sessionId = this.store.currentSessionId;
        if (!sessionId || !this.turnState.phase(sessionId)) return undefined;
        const messages = this.store.messages;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index]!;
            if (message.role !== "assistant") continue;
            return message.streaming ? message.id : undefined;
        }
        return undefined;
    }

    /** ⌃T 详情窗口：从最新往前允许展示改动详情的 assistant 消息 id。 */
    private diffWindowIds(): Set<number> {
        const ids = new Set<number>();
        if (!this.diffDetail) return ids;

        const messages = this.store.messages;
        let remaining = this.diffTurnWindow;
        for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
            const message = messages[index]!;
            if (message.role !== "assistant") continue;
            ids.add(message.id);
            remaining -= 1;
        }
        return ids;
    }

    /** 是否还有更早 turn 的改动详情没展开。 */
    private hasHiddenDiffTurns(): boolean {
        return this.store.messages.filter(message => message.role === "assistant").length > this.diffTurnWindow;
    }

    /** ⌃T：切换历史 turn 的改动详情（⌃O 已展开全部，此时忽略）。 */
    private toggleDiffDetail(): void {
        if (this.detailed) return;
        this.diffDetail = !this.diffDetail;
        this.diffTurnWindow = DIFF_TURN_BATCH;
        this.rerenderMessages();
    }

    /** 按当前显示开关重绘全部消息（不走 store 通知，避免多余的异步回调）。 */
    private rerenderMessages(): void {
        const ctx = this.renderContext();
        for (const entry of this.messageComponents.values()) {
            const message = this.store.getMessageById(entry.messageId);
            if (!message || !entry.timeline) continue;
            updateMessageComponent(entry, message, ctx);
            entry.renderKey = messageRenderKey(message, ctx);
        }
        this.tui.requestRender();
    }

    /**
     * 向上滚动到逼近顶端时再展开一批 turn 的改动详情（滚动加载）。
     * 新内容插在视口上方，按新增行数补偿滚动位置，视野不跳动。
     */
    private expandDiffDetail(): void {
        if (!this.diffDetail || this.detailed) return;
        if (!this.hasHiddenDiffTurns()) return;
        // 还剩不到一屏可见内容时才补：提前一屏预渲染，滚到底前已就绪
        if (this.scrollView.scrollTop > this.scrollView.viewportHeight) return;

        const width = this.tui.terminal.columns;
        const heightBefore = this.messagesContainer.render(width).length;
        this.diffTurnWindow += DIFF_TURN_BATCH;
        this.syncMessages();
        const addedLines = this.messagesContainer.render(width).length - heightBefore;
        if (addedLines > 0) this.scrollView.scrollBy(addedLines);
    }




    /** 高危操作二次确认：同一标签在 EXIT_CONFIRM_MS 窗口内再按一次才执行，首次给出提示。 */
    private requestConfirm(label: string, run: () => void): void {
        const now = Date.now();
        const pending = this.pendingConfirm;
        if (pending && pending.label === label && now - pending.armedAt <= EXIT_CONFIRM_MS) {
            this.pendingConfirm = null;
            run();
            return;
        }
        this.pendingConfirm = { label, run, armedAt: now };
        this.tui.flash(`再按一次 ${label} 确认`, EXIT_CONFIRM_MS);
    }

    private requestExitWithConfirm(label: string): void {
        if (this.exiting) return;
        this.requestConfirm(label, () => {
            void this.exit();
        });
    }

    shutdown(exitCode = 0): Promise<void> {
        return this.exit(exitCode);
    }

    forceShutdown(exitCode: number): void {
        this.unregisterRuntime();
        this.stopSpinnerTimer();
        // 强退前同步清状态：微任务队列没有机会在 process.exit 之后继续跑
        herdrReporter.releaseSync();
        if (this.terminalStarted) {
            try {
                this.tui.stop({ preserveScreen: true });
                this.terminalStarted = false;
            } catch (error) {
                console.error("⚠️ [TUI] 强制退出时恢复终端失败:", error);
            }
        }
        process.exit(exitCode);
    }

    /** 退出前丢弃 stdin 队列里的残留字节。抽成方法只为了让退出顺序可测（测试会替换掉它）。 */
    async discardTerminalInput(): Promise<number> {
        return await discardPendingInput({ maxMs: 400, idleMs: 60 });
    }

    private async exit(exitCode = 0): Promise<void> {
        if (this.exiting) return;
        this.exiting = true;
        // 前端能力先下线：退出过程中不该再有工具把提问/通知投给这个实例
        this.unregisterRuntime();
        this.unsubscribeBackgroundTaskCompletion();
        this.unsubscribeBackgroundTaskStart();
        // 先释放本实例持有的会话 socket：让等待中的其他实例能立刻接管
        herdrReporter.release();
        this.stopSpinnerTimer();
        this.closeActivePanel();
        await this.flushDrafts();
        // 空会话（从未用过）退出即清理；必须在 close() 之前，会话仍被本实例持有
        await this.deleteEmptySessionsHeld();
        // 先中止进行中的 turn 并等待其落盘（物化为 interrupted turn），再退出；
        // 否则 process.exit 会丢弃未落盘的 turn，重启后本轮上下文丢失。
        try {
            await this.agent.close();
        } catch (error) {
            console.error("⚠️ [TUI] 退出前落盘失败:", error);
        }
        // preserveScreen：退出 alternate buffer（\x1b[?1049l）而不把 TUI 最后一帧
        // 重绘回主 buffer，避免终端残留 TUI 画面与滚动历史。
        try {
            this.tui.stop({ preserveScreen: true });
        } catch (error) {
            console.error("⚠️ [TUI] 退出时恢复终端失败:", error);
        } finally {
            this.terminalStarted = false;
        }
        // stop() 已经弹出 kitty 协议栈并复原 raw 模式，之后到达的应答（设备属性、背景色、
        // 光标位置）不会再被解析，只能直接丢掉：留在队列里会被 shell 回显成一串 ^[ 垃圾。
        // 先 stop 再排空，顺序不能反：协议栈没弹时后续按键还会生成新的 CSI 序列。
        try {
            await this.discardTerminalInput();
        } catch (error) {
            console.error("⚠️ [TUI] 退出前排空终端输入失败:", error);
        }
        this.printNetworkStats();
        process.exit(exitCode);
    }

    /** 退出后输出本实例真实网络请求的用量统计（绕过已重定向到文件的 console）。 */
    private printNetworkStats(): void {
        try {
            const stats = this.agent.getInstanceNetworkStats();
            if (stats.sessionCount === 0) return;
            const fmt = (n: number): string => n.toLocaleString("en-US");
            const hitRate = stats.promptTokens > 0
                ? `${((stats.cacheHitTokens / stats.promptTokens) * 100).toFixed(1)}%`
                : "0.0%";
            process.stdout.write(
                `本实例使用统计：${stats.sessionCount} 个会话 · ${stats.requestCount} 次请求 · `
                + `输入 ${fmt(stats.promptTokens)} tokens · 输出 ${fmt(stats.completionTokens)} tokens · `
                + `思考 ${fmt(stats.reasoningTokens)} tokens · 缓存命中 ${fmt(stats.cacheHitTokens)} · 命中率 ${hitRate}\n`,
            );
        } catch (error) {
            console.error("⚠️ [TUI] 退出时统计输出失败:", error);
        }
    }
}
