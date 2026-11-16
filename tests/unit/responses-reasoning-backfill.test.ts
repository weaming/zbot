import { describe, expect, test } from "bun:test";
import { materializeResponsesInput } from "../../src/tools/orchestrator/messages.js";

const PLAINTEXT = (text: string) => ({
  type: "reasoning",
  content: [{ type: "reasoning_text", text }],
});

function reasoningTexts(items: any[]): string[] {
  return items
    .filter(item => item?.type === "reasoning")
    .map(item => (item.content ?? []).map((part: any) => part.text ?? "").join(""));
}

describe("Responses 明文推理回填", () => {
    test("没有 response_output 的工具轮按 reasoning_content 补明文推理", async () => {
        const items = await materializeResponsesInput([
            { role: "user", content: "跑测试" },
            {
                role: "assistant",
                content: null,
                reasoning_content: "先跑 bash",
                tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } }],
            },
            { role: "tool", tool_call_id: "call_1", content: "ok" },
        ] as any, { ensurePlaintextReasoning: true });

        expect(items[1]).toEqual(PLAINTEXT("先跑 bash"));
        expect(items[2]).toMatchObject({ type: "function_call", call_id: "call_1" });
        // reasoning 必须排在调用项之前：上游按「相邻助手消息」合并它们
        expect(items[3]).toMatchObject({ type: "function_call_output", call_id: "call_1" });
    });

    test("落盘的思考也丢了就补占位文本，不让整请求 400", async () => {
        const items = await materializeResponsesInput([
            { role: "user", content: "hi" },
            { role: "assistant", content: "（中断前的半句回复）" },
        ] as any, { ensurePlaintextReasoning: true });

        expect(items[1].type).toBe("reasoning");
        expect(reasoningTexts(items)[0]?.trim().length).toBeGreaterThan(0);
        expect(items[2]).toMatchObject({ type: "message", role: "assistant" });
    });

    test("已有明文推理时不重复补", async () => {
        const output = [PLAINTEXT("原思考"), { type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" }];
        const items = await materializeResponsesInput([
            { role: "user", content: "跑" },
            { role: "assistant", content: null, response_output: output, tool_calls: [] },
            { role: "tool", tool_call_id: "call_1", content: "ok" },
        ] as any, { ensurePlaintextReasoning: true });

        expect(reasoningTexts(items)).toEqual(["原思考"]);
        expect(items[2]).toMatchObject({ type: "function_call", call_id: "call_1" });
    });

    test("只有加密推理（encrypted_content）时补明文，旧项原样保留", async () => {
        const output = [
            { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "gAAAA", content: [] },
            { type: "function_call", call_id: "call_1", name: "bash", arguments: "{}" },
        ];
        const items = await materializeResponsesInput([
            { role: "user", content: "跑" },
            { role: "assistant", content: null, reasoning_content: "落盘思考", response_output: output, tool_calls: [] },
            { role: "tool", tool_call_id: "call_1", content: "ok" },
        ] as any, { ensurePlaintextReasoning: true });

        expect(reasoningTexts(items)).toEqual(["落盘思考", ""]);
        expect(items[2]).toMatchObject({ type: "reasoning", id: "rs_1" });
    });

    test("未开启回填时不插入推理项（其他上游不接受凭空推理）", async () => {
        const items = await materializeResponsesInput([
            { role: "user", content: "hi" },
            { role: "assistant", content: "回复" },
        ] as any);

        expect(items.map(item => item.type ?? `role:${item.role}`)).toEqual(["role:user", "message"]);
    });
});
