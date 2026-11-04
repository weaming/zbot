/**
 * 调度器行为测试：用 stub host 控制回合时序（挂起 / 失败 / 中止），
 * 验证并发上限、同 workspace 串行、取消与结果落库。
 */

import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../events/agent-events.js";
import { JobRunner, type JobRunnerHost } from "./runner.js";
import { JobStore } from "./store.js";
import type { JobRecord } from "./types.js";

interface StubHost extends JobRunnerHost {
    calls: { created: number; aborted: string[]; sent: string[] };
}

/** 回合结果可控：默认立即产出 assistant 文本。 */
function createStubHost(
    options: { sendMessage?: (sessionId: string, prompt: string) => Promise<{ aborted?: boolean }> } = {},
): StubHost {
    let sessionCounter = 0;
    const eventsBySession = new Map<string, AgentEvent[]>();
    const calls = { created: 0, aborted: [] as string[], sent: [] as string[] };

    const host = {
        calls,
        createSession: async () => {
            sessionCounter += 1;
            calls.created += 1;
            const sessionId = `s-${sessionCounter}`;
            eventsBySession.set(sessionId, []);
            return { sessionId };
        },
        claimSession: async () => ({ ok: true }),
        isSessionClaimed: () => true,
        renameSession: async () => {},
        readSessionEventsSince: async (sessionId: string, after: number) =>
            (eventsBySession.get(sessionId) ?? []).filter(event => event.seq > after),
        subscribeEvents: () => () => {},
        isSessionBusy: () => false,
        abortSession: async (sessionId: string) => {
            calls.aborted.push(sessionId);
            return true;
        },
        sendMessage:
            options.sendMessage ??
            (async (sessionId: string, prompt: string) => {
                calls.sent.push(prompt);
                const events = eventsBySession.get(sessionId)!;
                events.push({
                    seq: events.length + 1,
                    ts: new Date().toISOString(),
                    sessionId,
                    type: "turn_message",
                    payload: { turnId: "t1", message: { role: "assistant", content: "完成" } },
                } as AgentEvent);
                return {};
            }),
    } as unknown as StubHost;

    return host;
}

function makeRunner(host: JobRunnerHost, maxConcurrent = 2): { store: JobStore; runner: JobRunner } {
    const store = new JobStore({ path: ":memory:" });
    const runner = new JobRunner({ store, host, owner: "w1", maxConcurrent, tickMs: 60_000 });
    return { store, runner };
}

function createJob(store: JobStore, workspace = "/tmp/ws"): JobRecord {
    // 测试关注执行本身：显式授权（产品默认是 false，等用户点「开始」）
    return store.create({ source: "test", input: { prompt: "跑测试", workspace, autoStart: true } }).job;
}

/** 轮询等待条件成立：调度是异步的，不依赖固定 sleep。 */
async function waitFor(
    store: JobStore,
    jobId: string,
    predicate: (job: JobRecord) => boolean,
    timeoutMs = 3_000,
): Promise<JobRecord> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const job = store.get(jobId);
        if (job && predicate(job)) return job;
        if (Date.now() > deadline) throw new Error(`等待超时，当前状态 ${job?.state}`);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

describe("JobRunner 执行", () => {
    test("跑通后置为 succeeded", async () => {
        const host = createStubHost();
        const { store, runner } = makeRunner(host);
        const job = createJob(store);

        runner.kick();
        const done = await waitFor(store, job.id, item => item.state === "succeeded");

        expect(done.sessionId).toBeDefined();
        expect(done.attempts).toBe(1);
    });

    test("回合抛错判 failed 并记录原因", async () => {
        const host = createStubHost({
            sendMessage: async () => {
                throw new Error("上游 500");
            },
        });
        const { store, runner } = makeRunner(host);
        const job = createJob(store);

        runner.kick();
        const done = await waitFor(store, job.id, item => item.state === "failed");

        expect(done.error).toContain("上游 500");
    });

    test("回合被中止（非超时）判 failed", async () => {
        const host = createStubHost({ sendMessage: async () => ({ aborted: true }) });
        const { store, runner } = makeRunner(host);
        const job = createJob(store);

        runner.kick();
        const done = await waitFor(store, job.id, item => item.state === "failed");

        expect(done.error).toBe("回合被中止");
    });
});

describe("JobRunner 取消", () => {
    test("排队中的任务直接取消，不会执行", async () => {
        const host = createStubHost();
        const { store, runner } = makeRunner(host);
        const job = createJob(store);

        expect(await runner.cancel(job.id)).toBe(true);
        expect(store.get(job.id)?.state).toBe("cancelled");

        runner.kick();
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(host.calls.created).toBe(0);
    });

    test("在跑的任务取消会中止会话", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const host = createStubHost({
            sendMessage: async () => {
                await gate;
                return { aborted: true };
            },
        });
        const { store, runner } = makeRunner(host);
        const job = createJob(store);

        runner.kick();
        await waitFor(store, job.id, item => item.state === "running");

        expect(await runner.cancel(job.id)).toBe(true);
        expect(host.calls.aborted.length).toBe(1);
        expect(store.get(job.id)?.state).toBe("cancelled");

        release();
        await new Promise(resolve => setTimeout(resolve, 50));
        // 回合收尾时看到终态，不会把取消覆盖成 failed
        expect(store.get(job.id)?.state).toBe("cancelled");
    });

    test("已结束的任务取消返回 false", async () => {
        const host = createStubHost();
        const { store, runner } = makeRunner(host);
        const job = createJob(store);

        runner.kick();
        await waitFor(store, job.id, item => item.state === "succeeded");

        expect(await runner.cancel(job.id)).toBe(false);
    });
});

describe("JobRunner 并发与串行", () => {
    test("同一 workspace 串行：前一个没结束，后一个不进 running", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const host = createStubHost({
            sendMessage: async () => {
                await gate;
                return {};
            },
        });
        const { store, runner } = makeRunner(host, 4);
        const first = createJob(store, "/tmp/same");
        const second = createJob(store, "/tmp/same");

        runner.kick();
        await waitFor(store, first.id, item => item.state === "running");
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(store.get(second.id)?.state).toBe("queued");

        release();
        await waitFor(store, first.id, item => item.state === "succeeded");
        await waitFor(store, second.id, item => item.state === "running" || item.state === "succeeded");
    });

    test("并发上限为 1 时不同 workspace 也排队", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const host = createStubHost({
            sendMessage: async () => {
                await gate;
                return {};
            },
        });
        const { store, runner } = makeRunner(host, 1);
        const first = createJob(store, "/tmp/a");
        const second = createJob(store, "/tmp/b");

        runner.kick();
        await waitFor(store, first.id, item => item.state === "running");
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(store.get(second.id)?.state).toBe("queued");
        release();
        await waitFor(store, second.id, item => item.state === "succeeded");
    });
});

describe("JobRunner 停机", () => {
    test("stop() 中止在跑的回合，并把任务落到 cancelled（不是 failed）", async () => {
        let release: (() => void) | undefined;
        const host = createStubHost({
            sendMessage: async () => {
                await new Promise<void>(resolve => {
                    release = resolve;
                });
                return { aborted: true };
            },
        });
        // 模拟宿主的 abortSession：让卡住的回合真的返回
        const originalAbort = host.abortSession.bind(host);
        host.abortSession = async (sessionId: string) => {
            release?.();
            return originalAbort(sessionId);
        };

        const { store, runner } = makeRunner(host);
        const job = createJob(store);
        runner.kick();
        await waitFor(store, job.id, item => item.state === "running");

        await runner.stop();

        expect(host.calls.aborted.length).toBeGreaterThan(0);
        const done = store.get(job.id)!;
        expect(done.state).toBe("cancelled");
        expect(done.error).toContain("服务停止");
    });
});
