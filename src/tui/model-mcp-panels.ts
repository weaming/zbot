/**
 * 模型 / MCP 浮层的装配与状态：打开前的前置检查、异步读状态期间的失效判定、
 * 面板实例持有，以及 lazy MCP 启用集的串行落盘与失败回读。
 *
 * 业务动作（落盘模型选择、改 herdr 状态、写会话消息）仍由 ChatApp 通过注入的动作完成；
 * 这里只管「什么时候能开、开哪个、连按怎么合并、失败怎么回读」。
 */

import type { Component } from "@earendil-works/pi-tui";
import type { ChatModelSelection } from "../types/chat-model.js";
import type { McpServerStatus } from "../mcp/client-manager.js";
import type { PanelKind, PanelLayer } from "./panel-stack.js";
import type { PanelOverlay } from "./panel-overlay.js";

/** 面板内容能力：真实实现是 ModelPanel / McpPanel。 */
interface ModelMcpPanelLike extends Component {
    handleInput(data: string): void;
}

/** lazy 启用集的可回读面板。 */
export interface LazyTogglePanel extends ModelMcpPanelLike {
    setEnabled(servers: string[]): void;
}

/** 面板栈里与浮层相关的最小能力（结构上兼容 PanelStack）。 */
export interface ModelMcpPanelStack {
    readonly isEmpty: boolean;
    push(layer: PanelLayer): void;
    remove(kind: PanelKind): void;
}

export interface ModelMcpPanelsDeps {
    panels: ModelMcpPanelStack;
    isExiting(): boolean;
    currentSessionId(): string | null;
    /** 会话正在执行：模型/MCP 下发口径不能在回合中途变。 */
    isSessionBusy(sessionId: string): boolean;
    /** 面板内容行数（按终端高度算）。 */
    contentRows(): number;
    /** 打开浮层（框边、居中、返回句柄）。 */
    openOverlay(panel: Component, kind: PanelKind): PanelOverlay;
    /** 任意浮层关闭后的统一收尾（隐藏、还原焦点、重新露出提问）。 */
    afterPanelClosed(overlay: PanelOverlay): void;
    requestRender(): void;
    logWheel(line: string): void;
    /** 会话级提示（写进时间线）。 */
    notify(message: string, sessionId: string): void;
    /** 当前模型选择（面板默认高亮与强度归一化用）。 */
    currentSelection(): ChatModelSelection | undefined;
    /** 可切换的模型列表。 */
    modelOptions(): ChatModelSelection[];
    applyModel(sessionId: string, selection: ChatModelSelection, makeDefault: boolean): Promise<void>;
    /** MCP 服务状态快照与说明文案（没有配置时给出帮助）。 */
    mcpServers(): { servers: McpServerStatus[]; helpText: string };
    /** 当前接入端是否支持 tool_search（只影响面板说明文案）。 */
    supportsToolSearch(): boolean;
    readLazyServers(sessionId: string): Promise<string[]>;
    saveLazyServers(sessionId: string, servers: string[]): Promise<void>;
    /** 构造面板（真实实现 new ModelPanel / new McpPanel）。 */
    createModelPanel(input: {
        options: ChatModelSelection[];
        current: ChatModelSelection | undefined;
        visibleRows: number;
        close(): void;
        complete(selection: ChatModelSelection, makeDefault: boolean): void;
    }): ModelMcpPanelLike;
    createMcpPanel(input: {
        servers: McpServerStatus[];
        enabled: string[];
        toolSearch: boolean;
        visibleRows: number;
        close(): void;
        toggle(servers: string[]): void;
    }): LazyTogglePanel;
}

export class ModelMcpPanels {
    /** 当前打开的 MCP 面板：落盘失败时回读真实状态重置勾选。 */
    private mcpPanel: LazyTogglePanel | null = null;
    /** 每个会话的启用集保存队列：连按空格时合并成最新一份，串行落盘。 */
    private readonly saveQueues = new Map<string, { running: boolean; queued?: string[] }>();

    constructor(private readonly deps: ModelMcpPanelsDeps) {}

    /** 打开模型面板：无选项/会话忙/已有浮层时给出提示，不打断当前界面。 */
    openModel(sessionId: string): void {
        if (!this.deps.panels.isEmpty || this.deps.isExiting()) return;
        if (this.deps.isSessionBusy(sessionId)) {
            this.deps.notify("当前会话正在执行，暂不能切换模型。", sessionId);
            return;
        }

        const options = this.deps.modelOptions();
        if (options.length === 0) {
            this.deps.notify([
                "没有配置可切换的模型。",
                "请在配置文件中为 Responses API 或 Chat Completions 配置模型：",
                "模型列表来自 config.yaml 的 providers.<name>.models；面板里也能临时手输模型。",
            ].join("\n"), sessionId);
            return;
        }

        const panel = this.deps.createModelPanel({
            options,
            current: this.deps.currentSelection(),
            visibleRows: this.deps.contentRows(),
            close: () => this.closeModel(),
            complete: (selection, makeDefault) => {
                void this.deps.applyModel(sessionId, selection, makeDefault);
            },
        });
        const handle = this.deps.openOverlay(panel, "model");
        this.deps.panels.push({
            kind: "model",
            panel,
            meta: handle,
            onClose: () => this.deps.afterPanelClosed(handle),
        });
        this.deps.logWheel("打开面板 model");
        this.deps.requestRender();
    }

    /** 打开 MCP 面板：读会话启用集是异步的，期间换会话/开别的面板就放弃。 */
    openMcp(sessionId: string): void {
        if (!this.deps.panels.isEmpty || this.deps.isExiting()) return;
        if (this.deps.isSessionBusy(sessionId)) {
            this.deps.notify("当前会话正在执行，暂不能调整 lazy MCP 工具的下发。", sessionId);
            return;
        }

        const { servers, helpText } = this.deps.mcpServers();
        if (servers.length === 0) {
            this.deps.notify(helpText, sessionId);
            return;
        }

        void this.deps.readLazyServers(sessionId).then((enabled) => {
            // 读状态是异步的：期间可能又开了别的面板，或用户已切走会话
            if (!this.deps.panels.isEmpty || this.deps.isExiting()) return;
            if (this.deps.currentSessionId() !== sessionId) return;
            const panel = this.deps.createMcpPanel({
                servers,
                enabled,
                toolSearch: this.deps.supportsToolSearch(),
                visibleRows: this.deps.contentRows(),
                close: () => this.closeMcp(),
                toggle: nextEnabled => this.save(sessionId, nextEnabled),
            });
            const handle = this.deps.openOverlay(panel, "mcp");
            this.mcpPanel = panel;
            this.deps.panels.push({
                kind: "mcp",
                panel,
                meta: handle,
                onClose: () => this.deps.afterPanelClosed(handle),
            });
            this.deps.logWheel("打开面板 mcp");
            this.deps.requestRender();
        }).catch((error: any) => {
            this.deps.notify(`MCP 状态读取失败：${error?.message ?? String(error)}`, sessionId);
        });
    }

    closeModel(): void {
        this.deps.panels.remove("model");
    }

    closeMcp(): void {
        this.mcpPanel = null;
        this.deps.panels.remove("mcp");
    }

    /** 整份启用集落盘：按会话串行，连按空格只保留最新一份。 */
    save(sessionId: string, servers: string[]): void {
        const queue = this.saveQueues.get(sessionId) ?? { running: false };
        this.saveQueues.set(sessionId, queue);
        if (queue.running) {
            queue.queued = servers;
            return;
        }
        queue.running = true;
        void this.flush(sessionId, servers, queue);
    }

    private async flush(
        sessionId: string,
        servers: string[],
        queue: { running: boolean; queued?: string[] },
    ): Promise<void> {
        try {
            await this.deps.saveLazyServers(sessionId, servers);
        } catch (error: any) {
            // 存储失败就丢掉排队项并回读真实状态：宁可少一次切换，也不要面板与事件分叉
            queue.queued = undefined;
            this.saveQueues.delete(sessionId);
            this.deps.notify(`lazy MCP 启用状态保存失败：${error?.message ?? String(error)}`, sessionId);
            await this.resync(sessionId);
            return;
        }

        const next = queue.queued;
        queue.queued = undefined;
        if (next) {
            await this.flush(sessionId, next, queue);
            return;
        }
        queue.running = false;
        this.saveQueues.delete(sessionId);
    }

    /** 回读落盘状态并重置面板勾选。 */
    private async resync(sessionId: string): Promise<void> {
        const panel = this.mcpPanel;
        if (!panel) return;
        try {
            panel.setEnabled(await this.deps.readLazyServers(sessionId));
        } catch (error: any) {
            this.deps.notify(`lazy MCP 状态回读失败：${error?.message ?? String(error)}`, sessionId);
        }
    }
}
