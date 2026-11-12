import { describe, expect, test } from "bun:test";

import {
    adaptToolsForUpstream,
    resolveApplyPatchToolMode,
} from "../../src/tools/orchestrator/apply-patch-tool.js";
import { toResponsesToolDefinitions } from "../../src/tools/orchestrator/request-builder.js";
import { normalizeResponsesResponse } from "../../src/tools/orchestrator/responses-output.js";
import { materializeResponsesInput, normalizeToolCallShapes } from "../../src/tools/orchestrator/messages.js";
import { prepareRequest } from "../../src/tools/orchestrator/turn-request.js";
import { fromOpenAIToolCalls } from "../../src/types/tool-call.js";

/** apply_patch 作为自由文本工具（custom）的下发形态，以及它在两条链路上的往返。 */

const PATCH_TOOL = {
    type: "function",
    function: {
        name: "codex__apply_patch",
        description: "Apply one or more Codex patches to local files.",
        parameters: {
            type: "object",
            properties: {
                cwd: { type: "string", description: "Optional absolute working directory." },
                patch: { type: "string", description: "Complete Codex patch text." },
            },
            required: ["patch"],
        },
    },
};

const READ_TOOL = {
    type: "function",
    function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} } },
};

const PATCH_TEXT = "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch";

describe("resolveApplyPatchToolMode", () => {
    test("gpt 模型走 custom 自由文本工具", () => {
        expect(resolveApplyPatchToolMode(
            { model: "gpt-6-luna", baseURL: "https://api.openai.com/v1" },
            undefined,
        )).toBe("custom");
    });

    test("DeepSeek 端点原样下发（只有 function 工具可用）", () => {
        expect(resolveApplyPatchToolMode({ model: "deepseek-chat", baseURL: "https://api.deepseek.com/v1" }, undefined))
            .toBe("off");
    });

    test("其他模型不做处理", () => {
        expect(resolveApplyPatchToolMode({ model: "claude-4-sonnet", baseURL: "https://api.anthropic.com/v1" }, undefined))
            .toBe("off");
    });

    test("配置覆盖优先于模型判定", () => {
        expect(resolveApplyPatchToolMode(
            { model: "gpt-6-luna", baseURL: "https://api.openai.com/v1" },
            "off",
        )).toBe("off");
        expect(resolveApplyPatchToolMode(
            { model: "deepseek-chat", baseURL: "https://api.deepseek.com" },
            "custom",
        )).toBe("custom");
    });
});

describe("adaptToolsForUpstream", () => {
    test("Responses：apply_patch 变成扁平 custom 工具", () => {
        const [patchTool, readTool] = adaptToolsForUpstream([PATCH_TOOL, READ_TOOL], {
            mode: "custom",
            protocol: "responses",
        });

        expect(patchTool.type).toBe("custom");
        expect(patchTool.name).toBe("codex__apply_patch");
        expect(patchTool.format).toEqual({ type: "text" });
        expect(patchTool.description).toContain("*** Begin Patch");
        expect(patchTool).not.toHaveProperty("function");
        expect(readTool).toBe(READ_TOOL);
    });

    test("描述为空也补上自由文本指令，并保留 deferLoading", () => {
        const bare = {
            type: "function",
            deferLoading: true,
            function: { name: "codex__apply_patch", parameters: { type: "object", properties: {} } },
        };
        const [patchTool] = adaptToolsForUpstream([bare], { mode: "custom", protocol: "responses" });

        expect(patchTool.description).toContain("*** Begin Patch");
        expect(patchTool.deferLoading).toBe(true);
    });

    test("Chat Completions：custom 工具包在 custom 字段里", () => {
        const [patchTool] = adaptToolsForUpstream([PATCH_TOOL], {
            mode: "custom",
            protocol: "chat_completions",
        });

        expect(patchTool.type).toBe("custom");
        expect(patchTool.custom.name).toBe("codex__apply_patch");
        expect(patchTool.custom.format).toEqual({ type: "text" });
        expect(patchTool).not.toHaveProperty("name");
    });

    test("off 模式原样返回（DeepSeek 不再加固描述）", () => {
        expect(adaptToolsForUpstream([PATCH_TOOL], { mode: "off", protocol: "responses" })[0]).toBe(PATCH_TOOL);
        expect(adaptToolsForUpstream([PATCH_TOOL], { mode: "off", protocol: "chat_completions" })[0]).toBe(PATCH_TOOL);
    });

    test("重复适配幂等：描述尾巴只加一次，deferLoading 不丢", () => {
        const once = adaptToolsForUpstream([{ ...PATCH_TOOL, deferLoading: true }], {
            mode: "custom",
            protocol: "responses",
        });
        const twice = adaptToolsForUpstream(once, { mode: "custom", protocol: "responses" });

        expect(twice).toEqual(once);
        expect(twice[0].deferLoading).toBe(true);
        expect(twice[0].description.split("*** Begin Patch").length - 1).toBe(1);

        // Chat Completions 的嵌套 custom 形状读不到名字，再适配原样返回（no-op）
        const chatOnce = adaptToolsForUpstream([PATCH_TOOL], { mode: "custom", protocol: "chat_completions" });
        expect(adaptToolsForUpstream(chatOnce, { mode: "custom", protocol: "chat_completions" })).toEqual(chatOnce);
    });

});

describe("Responses 工具定义", () => {
    test("custom 工具保持扁平形状下发", () => {
        const adapted = adaptToolsForUpstream([PATCH_TOOL], { mode: "custom", protocol: "responses" });
        expect(toResponsesToolDefinitions(adapted)).toEqual([{
            type: "custom",
            name: "codex__apply_patch",
            description: adapted[0].description,
            format: { type: "text" },
        }]);
    });
});

describe("响应解析", () => {
    test("custom_tool_call 收成 custom 工具调用", () => {
        const normalized = normalizeResponsesResponse({
            status: "completed",
            output: [{
                type: "custom_tool_call",
                call_id: "call_1",
                name: "codex__apply_patch",
                input: PATCH_TEXT,
            }],
        });

        expect(normalized.choices[0].message.tool_calls).toEqual([{
            id: "call_1",
            type: "custom",
            custom: { name: "codex__apply_patch", input: PATCH_TEXT },
        }]);
        expect(normalized.choices[0].finish_reason).toBe("tool_calls");
    });

    test("custom 调用在执行层拿到 {patch}", () => {
        const [call] = fromOpenAIToolCalls([{
            id: "call_1",
            type: "custom",
            custom: { name: "codex__apply_patch", input: PATCH_TEXT },
        }]);

        expect(call).toMatchObject({
            id: "call_1",
            name: "codex__apply_patch",
            args: { patch: PATCH_TEXT },
            rawArgs: JSON.stringify({ patch: PATCH_TEXT }),
        });
    });

    test("历史参数不是合法 JSON 时整段原文当补丁，而不是空补丁", () => {
        const shaped = normalizeToolCallShapes([
            {
                role: "assistant",
                content: null,
                tool_calls: [{
                    id: "call_1",
                    type: "function",
                    function: { name: "codex__apply_patch", arguments: PATCH_TEXT },
                }],
            },
        ] as any, "custom");

        expect((shaped[0]!.tool_calls![0] as any).custom.input).toBe(PATCH_TEXT);
    });

    test("截断的 JSON 参数不会把 {\"patch\": 前缀混进补丁", () => {
        const shaped = normalizeToolCallShapes([
            {
                role: "assistant",
                content: null,
                tool_calls: [{
                    id: "call_1",
                    type: "function",
                    function: { name: "codex__apply_patch", arguments: '{"cwd":"~","patch":"*** Beg' },
                }],
            },
        ] as any, "custom");

        expect((shaped[0]!.tool_calls![0] as any).custom.input).toBe("");
    });
});

describe("历史物化", () => {
    test("custom 调用与结果回成 custom_tool_call / custom_tool_call_output", async () => {
        const items = await materializeResponsesInput([
            {
                role: "assistant",
                content: null,
                tool_calls: [{
                    id: "call_1",
                    type: "custom",
                    custom: { name: "codex__apply_patch", input: PATCH_TEXT },
                }],
            },
            { role: "tool", tool_call_id: "call_1", content: "ok" },
        ] as any);

        expect(items).toEqual([
            {
                type: "custom_tool_call",
                call_id: "call_1",
                name: "codex__apply_patch",
                input: PATCH_TEXT,
            },
            {
                type: "custom_tool_call_output",
                call_id: "call_1",
                output: [{ type: "input_text", text: "ok" }],
            },
        ]);
    });

    test("切到不支持 custom 的上游时历史调用降级成 function_call", async () => {
        const shaped = normalizeToolCallShapes([
            {
                role: "assistant",
                content: null,
                tool_calls: [{
                    id: "call_1",
                    type: "custom",
                    custom: { name: "codex__apply_patch", input: PATCH_TEXT },
                }],
            },
        ] as any, "off");

        expect(shaped[0]!.tool_calls).toEqual([{
            id: "call_1",
            type: "function",
            function: { name: "codex__apply_patch", arguments: JSON.stringify({ patch: PATCH_TEXT }) },
        }]);
    });

    test("切到 custom 上游时历史 function 调用升级成 custom", () => {
        const shaped = normalizeToolCallShapes([
            {
                role: "assistant",
                content: null,
                tool_calls: [{
                    id: "call_1",
                    type: "function",
                    function: { name: "codex__apply_patch", arguments: JSON.stringify({ patch: PATCH_TEXT }) },
                }],
            },
        ] as any, "custom");

        expect(shaped[0]!.tool_calls).toEqual([{
            id: "call_1",
            type: "custom",
            custom: { name: "codex__apply_patch", input: PATCH_TEXT },
        }]);
    });

    test("response_output 里的调用项跟着形态改写，并修复 item id 前缀", async () => {
        const responseOutput = [{
            type: "custom_tool_call",
            id: "ctc_raw",
            call_id: "call_1",
            name: "codex__apply_patch",
            input: PATCH_TEXT,
        }];
        const shaped = normalizeToolCallShapes([
            { role: "assistant", content: null, response_output: responseOutput },
        ] as any, "function");

        expect(shaped[0]!.response_output).toEqual([{
            type: "function_call",
            id: "ctc_raw",
            call_id: "call_1",
            name: "codex__apply_patch",
            arguments: JSON.stringify({ patch: PATCH_TEXT }),
        }]);

        const items = await materializeResponsesInput([shaped[0]] as any);
        expect(items[0].type).toBe("function_call");
        expect(items[0].id.startsWith("fc_")).toBe(true);
    });

    test("重放历史时移除可选 status，保留托管工具必需的 status", async () => {
        const items = await materializeResponsesInput([
            {
                role: "assistant",
                content: null,
                response_output: [
                    {
                        type: "reasoning",
                        id: "reasoning_1",
                        status: "completed",
                        encrypted_content: "opaque",
                        summary: [],
                    },
                    {
                        type: "function_call",
                        id: "fc_1",
                        call_id: "call_1",
                        name: "read_file",
                        arguments: "{}",
                        status: "completed",
                    },
                    {
                        type: "web_search_call",
                        id: "ws_1",
                        action: { type: "search", queries: ["nginx"] },
                        status: "completed",
                    },
                ],
            },
        ] as any);

        expect(items).toEqual([
            {
                type: "reasoning",
                id: "reasoning_1",
                encrypted_content: "opaque",
                summary: [],
            },
            {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "read_file",
                arguments: "{}",
            },
            {
                type: "web_search_call",
                id: "ws_1",
                action: { type: "search", queries: ["nginx"] },
                status: "completed",
            },
        ]);
    });
});

describe("prepareRequest 发送前适配", () => {
    const prepare = (model: string, protocol: "responses" | "chat_completions", baseURL: string) => prepareRequest({
        client: {
            baseURL,
            protocol,
            ...(protocol === "responses" ? { createResponse: async () => {} } : {}),
        } as any,
        model,
        messages: [{ role: "user", content: "改个文件" }] as any,
        tools: [PATCH_TOOL, READ_TOOL],
        normalizedTools: tools => tools,
        isFirstIteration: true,
        stream: false,
    });

    test("gpt 模型下发 custom 工具", async () => {
        const prepared = await prepare("gpt-6-luna", "responses", "https://api.openai.com/v1");
        const patchTool = prepared.requestBody.tools.find((tool: any) => tool.name === "codex__apply_patch");

        expect(patchTool!.type).toBe("custom");
        expect(patchTool!.format).toEqual({ type: "text" });
    });

    test("DeepSeek 模型原样下发 function 工具", async () => {
        const prepared = await prepare("deepseek-chat", "chat_completions", "https://api.deepseek.com/v1");
        const patchTool = prepared.requestBody.tools.find(
            (tool: any) => tool.function?.name === "codex__apply_patch",
        );

        expect(patchTool!.type).toBe("function");
        expect(patchTool).toEqual(PATCH_TOOL);
    });

    test("其他模型不动工具定义", async () => {
        const prepared = await prepare("claude-4-sonnet", "chat_completions", "https://api.anthropic.com/v1");
        expect(prepared.requestBody.tools).toEqual([PATCH_TOOL, READ_TOOL]);
    });
});
