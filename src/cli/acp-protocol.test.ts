import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import type { AcpHost } from "./acp-agent.js";
import { runAcpProtocol } from "./acp.js";

type Frame = { jsonrpc: string; id?: string | number | null; result?: any; error?: { code: number }; method?: string; params?: any };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function fixture(extra: Partial<Parameters<typeof runAcpProtocol>[0]> = {}) {
    const input = new PassThrough();
    const frames: Frame[] = [];
    const claimed = new Set<string>();
    const calls = { released: [] as string[], runtimeClosed: false };
    const host: AcpHost = {
        createSession: async () => ({ sessionId: "own" }),
        claimSession: async id => { claimed.add(id); return { ok: true }; },
        releaseSession: id => { claimed.delete(id); calls.released.push(id); },
        ensureSessionCreated: async () => {},
        isSessionClaimed: id => claimed.has(id), isSessionBusy: () => false,
        listSessions: async () => [], isSessionArchived: async () => false,
        unarchiveSession: async () => {}, closeSession: async () => {},
        getSessionCwd: async () => process.cwd(), setSessionCwd: async () => {},
        getSessionModelSelection: async () => undefined, setSessionModelSelection: async () => {},
        setSessionLazyMcpServers: async () => {},
        sendMessage: async () => ({}), abortSession: async () => true,
        subscribeEvents: () => () => {}, readSessionEvents: async () => [],
    };
    const output = new Writable({ write(chunk, _encoding, callback) {
        frames.push(JSON.parse(chunk.toString()));
        callback();
    } });
    const model = { provider: "test", model: "test", protocol: "chat_completions" as const };
    const done = runAcpProtocol({
        host, input, output, models: [model], defaultModel: model, defaultServers: [],
        saveImage: async () => { throw new Error("unexpected image"); },
        connectMcp: async () => ({ servers: [], close: async () => {} }),
        registerRuntime: () => () => { calls.runtimeClosed = true; },
        ...extra,
    });
    void done.catch(() => undefined);
    cleanups.push(async () => { input.destroy(); await done.catch(() => undefined); });
    const request = async (id: string | number, method: string, params: unknown = {}) => {
        input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        await waitFor(() => frames.some(frame => frame.id === id));
        return frames.find(frame => frame.id === id)!;
    };
    const ready = async () => {
        await request(1, "initialize", { protocolVersion: 1 });
        await request(2, "session/new", { cwd: process.cwd(), mcpServers: [] });
    };
    return { input, output, host, frames, done, calls, request, ready };
}

async function waitFor(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!check()) {
        if (Date.now() > deadline) throw new Error("等待 ACP 帧超时");
        await new Promise(resolve => setTimeout(resolve, 1));
    }
}

describe("ACP 标准 JSON-RPC 管道", () => {
    test("逐字节 UTF-8、数字 ID、无效 JSON 可恢复，所有帧带 jsonrpc:2.0", async () => {
        const f = fixture();
        f.input.write("not-json\n");
        await waitFor(() => f.frames.length > 0);
        expect(f.frames[0]).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
        await f.ready();
        const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: "中文", method: "session/prompt", params: {
            sessionId: "own", prompt: [{ type: "text", text: "你好🙂" }],
        } })}\n`);
        for (const byte of bytes) f.input.write(Buffer.from([byte]));
        await waitFor(() => f.frames.some(frame => frame.id === "中文"));
        expect(f.frames.find(frame => frame.id === "中文")?.result).toEqual({ stopReason: "end_turn" });
        expect(f.frames.every(frame => frame.jsonrpc === "2.0")).toBe(true);
        f.input.end();
        await f.done;
        expect(f.calls.released).toEqual(["own"]);
        expect(f.calls.runtimeClosed).toBe(true);
    });

    test("超长行与输出超时明确失败并清理", async () => {
        const large = fixture({ maxMessageBytes: 64 });
        large.input.write("x".repeat(65));
        await expect(large.done).rejects.toThrow();
        const output = new Writable({ write() {} });
        const stalled = fixture({ output, writeTimeoutMs: 10 });
        stalled.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`);
        await expect(stalled.done).rejects.toThrow("ACP 输出等待超时");
    });

    test("信号和断管关闭连接，不落回 TUI", async () => {
        const controller = new AbortController();
        const f = fixture({ signal: controller.signal });
        await f.ready();
        controller.abort();
        await f.done;
        expect(f.calls.released).toEqual(["own"]);
        const broken = fixture();
        await broken.ready();
        broken.output.destroy(new Error("broken pipe"));
        await expect(broken.done).rejects.toThrow("broken pipe");
        expect(broken.calls.released).toEqual(["own"]);
    });
});
