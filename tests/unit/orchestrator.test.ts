
import { test, expect, describe } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestImageFile } from "./image-fixture.js";

/** 断言送 LLM 的内容时忽略内部消息 id（只服务本地缓存，构造请求体前会剥掉）。 */
function stripMessageIds<T>(messages: T[]): Array<Omit<T, "id">> {
    return messages.map(message => {
        const { id: _id, ...rest } = message as T & { id?: string };
        return rest as Omit<T, "id">;
    });
}

describe("Chat Orchestrator", () => {
  test("should create chat client with default baseURL", async () => {
    const { createChatClient } = await import('../../src/tools/chat-orchestrator.js');

    const client = createChatClient("test-key");
    expect(client).toBeDefined();
    // baseURL 保持不变，在调用时添加后缀
    expect(client.baseURL).toBe("https://api.openai.com/v1");
  });

  test("should create chat client with custom baseURL", async () => {
    const { createChatClient } = await import('../../src/tools/chat-orchestrator.js');

    const client = createChatClient("test-key", "https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(client).toBeDefined();
    // baseURL 保持不变，在调用时添加后缀
    expect(client.baseURL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });

  test("模型为空时不发送 model 字段，由 llm-server 选择默认模型", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    let request: any;
    const client = {
      baseURL: "http://llm-server:8080/v1",
      create: async (body: any) => {
        request = body;
        return { model: "server-model", choices: [{ message: { content: "ok" } }] };
      },
    };

    const result = await executeWithChat({
      query: "test",
      client,
      model: "",
    });

    expect(result.content).toBe("ok");
    expect(request).not.toHaveProperty("model");
  });

  test("DeepSeek 请求将工具 schema 中的 NUL 正则转换为兼容写法", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    let request: any;
    const client = {
      baseURL: "https://api.deepseek.com/v1",
      create: async (body: any) => {
        request = body;
        return { choices: [{ message: { content: "ok" } }] };
      },
    };
    const tool = {
      type: "function",
      function: {
        name: "analyze_javascript_application",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", pattern: "^[^\\0]*$" },
          },
        },
      },
    };

    await executeWithChat({
      query: "test",
      client,
      model: "deepseek-chat",
      tools: [tool],
    });

    expect(request.tools[0].function.parameters.properties.path.pattern).toBe("^[^\\x00]*$");
    expect(tool.function.parameters.properties.path.pattern).toBe("^[^\\0]*$");
  });

  test("should parse tool calls from message", async () => {
    const { fromOpenAIToolCalls } = await import('../../src/types/tool-call.js');

    const message = {
      tool_calls: [
        {
          id: "call_123",
          function: {
            name: "get_time",
            arguments: '{"timezone": "Asia/Shanghai"}'
          }
        }
      ]
    };

    const toolCalls = fromOpenAIToolCalls(message.tool_calls);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].name).toBe("get_time");
    expect(toolCalls[0].args).toEqual({ timezone: "Asia/Shanghai" });
    expect(toolCalls[0].rawArgs).toBe('{"timezone": "Asia/Shanghai"}');
  });

  test("should execute a tool outside the request tool list", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const requests: any[] = [];
    let requestCount = 0;
    const executedToolNames: string[] = [];

    const client = {
      baseURL: "http://test.invalid",
      create: async (request: any) => {
        requests.push(structuredClone(request));
        requestCount++;

        if (requestCount === 1) {
          return {
            choices: [{
              message: {
                role: "assistant",
                tool_calls: [{
                  id: "call_unavailable",
                  type: "function",
                  function: { name: "unavailable_tool", arguments: "{}" },
                }],
              },
            }],
          };
        }

        return {
          choices: [{ message: { role: "assistant", content: "done" } }],
        };
      },
    };

    const result = await executeWithChat({
      query: "test",
      client,
      model: "test-model",
      tools: [{ type: "function", function: { name: "allowed_tool", parameters: {} } }],
      executeTool: async (name) => {
        executedToolNames.push(name);
        return "executed";
      },
    });

    expect(result.content).toBe("done");
    expect(requests).toHaveLength(2);
    expect(executedToolNames).toEqual(["unavailable_tool"]);
    expect(requests[1].messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_unavailable",
      content: "executed",
    });
    // 耗时与工具名只是本地渲染元数据，不随请求上行
    expect(requests[1].messages.at(-1)).not.toHaveProperty("durationMs");
    expect(requests[1].messages.at(-1)).not.toHaveProperty("name");
    // 消息 id 只服务本地缓存（token 记账 / 工具结果投影），不能出现在请求体里
    expect(requests[1].messages.some((message: any) => "id" in message)).toBe(false);
    expect(stripMessageIds(result.messages)).toEqual([
      {
        role: "assistant",
        tool_calls: [{
          id: "call_unavailable",
          type: "function",
          function: { name: "unavailable_tool", arguments: "{}" },
        }],
      },
      {
        role: "tool",
        tool_call_id: "call_unavailable",
        name: "unavailable_tool",
        content: "executed",
        durationMs: expect.any(Number),
      },
      { role: "assistant", content: "done" },
    ]);
  });

  test("工具返回图片时将图片作为请求专用的多模态用户消息发送", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const requests: any[] = [];
    let requestCount = 0;
    const imageContent = [{
      type: "image_data" as const,
      image: {
        id: "tool-image-1",
        data: "aGVsbG8=",
        filename: "result.png",
        mimeType: "image/png",
      },
    }];
    const client = {
      baseURL: "http://test.invalid",
      create: async (request: any) => {
        requests.push(structuredClone(request));
        requestCount++;
        return requestCount === 1
          ? {
            choices: [{
              message: {
                role: "assistant",
                tool_calls: [{
                  id: "call_read_image",
                  type: "function",
                  function: { name: "read_media_file", arguments: '{"path":"result.png"}' },
                }],
              },
            }],
          }
          : { choices: [{ message: { role: "assistant", content: "图片内容" } }] };
      },
    };

    const result = await executeWithChat({
      query: "分析图片",
      client,
      model: "test-model",
      executeTool: async () => ({
        content: "[image image/png base64_chars=8]",
        imageContent,
      }),
    });

    expect(requests[1].messages.at(-2)).toEqual({
      role: "tool",
      tool_call_id: "call_read_image",
      content: "[image image/png base64_chars=8]",
    });
    expect(requests[1].messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "工具返回了图片，请结合工具结果分析图片内容。" },
        {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,aGVsbG8=",
            detail: "original",
          },
        },
      ],
    });
    expect(result.messages[1]).toMatchObject({ imageContent });
  });

  test("音频模型收到工具音频时补成带 input_audio 的用户消息", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const requests: any[] = [];
    let requestCount = 0;
    const audioContent = [{ data: "UklGRg==", format: "wav" as const }];
    const client = {
      baseURL: "http://test.invalid",
      create: async (request: any) => {
        requests.push(structuredClone(request));
        requestCount++;
        return requestCount === 1
          ? {
            choices: [{
              message: {
                role: "assistant",
                tool_calls: [{
                  id: "call_read_audio",
                  type: "function",
                  function: { name: "read_media_file", arguments: '{"path":"voice.wav"}' },
                }],
              },
            }],
          }
          : { choices: [{ message: { role: "assistant", content: "音频内容" } }] };
      },
    };

    await executeWithChat({
      query: "分析音频",
      client,
      model: "gpt-audio-1.5",
      executeTool: async () => ({
        content: "[audio audio/wav base64_chars=8]",
        audioContent,
      }),
    });

    // 工具消息只留文本，本地 audioContent 不得上行
    expect(requests[1].messages.at(-2)).toEqual({
      role: "tool",
      tool_call_id: "call_read_audio",
      content: "[audio audio/wav base64_chars=8]",
    });
    expect(requests[1].messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "工具返回了音频，请结合工具结果分析音频内容。" },
        { type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } },
      ],
    });
  });

  test("不支持音频的模型只保留文本占位符，不外发 input_audio", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const requests: any[] = [];
    let requestCount = 0;
    const client = {
      baseURL: "http://test.invalid",
      create: async (request: any) => {
        requests.push(structuredClone(request));
        requestCount++;
        return requestCount === 1
          ? {
            choices: [{
              message: {
                role: "assistant",
                tool_calls: [{
                  id: "call_read_audio",
                  type: "function",
                  function: { name: "read_media_file", arguments: '{"path":"voice.wav"}' },
                }],
              },
            }],
          }
          : { choices: [{ message: { role: "assistant", content: "收到" } }] };
      },
    };

    await executeWithChat({
      query: "分析音频",
      client,
      model: "gpt-4o",
      executeTool: async () => ({
        content: "[audio audio/wav base64_chars=8]",
        audioContent: [{ data: "UklGRg==", format: "wav" as const }],
      }),
    });

    const sent = JSON.stringify(requests[1].messages);
    expect(sent).not.toContain("input_audio");
    expect(sent).not.toContain("audioContent");
    expect(requests[1].messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_read_audio",
      content: "[audio audio/wav base64_chars=8]",
    });
  });

  test("GPT Responses 请求使用 function_call_output 的 input_image 格式", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const requests: any[] = [];
    let requestCount = 0;
    const imageContent = [{
      type: "image_data" as const,
      image: {
        id: "responses-tool-image",
        data: "aGVsbG8=",
        filename: "result.png",
        mimeType: "image/png",
      },
    }];
    const client = {
      baseURL: "https://api.openai.com/v1",
      // 协议由 client.protocol 决定，不能只凭存在 createResponse 推断。
      protocol: "responses" as const,
      create: async () => {
        throw new Error("GPT 请求不应走 Chat Completions");
      },
      createResponse: async (request: any) => {
        requests.push(structuredClone(request));
        requestCount++;
        return requestCount === 1
          ? {
            model: "gpt-5.6-luna",
            output: [{
              type: "function_call",
              id: "fc_1",
              call_id: "call_read_image",
              name: "read_media_file",
              arguments: "{}",
            }],
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
          }
          : {
            model: "gpt-5.6-luna",
            output: [{
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "图片内容" }],
            }],
            usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 },
          };
      },
    };

    const result = await executeWithChat({
      query: "分析图片",
      client,
      model: "gpt-5.6-luna",
      tools: [{
        type: "function",
        function: { name: "read_media_file", description: "读取图片", parameters: { type: "object" } },
      }],
      executeTool: async () => ({
        content: "[image image/png base64_chars=8]",
        imageContent,
      }),
    });

    expect(requests[0].tools).toEqual([{
      type: "function",
      name: "read_media_file",
      description: "读取图片",
      parameters: { type: "object" },
    }]);
    expect(requests[1].input).toEqual([
      { role: "user", content: "分析图片" },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_read_image",
        name: "read_media_file",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_read_image",
        output: [
          { type: "input_text", text: "[image image/png base64_chars=8]" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,aGVsbG8=",
            detail: "original",
          },
        ],
      },
    ]);
    expect(result.content).toBe("图片内容");
  });

  test("GPT Responses 历史工具调用仅传 call_id，不传 Chat Completions 的 call ID 作为 item id", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    let request: any;
    const client = {
      baseURL: "https://api.openai.com/v1",
      protocol: "responses" as const,
      create: async () => { throw new Error("不应调用 Chat Completions"); },
      createResponse: async (body: any) => {
        request = body;
        return { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "完成" }] }] };
      },
    };

    await executeWithChat({
      query: "继续",
      client,
      model: "gpt-5.6-luna",
      history: [
        // 历史消息带内部 id（本地缓存记账用），请求体里必须被剥掉
        { id: "m-1", role: "assistant", tool_calls: [{ id: "call_00_u5h6LBjP3G1biuashXC12188", type: "function", function: { name: "get_time", arguments: "{}" } }] },
        { id: "m-2", role: "tool", tool_call_id: "call_00_u5h6LBjP3G1biuashXC12188", content: "10:00" },
      ],
    });

    expect(request.input[0]).toEqual({
      type: "function_call",
      call_id: "call_00_u5h6LBjP3G1biuashXC12188",
      name: "get_time",
      arguments: "{}",
    });
    expect(request.input[0]).not.toHaveProperty("id");
    expect(request.input[1].call_id).toBe(request.input[0].call_id);
    expect(request.input.every((item: any) => !("id" in item))).toBe(true);
  });

  test("GPT Responses 流式响应归一化文本和工具调用事件", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const events: any[] = [];
    let requestCount = 0;
    const client = {
      baseURL: "https://api.openai.com/v1",
      // 协议由 client.protocol 决定，不能只凭存在 createResponse 推断。
      protocol: "responses" as const,
      create: async () => {
        throw new Error("GPT 请求不应走 Chat Completions");
      },
      createResponse: async () => {
        requestCount++;

        async function* firstResponse() {
          yield {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_stream_1",
              call_id: "call_stream_1",
              name: "get_time",
              arguments: "",
            },
          };
          yield {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "fc_stream_1",
            delta: "{}",
          };
          yield {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_stream_1",
              call_id: "call_stream_1",
              name: "get_time",
              arguments: "{}",
            },
          };
          yield {
            type: "response.completed",
            response: {
              model: "gpt-5.6-luna",
              output: [{
                type: "function_call",
                id: "fc_stream_1",
                call_id: "call_stream_1",
                name: "get_time",
                arguments: "{}",
              }],
              usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
            },
          };
        }

        async function* secondResponse() {
          yield { type: "response.output_text.delta", delta: "现在是 " };
          yield { type: "response.output_text.delta", delta: "中午" };
          yield {
            type: "response.completed",
            response: {
              model: "gpt-5.6-luna",
              output: [{
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "现在是 中午" }],
              }],
              usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 },
            },
          };
        }

        return requestCount === 1 ? firstResponse() : secondResponse();
      },
    };

    const result = await executeWithChat({
      query: "现在几点",
      client,
      model: "gpt-5.6-luna",
      stream: true,
      tools: [{
        type: "function",
        function: { name: "get_time", parameters: { type: "object" } },
      }],
      executeTool: async () => "工具时间",
      onEvent: event => events.push(event),
    });

    expect(result.content).toBe("现在是 中午");
    expect(events).toContainEqual({ type: "toolcall_start", index: 0, id: "call_stream_1", name: "get_time" });
    expect(events).toContainEqual({ type: "toolcall_args_delta", index: 0, delta: "{}" });
    expect(events).toContainEqual({ type: "toolcall_end", index: 0, id: "call_stream_1", name: "get_time", argsJson: "{}" });
    expect(events).toContainEqual({ type: "text_delta", delta: "现在是 " });
    expect(events).toContainEqual({ type: "text_delta", delta: "中午" });
  });

  test("GPT Responses 历史工具图片文件不存在时继续发送文本提示", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const requests: any[] = [];
    let requestCount = 0;
    const client = {
      baseURL: "https://api.openai.com/v1",
      // 协议由 client.protocol 决定，不能只凭存在 createResponse 推断。
      protocol: "responses" as const,
      create: async () => {
        throw new Error("GPT 请求不应走 Chat Completions");
      },
      createResponse: async (request: any) => {
        requests.push(structuredClone(request));
        requestCount++;
        return requestCount === 1
          ? {
            output: [{
              type: "function_call",
              id: "fc_missing_image",
              call_id: "call_missing_image",
              name: "read_media_file",
              arguments: "{}",
            }],
          }
          : {
            output: [{
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "文件已不存在" }],
            }],
          };
      },
    };

    await executeWithChat({
      query: "继续分析",
      client,
      model: "gpt-5.6-luna",
      tools: [{
        type: "function",
        function: { name: "read_media_file", parameters: { type: "object" } },
      }],
      executeTool: async () => ({
        content: "历史图片文件已经被删除",
        imageContent: [{
          type: "image_asset" as const,
          image: {
            id: "deleted-image",
            path: "/missing/image.png",
            filename: "image.png",
            mimeType: "image/png" as const,
            sizeBytes: 10,
          },
        }],
      }),
    });

    expect(requests[1].input.at(-1)).toEqual({
      type: "function_call_output",
      call_id: "call_missing_image",
      output: [
        { type: "input_text", text: "历史图片文件已经被删除" },
        { type: "input_text", text: "[图片文件不可用：/missing/image.png]" },
      ],
    });
  });

  test("工具循环可压缩请求上下文且完整保留本轮历史", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const requests: any[] = [];
    const toolCallMessage = {
      role: "assistant",
      tool_calls: [{
        id: "call_compact",
        type: "function",
        function: { name: "large_tool", arguments: "{}" },
      }],
    };
    const client = {
      baseURL: "http://test.invalid",
      create: async (request: any) => {
        requests.push(structuredClone(request));
        return requests.length === 1
          ? { choices: [{ message: toolCallMessage }] }
          : { choices: [{ message: { role: "assistant", content: "done" } }] };
      },
    };

    const result = await executeWithChat({
      query: "执行长任务",
      client,
      model: "test-model",
      executeTool: async () => "很大的工具结果",
      compactMessagesIfNeeded: async () => [
        { role: "system", content: "system" },
        { role: "user", content: "压缩后的当前进展" },
      ],
    });

    expect(requests[1].messages).toEqual([
      { role: "system", content: "system" },
      { role: "user", content: "压缩后的当前进展" },
    ]);
    expect(stripMessageIds(result.messages)).toEqual([
      toolCallMessage,
      {
        role: "tool",
        tool_call_id: "call_compact",
        name: "large_tool",
        content: "很大的工具结果",
        durationMs: expect.any(Number),
      },
      { role: "assistant", content: "done" },
    ]);
  });

  test("请求级压缩后用量上报最后一次响应的输入 token", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const usages: any[] = [];
    const longHistoryText = "a".repeat(4000);
    let requestCount = 0;
    const client = {
      baseURL: "http://test.invalid",
      create: async (_request: any) => {
        requestCount++;
        if (requestCount === 1) {
          return {
            choices: [{
              message: {
                role: "assistant",
                tool_calls: [{ id: "call_big", type: "function", function: { name: "big_tool", arguments: "{}" } }],
              },
            }],
            usage: { prompt_tokens: 5000, completion_tokens: 1, total_tokens: 5001 },
          };
        }
        return {
          choices: [{ message: { role: "assistant", content: "done" } }],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        };
      },
    };

    await executeWithChat({
      query: "继续",
      client,
      model: "test-model",
      history: [{ role: "user", content: longHistoryText }],
      executeTool: async () => "工具结果",
      compactMessagesIfNeeded: async () => [{ role: "user", content: "压缩后的当前进展" }],
      onEvent: event => {
        if (event.type === "usage") usages.push(event.usage);
      },
    });

    const compactedUsage = usages.at(-1);
    expect(compactedUsage.promptTokens).toBe(10);
    expect(compactedUsage.latestPromptTokens).toBe(10);
  });

  test("provider 明确返回输入超窗 400 时强制压缩并仅重试一次", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const requests: any[] = [];
    const compactLimits: number[] = [];
    const client = {
      baseURL: "http://test.invalid",
      create: async (request: any) => {
        requests.push(request);
        if (requests.length === 1) {
          throw Object.assign(new Error("400 WorkBuddy AI: prompt is too long: 1048783 tokens > 1048576 maximum"), { status: 400 });
        }
        return {
          choices: [{ message: { role: "assistant", content: "done" } }],
          usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 },
        };
      },
    };

    const result = await executeWithChat({
      query: "继续",
      client,
      model: "test-model",
      compactMessagesIfNeeded: async (_messages, _lastPromptTokens, providerMaxTokens) => {
        compactLimits.push(providerMaxTokens!);
        return [{ role: "user", content: "压缩后的上下文" }];
      },
    });

    expect(result.content).toBe("done");
    expect(compactLimits).toEqual([1_048_576]);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages).toEqual([{ role: "user", content: "压缩后的上下文" }]);
  });

  test("压缩后再次超窗时保留第二次 provider 错误", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const error = Object.assign(new Error("400 WorkBuddy AI: prompt is too long: 1048783 tokens > 1048576 maximum"), { status: 400 });
    let requests = 0;
    let compactions = 0;

    await expect(executeWithChat({
      query: "继续",
      client: { baseURL: "http://test.invalid", create: async () => { requests++; throw error; } },
      model: "test-model",
      compactMessagesIfNeeded: async () => {
        compactions++;
        return [{ role: "user", content: "摘要" }];
      },
    })).rejects.toThrow("prompt is too long");

    expect(requests).toBe(2);
    expect(compactions).toBe(1);
  });

  test("其他 400 错误不触发压缩重试", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    let requests = 0;
    let compactions = 0;

    await expect(executeWithChat({
      query: "继续",
      client: {
        baseURL: "http://test.invalid",
        create: async () => {
          requests++;
          throw Object.assign(new Error("400 invalid_request_error"), { status: 400 });
        },
      },
      model: "test-model",
      compactMessagesIfNeeded: async () => {
        compactions++;
        return [{ role: "user", content: "摘要" }];
      },
    })).rejects.toThrow("invalid_request_error");

    expect(requests).toBe(1);
    expect(compactions).toBe(0);
  });

  test("should emit tool-call text before executing the tool and keep final text separate", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    let requestCount = 0;
    const emittedContent: string[] = [];
    const events: string[] = [];
    const client = {
      baseURL: "http://test.invalid",
      create: async () => {
        requestCount++;
        if (requestCount === 1) {
          return {
            choices: [{
              message: {
                role: "assistant",
                content: "完整正文",
                tool_calls: [{
                  id: "call_save_memory",
                  type: "function",
                  function: { name: "memory_file", arguments: "{}" },
                }],
              },
            }],
          };
        }

        return {
          choices: [{ message: { role: "assistant", content: "信息来源" } }],
        };
      },
    };

    const result = await executeWithChat({
      query: "test",
      client,
      model: "test-model",
      executeTool: async () => {
        events.push("tool");
        return "saved";
      },
      onAssistantToolCallContent: (content) => {
        emittedContent.push(content);
        events.push("assistant");
      },
    });

    expect(emittedContent).toEqual(["完整正文"]);
    expect(events).toEqual(["assistant", "tool"]);
    expect(result.content).toBe("信息来源");
  });

  test("should consume pending messages and inject them before next iteration request", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const recordedRequests: any[] = [];
    let requestCount = 0;
    let pendingQueue = ["补充指令 A", "补充指令 B"];
    let isPendingPersisted = false;

    const client = {
      baseURL: "http://test.invalid",
      create: async (body: any) => {
        requestCount++;
        recordedRequests.push(JSON.parse(JSON.stringify(body)));
        if (requestCount === 1) {
          return {
            choices: [{
              message: {
                role: "assistant",
                content: "调用工具",
                tool_calls: [{
                  id: "call_tool_1",
                  type: "function",
                  function: { name: "test_tool", arguments: "{}" },
                }],
              },
            }],
          };
        }

        expect(isPendingPersisted).toBe(true);

        return {
          choices: [{ message: { role: "assistant", content: "最终回答" } }],
        };
      },
    };

    const consumedCallbacks: string[] = [];
    const result = await executeWithChat({
      query: "初始查询",
      client,
      model: "test-model",
      executeTool: async () => "工具运行结果",
      consumePendingMessages: () => {
        const items = pendingQueue.splice(0);
        return items.length > 0 ? items : undefined;
      },
      onConsumePending: async (text) => {
        await new Promise(resolve => setTimeout(resolve, 1));
        consumedCallbacks.push(text);
        isPendingPersisted = true;
      },
    });

    expect(consumedCallbacks).toEqual(["补充指令 A\n补充指令 B"]);
    expect(recordedRequests.length).toBe(2);
    // 第二次请求的 messages 应在 tool 结果后包含注入的 user 消息
    const round2Messages = recordedRequests[1].messages;
    const injectedUserMsg = round2Messages.find((m: any) => m.role === "user" && m.content === "补充指令 A\n补充指令 B");
    expect(injectedUserMsg).toBeDefined();
    expect(result.content).toBe("最终回答");
  });

  test("turn_resume consumes queued input before its first request and before accepting a final answer", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const recordedRequests: any[] = [];
    const pendingQueue = ["续跑开始前的输入"];
    const consumed: string[] = [];
    let requestCount = 0;

    const client = {
      baseURL: "http://test.invalid",
      create: async (body: any) => {
        recordedRequests.push(structuredClone(body));
        requestCount += 1;
        if (requestCount === 1) {
          // 用户在首个续跑请求执行期间提交新消息。
          pendingQueue.push("续跑期间的新输入");
          return { choices: [{ message: { role: "assistant", content: "旧任务的阶段性答复" } }] };
        }
        return { choices: [{ message: { role: "assistant", content: "收到补充后的答复" } }] };
      },
    };

    const result = await executeWithChat({
      query: "",
      client,
      model: "test-model",
      skipUserQuery: true,
      initialRequestKind: "turn_resume",
      consumePendingMessages: () => pendingQueue.splice(0),
      onConsumePending: text => { consumed.push(text); },
    });

    expect(requestCount).toBe(2);
    expect(consumed).toEqual(["续跑开始前的输入", "续跑期间的新输入"]);
    expect(recordedRequests[0].messages.some((message: any) =>
      message.role === "user" && message.content === "续跑开始前的输入" )).toBe(true);
    expect(recordedRequests[1].messages.some((message: any) =>
      message.role === "user" && message.content === "续跑期间的新输入" )).toBe(true);
    expect(result.content).toBe("收到补充后的答复");
  });

  test("should retry empty response while retaining its reasoning in history", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const requests: any[] = [];
    let requestCount = 0;
    const client = {
      baseURL: "http://test.invalid",
      create: async (request: any) => {
        requests.push(structuredClone(request));
        requestCount++;
        if (requestCount === 1) {
          // 空响应：无 content、无 tool_calls
          return {
            choices: [{ message: { role: "assistant", content: "", reasoning: "想了一下" } }],
          };
        }
        return {
          choices: [{ message: { role: "assistant", content: "正常回复" } }],
        };
      },
    };

    const result = await executeWithChat({
      query: "test",
      client,
      model: "test-model",
      executeTool: async () => "ok",
    });

    expect(requests).toHaveLength(2);
    expect(result.content).toBe("正常回复");
    // 重试请求不带上先前思考，但完整历史保留已生成内容。
    expect(requests[1].messages.at(-1).role).toBe("user");
    expect(requests[1].messages.at(-1).content).toContain("no tool call and no content");
    expect(result.messages.some(message => message.role === "assistant" && message.reasoning === "想了一下")).toBe(true);
  });

  test("图片请求携带工具并保留图片 URL", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    let request: any;
    const client = {
      baseURL: "http://llm-server:8080/v1",
      create: async (body: any) => {
        request = body;
        return { choices: [{ message: { role: "assistant", content: "图片内容" } }] };
      },
    };
    const imageURL = "https://example.com/photo.jpg";

    const result = await executeWithChat({
      query: "识别图片",
      queryContent: [
        { type: "text", text: "识别图片" },
        {
          type: "image_url",
          image: {
            url: imageURL,
            filename: "photo.jpg",
          },
        },
      ],
      client,
      model: "gpt-5.6-luna",
      tools: [{ type: "function", function: { name: "test_tool", parameters: {} } }],
    });

    expect(result.content).toBe("图片内容");
    expect(request.tools).toEqual([{ type: "function", function: { name: "test_tool", parameters: {} } }]);
    expect(request.tool_choice).toBe("auto");
    expect(request.messages.at(-1).content.at(-1).image_url.url).toBe(imageURL);
  });

  test("图片历史后的文本请求继续携带工具", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    let request: any;
    const imageURL = "https://example.com/photo.jpg";
    const client = {
      baseURL: "http://llm-server:8080/v1",
      create: async (body: any) => {
        request = body;
        return { choices: [{ message: { role: "assistant", content: "文字回复" } }] };
      },
    };

    await executeWithChat({
      query: "继续分析",
      history: [{
        role: "user",
        content: [
          { type: "text", text: "分析这张图" },
          { type: "image_url", image: { url: imageURL, filename: "photo.jpg" } },
        ],
      }],
      client,
      model: "gpt-5.6-luna",
      tools: [{ type: "function", function: { name: "test_tool", parameters: {} } }],
    });

    expect(request.tools).toHaveLength(1);
    expect(request.tool_choice).toBe("auto");
  });

  test("DeepSeek 图片请求使用图片内容并携带工具", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-orchestrator-image-"));
    const originalPath = createTestImageFile(tempDir);
    const requests: any[] = [];
    const client = {
      baseURL: "https://api.deepseek.com/v1",
      create: async (body: any) => {
        requests.push(structuredClone(body));
        return { choices: [{ message: { role: "assistant", content: "图片识别成功" } }] };
      },
    };

    const result = await executeWithChat({
      query: "识别图片",
      queryContent: [
        { type: "text", text: "识别图片" },
        {
          type: "image_asset",
          image: {
            id: "img-test",
            path: originalPath,
            filename: "test-image.png",
            mimeType: "image/png",
            sizeBytes: fs.statSync(originalPath).size,
          },
        },
      ],
      client,
      model: "deepseek-v4-flash-vision-exp",
      tools: [{ type: "function", function: { name: "test_tool", parameters: {} } }],
    });

    expect(result.content).toBe("图片识别成功");
    expect(requests[0].tools).toHaveLength(1);
    expect(requests[0].tool_choice).toBe("auto");
    expect(requests[0].messages.at(-1).content.at(-1)).toMatchObject({
      type: "image_url",
      image_url: { url: expect.stringContaining("data:image/png;base64,") },
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("should give up after repeated empty responses, hint appended only on first retry", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const requests: any[] = [];
    let requestCount = 0;
    const client = {
      baseURL: "http://test.invalid",
      create: async (request: any) => {
        requests.push(structuredClone(request));
        requestCount++;
        return {
          choices: [{ message: { role: "assistant", content: "", reasoning: "还在想" } }],
        };
      },
    };

    const result = await executeWithChat({
      query: "test",
      client,
      model: "test-model",
      executeTool: async () => "ok",
    });

    // 初始请求 + 2 次重试 = 3 次请求
    expect(requests).toHaveLength(3);
    expect(result.content).toBe("");
    // 首次重试追加提示
    expect(requests[1].messages.at(-1).content).toContain("no tool call and no content");
    // 第二次重试不再追加新消息，与首次重试请求完全一致
    expect(requests[2].messages).toEqual(requests[1].messages);
  });

  test("should keep the compaction request identical except for its final user message", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const requests: any[] = [];
    const tools = [{ type: "function", function: { name: "stable_tool", parameters: {} } }];
    const history = [
      { role: "user", content: "历史问题" },
      { role: "assistant", content: "历史回复" },
    ];
    const client = {
      baseURL: "http://test.invalid",
      create: async (request: any) => {
        requests.push(structuredClone(request));
        return { choices: [{ message: { role: "assistant", content: "done" } }] };
      },
    };
    const sharedOptions = {
      client,
      model: "test-model",
      getSystemPrompt: () => "固定系统提示词",
      getToolDefinitions: () => tools,
      history,
    };

    await executeWithChat({
      ...sharedOptions,
      query: "普通用户消息",
      initialRequestKind: "user_request",
    });
    await executeWithChat({
      ...sharedOptions,
      query: "压缩当前消息，不要调用任何工具。",
      initialRequestKind: "context_compaction",
    });

    const [normalRequest, compactionRequest] = requests;
    const { messages: normalMessages, ...normalRequestWithoutMessages } = normalRequest;
    const { messages: compactionMessages, ...compactionRequestWithoutMessages } = compactionRequest;

    expect(compactionRequestWithoutMessages).toEqual(normalRequestWithoutMessages);
    expect(compactionMessages.slice(0, -1)).toEqual(normalMessages.slice(0, -1));
    expect(compactionMessages.at(-1)).toEqual({
      role: "user",
      content: "压缩当前消息，不要调用任何工具。",
    });
  });

  test("should send compact JSON tool output to the next request", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const requests: any[] = [];
    let requestCount = 0;
    const client = {
      baseURL: "http://test",
      async create(request: any) {
        requests.push(structuredClone(request));
        requestCount += 1;
        if (requestCount === 1) {
          return {
            choices: [{
              message: {
                role: "assistant",
                tool_calls: [{
                  id: "call_json",
                  type: "function",
                  function: { name: "longport_json_tool", arguments: "{}" },
                }],
              },
            }],
          };
        }
        return { choices: [{ message: { role: "assistant", content: "done" } }] };
      },
    };

    await executeWithChat({
      query: "test",
      client,
      model: "test-model",
      tools: [{ type: "function", function: { name: "longport_json_tool", parameters: {} } }],
      executeTool: async () => '{\n  "items": [\n    1,\n    2\n  ]\n}',
    });

    expect(requests[1].messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_json",
      content: '{"items":[1,2]}',
    });
  });

  test("should execute tool calls from one response in parallel", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const executedCommands: string[] = [];
    let activeToolCount = 0;
    let maxActiveToolCount = 0;
    let requestCount = 0;
    const client = {
      baseURL: "http://test.invalid",
      create: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return {
            choices: [{
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    id: "call_one",
                    type: "function",
                    function: { name: "bash", arguments: '{"command":"one"}' },
                  },
                  {
                    id: "call_two",
                    type: "function",
                    function: { name: "bash", arguments: '{"command":"two"}' },
                  },
                ],
              },
            }],
          };
        }

        return { choices: [{ message: { role: "assistant", content: "done" } }] };
      },
    };

    const result = await executeWithChat({
      query: "test",
      client,
      model: "test-model",
      executeTool: async (_name, argumentsValue) => {
        executedCommands.push(argumentsValue.command);
        activeToolCount += 1;
        maxActiveToolCount = Math.max(maxActiveToolCount, activeToolCount);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeToolCount -= 1;
        return "ok";
      },
    });

    expect(executedCommands).toEqual(["one", "two"]);
    expect(maxActiveToolCount).toBe(2);
    expect(result.content).toBe("done");
  });
});

describe("Chat Orchestrator finish_reason classification", () => {
  test("length 截断后同一请求重发，下一次成功就返回 content", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const requests: any[] = [];
    let requestCount = 0;
    const client = {
      baseURL: "http://test.invalid",
      create: async () => {
        requestCount++;
        requests.push(requestCount);
        if (requestCount === 1) {
          return {
            choices: [{
              message: { role: "assistant", content: "被截断" },
              finish_reason: "length",
            }],
          };
        }
        return {
          choices: [{
            message: { role: "assistant", content: "完成" },
            finish_reason: "stop",
          }],
        };
      },
    };

    const result = await executeWithChat({
      query: "q",
      client,
      model: "test-model",
    });
    expect(requestCount).toBeGreaterThanOrEqual(2);
    expect(result.content).toBe("完成");
    expect(result.messages.filter(message => message.role === "assistant").map(message => message.content))
      .toEqual(["被截断", "完成"]);
  });

  test("length 反复重试后抛 LLMOutputTruncated", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const client = {
      baseURL: "http://test.invalid",
      create: async () => ({
        choices: [{
          message: { role: "assistant", content: "x" },
          finish_reason: "length",
        }],
      }),
    };
    await expect(executeWithChat({
      query: "q",
      client,
      model: "test-model",
    })).rejects.toThrow(/length/);
  });

  test("content_filter 立即抛错", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const client = {
      baseURL: "http://test.invalid",
      create: async () => ({
        choices: [{
          message: { role: "assistant", content: "x" },
          finish_reason: "content_filter",
        }],
      }),
    };
    await expect(executeWithChat({
      query: "q",
      client,
      model: "test-model",
    })).rejects.toThrow(/content_filter/);
  });

  test("finish_reason=error 立即抛错", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const client = {
      baseURL: "http://test.invalid",
      create: async () => ({
        choices: [{
          message: { role: "assistant", content: null },
          finish_reason: "error",
        }],
      }),
    };
    await expect(executeWithChat({
      query: "q",
      client,
      model: "test-model",
    })).rejects.toThrow(/error/);
  });

  test("context reminders 只注入后续请求，不进本轮历史", async () => {
    const { executeWithChat } = await import('../../src/tools/chat-orchestrator.js');
    const requests: any[] = [];
    let reminderCalls = 0;
    const client = {
      baseURL: "http://test.invalid",
      create: async (request: any) => {
        requests.push(structuredClone(request));
        return requests.length === 1
          ? {
              choices: [{
                message: {
                  role: "assistant",
                  tool_calls: [{ id: "call_todo", type: "function", function: { name: "todo", arguments: "{}" } }],
                },
              }],
            }
          : { choices: [{ message: { role: "assistant", content: "done" } }] };
      },
    };

    const result = await executeWithChat({
      query: "开始",
      client,
      model: "test-model",
      executeTool: async () => "ok",
      getContextReminders: () => {
        reminderCalls += 1;
        return ["<todo_reminder>未完成 1 项</todo_reminder>"];
      },
    });

    expect(reminderCalls).toBe(1);
    expect(requests[0].messages.at(-1)).toEqual({ role: "user", content: "开始" });
    expect(requests[1].messages.at(-1)).toEqual({ role: "user", content: "<todo_reminder>未完成 1 项</todo_reminder>" });
    expect(result.messages.some((message) => String(message.content ?? "").includes("<todo_reminder>"))).toBe(false);
  });
});

describe("累计型上游的 usage 归一化", () => {
  /** 造一个只给「会话累计」token 的假流式上游（llm-deepseek-web 口径：x_usage_source 标注）。 */
  function accumulatedClient(values: number[], texts: string[]) {
    let call = 0;
    return {
      baseURL: "http://test.invalid",
      create: async () => {
        const index = call++;
        const value = values[index] ?? 0;
        const text = texts[index] ?? "完成";

        async function* frames() {
          yield { model: "deepseek-web-chat", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
          yield { model: "deepseek-web-chat", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
          yield {
            model: "deepseek-web-chat",
            choices: [],
            usage: { prompt_tokens: 0, completion_tokens: value, total_tokens: value },
            x_usage_source: { prompt_tokens: "unavailable", completion_tokens: "upstream" },
          };
        }
        return frames();
      },
    };
  }

  /** 跑一轮请求，回传当轮 usage 事件。 */
  async function runOnce(client: any, sessionId: string): Promise<any> {
    const { executeWithChat } = await import("../../src/tools/chat-orchestrator.js");
    let usage: any;
    await executeWithChat({
      query: "hi",
      client,
      model: "deepseek-web-chat",
      stream: true,
      sessionId,
      onEvent: event => {
        if (event.type === "usage") usage = event.usage;
      },
    });
    return usage;
  }

  test("按会话差分出本请求新增，输入量未知时不上报", async () => {
    const sessionId = `accum-${Math.random()}`;
    const client = accumulatedClient([1000, 1060], ["第一轮", "第二轮"]);

    const first = await runOnce(client, sessionId);
    const second = await runOnce(client, sessionId);

    // 首轮没有基线：退回累计值本身；次轮差分出新增 60，不再把累计值当单轮用量
    expect(first.completionTokens).toBe(1000);
    expect(second.completionTokens).toBe(60);
    expect(second.totalTokens).toBe(60);
    // 上游不区分输入/输出：生成量按正文估算（"第二轮" 3 个汉字 → 4）
    expect(second.outputTokens).toBe(4);
    expect(second.latestPromptTokens).toBe(0);
  });

  test("普通上游保持原值，不做差分", async () => {
    const { executeWithChat } = await import("../../src/tools/chat-orchestrator.js");
    const sessionId = `plain-${Math.random()}`;
    const usages: any[] = [];
    const client = {
      baseURL: "http://test.invalid",
      create: async () => {
        async function* frames() {
          yield { model: "m", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] };
          yield { model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
          yield { model: "m", choices: [], usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 } };
        }
        return frames();
      },
    };

    for (let index = 0; index < 2; index++) {
      await executeWithChat({
        query: "hi",
        client,
        model: "m",
        stream: true,
        sessionId,
        onEvent: event => {
          if (event.type === "usage") usages.push(event.usage);
        },
      });
    }

    expect(usages.map(item => item.completionTokens)).toEqual([7, 7]);
    expect(usages[0].outputTokens).toBeUndefined();
  });
});
