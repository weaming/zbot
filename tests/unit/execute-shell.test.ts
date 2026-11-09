import { expect, test } from "bun:test";
import { executeShellTool } from "../../src/tools/execute-shell.js";
import { backgroundTaskManager } from "../../src/tools/background-tasks.js";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";

const CWD = ".";

test("bash 工具使用可用的 shell 执行命令并返回输出", async () => {
    const shellResult = await executeShellTool.execute({ command: "printf '%s' \"$0\"", cwd: CWD });
    expect(shellResult.isError).toBeUndefined();
    expect(shellResult.content[0].text).toBe(fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");

    const result = await executeShellTool.execute({ command: "echo 'hello from zbot bash'", cwd: CWD });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("hello from zbot bash");
});

test("bash 工具不限制命令内容", async () => {
    const result = await executeShellTool.execute({ command: "printf '%s' 'sudo rm -rf /'", cwd: CWD });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("sudo rm -rf /");
});

test("bash 工具支持显式配置 timeout 并能正常执行", async () => {
    const result = await executeShellTool.execute({ command: "echo 'timeout ok'", cwd: CWD, timeout: 5 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("timeout ok");
});

test("bash 工具的 cwd 支持 ~ 与相对路径", async () => {
    const home = await executeShellTool.execute({ command: "pwd", cwd: "~" });
    expect(home.isError).toBeUndefined();
    expect(home.content[0].text).toBe(fs.realpathSync(os.homedir()));

    const relative = await executeShellTool.execute({ command: "pwd", cwd: "src/tools" });
    expect(relative.isError).toBeUndefined();
    expect(relative.content[0].text).toBe(fs.realpathSync(`${process.cwd()}/src/tools`));
});

test("bash 工具缺少 cwd 或目录不存在时直接报错", async () => {
    const missing = await executeShellTool.execute({ command: "pwd" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("缺少 cwd");

    const notExist = await executeShellTool.execute({ command: "pwd", cwd: "no-such-dir-here" });
    expect(notExist.isError).toBe(true);
    expect(notExist.content[0].text).toContain("目录不存在");
});

test("bash 工具把所属会话 id 注入 ZBOT_SESSION_ID，无会话上下文时不留继承值", async () => {
    const sessionId = "01JSHELLINJECT000000000001";
    const inside = await executeShellTool.execute({
        command: "printf '%s' \"$ZBOT_SESSION_ID\"",
        cwd: CWD,
        __sessionId: sessionId,
    });
    expect(inside.isError).toBeUndefined();
    expect(inside.content[0].text).toBe(sessionId);

    const outside = await executeShellTool.execute({
        command: "printf '%s' \"${ZBOT_SESSION_ID:-none}\"",
        cwd: CWD,
    });
    expect(outside.content[0].text).toBe("none");
});

test("bash 工具可在前台执行时通过任务管理器转入后台", async () => {
    const sessionId = `execute-shell-background-${Date.now()}`;
    const runPromise = executeShellTool.execute({ command: "sleep 10", cwd: CWD, __sessionId: sessionId });

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(backgroundTaskManager.detachForeground(sessionId)).toBe(1);

    const result = await runPromise;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('"background":true');

    const task = backgroundTaskManager.list(sessionId)[0];
    expect(task?.status).toBe("running");
    if (task) {
        backgroundTaskManager.stop(task.id, sessionId);
        await backgroundTaskManager.wait(task.id, 2_000, sessionId);
    }
});

test("bash 工具超时后会自动终止命令并返回友好提示与部分输出", async () => {
    const start = Date.now();
    const result = await executeShellTool.execute({
        command: "echo 'start working'; echo 'progress warning' >&2; sleep 3; echo 'finished'",
        cwd: CWD,
        timeout: 1,
    });
    const duration = Date.now() - start;

    expect(result.isError).toBe(true);
    expect(duration).toBeGreaterThanOrEqual(900);
    expect(duration).toBeLessThan(2500);
    expect(result.content[0].text).toContain("Command execution timed out after 1s and was terminated.");
    expect(result.content[0].text).toContain("[Partial stdout]:\nstart working");
    expect(result.content[0].text).toContain("[Partial stderr]:\nprogress warning");
    expect(result.content[0].text).toContain("[Suggestion]:");
    expect(result.content[0].text).not.toContain("finished");
});

test("bash 工具超时时会通过进程组 (-PGID) 连带杀死所有孙进程", async () => {
    const pidFile = `/tmp/zbot_test_timeout_grandchild_${Date.now()}.pid`;
    const command = `sh -c 'sleep 50 & echo $! > ${pidFile}; wait'`;

    const resultPromise = executeShellTool.execute({ command, cwd: CWD, timeout: 1 });

    let grandchildPid = 0;
    for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 20));
        const check = spawnSync("cat", [pidFile], { encoding: "utf8" });
        if (check.stdout && check.stdout.trim()) {
            grandchildPid = parseInt(check.stdout.trim(), 10);
            break;
        }
    }
    expect(grandchildPid).toBeGreaterThan(0);

    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("timed out after 1s");

    await new Promise((r) => setTimeout(r, 50));
    const isAlive = () => {
        try {
            process.kill(grandchildPid, 0);
            return true;
        } catch {
            return false;
        }
    };
    expect(isAlive()).toBe(false);
    spawnSync("rm", ["-f", pidFile]);
});

test("bash 工具能对异常 timeout 参数进行安全兜底", async () => {
    // 负数会被钳制为最小 1s，不会崩溃或失控
    const result = await executeShellTool.execute({ command: "echo 'safe fallback'", cwd: CWD, timeout: -10 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("safe fallback");
});

test("bash 工具会终止已取消的命令", async () => {
    const abortController = new AbortController();
    const abortTimer = setTimeout(() => abortController.abort(), 20);

    const result = await executeShellTool.execute({ command: "sleep 5", cwd: CWD }, abortController.signal);
    clearTimeout(abortTimer);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Command failed");
});

test("bash 工具中止时通过进程组 (-PGID) 连带杀死所有孙进程，不残留后台进程", async () => {
    const abortController = new AbortController();
    // 派生深层孙进程并在 /tmp 写下其 PID
    const pidFile = `/tmp/zbot_test_grandchild_${Date.now()}.pid`;
    const command = `sh -c 'sleep 50 & echo $! > ${pidFile}; wait'`;

    const runPromise = executeShellTool.execute({ command, cwd: CWD }, abortController.signal);

    // 等待子进程创建并写入 pid 文件
    let grandchildPid = 0;
    for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 20));
        const check = spawnSync("cat", [pidFile], { encoding: "utf8" });
        if (check.stdout && check.stdout.trim()) {
            grandchildPid = parseInt(check.stdout.trim(), 10);
            break;
        }
    }

    expect(grandchildPid).toBeGreaterThan(0);

    // 确认孙进程存活
    const isAliveBefore = () => {
        try {
            process.kill(grandchildPid, 0);
            return true;
        } catch {
            return false;
        }
    };
    expect(isAliveBefore()).toBe(true);

    // 中止命令
    abortController.abort();
    const result = await runPromise;
    expect(result.isError).toBe(true);

    // 等待操作系统清理
    await new Promise(r => setTimeout(r, 50));

    // 验证孙进程已被彻底连根杀死
    expect(isAliveBefore()).toBe(false);

    // 清理临时文件
    spawnSync("rm", ["-f", pidFile]);
});
