/**
 * 等待一个回合进入终态（succeeded / failed / cancelled），并取出它的最终结果或错误。
 *
 * 两个事实源，任一到齐即可返回：
 * 1) 事件日志（持久、可复盘）：`user_message.msgId / turn_commit.msgId` 把入站消息与回合
 *    绑在一起，`turn_commit` 就是终态；内容用 commit.events 指向的 turn_message 取最后一条
 *    assistant 文本。日志轮询是增量的（游标 + 只读持久化事件），长会话也不会每轮全量解析。
 * 2) 控制通道（在线）：PeerResult 推送给出命令类消息的结果；`query_pending` 可只读补查，
 *    覆盖半死连接与并发 polling/subscribe；重复消息由 msgId 幂等，重推的结果同样只采纳一次。
 *
 * 只有 `queued`/`delivered` 不算完成：ack 只代表受理，等不到终态就一直等（除非调用方给了
 * 超时），目标进程确定消失时才如实报「结果丢失」，避免把投递当成功。
 */

import { PeerConnection } from "../../control/client.js";
import { getSocketPath } from "../../control/paths.js";
import { isCancelledStopReason, type PeerResult } from "../../control/protocol.js";
import { probeOwnership } from "../../control/registry.js";
import type { AgentEventPayloads } from "../../events/agent-events.js";
import { isUlid, shortSessionId } from "../../utils/session-id.js";
import { SessionCliError, type WaitCommand } from "./args.js";
import { eventLog, resolveCurrentSessionId, resolveSessionId } from "./store.js";

/** 事件日志轮询间隔：足够及时，又不至于把盘 IO 打满。 */
const POLL_INTERVAL_MS = 400;
/** 归属探测间隔：比轮询慢，避免每轮都 connect 一次。 */
const PROBE_INTERVAL_MS = 1_500;
/** 在线补查间隔：事件日志覆盖不了命令类结果，靠它补。 */
const QUERY_INTERVAL_MS = 1_000;
/** 单次补查最多占用循环这么久：旧版持有者不认 keep 时不能让等待失去响应。 */
const QUERY_WAIT_MS = 1_200;
/** 连续多少次探测到「无持有者且无终态」才判定结果丢失（留出写 commit 与释放的窗口）。 */
const LOST_FREE_STREAK = 2;

/** 与 wait 相关的事件类型：轻量扫描只完整解析这几种行。 */
const WAIT_DECODE_TYPES: ReadonlySet<string> = new Set(["user_message", "turn_commit", "peer_message"]);

export type TurnSelector =
    | { kind: "msg"; msgId: string }
    | { kind: "turn"; turnId: string }
    | { kind: "latest" };

export type TurnStatus = "succeeded" | "failed" | "cancelled";

export interface TurnOutcome {
    sessionId: string;
    turnId: string;
    msgId?: string;
    status: TurnStatus;
    /** provider/orchestrator 的收尾原因（stop / aborted / error / command / expired …）。 */
    stopReason: string;
    /** 最终 assistant 文本；失败时可能是部分输出；命令类消息是命令输出。 */
    content: string;
    error?: string;
    /** 终态来自事件日志（可复盘）还是控制通道（仅在线可查）。 */
    source: "events" | "peer";
    waitedMs: number;
}

/** 在线结果源：推送 + 只读补查。命令行自己建连，或复用 send 已建好的连接。 */
export interface PeerResultSource {
    /** 结果推送；只采纳 selector 指向的那条消息。 */
    promise: Promise<PeerResult>;
    /** 只读补查（不消费对方暂存，可并发重复调用）。 */
    queryPending: (msgIds: string[]) => Promise<{ done: PeerResult[]; pending: string[] }>;
}

export interface WaitTurnOptions {
    sessionId: string;
    selector: TurnSelector;
    /** 有在线结果源时优先用（命令类消息不会落回合事件）。 */
    peer?: PeerResultSource;
    /** 等待上限（毫秒）；缺省一直等到终态。 */
    timeoutMs?: number;
    /** Ctrl-C 中断等待：只停止本进程的等待，不取消目标回合。 */
    signal?: AbortSignal;
}

/** 一个已知的回合：turnId 与首条事件 seq、终态 commit。 */
interface TurnFact {
    turnId: string;
    msgId?: string;
    commit?: AgentEventPayloads["turn_commit"];
}

/** 事件日志里的回合索引：幂等并入，重复扫描/补读不会产生重复回合。 */
class TurnIndex {
    private readonly facts = new Map<string, TurnFact>();
    private readonly order: string[] = [];
    private readonly turnByMsg = new Map<string, string>();
    /** 入站消息是否已落盘（peer_message）：区分「未投递」与「已投递但还没开始执行」。 */
    private readonly inboxMsgs = new Set<string>();

    ingest(event: { seq: number; type: string; payload?: any }): void {
        if (event.type === "peer_message") {
            if (event.payload?.direction === "in" && typeof event.payload?.msgId === "string") {
                this.inboxMsgs.add(event.payload.msgId);
            }
            return;
        }
        if (event.type === "user_message") {
            const turnId = event.payload?.turnId;
            if (typeof turnId !== "string") return;
            const fact = this.factOf(turnId);
            const msgId = event.payload?.msgId;
            if (typeof msgId === "string" && !fact.msgId) {
                fact.msgId = msgId;
                this.turnByMsg.set(msgId, turnId);
            }
            return;
        }
        if (event.type === "turn_commit") {
            const turnId = event.payload?.turnId;
            if (typeof turnId !== "string") return;
            const fact = this.factOf(turnId);
            // 同一 turnId 多次 commit（续跑/热修复）以最后一条为准，与重放口径一致
            fact.commit = event.payload;
            if (typeof event.payload?.msgId === "string") this.turnByMsg.set(event.payload.msgId, turnId);
        }
    }

    select(selector: TurnSelector): TurnFact | undefined {
        if (selector.kind === "msg") {
            const turnId = this.turnByMsg.get(selector.msgId);
            return turnId ? this.facts.get(turnId) : undefined;
        }
        if (selector.kind === "turn") return this.facts.get(selector.turnId);
        const latest = this.order.at(-1);
        return latest ? this.facts.get(latest) : undefined;
    }

    hasInbound(msgId: string): boolean {
        return this.inboxMsgs.has(msgId);
    }

    get turnCount(): number {
        return this.order.length;
    }

    private factOf(turnId: string): TurnFact {
        const existing = this.facts.get(turnId);
        if (existing) return existing;
        const created: TurnFact = { turnId };
        this.facts.set(turnId, created);
        this.order.push(turnId);
        return created;
    }
}

/**
 * 等一个回合进入终态。
 *
 * 调用方负责输出与退出码；这里只返回事实或抛 SessionCliError：
 * - `interrupted`（130）：Ctrl-C 停止等待，目标回合不受影响；
 * - `wait_timeout`（2）：显式超时，消息已投递，不要重发；
 * - `wait_lost`（1）：目标已释放/进程消失且没有终态记录；
 * - `not_found`（1）：目标在线且完全空闲，但该消息既不在途也没有回合。
 */
export async function waitForTurn(options: WaitTurnOptions): Promise<TurnOutcome> {
    const { sessionId, selector, peer, timeoutMs, signal } = options;
    const startedAt = Date.now();
    const deadline = timeoutMs === undefined ? undefined : startedAt + timeoutMs;

    // 先取游标再全量扫描：扫描与取游标之间追加的事件会被增量补读重复看到（索引幂等）
    let cursor = (await eventLog.lastSeq(sessionId, { forceRefresh: true })) + 1;
    const index = new TurnIndex();
    for (const record of await scanTurns(sessionId)) index.ingest(record);

    let peerOutcome: TurnOutcome | undefined;
    const wake = new Wake();
    if (peer) {
        peer.promise.then((result) => {
            // 只采纳目标消息的结果：同一连接上可能混入别的回传
            if (selector.kind === "msg" && result.msgId !== selector.msgId) return;
            peerOutcome = outcomeFromPeer(result, sessionId, "", Date.now() - startedAt);
            wake.wake();
        }).catch(() => undefined);
    }

    // 「等最近一轮」而会话还没有任何回合：只有正在跑（busy/在途）才值得等
    if (selector.kind === "latest" && index.turnCount === 0
        && !await hasInFlight(sessionId)) {
        throw new SessionCliError(
            "no_turn",
            `会话 ${shortSessionId(sessionId)} 还没有回合可等：先发一条消息，或确认 id 是否写错`,
            1,
            { sessionId },
        );
    }

    let freeStreak = 0;
    let idleStreak = 0;
    let lastProbeAt = 0;
    let lastQueryAt = 0;
    /** 同时只允许一个补查在飞：避免旧持有者不响应时请求越堆越多。 */
    let queryInFlight: Promise<PeerResult | undefined> | undefined;

    for (;;) {
        if (signal?.aborted) throw interruptedError(sessionId, selector);
        if (deadline !== undefined && Date.now() >= deadline) throw timeoutError(sessionId, selector, timeoutMs!);

        const settled = index.select(selector);
        if (settled?.commit) return await outcomeFromCommit(sessionId, settled, startedAt);
        if (peerOutcome) return peerOutcome;

        const appended = await eventLog.read(sessionId, cursor, undefined, { persistedOnly: true });
        if (appended.length > 0) {
            for (const event of appended) index.ingest(event);
            cursor = appended[appended.length - 1]!.seq + 1;
            continue; // 有新事件：立刻重判，不睡
        }

        const now = Date.now();
        if (peer && selector.kind === "msg" && now - lastQueryAt >= QUERY_INTERVAL_MS) {
            lastQueryAt = now;
            if (!queryInFlight) {
                queryInFlight = safeQuery(peer, selector.msgId)
                    .finally(() => { queryInFlight = undefined; });
            }
            // 只在循环里等一小段：补查慢（对方不认这个请求）也不能拖住事件日志轮询与超时判定
            const done = await withLimit(queryInFlight, QUERY_WAIT_MS);
            if (done) return outcomeFromPeer(done, sessionId, "", Date.now() - startedAt);
        }

        // 补查可能占用一段时间：探测节流按实际时刻算，别用补查前的旧时间
        const probeNow = Date.now();
        if (probeNow - lastProbeAt >= PROBE_INTERVAL_MS) {
            lastProbeAt = probeNow;
            const ownership = await probeOwnership(sessionId);
            if (ownership.state === "free") {
                // 释放与落 commit 之间存在窗口：判定丢失前再读一次日志
                const tail = await eventLog.read(sessionId, cursor, undefined, { persistedOnly: true });
                if (tail.length > 0) {
                    for (const event of tail) index.ingest(event);
                    cursor = tail[tail.length - 1]!.seq + 1;
                    continue;
                }
                freeStreak += 1;
                if (freeStreak >= LOST_FREE_STREAK) throw lostError(sessionId, selector, index);
                idleStreak = 0;
            } else {
                freeStreak = 0;
                // 持有者在线却完全空闲、日志里也没有这条消息：msgId 写错或早已被清理
                const info = ownership.state === "other" ? ownership.info : undefined;
                const inFlight = (info?.pending ?? 0) > 0 || (info?.queued ?? 0) > 0 || info?.busy === true;
                if (info && !inFlight && isUnresolvable(selector, index)) {
                    idleStreak += 1;
                    if (idleStreak >= LOST_FREE_STREAK) {
                        // 已投递却没有回合：只可能是命令类消息，结果只在持有者内存里
                        if (selector.kind === "msg" && index.hasInbound(selector.msgId)) {
                            throw new SessionCliError(
                                "wait_lost",
                                `消息 ${selector.msgId} 已投递，但事件日志里没有可回溯的回合终态`
                                + "（命令类消息只在线回传，或投递时没带 --wait）；可 `zbot session show` 复盘现场",
                                1,
                                { sessionId, msgId: selector.msgId, delivered: true, lost: true },
                            );
                        }
                        throw notFoundError(sessionId, selector);
                    }
                } else {
                    idleStreak = 0;
                }
            }
        }

        await sleep(POLL_INTERVAL_MS, signal, wake);
    }
}

/** 轻量全量扫描；行首形状不认识时退化为全量读取，宁可慢也不给错事实。 */
async function scanTurns(sessionId: string): Promise<Array<{ seq: number; type: string; payload?: any }>> {
    const scanned = await eventLog.scan(sessionId, WAIT_DECODE_TYPES);
    if (scanned) return scanned;
    return await eventLog.read(sessionId, 1, undefined, { persistedOnly: true });
}

/** 只读补查：连接问题只代表「这次没问到」，由归属探测决定是否判丢失。 */
async function safeQuery(peer: PeerResultSource, msgId: string): Promise<PeerResult | undefined> {
    try {
        const reply = await peer.queryPending([msgId]);
        return reply.done.find(result => result.msgId === msgId);
    } catch {
        return undefined;
    }
}

/** 事件终态 → 统一结果；内容取自 commit.events 指向的 turn_message（最后一条 assistant）。 */
async function outcomeFromCommit(sessionId: string, fact: TurnFact, startedAt: number): Promise<TurnOutcome> {
    const commit = fact.commit!;
    const stopReason = commit.stopReason || "stop";
    const status: TurnStatus = commit.interrupted || isCancelledStopReason(stopReason)
        ? "cancelled"
        : (stopReason === "error" || commit.error ? "failed" : "succeeded");
    return {
        sessionId,
        turnId: fact.turnId,
        ...(fact.msgId ? { msgId: fact.msgId } : {}),
        status,
        stopReason,
        content: await readTurnContent(sessionId, commit),
        ...(commit.error ? { error: commit.error } : {}),
        source: "events",
        waitedMs: Date.now() - startedAt,
    };
}

/** 从回合事件里取最终 assistant 文本：只读 commit 指向的区间，不重放整份日志。 */
async function readTurnContent(
    sessionId: string,
    commit: AgentEventPayloads["turn_commit"],
): Promise<string> {
    const seqs = (commit.events ?? []).filter(seq => Number.isSafeInteger(seq));
    if (seqs.length === 0) return "";
    const from = Math.min(...seqs);
    const to = Math.max(...seqs);
    const events = await eventLog.read(sessionId, from, to - from + 1, { persistedOnly: true });
    let content = "";
    for (const event of events) {
        if (event.type !== "turn_message") continue;
        if (event.payload.turnId !== commit.turnId) continue;
        const { message } = event.payload;
        if (message.role !== "assistant") continue;
        if (typeof message.content === "string" && message.content.trim()) content = message.content;
    }
    return content;
}

/**
 * 通道结果 → 统一结果。失败时 text 可能是部分输出，也可能是错误原因本身。
 *
 * 取消必须以 stopReason 为准：双方回合被中止时 PeerResult 仍是 ok=true（失败原因为空），
 * 只看 ok 会把「已取消」误报成成功，且与事件日志给出的终态互相矛盾。
 */
function outcomeFromPeer(
    result: PeerResult,
    sessionId: string,
    turnId: string,
    waitedMs: number,
): TurnOutcome {
    const stopReason = result.stopReason || (result.ok ? "stop" : "error");
    const cancelled = isCancelledStopReason(stopReason);
    const status: TurnStatus = cancelled ? "cancelled" : result.ok ? "succeeded" : "failed";
    const isErrorText = !result.ok && !!result.error && result.text === result.error;
    return {
        sessionId,
        turnId,
        msgId: result.msgId,
        status,
        stopReason,
        content: isErrorText ? "" : result.text,
        ...(cancelled || result.ok
            ? {}
            : { error: result.error ?? (result.text || `回合失败：${stopReason}`) }),
        source: "peer",
        waitedMs,
    };
}

function interruptedError(sessionId: string, selector: TurnSelector): SessionCliError {
    const hint = resumeHint(sessionId, selector);
    return new SessionCliError(
        "interrupted",
        `已停止等待（目标会话继续执行，未取消）${hint ? `；稍后可 ${hint}` : ""}`,
        130,
        { sessionId, ...selectorDetails(selector), delivered: true, cancelled: false, interrupted: true },
    );
}

function timeoutError(sessionId: string, selector: TurnSelector, timeoutMs: number): SessionCliError {
    const hint = resumeHint(sessionId, selector);
    return new SessionCliError(
        "wait_timeout",
        `等待会话 ${shortSessionId(sessionId)} 的结果超时（${Math.round(timeoutMs / 1000)}s）；`
        + "消息已投递，不要重复发送"
        + (hint ? `；可 ${hint} 继续等` : ""),
        2,
        { sessionId, ...selectorDetails(selector), delivered: true },
    );
}

function lostError(sessionId: string, selector: TurnSelector, index: TurnIndex): SessionCliError {
    const reason = selector.kind === "msg" && !index.hasInbound(selector.msgId)
        ? "会话已无持有者，事件日志里也没有这条消息的投递记录（可能没投递成功，或已在别的实例里清理）"
        : index.turnCount === 0
            ? "会话已无持有者，事件日志里也没有终态记录"
            : "目标会话已释放（进程退出或 /close），该回合没有落终态";
    return new SessionCliError(
        "wait_lost",
        `${reason}：结果不会再来了。可用 \`zbot session show ${shortSessionId(sessionId)}\` 复盘现场`,
        1,
        { sessionId, ...selectorDetails(selector), delivered: true, lost: true },
    );
}

function notFoundError(sessionId: string, selector: TurnSelector): SessionCliError {
    const target = selector.kind === "msg"
        ? `msgId ${selector.msgId}`
        : selector.kind === "turn" ? `turnId ${selector.turnId}` : "最近一轮";
    return new SessionCliError(
        "not_found",
        `会话 ${shortSessionId(sessionId)} 在线且空闲，但没有与 ${target} 对应的消息或回合；`
        + "确认 id 是否写错（`session send --json` 会输出 msgId，`session show --json` 有 turnId）",
        1,
        { sessionId, ...selectorDetails(selector) },
    );
}

/** 选择器在索引里还找不到对应回合：持有者在线且空闲时说明它根本不存在。 */
function isUnresolvable(selector: TurnSelector, index: TurnIndex): boolean {
    if (selector.kind === "latest") return index.turnCount === 0;
    return index.select(selector) === undefined;
}

/** 有没有正在执行的迹象（busy / 在途投递 / 排队）：决定「还没有回合」要不要继续等。 */
async function hasInFlight(sessionId: string): Promise<boolean> {
    const ownership = await probeOwnership(sessionId);
    if (ownership.state === "free") return false;
    const info = ownership.state === "other" ? ownership.info : undefined;
    return (info?.pending ?? 0) > 0 || (info?.queued ?? 0) > 0 || info?.busy === true;
}

function resumeHint(sessionId: string, selector: TurnSelector): string | undefined {
    const id = shortSessionId(sessionId);
    if (selector.kind === "msg") return `zbot session wait ${id} --msg=${selector.msgId}`;
    if (selector.kind === "turn") return `zbot session wait ${id} --turn=${selector.turnId}`;
    return `zbot session wait ${id}`;
}

function selectorDetails(selector: TurnSelector): Record<string, unknown> {
    if (selector.kind === "msg") return { msgId: selector.msgId };
    if (selector.kind === "turn") return { turnId: selector.turnId };
    return {};
}

/**
 * 结果推送唤醒器：醒一次即永久生效，但等待方可以反复登记/注销，
 * 不会像 `pendingPromise.then()` 那样在无限等待里按轮询次数累积闭包。
 */
class Wake {
    private readonly waiters = new Set<() => void>();
    private woken = false;

    /** 登记唤醒回调；返回注销函数。已经唤醒时同步回调一次。 */
    onWake(callback: () => void): () => void {
        if (this.woken) {
            callback();
            return () => undefined;
        }
        this.waiters.add(callback);
        return () => { this.waiters.delete(callback); };
    }

    wake(): void {
        if (this.woken) return;
        this.woken = true;
        const waiters = [...this.waiters];
        this.waiters.clear();
        for (const waiter of waiters) waiter();
    }
}

/** 给「结果可有可无」的动作设上限：到点返回 undefined，并清掉定时器。 */
async function withLimit<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<undefined>((resolve) => {
                timer = setTimeout(() => resolve(undefined), ms);
                timer.unref?.();
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** 可被 AbortSignal 或结果推送提前唤醒的 sleep。 */
function sleep(ms: number, signal?: AbortSignal, wake?: Wake): Promise<void> {
    return new Promise<void>((resolve) => {
        let done = false;
        let offWake: (() => void) | undefined;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", finish);
            offWake?.();
            resolve();
        };
        const timer = setTimeout(finish, ms);
        signal?.addEventListener("abort", finish, { once: true });
        offWake = wake?.onWake(finish);
        // 已唤醒时 onWake 会同步回调：这里只需把可能多登记的注销掉
        if (done) offWake?.();
    });
}

// ── 命令行入口（输出、Ctrl-C 与在线通道装配） ─────────────────

/**
 * `zbot session wait`：等到目标回合进入终态，打印最终结果或错误。
 *
 * 退出码：0 成功；1 失败/取消（终态事实仍打印）；2 超时；130 Ctrl-C 中断等待。
 * 中断只停止本进程的等待，**不取消**目标回合；之后可用同一条命令继续等。
 */
export async function runWait(command: WaitCommand, write: (text: string) => void): Promise<void> {
    const sessionId = await resolveWaitTarget(command.id);
    const selector: TurnSelector = command.msgId
        ? { kind: "msg", msgId: command.msgId }
        : command.turnId
            ? { kind: "turn", turnId: command.turnId }
            : { kind: "latest" };

    const peer = selector.kind === "msg" ? await openPeerSource(sessionId) : undefined;
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    let outcome: TurnOutcome;
    try {
        outcome = await waitForTurn({
            sessionId,
            selector,
            ...(peer ? { peer: peer.source } : {}),
            ...(command.timeoutSeconds !== undefined ? { timeoutMs: command.timeoutSeconds * 1000 } : {}),
            signal: controller.signal,
        });
    } finally {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", interrupt);
        peer?.close();
    }

    const ok = outcome.status === "succeeded";
    if (command.json) {
        write(`${JSON.stringify({
            sessionId,
            msgId: outcome.msgId ?? null,
            turnId: outcome.turnId || null,
            status: outcome.status,
            ok,
            content: outcome.content,
            stopReason: outcome.stopReason,
            error: outcome.error ?? null,
            source: outcome.source,
            waitedMs: outcome.waitedMs,
        }, null, 2)}\n`);
    } else if (ok) {
        write(outcome.content ? `${outcome.content}\n` : "（回合完成，没有输出）\n");
    } else {
        const lines = [`回合${outcome.status === "cancelled" ? "已取消" : "失败"}（${outcome.stopReason}）`];
        if (outcome.turnId) lines.push(`turnId: ${outcome.turnId}`);
        if (outcome.error) lines.push(outcome.error);
        if (outcome.content) lines.push("（部分输出）", outcome.content);
        process.stderr.write(`${lines.join("\n")}\n`);
    }
    if (!ok) process.exitCode = 1;
}

/**
 * wait 的目标解析：已落盘的 id 严格解析（写错的 ULID 要立刻报 not_found，而不是等 3s 报丢失）；
 * 只有「刚派生、还没落盘」的会话例外——这时必须有人持有它才值得等。
 */
async function resolveWaitTarget(input: string | undefined): Promise<string> {
    if (!input) return resolveCurrentSessionId();
    try {
        return await resolveSessionId(input);
    } catch (error) {
        const trimmed = input.trim();
        if (error instanceof SessionCliError && error.code === "not_found" && isUlid(trimmed)) {
            const ownership = await probeOwnership(trimmed);
            if (ownership.state !== "free") return trimmed;
        }
        throw error;
    }
}

/**
 * 为目标会话建一条只读控制连接（用来补查结果）。
 * 目标无人持有时返回 undefined：那时只有事件日志这一条路。
 */
async function openPeerSource(
    sessionId: string,
): Promise<{ source: PeerResultSource; close: () => void } | undefined> {
    const ownership = await probeOwnership(sessionId);
    if (ownership.state === "free") return undefined;

    const deferred = createDeferredResult();
    const connection = new PeerConnection({
        socketPath: getSocketPath(sessionId),
        onResult: result => deferred.settle(result),
    });
    return {
        source: { promise: deferred.promise, queryPending: msgIds => connection.queryPending(msgIds) },
        close: () => connection.close(),
    };
}

function createDeferredResult(): { promise: Promise<PeerResult>; settle: (result: PeerResult) => void } {
    let settle!: (result: PeerResult) => void;
    const promise = new Promise<PeerResult>((resolve) => {
        settle = resolve;
    });
    return { promise, settle };
}
