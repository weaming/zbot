import { describe, expect, test } from "bun:test";

import {
    appendHostedTools,
    buildRequestBody,
    toHostedToolDefinitions,
    toResponsesToolDefinitions,
} from "../../src/tools/orchestrator/request-builder.js";
import { isToolSearchEnabled, prepareRequest } from "../../src/tools/orchestrator/turn-request.js";

/** provider.hostedTools 的托管工具声明：只声明，不执行，且不挤动 function 前缀。 */

const functionTools = [
    { type: "function", function: { name: "grep", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } },
];

describe("toHostedToolDefinitions", () => {
    test("isToolSearchEnabled 只认 Responses + 接入端支持的 tool_search", () => {
        const base = { model: "gpt-5.6-luna", baseURL: "http://127.0.0.1:3060/v1", hostedTools: ["tool_search"] };

        expect(isToolSearchEnabled({ ...base, protocol: "responses" })).toBe(true);
        expect(isToolSearchEnabled({ ...base, protocol: "chat_completions" })).toBe(false);
        expect(isToolSearchEnabled({ ...base, protocol: "responses", hostedTools: ["web_search"] })).toBe(false);
        expect(isToolSearchEnabled({ ...base, protocol: "responses", model: "deepseek-v4-pro" })).toBe(true);
        expect(isToolSearchEnabled({
            ...base,
            protocol: "responses",
            model: "deepseek-v4-pro",
            baseURL: "https://api.deepseek.com/v1",
        })).toBe(false);
        expect(isToolSearchEnabled({
            ...base,
            protocol: "responses",
            model: "deepseek-flash",
            hostedTools: undefined,
        })).toBe(false);
    });

    test("逗号分隔值去空白、去空项、去重后变成扁平工具定义", () => {
        expect(toHostedToolDefinitions([" web_search ", "", "web_search_preview", "web_search"]))
            .toEqual([{ type: "web_search" }, { type: "web_search_preview" }]);
    });

    test("空列表不产生工具定义", () => {
        expect(toHostedToolDefinitions([])).toEqual([]);
    });

    test("按端能力集合过滤不支持的类型", () => {
        expect(toHostedToolDefinitions(
            ["web_search", "tool_search", "file_search"],
            { supportedTypes: new Set(["web_search"]) },
        ))
            .toEqual([{ type: "web_search" }]);
        expect(toHostedToolDefinitions(["tool_search"], { supportedTypes: new Set() })).toEqual([]);
    });
});

describe("appendHostedTools", () => {
    test("追加在尾部，同类型不重复", () => {
        const base = [...toResponsesToolDefinitions(functionTools), { type: "web_search" }];
        expect(appendHostedTools(base, [{ type: "web_search" }, { type: "web_search_preview" }])
            .map(tool => tool.type))
            .toEqual(["function", "function", "web_search", "web_search_preview"]);
    });
});

describe("Responses 请求体", () => {
    test("function 工具保持名称序，托管工具排在后面", () => {
        const tools = appendHostedTools(
            toResponsesToolDefinitions(functionTools),
            toHostedToolDefinitions(["web_search"]),
        );
        const body = buildRequestBody({
            protocol: "responses",
            model: "gpt-5.6-luna",
            baseURL: "http://127.0.0.1:3060/v1",
            messages: [{ role: "user", content: "hi" }],
            tools,
            stream: true,
            isMiniMax: false,
        });

        expect(body.tools.map((tool: any) => tool.type)).toEqual(["function", "function", "web_search"]);
        expect(body.tools[2]).toEqual({ type: "web_search" });
        expect(body.tool_choice).toBe("auto");
        expect(body.store).toBe(false);
    });

    test("只有托管工具时也声明 tool_choice=auto", () => {
        const tools = toHostedToolDefinitions(["web_search"]);
        const body = buildRequestBody({
            protocol: "responses",
            model: "gpt-5.6-luna",
            baseURL: "http://127.0.0.1:3060/v1",
            messages: [{ role: "user", content: "今天有什么 AI 新闻？" }],
            tools,
            stream: false,
            isMiniMax: false,
        });

        expect(body.tools).toEqual([{ type: "web_search" }]);
        expect(body.tool_choice).toBe("auto");
    });

    test("仅启用 tool_search 时把 defer=true 的 MCP function 标记 defer_loading", () => {
        const deferredMcpTool = {
            type: "function",
            deferLoading: true,
            function: { name: "remote__lookup", description: "Lookup", parameters: { type: "object" } },
        };
        expect(toResponsesToolDefinitions([deferredMcpTool], false)[0]).not.toHaveProperty("defer_loading");
        expect(toResponsesToolDefinitions([deferredMcpTool], true)[0]).toHaveProperty("defer_loading", true);
    });
});

describe("Chat Completions 请求体", () => {
    test("只发送 function 工具，不携带 Responses 托管工具类型", async () => {
        const prepared = await prepareRequest({
            client: {
                baseURL: "http://127.0.0.1:8787/provider/codex/v1",
                protocol: "chat_completions",
            },
            model: "gpt-5.6-luna",
            messages: [{ role: "user", content: "今天有什么 AI 新闻？" }] as any,
            tools: functionTools,
            normalizedTools: tools => tools,
            isFirstIteration: true,
            stream: true,
            hostedTools: ["web_search", "tool_search"],
        });

        expect(prepared.requestBody.tools.map((tool: any) => tool.type)).toEqual(["function", "function"]);
        expect(prepared.requestBody.stream_options).toEqual({ include_usage: true });
    });
});

test("prepareRequest 仅在启用 tool_search 时发出 defer_loading MCP 定义", async () => {
    const deferredMcpTool = {
        type: "function",
        deferLoading: true,
        function: { name: "remote__lookup", description: "Lookup", parameters: { type: "object" } },
    };
    const prepare = (hostedTools: string[]) => prepareRequest({
        client: {
            baseURL: "http://127.0.0.1:3060/v1",
            protocol: "responses",
            createResponse: async () => {},
        },
        model: "gpt-5.6-luna",
        messages: [{ role: "user", content: "find" }] as any,
        tools: [deferredMcpTool],
        getToolDefinitions: () => [deferredMcpTool],
        normalizedTools: tools => tools,
        isFirstIteration: true,
        stream: false,
        hostedTools,
    });

    const enabled = await prepare(["tool_search"]);
    const disabled = await prepare(["web_search"]);
    expect(enabled.requestBody.tools).toContainEqual({
        type: "function",
        name: "remote__lookup",
        description: "Lookup",
        parameters: { type: "object" },
        defer_loading: true,
    });
    expect(enabled.requestBody.tools).toContainEqual({ type: "tool_search" });
    expect(disabled.requestBody.tools.find((tool: any) => tool.name === "remote__lookup"))
        .not.toHaveProperty("defer_loading");
    expect(disabled.requestBody.tools).toContainEqual({ type: "web_search" });
});

describe("DeepSeek Responses 端点的托管工具", () => {
    const deferredMcpTool = {
        type: "function",
        deferLoading: true,
        function: { name: "remote__lookup", description: "Lookup", parameters: { type: "object" } },
    };
    const prepare = (model: string, hostedTools: string[], baseURL = "https://api.deepseek.com") => prepareRequest({
        client: {
            baseURL,
            protocol: "responses",
            createResponse: async () => {},
        },
        model,
        messages: [{ role: "user", content: "今天有什么 AI 新闻？" }] as any,
        tools: [deferredMcpTool],
        getToolDefinitions: () => [deferredMcpTool],
        normalizedTools: tools => tools,
        isFirstIteration: true,
        stream: false,
        hostedTools,
    });

    test("pro 档只声明 web_search，tool_search 与 defer_loading 丢弃", async () => {
        const requested = await prepare("deepseek-v4-pro", ["web_search", "tool_search", "file_search"]);
        expect(requested.requestBody.tools.map((tool: any) => tool.type)).toEqual(["function", "web_search"]);
        expect(requested.requestBody.tools[0]).not.toHaveProperty("defer_loading");
    });

    test("flash 档连 web_search 也不声明（上游会忽略）", async () => {
        for (const model of ["deepseek-flash", "deepseek-v4-flash", "gateway/deepseek-v4.1-flash-sg"]) {
            const requested = await prepare(model, ["web_search", "tool_search"]);
            expect(requested.requestBody.tools.map((tool: any) => tool.type)).toEqual(["function"]);
            expect(requested.requestBody.tools[0]).not.toHaveProperty("defer_loading");
        }
    });

    test("网关尊重显式托管工具声明，DeepSeek 模型仍可启用 tool_search 与 defer_loading", async () => {
        for (const baseURL of ["https://gateway.example/v1", "https://api.deepseek.com.evil.example/v1"]) {
            for (const model of ["deepseek-v4-pro", "vendor/deepseek-flash"]) {
                const requested = await prepare(model, ["web_search", "tool_search"], baseURL);
                expect(isToolSearchEnabled({
                    protocol: "responses",
                    model,
                    baseURL,
                    hostedTools: ["web_search", "tool_search"],
                })).toBe(true);
                expect(requested.requestBody.tools.map((tool: any) => tool.type))
                    .toEqual(["function", "web_search", "tool_search"]);
                expect(requested.requestBody.tools[0]).toHaveProperty("defer_loading", true);
            }
        }
    });

    test("网关未声明托管工具时不自动启用，也不发 defer_loading", async () => {
        const requested = await prepare("vendor/deepseek-flash", [], "https://gateway.example/v1");
        expect(requested.requestBody.tools.map((tool: any) => tool.type)).toEqual(["function"]);
        expect(requested.requestBody.tools[0]).not.toHaveProperty("defer_loading");
    });
});
