/**
 * 会话间投递：`send` 通过控制 socket 把消息交给运行中的实例，`queue` 查看排队快照。
 * 没有实例持有时交给一次性宿主本地接管（见 one-shot.ts）。
 */

import { PeerConnectError, PeerConnection } from "../../control/client.js";
import { getSocketPath } from "../../control/paths.js";
import { createPeerMessage, isCancelledStopReason, type PeerResult } from "../../control/protocol.js";
import { probeOwnership } from "../../control/registry.js";
import { shortSessionId } from "../../utils/session-id.js";
import { SessionCliError, usageError } from "./args.js";
import type { QueueCommand, SendCommand } from "./args.js";
import type { SessionCliIO } from "./io.js";
import { runSendLocally } from "./one-shot.js";
import { resolveSendTarget } from "./store.js";
import { formatTimestamp } from "./view.js";

export async function runSend(
    command: SendCommand,
    write: (text: string) => void,
    readStdinText: () => Promise<string>,
    io: SessionCliIO = {},
): Promise<void> {
    const sessionId = await resolveSendTarget(command.id);
    if (command.cancelMsgId) return cancelQueuedSend(sessionId, command, write);

    const text = command.text || (await readStdinText()).trim();
    if (!text) throw usageError("send 需要消息正文");

    const ownership = await probeOwnership(sessionId);
    if (ownership.state === "free") {
        // 没有实例持有：由本进程临时接管执行一条（命令直接跑，普通文本跑一轮），
        // 否则归档后的 /unarchive 这类命令永远没有可达路径。
        return runSendLocally(command, sessionId, text, write, io);
    }

    let settleResult: (result: PeerResult) => void = () => undefined;
    const resultPromise = new Promise<PeerResult>((resolve) => {
        settleResult = resolve;
    });
    const message = createPeerMessage({
        from: `cli-${process.pid}`,
        to: sessionId,
        text,
        ...(command.waitSeconds === undefined ? {} : { expectResult: true }),
        ...(command.queue ? { queueIfBusy: true } : {}),
        expiresAt: new Date(Date.now() + command.expiresSeconds * 1000).toISOString(),
    });
    const connection = new PeerConnection({
        socketPath: getSocketPath(sessionId),
        onResult: (result) => settleResult(result),
    });

    try {
        const reply = await connection.deliver(message);
        if (reply.type !== "ack") {
            throw new SessionCliError(
                "bad_reply",
                `会话 ${shortSessionId(sessionId)} 返回了非预期应答`,
                1,
                { sessionId, delivered: false },
            );
        }
        if (!reply.ok) {
            throw new SessionCliError(reply.error, describeAckError(sessionId, reply.error), 1, {
                sessionId,
                delivered: false,
            });
        }

        const queued = reply.queued === true;
        const position = reply.position;
        if (command.waitSeconds === undefined) {
            if (command.json) {
                write(`${JSON.stringify({
                    sessionId,
                    msgId: message.id,
                    delivered: true,
                    queued,
                    ...(position !== undefined ? { position } : {}),
                    ...(queued ? { expiresAt: message.expiresAt } : {}),
                }, null, 2)}\n`);
            } else if (queued) {
                write(`已排队到 ${shortSessionId(sessionId)}（第 ${position ?? "?"} 位，${message.id}）`
                    + `，会话空闲后执行；最晚 ${formatTimestamp(message.expiresAt)}\n`);
            } else {
                write(`已投递到 ${shortSessionId(sessionId)}（${message.id}）\n`);
            }
            return;
        }

        // 等待结果时先把排队状态告诉人类，避免看起来一直没反应
        if (queued && !command.json) {
            write(`已排队到 ${shortSessionId(sessionId)}（第 ${position ?? "?"} 位，${message.id}），等待执行...\n`);
        }

        const result = await withTimeout(resultPromise, command.waitSeconds * 1000, sessionId, message.id);
        if (!result.ok) {
            // 失败也把已产出的部分输出带出来：人类模式进 stderr，--json 进 details
            // 失败时 text 可能已是错误原因本身（命令拒绝/非法参数），别把它当"部分输出"再打一遍
            const partial = result.text && result.text !== result.error
                ? `\n（部分输出）\n${result.text}`
                : "";
            throw new SessionCliError(
                "peer_failed",
                `${result.error ?? `会话 ${shortSessionId(sessionId)} 执行失败：${result.stopReason}`}${partial}`,
                1,
                { sessionId, msgId: message.id, delivered: true, stopReason: result.stopReason, partialText: result.text },
            );
        }
        if (command.json) {
            write(`${JSON.stringify({
                sessionId,
                ...result,
                delivered: true,
                ...(queued ? { queued: true, ...(position !== undefined ? { position } : {}) } : {}),
            }, null, 2)}\n`);
            return;
        }
        // 被取消的回合没有产出：如实说"已取消"，不要含糊成"没有输出"
        const emptyText = isCancelledStopReason(result.stopReason)
            ? "（对方回合已取消，没有输出）\n"
            : "（对方回合没有输出）\n";
        write(result.text ? `${result.text}\n` : emptyText);
    } finally {
        connection.close();
    }
}

// ── 会话数据读取 ─────────────────────────────────────────────


/** 撤销排队中的消息：只对仍在队列里的生效，已开始执行返回失败。 */
async function cancelQueuedSend(
    sessionId: string,
    command: SendCommand,
    write: (text: string) => void,
): Promise<void> {
    const msgId = command.cancelMsgId!;
    const ownership = await probeOwnership(sessionId);
    if (ownership.state === "free") {
        throw new SessionCliError(
            "no_holder",
            `会话 ${shortSessionId(sessionId)} 没有运行中的实例持有，无法撤销排队消息`,
            1,
            { sessionId, msgId, cancelled: false },
        );
    }

    const connection = new PeerConnection({
        socketPath: getSocketPath(sessionId),
        onResult: () => undefined,
    });
    try {
        const reply = await connection.cancelQueued(msgId);
        if (reply.type !== "cancel_queued_result") {
            throw new SessionCliError("bad_reply", `会话 ${shortSessionId(sessionId)} 返回了非预期应答`, 1, {
                sessionId,
                msgId,
            });
        }
        if (!reply.ok) {
            if (reply.reason === "running") {
                throw new SessionCliError("send_running", "消息已开始执行，无法撤销", 1, {
                    sessionId,
                    msgId,
                    cancelled: false,
                });
            }
            throw new SessionCliError("not_found", "排队消息不存在或已执行", 1, {
                sessionId,
                msgId,
                cancelled: false,
            });
        }

        if (command.json) write(`${JSON.stringify({ sessionId, msgId, cancelled: true }, null, 2)}\n`);
        else write(`已撤销排队消息 ${msgId}\n`);
    } catch (error) {
        // 旧版本持有者会忽略新帧，只能给结构化不可达错误，不能裸抛连接异常
        if (error instanceof PeerConnectError) {
            throw new SessionCliError(
                "unreachable",
                `会话 ${shortSessionId(sessionId)} 不可达或不支持排队撤销（进程可能刚退出）`,
                1,
                { sessionId, msgId, cancelled: false },
            );
        }
        throw error;
    } finally {
        connection.close();
    }
}

/** 查看持有者的排队快照；没有持有者时返回空队列而不是报错。 */
export async function runQueue(command: QueueCommand, write: (text: string) => void): Promise<void> {
    const sessionId = await resolveSendTarget(command.id);
    const ownership = await probeOwnership(sessionId);
    if (ownership.state === "free") {
        if (command.json) write(`${JSON.stringify({ sessionId, holding: false, entries: [] }, null, 2)}\n`);
        else write(`会话 ${shortSessionId(sessionId)} 当前没有实例持有（队列为空）\n`);
        return;
    }

    const connection = new PeerConnection({
        socketPath: getSocketPath(sessionId),
        onResult: () => undefined,
    });
    try {
        const reply = await connection.queueState();
        if (reply.type !== "queue_state") {
            throw new SessionCliError("bad_reply", `会话 ${shortSessionId(sessionId)} 返回了非预期应答`, 1, {
                sessionId,
            });
        }
        if (command.json) {
            write(`${JSON.stringify({ sessionId, holding: true, entries: reply.entries }, null, 2)}\n`);
            return;
        }
        if (reply.entries.length === 0) {
            write("（队列为空）\n");
            return;
        }
        const lines = reply.entries.map(entry =>
            `#${entry.position} ${entry.msgId} from=${entry.from} 入队 ${formatTimestamp(entry.queuedAt)}`
            + `${entry.expiresAt ? ` 最晚 ${formatTimestamp(entry.expiresAt)}` : ""}`);
        write(`${lines.join("\n")}\n`);
    } catch (error) {
        if (error instanceof PeerConnectError) {
            throw new SessionCliError(
                "unreachable",
                `会话 ${shortSessionId(sessionId)} 不可达或不支持排队查询（进程可能刚退出）`,
                1,
                { sessionId },
            );
        }
        throw error;
    } finally {
        connection.close();
    }
}

function describeAckError(sessionId: string, code: string): string {
    switch (code) {
        case "busy":
            return `会话 ${shortSessionId(sessionId)} 正在执行中，请稍后重试`;
        case "queue_full":
            return `会话 ${shortSessionId(sessionId)} 的排队已满（最多 8 条），请稍后重试`;
        case "unreachable":
            return `会话 ${shortSessionId(sessionId)} 不可达（进程可能刚退出）`;
        default:
            return `会话 ${shortSessionId(sessionId)} 拒绝了消息（${code}）`;
    }
}


function withTimeout(
    promise: Promise<PeerResult>,
    timeoutMs: number,
    sessionId: string,
    msgId: string,
): Promise<PeerResult> {
    return new Promise<PeerResult>((resolve, reject) => {
        const timer = setTimeout(() => {
            // 超时≠失败投递：消息已进对方回合，重发会在目标会话里多压一轮
            reject(new SessionCliError(
                "wait_timeout",
                `等待会话 ${shortSessionId(sessionId)} 的结果超时（${Math.round(timeoutMs / 1000)}s）；`
                + `消息已投递（msgId=${msgId}），不要重复发送`,
                2,
                { sessionId, msgId, delivered: true },
            ));
        }, timeoutMs);
        timer.unref?.();
        promise.then(
            (result) => {
                clearTimeout(timer);
                resolve(result);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}
