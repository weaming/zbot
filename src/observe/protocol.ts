/**
 * 观察通道协议：newline-delimited JSON 帧，只读。
 *
 * 与控制通道分开成一套帧，是因为两端语义完全不同：
 * 控制通道有投递、排队、消费与协商释放；观察通道只有「初始化查询 + 订阅推送 + 心跳」，
 * 任何写操作类帧都应被拒绝，免得观察者顺手动到会话。
 */

import type { LiveFrame } from "../events/live-stream.js";
import type { SessionEventView } from "../events/session-event-view.js";

/** 协议版本：字段只增不改；客户端握手时声明，不一致直接报错而不是猜。 */
export const OBSERVE_PROTOCOL_VERSION = 1;

/** 单次快照最多下发多少条：多的由客户端带 since 继续读，避免一次把长会话全推过去。 */
export const MAX_SNAPSHOT_EVENTS = 200;

export type ObserveErrorCode =
    /** 观察通道只读：投递、消费、改标题、释放会话都不在这里。 */
    | "forbidden"
    /** 帧不是合法 JSON 或缺 type。 */
    | "bad_request"
    /** 客户端协议版本与宿主不一致。 */
    | "unsupported_version"
    | "internal";

export type ObserveRequest =
    | { type: "hello"; id: string; version: number }
    | { type: "snapshot"; id: string; since?: number; limit?: number }
    | { type: "subscribe"; id: string; since?: number }
    | { type: "unsubscribe"; id: string }
    | { type: "ping"; id: string };

export type ObserveReply =
    | {
          type: "hello_result";
          id: string;
          ok: boolean;
          version: number;
          sessionId: string;
          title?: string;
          busy: boolean;
          lastSeq: number;
          error?: string;
      }
    /** `more=true` 表示 since 之后还有事件，客户端接着带 since=lastSeq 读。 */
    | { type: "snapshot_result"; id: string; events: SessionEventView[]; lastSeq: number; more: boolean }
    /** 订阅生效：此后先有 `events`（持久化，带 seq），再有 `live`（瞬态）。 */
    | { type: "subscribed"; id: string; lastSeq: number }
    | { type: "unsubscribed"; id: string }
    | { type: "pong"; id: string }
    | { type: "error"; id?: string; code: ObserveErrorCode; message: string };

export type ObservePush =
    /** 持久化事实，seq 严格递增；客户端按 seq 去重。 */
    | { type: "events"; events: SessionEventView[] }
    /** 瞬态信号（正在生成的正文、是否在思考、回合收尾），不带 seq，不参与游标。 */
    | { type: "live"; frame: LiveFrame }
    /** 丢过帧：客户端应从 fromSeq 之后重新 snapshot，不要拿空隙当"没发生"。 */
    | { type: "gap"; fromSeq: number; toSeq: number };

export type ObserveFrame = ObserveReply | ObservePush | { type: "bad_request"; message: string };

export function encodeObserveFrame(frame: ObserveFrame): string {
    return `${JSON.stringify(frame)}\n`;
}

/** 解析一行；非法帧返回 undefined，由调用方回 bad_request 或忽略。 */
export function decodeObserveFrame(line: string): unknown {
    const trimmed = line.trim();
    if (!trimmed) return undefined;
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!parsed || typeof parsed !== "object") return undefined;
        if (typeof (parsed as { type?: unknown }).type !== "string") return undefined;
        return parsed;
    } catch {
        return undefined;
    }
}

/** 按换行切分缓冲：返回完整帧与剩余未完结的尾巴。 */
export function splitObserveFrames(buffer: string): { frames: unknown[]; rest: string } {
    const frames: unknown[] = [];
    let rest = buffer;

    for (;;) {
        const index = rest.indexOf("\n");
        if (index === -1) break;
        const line = rest.slice(0, index);
        rest = rest.slice(index + 1);
        const frame = decodeObserveFrame(line);
        if (frame) frames.push(frame);
    }

    return { frames, rest };
}
