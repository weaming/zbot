import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { defaultTestConfig, useConfig } from "./test-config.js";
import { useTmpStateDir } from "./test-env.js";
import type { ChatMessage } from "../../src/types/session.js";

let send: (request: any) => Promise<any>;
let protocol: "responses" | "chat_completions" = "chat_completions";
const realOrchestrator = await import("../../src/tools/chat-orchestrator.js");
mock.module("../../src/tools/chat-orchestrator.js", () => ({
    ...realOrchestrator,
    createChatClient: () => ({
        baseURL: "http://test.invalid/v1",
        protocol,
        create: (request: any) => send(request),
        createResponse: (request: any) => send(request),
    }),
}));
const { runChatQuery } = await import("../../src/services/chat-runtime.js");

let restoreConfig: (() => void) | undefined;
let stateDir: ReturnType<typeof useTmpStateDir> | undefined;

afterEach(() => {
    restoreConfig?.();
    stateDir?.cleanup();
});

afterAll(() => {
    mock.module("../../src/tools/chat-orchestrator.js", () => realOrchestrator);
});

describe("chat runtime 请求体超限恢复", () => {
    test.each([
        ["chat_completions", false],
        ["responses", false],
        ["chat_completions", true],
        ["responses", true],
    ] as const)(
        "%s 请求体超限恢复（手动压缩=%s）",
        async (selectedProtocol, isManualCompact) => {
            protocol = selectedProtocol;
            stateDir = useTmpStateDir("zbot-body-limit-");
            restoreConfig = useConfig(defaultTestConfig()).restore;
            const history: ChatMessage[] = [
                { role: "user", content: `EARLY ${"a".repeat(5000)}` },
                { role: "assistant", content: "b".repeat(5000) },
                { role: "user", content: `LATE ${"c".repeat(5000)}` },
                { role: "assistant", content: "d".repeat(5000) },
            ];
            const requests: any[] = [];
            send = async request => {
                requests.push(request);
                const text = JSON.stringify(request.messages ?? request.input);
                if (Buffer.byteLength(text) > 12_000) {
                    throw Object.assign(new Error("413 Failed to buffer the request body: length limit exceeded"), { status: 413 });
                }
                const content = request.tool_choice === "none"
                    ? ["EARLY", "LATE"].filter(marker => text.includes(marker)).join(" ") || "摘要"
                    : "done";
                if (protocol === "chat_completions" && request.stream) {
                    return (async function* () {
                        yield {
                            choices: [{ delta: { role: "assistant", content }, finish_reason: "stop" }],
                            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
                        };
                    })();
                }
                return protocol === "responses"
                    ? {
                        id: `response-${requests.length}`,
                        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] }],
                        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
                    }
                    : {
                        choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
                        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
                    };
            };
            const compacted: string[] = [];
            const errors: string[] = [];
            const result = await runChatQuery({
                query: "继续",
                systemPrompt: "system",
                history,
                userId: 0,
                compactOnProviderOverflow: !isManualCompact,
                ...(isManualCompact ? {
                    initialRequestKind: "context_compaction" as const,
                    disableToolCalls: true,
                } : {}),
                onTurnCompact: async summary => { compacted.push(summary); },
                onEvent: event => {
                    if (event.type === "error") errors.push(event.message);
                },
            });

            expect(result.content).toBe(isManualCompact ? "EARLY LATE" : "done");
            expect(compacted).toEqual(isManualCompact ? [] : ["EARLY LATE"]);
            expect(requests).toHaveLength(isManualCompact ? 4 : 6);
            expect(errors).toEqual([]);
            expect(requests.slice(1, -1).every(request => request.tool_choice === "none")).toBe(true);
            expect(history).toHaveLength(4);
        },
    );
});
