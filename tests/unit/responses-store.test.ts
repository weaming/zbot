import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createChatClient } from "../../src/tools/chat-orchestrator.js";
import { closeResponsesSession } from "../../src/tools/orchestrator/responses-session.js";
import { deleteResponsesBaseline } from "../../src/tools/orchestrator/responses-baseline.js";
import { getResponsesBaselineFile } from "../../src/utils/state-paths.js";
import { prepareRequest } from "../../src/tools/orchestrator/turn-request.js";

const previousStateDir = process.env.ZBOT_STATE_DIR;

async function readSessionLog(sessionId: string): Promise<any[]> {
  const file = path.join(process.env.ZBOT_STATE_DIR!, "sessions", "http", `${sessionId}.jsonl`);
  return (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
  else process.env.ZBOT_STATE_DIR = previousStateDir;
});

test("GPT Responses 默认走 HTTP 且不请求上游存储", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "zbot-responses-default-"));
  process.env.ZBOT_STATE_DIR = stateDir;
  const sessionId = crypto.randomUUID();
  const requests: Array<{ transport: string; body: any }> = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return (async () => {
        const body = await request.json() as any;
        requests.push({ transport: "http", body });
        const response = { id: "resp_default", status: "completed", output: [] };
        if (!body.stream) return Response.json(response);
        return new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      })();
    },
    websocket: {
      message(socket, raw) {
        const body = JSON.parse(raw.toString());
        requests.push({ transport: "ws", body });
        const id = body.generate === false ? "warmup" : "resp_default";
        socket.send(JSON.stringify({ type: "response.completed", response: { id, output: [] } }));
      },
    },
  });
  const client = createChatClient("key", `http://127.0.0.1:${server.port}/v1`, "responses", sessionId, "gpt-5", { store: false });
  try {
    const prepared = await prepareRequest({
      client,
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      normalizedTools: tools => tools,
      isFirstIteration: true,
      stream: true,
    });
    expect(prepared.requestBody.store).toBe(false);
    expect(prepared.requestBody.include).toBeUndefined();
    const events = await client.createResponse!(prepared.requestBody);
    for await (const _event of events) { /* 消费完整响应。 */ }
    // 未配置 websocket 时不再按模型名启发式开 WS：只有一次 HTTP 请求
    expect(requests).toHaveLength(1);
    expect(requests[0]!.transport).toBe("http");
    expect(requests[0]!.body.store).toBe(false);
    expect(requests[0]!.body.previous_response_id).toBeUndefined();
    const log = await readSessionLog(sessionId);
    expect(log[0]!.type).toBe("HTTP_REQUEST");
    expect(log.every(entry => !String(entry.type).startsWith("WS_"))).toBe(true);
    // 请求除请求链字段外与真实发送内容一致
    expect(log[0]!.content).toMatchObject(requests[0]!.body);
    expect(log[0]!.content.requestId).toBeString();
    expect(log.at(-1)!.content.type).toBe("response.completed");
    expect(log.at(-1)!.content.response.id).toBe("resp_default");
  } finally {
    client.close?.();
    closeResponsesSession(sessionId);
    await deleteResponsesBaseline(sessionId);
    server.stop(true);
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("store=true 跨连接及 HTTP/WS 切换续接，失效时重发完整输入", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "zbot-responses-"));
  process.env.ZBOT_STATE_DIR = stateDir;
  const sessionId = crypto.randomUUID();
  const requests: Array<{ transport: string; body: any }> = [];
  const input = { role: "user", content: "hello" };
  const output = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] };
  const next = { role: "user", content: "next" };
  const third = { role: "user", content: "third" };
  const fourth = { role: "user", content: "fourth" };
  let rejectPrevious = true;
  let rejectWsPrevious = false;
  let resultIndex = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request, server) {
      if (request.method === "GET" && server.upgrade(request)) return;
      const body = await request.json() as any;
      requests.push({ transport: "http", body });
      if (body.previous_response_id && rejectPrevious) {
        rejectPrevious = false;
        return Response.json({ error: { type: "invalid_request_error", code: "previous_response_not_found", message: "missing" } }, { status: 400 });
      }
      resultIndex++;
      const response = { id: `resp_${resultIndex}`, status: "completed", output: [output] };
      if (!body.stream) return Response.json(response);
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
    websocket: {
      message(socket, raw) {
        const body = JSON.parse(raw.toString());
        requests.push({ transport: "ws", body });
        if (body.previous_response_id && rejectWsPrevious) {
          rejectWsPrevious = false;
          socket.send(JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", code: "previous_response_not_found", message: "missing", param: "previous_response_id" } }));
          return;
        }
        const response = body.generate === false
          ? { id: "warmup", status: "completed", output: [] }
          : { id: `resp_${++resultIndex}`, status: "completed", output: [output] };
        socket.send(JSON.stringify({ type: "response.completed", response }));
      },
    },
  });
  const baseURL = `http://127.0.0.1:${server.port}/v1`;
  try {
    const first = createChatClient("key", baseURL, "responses", sessionId, undefined, { websocket: true, store: true });
    await first.createResponse!({ model: "test", store: true, input: [input], stream: false });
    first.close?.();
    closeResponsesSession(sessionId);

    
    const second = createChatClient("key", baseURL, "responses", sessionId, undefined, { websocket: false, store: true });
    await second.createResponse!({ model: "test", store: true, input: [input, output, next], stream: false });
    second.close?.();
    closeResponsesSession(sessionId);

    const httpRequests = requests.filter(request => request.transport === "http");
    expect(httpRequests).toHaveLength(2);
    expect(httpRequests[0]!.body.previous_response_id).toBe("resp_1");
    expect(httpRequests[0]!.body.input).toEqual([next]);
    expect(httpRequests[1]!.body.previous_response_id).toBeUndefined();
    expect(httpRequests[1]!.body.input).toEqual([input, output, next]);
    const httpLog = await readSessionLog(sessionId);
    const loggedRequests = httpLog.filter(entry => entry.type === "HTTP_REQUEST");
    expect(loggedRequests.map(entry => entry.content.previous_response_id)).toEqual(["resp_1", undefined]);
    expect(loggedRequests[0].content.input).toEqual([next]);
    expect(loggedRequests[1].content.input).toEqual([input, output, next]);
    expect(httpLog.some(entry => entry.type === "HTTP_ERROR" && entry.content.status === 400)).toBe(true);
    expect(httpLog.some(entry => entry.type === "HTTP_RESPONSE" && entry.content.id === "resp_2")).toBe(true);
    expect(httpLog.find(entry => entry.type === "HTTP_RESPONSE").content.requestId).toBeUndefined();

    const last = createChatClient("key", baseURL, "responses", sessionId, undefined, { websocket: true, store: true });
    await last.createResponse!({ model: "test", store: true, input: [input, output, next, output, third], stream: false });
    last.close?.();
    closeResponsesSession(sessionId);
    const lastRequest = requests.at(-1)!.body;
    expect(lastRequest.previous_response_id).toBe("resp_2");
    expect(lastRequest.input).toEqual([third]);
    expect(lastRequest.generate).toBeUndefined();

    rejectWsPrevious = true;
    const resumed = createChatClient("key", baseURL, "responses", sessionId, undefined, { websocket: true, store: true });
    const fullInput = [input, output, next, output, third, output, fourth];
    await resumed.createResponse!({ model: "test", store: true, input: fullInput, stream: false });
    resumed.close?.();
    closeResponsesSession(sessionId);
    const [incremental, replay] = requests.slice(-2).map(request => request.body);
    expect(incremental.previous_response_id).toBe("resp_3");
    expect(incremental.input).toEqual([fourth]);
    expect(replay.previous_response_id).toBeUndefined();
    expect(replay.input).toEqual(fullInput);

    const otherAccount = createChatClient("other-key", baseURL, "responses", sessionId, undefined, { websocket: true, store: true });
    await otherAccount.createResponse!({ model: "test", store: true, input: fullInput, stream: false });
    otherAccount.close?.();
    closeResponsesSession(sessionId);
    expect(requests.at(-2)!.body.generate).toBe(false);
    expect(requests.at(-1)!.body.previous_response_id).toBe("warmup");

    
    const unstored = createChatClient("key", baseURL, "responses", sessionId, undefined, { websocket: false, store: false });
    await unstored.createResponse!({ model: "test", store: false, input: fullInput, stream: false });
    unstored.close?.();
    closeResponsesSession(sessionId);
    expect(requests.at(-1)!.body.previous_response_id).toBeUndefined();
    await expect(stat(getResponsesBaselineFile(sessionId))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    closeResponsesSession(sessionId);
    await deleteResponsesBaseline(sessionId);
    server.stop(true);
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("HTTP SSE 保存输出项并在旧响应不存在时回退", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "zbot-responses-sse-"));
  process.env.ZBOT_STATE_DIR = stateDir;
  
  const sessionId = crypto.randomUUID();
  const input = { role: "user", content: "hello" };
  const output = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] };
  const next = { role: "user", content: "next" };
  const requests: any[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json() as any;
      requests.push(body);
      const events = body.previous_response_id
        ? [
          { type: "codex.rate_limits", rate_limits: {} },
          { type: "error", error: { code: "previous_response_not_found", message: "missing", type: "invalid_request_error" } },
        ]
        : [
          { type: "response.output_item.done", output_index: 0, item: output },
          { type: "response.completed", response: { id: `resp_${requests.length}`, status: "completed", output: [] } },
        ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const baseURL = `http://127.0.0.1:${server.port}/v1`;
  try {
    const first = createChatClient("key", baseURL, "responses", sessionId, undefined, { websocket: false, store: true });
    const firstStream = await first.createResponse!({ model: "test", store: true, input: [input], stream: true });
    for await (const _event of firstStream) { /* 消费流以完成基准保存。 */ }
    first.close?.();
    closeResponsesSession(sessionId);

    const second = createChatClient("key", baseURL, "responses", sessionId, undefined, { websocket: false, store: true });
    const secondStream = await second.createResponse!({ model: "test", store: true, input: [input, output, next], stream: true });
    const events: any[] = [];
    for await (const event of secondStream) events.push(event);
    second.close?.();
    expect(requests).toHaveLength(3);
    expect(requests[1].previous_response_id).toBe("resp_1");
    expect(requests[1].input).toEqual([next]);
    expect(requests[2].previous_response_id).toBeUndefined();
    expect(requests[2].input).toEqual([input, output, next]);
    expect(events.at(-1).type).toBe("response.completed");
    const log = await readSessionLog(sessionId);
    const loggedRequests = log.filter(entry => entry.type === "HTTP_REQUEST");
    expect(loggedRequests.map(entry => entry.content.previous_response_id)).toEqual([undefined, "resp_1", undefined]);
    expect(loggedRequests[1].content.input).toEqual([next]);
    expect(log.some(entry => entry.type === "HTTP_SSE_EVENT" && entry.content.type === "codex.rate_limits")).toBe(true);
    expect(log.some(entry => entry.type === "HTTP_ERROR" && JSON.stringify(entry.content).includes("previous_response_not_found"))).toBe(true);
    expect(log.at(-1).content.type).toBe("response.completed");
  } finally {
    closeResponsesSession(sessionId);
    await deleteResponsesBaseline(sessionId);
    server.stop(true);
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("WebSocket 达到连接时限后重连并使用已存储响应续接", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "zbot-responses-reconnect-"));
  process.env.ZBOT_STATE_DIR = stateDir;
  const sessionId = crypto.randomUUID();
  const input = { role: "user", content: "hello" };
  const output = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hi", annotations: [] }] };
  const next = { role: "user", content: "next" };
  const requests: any[] = [];
  let connections = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("upgrade required", { status: 400 });
    },
    websocket: {
      open() { connections++; },
      message(socket, raw) {
        const body = JSON.parse(raw.toString());
        if (body.generate === false) {
          socket.send(JSON.stringify({ type: "response.completed", response: { id: "warmup", output: [] } }));
          return;
        }
        requests.push(body);
        if (requests.length === 2) {
          socket.send(JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", code: "websocket_connection_limit_reached", message: "expired" } }));
          return;
        }
        socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${requests.length}`, output: [output] } }));
      },
    },
  });
  const client = createChatClient("key", `http://127.0.0.1:${server.port}/v1`, "responses", sessionId, undefined, { websocket: true });
  try {
    await client.createResponse!({ model: "test", store: true, input: [input], stream: false });
    await client.createResponse!({ model: "test", store: true, input: [input, output, next], stream: false });
    expect(connections).toBe(2);
    expect(requests).toHaveLength(3);
    expect(requests[1].previous_response_id).toBe("resp_1");
    expect(requests[2].previous_response_id).toBe("resp_1");
    expect(requests[2].input).toEqual([next]);
  } finally {
    client.close?.();
    closeResponsesSession(sessionId);
    await deleteResponsesBaseline(sessionId);
    server.stop(true);
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("WebSocket 已输出内容时连接错误不会自动重放请求", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "zbot-responses-partial-"));
  process.env.ZBOT_STATE_DIR = stateDir;
  const sessionId = crypto.randomUUID();
  let generations = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("upgrade required", { status: 400 });
    },
    websocket: {
      message(socket, raw) {
        const body = JSON.parse(raw.toString());
        if (body.generate === false) {
          socket.send(JSON.stringify({ type: "response.completed", response: { id: "warmup", output: [] } }));
          return;
        }
        generations++;
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "partial" }));
        socket.send(JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", code: "websocket_connection_limit_reached", message: "expired" } }));
      },
    },
  });
  const client = createChatClient("key", `http://127.0.0.1:${server.port}/v1`, "responses", sessionId, undefined, { websocket: true });
  try {
    const stream = await client.createResponse!({ model: "test", store: true, input: [{ role: "user", content: "hi" }], stream: true });
    const events: any[] = [];
    let failure: unknown;
    try {
      for await (const event of stream) events.push(event);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(events.map(event => event.type)).toEqual(["response.output_text.delta"]);
    expect(generations).toBe(1);
  } finally {
    client.close?.();
    closeResponsesSession(sessionId);
    await deleteResponsesBaseline(sessionId);
    server.stop(true);
    await rm(stateDir, { recursive: true, force: true });
  }
});
