/**
 * herdr-core（hc / Herdr 2）终端标签上报：TUI 在 hc 终端内运行时，
 * 通过 `hc label <HC_TERMINAL_ID> <k=v>...` 同步会话身份与多 tab 元数据，
 * 供外部（如 Anywhere discovery/hc）精确发现已验证的 zbot 会话。
 *
 * 状态协议（OSC 7501）由同目录 `program-status.ts` 独立负责，避免重复写终端流。
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeDisplayText, type HerdrMetadata } from "./herdr-reporter.js";

export interface HcContext {
    terminalId: string;
    binPath?: string;
}

export interface ResolveHcBinOptions {
    homedir?: string;
    isExecutable?: (filePath: string) => boolean;
}

export type HcRunner = (binPath: string, args: string[]) => void | Promise<void>;
export type HcSyncRunner = (binPath: string, args: string[]) => void;

export interface HcReporterOptions {
    /** 异步执行 hc CLI；测试可注入替身。 */
    runner?: HcRunner;
    /** 退出路径的同步执行器：保证进程退出前清掉终端残留标签。 */
    syncRunner?: HcSyncRunner;
    /** 时钟：用于节流强制刷新。 */
    now?: () => number;
    /** 上报失败回调：去重后输出，不阻塞 TUI。 */
    onError?: (error: unknown) => void;
}

const AGENT_LABEL = "zbot";
const CALL_TIMEOUT_MS = 5000;
const MAX_TOKENS_PER_REPORT = 16;
const TOKEN_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const RESERVED_LABEL_KEYS = new Set(["agent", "title"]);
const DEFAULT_CLEAR_TOKEN_KEYS = ["session", "tabs", "model"] as const;
const SHEPRD_HC_PATH = "/Applications/Sheprd.app/Contents/MacOS/herdr-core";

function defaultIsExecutable(filePath: string): boolean {
    try {
        if (!fs.statSync(filePath).isFile()) return false;
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** 解析 hc 可执行文件：HC_BIN_PATH → PATH → ~/.local/bin/hc → Sheprd 内置 herdr-core。 */
export function resolveHcBinPath(
    env: NodeJS.ProcessEnv = process.env,
    options: ResolveHcBinOptions = {},
): string | undefined {
    const explicit = env.HC_BIN_PATH?.trim();
    if (explicit) return explicit;

    const isExecutable = options.isExecutable ?? defaultIsExecutable;
    const pathDirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
    for (const dir of pathDirs) {
        const candidate = path.join(dir, "hc");
        if (isExecutable(candidate)) return candidate;
    }

    const homedir = options.homedir ?? os.homedir();
    const fallbacks = [
        path.join(homedir, ".local", "bin", "hc"),
        SHEPRD_HC_PATH,
    ];
    for (const candidate of fallbacks) {
        if (isExecutable(candidate)) return candidate;
    }
    return undefined;
}

/** 读取 hc 终端上下文；不在 hc 终端内时返回 undefined。 */
export function readHcContext(
    env: NodeJS.ProcessEnv = process.env,
    options: ResolveHcBinOptions = {},
): HcContext | undefined {
    const terminalId = env.HC_TERMINAL_ID?.trim();
    if (!terminalId) return undefined;
    return {
        terminalId,
        binPath: resolveHcBinPath(env, options),
    };
}

function spawnHcAsync(
    binPath: string,
    args: string[],
    onChild: (child: ChildProcess | undefined) => void,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(binPath, args, { stdio: ["ignore", "ignore", "pipe"] });
        onChild(child);

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
            onChild(undefined);
            reject(error);
        });
        child.once("exit", (code) => {
            clearTimeout(timer);
            onChild(undefined);
            if (code === 0 || code === null) {
                resolve();
                return;
            }
            const detail = stderr.trim().slice(0, 200);
            reject(new Error(`hc ${args[0] ?? ""} 退出码 ${code}${detail ? `：${detail}` : ""}`));
        });
    });
}

function defaultSyncRunner(binPath: string, args: string[]): void {
    spawnSync(binPath, args, { stdio: "ignore", timeout: CALL_TIMEOUT_MS });
}

export class HcReporter {
    private readonly runner: HcRunner;
    private readonly syncRunner: HcSyncRunner;
    private readonly now: () => number;
    private readonly onError: (error: unknown) => void;
    private queue: Promise<void> = Promise.resolve();
    private activeChild: ChildProcess | undefined;
    private lastLabelKey: string | undefined;
    private lastRefreshAt = 0;
    private lastErrorText: string | undefined;
    private isReleased = false;
    private hasMetadata = false;
    private title: string | undefined;
    private readonly tokens = new Map<string, string | null>();

    constructor(
        private readonly context: HcContext | undefined,
        options: HcReporterOptions = {},
    ) {
        this.runner = options.runner ?? ((binPath, args) => spawnHcAsync(binPath, args, (child) => {
            this.activeChild = child;
        }));
        this.syncRunner = options.syncRunner ?? defaultSyncRunner;
        this.now = options.now ?? Date.now;
        this.onError = options.onError ?? ((error) => {
            console.error("[hc] 上报失败:", error);
        });
    }

    get supported(): boolean {
        return this.context !== undefined && !this.isReleased;
    }

    private reportError(error: unknown): void {
        const text = error instanceof Error ? error.message : String(error);
        if (text === this.lastErrorText) return;
        this.lastErrorText = text;
        this.onError(error);
    }

    /** 合并更新并异步上报终端标签；undefined 保持原值，null 清空对应键。 */
    reportMetadata(update: HerdrMetadata): void {
        if (!this.supported) return;
        this.hasMetadata = true;

        if (update.title !== undefined) {
            this.title = update.title === null ? undefined : normalizeDisplayText(update.title);
        }

        if (update.tokens) {
            const entries = Object.entries(update.tokens);
            if (entries.length > MAX_TOKENS_PER_REPORT) {
                this.reportError(new Error(`hc label token 单次最多 ${MAX_TOKENS_PER_REPORT} 个`));
            }
            for (const [name, value] of entries.slice(0, MAX_TOKENS_PER_REPORT)) {
                if (!TOKEN_NAME_RE.test(name) || RESERVED_LABEL_KEYS.has(name)) {
                    this.reportError(new Error(`非法的 hc label 名：${name}`));
                    continue;
                }
                if (value === null) {
                    this.tokens.set(name, null);
                    continue;
                }
                const normalized = normalizeDisplayText(value);
                this.tokens.set(name, normalized ?? null);
            }
        }

        this.sendLabels(false);
    }

    /** 跳过去重，强制重发当前完整标签快照。 */
    reassert(): void {
        if (!this.supported || !this.hasMetadata) return;
        this.sendLabels(true);
    }

    /** 按最小间隔节流强制重发标签；实际触发重发时返回 true。 */
    refreshMetadata(minIntervalMs = 5_000): boolean {
        if (!this.supported || !this.hasMetadata) return false;
        const now = this.now();
        if (now - this.lastRefreshAt < minIntervalMs) return false;
        this.lastRefreshAt = now;
        this.sendLabels(true);
        return true;
    }

    private buildLabelArgs(): string[] {
        const args = [
            "label",
            this.context!.terminalId,
            `agent=${AGENT_LABEL}`,
            `title=${this.title ?? ""}`,
        ];
        for (const [name, value] of this.tokens) {
            args.push(`${name}=${value ?? ""}`);
        }
        return args;
    }

    private sendLabels(isForce: boolean): void {
        const binPath = this.context?.binPath;
        if (!this.supported || !binPath) return;

        const args = this.buildLabelArgs();
        const key = JSON.stringify(args);
        if (!isForce && key === this.lastLabelKey) return;
        this.lastLabelKey = key;

        this.queue = this.queue
            .then(async () => {
                if (this.isReleased) return;
                await this.runner(binPath, args);
                this.lastErrorText = undefined;
            })
            .catch((error: unknown) => {
                if (this.isReleased) return;
                if (this.lastLabelKey === key) this.lastLabelKey = undefined;
                this.reportError(error);
            });
    }

    /** 退出清理：同步清空全部上报过的标签，防止终端残留过期会话身份。 */
    release(): void {
        const context = this.context;
        if (!context || this.isReleased) return;
        this.isReleased = true;

        this.activeChild?.kill();
        this.activeChild = undefined;

        const tokenKeys = new Set<string>([...DEFAULT_CLEAR_TOKEN_KEYS, ...this.tokens.keys()]);
        const clearArgs = [
            "label",
            context.terminalId,
            "agent=",
            "title=",
            ...[...tokenKeys].map(key => `${key}=`),
        ];

        this.title = undefined;
        this.tokens.clear();
        this.lastLabelKey = undefined;
        this.hasMetadata = false;

        if (!context.binPath) return;
        try {
            this.syncRunner(context.binPath, clearArgs);
        } catch (error) {
            this.reportError(error);
        }
    }
}

export const hcReporter = new HcReporter(readHcContext());
