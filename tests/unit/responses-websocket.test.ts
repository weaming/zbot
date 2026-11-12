import { describe, expect, test } from "bun:test";
import OpenAI from "openai";
import { createChatClient } from "../../src/tools/chat-orchestrator.js";
import { ResponsesSession } from "../../src/tools/orchestrator/responses-session.js";

describe("Responses WebSocket", () => {

  test("转发请求并接收流式与非流式响应", async () => {
    const requests: any[] = [];
    let connections = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (new URL(request.url).pathname !== "/v1/responses") return new Response("missing", { status: 404 });
        if (request.headers.get("authorization") !== "Bearer test-key") return new Response("unauthorized", { status: 401 });
        if (server.upgrade(request)) return;
        return new Response("upgrade required", { status: 400 });
      },
      websocket: {
        open() { connections += 1; },
        message(socket, message) {
          const request = JSON.parse(message.toString());
          if (request.generate === false) {
            socket.send(JSON.stringify({ type: "response.completed", response: { id: "warmup", output: [] } }));
            return;
          }
          requests.push(request);
          socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "OK" }));
          socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_test", output: [] } }));
        },
      },
    });
    try {
      const client = createChatClient("test-key", `http://127.0.0.1:${server.port}/v1`, "responses", undefined, undefined, { websocket: true });
      const stream = await client.createResponse!({ model: "test", input: [], stream: true });
      const events = [];
      for await (const event of stream) events.push(event);
      expect(events.map(event => event.type)).toEqual(["response.output_text.delta", "response.completed"]);
      const response = await client.createResponse!({ model: "test", input: [], stream: false });
      expect(response.id).toBe("resp_test");
      expect(requests).toHaveLength(2);
      expect(requests.every(request => request.type === "response.create" && !("stream" in request))).toBe(true);
      expect(connections).toBe(1);
      expect(requests[1].previous_response_id).toBe("resp_test");
      client.close?.();
    } finally {
      server.stop(true);
    }
  });

  test("复用连接，仅在前缀匹配时增量发送，并在响应不存在时恢复完整请求", async () => {
    const requests: any[] = [];
    const firstInput = { role: "user", content: "查一下" };
    const output = { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}" };
    const toolResult = { type: "function_call_output", call_id: "call_1", output: "ok" };
    let connections = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response("upgrade required", { status: 400 });
      },
      websocket: {
        open() { connections += 1; },
        message(socket, message) {
          const request = JSON.parse(message.toString());
          if (request.generate === false) {
            socket.send(JSON.stringify({ type: "response.completed", response: { id: "warmup", output: [] } }));
            return;
          }
          requests.push(request);
          if (requests.length === 2) {
            socket.send(JSON.stringify({ type: "error", code: "previous_response_not_found", message: "missing", param: null, sequence_number: 0 }));
            return;
          }
          const items = requests.length === 1 ? [output] : [];
          socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${requests.length}`, output: items } }));
        },
      },
    });
    const client = createChatClient("test-key", `http://127.0.0.1:${server.port}/v1`, "responses", undefined, undefined, { websocket: true });
    try {
      await client.createResponse!({ model: "test", input: [firstInput], stream: false });
      await client.createResponse!({ model: "test", input: [firstInput, output, toolResult], stream: false });
      await client.createResponse!({ model: "other", input: [firstInput], stream: false });
      await client.createResponse!({ model: "other", input: [{ role: "user", content: "不同的历史" }], stream: false });
      expect(connections).toBe(1);
      expect(requests[1].previous_response_id).toBe("resp_1");
      expect(requests[1].input).toEqual([toolResult]);
      expect(requests[2].previous_response_id).toBeUndefined();
      expect(requests[2].input).toEqual([firstInput, output, toolResult]);
      expect(requests[3].previous_response_id).toBeUndefined();
      expect(requests[3].input).toEqual([firstInput]);
      expect(requests[4].previous_response_id).toBeUndefined();
      expect(requests[4].input).toEqual([{ role: "user", content: "不同的历史" }]);
    } finally {
      client.close?.();
      server.stop(true);
    }
  });

  test("升级失败时回退 HTTP Responses", async () => {
    const methods: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        methods.push(request.method);
        if (request.method === "GET") return new Response("unsupported", { status: 426 });
        const body = await request.json() as { stream?: boolean };
        if (!body.stream) return Response.json({ id: "resp_http", output: [] });
        return new Response('data: {"type":"response.completed","response":{"id":"resp_http","output":[]}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const client = createChatClient("test-key", `http://127.0.0.1:${server.port}/v1`, "responses", undefined, undefined, { websocket: true });
    try {
      const response = await client.createResponse!({ model: "test", input: [], stream: false });
      expect(response.id).toBe("resp_http");
      const next = await client.createResponse!({ model: "test", input: [], stream: false });
      expect(next.id).toBe("resp_http");
      expect(methods).toEqual(["GET", "POST", "POST"]);
    } finally {
      client.close?.();
      server.stop(true);
    }
  });

  test("同一会话跨回合复用连接，认证变化时重新连接", async () => {
    const requests: any[] = [];
    let connections = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response("upgrade required", { status: 400 });
      },
      websocket: {
        open() { connections += 1; },
        message(socket, message) {
          const request = JSON.parse(message.toString());
          if (request.generate === false) {
            socket.send(JSON.stringify({ type: "response.completed", response: { id: "warmup", output: [] } }));
            return;
          }
          requests.push(request);
          socket.send(JSON.stringify({ type: "response.completed", response: { id: `resp_${requests.length}`, output: [] } }));
        },
      },
    });
    const sessionId = crypto.randomUUID();
    const url = `http://127.0.0.1:${server.port}/v1`;
    try {
      const first = createChatClient("key-1", url, "responses", sessionId, undefined, { websocket: true });
      await first.createResponse!({ model: "test", input: [], stream: false });
      first.close?.();
      const second = createChatClient("key-1", url, "responses", sessionId, undefined, { websocket: true });
      await second.createResponse!({ model: "test", input: [{ role: "user", content: "next" }], stream: false });
      second.close?.();
      const third = createChatClient("key-2", url, "responses", sessionId, undefined, { websocket: true });
      await third.createResponse!({ model: "test", input: [], stream: false });
      third.close?.();
      expect(connections).toBe(2);
      expect(requests[1].previous_response_id).toBe("resp_1");
      expect(requests[1].input).toEqual([{ role: "user", content: "next" }]);
      expect(requests[2].previous_response_id).toBe("warmup");
    } finally {
      server.stop(true);
    }
  });

  test("取消等待中的请求会返回 AbortError", async () => {
    const controller = new AbortController();
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response("upgrade required", { status: 400 });
      },
      websocket: { message() { controller.abort(); } },
    });
    const client = createChatClient("test-key", `http://127.0.0.1:${server.port}/v1`, "responses", undefined, undefined, { websocket: true });
    try {
      await expect(client.createResponse!({ model: "test", input: [], stream: false }, { signal: controller.signal }))
        .rejects.toMatchObject({ name: "AbortError" });
    } finally {
      client.close?.();
      server.stop(true);
    }
  });

  test("同一响应的多个 steer 逐个确认，且每条只记录一次接受事件", async () => {
    const sent: any[] = [];
    const updates: string[] = [];
    let acceptFirst: (() => void) | undefined;
    let commitFirst: (() => void) | undefined;
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response("upgrade required", { status: 400 });
      },
      websocket: {
        message(socket, data) {
          const request = JSON.parse(data.toString());
          if (request.generate === false) {
            socket.send(JSON.stringify({ type: "response.completed", response: { id: "warmup", output: [] } }));
            return;
          }
          if (request.type === "response.create") {
            socket.send(JSON.stringify({ type: "response.created", response: { id: "parent" } }));
            return;
          }
          sent.push(request);
          if (sent.length === 1) {
            acceptFirst = () => {
              socket.send(JSON.stringify({ type: "response.steer.accepted", steer: { previous_response_id: "parent" } }));
            };
            commitFirst = () => {
              socket.send(JSON.stringify({ type: "response.completed", response: {
                id: "parent", output: [{ type: "message", content: [{ type: "output_text", text: "前段完整回复" }] }],
              } }));
              socket.send(JSON.stringify({ type: "response.created", response: { id: "continuation" } }));
            };
          } else {
            socket.send(JSON.stringify({ type: "response.steer.accepted", steer: { previous_response_id: "continuation" } }));
            socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "切换前的片段" }));
            socket.send(JSON.stringify({
              type: "response.incomplete",
              response: { id: "continuation", incomplete_details: { reason: "steered" }, output: [] },
            }));
            socket.send(JSON.stringify({ type: "response.created", response: { id: "final" } }));
            socket.send(JSON.stringify({ type: "response.completed", response: { id: "final", output: [] } }));
          }
        },
      },
    });
    const client = new OpenAI({ apiKey: "test-key", baseURL: `http://127.0.0.1:${server.port}/v1` });
    const session = new ResponsesSession(client, true);
    const accepted: string[] = [];
    const events: string[] = [];
    try {
      const reading = (async () => {
        for await (const event of session.stream(
          { model: "test", input: [], store: false }, undefined,
          async text => { accepted.push(text); updates.push(`applied:${text}`); },
          async update => { updates.push(`${update.phase}:${update.responseId}:${update.text ?? ""}`); },
        )) events.push(event.type);
      })();
      for (let attempt = 0; attempt < 100 && !(session as any).activeResponseId; attempt++) await Bun.sleep(5);
      expect((session as any).activeResponseId).toBe("parent");

      const first = session.steer("第一条");
      const second = session.steer("第二条");
      for (let attempt = 0; attempt < 100 && !acceptFirst; attempt++) await Bun.sleep(5);
      expect(sent.map(item => item.input)).toEqual(["第一条"]);
      acceptFirst?.();
      for (let attempt = 0; attempt < 100 && !events.includes("response.steer.accepted"); attempt++) await Bun.sleep(5);
      expect(accepted).toEqual([]);
      expect(sent).toHaveLength(1);
      commitFirst?.();
      expect(await first).toBe(true);
      expect(await second).toBe(true);
      await reading;
      expect(sent.map(item => [item.previous_response_id, item.input])).toEqual([
        ["parent", "第一条"],
        ["continuation", "第二条"],
      ]);
      expect(accepted).toEqual(["第一条", "第二条"]);
      expect(updates).toEqual([
        "accepted:parent:",
        "completed:parent:前段完整回复",
        "applied:第一条",
        "accepted:continuation:",
        "steered:continuation:切换前的片段",
        "applied:第二条",
      ]);
      expect(events.filter(type => type === "response.steer.accepted")).toHaveLength(2);
    } finally {
      session.close();
      server.stop(true);
    }
  });

  test("steer 已接受但后续提交失败时不消费用户消息", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response("upgrade required", { status: 400 });
      },
      websocket: {
        message(socket, data) {
          const request = JSON.parse(data.toString());
          if (request.generate === false) {
            socket.send(JSON.stringify({ type: "response.completed", response: { id: "warmup", output: [] } }));
          } else if (request.type === "response.create") {
            socket.send(JSON.stringify({ type: "response.created", response: { id: "parent" } }));
          } else {
            socket.send(JSON.stringify({ type: "response.steer.accepted", steer: { id: "steer_1", previous_response_id: "parent" } }));
            socket.send(JSON.stringify({ type: "response.steer.failed", steer: { id: "steer_1", previous_response_id: "parent" } }));
            socket.send(JSON.stringify({ type: "response.completed", response: { id: "parent", output: [] } }));
          }
        },
      },
    });
    const client = new OpenAI({ apiKey: "test-key", baseURL: `http://127.0.0.1:${server.port}/v1` });
    const session = new ResponsesSession(client, true);
    const accepted: string[] = [];
    try {
      const reading = (async () => {
        for await (const _event of session.stream({ model: "test", input: [], store: false }, undefined, async text => {
          accepted.push(text);
        })) { /* consume */ }
      })();
      for (let attempt = 0; attempt < 100 && !(session as any).activeResponseId; attempt++) await Bun.sleep(5);
      expect(await session.steer("不能丢")).toBe(false);
      await reading;
      expect(accepted).toEqual([]);
    } finally {
      session.close();
      server.stop(true);
    }
  });

  test("steer 等待工具结果时记录补充消息，并在下轮断开旧连接后完整重放", async () => {
    let connections = 0;
    const requests: any[] = [];
    const warmups: any[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response("upgrade required", { status: 400 });
      },
      websocket: {
        open() { connections++; },
        message(socket, data) {
          const request = JSON.parse(data.toString());
          if (request.generate === false) {
            warmups.push(request);
            socket.send(JSON.stringify({ type: "response.completed", response: { id: "warmup", output: [] } }));
          } else if (request.type === "response.create") {
            requests.push(request);
            if (requests.length === 2) {
              socket.send(JSON.stringify({ type: "response.completed", response: { id: "next", output: [] } }));
            } else {
              socket.send(JSON.stringify({ type: "response.created", response: { id: "parent" } }));
            }
          } else {
            socket.send(JSON.stringify({ type: "response.steer.accepted", steer: { id: "steer_1", previous_response_id: "parent" } }));
            socket.send(JSON.stringify({ type: "response.completed", response: { id: "parent", output: [] } }));
            socket.send(JSON.stringify({
              type: "response.steer.pending",
              steer: { id: "steer_1", previous_response_id: "parent" },
              reason: "waiting_for_required_input",
              required_input: [],
            }));
          }
        },
      },
    });
    const client = new OpenAI({ apiKey: "test-key", baseURL: `http://127.0.0.1:${server.port}/v1` });
    const session = new ResponsesSession(client, true);
    const accepted: string[] = [];
    const updates: Array<{ phase: string; isAwaitingToolInput?: boolean }> = [];
    try {
      const reading = (async () => {
        for await (const _event of session.stream(
          { model: "test", input: [], store: false }, undefined,
          async text => { accepted.push(text); },
          async update => { updates.push({ phase: update.phase, isAwaitingToolInput: update.isAwaitingToolInput }); },
        )) { /* consume */ }
      })();
      for (let attempt = 0; attempt < 100 && !(session as any).activeResponseId; attempt++) await Bun.sleep(5);
      expect(await session.steer("补充")).toBe(true);
      await reading;
      expect(accepted).toEqual(["补充"]);
      expect(updates).toEqual([
        { phase: "accepted", isAwaitingToolInput: undefined },
        { phase: "completed", isAwaitingToolInput: true },
      ]);
      expect((session as any).socket).toBeUndefined();

      for await (const _event of session.stream({
        model: "test", input: [{ role: "user", content: "补充" }], store: false,
      })) { /* consume */ }
      expect(connections).toBe(2);
      expect(warmups[1].input).toEqual([{ role: "user", content: "补充" }]);
      expect(requests[1].previous_response_id).toBe("warmup");
    } finally {
      session.close();
      server.stop(true);
    }
  });

  test("连接超过 50 分钟存活上限即视为过期", () => {
    const client = new OpenAI({ apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1" });
    const session = new ResponsesSession(client, true, "session-age");
    try {
      expect(session.isExpired()).toBe(false);
      expect(session.isExpired(Date.now() + 51 * 60 * 1000)).toBe(true);
    } finally {
      session.close();
    }
  });
});
