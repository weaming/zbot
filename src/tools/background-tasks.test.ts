/**
 * 后台任务管理测试：前台完成/超时/转后台、后台停止与等待。
 * 用 /bin/sh 跑真实子进程，按 sessionId 隔离各用例的可见范围。
 */

import { describe, expect, test } from "bun:test";
import { backgroundTaskManager } from "./background-tasks.js";

const SHELL = "/bin/sh";

interface StartOptions {
    sessionId: string;
    timeoutSeconds?: number;
    autoBackgroundOnTimeout?: boolean;
    signal?: AbortSignal;
}

function start(command: string, options: StartOptions) {
    return backgroundTaskManager.startShell({
        command,
        cwd: process.cwd(),
        env: process.env,
        shellPath: SHELL,
        timeoutSeconds: options.timeoutSeconds ?? 10,
        autoBackgroundOnTimeout: options.autoBackgroundOnTimeout ?? false,
        sessionId: options.sessionId,
        signal: options.signal,
    });
}

/** 轮询等待某个状态的任务出现：完成是异步的，不依赖固定 sleep。 */
async function waitForTask(sessionId: string, status: string, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const task = backgroundTaskManager.list(sessionId).find(item => item.status === status);
        if (task) return task;
        if (Date.now() > deadline) throw new Error(`等待任务 ${status} 超时`);
        await Bun.sleep(20);
    }
}

describe("前台执行", () => {
    test("正常结束返回输出与退出码", async () => {
        const result = await start("echo hello", { sessionId: "fg-ok" }).promise;

        expect(result.kind).toBe("completed");
        expect(result.kind === "completed" ? result.stdout.trim() : "").toBe("hello");
        expect(result.kind === "completed" ? result.exitCode : null).toBe(0);
    });

    test("到点未转后台：杀掉进程并标记 timed_out", async () => {
        const result = await start("sleep 5", { sessionId: "fg-timeout", timeoutSeconds: 0.2 }).promise;

        expect(result.kind).toBe("timed_out");
        expect(result.kind === "timed_out" ? result.timeoutSeconds : undefined).toBe(0.2);
    });

    test("到点转后台：返回 detached，任务继续跑完并保留输出", async () => {
        const result = await start("sleep 0.4; echo done", {
            sessionId: "fg-detach-timeout",
            timeoutSeconds: 0.1,
            autoBackgroundOnTimeout: true,
        }).promise;

        expect(result.kind).toBe("detached");
        // 因超时而转后台的任务记为 timed_out（与原来一致），但进程跑完后输出照样保留
        const task = await waitForTask("fg-detach-timeout", "timed_out");
        expect(task.stdout?.trim()).toBe("done");
    });
});

describe("后台任务", () => {
    test("手动转后台后可以 stop，状态落 stopped", async () => {
        const handle = start("sleep 5", { sessionId: "bg-stop" });
        expect(handle.detach()).toBe(true);

        const result = await handle.promise;
        const taskId = result.kind === "detached" ? result.task.id : "";

        expect(backgroundTaskManager.stop(taskId, "bg-stop")).toBe(true);
        const stopped = await waitForTask("bg-stop", "stopped");
        expect(stopped.id).toBe(taskId);
    });

    test("wait 拿到结束结果；超时返回当前快照", async () => {
        const handle = start("sleep 0.2; echo tail", { sessionId: "bg-wait" });
        handle.detach();
        const result = await handle.promise;
        const taskId = result.kind === "detached" ? result.task.id : "";

        const finished = await backgroundTaskManager.wait(taskId, 5_000, "bg-wait");
        expect(finished?.status).toBe("completed");
        expect(finished?.stdout?.trim()).toBe("tail");

        const long = start("sleep 5", { sessionId: "bg-wait-timeout" });
        long.detach();
        const detached = await long.promise;
        const runningId = detached.kind === "detached" ? detached.task.id : "";
        const snapshot = await backgroundTaskManager.wait(runningId, 100, "bg-wait-timeout");

        expect(snapshot?.status).toBe("running");
        backgroundTaskManager.stop(runningId, "bg-wait-timeout");
    });

    test("wait 被 abort 时抛 AbortError", async () => {
        const handle = start("sleep 5", { sessionId: "bg-wait-abort" });
        handle.detach();
        const result = await handle.promise;
        const taskId = result.kind === "detached" ? result.task.id : "";

        const controller = new AbortController();
        const waiting = backgroundTaskManager.wait(taskId, 5_000, "bg-wait-abort", controller.signal);
        controller.abort();

        await expect(waiting).rejects.toThrow(/aborted/);
        backgroundTaskManager.stop(taskId, "bg-wait-abort");
    });

    test("abort 前台运行会杀掉进程", async () => {
        const controller = new AbortController();
        const handle = start("sleep 5", { sessionId: "fg-abort", signal: controller.signal });
        controller.abort();

        const result = await handle.promise;
        expect(result.kind).toBe("aborted");
    });
});
