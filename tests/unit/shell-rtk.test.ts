import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rewriteShellCommand } from "../../src/tools/shell-rtk.js";
import { executeShellTool } from "../../src/tools/execute-shell.js";
import { backgroundTaskManager } from "../../src/tools/background-tasks.js";

const cwd = process.cwd();
mkdirSync(join(cwd, "tmp"), { recursive: true });
const fixtureDir = mkdtempSync(join(cwd, "tmp/shell-rtk-test-"));
const rawBinDir = join(fixtureDir, "raw");
mkdirSync(rawBinDir);

writeFileSync(join(fixtureDir, "rtk"), `#!/bin/sh
if [ "$1" = rewrite ]; then
    case "$RTK_TEST_MODE" in
        unavailable) exit 1 ;;
        denied) exit 2 ;;
        timeout) while :; do :; done ;;
        unexpected) printf 'rtk bun test'; exit 0 ;;
    esac
    printf 'rtk %s' "$2"
    exit "\${RTK_TEST_REWRITE_CODE:-3}"
fi
if [ "$1" = bun ]; then
    printf 'compressed bun output'
else
    printf 'compressed git output'
fi
if [ "$RTK_TEST_MODE" = running ]; then
    while :; do :; done
fi
if [ "$RTK_TEST_MODE" = failed ]; then
    printf 'git failure details' >&2
    exit 7
fi
`, { mode: 0o755 });
writeFileSync(join(rawBinDir, "git"), "#!/bin/sh\nprintf 'raw git output'\n", { mode: 0o755 });
writeFileSync(join(rawBinDir, "bun"), "#!/bin/sh\nprintf 'raw bun output'\n", { mode: 0o755 });

afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

function rewrite(command: string, extraEnv: NodeJS.ProcessEnv = {}, signal?: AbortSignal) {
    return rewriteShellCommand(command, cwd, { PATH: fixtureDir, ...extraEnv }, signal);
}

test("仅重写白名单命令，混合命令链的其他命令、空白与引用保持原样", async () => {
    const command = "  git -C 'path with spaces' status && bun test; git diff -- 'a;b'\nprintf '%s' 'git status'";
    const expected = "  rtk git -C 'path with spaces' status && rtk bun test; rtk git diff -- 'a;b'\nprintf '%s' 'git status'";
    expect(await rewrite(command)).toBe(expected);
    expect(await rewrite("bun run test && printf git")).toBe("bun run test && printf git");
});

test("接受 RTK 的 0 和 3 状态，拒绝无效重写或不可用结果", async () => {
    expect(await rewrite("git status", { RTK_TEST_REWRITE_CODE: "0" })).toBe("rtk git status");
    for (const mode of ["unavailable", "denied", "unexpected"]) {
        expect(await rewrite("git status", { RTK_TEST_MODE: mode })).toBe("git status");
    }
    expect(await rewrite("git status", { PATH: rawBinDir })).toBe("git status");
    expect(await rewrite("git status", { RTK_DISABLED: "1" })).toBe("git status");
});

test("普通 bun test 支持路径、引用、测试名筛选和超时参数", async () => {
    const commands = [
        "bun test", "bun test tests/unit/example.test.ts", "bun test 'tests/path with spaces.test.ts'",
        'bun test -t "case name" --timeout 5000', "bun test --test-name-pattern=case --timeout=10000",
        "bun test --test-name-pattern 'case.*name'", "bun test --timeout '5000'",
    ];
    for (const command of commands) expect(await rewrite(command)).toBe(`rtk ${command}`);
    expect(await rewrite("bun test; \n  ")).toBe("rtk bun test; \n  ");
});

test("Bun 的特殊模式、未知参数、动态路径及其他子命令保持原样", async () => {
    const commands = [
        "bun test --watch", "bun test --hot", "bun test --coverage", "bun test --coverage-reporter=lcov",
        "bun test --reporter junit", "bun test --reporter=dots", "bun test --dots",
        "bun test --update-snapshots", "bun test --preload setup.ts", "bun test --unknown-option",
        "bun test '--coverage'", 'bun test --rep"orter"=dots', "bun test --cov\\erage",
        "bun test --timeout", "bun test --timeout invalid", "bun test --timeout --coverage",
        "bun test -t", "bun test --test-name-pattern --watch", "bun test tests/*.test.ts",
        "bun test -- tests/unit/example.test.ts", "bun run test", "bun install", "bun build index.ts",
        "bunx tsc --noEmit", "go test ./...", "ruff check .", "RTK_DISABLED=1 bun test",
    ];
    for (const command of commands) expect(await rewrite(command)).toBe(command);
});

test("bun test 也遵循禁用、不可用回退和重写类型校验", async () => {
    expect(await rewrite("bun test", { RTK_DISABLED: "1" })).toBe("bun test");
    expect(await rewrite("bun test", { PATH: rawBinDir })).toBe("bun test");
    expect(await rewrite("bun test", { RTK_TEST_MODE: "unavailable" })).toBe("bun test");
    expect(await rewrite("bun test", { RTK_TEST_REWRITE_CODE: "0" })).toBe("rtk bun test");
});

test("bash 仅压缩普通 bun test，特殊模式和禁用时执行原始 bun", async () => {
    const envs = { PATH: `${fixtureDir}:${rawBinDir}`, RTK_DISABLED: "0" };
    const compressed = await executeShellTool.execute({ command: "bun test tests/unit/example.test.ts", cwd, envs });
    expect(compressed.isError).toBeUndefined();
    expect(compressed.content[0].text).toBe("compressed bun output");

    for (const command of ["bun test --coverage", "bun test --watch", "bun test --reporter=dots", "bun run test"]) {
        const result = await executeShellTool.execute({ command, cwd, envs });
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toBe("raw bun output");
    }
    const disabled = await executeShellTool.execute({ command: "bun test", cwd, envs: { ...envs, RTK_DISABLED: "1" } });
    expect(disabled.isError).toBeUndefined();
    expect(disabled.content[0].text).toBe("raw bun output");
});

test("管道、重定向、替换、后台任务及复杂 shell 结构不参与重写", async () => {
    const commands = [
        "git diff | head -n 2", "git diff > patch", "git status || git diff",
        "git show $(printf HEAD)", "git show `printf HEAD`", 'git show "$REF"',
        "git status &", "(git status)", "git status # comment", "git show <<EOF\nHEAD\nEOF",
        "git show 'unclosed", "git sta\\\ntus", "rtk git status", "RTK_DISABLED=1 git status",
    ];
    for (const command of commands) expect(await rewrite(command)).toBe(command);
});

test("重写超时回退原命令，中途取消不会执行后续命令", async () => {
    // 默认超时 2s 对用例太长：压到 200ms 仍能验证回退与取消
    process.env.ZBOT_RTK_TIMEOUT_MS = "200";
    try {
        expect(await rewrite("git status", { RTK_TEST_MODE: "timeout" })).toBe("git status");

        const controller = new AbortController();
        const pending = rewrite("git status", { RTK_TEST_MODE: "timeout" }, controller.signal);
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
        delete process.env.ZBOT_RTK_TIMEOUT_MS;
    }
}, 5_000);

test("bash 使用 RTK 执行 git，并保持非 git 命令原样执行", async () => {
    const result = await executeShellTool.execute({
        command: "git status && printf '\\nplain command'",
        cwd,
        envs: { PATH: fixtureDir, RTK_DISABLED: "0" },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("compressed git output\nplain command");
});

test("bash 保留 RTK 失败退出码以及 stdout 和 stderr 诊断", async () => {
    const result = await executeShellTool.execute({
        command: "git status",
        cwd,
        envs: { PATH: fixtureDir, RTK_DISABLED: "0", RTK_TEST_MODE: "failed" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("exit code 7");
    expect(result.content[0].text).toContain("compressed git output");
    expect(result.content[0].text).toContain("git failure details");
});

test("bash 在 RTK 缺失或显式关闭时仍能执行原始 git", async () => {
    for (const envs of [
        { PATH: rawBinDir, RTK_DISABLED: "0" },
        { PATH: `${rawBinDir}:${fixtureDir}`, RTK_DISABLED: "1" },
    ]) {
        const result = await executeShellTool.execute({ command: "git status", cwd, envs });
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toBe("raw git output");
    }
});

test("RTK 执行仍受 bash 超时控制", async () => {
    const result = await executeShellTool.execute({
        command: "git status",
        cwd,
        timeout: 1,
        envs: { PATH: fixtureDir, RTK_DISABLED: "0", RTK_TEST_MODE: "running" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("timed out after 1s");
    expect(result.content[0].text).toContain("compressed git output");
});

test("RTK 命令转后台后保留原始命令并能停止", async () => {
    const sessionId = "git-rtk-background-test";
    const controller = new AbortController();
    const pending = executeShellTool.execute({
        command: "git status",
        cwd,
        __sessionId: sessionId,
        envs: { PATH: fixtureDir, RTK_DISABLED: "0", RTK_TEST_MODE: "running" },
    }, controller.signal);
    try {
        let detachedCount = 0;
        for (let attempt = 0; attempt < 100 && detachedCount === 0; attempt++) {
            await Bun.sleep(10);
            detachedCount = backgroundTaskManager.detachForeground(sessionId);
        }
        expect(detachedCount).toBe(1);
        const result = await pending;
        const task = backgroundTaskManager.list(sessionId)[0]!;
        expect(result.isError).toBeUndefined();
        expect(task.command).toBe("git status");
        expect(task.status).toBe("running");
    } finally {
        controller.abort();
        for (const task of backgroundTaskManager.list(sessionId)) {
            backgroundTaskManager.stop(task.id, sessionId);
            await backgroundTaskManager.wait(task.id, 2_000, sessionId);
        }
        await pending;
    }
});
