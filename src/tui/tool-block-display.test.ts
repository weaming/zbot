import { describe, expect, test } from "bun:test";
import * as os from "os";
import * as path from "path";
import {
    displayPath,
    formatToolBlockArgs,
    isAskUserTool,
    isTodoTool,
    parsePeerSendBlock,
    renderCollapsedToolBlock,
    renderExpandedToolBlock,
    renderCollapsedFileBlocks,
    renderToolBlockResult,
} from "./tool-block-display.js";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

describe("工具块参数转换", () => {
    test("bash 参数提取命令文本，并把其他参数放在命令前面", () => {
        const args = JSON.stringify({
            command: "curl https://example.com/a\\b | jq '.data'",
            enable_proxy: false,
            envs: { API_KEY: "secret value" },
        });

        // enable_proxy=false 为默认值时省略，避免噪音
        expect(formatToolBlockArgs("bash", args)).toBe(
            'envs={"API_KEY":"secret value"} cwd=. curl https://example.com/a\\b | jq \'.data\'',
        );
    });

    test("bash 参数 enable_proxy=true 时仍会显示", () => {
        const args = JSON.stringify({
            command: "curl https://example.com",
            enable_proxy: true,
        });

        expect(formatToolBlockArgs("bash", args)).toBe(
            "enable_proxy=true cwd=. curl https://example.com",
        );
    });

    test("bash 始终显示有效 cwd，且相对 cwd 按当前会话目录解析", () => {
        const originalTuiCwd = process.env.TUI_CWD;
        process.env.TUI_CWD = path.join(os.homedir(), "workspace");
        try {
            expect(formatToolBlockArgs("bash", JSON.stringify({ command: "ls" })))
                .toBe("cwd=. ls");
            expect(formatToolBlockArgs("bash", JSON.stringify({ command: "ls", cwd: "." })))
                .toBe("cwd=. ls");
            expect(formatToolBlockArgs("bash", JSON.stringify({ command: "ls", cwd: "~/" })))
                .toBe("cwd=~ ls");
            expect(formatToolBlockArgs("bash", JSON.stringify({ command: "ls", cwd: "a/b/c" })))
                .toBe("cwd=a/b/c/ ls");
            expect(formatToolBlockArgs("bash", JSON.stringify({ command: "ls", cwd: "/tmp" })))
                .toBe("cwd=/tmp/ ls");
        } finally {
            if (originalTuiCwd === undefined) delete process.env.TUI_CWD;
            else process.env.TUI_CWD = originalTuiCwd;
        }
    });

    test("非 bash 工具保持原始 JSON 参数", () => {
        const args = '{"command":"echo \\"hello\\""}';

        expect(formatToolBlockArgs("some_tool", args)).toBe(args);
    });

    test("Shell bash 的 commands 数组转换为管道命令", () => {
        const args = JSON.stringify({
            commands: ["printf out", "head -n 1"],
            timeout: 10,
        });

        expect(formatToolBlockArgs("Shell__bash", args)).toBe("timeout=10 cwd=. printf out | head -n 1");
    });

    test("bash 参数解析失败时保持原文", () => {
        const args = '{"command":';

        expect(formatToolBlockArgs("bash", args)).toBe(args);
    });

    test("空对象和空数组参数不渲染", () => {
        expect(formatToolBlockArgs("bash", "{}")).toBe("");
        expect(formatToolBlockArgs("some_tool", " [] ")).toBe("");
    });

    test("普通工具折叠时显示参数和耗时，不显示结果", () => {
        const rendered = renderCollapsedToolBlock({
            name: "yfinance__quote",
            args: '{"symbols":["TSM"]}',
            result: '{"price":422.95}',
            durationMs: 1234,
        });

        expect(stripTerminalSequences(rendered)).toBe(
            '🔧 yfinance__quote 1.234s\n{"symbols":["TSM"]}',
        );
        expect(rendered).toContain("\x1b[32m1.234s");
        expect(rendered).toContain("\x1b[90m");
        expect(rendered).not.toContain("422.95");
    });

    test("成功绿 / 失败红 / 取消黄：靠颜色区分状态，无耗时数据时只保留必要文字", () => {
        const success = renderCollapsedToolBlock({ name: "bash", result: "ok", durationMs: 850 });
        expect(stripTerminalSequences(success)).toBe("🔧 bash 850ms");
        expect(success).toContain("\x1b[32m850ms");

        const failed = renderCollapsedToolBlock({ name: "bash", result: "boom", isError: true, durationMs: 65000 });
        expect(stripTerminalSequences(failed)).toBe("🔧 bash 1m5s");
        expect(failed).toContain("\x1b[31m1m5s");

        const cancelled = renderCollapsedToolBlock({ name: "bash", cancelled: true, durationMs: 2000 });
        expect(stripTerminalSequences(cancelled)).toBe("🔧 bash 2s");
        expect(cancelled).toContain("\x1b[1m\x1b[33m2s");

        // 旧落盘数据没有耗时时，状态只用文字兜底
        expect(stripTerminalSequences(renderCollapsedToolBlock({ name: "bash", result: "ok" }))).toBe("🔧 bash");
        expect(stripTerminalSequences(renderCollapsedToolBlock({ name: "bash", result: "x", isError: true })))
            .toBe("🔧 bash 失败");
        expect(stripTerminalSequences(renderCollapsedToolBlock({ name: "bash", cancelled: true })))
            .toBe("🔧 bash 已取消");
    });

    test("session_send 折叠时只有 text 换成占位符，展开时仍是完整参数", () => {
        const block = {
            name: "session_send",
            args: '{"session":"a1b2c3d4","text":"帮我改一下 README 的命令示例","expect_result":true}',
            result: "已发送到会话 a1b2c3d4（msgId=7）",
        };

        const collapsed = renderCollapsedToolBlock(block);

        expect(stripTerminalSequences(collapsed)).toBe(
            "🔧 session_send\nsession=a1b2c3d4 text=... expect_result=true",
        );
        expect(collapsed).not.toContain("README");

        const expanded = renderExpandedToolBlock(block);

        expect(expanded).toContain("README");
        expect(expanded).toContain("a1b2c3d4");
    });

    test("session_send 无参数时不留参数行", () => {
        expect(stripTerminalSequences(renderCollapsedToolBlock({ name: "session_send", args: "{}" }))).toBe(
            "🔧 session_send",
        );
    });

    test("session_send 参数不是合法 JSON 时退回原始参数", () => {
        const brokenArgs = '{"session":"a1b2c3d4","text":';

        expect(stripTerminalSequences(renderCollapsedToolBlock({ name: "session_send", args: brokenArgs }))).toBe(
            `🔧 session_send\n${brokenArgs}`,
        );
    });

    test("期望结果的 session_send：正文与结果原样交给 Markdown，头部只留摘要", () => {
        const digest = parsePeerSendBlock({
            name: "session_send",
            args: JSON.stringify({
                session: "01J8ZZZZZZZZZZZZZZZZZZZZZZ",
                text: "## 改一下 README\n- 命令示例",
                expect_result: true,
            }),
            result: "改好了",
            durationMs: 1200,
        });

        expect(digest).toBeDefined();
        expect(stripTerminalSequences(digest!.head)).toBe("🔧 session_send → ZZZZZZZZ · 期望结果 1.2s");
        // 正文不再占位成 ...，结果也要能拿到
        expect(digest!.text).toBe("## 改一下 README\n- 命令示例");
        // 回执不是会话间结果的包装形状，界面按「已发送」而不是「结果」处理
        expect(digest!.result).toEqual({ body: "改好了", isResult: false });
        // wait_seconds=0：结果区只是「已发送」回执，真结果走 peer_result 气泡
        expect(digest!.waitSeconds).toBe(0);
    });

    test("就地等待的 session_send 头部标出等待秒数", () => {
        const digest = parsePeerSendBlock({
            name: "session_send",
            args: JSON.stringify({ session: "a1b2c3d4", text: "跑一下", wait_seconds: 30 }),
        });

        expect(stripTerminalSequences(digest!.head)).toBe("🔧 session_send → a1b2c3d4 · 就地等待");
        expect(digest!.waitSeconds).toBe(30);
        expect(digest!.result).toBeUndefined();
    });

    test("等待拿到的结果剥掉模型侧包装，只留正文", () => {
        const digest = parsePeerSendBlock({
            name: "session_send",
            args: JSON.stringify({ session: "01J8ZZZZZZZZZZZZZZZZZZZZZZ", text: "跑一下", wait_seconds: 30 }),
            result: "[会话 01J8ZZZZZZZZZZZZZZZZZZZZZZ 的结果]\n跑完了，全绿\n（stopReason: end_turn）",
            durationMs: 30000,
        });

        expect(digest!.result).toEqual({ body: "跑完了，全绿", isResult: true, status: "ok" });
    });

    test("失败与取消：标签要跟头部状态一致", () => {
        const failed = parsePeerSendBlock({
            name: "session_send",
            args: JSON.stringify({ session: "a1b2c3d4", text: "跑一下", wait_seconds: 30 }),
            result: "对方会话不可达",
            isError: true,
        });
        expect(failed!.isError).toBe(true);

        const cancelled = parsePeerSendBlock({
            name: "session_send",
            args: JSON.stringify({ session: "a1b2c3d4", text: "跑一下", wait_seconds: 30 }),
            cancelled: true,
        });
        expect(cancelled!.cancelled).toBe(true);
        expect(cancelled!.result).toBeUndefined();
    });

    test("纯通知或参数不合法的 session_send 交回常规渲染", () => {
        expect(parsePeerSendBlock({
            name: "session_send",
            args: JSON.stringify({ session: "a1b2c3d4", text: "知会一声" }),
        })).toBeUndefined();
        expect(parsePeerSendBlock({ name: "session_send", args: "not-json" })).toBeUndefined();
        expect(parsePeerSendBlock({ name: "bash", args: "{}" })).toBeUndefined();
    });

    test("edit_file 使用变更统计摘要并为增删行着色", () => {
        const result = [
            "Edited file successfully: sample.txt",
            "",
            "Replacements: 1",
            "",
            "```diff",
            "--- sample.txt",
            "+++ sample.txt",
            "@@ -1,2 +1,2 @@",
            "-old line",
            "+new line",
            "```",
        ].join("\n");

        const rendered = renderToolBlockResult("edit_file", result);

        expect(rendered).not.toContain("```diff");
        expect(rendered).not.toContain("```\n");
        expect(rendered).toContain("\x1b[35mEdited sample.txt (\x1b[0m");
        expect(rendered).toContain("\x1b[32m+1\x1b[0m");
        expect(rendered).toContain("\x1b[31m-1\x1b[0m");
        expect(rendered).not.toContain("Edited file successfully");
        expect(rendered).not.toContain("Replacements: 1");
        expect(rendered).not.toContain("--- sample.txt");
        expect(rendered).not.toContain("+++ sample.txt");
        expect(rendered).not.toContain("@@ -1,2 +1,2 @@");
        expect(rendered).toContain("- old line\x1b[0m");
        expect(rendered).toContain("+ new line\x1b[0m");
    });

    test("edit_file 支持多文件摘要和 hunk 行号", () => {
        const result = [
            "Edited file successfully: first.ts",
            "",
            "Replacements: 2",
            "",
            "```diff",
            "--- first.ts",
            "+++ first.ts",
            "@@ -10,2 +10,2 @@",
            " context line",
            "-old line",
            "+new line",
            "@@ -103,1 +103,1 @@",
            "-old second line",
            "+new second line",
            "--- second.ts",
            "+++ second.ts",
            "@@ -20,1 +20,2 @@",
            "+added line",
            " context line",
            "```",
        ].join("\n");

        const rendered = renderCollapsedFileBlocks([{ result }]);

        expect(rendered).toContain("Edited 2 files");
        expect(rendered).toContain("  └ first.ts");
        expect(rendered).toContain("  └ second.ts");
        expect(rendered).toContain(" 10   context line");
        expect(rendered).toContain("103 + new second line");
        expect(rendered).toContain("20");
        expect(rendered).toContain("\x1b[32m");
        expect(rendered).toContain("\x1b[31m");
    });

    test("showDiff=false 时只保留文件名与增删统计", () => {
        const single = [
            "```diff",
            "--- sample.txt",
            "+++ sample.txt",
            "@@ -1,2 +1,2 @@",
            "-old line",
            "+new line",
            "```",
        ].join("\n");
        expect(stripTerminalSequences(renderCollapsedFileBlocks([{ result: single }], false)))
            .toBe("🔧 Edited sample.txt (+1 -1)");

        const multiple = [
            "```diff",
            "--- first.ts",
            "+++ first.ts",
            "@@ -10,2 +10,2 @@",
            "-old line",
            "+new line",
            "--- second.ts",
            "+++ second.ts",
            "@@ -20,1 +20,2 @@",
            "+added line",
            "```",
        ].join("\n");
        expect(stripTerminalSequences(renderCollapsedFileBlocks([{ result: multiple }], false)).split("\n"))
            .toEqual(["🔧 Edited 2 files (+2 -1)", "  └ first.ts (+1 -1)", "  └ second.ts (+1 -0)"]);
    });

    test("文件变更摘要带耗时并合并且多块耗时", () => {
        const single = renderCollapsedToolBlock({
            name: "write_file",
            args: JSON.stringify({ path: "src/new-file.ts", content: "const a = 1;\n" }),
            result: "Successfully wrote to src/new-file.ts",
            durationMs: 940,
        });

        expect(stripTerminalSequences(single).split("\n")[0]).toBe("🔧 Wrote src/new-file.ts (+2 -0) 940ms");
        expect(single).toContain("\x1b[32m940ms");

        const merged = renderCollapsedFileBlocks([
            {
                name: "write_file",
                args: JSON.stringify({ path: "src/a.ts", content: "const a = 1;\n" }),
                result: "Successfully wrote to src/a.ts",
                durationMs: 500,
            },
            {
                name: "write_file",
                args: JSON.stringify({ path: "src/b.ts", content: "const b = 2;\n" }),
                result: "Successfully wrote to src/b.ts",
                durationMs: 1500,
            },
        ]);

        expect(stripTerminalSequences(merged).split("\n")[0]).toBe("🔧 Wrote 2 files (+4 -0) 2s");
    });

    test("文件变更失败时摘要行按红色显示耗时", () => {
        const rendered = renderCollapsedFileBlocks([
            { name: "edit_file", result: "Could not find exact match", isError: true, durationMs: 30 },
        ]);

        expect(stripTerminalSequences(rendered)).toContain("30ms");
        expect(rendered).toContain("\x1b[31m30ms");
    });

    test("edit_file 错误结果保持错误色，不误判为 diff", () => {
        const rendered = renderToolBlockResult("edit_file", "Could not find exact match", true);

        expect(rendered).toBe("\x1b[31m\x1b[2mCould not find exact match\x1b[0m");
    });

    test("write_file 渲染为与 edit_file 一致的变更风格和增行高亮", () => {
        const block = {
            name: "write_file",
            args: JSON.stringify({
                path: "src/new-file.ts",
                content: "const a = 1;\nconst b = 2;\nexport { a, b };",
            }),
            result: "Successfully wrote to src/new-file.ts",
        };

        const collapsed = renderCollapsedToolBlock(block);
        expect(collapsed).toContain("🔧");
        expect(collapsed).toContain("Wrote src/new-file.ts");
        expect(collapsed).toContain("\x1b[32m+3\x1b[0m");
        expect(collapsed).toContain("\x1b[31m-0\x1b[0m");
        expect(collapsed).toContain("1 + const a = 1;");
        expect(collapsed).toContain("2 + const b = 2;");
        expect(collapsed).toContain("3 + export { a, b };");

        const resultRendered = renderToolBlockResult("write_file", block.result, false, block.args);
        expect(resultRendered).toContain("Wrote src/new-file.ts");
        expect(resultRendered).toContain("1 + const a = 1;");
    });

    test("write_file 与 edit_file 混合时合并多文件变更统计", () => {
        const blocks = [
            {
                name: "write_file",
                args: JSON.stringify({
                    path: "src/new-module.ts",
                    content: "export function foo() {}\n",
                }),
                result: "Successfully wrote to src/new-module.ts",
            },
            {
                name: "edit_file",
                result: [
                    "Edited file successfully: src/index.ts",
                    "```diff",
                    "--- src/index.ts",
                    "+++ src/index.ts",
                    "@@ -1,1 +1,2 @@",
                    "-export {};",
                    "+export * from './new-module.js';",
                    "+export {};",
                    "```",
                ].join("\n"),
            },
        ];

        const rendered = renderCollapsedFileBlocks(blocks);
        expect(rendered).toContain("Updated 2 files");
        expect(rendered).toContain("New");
        expect(rendered).toContain("src/new-module.ts (");
        expect(rendered).toContain("  └ src/index.ts (");
        expect(rendered).toContain("\x1b[32m+4\x1b[0m"); // 2 (write) + 2 (edit)
        expect(rendered).toContain("\x1b[31m-1\x1b[0m"); // 0 (write) + 1 (edit)
    });

    test("write_file 错误结果保持错误色", () => {
        const rendered = renderToolBlockResult("write_file", "Permission denied", true);

        expect(rendered).toBe("\x1b[31m\x1b[2mPermission denied\x1b[0m");
    });

    test("apply_patch 单文件更新解析为变更摘要与增删行高亮", () => {
        const block = {
            name: "apply_patch",
            args: JSON.stringify({
                patch: [
                    "*** Begin Patch",
                    "*** Update File: src/main.ts",
                    "@@",
                    " const a = 1;",
                    "-const b = 2;",
                    "+const b = 3;",
                    "+const c = 4;",
                    "*** End Patch",
                ].join("\n"),
            }),
            result: "Success. Updated the following files:\nM src/main.ts",
        };

        const collapsed = renderCollapsedToolBlock(block);
        expect(collapsed).toContain("🔧");
        expect(collapsed).toContain("Edited src/main.ts [apply_patch] (");
        expect(collapsed).toContain("\x1b[32m+2\x1b[0m");
        expect(collapsed).toContain("\x1b[31m-1\x1b[0m");
        expect(collapsed).toContain("1   const a = 1;");
        expect(collapsed).toContain("2 - const b = 2;");
        expect(collapsed).toContain("2 + const b = 3;");
        expect(collapsed).toContain("3 + const c = 4;");

        const resultRendered = renderToolBlockResult("apply_patch", block.result, false, block.args);
        expect(resultRendered).toContain("Edited src/main.ts [apply_patch] (");
        expect(resultRendered).toContain("2 + const b = 3;");
    });

    test("apply_patch 单文件删除渲染为 Deleted 摘要", () => {
        const block = {
            name: "apply_patch",
            args: JSON.stringify({
                patch: [
                    "*** Begin Patch",
                    "*** Delete File: src/old-script.ts",
                    "*** End Patch",
                ].join("\n"),
            }),
            result: "Success. Updated the following files:\nD src/old-script.ts",
        };

        const collapsed = renderCollapsedToolBlock(block);
        expect(collapsed).toContain("🔧");
        expect(collapsed).toContain("Deleted src/old-script.ts [apply_patch] (");
        expect(collapsed).toContain("\x1b[32m+0\x1b[0m");
        expect(collapsed).toContain("\x1b[31m-0\x1b[0m");
    });

    test("apply_patch 支持新增文件、删除文件、重命名与多文件合并摘要", () => {
        const block = {
            name: "apply_patch",
            args: JSON.stringify({
                patch: [
                    "*** Begin Patch",
                    "*** Add File: src/new-util.ts",
                    "+export function util() { return 42; }",
                    "*** Update File: src/old-name.ts",
                    "*** Move to: src/new-name.ts",
                    "@@",
                    "-export const old = 1;",
                    "+export const updated = 1;",
                    "*** Delete File: src/obsolete.ts",
                    "*** End Patch",
                ].join("\n"),
            }),
            result: "Success. Updated the following files:\nA src/new-util.ts\nM src/new-name.ts\nD src/obsolete.ts",
        };

        const collapsed = renderCollapsedToolBlock(block);
        expect(collapsed).toContain("Updated 3 files [apply_patch]");
        expect(collapsed).toContain("New");
        expect(collapsed).toContain("src/new-util.ts");
        expect(collapsed).toContain("[renamed]");
        expect(collapsed).toContain("src/old-name.ts → src/new-name.ts");
        expect(collapsed).toContain("~~src/obsolete.ts~~");
        expect(collapsed).toContain("1 + export function util() { return 42; }");
        expect(collapsed).toContain("1 - export const old = 1;");
        expect(collapsed).toContain("1 + export const updated = 1;");
    });

    test("apply_patch 支持 heredoc 格式和无 args 时的 summary 回退", () => {
        const heredocBlock = {
            name: "apply_patch",
            args: JSON.stringify({
                patch: [
                    "<<'EOF'",
                    "*** Begin Patch",
                    "*** Update File: src/config.ts",
                    "@@",
                    "-port: 8080",
                    "+port: 9090",
                    "*** End Patch",
                    "EOF",
                ].join("\n"),
            }),
            result: "Success. Updated the following files:\nM src/config.ts",
        };

        const rendered = renderToolBlockResult("apply_patch", heredocBlock.result, false, heredocBlock.args);
        expect(rendered).toContain("Edited src/config.ts");
        expect(rendered).toContain("1 - port: 8080");
        expect(rendered).toContain("1 + port: 9090");

        // 当 args 为空时，回退提取 result 中的文件列表
        const fallbackBlock = {
            name: "apply_patch",
            result: "Success. Updated the following files:\nM src/fallback.ts",
        };
        const fallbackRendered = renderCollapsedToolBlock(fallbackBlock);
        expect(fallbackRendered).toContain("Edited src/fallback.ts");
    });

    test("codex 前缀工具名显示为 [codex:apply_patch] 标识", () => {
        const block = {
            name: "codex__apply_patch",
            args: JSON.stringify({
                patch: [
                    "*** Begin Patch",
                    "*** Update File: src/main.ts",
                    "@@",
                    "-const a = 1;",
                    "+const a = 2;",
                    "*** End Patch",
                ].join("\n"),
            }),
            result: "Success. Updated the following files:\nM src/main.ts",
        };

        const collapsed = renderCollapsedToolBlock(block);
        expect(collapsed).toContain("Edited src/main.ts [codex:apply_patch]");
    });

    test("apply_patch 错误结果保持错误样式", () => {
        const rendered = renderToolBlockResult("apply_patch", "Invalid patch hunk on line 3: missing header", true);
        expect(rendered).toBe("\x1b[31m\x1b[2mInvalid patch hunk on line 3: missing header\x1b[0m");
    });

    test("展开模式（Ctrl+O）：apply_patch 与 write_file/edit_file 一样不显示原始参数", () => {
        const patchBlock = {
            name: "apply_patch",
            args: JSON.stringify({
                patch: "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch",
            }),
            result: "Success. Updated the following files:\nM a.ts",
        };

        const expanded = renderExpandedToolBlock(patchBlock);
        expect(expanded).toContain("Edited a.ts");
        expect(expanded).toContain("1 - old");
        expect(expanded).toContain("1 + new");
        expect(expanded).not.toContain("*** Begin Patch");
        expect(expanded).not.toContain('"patch":');
    });

    test("展开模式（Ctrl+O）：edit_file 与 write_file 不显示参数", () => {
        const editBlock = {
            name: "edit_file",
            args: JSON.stringify({
                path: "sample.txt",
                edits: [{ oldText: "old line", newText: "new line" }],
            }),
            result: [
                "Edited file successfully: sample.txt",
                "```diff",
                "--- sample.txt",
                "+++ sample.txt",
                "@@ -1,2 +1,2 @@",
                "-old line",
                "+new line",
                "```",
            ].join("\n"),
        };

        const editExpanded = renderExpandedToolBlock(editBlock);
        expect(editExpanded).toContain("Edited sample.txt");
        expect(editExpanded).toContain("- old line");
        expect(editExpanded).toContain("+ new line");
        expect(editExpanded).not.toContain("edits");
        expect(editExpanded).not.toContain('"oldText"');

        const writeBlock = {
            name: "write_file",
            args: JSON.stringify({
                path: "src/new-file.ts",
                content: "const a = 1;\nconst b = 2;\nexport { a, b };",
            }),
            result: "Successfully wrote to src/new-file.ts",
        };

        const writeExpanded = renderExpandedToolBlock(writeBlock);
        expect(writeExpanded).toContain("Wrote src/new-file.ts");
        expect(writeExpanded).toContain("1 + const a = 1;");
        expect(writeExpanded).not.toContain('"path":"src/new-file.ts"');
        expect(writeExpanded).not.toContain('"content"');
    });

    test("展开模式（Ctrl+O）：非文件变更工具正常显示参数和结果", () => {
        const quoteBlock = {
            name: "yfinance__quote",
            args: '{"symbols":["TSM"]}',
            result: '{"price":422.95}',
        };

        const quoteExpanded = renderExpandedToolBlock(quoteBlock);
        expect(quoteExpanded).toContain("🔧 yfinance__quote");
        expect(quoteExpanded).toContain('{"symbols":["TSM"]}');
        expect(quoteExpanded).toContain('{"price":422.95}');

        const bashBlock = {
            name: "bash",
            args: JSON.stringify({ command: "ls -la", enable_proxy: false }),
            result: "total 0\ndrwxr-xr-x",
        };

        const bashExpanded = renderExpandedToolBlock(bashBlock);
        expect(bashExpanded).toContain("🔧 bash");
        expect(bashExpanded).toContain("ls -la");
        expect(bashExpanded).toContain("total 0\ndrwxr-xr-x");
    });

    test("Shell__bash 输出为 JSON 对象（含 stdout/stderr）时解包格式化渲染", () => {
        const resultJson = JSON.stringify({
            stderr: "$ tsgo && bun run build.mjs\n",
            stdout: "Building dist/index.js...\nBundled 523 modules in 58ms\n",
        });

        const rendered = renderToolBlockResult("Shell__bash", resultJson);
        expect(rendered).toContain("$ tsgo && bun run build.mjs");
        expect(rendered).toContain("Building dist/index.js...");
        expect(rendered).toContain("Bundled 523 modules in 58ms");
        expect(rendered).not.toContain('{"stderr":');
        expect(rendered).not.toContain('"stdout":');
        expect(rendered).not.toContain('\\n');
    });

    test("Shell__bash 输出为 JSON 字符串标量时自动反转义并按正常多行展示", () => {
        const jsonScalar = JSON.stringify("line 1: match\nline 2: match > pass\n");

        const rendered = renderToolBlockResult("Shell__bash", jsonScalar);
        expect(rendered).toContain("line 1: match\nline 2: match > pass");
        expect(rendered).not.toContain('\\n');
        expect(rendered).not.toBe("");
    });
});

describe("displayPath 相对化展示", () => {
    const root = path.join(os.tmpdir(), "zbot-display-test");
    const cwd = path.join(root, "proj");

    test("cwd 之下的绝对路径转为相对路径", () => {
        expect(displayPath(path.join(cwd, "src/foo.ts"), cwd)).toBe("src/foo.ts");
        expect(displayPath(path.join(cwd, "a/b/c.ts"), cwd)).toBe("a/b/c.ts");
    });

    test("cwd 之外的绝对路径与相对路径保持原样", () => {
        const outside = path.join(root, "other.ts");
        expect(displayPath(outside, cwd)).toBe(outside);
        expect(displayPath("src/foo.ts", cwd)).toBe("src/foo.ts");
    });

    test("edit_file 渲染 diff 头部的绝对路径时相对化为 cwd 内路径", () => {
        const target = path.join(cwd, "src/foo.ts");
        const previousEnv = process.env.TUI_CWD;
        process.env.TUI_CWD = cwd;
        try {
            const result = [
                `Edited file successfully: src/foo.ts`,
                "",
                "Replacements: 1",
                "",
                "```diff",
                `--- ${target}`,
                `+++ ${target}`,
                "@@ -1,1 +1,2 @@",
                "-old line",
                "+new line",
                "```",
            ].join("\n");

            const rendered = renderToolBlockResult("edit_file", result);
            expect(rendered).toContain("Edited src/foo.ts");
            expect(rendered).not.toContain(target);
        } finally {
            if (previousEnv === undefined) {
                delete process.env.TUI_CWD;
            } else {
                process.env.TUI_CWD = previousEnv;
            }
        }
    });

    test("write_file 参数里的 cwd 内绝对路径渲染为相对路径", () => {
        const target = path.join(cwd, "src/new-file.ts");
        const previousEnv = process.env.TUI_CWD;
        process.env.TUI_CWD = cwd;
        try {
            const block = {
                name: "write_file",
                args: JSON.stringify({ path: target, content: "const a = 1;\n" }),
                result: `Successfully wrote to ${target}`,
            };

            const collapsed = renderCollapsedToolBlock(block);
            expect(collapsed).toContain("Wrote src/new-file.ts");
            expect(collapsed).not.toContain(target);
        } finally {
            if (previousEnv === undefined) {
                delete process.env.TUI_CWD;
            } else {
                process.env.TUI_CWD = previousEnv;
            }
        }
    });
});

describe("todo 工具识别", () => {
    test("识别本地与命名空间的 todo 工具", () => {
        expect(isTodoTool("todo")).toBe(true);
        expect(isTodoTool("Local__todo")).toBe(true);
        expect(isTodoTool("mcp:todo")).toBe(true);
        expect(isTodoTool("todo_write")).toBe(false);
    });
});

describe("ask_user 问答块", () => {
    /** 折叠/展开两条路径应当渲染同一份问答文本。 */
    function renderBoth(block: { name: string; args?: string; result?: string; isError?: boolean }): string {
        const collapsed = renderCollapsedToolBlock(block);
        expect(renderExpandedToolBlock(block)).toBe(collapsed);
        return collapsed;
    }

    function askArgs(questions: unknown[]): string {
        return JSON.stringify({ questions });
    }

    test("识别本地与命名空间的 ask_user 工具", () => {
        expect(isAskUserTool("ask_user")).toBe(true);
        expect(isAskUserTool("Local__ask_user")).toBe(true);
        expect(isAskUserTool("mcp:ask_user")).toBe(true);
        expect(isAskUserTool("ask_user_question")).toBe(false);
        expect(isAskUserTool("bash")).toBe(false);
    });

    test("作答后逐题回显「标签 · 题干 → 选择」", () => {
        const rendered = renderBoth({
            name: "ask_user",
            args: askArgs([
                { header: "部署方式", question: "这次部署走哪条路？", options: [{ label: "方案 A" }, { label: "方案 B" }] },
                {
                    header: "通知渠道",
                    question: "要不要顺手通知团队？",
                    multiSelect: true,
                    options: [{ label: "邮件" }, { label: "Slack" }],
                },
            ]),
            result: [
                "用户已回答：",
                "1. 这次部署走哪条路？ → 方案 A",
                "2. 要不要顺手通知团队？（多选） → 邮件、Slack、其他：顺便发群里",
            ].join("\n"),
        });

        expect(stripTerminalSequences(rendered)).toBe([
            "❓ 提问",
            " ✓ 1. 部署方式 · 这次部署走哪条路？ → 方案 A",
            " ✓ 2. 通知渠道 · 要不要顺手通知团队？ → 邮件、Slack、其他：顺便发群里",
        ].join("\n"));
        // 选择用成功色，题干保持工具块的灰
        expect(rendered).toContain("\x1b[32m方案 A\x1b[0m");
        expect(rendered).toContain("\x1b[32m邮件、Slack、其他：顺便发群里\x1b[0m");
        expect(rendered).not.toContain("🔧");
    });

    test("题干里带箭头也能按题干锚定作答", () => {
        const rendered = renderBoth({
            name: "ask_user",
            args: askArgs([{ header: "", question: "A → B 走哪条？", options: [{ label: "甲" }, { label: "乙" }] }]),
            result: ["用户已回答：", "1. A → B 走哪条？ → 乙"].join("\n"),
        });

        expect(stripTerminalSequences(rendered)).toContain(" ✓ 1. A → B 走哪条？ → 乙");
    });

    test("等待作答：只有题干，没有选择", () => {
        const rendered = renderBoth({
            name: "ask_user",
            args: askArgs([{ header: "部署方式", question: "这次部署走哪条路？", options: [{ label: "方案 A" }] }]),
        });

        expect(stripTerminalSequences(rendered)).toBe([
            "❓ 提问（等待作答）",
            " · 1. 部署方式 · 这次部署走哪条路？",
        ].join("\n"));
    });

    test("用户取消：整次不作答，只留题干", () => {
        const rendered = renderBoth({
            name: "ask_user",
            args: askArgs([{ header: "部署方式", question: "这次部署走哪条路？", options: [{ label: "方案 A" }] }]),
            result: "用户取消了这次提问，没有作答。请按你认为最合理的默认方案继续，并在回复里说明你假设了什么。",
        });

        expect(stripTerminalSequences(rendered)).toBe([
            "❓ 提问（已取消）",
            " · 1. 部署方式 · 这次部署走哪条路？",
        ].join("\n"));
    });

    test("结果里缺某题时该题留白，其余照常回显", () => {
        const rendered = renderBoth({
            name: "ask_user",
            args: askArgs([
                { header: "部署方式", question: "这次部署走哪条路？", options: [{ label: "方案 A" }] },
                { header: "通知", question: "要不要通知团队？", options: [{ label: "要" }, { label: "不要" }] },
            ]),
            result: ["用户已回答：", "2. 要不要通知团队？ → 要"].join("\n"),
        });

        expect(stripTerminalSequences(rendered)).toBe([
            "❓ 提问",
            " · 1. 部署方式 · 这次部署走哪条路？",
            " ✓ 2. 通知 · 要不要通知团队？ → 要",
        ].join("\n"));
    });

    test("参数不是可解析的题目 / 结果格式不认识：回退通用工具块", () => {
        const brokenArgs = renderCollapsedToolBlock({ name: "ask_user", args: '{"questions":', result: "用户已回答：" });
        expect(brokenArgs).toContain("🔧 ask_user");
        expect(brokenArgs).not.toContain("❓");

        const unknownResult = renderCollapsedToolBlock({
            name: "ask_user",
            args: askArgs([{ header: "部署方式", question: "这次部署走哪条路？", options: [{ label: "方案 A" }] }]),
            result: "Unexpected tool failure",
        });
        expect(unknownResult).toContain("🔧 ask_user");
        expect(unknownResult).not.toContain("❓");
    });

    test("工具报错时不冒充问答块", () => {
        const rendered = renderCollapsedToolBlock({
            name: "ask_user",
            args: askArgs([{ header: "部署方式", question: "这次部署走哪条路？", options: [{ label: "方案 A" }] }]),
            result: "ask_user 参数不合法：questions 必须是非空数组",
            isError: true,
        });

        expect(rendered).toContain("失败");
        expect(rendered).not.toContain("❓");
        // 展开态仍保留错误原文（问答块不接管错误）
        expect(renderExpandedToolBlock({
            name: "ask_user",
            args: askArgs([{ header: "部署方式", question: "这次部署走哪条路？", options: [{ label: "方案 A" }] }]),
            result: "ask_user 参数不合法：questions 必须是非空数组",
            isError: true,
        })).toContain("ask_user 参数不合法");
    });
});
