/**
 * 对话主链路的网络重试：5xx 退避重试、已输出不重放、按 provider 熔断。
 *
 * 独立文件：不依赖 mock.module，退避由 ZBOT_RETRY_BASE_DELAY_MS 压到毫秒级。
 */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createChatClient } from "../../src/tools/chat-orchestrator.js";
import { closeResponsesSession } from "../../src/tools/orchestrator/responses-session.js";
import { resetNetworkCircuit } from "../../src/services/network-retry.js";

const previousStateDir = process.env.ZBOT_STATE_DIR;
const previousBaseDelay = process.env.ZBOT_RETRY_BASE_DELAY_MS;
let stateDir = "";

beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "zbot-net-retry-"));
    process.env.ZBOT_STATE_DIR = stateDir;
    process.env.ZBOT_RETRY_BASE_DELAY_MS = "1";
    resetNetworkCircuit();
});

afterEach(async () => {
    resetNetworkCircuit();
    if (previousStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = previousStateDir;
    if (previousBaseDelay === undefined) delete process.env.ZBOT_RETRY_BASE_DELAY_MS;
    else process.env.ZBOT_RETRY_BASE_DELAY_MS = previousBaseDelay;
    await rm(stateDir, { recursive: true, force: true });
});

afterAll(() => {
    resetNetworkCircuit();
});

/** 记一次请求并决定回什么；返回 true 表示继续走默认成功响应。 */
function serveWith(handler: (count: number) => Response | undefined) {
    const requests: string[] = [];
    const server = Bun.serve({
        port: 0,
        async fetch(request) {
            requests.push(request.method);
            const body = await request.json() as { stream?: boolean };
            const override = handler(requests.length);
            if (override) return override;
            if (!body.stream) return Response.json({ id: `resp_${requests.length}`, status: "completed", output: [] });
            const payload = JSON.stringify({
                type: "response.completed",
                response: { id: `resp_${requests.length}`, status: "completed", output: [] },
            });
            return new Response(`data: ${payload}\n\n`, { headers: { "content-type": "text/event-stream" } });
        },
    });
    return { requests, server, baseURL: `http://127.0.0.1:${server.port}/v1` };
}

test("非流式请求遇到 5xx 会退避重试并最终成功", async () => {
    const { requests, server, baseURL } = serveWith(count =>
        count === 1 ? Response.json({ error: { message: "upstream down" } }, { status: 503 }) : undefined);
    const client = createChatClient("key", baseURL, "responses", undefined, undefined, { store: false });
    try {
        const response = await client.createResponse!({ model: "test", input: [], stream: false });
        expect(response.id).toBe("resp_2");
        expect(requests).toHaveLength(2);
    } finally {
        client.close?.();
        server.stop(true);
    }
});

test("流式请求在建流阶段失败时重试，成功拿到完整响应", async () => {
    const { requests, server, baseURL } = serveWith(count =>
        count === 1 ? Response.json({ error: { message: "bad gateway" } }, { status: 502 }) : undefined);
    const client = createChatClient("key", baseURL, "responses", undefined, undefined, { store: false });
    try {
        const stream = await client.createResponse!({ model: "test", input: [], stream: true });
        const events: any[] = [];
        for await (const event of stream) events.push(event);
        expect(events.at(-1)?.type).toBe("response.completed");
        expect(requests).toHaveLength(2);
    } finally {
        client.close?.();
        server.stop(true);
    }
});

test("已经输出内容后连接中断不重试，避免重复输出", async () => {
    const encoder = new TextEncoder();
    let calls = 0;
    const server = Bun.serve({
        port: 0,
        fetch() {
            calls += 1;
            return new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(
                        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`,
                    ));
                    setTimeout(() => controller.error(new Error("socket hang up")), 5);
                },
            }), { headers: { "content-type": "text/event-stream" } });
        },
    });
    const client = createChatClient("key", `http://127.0.0.1:${server.port}/v1`, "responses", undefined, undefined, { store: false });
    try {
        const stream = await client.createResponse!({ model: "test", input: [], stream: true });
        const events: any[] = [];
        // 断流可能以抛错收尾，也可能被 SSE 解析当成正常结束：两种都不许重放
        try {
            for await (const event of stream) events.push(event);
        } catch {
            // 忽略：核心断言是不重试
        }
        expect(events.map(event => event.type)).toEqual(["response.output_text.delta"]);
        expect(calls).toBe(1);
    } finally {
        client.close?.();
        server.stop(true);
    }
});

test("同一 provider 连续失败达到阈值后熔断，不再打上游", async () => {
    const { requests, server, baseURL } = serveWith(() =>
        Response.json({ error: { message: "upstream down" } }, { status: 503 }));
    const failing = createChatClient("key", baseURL, "responses", undefined, undefined, { store: false });
    try {
        // 每条链 1 次首发 + 3 次重试 = 4 次请求；5 条链之后熔断打开
        for (let chain = 0; chain < 5; chain += 1) {
            await expect(failing.createResponse!({ model: "test", input: [], stream: false })).rejects.toThrow();
        }
        const callsBeforeBreak = requests.length;
        expect(callsBeforeBreak).toBe(20);

        await expect(failing.createResponse!({ model: "test", input: [], stream: false }))
            .rejects.toThrow(/熔断/);
        expect(requests).toHaveLength(callsBeforeBreak);
    } finally {
        failing.close?.();
        server.stop(true);
    }
});
