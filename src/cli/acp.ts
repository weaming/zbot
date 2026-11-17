/** 标准 ACP 的 stdio 入口；stdout 只承载 JSON-RPC，绝不混入终端控制帧。 */
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { AcpAgent, type AcpAgentOptions } from "./acp-agent.js";
import { parseHeadlessArgs, runHeadless } from "./headless.js";

interface ProtocolOptions extends Omit<AcpAgentOptions, "onFailure"> {
    input: Readable;
    output: Writable;
    signal?: AbortSignal;
    onClosing?: () => void;
    writeTimeoutMs?: number;
    maxMessageBytes?: number;
    maxRequests?: number;
}

export async function runAcpProtocol(options: ProtocolOptions): Promise<void> {
    let connection: acp.AgentConnection | undefined;
    let failure: Error | undefined;
    const fail = (error: Error): void => {
        failure ??= error;
        connection?.close(error);
    };
    const agent = new AcpAgent({ ...options, onFailure: fail });
    const writeTimeoutMs = options.writeTimeoutMs ?? 5000;
    const output = new WritableStream<Uint8Array>({
        write: chunk => new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                const error = new Error("ACP 输出等待超时");
                fail(error);
                reject(error);
            }, writeTimeoutMs);
            try {
                options.output.write(chunk, error => {
                    clearTimeout(timer);
                    if (error) { fail(error); reject(error); }
                    else resolve();
                });
            } catch (error) {
                clearTimeout(timer);
                fail(error instanceof Error ? error : new Error(String(error)));
                reject(error);
            }
        }),
    });
    const abort = (): void => { connection?.close(); };
    const onOutputError = (error: Error): void => fail(error);
    options.output.on("error", onOutputError);
    options.input.on("error", onOutputError);
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
        const requests = new Set<string>();
        const codec = acp.ndJsonStream(output,
            Readable.toWeb(options.input) as ReadableStream<Uint8Array>,
            { maxMessageBytes: options.maxMessageBytes ?? 8 * 1024 * 1024 });
        const readable = codec.readable.pipeThrough(new TransformStream<acp.AnyMessage, acp.AnyMessage>({
            transform(message, controller) {
                if ("method" in message && "id" in message) {
                    const key = JSON.stringify(message.id);
                    if ((typeof message.id === "string" && message.id.length > 128)
                        || requests.has(key) || requests.size >= (options.maxRequests ?? 128)) {
                        const error = new Error("ACP 请求 id 重复、过长或在途请求超过上限");
                        fail(error);
                        throw error;
                    }
                    requests.add(key);
                }
                controller.enqueue(message);
            },
        }));
        const writer = codec.writable.getWriter();
        const writable = new WritableStream<acp.AnyMessage>({
            async write(message) {
                await writer.write(message);
                if (!("method" in message) && "id" in message) requests.delete(JSON.stringify(message.id));
            },
        });
        connection = agent.app().connect({ readable, writable });
        if (options.signal?.aborted) abort();
        await connection.closed;
        if (connection.signal.reason instanceof acp.MessageTooLargeError) failure ??= connection.signal.reason;
    } finally {
        options.onClosing?.();
        connection?.close();
        options.input.destroy();
        try { await agent.dispose(); }
        finally {
            options.signal?.removeEventListener("abort", abort);
            options.output.off("error", onOutputError);
            options.input.off("error", onOutputError);
        }
    }
    if (failure) throw failure;
}

export async function runAcp(argv: string[]): Promise<void> {
    const { cwd } = parseHeadlessArgs(argv, "acp");
    await runHeadless(cwd, async context => {
        const { registerSessionRuntime } = await import("../control/runtime.js");
        const { getChatModelOptions, getChatApiSettings } = await import("../services/chat-runtime.js");
        const { defaultMcpSelection } = await import("../mcp/client-manager.js");
        const { createImageAsset } = await import("../utils/image-assets.js");
        const { connectAcpMcp } = await import("./acp-mcp.js");
        const { eventLog } = await import("./session/store.js");
        const settings = getChatApiSettings();
        await runAcpProtocol({
            ...context, input: process.stdin, output: process.stdout,
            models: getChatModelOptions().map(model => ({ ...model, protocol: model.protocol ?? "chat_completions" })),
            defaultModel: {
                provider: settings.provider, protocol: settings.protocol ?? "chat_completions", model: settings.model,
                ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
            },
            defaultServers: defaultMcpSelection(), saveImage: createImageAsset,
            connectMcp: connectAcpMcp, readHistory: id => eventLog.iterate(id), registerRuntime: registerSessionRuntime,
        });
    });
}
