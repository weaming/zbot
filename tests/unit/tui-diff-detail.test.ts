/**
 * 改动详情显示策略：历史 turn 只留文件名与增删统计，运行中的 turn 展开 diff，
 * ⌃T 打开后窗口内的历史 turn 也展开。
 */

import { describe, expect, test } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
    createMessageComponent,
    messageRenderKey,
    updateMessageComponent,
    type RenderContext,
} from "../../src/tui/render/messages.js";
import { ChatStore } from "../../src/tui/store.js";
import type { ToolBlock, UiMessage } from "../../src/tui/store.js";

const DIFF_RESULT = [
    "Edited file successfully: sample.txt",
    "",
    "Replacements: 1",
    "",
    "```diff",
    "--- sample.txt",
    "+++ sample.txt",
    "@@ -1,2 +1,2 @@",
    "-old line",
    "+new line",
    "```",
].join("\n");

function makeBlock(): ToolBlock {
    return {
        id: 1,
        requestId: 1,
        toolId: 1,
        name: "edit_file",
        args: "{}",
        result: DIFF_RESULT,
        expanded: false,
    };
}

function makeMessage(streaming: boolean): UiMessage {
    const block = makeBlock();
    return {
        id: 7,
        role: "assistant",
        text: "",
        streaming,
        sortKey: 1,
        timeline: [{ type: "tool", block }],
        toolBlocks: [block],
    };
}

function makeContext(overrides: Partial<RenderContext> = {}): RenderContext {
    return {
        detailed: false,
        spinnerIndex: 0,
        columns: 120,
        diffDetail: false,
        diffMessageIds: new Set<number>(),
        ...overrides,
    };
}

/** 渲染一条消息，返回去色后的纯文本。 */
function renderMessage(message: UiMessage, ctx: RenderContext): string {
    const entry = createMessageComponent(message);
    updateMessageComponent(entry, message, ctx);
    return stripTerminalSequences(entry.timeline!.render(120).join("\n"));
}

describe("改动详情显示", () => {
    test("已结束的历史 turn 只保留文件名与增删统计", () => {
        const text = renderMessage(makeMessage(false), makeContext());

        expect(text).toContain("Edited sample.txt (+1 -1)");
        expect(text).not.toContain("new line");
        expect(text).not.toContain("old line");
    });

    test("运行中的 turn 展开 diff 详情，结束后自动收起", () => {
        const streaming = renderMessage(makeMessage(true), makeContext());
        expect(streaming).toContain("+ new line");
        expect(streaming).toContain("- old line");

        const finished = renderMessage(makeMessage(false), makeContext());
        expect(finished).not.toContain("+ new line");
    });

    test("⌃T 打开后窗口内的历史 turn 展开详情", () => {
        const message = makeMessage(false);
        const text = renderMessage(message, makeContext({ diffDetail: true, diffMessageIds: new Set([message.id]) }));

        expect(text).toContain("+ new line");
    });

    test("窗口外的历史 turn 仍只显示统计", () => {
        const text = renderMessage(makeMessage(false), makeContext({ diffDetail: true, diffMessageIds: new Set([99]) }));

        expect(text).not.toContain("+ new line");
    });

    test("streaming 标记残留但回合已结束：仍收起详情", () => {
        const message = makeMessage(true);

        const stale = renderMessage(message, makeContext({ activeTurnMessageId: null }));
        expect(stale).toContain("Edited sample.txt (+1 -1)");
        expect(stale).not.toContain("+ new line");

        const running = renderMessage(message, makeContext({ activeTurnMessageId: message.id }));
        expect(running).toContain("+ new line");
    });

    test("详情开关与流式状态变化都会让渲染指纹失效", () => {
        const message = makeMessage(false);
        const closed = messageRenderKey(message, makeContext());
        const opened = messageRenderKey(message, makeContext({
            diffDetail: true,
            diffMessageIds: new Set([message.id]),
        }));
        const streaming = messageRenderKey({ ...message, streaming: true }, makeContext());

        expect(opened).not.toBe(closed);
        expect(streaming).not.toBe(closed);
    });

    test("按事件流走一遍：运行中展开，回合结束后收起，⌃T 打开后再展开", () => {
        const store = new ChatStore();
        store.setCurrentSession("s1");
        store.applyEvent(1, "s1", { type: "turn_start", iteration: 1 });
        store.applyEvent(1, "s1", {
            type: "tool_start",
            toolId: 1,
            callId: "c1",
            name: "edit_file",
            args: {},
            mode: "serial",
        });
        store.applyEvent(1, "s1", {
            type: "tool_result",
            toolId: 1,
            callId: "c1",
            name: "edit_file",
            summary: DIFF_RESULT,
            isError: false,
            durationMs: 12,
        });

        const running = assistantMessage(store);
        expect(running.streaming).toBe(true);
        expect(renderMessage(running, makeContext())).toContain("+ new line");

        store.applyEvent(1, "s1", { type: "message_end", content: "完成", stopReason: "end_turn" });
        const finished = assistantMessage(store);
        expect(finished.streaming).toBe(false);
        expect(renderMessage(finished, makeContext())).not.toContain("+ new line");

        const opened = renderMessage(finished, makeContext({
            diffDetail: true,
            diffMessageIds: new Set([finished.id]),
        }));
        expect(opened).toContain("+ new line");
    });
});

function assistantMessage(store: ChatStore): UiMessage {
    const message = store.messages.find(item => item.role === "assistant");
    if (!message) throw new Error("assistant 消息不存在");
    return message;
}
