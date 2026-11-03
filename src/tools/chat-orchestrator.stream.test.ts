import { describe, it, expect } from "bun:test";
import { executeWithChat, type ChatClient } from "./chat-orchestrator.js";
import type { UIEvent } from "../events/ui-events.js";

/** 断言送 LLM 的内容时忽略内部消息 id（只服务本地缓存，构造请求体前会剥掉）。 */
function stripMessageIds<T>(messages: T[]): Array<Omit<T, "id">> {
    return messages.map(message => {
        const { id: _id, ...rest } = message as T & { id?: string };
        return rest as Omit<T, "id">;
    });
}

function textChunk(content: string, extra: any = {}): any {
    return {
        id: "chunk-1",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
        ...extra,
    };
}

function toolCallChunk(partial: any, finishReason: string | null = null): any {
    return {
        id: "chunk-1",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta: { tool_calls: [partial] }, finish_reason: finishReason }],
    };
}

function fakeClient(chunks: any[], followUp?: any[]): ChatClient {
    let callCount = 0;
    return {
        baseURL: "http://test.local/v1",
        create: async () => ({
            [Symbol.asyncIterator]: async function* () {
                callCount++;
                const current = callCount === 1 ? chunks : (followUp ?? [
                    textChunk("完成"),
                    { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
                ]);
                for (const chunk of current) yield chunk;
            },
        }),
    };
}

describe("executeWithChat 流式聚合", () => {
    it("流式片段先落盘再展示", async () => {
        const order: string[] = [];
        await executeWithChat({
            query: "问题",
            client: fakeClient([textChunk("你好"), { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]),
            model: "test-model",
            stream: true,
            onStreamDelta: async delta => {
                await Promise.resolve();
                order.push(`persist:${delta.text}`);
            },
            onEvent: event => {
                if (event.type === "text_delta") order.push(`display:${event.delta}`);
            },
        });
        expect(order).toEqual(["persist:你好", "display:你好"]);
    });

    it("流式片段落盘失败时不展示未保存内容", async () => {
        const shown: string[] = [];
        await expect(executeWithChat({
            query: "问题",
            client: fakeClient([textChunk("未保存")]),
            model: "test-model",
            stream: true,
            onStreamDelta: async () => { throw new Error("磁盘不可写"); },
            onEvent: event => {
                if (event.type === "text_delta") shown.push(event.delta);
            },
        })).rejects.toThrow("磁盘不可写");
        expect(shown).toEqual([]);
    });

    it("Chat Completions 流断线后保留已收到的文字与未完成工具参数", async () => {
        const saved: any[] = [];
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async () => ({
                [Symbol.asyncIterator]: async function* () {
                    yield textChunk("已经找到");
                    yield toolCallChunk({ index: 0, id: "call-1", function: { name: "search", arguments: '{"q":' } });
                    throw new Error("Connection error.");
                },
            }),
        };

        await expect(executeWithChat({
            query: "查找",
            client,
            model: "test-model",
            stream: true,
            onTurnMessage: message => { saved.push(message); },
        })).rejects.toThrow("Connection error.");

        expect(saved).toHaveLength(1);
        expect(saved[0].content).toContain("已经找到");
        expect(saved[0].content).toContain('"q"');
        expect(saved[0].tool_calls).toBeUndefined();
    });

    it("只发 done 事件时补上正文、思维链与工具参数", async () => {
        const saved: any[] = [];
        const argsDeltas: any[] = [];
        let round = 0;
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            protocol: "responses",
            create: async () => undefined,
            createResponse: async () => ({
                [Symbol.asyncIterator]: async function* () {
                    round += 1;
                    if (round === 1) {
                        yield { type: "response.output_item.added", output_index: 0, item: {
                            type: "function_call", id: "item-1", call_id: "call-1", name: "search", arguments: "",
                        } };
                        yield { type: "response.function_call_arguments.done", item_id: "item-1", arguments: '{"q":"x"}' };
                        yield { type: "response.output_text.done", text: "合并后的正文" };
                        yield { type: "response.reasoning_text.done", text: "合并后的思考" };
                    } else {
                        yield { type: "response.output_text.delta", delta: "完成" };
                    }
                    yield { type: "response.completed", response: { status: "completed", output: [] } };
                },
            }),
        };

        await executeWithChat({
            query: "查询",
            client,
            model: "test-model",
            stream: true,
            executeTool: async () => "ok",
            onTurnMessage: message => { saved.push(message); },
            onEvent: event => {
                if (event.type === "toolcall_args_delta") argsDeltas.push(event);
            },
        });

        expect(argsDeltas).toEqual([{ type: "toolcall_args_delta", index: 0, delta: '{"q":"x"}' }]);
        expect(saved[0]?.content).toBe("合并后的正文");
        expect(saved[0]?.reasoning_content).toBe("合并后的思考");
        expect(saved[0]?.tool_calls?.[0]?.function?.arguments).toBe('{"q":"x"}');
    });

    it("Responses 流断线后保留已收到的文字", async () => {
        const saved: any[] = [];
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            protocol: "responses",
            create: async () => undefined,
            createResponse: async () => ({
                [Symbol.asyncIterator]: async function* () {
                    yield { type: "response.output_text.delta", delta: "已收到" };
                    throw new Error("Connection error.");
                },
            }),
        };

        await expect(executeWithChat({
            query: "你好",
            client,
            model: "test-model",
            stream: true,
            onTurnMessage: message => { saved.push(message); },
        })).rejects.toThrow("Connection error.");

        expect(stripMessageIds(saved)).toEqual([{ role: "assistant", content: "已收到" }]);
    });

    it("Responses 托管 tool_search 事件显示工具发现进度", async () => {
        const progress: string[] = [];
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            protocol: "responses",
            create: async () => undefined,
            createResponse: async () => ({
                [Symbol.asyncIterator]: async function* () {
                    yield { type: "response.tool_search_call.in_progress", item_id: "ts-1" };
                    yield { type: "response.tool_search_call.searching", item_id: "ts-1" };
                    yield { type: "response.output_text.delta", delta: "找到工具并完成。" };
                    yield { type: "response.completed", response: { status: "completed", output: [] } };
                },
            }),
        };

        await executeWithChat({
            query: "使用 MCP 工具",
            client,
            model: "test-model",
            hostedTools: ["tool_search"],
            stream: true,
            onEvent: event => {
                if (event.type === "progress") progress.push(event.message);
            },
        });

        expect(progress).toEqual(["🌐 找工具中 1..."]);
    });

    it("Responses 联网搜索的三个阶段都解析为进度（含并行搜索与完成汇总）", async () => {
        // 事件序列取样自 deepseek-v4-pro 开启 web_search 的真实流式响应
        const progress: string[] = [];
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            protocol: "responses",
            create: async () => undefined,
            createResponse: async () => ({
                [Symbol.asyncIterator]: async function* () {
                    yield { type: "response.web_search_call.in_progress", item_id: "call_00", output_index: 1 };
                    yield { type: "response.web_search_call.searching", item_id: "call_00", output_index: 1 };
                    yield { type: "response.web_search_call.completed", item_id: "call_00", output_index: 1 };
                    yield { type: "response.web_search_call.in_progress", item_id: "call_01", output_index: 3 };
                    yield { type: "response.web_search_call.in_progress", item_id: "call_02", output_index: 4 };
                    yield { type: "response.web_search_call.searching", item_id: "call_01", output_index: 3 };
                    yield { type: "response.web_search_call.searching", item_id: "call_02", output_index: 4 };
                    yield { type: "response.web_search_call.completed", item_id: "call_01", output_index: 3 };
                    yield { type: "response.web_search_call.completed", item_id: "call_02", output_index: 4 };
                    yield { type: "response.output_text.delta", delta: "两条新闻……" };
                    yield { type: "response.completed", response: { status: "completed", output: [] } };
                },
            }),
        };

        await executeWithChat({
            query: "最近 24 小时的 AI 新闻",
            client,
            model: "test-model",
            hostedTools: ["web_search"],
            stream: true,
            onEvent: event => {
                if (event.type === "progress") progress.push(event.message);
            },
        });

        expect(progress).toEqual([
            "🌐 搜索中 1...",
            "🌐 搜索完成 1",
            "🌐 搜索中 2...",
            "🌐 搜索中 3...",
            "🌐 搜索完成 3",
        ]);
    });

    it("Responses 以 failed 事件结束时保留增量文字", async () => {
        const saved: any[] = [];
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            protocol: "responses",
            create: async () => undefined,
            createResponse: async () => ({
                [Symbol.asyncIterator]: async function* () {
                    yield { type: "response.output_text.delta", delta: "部分回复" };
                    yield { type: "response.failed", response: { status: "failed", output: [] } };
                },
            }),
        };

        await expect(executeWithChat({
            query: "你好",
            client,
            model: "test-model",
            stream: true,
            onTurnMessage: message => { saved.push(message); },
        })).rejects.toThrow("显式标为失败");
        expect(saved[0]?.content).toBe("部分回复");
    });

    it("Responses 失败事件保留未完成工具参数且不执行", async () => {
        const saved: any[] = [];
        let isToolExecuted = false;
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            protocol: "responses",
            create: async () => undefined,
            createResponse: async () => ({
                [Symbol.asyncIterator]: async function* () {
                    yield { type: "response.output_item.added", output_index: 0, item: {
                        type: "function_call", id: "item-1", call_id: "call-1", name: "search", arguments: "",
                    } };
                    yield { type: "response.function_call_arguments.delta", item_id: "item-1", delta: '{"q":' };
                    yield { type: "response.failed" };
                },
            }),
        };

        await expect(executeWithChat({
            query: "查询",
            client,
            model: "test-model",
            stream: true,
            executeTool: async () => { isToolExecuted = true; return "ok"; },
            onTurnMessage: message => { saved.push(message); },
        })).rejects.toThrow("显式标为失败");
        expect(isToolExecuted).toBe(false);
        expect(saved[0]?.content).toContain("search");
        expect(saved[0]?.tool_calls).toBeUndefined();
    });

    it("provider 明确返回失败时保留已生成的文字", async () => {
        const saved: any[] = [];
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async () => ({
                choices: [{ message: { role: "assistant", content: "部分答复" }, finish_reason: "error" }],
            }),
        };

        await expect(executeWithChat({
            query: "问题",
            client,
            model: "test-model",
            onTurnMessage: message => { saved.push(message); },
        })).rejects.toThrow("显式标为失败");
        expect(stripMessageIds(saved)).toEqual([{ role: "assistant", content: "部分答复" }]);
    });

    it("provider 失败时未确认的工具调用只记录参数，不执行", async () => {
        const saved: any[] = [];
        let isToolExecuted = false;
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async () => ({
                choices: [{
                    message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: '{"cmd":"pwd"}' } }],
                    },
                    finish_reason: "error",
                }],
            }),
        };

        await expect(executeWithChat({
            query: "问题",
            client,
            model: "test-model",
            executeTool: async () => { isToolExecuted = true; return "ok"; },
            onTurnMessage: message => { saved.push(message); },
        })).rejects.toThrow("显式标为失败");
        expect(isToolExecuted).toBe(false);
        expect(saved[0]?.content).toContain("bash");
        expect(saved[0]?.tool_calls).toBeUndefined();
    });

    it("消息落盘回调失败会向上抛出，并保留待补写消息", async () => {
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async () => ({
                choices: [{ message: { role: "assistant", content: "已生成" }, finish_reason: "stop" }],
            }),
        };
        let thrown: any;
        try {
            await executeWithChat({
                query: "问题",
                client,
                model: "test-model",
                onTurnMessage: async () => { throw new Error("磁盘不可写"); },
            });
        } catch (error) {
            thrown = error;
        }
        expect(thrown?.message).toContain("回合消息落盘失败");
        expect(stripMessageIds(thrown?.partialMessages ?? [])).toEqual([{ role: "assistant", content: "已生成" }]);
    });

    it("text_delta 事件序列与聚合结果", async () => {
        const chunks = [
            textChunk("你"),
            textChunk("好"),
            {
                ...textChunk(""),
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            },
        ];
        const events: UIEvent[] = [];
        const result = await executeWithChat({
            query: "hi",
            client: fakeClient(chunks),
            model: "test-model",
            stream: true,
            getSystemPrompt: () => "sys",
            onEvent: event => events.push(event),
        });

        expect(result.content).toBe("你好");
        expect(events.filter(event => event.type === "text_delta").map(event => (event as any).delta))
            .toEqual(["你", "好"]);
        expect(events.some(event => event.type === "message_end")).toBe(true);

        const assistant = result.messages.find(message => message.role === "assistant");
        expect(assistant?.content).toBe("你好");
        expect(assistant?.role).toBe("assistant");
    });

    it("tool_calls 按 index 聚合增量并执行", async () => {
        const chunks = [
            toolCallChunk({ index: 0, id: "call-1", function: { name: "lookup_tool", arguments: "" } }),
            toolCallChunk({ index: 0, function: { arguments: '{"q":' } }),
            toolCallChunk({ index: 0, function: { arguments: '"x"}' } }, "tool_calls"),
        ];
        const events: UIEvent[] = [];
        const calls: Array<{ name: string; args: any }> = [];
        const result = await executeWithChat({
            query: "q",
            client: fakeClient(chunks),
            model: "test-model",
            stream: true,
            getSystemPrompt: () => "sys",
            executeTool: async (name, args) => {
                calls.push({ name, args });
                return "ok";
            },
            onEvent: event => events.push(event),
        });

        expect(calls).toEqual([{ name: "lookup_tool", args: { q: "x" } }]);
        expect(events.filter(event => event.type === "toolcall_start")).toHaveLength(1);
        expect(events.filter(event => event.type === "toolcall_args_delta")).toHaveLength(2);
        expect(events.some(event => event.type === "tool_start" && event.name === "lookup_tool")).toBe(true);
        expect(events.some(event => event.type === "tool_result" && event.name === "lookup_tool")).toBe(true);
        expect(result.toolCalls).toBeGreaterThan(1);
    });

    it("保留流式工具调用的 thought_signature", async () => {
        const chunks = [
            toolCallChunk({
                index: 0,
                id: "call-1",
                thought_signature: "c2lnbmF0dXJl",
                function: { name: "lookup_tool", arguments: "{}" },
            }, "tool_calls"),
        ];
        const requests: any[] = [];
        let requestCount = 0;
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async (request: any) => {
                requests.push(structuredClone(request));
                requestCount++;
                if (requestCount === 1) {
                    return {
                        [Symbol.asyncIterator]: async function* () {
                            for (const chunk of chunks) yield chunk;
                        },
                    };
                }
                return {
                    [Symbol.asyncIterator]: async function* () {
                        yield textChunk("完成");
                        yield { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                    },
                };
            },
        };

        await executeWithChat({
            query: "q",
            client,
            model: "test-model",
            stream: true,
            executeTool: async () => "ok",
        });

        expect(requests[1].messages.at(-2)?.tool_calls?.[0]?.thought_signature)
            .toBe("c2lnbmF0dXJl");
    });

    it("reasoning_content 聚合进 assistant 消息并发出 reasoning_delta", async () => {
        const chunks = [
            { ...textChunk(""), choices: [{ index: 0, delta: { reasoning_content: "think" }, finish_reason: null }] },
            textChunk("答案"),
            { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        const events: UIEvent[] = [];
        const result = await executeWithChat({
            query: "q",
            client: fakeClient(chunks),
            model: "test-model",
            stream: true,
            getSystemPrompt: () => "sys",
            onEvent: event => events.push(event),
        });

        expect(events.some(event => event.type === "reasoning_delta" && event.delta === "think")).toBe(true);
        const assistant = result.messages.find(message => message.role === "assistant");
        expect(assistant?.reasoning_content).toBe("think");
    });

    it("空助手消息被 HTTP 400 拒绝后修复请求历史并重试一次", async () => {
        const requests: any[] = [];
        let requestCount = 0;
        let repairCount = 0;
        const history: any[] = [
            { role: "user", content: "之前的问题" },
            { role: "assistant", content: null, reasoning_content: "用户" },
        ];
        const client: ChatClient = {
            baseURL: "https://api.deepseek.com",
            create: async (request: any) => {
                requests.push(structuredClone(request));
                requestCount++;
                if (requestCount === 1) {
                    throw Object.assign(new Error("400 Invalid assistant message: content or tool_calls must be set"), { status: 400 });
                }
                return {
                    [Symbol.asyncIterator]: async function* () {
                        yield textChunk("答案");
                        yield { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                    },
                };
            },
        };

        const result = await executeWithChat({
            query: "问题",
            client,
            model: "deepseek-flash",
            stream: true,
            history,
            onInvalidAssistantHistory: () => { repairCount++; },
        });

        expect(result.content).toBe("答案");
        expect(requests).toHaveLength(2);
        expect(requests[0].messages.some((message: any) => message.role === "assistant" && !message.content)).toBe(true);
        expect(requests[1].messages.some((message: any) => message.role === "assistant" && !message.content && !message.tool_calls?.length)).toBe(false);
        expect(history).toHaveLength(2);
        expect(repairCount).toBe(1);
    });

    it("其他 HTTP 400 不修改历史也不重试", async () => {
        let requestCount = 0;
        const history: any[] = [{ role: "assistant", content: null, reasoning_content: "思考" }];
        const client: ChatClient = {
            baseURL: "https://api.deepseek.com",
            create: async () => {
                requestCount++;
                throw Object.assign(new Error("400 Invalid model"), { status: 400 });
            },
        };

        await expect(executeWithChat({
            query: "问题",
            client,
            model: "deepseek-flash",
            history,
        })).rejects.toThrow("Invalid model");
        expect(requestCount).toBe(1);
        expect(history).toHaveLength(1);
    });

    it("修复历史后仍把后续工具调用和结果加入请求", async () => {
        const requests: any[] = [];
        const client: ChatClient = {
            baseURL: "https://api.deepseek.com",
            create: async (request: any) => {
                requests.push(structuredClone(request));
                if (requests.length === 1) {
                    throw Object.assign(new Error("400 Invalid assistant message: content or tool_calls must be set"), { status: 400 });
                }
                return {
                    [Symbol.asyncIterator]: async function* () {
                        if (requests.length === 2) {
                            yield toolCallChunk({ index: 0, id: "call-read", function: { name: "read", arguments: "{}" } }, "tool_calls");
                            return;
                        }
                        yield textChunk("完成");
                        yield { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                    },
                };
            },
        };

        const result = await executeWithChat({
            query: "问题",
            client,
            model: "deepseek-flash",
            stream: true,
            history: [{ role: "assistant", content: null, reasoning_content: "思考" }],
            executeTool: async () => "工具结果",
        });

        expect(result.content).toBe("完成");
        expect(requests).toHaveLength(3);
        expect(requests[2].messages.some((message: any) => message.role === "assistant" && message.tool_calls?.[0]?.id === "call-read")).toBe(true);
        expect(requests[2].messages.some((message: any) => message.role === "tool" && message.content === "工具结果")).toBe(true);
    });

    it("超大工具结果在请求中被投影，完整历史仍保留原文", async () => {
        const chunks = [
            toolCallChunk({ index: 0, id: "call-big", function: { name: "big_tool", arguments: "{}" } }, "tool_calls"),
        ];
        const requests: any[] = [];
        let requestCount = 0;
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async (request: any) => {
                requests.push(structuredClone(request));
                requestCount++;
                if (requestCount === 1) {
                    return {
                        [Symbol.asyncIterator]: async function* () {
                            for (const chunk of chunks) yield chunk;
                        },
                    };
                }
                return {
                    [Symbol.asyncIterator]: async function* () {
                        yield textChunk("完成");
                        yield { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                    },
                };
            },
        };

        const hugeResult = "x".repeat(50_000);
        const result = await executeWithChat({
            query: "q",
            client,
            model: "test-model",
            stream: true,
            executeTool: async () => hugeResult,
        });

        const toolInRequest = requests[1].messages.at(-1);
        expect(toolInRequest.role).toBe("tool");
        expect(toolInRequest.tool_call_id).toBe("call-big");
        expect(toolInRequest.content).toContain("[工具结果已截取");
        expect(toolInRequest.content.length).toBeLessThan(hugeResult.length);

        const toolInHistory = result.messages.find(message => message.role === "tool");
        expect(toolInHistory?.tool_call_id).toBe("call-big");
        expect(toolInHistory?.content).toBe(hugeResult);
    });

    it("preserveFull 工具结果在请求中完整保留且剥离 contextPolicy", async () => {
        const chunks = [
            toolCallChunk({ index: 0, id: "call-full", function: { name: "full_tool", arguments: "{}" } }, "tool_calls"),
        ];
        const requests: any[] = [];
        let requestCount = 0;
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async (request: any) => {
                requests.push(structuredClone(request));
                requestCount++;
                if (requestCount === 1) {
                    return {
                        [Symbol.asyncIterator]: async function* () {
                            for (const chunk of chunks) yield chunk;
                        },
                    };
                }
                return {
                    [Symbol.asyncIterator]: async function* () {
                        yield textChunk("完成");
                        yield { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                    },
                };
            },
        };

        const hugeResult = "y".repeat(50_000);
        const result = await executeWithChat({
            query: "q",
            client,
            model: "test-model",
            stream: true,
            executeTool: async () => ({
                content: hugeResult,
                contextPolicy: { mode: "full" },
            }),
        });

        const toolInRequest = requests[1].messages.at(-1);
        expect(toolInRequest.role).toBe("tool");
        expect(toolInRequest.tool_call_id).toBe("call-full");
        expect(toolInRequest.content).toBe(hugeResult);
        expect(toolInRequest).not.toHaveProperty("contextPolicy");

        const toolInHistory = result.messages.find(message => message.role === "tool");
        expect(toolInHistory?.content).toBe(hugeResult);
    });

    it("并行多工具调用按 tool_call_id 正确配对且各自投影", async () => {
        const chunks = [
            toolCallChunk({ index: 0, id: "call-a", function: { name: "tool_a", arguments: "{}" } }),
            toolCallChunk({ index: 1, id: "call-b", function: { name: "tool_b", arguments: "{}" } }),
            toolCallChunk({ index: 0 }, "tool_calls"),
            toolCallChunk({ index: 1 }, "tool_calls"),
        ];
        const requests: any[] = [];
        let requestCount = 0;
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async (request: any) => {
                requests.push(structuredClone(request));
                requestCount++;
                if (requestCount === 1) {
                    return {
                        [Symbol.asyncIterator]: async function* () {
                            for (const chunk of chunks) yield chunk;
                        },
                    };
                }
                return {
                    [Symbol.asyncIterator]: async function* () {
                        yield textChunk("完成");
                        yield { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                    },
                };
            },
        };

        const called: string[] = [];
        const result = await executeWithChat({
            query: "q",
            client,
            model: "test-model",
            stream: true,
            executeTool: async (name) => {
                called.push(name);
                return name === "tool_a" ? "ok" : "b".repeat(100_000);
            },
        });

        expect(called.sort()).toEqual(["tool_a", "tool_b"]);
        const requestMessages = requests[1].messages;
        const toolMessages = requestMessages.filter((message: any) => message.role === "tool");
        expect(toolMessages).toHaveLength(2);
        expect(toolMessages.map((message: any) => message.tool_call_id).sort())
            .toEqual(["call-a", "call-b"]);

        const toolA = toolMessages.find((message: any) => message.tool_call_id === "call-a");
        const toolB = toolMessages.find((message: any) => message.tool_call_id === "call-b");
        expect(toolA.content).toBe("ok");
        expect(toolB.content).toContain("[工具结果已截取");

        const assistantCalls = requestMessages.find((message: any) => message.role === "assistant")?.tool_calls;
        expect(assistantCalls.map((call: any) => call.id).sort()).toEqual(["call-a", "call-b"]);

        const historyToolB = result.messages.find(message => message.role === "tool" && message.tool_call_id === "call-b");
        expect(historyToolB?.content).toBe("b".repeat(100_000));
    });

    it("skipUserQuery 不把 query 插入请求消息（续跑对上游无感）", async () => {
        const requests: any[] = [];
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async (request: any) => {
                requests.push(structuredClone(request));
                return {
                    [Symbol.asyncIterator]: async function* () {
                        yield textChunk("完成");
                        yield { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                    },
                };
            },
        };

        await executeWithChat({
            query: "不应出现",
            client,
            model: "test-model",
            stream: true,
            getSystemPrompt: () => "sys",
            history: [{ role: "user", content: "查行情" }],
            skipUserQuery: true,
        });

        expect(requests[0].messages).toEqual([
            { role: "system", content: "sys" },
            { role: "user", content: "查行情" },
        ]);
    });

    it("续跑补跑结果紧跟在 assistant(tool_calls) 之后，不出现重复 tool 消息", async () => {
        const requests: any[] = [];
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async (request: any) => {
                requests.push(structuredClone(request));
                return {
                    [Symbol.asyncIterator]: async function* () {
                        yield textChunk("完成");
                        yield { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                    },
                };
            },
        };

        await executeWithChat({
            query: "",
            client,
            model: "test-model",
            stream: true,
            getSystemPrompt: () => "sys",
            // 历史修复跳过 c1（待重跑），因此这里没有合成的 tool 结果
            history: [
                { role: "user", content: "查行情" },
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
                },
            ],
            skipUserQuery: true,
            pendingToolCalls: [{ id: "c1", name: "bash", args: {}, rawArgs: "{}" }],
            executeTool: async () => "真实结果",
        });

        const messages = requests[0].messages;
        const toolMessages = messages.filter((message: any) => message.role === "tool");
        expect(toolMessages).toHaveLength(1);
        expect(toolMessages[0].content).toBe("真实结果");
        const assistantIndex = messages.findIndex((message: any) => message.role === "assistant");
        expect(messages[assistantIndex + 1]).toMatchObject({ role: "tool", tool_call_id: "c1" });
    });

    it("pendingToolCalls 在进入循环前补跑并落进消息与 onTurnMessage", async () => {
        const calls: Array<{ name: string; args: any }> = [];
        const persisted: any[] = [];
        const requests: any[] = [];
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async (request: any) => {
                requests.push(structuredClone(request));
                return {
                    [Symbol.asyncIterator]: async function* () {
                        yield textChunk("完成");
                        yield { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                    },
                };
            },
        };

        const result = await executeWithChat({
            query: "",
            client,
            model: "test-model",
            stream: true,
            getSystemPrompt: () => "sys",
            history: [
                { role: "user", content: "查行情" },
                { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
            ],
            skipUserQuery: true,
            pendingToolCalls: [{ id: "c1", name: "bash", args: { cmd: "ls" }, rawArgs: '{"cmd":"ls"}' }],
            executeTool: async (name, args) => {
                calls.push({ name, args });
                return "重跑结果";
            },
            onTurnMessage: message => { persisted.push(message); },
        });

        expect(calls).toEqual([{ name: "bash", args: { cmd: "ls" } }]);
        expect(result.messages[0]).toMatchObject({ role: "tool", tool_call_id: "c1", content: "重跑结果" });
        // 补跑结果先于最终 assistant 文本落盘
        expect(persisted.map(message => message.role)).toEqual(["tool", "assistant"]);
        const requestMessages = requests[0].messages;
        expect(requestMessages.filter((message: any) => message.role === "tool")).toHaveLength(1);
    });

    it("Responses 流式 custom_tool_call 收成自由文本调用并按 {patch} 执行", async () => {
        const saved: any[] = [];
        const calls: any[] = [];
        const patchText = "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch";
        let round = 0;
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            protocol: "responses",
            create: async () => undefined,
            createResponse: async () => ({
                [Symbol.asyncIterator]: async function* () {
                    round += 1;
                    if (round === 1) {
                        yield { type: "response.output_item.added", output_index: 0, item: {
                            type: "custom_tool_call", id: "ctc_1", call_id: "call-1", name: "codex__apply_patch", input: "",
                        } };
                        yield { type: "response.custom_tool_call_input.delta", item_id: "ctc_1", output_index: 0, delta: patchText };
                        yield { type: "response.completed", response: { status: "completed", output: [] } };
                        return;
                    }
                    yield { type: "response.output_text.delta", delta: "完成" };
                    yield { type: "response.completed", response: { status: "completed", output: [] } };
                },
            }),
        };

        await executeWithChat({
            query: "改文件",
            client,
            model: "gpt-6-luna",
            stream: true,
            executeTool: async (name, args) => {
                calls.push({ name, args });
                return "ok";
            },
            onTurnMessage: message => { saved.push(message); },
        });

        expect(calls).toEqual([{ name: "codex__apply_patch", args: { patch: patchText } }]);
        expect(saved[0]?.tool_calls?.[0]).toEqual({
            id: "call-1",
            type: "custom",
            custom: { name: "codex__apply_patch", input: patchText },
        });
    });

    it("Chat Completions 流式 custom 工具调用按增量拼出补丁原文", async () => {
        const saved: any[] = [];
        const calls: any[] = [];
        let round = 0;
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            create: async () => ({
                [Symbol.asyncIterator]: async function* () {
                    round += 1;
                    if (round > 1) {
                        yield textChunk("完成");
                        yield { ...textChunk(""), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                        return;
                    }
                    yield toolCallChunk({ index: 0, id: "call-1", type: "custom", custom: { name: "codex__apply_patch", input: "*** Begin Patch\n" } });
                    yield toolCallChunk({ index: 0, custom: { input: "*** End Patch" } }, "tool_calls");
                },
            }),
        };

        await executeWithChat({
            query: "改文件",
            client,
            model: "gpt-6-luna",
            stream: true,
            history: [],
            executeTool: async (name, args) => {
                calls.push({ name, args });
                return "ok";
            },
            onTurnMessage: message => { saved.push(message); },
        });

        expect(calls).toEqual([{ name: "codex__apply_patch", args: { patch: "*** Begin Patch\n*** End Patch" } }]);
        expect(saved[0]?.tool_calls?.[0]).toEqual({
            id: "call-1",
            type: "custom",
            custom: { name: "codex__apply_patch", input: "*** Begin Patch\n*** End Patch" },
        });
    });

    it("Responses 只在 custom input.done 里给全文时也能收到补丁", async () => {
        const saved: any[] = [];
        const calls: any[] = [];
        const patchText = "*** Begin Patch\n*** Add File: b.txt\n+ok\n*** End Patch";
        let round = 0;
        const client: ChatClient = {
            baseURL: "http://test.local/v1",
            protocol: "responses",
            create: async () => undefined,
            createResponse: async () => ({
                [Symbol.asyncIterator]: async function* () {
                    round += 1;
                    if (round === 1) {
                        yield { type: "response.output_item.added", output_index: 0, item: {
                            type: "custom_tool_call", id: "ctc_2", call_id: "call-2", name: "codex__apply_patch", input: "",
                        } };
                        yield { type: "response.custom_tool_call_input.done", item_id: "ctc_2", output_index: 0, input: patchText };
                        yield { type: "response.completed", response: { status: "completed", output: [] } };
                        return;
                    }
                    yield { type: "response.output_text.delta", delta: "完成" };
                    yield { type: "response.completed", response: { status: "completed", output: [] } };
                },
            }),
        };

        await executeWithChat({
            query: "改文件",
            client,
            model: "gpt-6-luna",
            stream: true,
            executeTool: async (name, args) => {
                calls.push({ name, args });
                return "ok";
            },
            onTurnMessage: message => { saved.push(message); },
        });

        expect(calls).toEqual([{ name: "codex__apply_patch", args: { patch: patchText } }]);
        expect(saved[0]?.tool_calls?.[0]?.custom?.input).toBe(patchText);
    });
});
