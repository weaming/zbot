/**
 * 会话事件的 HTTP 视图：只发界面用得上的字段，大块正文（工具输出、推理）不进响应。
 */

import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../../src/events/agent-events.js";
import { toSessionEventView, toSessionEventViews } from "../../src/web/event-view.js";

function event(type: string, payload: Record<string, unknown>, seq = 1): AgentEvent {
    return { seq, ts: "2026-10-30T00:00:00.000Z", sessionId: "s1", type, payload } as unknown as AgentEvent;
}

describe("toSessionEventView", () => {
    test("界面不渲染的事件不下发", () => {
        for (const type of ["turn_segment_start", "turn_stream_delta", "usage_recorded", "lazy_mcp_changed"]) {
            expect(toSessionEventView(event(type, {}))).toBeNull();
        }
    });

    test("工具输出只保留长度与用时，正文不下发", () => {
        const view = toSessionEventView(event("turn_message", {
            message: { role: "tool", tool_call_id: "c1", name: "bash", durationMs: 27, content: "x".repeat(5000) },
        }));

        const message = view?.payload.message as Record<string, unknown>;
        expect(message.content).toBeUndefined();
        expect(message.contentLength).toBe(5000);
        expect(message.durationMs).toBe(27);
        expect(message.name).toBe("bash");
    });

    test("推理正文不下发，只留 hasReasoning", () => {
        const view = toSessionEventView(event("turn_message", {
            message: { role: "assistant", content: "答案", reasoning_content: "想了很久".repeat(100) },
        }));

        const message = view?.payload.message as Record<string, unknown>;
        expect(message.content).toBe("答案");
        expect(message.hasReasoning).toBe(true);
        expect(message.reasoning_content).toBeUndefined();
    });

    test("工具参数：小的带上原文，大的只留摘要", () => {
        const small = toSessionEventView(event("turn_message", {
            message: {
                role: "assistant",
                tool_calls: [{ id: "c1", function: { name: "bash", arguments: '{"command":"pwd && ls"}' } }],
            },
        }));
        const smallCall = (small?.payload.message as any).tool_calls[0];
        expect(smallCall.name).toBe("bash");
        expect(smallCall.summary).toBe("pwd && ls");
        expect(smallCall.arguments).toBe('{"command":"pwd && ls"}');

        const bigArg = JSON.stringify({ patch: "x".repeat(5000) });
        const big = toSessionEventView(event("turn_message", {
            message: { role: "assistant", tool_calls: [{ id: "c2", function: { name: "apply_patch", arguments: bigArg } }] },
        }));
        const bigCall = (big?.payload.message as any).tool_calls[0];
        expect(bigCall.arguments).toBeUndefined();
        // 长参数给长度，界面点开时按需拉全文
        expect(bigCall.argumentSize).toBe(bigArg.length);
        expect(bigCall.summary.length).toBeLessThanOrEqual(121);
    });

    test("空参数不带 arguments，界面不会出现空的参数面板", () => {
        const view = toSessionEventView(event("turn_message", {
            message: { role: "assistant", tool_calls: [{ id: "c1", function: { name: "bash", arguments: "" } }] },
        }));

        const call = (view?.payload.message as any).tool_calls[0];
        expect(call.arguments).toBeUndefined();
        expect(call.argumentSize).toBeUndefined();
    });

    test("期望结果的 session_send：正文随事件下发，界面按对话渲染", () => {
        const args = JSON.stringify({ session: "01J8ZZZZZZZZZZZZZZZZZZZZZZ", text: "改一下 README", expect_result: true });
        const call = toSessionEventView(event("turn_message", {
            message: { role: "assistant", tool_calls: [{ id: "c1", function: { name: "session_send", arguments: args } }] },
        }))?.payload.message as any;

        expect(call.tool_calls[0].expectResult).toBe(true);
        expect(call.tool_calls[0].peerText).toBe("改一下 README");
        // 头部要与 TUI 对齐：目标会话截成短 id，等待秒数单独给
        expect(call.tool_calls[0].peerTarget).toBe("ZZZZZZZZ");
        expect(call.tool_calls[0].peerWaitSeconds).toBeUndefined();

        // 纯通知（expect_result=false）不触发对话式渲染
        const notice = JSON.stringify({ session: "s1", text: "知会一声" });
        const noticeCall = toSessionEventView(event("turn_message", {
            message: { role: "assistant", tool_calls: [{ id: "c2", function: { name: "session_send", arguments: notice } }] },
        }))?.payload.message as any;
        expect(noticeCall.tool_calls[0].expectResult).toBeUndefined();
        expect(noticeCall.tool_calls[0].peerText).toBeUndefined();

        // wait_seconds>0 隐含期望结果
        const waiting = JSON.stringify({ session: "s1", text: "跑一下", wait_seconds: 30 });
        const waitingCall = toSessionEventView(event("turn_message", {
            message: { role: "assistant", tool_calls: [{ id: "c3", function: { name: "session_send", arguments: waiting } }] },
        }))?.payload.message as any;
        expect(waitingCall.tool_calls[0].expectResult).toBe(true);
        expect(waitingCall.tool_calls[0].peerWaitSeconds).toBe(30);
    });

    test("会话间结果下发正文与状态，Web 才能像 TUI 一样铺开", () => {
        const view = toSessionEventView(event("peer_result", {
            msgId: "m1",
            peerId: "01M21GZH0SMW7FTB1X0HQKEPDE",
            peerTitle: "改 README",
            ok: true,
            text: "改好了",
            stopReason: "end_turn",
        }));

        expect(view?.payload).toEqual({
            msgId: "m1",
            peerId: "01M21GZH0SMW7FTB1X0HQKEPDE",
            peerTitle: "改 README",
            ok: true,
            text: "改好了",
        });

        // 取消由服务端判定后下发，前端不需要自己解析 stopReason
        const cancelled = toSessionEventView(event("peer_result", {
            msgId: "m2",
            peerId: "p2",
            ok: false,
            text: "（本轮被取消，没有文本输出）",
            stopReason: "aborted",
        }));
        expect((cancelled?.payload as any).cancelled).toBe(true);
        expect((cancelled?.payload as any).stopReason).toBeUndefined();
    });

    test("session_send 的结果正文下发，其他工具输出仍只留长度", () => {
        const result = toSessionEventView(event("turn_message", {
            message: { role: "tool", tool_call_id: "c1", name: "session_send", durationMs: 12, content: "对方改完了" },
        }))?.payload.message as any;
        expect(result.content).toBe("对方改完了");
        expect(result.contentLength).toBe(5);
        // 不是会话间结果包装形状：不冒充结果状态
        expect(result.peerResultStatus).toBeUndefined();

        const bash = toSessionEventView(event("turn_message", {
            message: { role: "tool", tool_call_id: "c2", name: "bash", durationMs: 12, content: "lots of log" },
        }))?.payload.message as any;
        expect(bash.content).toBeUndefined();
        expect(bash.contentLength).toBe("lots of log".length);
    });

    test("会话间结果正文在下发前剥掉模型侧包装，并带上状态", () => {
        const view = toSessionEventView(event("turn_message", {
            message: {
                role: "tool",
                tool_call_id: "c1",
                name: "session_send",
                durationMs: 12,
                content: "[会话 01J8ZZZ 的结果（未正常完成）]\n改了一半\n（stopReason: max_tokens）",
            },
        }))?.payload.message as any;

        expect(view.content).toBe("改了一半");
        expect(view.peerResultStatus).toBe("failed");
    });

    test("custom 工具形状：名字取 custom.name，apply_patch 按文件统计增删", () => {
        const patch = [
            "*** Begin Patch",
            "*** Update File: src/a.ts",
            "@@ export function a() {",
            "-const old = 1;",
            "+const next = 2;",
            "+const more = 3;",
            "*** Add File: src/b.ts",
            "+export const b = 1;",
            "*** Delete File: src/c.ts",
            "*** End Patch",
            "",
        ].join("\n");
        const view = toSessionEventView(event("turn_message", {
            message: {
                role: "assistant",
                tool_calls: [{ id: "c9", type: "custom", custom: { name: "codex__apply_patch", input: patch } }],
            },
        }));

        const call = (view?.payload.message as any).tool_calls[0];
        expect(call.name).toBe("codex__apply_patch");
        expect(call.summary).toBe("3 个文件 · +3 −1");
        expect(call.patchStat).toEqual({
            files: [
                { path: "src/a.ts", kind: "update", added: 2, removed: 1 },
                { path: "src/b.ts", kind: "add", added: 1, removed: 0 },
                { path: "src/c.ts", kind: "delete", added: 0, removed: 0 },
            ],
            added: 3,
            removed: 1,
        });
        // 小 patch 仍带原文，界面按文件清单渲染，不摊 patch
        expect(call.arguments).toBe(patch);
    });

    test("turn_commit 只发 turnId：界面靠它判断回合是否收尾", () => {
        const view = toSessionEventView(event("turn_commit", {
            turnId: "t1",
            events: [1, 2, 3],
            userMessages: ["hi"],
            stopReason: "stop",
            usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
            interrupted: false,
        }));

        expect(view?.payload).toEqual({ turnId: "t1" });
    });

    test("turn_message 带上 turnId，便于判定该回合是否在跑", () => {
        const view = toSessionEventView(event("turn_message", {
            turnId: "t9",
            message: { role: "assistant", content: "hi", reasoning_content: "想了" },
        }));

        expect(view?.payload.turnId).toBe("t9");
    });

    test("用户消息只带图片 id 与文件名", () => {
        const view = toSessionEventView(event("user_message", {
            text: "看图",
            trigger: "user",
            images: [{ id: "img1", filename: "a.png", path: "/tmp/a.png", mimeType: "image/png", size: 123 }],
        }));

        expect(view?.payload.images).toEqual([{ id: "img1", filename: "a.png" }]);
    });

    test("批量投影会过滤掉不下发的条目", () => {
        const views = toSessionEventViews([
            event("user_message", { text: "hi" }, 1),
            event("turn_segment_start", { turnId: "t1", kind: "text" }, 2),
            event("context_compacted", { compactedContext: "摘要" }, 3),
        ]);

        expect(views.map(view => view.type)).toEqual(["user_message", "context_compacted"]);
    });
});
