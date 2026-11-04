/** 模型选择浮层：协议 → 模型 → 思考强度 → 是否设为默认，全程键盘、无需输入文本。 */

import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ChatModelSelection } from "../types/chat-model.js";
import { effortChoicesFor, resolveEffort } from "../commands/slash-model.js";
import { PanelBody } from "./panel-body.js";
import { handlePanelScroll } from "./panel-scroll.js";
import { truncatePlain } from "../format/text.js";
import { theme } from "./theme.js";

type Step = "protocol" | "model" | "effort" | "default";

/** 每一步的总步数，用于标题里的 1/4…4/4。 */
const STEP_LABELS: Record<Step, string> = {
    protocol: "1/4 选择协议",
    model: "2/4 选择模型",
    effort: "3/4 选择思考强度",
    default: "4/4 设为默认模型？",
};

export interface ModelPanelOptions {
    options: ChatModelSelection[];
    /** 当前选择：协议、模型与思考强度（强度用于默认高亮）。 */
    current?: ChatModelSelection;
    visibleRows: number;
    close(): void;
    complete(selection: ChatModelSelection, makeDefault: boolean): void | Promise<void>;
}

export class ModelPanel implements Component {
    private readonly root = new PanelBody();
    private step: Step = "protocol";
    private protocolIndex = 0;
    private modelIndex = 0;
    private effortIndex = 0;
    private defaultIndex = 0;
    private cursor = 0;

    constructor(private readonly options: ModelPanelOptions) {
        const protocols = this.protocols();
        const currentProtocol = options.current?.protocol;
        this.protocolIndex = Math.max(0, protocols.findIndex(protocol => protocol === currentProtocol));
        this.cursor = this.protocolIndex;
    }

    handleInput(data: string): void {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
            this.options.close();
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

        if (this.step === "protocol") {
            this.protocolIndex = this.cursor;
            this.step = "model";
            const current = this.options.current;
            const models = this.models();
            const currentIndex = models.findIndex(option =>
                option.protocol === current?.protocol && option.model === current?.model,
            );
            this.modelIndex = Math.max(0, currentIndex);
            this.cursor = this.modelIndex;
            return;
        }
        if (this.step === "model") {
            this.modelIndex = this.cursor;
            this.step = "effort";
            // 默认高亮：目标模型支持当前档位就用它，否则 auto
            this.cursor = this.initialEffortIndex();
            return;
        }
        if (this.step === "effort") {
            this.effortIndex = this.cursor;
            this.step = "default";
            this.defaultIndex = 0;
            this.cursor = 0;
            return;
        }

        this.defaultIndex = this.cursor;
        const model = this.models()[this.modelIndex];
        if (!model) return;
        const target = this.efforts();
        void this.options.complete(
            {
                protocol: model.protocol,
                model: model.model,
                reasoningEffort: target[this.effortIndex] ?? "auto",
            },
            this.defaultIndex === 1,
        );
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
        const model = this.models()[this.modelIndex];
        const target = model ? `（${model.protocol} · ${model.model}）` : "";
        const header = new Text(theme.commandBorder(`模型设置 · ${STEP_LABELS[this.step]}${this.step === "protocol" ? "" : target}`), 1, 0);
        const footer = new Text(theme.dim("↑↓ 选择 · Enter 确认 · Backspace 返回 · Esc 关闭"), 1, 0);
        this.root.setChildren([header, ...lines, footer]);
        return this.root.render(width);
    }

    invalidate(): void {
        this.root.invalidate();
    }

    private protocols(): ChatModelSelection["protocol"][] {
        return [...new Set(this.options.options.map(option => option.protocol))];
    }

    private models(): ChatModelSelection[] {
        const protocol = this.protocols()[this.protocolIndex];
        return this.options.options.filter(option => option.protocol === protocol);
    }

    /** 目标模型的可用档位（含 auto）：与命令行同一份解析。 */
    private efforts(): string[] {
        const model = this.models()[this.modelIndex];
        return model ? effortChoicesFor(model.protocol, model.model) : ["auto"];
    }

    private initialEffortIndex(): number {
        const model = this.models()[this.modelIndex];
        if (!model) return 0;
        const efforts = this.efforts();
        // 归一化后再找索引：preserve 的返回值可能与展示值大小写不同（如 HIGH vs high），
        // 精确匹配失败会落到第一项 none，等于把思考悄悄关掉
        const current = this.options.current?.reasoningEffort;
        const normalized = current === undefined ? undefined : resolveEffort(current, efforts);
        const desired = normalized?.ok ? normalized.effort : "auto";
        const index = efforts.indexOf(desired);
        return index >= 0 ? index : Math.max(0, efforts.indexOf("auto"));
    }

    private choices(): string[] {
        if (this.step === "protocol") {
            return this.protocols().map(protocol => protocol === "responses" ? "Responses API" : "Chat Completions");
        }
        if (this.step === "model") return this.models().map(option => option.model);
        if (this.step === "effort") return this.efforts();
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
            this.step = "protocol";
            this.cursor = this.protocolIndex;
        }
        this.root.invalidate();
    }
}
