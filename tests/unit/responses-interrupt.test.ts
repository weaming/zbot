import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createChatClient } from "../../src/tools/chat-orchestrator.js";
import { closeResponsesSession } from "../../src/tools/orchestrator/responses-session.js";

const previousStateDir = process.env.ZBOT_STATE_DIR;

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
  else process.env.ZBOT_STATE_DIR = previousStateDir;
});

test("上游拒绝中断时按取消结束，不把整轮报成请求失败", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "zbot-responses-interrupt-"));
  process.env.ZBOT_STATE_DIR = stateDir;
  const sessionId = crypto.randomUUID();
  let interruptRequests = 0;
  let isSocketClosed = false;
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("upgrade required", { status: 400 });
    },
    websocket: {
      close() { isSocketClosed = true; },
      message(socket, raw) {
        const body = JSON.parse(raw.toString());
        if (body.generate === false) {
          socket.send(JSON.stringify({ type: "response.completed", response: { id: "warmup", output: [] } }));
          return;
        }
        if (body.type === "response.interrupt") {
          interruptRequests++;
          // 复刻带托管工具时的上游回应
          socket.send(JSON.stringify({
            type: "response.interrupt.failed",
            response_id: body.response_id,
            error: {
              type: "invalid_request_error",
              code: "interrupt_not_supported",
              message: "response.interrupt does not yet support hosted tools.",
              param: "response_id",
            },
          }));
          return;
        }
        socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } }));
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "partial" }));
      },
    },
  });
  const client = createChatClient("key", `http://127.0.0.1:${server.port}/v1`, "responses", sessionId, undefined, { websocket: true, store: false });
  const controller = new AbortController();
  try {
    const stream = await client.createResponse!(
      { model: "test", store: false, input: [{ role: "user", content: "hi" }], stream: true },
      { signal: controller.signal },
    );
    const events: any[] = [];
    let failure: any;
    try {
      for await (const event of stream) {
        events.push(event);
        if (event.type === "response.output_text.delta") controller.abort();
      }
    } catch (error: any) {
      failure = error;
    }
    expect(events.map(event => event.type)).toEqual(["response.created", "response.output_text.delta"]);
    expect(failure?.name).toBe("AbortError");
    expect(failure?.message).not.toContain("中断失败");
    expect(interruptRequests).toBe(1);
    // 抛 AbortError 后由 finally 关闭连接，close 事件是异步的
    for (let i = 0; i < 100 && !isSocketClosed; i++) await Bun.sleep(10);
    expect(isSocketClosed).toBe(true);
  } finally {
    client.close?.();
    closeResponsesSession(sessionId);
    server.stop(true);
    await rm(stateDir, { recursive: true, force: true });
  }
});
