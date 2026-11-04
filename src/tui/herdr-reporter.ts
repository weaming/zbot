/**
 * herdr 集成上报：zbot 在 herdr（终端复用器）pane 内运行时，通过 herdr CLI
 * 上报自有 agent 的生命周期状态与展示元数据。
 *
 * 协议依据（herdr 0.9.5 / protocol 22）：
 * - `herdr pane report-agent <pane> --source ID --agent LABEL --state idle|working|blocked|unknown [--message]
 *    [--seq N]`：语义状态，参与 herdr 的 wait/notification/rollup。
 * - `herdr pane report-metadata <pane> --source ID [--agent LABEL] [--title TEXT] [--display-agent TEXT]
 *    [--token NAME=VALUE] [--clear-*] [--ttl-ms N] [--seq N]`：纯展示，不改变语义状态。
 * - `herdr pane release-agent <pane> --source ID --agent LABEL --seq N`：进程退出时交还生命周期权威。
 * 官方文档：herdr 仓库 `docs/next/website/src/content/docs/integrations.mdx` 的
 * "Integrate your own agent" 与 socket-api 的 "Agent state reporting"。
 *
 * 兼容边界（已按本机 CLI 实测）：
 * - 自定义 source（`custom:*`）的 `--agent-session-id/--agent-session-path` 不会进入
 *   herdr 的 `agent_session`，也不参与 session 恢复（herdr 只持久化官方集成 source）；
 *   因此这里不伪造 session 身份，改用 metadata token 暴露会话信息。
 * - `--seq` 在同一 source 上必须严格递增，herdr 会丢弃不大于上次值的报告；
 *   进程被强杀后再启动不能从 0 重新计数，故 seq 以当前时间微秒为下界。
 * - metadata 的展示字段按 source 整组替换（未带 `--clear-*` 时），所以每次上报都
 *   带上完整的 title/display_agent，避免互相清空；token 是逐键 patch。
 *
 * 非 herdr 环境（无 HERDR_ENV=1）全部 no-op，不影响本地直接运行。
 */

import { spawn, spawnSync } from "node:child_process";

export type HerdrState = "idle" | "working" | "blocked" | "unknown";

export interface HerdrContext {
    binPath: string;
    paneId: string;
}

export type HerdrRunner = (binPath: string, args: string[]) => void | Promise<void>;
export type HerdrSyncRunner = (binPath: string, args: string[]) => void;

export interface HerdrReporterOptions {
    /** 执行 herdr CLI；测试注入替身。 */
    runner?: HerdrRunner;
    /** 强退路径的同步执行器：必须在 process.exit 之前完成。 */
    syncRunner?: HerdrSyncRunner;
    /** 时钟：测试可注入固定时间以断言 seq。 */
    now?: () => number;
    /** 上报失败回调：默认打印一次，避免 TUI 路径因 herdr 缺失而抛错。 */
    onError?: (error: unknown) => void;
}

/** 展示元数据：`null` 表示清空该字段，`undefined` 表示保持当前值。 */
export interface HerdrMetadata {
    title?: string | null;
    displayAgent?: string | null;
    /** token 值 `null` 表示清除该键。 */
    tokens?: Record<string, string | null>;
}

const AGENT_LABEL = "zbot";
const SOURCE_ID = "custom:zbot";
/** herdr 语义状态可由外部事件驱动的冷却时间：单次 CLI 挂起不应堵住后续上报。 */
const CALL_TIMEOUT_MS = 5000;
/** herdr 侧展示字段上限（title/display_agent 80 字符，token 值 80 字符）。 */
const MAX_TEXT_LEN = 80;
/** 单次 metadata 上报的 token 数量上限（herdr 约定 16）。 */
const MAX_TOKENS_PER_REPORT = 16;
const TOKEN_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** 从 herdr 注入的环境变量读取上下文；不在 herdr 内时返回 undefined。 */
export function readHerdrContext(): HerdrContext | undefined {
    if (process.env.HERDR_ENV !== "1") return undefined;
    const binPath = process.env.HERDR_BIN_PATH?.trim();
    const paneId = process.env.HERDR_PANE_ID?.trim();
    if (!binPath || !paneId) return undefined;
    return { binPath, paneId };
}

function defaultRunner(binPath: string, args: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(binPath, args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
            if (stderr.length < 512) stderr += chunk.toString();
        });
        const timer = setTimeout(() => {
            child.kill();
            resolve();
        }, CALL_TIMEOUT_MS);
        timer.unref?.();
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("exit", (code) => {
            clearTimeout(timer);
            if (code === 0 || code === null) {
                resolve();
                return;
            }
            const detail = stderr.trim().slice(0, 200);
            reject(new Error(
                `herdr ${args.slice(0, 2).join(" ")} 退出码 ${code}${detail ? `：${detail}` : ""}`,
            ));
        });
    });
}

function defaultSyncRunner(binPath: string, args: string[]): void {
    spawnSync(binPath, args, { stdio: "ignore", timeout: CALL_TIMEOUT_MS });
}

/** 单行展示文本：去掉控制字符并截断，避免换行破坏 herdr 侧边栏排版。 */
function normalizeText(value: string, maxLen = MAX_TEXT_LEN): string | undefined {
    const normalized = value
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maxLen)
        .trim();
    return normalized || undefined;
}

export class HerdrReporter {
    private readonly runner: HerdrRunner;
    private readonly syncRunner: HerdrSyncRunner;
    private readonly now: () => number;
    private readonly onError: (error: unknown) => void;
    private seq = 0;
    /** 串行队列：保证同一 source 的 CLI 调用按提交顺序落到 herdr。 */
    private queue: Promise<void> = Promise.resolve();
    private lastState: HerdrState | undefined;
    private lastMessage: string | undefined;
    private lastMetadataKey: string | undefined;
    private lastErrorText: string | undefined;
    private released = false;
    private title: string | undefined;
    private displayAgent: string | undefined;
    private tokens = new Map<string, string>();
    /** 待发送的 token 清除：herdr 侧只有收到 --clear-token 才会删除。 */
    private pendingTokenClears = new Set<string>();

    constructor(
        private readonly context: HerdrContext | undefined,
        options: HerdrReporterOptions = {},
    ) {
        this.runner = options.runner ?? defaultRunner;
        this.syncRunner = options.syncRunner ?? defaultSyncRunner;
        this.now = options.now ?? Date.now;
        this.onError = options.onError ?? ((error) => {
            console.error("[herdr] 上报失败:", error);
        });
    }

    get supported(): boolean {
        return this.context !== undefined && !this.released;
    }

    /** 严格递增的 seq：以时钟微秒为下界，保证强杀重启后仍比上次上报新。 */
    private nextSeq(): number {
        this.seq = Math.max(this.seq + 1, Math.floor(this.now() * 1000));
        return this.seq;
    }

    private reportError(error: unknown): void {
        const text = error instanceof Error ? error.message : String(error);
        if (text === this.lastErrorText) return;
        this.lastErrorText = text;
        this.onError(error);
    }

    private enqueue(args: string[], onSuccess?: () => void, onFailure?: () => void): void {
        const context = this.context;
        if (!context) return;
        this.queue = this.queue
            .then(async () => {
                await this.runner(context.binPath, args);
                this.lastErrorText = undefined;
                onSuccess?.();
            })
            .catch((error: unknown) => {
                onFailure?.();
                this.reportError(error);
            });
    }

    /** 上报 agent 语义状态；状态与 message 都未变化时跳过，避免每 turn 都 spawn CLI。 */
    report(state: HerdrState, message?: string): void {
        if (!this.supported) return;
        const normalizedMessage = message === undefined ? undefined : normalizeText(message, 120);
        if (this.lastState === state && this.lastMessage === normalizedMessage) return;
        this.lastState = state;
        this.lastMessage = normalizedMessage;

        const args = [
            "pane", "report-agent", this.context!.paneId,
            "--source", SOURCE_ID,
            "--agent", AGENT_LABEL,
            "--state", state,
            "--seq", String(this.nextSeq()),
        ];
        if (normalizedMessage) args.push("--message", normalizedMessage);
        // 单次失败后允许下次同状态重试（CLI 失败通常意味着 herdr/pane 暂不可用）
        this.enqueue(args, undefined, () => {
            if (this.lastState === state && this.lastMessage === normalizedMessage) {
                this.lastState = undefined;
                this.lastMessage = undefined;
            }
        });
    }

    /**
     * 上报 pane 展示元数据（标题 / 显示名 / token）。
     * 展示字段整组替换，所以内部保留当前值并每次全量带上；token 逐键 patch。
     */
    reportMetadata(update: HerdrMetadata): void {
        if (!this.supported) return;
        if (update.title !== undefined) {
            this.title = update.title === null ? undefined : normalizeText(update.title);
        }
        if (update.displayAgent !== undefined) {
            this.displayAgent = update.displayAgent === null ? undefined : normalizeText(update.displayAgent);
        }
        if (update.tokens) {
            const entries = Object.entries(update.tokens);
            if (entries.length > MAX_TOKENS_PER_REPORT) {
                this.onError(new Error(`herdr metadata token 单次最多 ${MAX_TOKENS_PER_REPORT} 个`));
            }
            for (const [name, value] of entries.slice(0, MAX_TOKENS_PER_REPORT)) {
                if (!TOKEN_NAME_RE.test(name)) {
                    this.onError(new Error(`非法的 herdr metadata token 名：${name}`));
                    continue;
                }
                if (value === null) {
                    this.tokens.delete(name);
                    this.pendingTokenClears.add(name);
                    continue;
                }
                const normalized = normalizeText(value);
                if (normalized) {
                    this.tokens.set(name, normalized);
                    this.pendingTokenClears.delete(name);
                } else {
                    this.tokens.delete(name);
                    this.pendingTokenClears.add(name);
                }
            }
        }

        const args = [
            "pane", "report-metadata", this.context!.paneId,
            "--source", SOURCE_ID,
            "--agent", AGENT_LABEL,
            this.title ? "--title" : "--clear-title",
            ...(this.title ? [this.title] : []),
            this.displayAgent ? "--display-agent" : "--clear-display-agent",
            ...(this.displayAgent ? [this.displayAgent] : []),
        ];
        for (const name of this.pendingTokenClears) args.push("--clear-token", name);
        for (const [name, value] of this.tokens) args.push("--token", `${name}=${value}`);
        if (!this.title && !this.displayAgent && this.tokens.size === 0 && this.pendingTokenClears.size === 0) {
            return;
        }

        args.push("--seq", String(this.nextSeq()));
        const key = JSON.stringify(args.slice(0, -2));
        if (key === this.lastMetadataKey) return;
        this.lastMetadataKey = key;
        const cleared = [...this.pendingTokenClears];
        this.pendingTokenClears.clear();
        this.enqueue(args, undefined, () => {
            this.lastMetadataKey = undefined;
            // 失败时把尚未被新值覆盖的清除请求放回，避免 herdr 侧残留旧 token
            for (const name of cleared) {
                if (!this.tokens.has(name)) this.pendingTokenClears.add(name);
            }
        });
    }

    /** 清展示元数据 + 交还生命周期权威的完整命令序列。 */
    private buildReleaseCommands(): string[][] {
        const clearArgs = [
            "pane", "report-metadata", this.context!.paneId,
            "--source", SOURCE_ID,
            "--agent", AGENT_LABEL,
            "--clear-title",
            "--clear-display-agent",
        ];
        for (const name of new Set([...this.tokens.keys(), ...this.pendingTokenClears])) {
            clearArgs.push("--clear-token", name);
        }
        clearArgs.push("--seq", String(this.nextSeq()));
        return [
            clearArgs,
            [
                "pane", "release-agent", this.context!.paneId,
                "--source", SOURCE_ID,
                "--agent", AGENT_LABEL,
                "--seq", String(this.nextSeq()),
            ],
        ];
    }

    private resetPresentation(): void {
        this.title = undefined;
        this.displayAgent = undefined;
        this.tokens.clear();
        this.pendingTokenClears.clear();
        this.lastMetadataKey = undefined;
        this.lastState = undefined;
        this.lastMessage = undefined;
    }

    /** 优雅退出：排队发送，不阻塞事件循环。 */
    release(): void {
        if (!this.supported) return;
        this.released = true;
        const commands = this.buildReleaseCommands();
        this.resetPresentation();
        for (const args of commands) this.enqueue(args);
    }

    /**
     * 强退路径：同步执行，必须在 process.exit 之前完成。
     * 不受 released 限制——优雅退出排队后若立刻强退，微任务没有机会跑。
     */
    releaseSync(): void {
        const context = this.context;
        if (!context) return;
        this.released = true;
        const commands = this.buildReleaseCommands();
        this.resetPresentation();
        for (const args of commands) {
            try {
                this.syncRunner(context.binPath, args);
            } catch (error) {
                this.reportError(error);
            }
        }
    }
}

/** 全局单例：读取当前进程的 herdr 上下文。 */
export const herdrReporter = new HerdrReporter(readHerdrContext());
