import { defaultTestConfig, useConfig } from "./test-config.js";
import { reloadConfig } from "../../src/config/index.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
    applyConsoleTimestamps,
    CONSOLE_TIMESTAMP_MARK,
    formatAIInteractionLogEntry,
    recordLLMExchange,
} from "../../src/utils/logger.js";

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-logger-"));
    process.env.ZBOT_STATE_DIR = tmpDir;
});

afterEach(() => {
    delete process.env.ZBOT_STATE_DIR;
    reloadConfig();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("console 时间戳", () => {
    function makeConsole(): { target: Console; calls: any[][] } {
        const calls: any[][] = [];
        const target = {
            log: (...args: any[]) => calls.push(args),
            info: (...args: any[]) => calls.push(args),
            warn: (...args: any[]) => calls.push(args),
            error: (...args: any[]) => calls.push(args),
        } as unknown as Console;
        return { target, calls };
    }

    test("加上本地时间戳前缀且重复调用幂等", () => {
        const { target, calls } = makeConsole();

        applyConsoleTimestamps(target);
        applyConsoleTimestamps(target);
        target.log("hello");

        expect(calls.length).toBe(1);
        expect(calls[0][0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/);
        expect(calls[0][1]).toBe("hello");
    });

    test("已被 TUI 日志重定向接管（标记存在）时跳过，避免两个时间戳", () => {
        const { target, calls } = makeConsole();
        (target as unknown as Record<symbol, unknown>)[CONSOLE_TIMESTAMP_MARK] = true;

        applyConsoleTimestamps(target);
        target.log("hello");

        expect(calls).toEqual([["hello"]]);
    });
});

describe("AI 交互日志", () => {
    test("将每次交互编码为可独立解析的 JSONL 记录", () => {
        const content = {
            messages: [{ role: "user", content: "包含\n换行的内容" }],
            enabled: true,
        };

        const entry = JSON.parse(formatAIInteractionLogEntry("REQUEST", content));

        expect(entry).toEqual({
            schemaVersion: 1,
            timestamp: expect.any(String),
            type: "REQUEST",
            content,
        });
        expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
    });

    test("保留字符串内容而不生成额外日志行", () => {
        const entry = formatAIInteractionLogEntry("ERROR", "第一行\n第二行");

        expect(entry).not.toContain("\n");
        expect(JSON.parse(entry)).toMatchObject({
            type: "ERROR",
            content: "第一行\n第二行",
        });
    });

    test("图片数据只在交换日志中保留类型和长度", () => {
        const request = {
            messages: [{
                role: "user",
                content: [
                    { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
                    { type: "image_data", image: { mimeType: "image/png", data: "aGVsbG8=" } },
                ],
            }],
        };

        const entry = JSON.parse(formatAIInteractionLogEntry("REQUEST", request));
        expect(JSON.stringify(entry)).not.toContain("aGVsbG8=");
        expect(entry.content.messages[0].content[0].image_url.url).toBe("[image/png base64_chars=8]");
        expect(entry.content.messages[0].content[1].image.data).toBe("[image/png base64_chars=8]");
        expect(request.messages[0].content[0].image_url.url).toBe("data:image/png;base64,aGVsbG8=");
    });
});

describe("LLM exchange 链式增量记录", () => {
    const toolsA = [{ type: "function", function: { name: "t1" } }];

    function readRequests(): any[] {
        const text = fs.readFileSync(path.join(tmpDir, "logs", "llm-exchange.jsonl"), "utf8");
        return text.split("\n").filter(Boolean).map(line => JSON.parse(line));
    }

    function readSessionEntries(sessionId: string): any[] {
        const text = fs.readFileSync(path.join(tmpDir, "sessions", "http", `${sessionId}.jsonl`), "utf8");
        return text.split("\n").filter(Boolean).map(line => JSON.parse(line));
    }

    test("REQUEST 只记录相对上一请求新增的 messages，tools 未变化只写 hash", () => {
        recordLLMExchange("REQUEST", {
            model: "m",
            messages: [
                { role: "system", content: "sys" },
                { role: "user", content: "q1" },
            ],
            tools: toolsA,
        }, { requestId: "r1" });

        recordLLMExchange("REQUEST", {
            model: "m",
            messages: [
                { role: "system", content: "sys" },
                { role: "user", content: "q1" },
                { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
                { role: "tool", tool_call_id: "c1", name: "t1", content: "res" },
            ],
            tools: toolsA,
        }, { requestId: "r2", parentRequestId: "r1", prevMessageCount: 2 });

        const requests = readRequests().filter(entry => entry.type === "REQUEST").map(entry => entry.content);
        expect(requests).toHaveLength(2);
        expect(requests[1].messages).toEqual([
            { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
            { role: "tool", tool_call_id: "c1", name: "t1", content: "res" },
        ]);
        expect(requests[1].parentRequestId).toBe("r1");
        expect(requests[1].toolsHash).toBeDefined();
        expect(requests[1].tools).toBeUndefined();
    });

    test("tools 变化时写入全量定义", () => {
        const toolsT2 = [{ type: "function", function: { name: "t2" } }];
        recordLLMExchange("REQUEST", { messages: [], tools: toolsT2 }, { requestId: "r1" });
        recordLLMExchange("REQUEST", { messages: [], tools: [{ type: "function", function: { name: "t2b" } }] }, { requestId: "r2", prevMessageCount: 0 });

        const r2 = readRequests()[1].content;
        expect(r2.tools).toEqual([{ type: "function", function: { name: "t2b" } }]);
    });

    test("RESPONSE 关联到对应 requestId", () => {
        recordLLMExchange("REQUEST", { messages: [], tools: toolsA }, { requestId: "r1" });
        recordLLMExchange("RESPONSE", { choices: [{ message: { role: "assistant", content: "hi" } }] }, { requestId: "r1" });

        const response = readRequests()[1];
        expect(response.type).toBe("RESPONSE");
        expect(response.content.requestId).toBe("r1");
    });

    test("RESPONSE 合并 usage 统计（原 llm-usage 行）", () => {
        recordLLMExchange("RESPONSE", { choices: [] }, {
            requestId: "r1",
            usage: {
                timestamp: "2026-08-31T00:00:00.000Z",
                caller: "zbot",
                request_kind: "user_request",
                model: "m",
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
                input_chars: 34,
                output_chars: 4,
                duration_ms: 1,
                token_usage_source: "provider",
            } as any,
        });

        const response = readRequests()[0];
        expect(response.content.usage.prompt_tokens).toBe(10);
        expect(response.content.usage.total_tokens).toBe(15);
    });

    test("有 sessionId 时按 session 分离写入 sessions/<id>.exchange.jsonl", () => {
        recordLLMExchange("REQUEST", { messages: [{ role: "user", content: "q" }], tools: toolsA }, {
            requestId: "r1",
            sessionId: "sess-1",
        });

        const sessionFile = path.join(tmpDir, "sessions", "http", "sess-1.jsonl");
        expect(fs.existsSync(sessionFile)).toBe(true);
        const entry = JSON.parse(fs.readFileSync(sessionFile, "utf8").trim());
        expect(entry.content.requestId).toBe("r1");
        // 全局文件不写入
        expect(fs.existsSync(path.join(tmpDir, "logs", "llm-exchange.jsonl"))).toBe(false);
    });

    test("同 session 跨调用自动成链并只写消息增量（调用方无需维护链状态）", () => {
        const toolsT4 = [{ type: "function", function: { name: "t4" } }];

        // 第一次 sendMessage：仅传 sessionId
        recordLLMExchange("REQUEST", {
            messages: [{ role: "system", content: "sys" }, { role: "user", content: "q1" }],
            tools: toolsT4,
        }, { sessionId: "sess-3" });

        // 第二次 sendMessage（新 executeWithChat，但同 session）：自动成链 + 增量
        recordLLMExchange("REQUEST", {
            messages: [
                { role: "system", content: "sys" },
                { role: "user", content: "q1" },
                { role: "assistant", content: "a1" },
                { role: "user", content: "q2" },
            ],
            tools: toolsT4,
        }, { sessionId: "sess-3" });

        const file = path.join(tmpDir, "sessions", "http", "sess-3.jsonl");
        const requests = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
            .map(line => JSON.parse(line).content)
            .filter(c => c.requestId);

        expect(requests).toHaveLength(2);
        expect(requests[0].messages).toHaveLength(2);      // 首次全量
        expect(requests[0].parentRequestId).toBeUndefined();
        expect(requests[1].parentRequestId).toBe(requests[0].requestId); // 自动成链
        expect(requests[1].messages).toEqual([             // 只写新增
            { role: "assistant", content: "a1" },
            { role: "user", content: "q2" },
        ]);
    });

    test("RESPONSE 自动关联最近一次 REQUEST", () => {
        recordLLMExchange("REQUEST", { messages: [{ role: "user", content: "q" }], tools: toolsA }, { sessionId: "sess-4" });
        recordLLMExchange("RESPONSE", { choices: [] }, { sessionId: "sess-4" });

        const response = JSON.parse(
            fs.readFileSync(path.join(tmpDir, "sessions", "http", "sess-4.jsonl"), "utf8").trim().split("\n")[1],
        );
        expect(response.type).toBe("RESPONSE");
        expect(response.content.requestId).toBeTypeOf("string");
    });

    test("responses 协议（input）同样只写增量，并记 historyCount/historyField", () => {
        const input = (n: number) => Array.from({ length: n }, (_, i) => ({ role: "user", content: `m${i}` }));

        recordLLMExchange("REQUEST", { model: "m", input: input(2), tools: toolsA }, { sessionId: "sess-5" });
        recordLLMExchange("REQUEST", { model: "m", input: input(5), tools: toolsA }, { sessionId: "sess-5" });

        const requests = fs.readFileSync(path.join(tmpDir, "sessions", "http", "sess-5.jsonl"), "utf8")
            .split("\n").filter(Boolean).map(line => JSON.parse(line).content);

        expect(requests[0].input).toHaveLength(2);
        expect(requests[0].historyCount).toBe(2);
        expect(requests[0].historyField).toBe("input");
        expect(requests[1].input).toHaveLength(3);           // 只写新增
        expect(requests[1].input[2].content).toBe("m4");
        expect(requests[1].historyCount).toBe(5);
        expect(requests[1].messages).toBeUndefined();        // 不污染不存在的字段
    });

    test("带 previous_response_id 的 HTTP 请求保留实际增量输入", () => {
        const sessionId = "sess-previous-response";
        const input = [{ role: "user", content: "first" }, { role: "user", content: "next" }];
        recordLLMExchange("HTTP_REQUEST", { input }, { sessionId });
        recordLLMExchange("HTTP_REQUEST", {
            previous_response_id: "resp_1",
            input: [{ role: "user", content: "latest" }],
        }, { sessionId });
        recordLLMExchange("HTTP_REQUEST", { input }, { sessionId });

        const file = path.join(tmpDir, "sessions", "http", `${sessionId}.jsonl`);
        const requests = fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line).content);
        expect(requests[1].previous_response_id).toBe("resp_1");
        expect(requests[1].input).toEqual([{ role: "user", content: "latest" }]);
        expect(requests[2].input).toEqual(input);
    });

    test("输入前缀被替换时写入完整 HTTP 请求", () => {
        const sessionId = "sess-replaced-input";
        recordLLMExchange("HTTP_REQUEST", { input: [{ role: "user", content: "old" }] }, { sessionId });
        recordLLMExchange("HTTP_REQUEST", { input: [{ role: "user", content: "new" }] }, { sessionId });

        const file = path.join(tmpDir, "sessions", "http", `${sessionId}.jsonl`);
        const requests = fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line).content);
        expect(requests[1].input).toEqual([{ role: "user", content: "new" }]);
        expect(requests[1].historyBase).toBe(0);
    });

    test("工具定义在不同会话中分别写入首份全量", () => {
        recordLLMExchange("HTTP_REQUEST", { input: [], tools: toolsA }, { sessionId: "sess-tools-a" });
        recordLLMExchange("HTTP_REQUEST", { input: [], tools: toolsA }, { sessionId: "sess-tools-b" });

        for (const sessionId of ["sess-tools-a", "sess-tools-b"]) {
            const file = path.join(tmpDir, "sessions", "http", `${sessionId}.jsonl`);
            const entry = JSON.parse(fs.readFileSync(file, "utf8").trim());
            expect(entry.content.tools).toEqual(toolsA);
        }
    });

    test("HTTP 响应与 WS 消息保留完整协议内容", () => {
        const sessionId = "sess-protocol-frames";
        const response = { id: "resp_1", tools: toolsA, instructions: "sys", output: [] };
        const wsMessage = { type: "response.create", previous_response_id: "resp_1", input: [] };
        recordLLMExchange("HTTP_RESPONSE", response, { sessionId });
        recordLLMExchange("WS_SEND", wsMessage, { sessionId });

        const file = path.join(tmpDir, "sessions", "http", `${sessionId}.jsonl`);
        const entries = fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(entries.map(entry => entry.type)).toEqual(["HTTP_RESPONSE", "WS_SEND"]);
        expect(entries[0].content).toEqual(response);
        expect(entries[1].content).toEqual(wsMessage);
    });

    test("历史条数回退（上下文压缩）时整块重写而不是漏记", () => {
        const input = (n: number) => Array.from({ length: n }, (_, i) => ({ role: "user", content: `m${i}` }));

        recordLLMExchange("REQUEST", { input: input(6) }, { sessionId: "sess-6" });
        recordLLMExchange("REQUEST", { input: input(2) }, { sessionId: "sess-6" });

        const requests = fs.readFileSync(path.join(tmpDir, "sessions", "http", "sess-6.jsonl"), "utf8")
            .split("\n").filter(Boolean).map(line => JSON.parse(line).content);
        expect(requests[1].input).toHaveLength(2);
        expect(requests[1].historyCount).toBe(2);
    });

    test("RESPONSE 丢弃回显的 tools/instructions", () => {
        recordLLMExchange("RESPONSE", { id: "resp-1", tools: toolsA, instructions: "sys", output: [] }, { requestId: "r1" });

        const response = readRequests()[0];
        expect(response.content.tools).toBeUndefined();
        expect(response.content.instructions).toBeUndefined();
        expect(response.content.id).toBe("resp-1");
        expect(response.content.output).toEqual([]);
    });

    test("响应回显的 tools 与请求一致时只记 toolsRef", () => {
        const sessionId = "sess-tools-ref";
        const toolsB = [{ type: "function", function: { name: "t2" } }];
        recordLLMExchange("HTTP_REQUEST", { input: [], tools: toolsA }, { sessionId });
        const requestId = readSessionEntries(sessionId)[0].content.requestId;

        recordLLMExchange("HTTP_SSE_EVENT", {
            type: "response.created",
            response: { id: "resp_1", tools: toolsA, instructions: null, output: [] },
        }, { sessionId });
        recordLLMExchange("WS_RECV", { type: "response.completed", response: { id: "resp_1", tools: toolsA } }, { sessionId });
        // 工具定义不同则保留全量，不做引用
        recordLLMExchange("WS_RECV", { type: "response.completed", response: { id: "resp_1", tools: toolsB } }, { sessionId });

        const [, created, completed, changed] = readSessionEntries(sessionId);
        expect(created.content.response.tools).toBeUndefined();
        expect(created.content.response.toolsRef).toBe(requestId);
        expect(created.content.response.instructions).toBeNull();
        expect(completed.content.response.toolsRef).toBe(requestId);
        expect(changed.content.response.tools).toEqual(toolsB);
        expect(changed.content.response.toolsRef).toBeUndefined();
    });

    test("重启后续链仍能引用更早请求里的 tools 全量", async () => {
        const mod = await import(`../../src/utils/logger.js?toolsref=${Date.now()}`) as typeof import("../../src/utils/logger.js");
        const sessionId = "sess-tools-ref-reload";
        const input = [{ role: "user", content: "q0" }];
        recordLLMExchange("HTTP_REQUEST", { input, tools: toolsA }, { sessionId });
        // 第二次请求工具未变化，只写 toolsHash
        recordLLMExchange("HTTP_REQUEST", { input: [...input, { role: "user", content: "q1" }], tools: toolsA }, { sessionId });
        const [first, second] = readSessionEntries(sessionId).map(entry => entry.content);
        expect(second.tools).toBeUndefined();

        mod.recordLLMExchange("WS_RECV", { type: "response.created", response: { id: "resp_1", tools: toolsA } }, { sessionId });

        const created = readSessionEntries(sessionId).at(-1)!;
        expect(created.content.response.toolsRef).toBe(first.requestId);
    });

    test("回显 tools 补 strict 默认值或键序不同时仍能引用", () => {
        const sessionId = "sess-tools-ref-echo";
        const requestTools = [{ type: "function", name: "t1", description: "d", parameters: { type: "object" } }];
        recordLLMExchange("HTTP_REQUEST", { input: [], tools: requestTools }, { sessionId });
        const requestId = readSessionEntries(sessionId)[0].content.requestId;

        // 上游回显：补 strict:null，键顺序也不同
        const echoedTools = [{ strict: null, parameters: { type: "object" }, description: "d", name: "t1", type: "function" }];
        recordLLMExchange("HTTP_SSE_EVENT", {
            type: "response.created",
            response: { id: "resp_1", tools: echoedTools },
        }, { sessionId });

        const created = readSessionEntries(sessionId).at(-1)!;
        expect(created.content.response.tools).toBeUndefined();
        expect(created.content.response.toolsRef).toBe(requestId);
    });

    test("增量态 delta 事件默认丢弃，ZBOT_LLM_LOG_DELTAS=1 时保留", () => {
        const sessionId = "sess-deltas";
        recordLLMExchange("HTTP_SSE_EVENT", { type: "response.output_text.delta", delta: "he" }, { sessionId });
        recordLLMExchange("HTTP_SSE_EVENT", { type: "response.output_item.done", item: {} }, { sessionId });
        recordLLMExchange("WS_RECV", { type: "response.reasoning_text.delta", delta: "x" }, { sessionId });
        recordLLMExchange("WS_RECV", { type: "response.completed", response: { id: "r" } }, { sessionId });

        expect(readSessionEntries(sessionId).map(entry => entry.content.type))
            .toEqual(["response.output_item.done", "response.completed"]);

        useConfig(defaultTestConfig({ runtime: { tokenizer: false, memoryUserId: 0, llmLogDeltas: true } }));
        recordLLMExchange("HTTP_SSE_EVENT", { type: "response.output_text.delta", delta: "kept" }, { sessionId });

        expect(readSessionEntries(sessionId).at(-1)!.content.delta).toBe("kept");
    });

    test("重启后续链只写新增（从日志尾部恢复历史总数）", async () => {
        // 带查询串导入得到独立模块实例，模拟进程重启后 sessionChains 为空。
        const mod = await import(`../../src/utils/logger.js?reload=${Date.now()}`) as typeof import("../../src/utils/logger.js");
        const input = (n: number) => Array.from({ length: n }, (_, i) => ({ role: "user", content: `m${i}` }));

        recordLLMExchange("REQUEST", { input: input(3) }, { sessionId: "sess-7" });
        mod.recordLLMExchange("REQUEST", { input: input(4) }, { sessionId: "sess-7" });

        const requests = fs.readFileSync(path.join(tmpDir, "sessions", "http", "sess-7.jsonl"), "utf8")
            .split("\n").filter(Boolean).map(line => JSON.parse(line).content);
        expect(requests[1].input).toHaveLength(1);
        expect(requests[1].input[0].content).toBe("m3");
        expect(requests[1].parentRequestId).toBe(requests[0].requestId);
    });

    test("旧格式日志（无 historyCount，input 为全量快照）续链仍只写新增", async () => {
        const mod = await import(`../../src/utils/logger.js?legacy=${Date.now()}`) as typeof import("../../src/utils/logger.js");
        const input = (n: number) => Array.from({ length: n }, (_, i) => ({ role: "user", content: `m${i}` }));
        const file = path.join(tmpDir, "sessions", "http", "sess-8.jsonl");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, [
            { timestamp: "t", type: "REQUEST", schemaVersion: 1, content: { model: "m", input: input(2), messages: [], requestId: "old-1" } },
            { timestamp: "t", type: "RESPONSE", schemaVersion: 1, content: { id: "r", requestId: "old-1" } },
            { timestamp: "t", type: "REQUEST", schemaVersion: 1, content: { model: "m", input: input(4), messages: [], requestId: "old-2", parentRequestId: "old-1" } },
        ].map(entry => `${JSON.stringify(entry)}\n`).join(""));

        mod.recordLLMExchange("REQUEST", { model: "m", input: input(5) }, { sessionId: "sess-8" });

        const requests = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
            .map(line => JSON.parse(line)).filter(entry => entry.type === "REQUEST").map(entry => entry.content);
        expect(requests).toHaveLength(3);
        expect(requests[2].input).toEqual([{ role: "user", content: "m4" }]);
        expect(requests[2].parentRequestId).toBe("old-2");
        expect(requests[2].historyCount).toBe(5);
    });

    test("单行超过尾部读取窗口时放大窗口续链，不重写全量", async () => {
        const mod = await import(`../../src/utils/logger.js?bigline=${Date.now()}`) as typeof import("../../src/utils/logger.js");
        const file = path.join(tmpDir, "sessions", "http", "sess-9.jsonl");
        fs.mkdirSync(path.dirname(file), { recursive: true });

        const big = "x".repeat(5 * 1024 * 1024); // 大于 4 MB 初始窗口
        const legacyInput = [
            { role: "user", content: "m0" },
            { role: "user", content: big },
            { role: "user", content: "m2" },
        ];
        fs.writeFileSync(file, `${JSON.stringify({
            timestamp: "t", type: "REQUEST", schemaVersion: 1,
            content: { model: "m", input: legacyInput, messages: [], requestId: "old-big" },
        })}\n`);

        mod.recordLLMExchange("REQUEST", {
            model: "m",
            input: [...legacyInput, { role: "user", content: "m3" }, { role: "user", content: "m4" }],
        }, { sessionId: "sess-9" });

        const requests = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
            .map(line => JSON.parse(line)).filter(entry => entry.type === "REQUEST").map(entry => entry.content);
        expect(requests).toHaveLength(2);
        expect(requests[1].input).toEqual([
            { role: "user", content: "m3" },
            { role: "user", content: "m4" },
        ]);
        expect(requests[1].historyCount).toBe(5);
        expect(requests[1].parentRequestId).toBe("old-big");
    });

});
