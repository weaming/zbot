import path from "node:path";
import os from "node:os";
import { DEFAULT_MEMORY_USER_ID } from "../utils/runtime-paths.js";
import { redirectLogsToFile } from "../host/runtime-context.js";
import { readStdinText } from "../utils/stdin.js";

export interface PrintArgs {
    prompt: string[];
    cwd: string;
    json: boolean;
    model?: string;
}

export function isPrintCliInvocation(argv: string[]): boolean {
    return argv.includes("-p") || argv.includes("--print");
}

export function parsePrintArgs(argv: string[]): PrintArgs {
    if (argv[0] !== "-p" && argv[0] !== "--print") {
        throw new Error("-p/--print 必须是首个参数");
    }
    const args: PrintArgs = { prompt: [], cwd: process.cwd(), json: false };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index + 1];
        switch (argv[index]) {
            case "-p":
            case "--print":
                break;
            case "--cwd":
                if (!value || value.startsWith("-")) throw new Error("--cwd 需要路径");
                args.cwd = path.resolve(value === "~" ? os.homedir() : value.startsWith("~/")
                    ? path.join(os.homedir(), value.slice(2))
                    : value);
                index += 1;
                break;
            case "--model":
                if (!value || value.startsWith("-")) throw new Error("--model 需要模型名");
                args.model = value;
                index += 1;
                break;
            case "--json":
                args.json = true;
                break;
            default:
                if (argv[index]?.startsWith("-")) throw new Error(`未知参数：${argv[index]}`);
                args.prompt.push(argv[index]!);
        }
    }
    return args;
}

export async function runPrintCli(argv: string[]): Promise<void> {
    const args = parsePrintArgs(argv);
    const prompt = (args.prompt.length > 0 ? args.prompt.join(" ") : await readStdinText()).trim();
    if (!prompt) throw new Error("请提供任务文本，或通过 stdin 输入任务");

    const restoreConsole = redirectLogsToFile();
    try {
        const [skills, runtime, mcp] = await Promise.all([
            import("../skills/skill-registry.js"),
            import("../services/chat-runtime.js"),
            import("../mcp/client-manager.js"),
        ]);
        try {
            await skills.skillRegistry.load();
            await mcp.initMcpClients({ mode: "tui" });

            const settings = runtime.getChatApiSettings();
            const settingsError = runtime.validateChatApiSettings(settings);
            if (settingsError) throw new Error(`LLM provider 配置无效：${settingsError}`);

        const controller = new AbortController();
        const onInterrupt = (exitCode: 130 | 143): (() => void) => () => {
            process.exitCode = exitCode;
            controller.abort();
        };
        const onSigint = onInterrupt(130);
        const onSigterm = onInterrupt(143);
        process.once("SIGINT", onSigint);
        process.once("SIGTERM", onSigterm);
            try {
                const systemPrompt = runtime.buildSystemPrompt(args.cwd);
                const result = await runtime.runChatQuery({
                    query: prompt,
                    systemPrompt,
                    cwd: args.cwd,
                    userId: DEFAULT_MEMORY_USER_ID,
                    modelOverride: args.model,
                    signal: controller.signal,
                    stream: false,
                });
                if (args.json) {
                    process.stdout.write(`${JSON.stringify({ content: result.content, toolCalls: result.toolCalls ?? 0 })}\n`);
                } else {
                    process.stdout.write(`${result.content}\n`);
                }
            } finally {
                process.removeListener("SIGINT", onSigint);
                process.removeListener("SIGTERM", onSigterm);
            }
        } finally {
            await mcp.closeAllMcpClients();
        }
    } finally {
        restoreConsole();
    }
}
