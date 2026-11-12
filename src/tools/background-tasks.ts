/**
 * 管理仍在运行的 shell 后台任务，供 bash 工具和 TUI 快捷键共用。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Duration, Effect, Fiber } from "effect";
import { abortError, interruptOnAbort, runPromiseOrAbort, sleepUnref, whenAborted } from "../utils/effect.js";

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_PREVIEW_CHARS = 8_000;
const TASK_RETENTION_MS = 10 * 60 * 1_000;
const MAX_BACKGROUND_TIMEOUT_SECONDS = 2 * 60 * 60;

type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped" | "timed_out";

interface ShellProcessOptions {
    command: string;
    executionCommand?: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    shellPath: string;
    sessionId?: string;
    timeoutSeconds: number;
    autoBackgroundOnTimeout: boolean;
    backgroundTimeoutSeconds?: number;
    signal?: AbortSignal;
}

interface ShellCompletedResult {
    kind: "completed" | "timed_out" | "aborted";
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signalName: NodeJS.Signals | null;
    timeoutSeconds?: number;
}

interface ShellDetachedResult {
    kind: "detached";
    task: BackgroundTaskSummary;
}

type ShellForegroundResult = ShellCompletedResult | ShellDetachedResult;

export interface BackgroundTaskSummary {
    id: string;
    sessionId?: string;
    command: string;
    cwd: string;
    status: BackgroundTaskStatus;
    startedAt: string;
    finishedAt?: string;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    reason?: "manual" | "timeout" | "stopped";
    stdout?: string;
    stderr?: string;
    outputTruncated?: boolean;
}

interface BackgroundTaskRecord {
    summary: BackgroundTaskSummary;
    child: ChildProcess;
    pgid?: number;
    stdoutChunks: Buffer[];
    stderrChunks: Buffer[];
    stdoutBytes: number;
    stderrBytes: number;
    outputTruncated: boolean;
    stopRequested: boolean;
    /** 超时 watchdog：任务结束即中断（= 清定时器），不占进程退出。 */
    watchdog?: Fiber.Fiber<void>;
    resolveDone: (summary: BackgroundTaskSummary) => void;
    done: Promise<BackgroundTaskSummary>;
}

interface ForegroundShellRun {
    sessionId?: string;
    detach(reason?: "manual" | "timeout"): boolean;
}

interface ShellProcessHandle {
    promise: Promise<ShellForegroundResult>;
    detach(reason?: "manual" | "timeout"): boolean;
}

function trimOutput(value: string): string {
    if (value.length <= MAX_OUTPUT_PREVIEW_CHARS) return value;
    return `…${value.slice(-MAX_OUTPUT_PREVIEW_CHARS)}`;
}

function nowISO(): string {
    return new Date().toISOString();
}

/** 起一个 watchdog fiber，或停掉它（中断 fiber 即清掉它持有的定时器）。 */
function stopWatchdog(fiber?: Fiber.Fiber<void>): void {
    if (fiber) Effect.runFork(Fiber.interrupt(fiber));
}

function killProcessGroup(pgid: number | undefined, child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
    if (!pgid) return;
    try {
        process.kill(-pgid, signal);
    } catch (error: any) {
        if (error?.code !== "ESRCH") {
            try {
                child.kill(signal);
            } catch {
                // 子进程已经退出时无需重复处理。
            }
        }
    }
}

class BackgroundTaskManager {
    private readonly tasks = new Map<string, BackgroundTaskRecord>();
    private readonly foregroundRuns = new Set<ForegroundShellRun>();
    private readonly completionListeners = new Set<(task: BackgroundTaskSummary) => void>();
    private readonly startListeners = new Set<(task: BackgroundTaskSummary) => void>();
    private nextTaskId = 1;

    onTaskCompleted(listener: (task: BackgroundTaskSummary) => void): () => void {
        this.completionListeners.add(listener);
        return () => this.completionListeners.delete(listener);
    }

    /** 任务进入 running：让界面能在启动瞬间反映"有后台任务在跑"。 */
    onTaskStarted(listener: (task: BackgroundTaskSummary) => void): () => void {
        this.startListeners.add(listener);
        return () => this.startListeners.delete(listener);
    }

    startShell(options: ShellProcessOptions): ShellProcessHandle {
        const child = spawn(options.shellPath, ["-c", options.executionCommand ?? options.command], {
            cwd: options.cwd,
            env: options.env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        });

        const pgid = child.pid;
        const startedAt = nowISO();
        const foregroundRun: ForegroundShellRun = {
            sessionId: options.sessionId,
            detach: () => false,
        };
        let settled = false;
        let detached = false;
        let timedOut = false;
        let backgroundTask: BackgroundTaskRecord | undefined;
        let watchdog: Fiber.Fiber<void> | undefined;
        let resolveForeground!: (result: ShellForegroundResult) => void;
        let rejectForeground!: (error: Error) => void;

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let outputTruncated = false;

        const appendOutput = (chunks: Buffer[], chunk: Buffer, currentBytes: number, assign: (value: number) => void): void => {
            if (currentBytes >= MAX_OUTPUT_BYTES) {
                outputTruncated = true;
                return;
            }
            const remain = MAX_OUTPUT_BYTES - currentBytes;
            chunks.push(chunk.subarray(0, remain));
            assign(currentBytes + Math.min(chunk.length, remain));
            if (chunk.length > remain) outputTruncated = true;
        };

        const collectOutput = (chunks: Buffer[]): string => Buffer.concat(chunks).toString("utf8");
        const clearForeground = (): void => {
            this.foregroundRuns.delete(foregroundRun);
            stopWatchdog(watchdog);
            watchdog = undefined;
        };

        const resolveDetached = (reason: "manual" | "timeout"): boolean => {
            if (settled || detached) return false;
            detached = true;
            clearForeground();
            backgroundTask = this.createTask(options, child, pgid, reason, startedAt, stdoutChunks, stderrChunks, stdoutBytes, stderrBytes, outputTruncated);
            resolveForeground({ kind: "detached", task: this.toSummary(backgroundTask, true) });
            return true;
        };
        foregroundRun.detach = resolveDetached;
        this.foregroundRuns.add(foregroundRun);

        const finishBackground = (code: number | null, signalName: NodeJS.Signals | null): void => {
            if (!backgroundTask) return;
            if (backgroundTask.summary.status !== "running") return;
            stopWatchdog(backgroundTask.watchdog);
            backgroundTask.watchdog = undefined;
            const stdout = collectOutput(backgroundTask.stdoutChunks).trim();
            const stderr = collectOutput(backgroundTask.stderrChunks).trim();
            const status = backgroundTask.stopRequested
                ? "stopped"
                : backgroundTask.summary.reason === "timeout"
                    ? "timed_out"
                    : code === 0
                        ? "completed"
                        : "failed";
            backgroundTask.summary = {
                ...backgroundTask.summary,
                status,
                finishedAt: nowISO(),
                exitCode: code,
                signal: signalName,
                ...(stdout ? { stdout: trimOutput(stdout) } : {}),
                ...(stderr ? { stderr: trimOutput(stderr) } : {}),
                ...(backgroundTask.outputTruncated ? { outputTruncated: true } : {}),
            };
            backgroundTask.resolveDone(backgroundTask.summary);
            this.notifyTaskCompleted(this.toSummary(backgroundTask, true));
        };

        child.stdout?.on("data", (chunk: Buffer) => {
            if (backgroundTask) {
                appendOutput(backgroundTask.stdoutChunks, chunk, backgroundTask.stdoutBytes, value => { backgroundTask!.stdoutBytes = value; });
                backgroundTask.outputTruncated ||= outputTruncated;
            } else {
                appendOutput(stdoutChunks, chunk, stdoutBytes, value => { stdoutBytes = value; });
            }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            if (backgroundTask) {
                appendOutput(backgroundTask.stderrChunks, chunk, backgroundTask.stderrBytes, value => { backgroundTask!.stderrBytes = value; });
                backgroundTask.outputTruncated ||= outputTruncated;
            } else {
                appendOutput(stderrChunks, chunk, stderrBytes, value => { stderrBytes = value; });
            }
        });

        child.once("error", (error) => {
            if (detached) {
                finishBackground(null, null);
                return;
            }
            if (settled) return;
            settled = true;
            clearForeground();
            rejectForeground(error);
        });

        child.once("close", (code, signalName) => {
            if (detached) {
                finishBackground(code, signalName);
                return;
            }
            if (settled) return;
            settled = true;
            clearForeground();
            resolveForeground({
                kind: options.signal?.aborted ? "aborted" : timedOut ? "timed_out" : "completed",
                stdout: collectOutput(stdoutChunks),
                stderr: collectOutput(stderrChunks),
                exitCode: code,
                signalName,
                ...(timedOut ? { timeoutSeconds: options.timeoutSeconds } : {}),
            });
        });

        const promise = new Promise<ShellForegroundResult>((resolve, reject) => {
            resolveForeground = resolve;
            rejectForeground = reject;
        });

        // 前台等待的两条出口：到点（转后台或杀掉）与调用方 abort；先到者胜，另一条随之撤销
        const onTimeout = Effect.sleep(Duration.millis(options.timeoutSeconds * 1_000)).pipe(
            Effect.andThen(Effect.sync(() => {
                timedOut = true;
                if (options.autoBackgroundOnTimeout) {
                    resolveDetached("timeout");
                    return;
                }
                killProcessGroup(pgid, child);
            })),
        );
        const onAbortSignal = whenAborted(options.signal, () => {
            if (detached) return;
            killProcessGroup(pgid, child);
        });
        watchdog = Effect.runFork(Effect.raceFirst(onTimeout, onAbortSignal));

        return { promise, detach: reason => foregroundRun.detach(reason) };
    }

    detachForeground(sessionId: string): number {
        let detachedCount = 0;
        for (const run of [...this.foregroundRuns]) {
            if (run.sessionId === sessionId && run.detach("manual")) detachedCount++;
        }
        return detachedCount;
    }

    list(sessionId?: string): BackgroundTaskSummary[] {
        this.prune();
        return [...this.tasks.values()]
            .filter(task => sessionId === undefined || task.summary.sessionId === sessionId)
            .map(task => this.toSummary(task, true));
    }

    get(taskId: string, sessionId?: string): BackgroundTaskSummary | undefined {
        this.prune();
        const task = this.tasks.get(taskId);
        if (!task || (sessionId !== undefined && task.summary.sessionId !== sessionId)) return undefined;
        return this.toSummary(task, true);
    }

    /** 等任务结束或超时返回快照；signal 中断时抛 AbortError，定时器与监听器由 Effect 托管。 */
    async wait(taskId: string, timeoutMs: number, sessionId?: string, signal?: AbortSignal): Promise<BackgroundTaskSummary | undefined> {
        const task = this.tasks.get(taskId);
        if (!task || (sessionId !== undefined && task.summary.sessionId !== sessionId)) return undefined;
        if (task.summary.status !== "running") return this.toSummary(task, true);
        if (signal?.aborted) throw abortError();

        const snapshot = (): BackgroundTaskSummary => this.toSummary(task, true);
        const finished = Effect.callback<void>(resume => {
            void task.done.then(() => resume(Effect.void));
        }).pipe(Effect.andThen(Effect.sync(snapshot)));
        const expired = sleepUnref(timeoutMs).pipe(Effect.andThen(Effect.sync(snapshot)));

        return runPromiseOrAbort(
            Effect.raceFirst(finished, expired).pipe(Effect.raceFirst(interruptOnAbort(signal))),
        );
    }

    stop(taskId: string, sessionId?: string): boolean {
        const task = this.tasks.get(taskId);
        if (!task || (sessionId !== undefined && task.summary.sessionId !== sessionId)) return false;
        if (task.summary.status !== "running") return false;
        task.stopRequested = true;
        task.summary.reason = "stopped";
        killProcessGroup(task.pgid, task.child);
        return true;
    }

    stopAll(): void {
        for (const run of [...this.foregroundRuns]) run.detach("manual");
        for (const task of this.tasks.values()) {
            if (task.summary.status === "running") this.stop(task.summary.id);
        }
    }

    private createTask(
        options: ShellProcessOptions,
        child: ChildProcess,
        pgid: number | undefined,
        reason: "manual" | "timeout",
        startedAt: string,
        stdoutChunks: Buffer[],
        stderrChunks: Buffer[],
        stdoutBytes: number,
        stderrBytes: number,
        outputTruncated: boolean,
    ): BackgroundTaskRecord {
        this.prune();
        const id = `task_${this.nextTaskId++}`;
        let resolveDone!: (summary: BackgroundTaskSummary) => void;
        const done = new Promise<BackgroundTaskSummary>(resolve => { resolveDone = resolve; });
        const summary: BackgroundTaskSummary = {
            id,
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            command: options.command,
            cwd: options.cwd,
            status: "running",
            startedAt,
            reason,
        };
        const task: BackgroundTaskRecord = {
            summary,
            child,
            pgid,
            stdoutChunks,
            stderrChunks,
            stdoutBytes,
            stderrBytes,
            outputTruncated,
            stopRequested: false,
            resolveDone,
            done,
        };
        this.tasks.set(id, task);
        this.notifyTaskStarted(task.summary);

        const timeoutSeconds = Math.min(
            MAX_BACKGROUND_TIMEOUT_SECONDS,
            Math.max(1, Math.round(options.backgroundTimeoutSeconds ?? 30 * 60)),
        );
        // 后台任务的超时也走 watchdog：结束时中断即可，且不阻止进程退出（与原来的 unref 一致）
        task.watchdog = Effect.runFork(sleepUnref(timeoutSeconds * 1_000).pipe(
            Effect.andThen(Effect.sync(() => {
                if (task.summary.status !== "running") return;
                task.summary.reason = "timeout";
                killProcessGroup(task.pgid, task.child);
            })),
        ));
        return task;
    }

    private toSummary(task: BackgroundTaskRecord, includeOutput: boolean): BackgroundTaskSummary {
        const stdout = collectTaskOutput(task.stdoutChunks).trim();
        const stderr = collectTaskOutput(task.stderrChunks).trim();
        return {
            ...task.summary,
            ...(includeOutput && stdout ? { stdout: trimOutput(stdout) } : {}),
            ...(includeOutput && stderr ? { stderr: trimOutput(stderr) } : {}),
            ...(task.outputTruncated ? { outputTruncated: true } : {}),
        };
    }

    private notifyTaskStarted(task: BackgroundTaskSummary): void {
        for (const listener of this.startListeners) {
            try {
                listener(task);
            } catch (error) {
                console.error("后台任务启动通知失败", error);
            }
        }
    }

    /** 当前会话仍在运行的后台任务数。 */
    runningCount(sessionId?: string): number {
        this.prune();
        let count = 0;
        for (const task of this.tasks.values()) {
            if (task.summary.status !== "running") continue;
            if (sessionId !== undefined && task.summary.sessionId !== sessionId) continue;
            count += 1;
        }
        return count;
    }

    private notifyTaskCompleted(task: BackgroundTaskSummary): void {
        for (const listener of this.completionListeners) {
            try {
                listener(task);
            } catch (error) {
                console.error("后台任务完成通知失败", error);
            }
        }
    }

    private prune(): void {
        const cutoff = Date.now() - TASK_RETENTION_MS;
        for (const [id, task] of this.tasks) {
            if (task.summary.status !== "running" && task.summary.finishedAt && Date.parse(task.summary.finishedAt) < cutoff) {
                this.tasks.delete(id);
            }
        }
    }
}

function collectTaskOutput(chunks: Buffer[]): string {
    return Buffer.concat(chunks).toString("utf8");
}

export const backgroundTaskManager = new BackgroundTaskManager();
