import path from "node:path";
import os from "node:os";
import { AppError } from "../utils/app-error.js";

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
    parsePrintArgs(argv);
    throw new AppError(
        "tui_or_backend_required",
        "CLI 不会在没有 TUI 或后台持有者时直接运行模型。请启动 zbot TUI 后用 `zbot session send <id> <文本> --wait`，或把任务提交到 `zbot serve`。",
    );
}
