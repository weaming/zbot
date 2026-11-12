/** 模型选择浮层：provider → 模型（可手输）→ 思考强度 → 是否设为默认。 */

import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ChatModelSelection } from "../types/chat-model.js";
import {
    describeProviderChoices,
    effortChoicesFor,
    resolveEffort,
    type ProviderChoice,
} from "../commands/slash-model.js";
import { PanelBody } from "./panel-body.js";
import { handlePanelScroll } from "./panel-scroll.js";
import { truncatePlain } from "../format/text.js";
import { theme } from "./theme.js";

type Step = "provider" | "model" | "custom" | "effort" | "default";

/** 每一步的序号文案；手输模型是模型步骤的另一种形态，不单独占一步。 */
const STEP_LABELS: Record<Step, string> = {
    provider: "1/4 选择 provider",
    model: "2/4 选择模型",
    custom: "2/4 手输模型",
    effort: "3/4 选择思考强度",
    default: "4/4 设为默认模型？",
};

/** 手输模型的入口文案，作为模型列表的最后一项。 */
const CUSTOM_MODEL_LABEL = "自定义模型…（仅本会话生效）";

export interface ModelPanelOptions {
    /** provider 清单；省略时按配置里的 providers 现取。 */
    providers?: ProviderChoice[];
    options: ChatModelSelection[];
    /** 当前选择：provider、模型与思考强度（强度用于默认高亮）。 */
    current?: ChatModelSelection;
    visibleRows: number;
    close(): void;
    complete(selection: ChatModelSelection, makeDefault: boolean): void | Promise<void>;
}

export class ModelPanel implements Component {
    private readonly root = new PanelBody();
    private readonly providers: ProviderChoice[];
    private step: Step = "provider";
    private providerIndex = 0;
    private modelIndex = 0;
    private effortIndex = 0;
    private defaultIndex = 0;
    private cursor = 0;
    /** 手输模型缓冲（step === "custom" 时生效）。 */
    private custom = "";
    /** 已确认的手输模型：后续步骤都以它为目标模型。 */
    private customModel?: string;

    constructor(private readonly options: ModelPanelOptions) {
        this.providers = options.providers ?? describeProviderChoices();
        const currentProvider = options.current?.provider;
        this.providerIndex = Math.max(0, this.providers.findIndex(provider => provider.name === currentProvider));
        this.cursor = this.providerIndex;
    }

    handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
            this.options.close();
            return;
        }
        if (this.step === "custom") {
            this.handleCustomInput(data);
            return;
        }
        if (matchesKey(data, Key.backspace)) {
            this.goBack();
            return;
        }
        if (handlePanelScroll(data, {
            pageSize: this.options.visibleRows,
            scrollBy: delta => this.moveCursor(delta),
            vimKeys: false,
        })) return;
        if (!matchesKey(data, Key.enter)) return;

        if (this.step === "provider") {
            this.providerIndex = this.cursor;
            this.customModel = undefined;
            this.step = "model";
            const current = this.options.current;
            const sameProvider = this.provider()?.name === current?.provider;
            const currentIndex = sameProvider ? this.modelNames().indexOf(current?.model ?? "") : -1;
            this.modelIndex = Math.max(0, currentIndex);
            this.cursor = this.modelIndex;
            return;
        }
        if (this.step === "model") {
            // 最后一项是手输入口
            if (this.cursor === this.modelNames().length) {
                this.custom = "";
                this.step = "custom";
                this.root.invalidate();
                return;
            }
            this.modelIndex = this.cursor;
            this.customModel = undefined;
            this.step = "effort";
            this.cursor = this.initialEffortIndex();
            return;
        }
        if (this.step === "effort") {
            this.effortIndex = this.cursor;
            // 临时模型不进偏好文件，跳过默认模型这一步
            if (this.isTemporaryModel()) {
                this.finish(false);
                return;
            }
            this.step = "default";
            this.defaultIndex = 0;
            this.cursor = 0;
            return;
        }

        this.defaultIndex = this.cursor;
        this.finish(this.defaultIndex === 1);
    }

    render(width: number): string[] {
        const choices = this.choices();
        const maxChoices = Math.max(1, this.options.visibleRows - 4);
        const start = Math.max(0, Math.min(this.cursor - maxChoices + 1, choices.length - maxChoices));
        const visible = choices.slice(start, start + maxChoices);
        const lines = visible.map((choice, index) => {
            const itemIndex = start + index;
            const prefix = itemIndex === this.cursor ? "❯ " : "  ";
            return new Text(`${prefix}${truncatePlain(choice, Math.max(1, width - 4))}`, 1, 0);
        });
        const target = this.step === "provider" ? "" : `（${this.providerLabel()} · ${this.activeModel() ?? ""}）`;
        const header = new Text(theme.commandBorder(`模型设置 · ${STEP_LABELS[this.step]}${target}`), 1, 0);
        const footer = new Text(
            theme.dim(this.step === "custom"
                ? "输入模型名 · Enter 确认 · Backspace 删除 · Esc 关闭"
                : "↑↓ 选择 · Enter 确认 · Backspace 返回 · Esc 关闭"),
            1,
            0,
        );
        const input = this.step === "custom"
            ? [new Text(`  模型：${this.custom}█`, 1, 0)]
            : [];
        this.root.setChildren([header, ...lines, ...input, footer]);
        return this.root.render(width);
    }

    invalidate(): void {
        this.root.invalidate();
    }

    /** 手输模型：可打印字符累积，Enter 确认（空则退回模型列表）。 */
    private handleCustomInput(data: string): void {
        if (matchesKey(data, Key.enter)) {
            if (!this.custom.trim()) {
                this.step = "model";
                this.root.invalidate();
                return;
            }
            this.customModel = this.custom.trim();
            const efforts = this.effortChoices();
            const current = this.options.current?.reasoningEffort;
            const index = current === undefined ? -1 : efforts.findIndex(value => value.toLowerCase() === current.toLowerCase());
            this.effortIndex = index >= 0 ? index : Math.max(0, efforts.indexOf("auto"));
            this.step = "effort";
            this.cursor = this.effortIndex;
            this.root.invalidate();
            return;
        }
        if (matchesKey(data, Key.backspace)) {
            this.custom = this.custom.slice(0, -1);
            this.root.invalidate();
            return;
        }
        // 只收可打印字符：方向键等控制序列直接丢弃
        const printable = data.replace(/[\u0000-\u001f\u007f]/g, "");
        if (!printable) return;
        this.custom += printable;
        this.root.invalidate();
    }

    private provider(): ProviderChoice | undefined {
        return this.providers[this.providerIndex];
    }

    /** 当前选中的模型名（手输态取输入缓冲）。 */
    private activeModel(): string | undefined {
        if (this.step === "custom") return this.custom.trim() || undefined;
        return this.customModel ?? this.modelNames()[this.modelIndex];
    }

    private isTemporaryModel(): boolean {
        const name = this.activeModel();
        return name !== undefined && !(this.provider()?.models.includes(name) ?? false);
    }

    private finish(makeDefault: boolean): void {
        const provider = this.provider();
        const model = this.activeModel();
        if (!provider || !model) return;
        void this.options.complete(
            {
                provider: provider.name,
                protocol: provider.protocol,
                model,
                reasoningEffort: this.effortChoices()[this.effortIndex] ?? "auto",
            },
            makeDefault,
        );
    }

    private modelNames(): string[] {
        return this.provider()?.models ?? [];
    }

    private effortChoices(): string[] {
        const provider = this.provider();
        const model = this.activeModel();
        return provider && model ? effortChoicesFor(provider.name, model) : ["auto"];
    }

    private initialEffortIndex(): number {
        const efforts = this.effortChoices();
        // 归一化后再找索引：preserve 的返回值可能与展示值大小写不同（如 HIGH vs high），
        // 精确匹配失败会落到第一项 none，等于把思考悄悄关掉
        const current = this.options.current?.reasoningEffort;
        const normalized = current === undefined ? undefined : resolveEffort(current, efforts);
        const desired = normalized?.ok ? normalized.effort : "auto";
        const index = efforts.indexOf(desired);
        return index >= 0 ? index : Math.max(0, efforts.indexOf("auto"));
    }

    private providerLabel(): string {
        const provider = this.provider();
        if (!provider) return "（无 provider）";
        return `${provider.name} · ${provider.protocol === "responses" ? "Responses" : "Chat"}`;
    }

    private choices(): string[] {
        if (this.step === "provider") {
            return this.providers.map(provider => {
                const label = provider.protocol === "responses" ? "Responses API" : "Chat Completions";
                return `${provider.name} · ${label} · ${provider.models.length} 个模型`;
            });
        }
        if (this.step === "model" || this.step === "custom") {
            return [...this.modelNames(), CUSTOM_MODEL_LABEL];
        }
        if (this.step === "effort") return this.effortChoices();
        return ["否（仅应用到当前会话）", "是（同时设为默认模型）"];
    }

    private moveCursor(delta: number): void {
        const maxIndex = Math.max(0, this.choices().length - 1);
        this.cursor = Math.max(0, Math.min(maxIndex, this.cursor + delta));
        this.root.invalidate();
    }

    private goBack(): void {
        if (this.step === "default") {
            this.step = "effort";
            this.cursor = this.effortIndex;
        } else if (this.step === "effort") {
            this.step = "model";
            this.cursor = this.modelIndex;
        } else if (this.step === "model") {
            this.step = "provider";
            this.cursor = this.providerIndex;
        }
        this.root.invalidate();
    }
}
