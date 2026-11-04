/**
 * 一次性 CLI 的宿主环境：状态目录与启动目录必须听调用方的，
 * 否则 `session send` 在自定义 ZBOT_STATE_DIR 下会找不到刚解析出来的会话。
 *
 * 只测纯解析函数：`configureHostEnvironment` 会改全局身份/环境，混跑会污染同进程的其它测试。
 */

import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

const { resolveHostEnvironment } = await import("../../src/host/runtime-context.js");

describe("resolveHostEnvironment", () => {
    test("显式 stateDir / startupCwd 优先", () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-host-env-"));
        try {
            const stateDir = path.join(tmp, "state");
            const workdir = path.join(tmp, "work");
            expect(resolveHostEnvironment({ stateDir, startupCwd: workdir })).toEqual({ stateDir, startupCwd: workdir });
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test("不给参数时回落到 ~/.zbot 与当前目录", () => {
        const resolved = resolveHostEnvironment();
        expect(resolved.stateDir).toBe(path.join(os.homedir(), ".zbot"));
        expect(resolved.startupCwd).toBe(process.cwd());
    });
});
