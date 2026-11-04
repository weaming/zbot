import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
    MAIN_CLI_USAGE,
    PRINT_CLI_USAGE,
    RESUME_CLI_USAGE,
    SERVE_CLI_USAGE,
    SESSION_CLI_USAGE,
    printCliHelp,
} from "./help.js";
import { MCP_CLI_USAGE } from "../mcp/help.js";

const SRC_ROOT = path.resolve(import.meta.dir, "..");

/** 临时接管 stdout，拿到 printCliHelp 的输出后立刻还原。 */
function capture(run: () => boolean): { printed: boolean; output: string } {
    const original = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: unknown) => {
        output += String(chunk);
        return true;
    }) as typeof process.stdout.write;
    try {
        const printed = run();
        return { printed, output };
    } finally {
        process.stdout.write = original;
    }
}

describe("printCliHelp", () => {
    test("顶层 -h / --help / help 输出总览", () => {
        for (const argv of [["-h"], ["--help"], ["help"]]) {
            const { printed, output } = capture(() => printCliHelp(argv));

            expect(printed).toBe(true);
            expect(output.trim()).toBe(MAIN_CLI_USAGE);
        }
    });

    test("子命令后的 -h / --help 输出对应用法", () => {
        expect(capture(() => printCliHelp(["serve", "--help"])).output.trim()).toBe(SERVE_CLI_USAGE);
        expect(capture(() => printCliHelp(["serve", "-h"])).output.trim()).toBe(SERVE_CLI_USAGE);
        expect(capture(() => printCliHelp(["session", "-h"])).output.trim()).toBe(SESSION_CLI_USAGE);
        expect(capture(() => printCliHelp(["-p", "--help"])).output.trim()).toBe(PRINT_CLI_USAGE);
        expect(capture(() => printCliHelp(["resume", "-h"])).output.trim()).toBe(RESUME_CLI_USAGE);
        expect(capture(() => printCliHelp(["mcp", "-h"])).output.trim()).toBe(MCP_CLI_USAGE);
    });

    test("帮助开关出现在参数之后也认", () => {
        expect(capture(() => printCliHelp(["session", "list", "--help"])).output.trim()).toBe(SESSION_CLI_USAGE);
        expect(capture(() => printCliHelp(["serve", "--port", "1", "-h"])).output.trim()).toBe(SERVE_CLI_USAGE);
        expect(capture(() => printCliHelp(["mcp", "list", "-h"])).output.trim()).toBe(MCP_CLI_USAGE);
        expect(capture(() => printCliHelp(["-p", "写个测试", "--help"])).output.trim()).toBe(PRINT_CLI_USAGE);
    });

    test("help <子命令> 也能定位，未知主题回落到总览", () => {
        expect(capture(() => printCliHelp(["help", "serve"])).output.trim()).toBe(SERVE_CLI_USAGE);
        expect(capture(() => printCliHelp(["help", "sessions"])).output.trim()).toBe(SESSION_CLI_USAGE);
        expect(capture(() => printCliHelp(["help", "resume"])).output.trim()).toBe(RESUME_CLI_USAGE);
        expect(capture(() => printCliHelp(["help", "mcp"])).output.trim()).toBe(MCP_CLI_USAGE);
        expect(capture(() => printCliHelp(["help", "nope"])).output.trim()).toBe(MAIN_CLI_USAGE);
    });

    test("只是取值像帮助的普通调用不拦截", () => {
        const cases = [
            [],
            ["serve", "--port", "9000"],
            ["-p", "写个测试"],
            ["-p", "help"],
            ["session", "list"],
        ];
        for (const argv of cases) {
            const { printed, output } = capture(() => printCliHelp(argv));

            expect(printed).toBe(false);
            expect(output).toBe("");
        }
    });

    test("`--` 之后是字面量，不当成帮助请求", () => {
        for (const argv of [["session", "send", "abc", "--", "--help"], ["session", "rename", "abc", "--", "-h"]]) {
            const { printed, output } = capture(() => printCliHelp(argv));

            expect(printed).toBe(false);
            expect(output).toBe("");
        }
    });

    test("真实入口：-h 立刻退出，不初始化宿主环境", () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-help-"));
        try {
            const result = Bun.spawnSync([process.execPath, "src/tui/main.ts", "--help"], {
                cwd: path.resolve(import.meta.dir, "../.."),
                env: { ...process.env, HOME: home },
                stdout: "pipe",
                stderr: "pipe",
            });

            expect(result.exitCode).toBe(0);
            expect(result.stdout.toString().trim()).toBe(MAIN_CLI_USAGE);
            // configureHostEnvironment 会 mkdir ~/.zbot；帮助分支必须排在它之前
            expect(fs.existsSync(path.join(home, ".zbot"))).toBe(false);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
});

describe("用法文本与实现同步", () => {
    /** 从源码的 `case "--xxx"` 抽出实现真正支持的开关。 */
    function implementedFlags(file: string): string[] {
        const source = fs.readFileSync(path.join(SRC_ROOT, file), "utf8");
        return [...new Set([...source.matchAll(/case\s+"(--[a-z][a-z-]*)"/g)].map(match => match[1]!))].sort();
    }

    /** 从用法文本抽出被写进文档的开关。 */
    function documentedFlags(usage: string): string[] {
        return [...new Set([...usage.matchAll(/--[a-z][a-z-]*/g)].map(match => match[0]))].sort();
    }

    test("serve 用法与 parseServeArgs 双向对齐", () => {
        const implemented = implementedFlags("cli/serve.ts");

        expect(implemented.length).toBeGreaterThan(0);
        expect(documentedFlags(SERVE_CLI_USAGE)).toEqual(implemented);
    });

    test("print 用法与 parsePrintArgs 双向对齐", () => {
        const implemented = implementedFlags("cli/print.ts");

        expect(implemented.length).toBeGreaterThan(0);
        expect(documentedFlags(PRINT_CLI_USAGE)).toEqual(implemented);
        // -p 是单横线短开关，正则抽不到，单独钉住
        expect(PRINT_CLI_USAGE).toContain("-p, --print");
    });

    test("总览列出全部分支入口", () => {
        for (const entry of ["zbot -p", "zbot resume", "zbot session", "zbot serve", "zbot mcp", "zbot help"]) {
            expect(MAIN_CLI_USAGE).toContain(entry);
        }
    });

    test("resume 用法与 parseResumeArgs 双向对齐", () => {
        const implemented = implementedFlags("cli/resume.ts");

        expect(implemented.length).toBeGreaterThan(0);
        expect(documentedFlags(RESUME_CLI_USAGE)).toEqual(implemented);
        expect(RESUME_CLI_USAGE).toContain("-p, --print");
    });
});
