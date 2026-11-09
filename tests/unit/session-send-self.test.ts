/**
 * 投递给自己：会话内的 shell 带 ZBOT_SESSION_ID（execute-shell 注入），
 * `zbot session send` 一旦解析到同一个会话就直接拒绝，不投递、不排队。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runSessionCli } from "../../src/cli/session.js";
import { LocalSessionHost } from "../../src/host/session-host.js";
import { useTmpStateDir, type TmpStateDir } from "./test-env.js";

let stateDir: TmpStateDir;
let previousSessionId: string | undefined;

beforeEach(() => {
    stateDir = useTmpStateDir("zbot-session-self-");
    previousSessionId = process.env.ZBOT_SESSION_ID;
});

afterEach(() => {
    if (previousSessionId === undefined) delete process.env.ZBOT_SESSION_ID;
    else process.env.ZBOT_SESSION_ID = previousSessionId;
    stateDir.cleanup();
});

async function cli(argv: string[]): Promise<string> {
    const chunks: string[] = [];
    await runSessionCli(argv, { write: text => chunks.push(text), readStdin: async () => "" });
    return chunks.join("");
}

/** 落一个真实会话（带标题即写事件日志），返回它的 id。 */
async function savedSession(): Promise<string> {
    const host = new LocalSessionHost();
    const { sessionId } = await host.createSession();
    await host.renameSession(sessionId, "self-send");
    await host.close();
    return sessionId;
}

describe("send 目标就是自己", () => {
    test("会话内投给自己所在的会话：直接拒绝", async () => {
        const self = await savedSession();
        process.env.ZBOT_SESSION_ID = self;
        await expect(cli(["send", self, "给自己发一条", "--json"])).rejects.toMatchObject({
            code: "self_target",
        });
    }, 20_000);

    test("末几位短 id 与大小写变体同样算自己", async () => {
        const self = await savedSession();
        process.env.ZBOT_SESSION_ID = self;
        for (const alias of [self.slice(-8), self.toLowerCase()]) {
            await expect(cli(["send", alias, "给自己发一条", "--json"])).rejects.toMatchObject({
                code: "self_target",
            });
        }
    }, 20_000);

    test("不带会话上下文或指向别的会话时，按正常投递路径处理", async () => {
        const self = await savedSession();
        const other = await savedSession();
        delete process.env.ZBOT_SESSION_ID;
        await expect(cli(["send", self, "给别人", "--json"])).rejects.toMatchObject({ code: "no_holder" });

        process.env.ZBOT_SESSION_ID = other;
        await expect(cli(["send", self, "给别人", "--json"])).rejects.toMatchObject({ code: "no_holder" });
    }, 20_000);
});
