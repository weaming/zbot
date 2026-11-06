import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../events/agent-events.js";
import { toSessionEventView } from "./event-view.js";

describe("steer 会话事件视图", () => {
    test("保留响应状态和输出快照，供历史与 SSE 使用", () => {
        const event: AgentEvent = {
            seq: 3,
            ts: "2026-01-01T00:00:00.000Z",
            sessionId: "session-a",
            type: "steer_update",
            payload: {
                turnId: "turn-a",
                responseId: "response-a",
                phase: "steered",
                text: "已生成但未完成的文字",
            },
        };

        expect(toSessionEventView(event)).toEqual({
            seq: 3,
            ts: event.ts,
            sessionId: "session-a",
            type: "steer_update",
            payload: event.payload,
        });
    });
});
