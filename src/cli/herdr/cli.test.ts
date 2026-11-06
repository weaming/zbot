import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { HERDR_CLI_USAGE } from "../help.js";

const SRC_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const MAIN = path.join("src", "tui", "main.ts");

/** 去掉 HERDR_* 的运行环境：既验证「不在 herdr 里」的分支，也不受跑测试的 pane 影响。 */
function envWithoutHerdr(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith("HERDR_") || value === undefined) continue;
        env[key] = value;
    }
    return env;
}

/** 跑一次真实入口；超过 10s 还没退出说明落回了 TUI（那正是要防的回归）。 */
async function runEntry(
    args: string[],
): Promise<{ exitCode: number | null; killed: boolean; stdout: string; stderr: string }> {
    // 用当前 bun 的可执行路径：PATH 里没有 bun 时不该变成假失败
    const proc = Bun.spawn([process.execPath, MAIN, ...args], {
        cwd: SRC_ROOT,
        env: envWithoutHerdr(),
        stdout: "pipe",
        stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    const killed = proc.signalCode !== null;
    clearTimeout(timer);
    return { exitCode, killed, stdout, stderr };
}

describe("入口回归", () => {
    test("非 herdr 环境：herdr spawn 报 herdr_unavailable，不落回 TUI", async () => {
        const result = await runEntry(["herdr", "spawn", "--title", "x", "--cwd", os.tmpdir()]);

        expect(result.killed).toBe(false);   // 被 kill 说明 10s 内没退出，即落回了 TUI
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("HERDR_ENV");
        // 落回 TUI 会写终端控制序列（清屏/移动光标）
        expect(result.stdout).not.toContain("\u001b[");
    }, 20_000);

    test("--json 时错误走结构化输出", async () => {
        const result = await runEntry(["herdr", "teardown", "01JVZ0J8V0RZ8Q3P9Y4W1Z6K2B", "--json"]);

        expect(result.exitCode).toBe(1);
        const payload = JSON.parse(result.stdout) as { error?: { code?: string } };
        expect(payload.error?.code).toBe("herdr_unavailable");
    }, 20_000);
});

describe("用法文本与实现同步", () => {
    test("herdr 用法与解析器双向对齐", () => {
        const source = fs.readFileSync(path.join(SRC_ROOT, "src", "cli", "herdr", "args.ts"), "utf8");
        const documented = new Set([...HERDR_CLI_USAGE.matchAll(/--[a-z][a-z-]*/g)].map(match => match[0]));
        // 解析器里作为字符串字面量出现的开关（含 --x= 的形式，按前缀归并）
        const implemented = new Set(
            [...source.matchAll(/"(--[a-z][a-z-]+)=?"/g)].map(match => match[1]!),
        );

        expect(documented.size).toBeGreaterThan(0);
        expect([...implemented].sort()).toEqual([...documented].sort());
    });
});
