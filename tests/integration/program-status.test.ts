import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

test.skipIf(!Bun.which("hc"))("真实 herdr-core 解析 OSC 7501 根状态与子记录", async () => {
    const dir = await fs.mkdtemp(path.join(process.env.CANBAN_RUN_DIR ?? os.tmpdir(), "hc-"));
    const env = {
        ...process.env,
        HC_SESSION: `zbot-${randomBytes(4).toString("hex")}`,
        HC_SOCKET: path.join(dir, "c.sock"),
        XDG_STATE_HOME: path.join(dir, "state"), XDG_CONFIG_HOME: path.join(dir, "config"),
        XDG_RUNTIME_DIR: dir,
    };
    delete env.HC_TERMINAL_ID;
    const run = (args: string[]) => {
        const result = Bun.spawnSync(["hc", ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 15_000 });
        if (result.exitCode !== 0) throw new Error(`hc ${args[0]} 失败: ${result.stderr.toString()}`);
        return JSON.parse(result.stdout.toString());
    };
    let terminalId: string | undefined;
    let isStarted = false;
    try {
        const launched = run(["run", "--bg", "--no-parent", "--no-notify", process.execPath,
            path.join(import.meta.dir, "helpers/program-status.ts")]);
        isStarted = true;
        terminalId = launched.address ?? launched.terminal?.id ?? launched.id ?? launched.terminal;
        if (typeof terminalId !== "string") throw new Error(`hc run 没有返回终端 id: ${JSON.stringify(launched)}`);
        run(["wait", terminalId, "--timeout", "5"]);
        const snapshot = run(["get", terminalId]);
        const terminal = snapshot.terminal ?? snapshot;
        expect(terminal.status).toMatchObject({ state: "blocked", kind: "question", app: "zbot", title: "中文状态测试", msg: "等待测试输入" });
        expect(terminal.records.session1).toMatchObject({ state: "done", app: "zbot" });
        expect(terminal.labels).toEqual({
            agent: "zbot",
            title: "中文状态测试",
            session: "GWKTPM37",
            tabs: "GWKTPM37,DC3RSX27",
            model: "deepseek-chat",
        });
        expect(terminal.turn).toBe(2);

        run(["send", "--force", terminalId, "ok"]);
        run(["wait", terminalId, "--timeout", "5"]);
        const exitedSnapshot = run(["get", terminalId]);
        const exitedTerminal = exitedSnapshot.terminal ?? exitedSnapshot;
        expect(exitedTerminal.labels).toEqual({});
        expect(exitedTerminal.status).toBeNull();
    } finally {
        if (terminalId) {
            run(["kill", terminalId]);
            run(["rm", terminalId]);
        }
        if (isStarted) run(["server", "stop"]);
        await fs.rm(dir, { recursive: true, force: true });
    }
}, 25_000);
