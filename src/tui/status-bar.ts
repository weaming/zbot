/** 底部状态栏：按终端宽度自适应渲染（宽屏双行，窄屏 2–4 行）。 */

import type { Component } from "@earendil-works/pi-tui";
import {
    renderStatusBarLines,
    renderWideStatusLine,
    type StatusBarInput,
} from "./status-bar-model.js";

export class StatusBar implements Component {
    private input: StatusBarInput | null = null;
    private line1 = { left: "", right: "" };
    private line2 = { left: "", right: "" };

    /** 设置响应式状态栏数据，render(width) 时按当前列宽排版。 */
    setInput(input: StatusBarInput): void {
        this.input = input;
    }

    /** 直接设置静态双行文本（用于未接入 StatusBarInput 的场景）。 */
    setStatus(
        line1: { left: string; right?: string } | string,
        line2?: { left: string; right?: string } | string,
    ): void {
        this.input = null;
        if (typeof line1 === "string") {
            this.line1 = { left: line1, right: typeof line2 === "string" ? line2 : "" };
            this.line2 = { left: "", right: "" };
        } else {
            this.line1 = { left: line1.left, right: line1.right ?? "" };
            if (line2 && typeof line2 !== "string") {
                this.line2 = { left: line2.left, right: line2.right ?? "" };
            } else if (typeof line2 === "string") {
                this.line2 = { left: line2, right: "" };
            } else {
                this.line2 = { left: "", right: "" };
            }
        }
    }

    render(width: number): string[] {
        const safeWidth = Math.max(1, Math.floor(width));
        if (this.input) {
            return renderStatusBarLines(this.input, safeWidth);
        }
        return [
            renderWideStatusLine(this.line1.left, this.line1.right, safeWidth),
            renderWideStatusLine(this.line2.left, this.line2.right, safeWidth),
        ];
    }

    invalidate(): void {}
}
