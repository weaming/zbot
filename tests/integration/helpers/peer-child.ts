/**
 * 跨进程会话间通信的子进程夹具：认领一个会话，收到消息即模拟回合结束并回传结果。
 * 由 tests/integration/control-cross-process.test.ts 通过 Bun.spawn 启动，
 * 用 stdin 收指令、用 stdout 的 JSON 行回事件（父进程据此同步状态）。
 */

import { SessionControl } from "../../../src/control/channel.js";
import type { PeerMessage } from "../../../src/control/protocol.js";

const sessionId = process.env.PEER_CHILD_SESSION ?? "";
const busy = process.env.PEER_CHILD_BUSY === "1";
const title = process.env.PEER_CHILD_TITLE ?? "child";
/** 模拟回合耗时：结果在这之后回传，父进程据此观察「等待结果」窗口。 */
const turnMs = Number(process.env.PEER_CHILD_TURN_MS ?? "20");

if (!sessionId) throw new Error("PEER_CHILD_SESSION 必填");

function emit(event: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify(event)}\n`);
}

const control = new SessionControl({
    title: () => title,
    isBusy: () => busy,
    accept: (message: PeerMessage) => {
        emit({ event: "inbound", msgId: message.id, text: message.text, expectResult: message.expectResult === true });
        if (message.expectResult) {
            setTimeout(() => {
                control.completeInbound(sessionId, message, {
                    msgId: message.id,
                    ok: true,
                    text: `已处理:${message.text}`,
                    stopReason: "stop",
                });
            }, turnMs);
        }
        return { status: "accepted" as const };
    },
    onOutbound: () => {},
    onResult: () => {},
    onLost: () => {},
    onReleased: () => emit({ event: "released" }),
});

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line) continue;
        void handle(line);
    }
});

async function handle(line: string): Promise<void> {
    if (line === "claim") {
        emit({ event: "claim", result: await control.claim(sessionId) });
        return;
    }
    if (line === "release") {
        control.release(sessionId);
        emit({ event: "release" });
        return;
    }
    if (line === "close") {
        control.close();
        emit({ event: "closed" });
        process.exit(0);
    }
    emit({ event: "unknown", line });
}

emit({ event: "ready", pid: process.pid });
