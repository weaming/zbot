import { describe, expect, test } from "bun:test";
import type { ChatModelSelection } from "../types/chat-model.js";
import type { McpServerStatus } from "../mcp/client-manager.js";
import { ModelMcpPanels, type ModelMcpPanelsDeps, type ModelMcpPanelStack } from "./model-mcp-panels.js";
import type { PanelKind, PanelLayer } from "./panel-stack.js";

/**
 * 模型 / MCP 浮层装配的单测：面板工厂、浮层与栈都是替身，
 * 覆盖"忙/无配置/已有浮层时不打开"、"异步读状态期间换会话就放弃"、以及 lazy 启用集串行落盘。
 */

class FakeStack implements ModelMcpPanelStack {
    layers: PanelLayer[] = [];
    get isEmpty(): boolean {
        return this.layers.length === 0;
    }
    push(layer: PanelLayer): void {
        this.layers.push(layer);
    }
    remove(kind: PanelKind): void {
        const index = this.layers.findIndex(layer => layer.kind === kind);
        if (index >= 0) this.layers.splice(index, 1);
    }
}

const SELECTION: ChatModelSelection = { protocol: "responses", model: "gpt-x" };

function harness(options: {
    busy?: boolean;
    exiting?: boolean;
    options?: ChatModelSelection[];
    servers?: McpServerStatus[];
    readLazy?: (sessionId: string) => Promise<string[]>;
    saveLazy?: (sessionId: string, servers: string[]) => Promise<void>;
} = {}) {
    const stack = new FakeStack();
    const state = {
        current: "sess-a",
        busy: options.busy ?? false,
        exiting: options.exiting ?? false,
        notices: [] as string[],
        wheels: [] as string[],
        renders: 0,
        overlays: [] as PanelKind[],
        applied: [] as Array<{ selection: ChatModelSelection; makeDefault: boolean }>,
        saved: [] as string[][],
        toggles: [] as Array<string[]>,
        setEnabled: [] as string[][],
    };
    const deps: ModelMcpPanelsDeps = {
        panels: stack,
        isExiting: () => state.exiting,
        currentSessionId: () => state.current,
        isSessionBusy: () => state.busy,
        contentRows: () => 10,
        openOverlay: (_panel, kind) => {
            state.overlays.push(kind);
            return { handle: { hide: () => {} }, height: () => 0 } as never;
        },
        afterPanelClosed: () => {},
        requestRender: () => { state.renders += 1; },
        logWheel: line => state.wheels.push(line),
        notify: message => state.notices.push(message),
        currentSelection: () => SELECTION,
        modelOptions: () => options.options ?? [SELECTION],
        applyModel: async (_sessionId, selection, makeDefault) => {
            state.applied.push({ selection, makeDefault });
        },
        mcpServers: () => ({
            servers: options.servers ?? [{ name: "hub", type: "stdio", target: "x", connected: true, toolCount: 1 } as McpServerStatus],
            helpText: "没有配置 MCP",
        }),
        supportsToolSearch: () => true,
        readLazyServers: options.readLazy ?? (async () => ["hub"]),
        saveLazyServers: async (sessionId, servers) => {
            state.saved.push(servers);
            await options.saveLazy?.(sessionId, servers);
        },
        createModelPanel: ({ options: modelOptions, close, complete }) => ({
            handleInput: () => {},
            render: () => [],
            invalidate: () => {},
            close,
            complete,
            options: modelOptions,
        }) as unknown as ModelMcpPanelLike & { close(): void; complete(s: ChatModelSelection, d: boolean): void },
        createMcpPanel: ({ enabled, close, toggle }) => {
            state.setEnabled.push(enabled);
            state.toggles.push([]);
            return {
                handleInput: () => {},
                render: () => [],
                invalidate: () => {},
                close,
                toggle,
                setEnabled: (servers: string[]) => { state.setEnabled.push(servers); },
            };
        },
    };
    return { panels: new ModelMcpPanels(deps), stack, state };
}

describe("ModelMcpPanels 模型面板", () => {
    test("会话忙 / 已有浮层 / 退出中：不打开也不提示或只提示忙", () => {
        const busy = harness({ busy: true });
        busy.panels.openModel("sess-a");
        expect(busy.stack.isEmpty).toBe(true);
        expect(busy.state.notices.at(-1)).toContain("正在执行");

        const open = harness();
        open.stack.push({ kind: "session", panel: { handleInput: () => {} } });
        open.panels.openModel("sess-a");
        expect(open.state.overlays).toEqual([]);

        const exiting = harness({ exiting: true });
        exiting.panels.openModel("sess-a");
        expect(exiting.stack.isEmpty).toBe(true);
    });

    test("没有配置模型：给出配置指引而不是空面板", () => {
        const { panels, stack, state } = harness({ options: [] });
        panels.openModel("sess-a");

        expect(stack.isEmpty).toBe(true);
        expect(state.notices.at(-1)).toContain("OPENAI_RESPONSES_MODELS");
    });

    test("打开模型面板：进栈、记录浮层与日志；complete 交给宿主动作", () => {
        const { panels, stack, state } = harness();
        panels.openModel("sess-a");

        expect(stack.layers.map(layer => layer.kind)).toEqual(["model"]);
        expect(state.overlays).toEqual(["model"]);
        expect(state.wheels).toEqual(["打开面板 model"]);
        expect(state.renders).toBe(1);

        const panel = stack.layers[0]!.panel as unknown as { complete(s: ChatModelSelection, d: boolean): void };
        panel.complete(SELECTION, true);
        expect(state.applied).toEqual([{ selection: SELECTION, makeDefault: true }]);

        panels.closeModel();
        expect(stack.layers).toEqual([]);
    });
});

describe("ModelMcpPanels MCP 面板", () => {
    test("异步读启用集期间切走会话：放弃打开", async () => {
        let release!: (value: string[]) => void;
        const { panels, stack, state } = harness({
            readLazy: () => new Promise<string[]>((resolve) => { release = resolve; }),
        });

        panels.openMcp("sess-a");
        state.current = "sess-b";
        release(["hub"]);
        await Bun.sleep(0);

        expect(stack.isEmpty).toBe(true);
        expect(state.overlays).toEqual([]);
    });

    test("读取失败：写会话提示，不打开面板", async () => {
        const { panels, stack, state } = harness({
            readLazy: async () => {
                throw new Error("socket 断了");
            },
        });

        panels.openMcp("sess-a");
        await Bun.sleep(0);

        expect(stack.isEmpty).toBe(true);
        expect(state.notices.at(-1)).toContain("MCP 状态读取失败");
    });

    test("没有 MCP 服务：给出帮助文案", () => {
        const { panels, stack, state } = harness({ servers: [] });
        panels.openMcp("sess-a");

        expect(stack.isEmpty).toBe(true);
        expect(state.notices.at(-1)).toBe("没有配置 MCP");
    });

    test("lazy 启用集串行落盘：连按只保留最新一份，失败回读真实状态", async () => {
        const gates: Array<() => void> = [];
        const { panels, state } = harness({
            saveLazy: () => new Promise<void>((resolve) => { gates.push(resolve); }),
        });
        panels.openMcp("sess-a");
        await Bun.sleep(0);

        panels.save("sess-a", ["hub"]);
        panels.save("sess-a", ["hub", "rea"]);
        panels.save("sess-a", ["rea"]);

        expect(state.saved).toEqual([["hub"]]);
        gates.shift()!();
        await Bun.sleep(0);
        // 中间两次被合并：只落最新一份
        expect(state.saved).toEqual([["hub"], ["rea"]]);

        gates.shift()!();
        await Bun.sleep(0);
        // 落盘完成后队列清空，下一次保存重新开始
        panels.save("sess-a", []);
        expect(state.saved).toEqual([["hub"], ["rea"], []]);
    });

    test("保存失败：提示并回读真实状态重置勾选", async () => {
        let attempt = 0;
        const { panels, state } = harness({
            readLazy: async () => ["hub"],
            saveLazy: async () => {
                attempt += 1;
                if (attempt === 1) throw new Error("会话锁占用");
            },
        });
        panels.openMcp("sess-a");
        await Bun.sleep(0);

        panels.save("sess-a", ["rea"]);
        await Bun.sleep(0);

        expect(state.notices.at(-1)).toContain("保存失败");
        // 回读后把面板勾选重置回真实值
        expect(state.setEnabled.at(-1)).toEqual(["hub"]);
    });
});
