/**
 * Job 调度器：单进程内守护队列，按并发上限与「同 workspace 串行」规则领活执行。
 *
 * 职责边界：本类只管领活、限流、租约、超时与状态落库；
 * turn 怎么跑仍由 SessionHost 决定。崩溃恢复靠租约——进程没了租约就过期，
 * 过期即判 lost（此时副作用未知，绝不自动重试）。
 */

import { Cause, Data, Duration, Effect, Exit, Fiber } from "effect";
import type { SessionLifecycle, SessionTurnHost } from "../host/session-host-types.js";
import { withJobContext } from "../tools/job-context.js";
import { defaultMcpSelection } from "../mcp/client-manager.js";
import { JobStore } from "./store.js";
import {
    DEFAULT_LEASE_MS,
    DEFAULT_TIMEOUT_SEC,
    isTerminalState,
    type JobRecord,
} from "./types.js";

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_TICK_MS = 500;
/** 停止时等待回合收尾的上限：超过就放弃，交给进程退出兜底（不能卡死停机）。 */
const STOP_WAIT_MS = 5_000;
/** 会话标题取任务文本开头：列表里够认出来即可。 */
const TITLE_MAX = 40;
/** 续租频率 = 租约 / 3：连续三次失败才真的过期。 */
const LEASE_RENEW_DIVISOR = 3;

/**
 * 调度器需要的宿主能力：新建/认领/命名会话 + 驱动与中止回合。
 * 不依赖事件流与查询面，替身不必实现整个 `SessionHost`。
 */
export type JobRunnerHost = Pick<
    SessionLifecycle,
    "createSession" | "claimSession" | "renameSession"
> & Pick<SessionTurnHost, "sendMessage" | "abortSession">;

interface RunningJob {
    jobId: string;
    workspace: string;
    sessionId?: string;
    abort: () => void;
    /** 执行 fiber：停机时按它结构化等待收尾，不靠轮询。 */
    fiber?: Fiber.Fiber<void>;
}

/** 回合失败的载体：错误通道需要具名错误，取值时再还原成原始异常。 */
class TurnFailure extends Data.TaggedError("TurnFailure")<{ readonly cause: unknown }> {}

/** 每隔 intervalMs 跑一次（首次也等一个间隔，与 setInterval 一致）；fiber 被中断即停。 */
function repeatEvery(intervalMs: number, action: Effect.Effect<void>): Effect.Effect<never> {
    return Effect.forever(Effect.sleep(Duration.millis(intervalMs)).pipe(Effect.andThen(action)));
}

export interface JobRunnerOptions {
    store: JobStore;
    host: JobRunnerHost;
    /** 租约持有者标识（进程实例 id），用于区分不同 worker。 */
    owner: string;
    /**
     * 取走「下次请求附带」的用户输入（web 端在回合中输入的内容）。
     * 不注入时行为不变：只有任务本身的 prompt 进上下文。
     */
    consumePendingInputs?: (sessionId: string) => string[] | undefined;
    maxConcurrent?: number;
    leaseMs?: number;
    tickMs?: number;
    /** 缺省回合超时（秒）。 */
    defaultTimeoutSec?: number;
}

export interface RunnerStats {
    queued: number;
    running: number;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function titleOf(prompt: string): string {
    const flat = prompt.replace(/\s+/g, " ").trim();
    return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}

export class JobRunner {
    private readonly store: JobStore;
    private readonly host: JobRunnerHost;
    private readonly owner: string;
    private readonly maxConcurrent: number;
    private readonly leaseMs: number;
    private readonly tickMs: number;
    private readonly defaultTimeoutSec: number;
    private readonly consumePendingInputs?: (sessionId: string) => string[] | undefined;
    private readonly running = new Map<string, RunningJob>();
    private tickFiber?: Fiber.Fiber<void>;
    private ticking = false;
    private stopping = false;

    constructor(options: JobRunnerOptions) {
        this.store = options.store;
        this.host = options.host;
        this.owner = options.owner;
        this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
        this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
        this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
        this.defaultTimeoutSec = options.defaultTimeoutSec ?? DEFAULT_TIMEOUT_SEC;
        this.consumePendingInputs = options.consumePendingInputs;
    }

    start(): void {
        if (this.tickFiber) return;
        // 启动即清理上一进程留下的过期租约：那些 turn 的副作用未知，只能标 lost
        const expired = this.store.expireLeases();
        if (expired.length > 0) {
            console.warn(`[jobs] 上次退出遗留 ${expired.length} 个任务，已标记 lost`);
        }
        this.tickFiber = Effect.runFork(repeatEvery(this.tickMs, Effect.promise(() => this.tickSafely())));
    }

    /** 停止调度并中止在跑的回合；返回时 running 已清空。 */
    async stop(): Promise<void> {
        this.stopping = true;
        if (this.tickFiber) {
            const fiber = this.tickFiber;
            this.tickFiber = undefined;
            await Effect.runPromise(Fiber.interrupt(fiber));
        }
        // 中止的是「宿主的回合」，不是自己的 AbortSignal —— 后者没有任何调用方监听
        for (const item of this.running.values()) {
            item.abort();
            if (item.sessionId) {
                await this.host.abortSession(item.sessionId).catch(() => undefined);
            }
        }

        // 等执行 fiber 收尾：超时说明回合卡在别处，交给进程退出兜底（不能卡死停机）
        const fibers = [...this.running.values()].flatMap(item => (item.fiber ? [item.fiber] : []));
        if (fibers.length > 0) {
            await Effect.runPromise(Effect.race(
                Effect.forEach(
                    fibers,
                    fiber => Fiber.join(fiber).pipe(Effect.exit),
                    { concurrency: "unbounded", discard: true },
                ),
                Effect.sleep(Duration.millis(STOP_WAIT_MS)),
            ));
        }
        if (this.running.size > 0) {
            console.warn(`[jobs] 停止时仍有 ${this.running.size} 个回合未收尾，交给进程退出兜底`);
        }
    }

    /** 有新任务时立即跑一轮，不必等下一个 tick。 */
    kick(): void {
        void this.tickSafely();
    }

    stats(): RunnerStats {
        const queued = this.store.list({ states: ["queued"], limit: 1000 }).length;
        return { queued, running: this.running.size };
    }

    /**
     * 取消：排队中直接出队；在跑的按会话中止。
     * 状态先落 cancelled，run 收尾时看到终态会跳过，不会覆盖。
     */
    async cancel(jobId: string): Promise<boolean> {
        const job = this.store.get(jobId);
        if (!job || isTerminalState(job.state)) return false;

        if (job.state === "queued") {
            this.store.transition(jobId, "cancelled", { error: "提交方取消" });
            return true;
        }

        const entry = this.running.get(jobId);
        entry?.abort();
        // 光 abort 自己的信号不够：turn 还挂在宿主里，必须让宿主中止它
        const sessionId = entry?.sessionId ?? job.sessionId;
        if (sessionId) await this.host.abortSession(sessionId);

        // 回合收尾可能已经把它写成终态（例如刚跑完），这里只补未终态的情况
        const current = this.store.get(jobId);
        if (current && !isTerminalState(current.state)) {
            this.store.transition(jobId, "cancelled", { error: "提交方取消" });
        }
        return true;
    }

    private async tick(): Promise<void> {
        if (this.ticking || this.stopping) return;
        this.ticking = true;
        try {
            // 进程内也要收敛租约：续租失败的任务不能一直挂在 running 上等重启
            const expired = this.store.expireLeases();
            if (expired.length > 0) {
                console.warn(`[jobs] ${expired.length} 个任务租约过期，已标记 lost`);
            }
            // 每轮只领一个：领完立刻把它的 workspace 计入阻塞集合，串行判断才成立
            while (!this.stopping && this.running.size < this.maxConcurrent) {
                const blocked = new Set([...this.running.values()].map(item => item.workspace));
                const job = this.store.claimNext(this.owner, this.leaseMs, blocked);
                if (!job) break;
                this.dispatch(job);
            }
        } finally {
            this.ticking = false;
        }
    }

    /** 轮询失败只记录：定时回调抛错会走 uncaughtException 把整个服务带走。 */
    private async tickSafely(): Promise<void> {
        try {
            await this.tick();
        } catch (error) {
            console.error("[jobs] 调度轮询失败:", error);
        }
    }

    /** 同步登记到 running 再异步执行：并发计数必须先于下一个 claim。 */
    private dispatch(job: JobRecord): void {
        const controller = new AbortController();
        const entry: RunningJob = {
            jobId: job.id,
            workspace: job.input.workspace,
            abort: () => controller.abort(),
        };
        this.running.set(job.id, entry);

        entry.fiber = Effect.runFork(
            this.execute(job, entry, controller.signal).pipe(
                Effect.catchCause(cause => Effect.sync(() => {
                    console.error(`[jobs] ${job.id} 执行异常:`, Cause.squash(cause));
                })),
                Effect.ensuring(Effect.sync(() => {
                this.running.delete(job.id);
                // 完成即补位：不必等下一个 tick 周期，队列不会因为 tick 间隔空转
                if (!this.stopping) this.kick();
                })),
            ),
        );
    }

    /**
     * 跑一个任务：领会话 → 记 running → 在作用域里跑回合。
     * 租约心跳与回合超时都是作用域内的 fiber，回合结束（含异常）随作用域一起收掉，
     * 不需要在 finally 里逐个 clearInterval/clearTimeout。
     */
    private execute(job: JobRecord, entry: RunningJob, signal: AbortSignal): Effect.Effect<void> {
        const runner = this;

        return Effect.gen(function* () {
            const sessionId = yield* Effect.promise(() => runner.ensureSession(job));
            entry.sessionId = sessionId;
            if (signal.aborted) {
                // 取消发生在建会话期间：任务此时是 leased，必须落终态，否则永远僵尸
                const cancelled = runner.store.get(job.id);
                if (cancelled && !isTerminalState(cancelled.state)) {
                    // 与回合内中止保持同一口径：停机和服务停止要能区分出来
                    runner.store.transition(job.id, "cancelled", {
                        error: runner.stopping ? "服务停止，回合被中止" : "已取消",
                    });
                }
                return;
            }

            runner.store.transition(job.id, "running");

            let timedOut = false;
            let aborted = false;
            let failure: unknown;

            const renewEveryMs = Math.max(1_000, Math.floor(runner.leaseMs / LEASE_RENEW_DIVISOR));
            const heartbeat = repeatEvery(renewEveryMs, Effect.sync(() => {
                if (runner.store.renewLease(job.id, runner.owner, runner.leaseMs)) return;
                // 租约丢了（被判 lost 或被别人接手）：立刻中止，别再往会话里写
                void runner.host.abortSession(sessionId);
            }));

            const timeoutMs = (job.input.timeoutSec ?? runner.defaultTimeoutSec) * 1_000;
            const deadline = Effect.sleep(Duration.millis(timeoutMs)).pipe(
                Effect.andThen(Effect.sync(() => {
                    timedOut = true;
                })),
                Effect.andThen(Effect.promise(() => runner.host.abortSession(sessionId))),
            );

            yield* Effect.scoped(Effect.gen(function* () {
                yield* Effect.forkScoped(heartbeat);
                yield* Effect.forkScoped(deadline);

                // 注入任务上下文：job_comment 工具据此知道往哪张卡片写评论
                const outcome = yield* Effect.exit(Effect.tryPromise({
                    try: () => withJobContext({ jobId: job.id, sessionId }, () =>
                        runner.host.sendMessage(sessionId, job.input.prompt, {
                            // 回合进行中用户追加的输入，在下一次请求前带给模型
                            ...(runner.consumePendingInputs
                                ? { consumePendingMessages: () => runner.consumePendingInputs?.(sessionId) }
                                : {}),
                        }),
                    ),
                    catch: cause => new TurnFailure({ cause }),
                }));
                if (Exit.isSuccess(outcome)) aborted = outcome.value.aborted === true;
                else {
                    const squashed = Cause.squash(outcome.cause);
                    failure = squashed instanceof TurnFailure ? squashed.cause : squashed;
                }
            }));

            // 可能已被取消：此时 job 已是终态，收尾让给取消方
            const current = runner.store.get(job.id);
            if (!current || isTerminalState(current.state)) return;

            if (failure) {
                runner.store.transition(job.id, "failed", { error: errorMessage(failure) });
                return;
            }
            if (aborted) {
                // 停机导致的中止不算失败：否则每次重启都在「待处理」里堆一批失败卡片
                const stopped = runner.stopping;
                runner.store.transition(job.id, stopped ? "cancelled" : "failed", {
                    error: stopped ? "服务停止，回合被中止" : timedOut ? "回合超时" : "回合被中止",
                });
                return;
            }

            // 成功只改状态：会话输出留在会话里，任务不再重复保存一份当「结果」
            runner.store.transition(job.id, "succeeded");
        }).pipe(Effect.catchCause(cause => Effect.sync(() => {
            const current = runner.store.get(job.id);
            if (current && !isTerminalState(current.state)) {
                runner.store.transition(job.id, "failed", { error: errorMessage(Cause.squash(cause)) });
            }
        })));
    }

    /**
     * 取或建会话：重试默认复用（保留失败上下文），freshSession 才新建。
     * 会话一旦建立就绑定到 job，之后重试继续用它。
     */
    private async ensureSession(job: JobRecord): Promise<string> {
        const reusable = job.sessionId && !job.input.freshSession;
        if (reusable) {
            const claim = await this.host.claimSession(job.sessionId!, { noNegotiate: true });
            if (claim.ok) return job.sessionId!;
            // 原会话被别人拿走：退化为新建，避免和 TUI 抢
        }

        // 勾选即选中：选中集决定这轮下发哪些 MCP 工具，lazy 只影响「默认选中」。
        // 未勾选时用默认集合（= 配置里没标 lazy 的服务），在建会话时一次写好。
        const selection = job.input.mcpServers ?? defaultMcpSelection();
        const created = await this.host.createSession(job.input.workspace, {
            selectedServers: selection,
            origin: "job",
        });
        const claim = await this.host.claimSession(created.sessionId, { noNegotiate: true });
        if (!claim.ok) throw new Error(`会话认领失败：${claim.reason}`);
        await this.host.renameSession(created.sessionId, titleOf(job.input.prompt));
        this.store.attachSession(job.id, created.sessionId);
        // 每次新建执行会话都留档：卡片详情据此在多个 session 之间切换看历史
        this.store.addSession(job.id, created.sessionId, "run", job.attempts);
        return created.sessionId;
    }
}
