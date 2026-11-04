/**
 * 期望结果的 session_send 显示策略：正文与结果常驻（永不收起），⌃O 不改变形态。
 *
 * 派活与回传是这条时间线的主线，折叠掉就等于「派了什么、回了什么」都看不见，
 * 因此这里锁死结构：历史 turn、详细模式、结果未到三种情形都要照常铺开。
 */

import { describe, expect, test } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
    createMessageComponent,
    messageRenderKey,
    updateMessageComponent,
    type RenderContext,
} from "../../src/tui/render/messages.js";
import type { ToolBlock, UiMessage } from "../../src/tui/store.js";

const ACK = "已发送到会话 a1b2c3d4（msgId=7），结果稍后自动回传";

function makeBlock(overrides: Partial<ToolBlock> = {}): ToolBlock {
    return {
        id: 1,
        requestId: 1,
        toolId: 1,
        name: "session_send",
        args: JSON.stringify({ session: "a1b2c3d4", text: "改一下 README 的命令示例", expect_result: true }),
        result: ACK,
        expanded: false,
        ...overrides,
    };
}

function makeMessage(block: ToolBlock): UiMessage {
    return {
        id: 7,
        role: "assistant",
        text: "",
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

describe("期望结果的 session_send", () => {
    test("历史 turn 正常模式下也铺开正文与回执", () => {
        const text = renderMessage(makeMessage(makeBlock()), makeContext());

        expect(text).toContain("🔧 session_send");
        expect(text).toContain("→ a1b2c3d4");
        expect(text).toContain("期望结果");
        // 正文不再占位成 ...
        expect(text).toContain("改一下 README 的命令示例");
        // wait_seconds=0：这只是回执，真结果走 peer_result 气泡
        expect(text).toContain("↩ 已发送");
        expect(text).toContain(ACK);
    });

    test("⌃O 不改变它的渲染", () => {
        const message = makeMessage(makeBlock());

        const normal = renderMessage(message, makeContext());
        const detailed = renderMessage(message, makeContext({ detailed: true }));

        expect(detailed).toBe(normal);
    });

    test("就地等待：结果未到时给出等待提示，到达后换成结果", () => {
        const args = JSON.stringify({ session: "a1b2c3d4", text: "跑一下测试", wait_seconds: 30 });
        const waiting = makeMessage(makeBlock({ args, result: undefined }));
        expect(renderMessage(waiting, makeContext())).toContain("↩ 等待结果回传…");

        const arrived = makeMessage(makeBlock({
            args,
            result: "[会话 a1b2c3d4 的结果]\n跑完了，全绿\n（stopReason: end_turn）",
        }));
        const text = renderMessage(arrived, makeContext());
        expect(text).toContain("↩ 结果");
        expect(text).toContain("跑完了，全绿");
        // 模型侧包装（会话头 + stopReason）不该出现在界面上
        expect(text).not.toContain("stopReason");
        expect(text).not.toContain("等待结果回传");
    });

    test("等待没拿到产出时标「返回」，异常产出保留状态", () => {
        const args = JSON.stringify({ session: "a1b2c3d4", text: "跑一下", wait_seconds: 5 });
        const timeout = renderMessage(
            makeMessage(makeBlock({ args, result: "已发送到会话 a1b2c3d4（msgId=7），等待 5s 未见结果；结果到达后会自动继续，不要重复发送" })),
            makeContext(),
        );
        expect(timeout).toContain("↩ 返回");

        const unfinished = renderMessage(
            makeMessage(makeBlock({
                args,
                result: "[会话 a1b2c3d4 的结果（未正常完成）]\n改了一半\n（stopReason: max_tokens）",
            })),
            makeContext(),
        );
        expect(unfinished).toContain("↩ 结果（未完成）");
        expect(unfinished).toContain("改了一半");
    });

    test("结果到达后渲染指纹失效，界面会重绘", () => {
        const args = JSON.stringify({ session: "a1b2c3d4", text: "跑一下", wait_seconds: 30 });
        const pending = messageRenderKey(makeMessage(makeBlock({ args, result: undefined })), makeContext());
        const done = messageRenderKey(makeMessage(makeBlock({ args, result: "跑完了" })), makeContext());

        expect(done).not.toBe(pending);
    });

    test("失败标「失败」，取消不再挂着「等待结果回传」", () => {
        const args = JSON.stringify({ session: "a1b2c3d4", text: "跑一下", wait_seconds: 30 });
        const failed = renderMessage(
            makeMessage(makeBlock({ args, result: "对方会话不可达", isError: true })),
            makeContext(),
        );
        expect(failed).toContain("↩ 失败");

        const cancelled = renderMessage(
            makeMessage(makeBlock({ args, result: undefined, cancelled: true })),
            makeContext(),
        );
        expect(cancelled).not.toContain("等待结果回传");
    });
});
