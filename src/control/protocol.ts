/**
 * 会话间控制协议：newline-delimited JSON 帧。
 *
 * 一次「发消息」只有一个信封装载全部语义（对话 / 任务交付 / 结果回传），
 * 协议层不理解"任务"，只理解「消息 + 期望结果」。
 */

import { createUlid } from "../utils/ulid.js";
import { getShanghaiISOString } from "../utils/time.js";

/** 会话间消息信封：对话、任务下发、结果都走它。 */
export interface PeerMessage {
    /** 消息 id（ULID，发送方生成），也是结果回传的关联键。 */
    id: string;
    from: string;
    to: string;
    text: string;
    /** 我在回应哪条消息：串成一条线程。 */
    replyTo?: string;
    /** 期望结果：对方本回合结束后自动回传最终输出。 */
    expectResult?: boolean;
    /** 本地一次性唤醒任务：结果回传后自动归档接收会话。 */
    closeOnResult?: boolean;
    /** 目标正忙时允许排队等待执行；缺省直接回 busy。 */
    queueIfBusy?: boolean;
    /** 排队截止时间（ISO）；到期未执行则按 expired 回传结果并出队。 */
    expiresAt?: string;
    createdAt: string;
}

/** 失败原因；只有 unreachable 属于"目标不在线"，busy 由调用方决定是否重试。 */
export type PeerErrorCode =
    | "busy"
    | "queue_full"
    | "unreachable"
    | "unknown_session"
    | "bad_request"
    | "internal";

/** 一轮 turn 的交付结果；ok=false 时 error 说明中止或异常。 */
export interface PeerResult {
    msgId: string;
    ok: boolean;
    text: string;
    stopReason: string;
    error?: string;
}

/**
 * 回合被取消的终态：用户中止（aborted）、进程中断（interrupted）、
 * 跨会话取消（cancelled）。这类回合不会再有产出，结果只能如实反映"被取消"。
 */
const CANCELLED_STOP_REASONS = new Set(["aborted", "interrupted", "cancelled"]);

/** 该终态是否表示回合被取消。结果文案与时间线标记共用，避免各写一份名单。 */
export function isCancelledStopReason(stopReason: string | undefined): boolean {
    return stopReason !== undefined && CANCELLED_STOP_REASONS.has(stopReason);
}

/** 持有者身份：由 who 握手实时返回，不落盘所以不会滞后。 */
export interface PeerOwnerInfo {
    pid: number;
    instanceId: string;
    sessionId: string;
    title?: string;
    busy: boolean;
    /** 已受理但尚未回结果的消息数。 */
    pending: number;
    /** 排队等待执行的入站消息数。 */
    queued: number;
}

type PeerAck =
    /** queued=true 表示已受理待执行；position 是队列位次（从 1 开始）。 */
    | { type: "ack"; id: string; ok: true; queued?: boolean; position?: number }
    | { type: "ack"; id: string; ok: false; error: PeerErrorCode };

/** 排队项快照（`queue_state` 应答）。 */
export interface PeerQueuedEntry {
    msgId: string;
    from: string;
    queuedAt: string;
    expiresAt?: string;
    /** 队列位次（从 1 开始）。 */
    position: number;
}

/**
 * 入站受理结果：
 * - accepted 立即执行；queued 已入队（position 从 1 起）；
 * - full 队列已满；busy 未排队且当前不能执行。
 */
export type PeerAcceptOutcome =
    | { status: "accepted" }
    | { status: "queued"; position: number }
    | { status: "full" }
    | { status: "busy" };

export type PeerReply =
    | PeerAck
    | { type: "who"; id: string; info: PeerOwnerInfo }
    | { type: "release_result"; id: string; ok: boolean; reason?: "busy" }
    | { type: "pending_state"; id: string; done: PeerResult[]; pending: string[] }
    | { type: "cancel_queued_result"; id: string; ok: boolean; reason?: "not_found" | "running" }
    | { type: "queue_state"; id: string; entries: PeerQueuedEntry[] }
    | { type: "pong"; id: string };

/** 异步推送：结果到达时随时发给发起方，没有对应的请求 id。 */
type PeerPush = { type: "result"; result: PeerResult };

export type PeerRequest =
    | { type: "deliver"; id: string; message: PeerMessage }
    | { type: "who"; id: string }
    | { type: "release"; id: string }
    | { type: "query_pending"; id: string; msgIds: string[] }
    | { type: "cancel_queued"; id: string; msgId: string }
    | { type: "queue_state"; id: string }
    | { type: "ping"; id: string };

export type PeerFrame = PeerRequest | PeerReply | PeerPush;

export interface CreatePeerMessageInput {
    /** 固定消息 id（重试同一投递时复用，服务端据此幂等）；缺省生成 ULID。 */
    id?: string;
    from: string;
    to: string;
    text: string;
    replyTo?: string;
    expectResult?: boolean;
    closeOnResult?: boolean;
    queueIfBusy?: boolean;
    expiresAt?: string;
}

/** 构造一条消息信封。 */
export function createPeerMessage(input: CreatePeerMessageInput): PeerMessage {
    return {
        id: input.id ?? createUlid(),
        from: input.from,
        to: input.to,
        text: input.text,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        ...(input.expectResult ? { expectResult: true } : {}),
        ...(input.closeOnResult ? { closeOnResult: true } : {}),
        ...(input.queueIfBusy ? { queueIfBusy: true } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        createdAt: getShanghaiISOString(),
    };
}

/** 生成请求 id（请求/应答配对用）。 */
export function createFrameId(): string {
    return createUlid();
}

export function encodeFrame(frame: PeerFrame): string {
    return `${JSON.stringify(frame)}\n`;
}

/** 解析一行；非法或未知帧返回 undefined（调用方忽略，绝不因此断连）。 */
function decodeFrame(line: string): PeerFrame | undefined {
    try {
        const parsed = JSON.parse(line) as PeerFrame;
        if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
            return undefined;
        }
        return parsed;
    } catch {
        return undefined;
    }
}

/** 按换行切分缓冲：返回完整帧与剩余未完结的尾巴。 */
export function splitFrames(buffer: string): { frames: PeerFrame[]; rest: string } {
    const frames: PeerFrame[] = [];
    let rest = buffer;

    for (;;) {
        const index = rest.indexOf("\n");
        if (index === -1) break;

        const line = rest.slice(0, index).trim();
        rest = rest.slice(index + 1);
        if (!line) continue;

        const frame = decodeFrame(line);
        if (frame) frames.push(frame);
    }

    return { frames, rest };
}
