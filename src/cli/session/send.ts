/**
 * 会话间投递：`send` 通过控制 socket 把消息交给运行中的 TUI 或后台实例，`queue` 查看排队快照。
 */

import { PeerConnectError, PeerConnection } from "../../control/client.js";
import { getSocketPath } from "../../control/paths.js";
import { createPeerMessage, type PeerResult } from "../../control/protocol.js";
import { probeOwnership } from "../../control/registry.js";
import { isSameSession, shortSessionId } from "../../utils/session-id.js";
import { SessionCliError, usageError } from "./args.js";
import type { QueueCommand, SendCommand } from "./args.js";
import type { SessionCliIO } from "./io.js";
import { waitForTurn, type TurnOutcome } from "./wait.js";
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

    const delivered = await deliverPeerText({
        sessionId,
        text,
        queue: command.queue,
        expiresSeconds: command.expiresSeconds,
        expectResult: command.wait,
    });
    const { msgId, queued, position, expiresAt, connection, resultPromise } = delivered;
    try {
        if (!command.wait) {
            if (command.json) {
                // status 只说投递事实：queued/delivered 都不是完成，别让脚本把 ack 当成结果
                write(`${JSON.stringify({
                    sessionId,
                    msgId,
                    delivered: true,
                    status: queued ? "queued" : "delivered",
                    queued,
                    ...(position !== undefined ? { position } : {}),
                    ...(queued ? { expiresAt } : {}),
                }, null, 2)}\n`);
            } else if (queued) {
                write(`已排队到 ${shortSessionId(sessionId)}（第 ${position ?? "?"} 位，${msgId}）`
                    + `，会话空闲后执行；最晚 ${formatTimestamp(expiresAt)}\n`);
            } else {
                write(`已投递到 ${shortSessionId(sessionId)}（${msgId}）\n`);
            }
            return;
        }

        // 等待结果时先把排队状态告诉人类，避免看起来一直没反应
        if (queued && !command.json) {
            write(`已排队到 ${shortSessionId(sessionId)}（第 ${position ?? "?"} 位，${msgId}），等待执行...\n`);
        }

        const outcome = await waitForAckResult({
            sessionId,
            msgId,
            resultPromise,
            queryPending: msgIds => connection.queryPending(msgIds),
            ...(command.waitSeconds !== undefined ? { timeoutMs: command.waitSeconds * 1000 } : {}),
        });
        if (outcome.status !== "succeeded") {
            // 失败也把已产出的部分输出带出来：人类模式进 stderr，--json 进 details
            // 失败时 text 可能已是错误原因本身（命令拒绝/非法参数），别把它当"部分输出"再打一遍
            const partial = outcome.content && outcome.content !== outcome.error
                ? `\n（部分输出）\n${outcome.content}`
                : "";
            // 取消是终态但没有结果：单独给 peer_cancelled，别含糊成「执行失败」
            const cancelled = outcome.status === "cancelled";
            throw new SessionCliError(
                cancelled ? "peer_cancelled" : "peer_failed",
                cancelled
                    ? `会话 ${shortSessionId(sessionId)} 的回合已取消（${outcome.stopReason}）${partial}`
                    : `${outcome.error ?? `会话 ${shortSessionId(sessionId)} 执行失败：${outcome.stopReason}`}${partial}`,
                1,
                {
                    sessionId,
                    msgId,
                    turnId: outcome.turnId,
                    status: outcome.status,
                    delivered: true,
                    stopReason: outcome.stopReason,
                    partialText: outcome.content,
                },
            );
        }
        if (command.json) {
            write(`${JSON.stringify({
                sessionId,
                msgId,
                turnId: outcome.turnId || null,
                status: outcome.status,
                ok: true,
                text: outcome.content,
                stopReason: outcome.stopReason,
                delivered: true,
                source: outcome.source,
                waitedMs: outcome.waitedMs,
                ...(queued ? { queued: true, ...(position !== undefined ? { position } : {}) } : {}),
            }, null, 2)}\n`);
            return;
        }
        // 走到这里一定是 succeeded：取消/失败上面已经按 peer_failed 抛出
        write(outcome.content ? `${outcome.content}\n` : "（对方回合没有输出）\n");
    } finally {
        connection.close();
    }
}

export interface DeliveredPeerText {
    msgId: string;
    queued: boolean;
    position?: number;
    expiresAt: string;
    /** 调用方负责 close：要等结果的路径还得用它收推送与补查。 */
    connection: PeerConnection;
    resultPromise: Promise<PeerResult>;
}

/**
 * 建控制连接并投递一条文本，返回受理凭证（不等待结果）。
 * `session send` 与 `herdr spawn` 共用；目标必须由 TUI/后台实例持有，否则 no_holder。
 */
export async function deliverPeerText(input: {
    sessionId: string;
    text: string;
    queue: boolean;
    expiresSeconds: number;
    expectResult?: boolean;
}): Promise<DeliveredPeerText> {
    const { sessionId, text } = input;
    // 会话内的 shell 会带上所属会话 id：投给自己只会把消息塞回自己的收件箱，直接拒绝
    const ownSessionId = process.env.ZBOT_SESSION_ID?.trim();
    if (ownSessionId && isSameSession(ownSessionId, sessionId)) {
        throw new SessionCliError(
            "self_target",
            `会话 ${shortSessionId(sessionId)} 就是你所在的会话，不能给自己发消息`,
            1,
            { sessionId, delivered: false },
        );
    }

    const ownership = await probeOwnership(sessionId);
    if (ownership.state === "free") {
        throw new SessionCliError(
            "no_holder",
            `会话 ${shortSessionId(sessionId)} 没有运行中的 TUI 或后台实例；CLI 不会自行启动模型。请先用 zbot resume ${sessionId} 打开 TUI。`,
            1,
            { sessionId, delivered: false },
        );
    }

    let settleResult: (result: PeerResult) => void = () => undefined;
    const resultPromise = new Promise<PeerResult>((resolve) => {
        settleResult = resolve;
    });
    const expiresAt = new Date(Date.now() + input.expiresSeconds * 1000).toISOString();
    const message = createPeerMessage({
        from: `cli-${process.pid}`,
        to: sessionId,
        text,
        ...(input.expectResult ? { expectResult: true } : {}),
        ...(input.queue ? { queueIfBusy: true } : {}),
        expiresAt,
    });
    const connection = new PeerConnection({
        socketPath: getSocketPath(sessionId),
        onResult: (result) => settleResult(result),
    });

    // 投递失败（含 ack 拒绝）就自己关连接：成功才把连接交给调用方
    let accepted = false;
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

        accepted = true;
        return {
            msgId: message.id,
            queued: reply.queued === true,
            ...(reply.position !== undefined ? { position: reply.position } : {}),
            expiresAt,
            connection,
            resultPromise,
        };
    } finally {
        if (!accepted) connection.close();
    }
}

/**
 * 等待已受理消息的终态：事件日志 + 在线结果双源，中途 Ctrl-C 只停止等待。
 * 单独包一层是为了把信号处理收在一处，且不干扰后续的 finally（连接必须关）。
 */
async function waitForAckResult(input: {
    sessionId: string;
    msgId: string;
    resultPromise: Promise<PeerResult>;
    queryPending: (msgIds: string[]) => Promise<{ done: PeerResult[]; pending: string[] }>;
    timeoutMs?: number;
}): Promise<TurnOutcome> {
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
        return await waitForTurn({
            sessionId: input.sessionId,
            selector: { kind: "msg", msgId: input.msgId },
            peer: { promise: input.resultPromise, queryPending: input.queryPending },
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
            signal: controller.signal,
        });
    } finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
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
