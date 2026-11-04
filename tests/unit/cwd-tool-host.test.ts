import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * cwd 工具的宿主能力测试：落盘入口由宿主自己装配，不靠前端注入。
 *
 * 反例就是无 UI 的 `zbot serve`：它没有 TUI，若落盘入口只由前端注入，
 * 工具在 serve 里只能回「当前运行模式不支持切换会话目录」。
 */

const { LocalSessionHost } = await import("../../src/host/session-host.js");
const { cwdTool } = await import("../../src/tools/cwd-tool.js");
const { getSessionControl } = await import("../../src/control/runtime.js");

let tmpDir: string;
let savedStateDir: string | undefined;
let savedTuiCwd: string | undefined;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-cwd-tool-"));
    savedStateDir = process.env.ZBOT_STATE_DIR;
    savedTuiCwd = process.env.TUI_CWD;
    process.env.ZBOT_STATE_DIR = tmpDir;
    process.env.TUI_CWD = tmpDir;
});

afterEach(() => {
    if (savedStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = savedStateDir;
    if (savedTuiCwd === undefined) delete process.env.TUI_CWD;
    else process.env.TUI_CWD = savedTuiCwd;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("cwd 工具的会话落盘入口", () => {
    test("宿主装配后无需前端注入即可切目录并落盘", async () => {
        const host = new LocalSessionHost(undefined, { startupCwd: tmpDir });
        try {
            const target = fs.mkdtempSync(path.join(tmpDir, "sub-"));
            const { sessionId } = await host.createSession(tmpDir);
            await host.claimSession(sessionId, { noNegotiate: true });

            const result = await cwdTool.execute({ action: "set", path: target, __sessionId: sessionId });

            expect(result.isError).toBeFalsy();
            expect(await host.getSessionCwd(sessionId)).toBe(path.resolve(target));
            const events = await host.readSessionEvents(sessionId);
            expect(events.at(-1)?.type).toBe("session_cwd_changed");
        } finally {
            await host.close();
        }
    });

    test("宿主关闭后释放入口：不写进已退出的宿主，工具如实报错", async () => {
        const host = new LocalSessionHost(undefined, { startupCwd: tmpDir });
        const target = fs.mkdtempSync(path.join(tmpDir, "sub-"));
        const { sessionId } = await host.createSession(tmpDir);
        await host.claimSession(sessionId, { noNegotiate: true });
        await host.close();

        const result = await cwdTool.execute({ action: "set", path: target, __sessionId: sessionId });

        // 已退出宿主不再被解析：工具拒绝，不改任何目录
        expect(result.isError).toBe(true);
        expect(process.env.TUI_CWD).toBe(tmpDir);
    });

    test("关闭较早的宿主不会摘掉后来宿主的入口", async () => {
        const older = new LocalSessionHost(undefined, { startupCwd: tmpDir });
        const newer = new LocalSessionHost(undefined, { startupCwd: tmpDir });
        try {
            const target = fs.mkdtempSync(path.join(tmpDir, "newer-"));
            const { sessionId } = await newer.createSession(tmpDir);
            await newer.claimSession(sessionId, { noNegotiate: true });

            await older.close();

            const result = await cwdTool.execute({ action: "set", path: target, __sessionId: sessionId });
            expect(result.isError).toBeFalsy();
            expect(await newer.getSessionCwd(sessionId)).toBe(path.resolve(target));
        } finally {
            await newer.close();
        }
    });

    test("多宿主同进程：按会话解析到各自的宿主，不互相覆盖", async () => {
        const first = new LocalSessionHost(undefined, { startupCwd: tmpDir });
        const second = new LocalSessionHost(undefined, { startupCwd: tmpDir });
        try {
            const firstDir = fs.mkdtempSync(path.join(tmpDir, "first-"));
            const secondDir = fs.mkdtempSync(path.join(tmpDir, "second-"));
            const firstSession = (await first.createSession(tmpDir)).sessionId;
            const secondSession = (await second.createSession(tmpDir)).sessionId;
            await first.claimSession(firstSession, { noNegotiate: true });
            await second.claimSession(secondSession, { noNegotiate: true });

            // 控制通道按会话路由：不再由"最后创建的宿主"一把抓
            expect(getSessionControl(firstSession)).toBe(first.sessionControl);
            expect(getSessionControl(secondSession)).toBe(second.sessionControl);

            expect((await cwdTool.execute({ action: "set", path: firstDir, __sessionId: firstSession })).isError)
                .toBeFalsy();
            expect((await cwdTool.execute({ action: "set", path: secondDir, __sessionId: secondSession })).isError)
                .toBeFalsy();

            expect(await first.getSessionCwd(firstSession)).toBe(path.resolve(firstDir));
            expect(await second.getSessionCwd(secondSession)).toBe(path.resolve(secondDir));
        } finally {
            await first.close();
            await second.close();
        }
    });

    test("关闭的宿主不再被解析：并发的另一个实例照常工作", async () => {
        const keeper = new LocalSessionHost(undefined, { startupCwd: tmpDir });
        const leaving = new LocalSessionHost(undefined, { startupCwd: tmpDir });
        const keeperSession = (await keeper.createSession(tmpDir)).sessionId;
        const leavingSession = (await leaving.createSession(tmpDir)).sessionId;
        await keeper.claimSession(keeperSession, { noNegotiate: true });
        await leaving.claimSession(leavingSession, { noNegotiate: true });
        const leavingControl = leaving.sessionControl;
        try {
            await leaving.close();

            // 已退出实例的能力不再出现在解析结果里
            expect(getSessionControl(leavingSession)).not.toBe(leavingControl);
            expect(getSessionControl(keeperSession)).toBe(keeper.sessionControl);

            const target = fs.mkdtempSync(path.join(tmpDir, "keeper-"));
            const result = await cwdTool.execute({ action: "set", path: target, __sessionId: keeperSession });
            expect(result.isError).toBeFalsy();
            expect(await keeper.getSessionCwd(keeperSession)).toBe(path.resolve(target));
        } finally {
            await keeper.close();
        }
    });

    test("没有会话上下文时只改进程级目录，不落盘", async () => {
        const host = new LocalSessionHost(undefined, { startupCwd: tmpDir });
        try {
            const target = fs.mkdtempSync(path.join(tmpDir, "loose-"));

            const result = await cwdTool.execute({ action: "set", path: target });

            expect(result.isError).toBeFalsy();
            expect(process.env.TUI_CWD).toBe(path.resolve(target));
        } finally {
            await host.close();
        }
    });
});
