#!/usr/bin/env bun
/**
 * 一次性维护脚本：把会话交换日志（`sessions/**\/http/*.jsonl`）折叠成链式增量。
 *
 * 背景：历史实现给缺 ID 的 Responses 工具调用**每次请求随机**补 `fc_<uuid>`，
 * 于是每次请求体前缀都不同 —— 上游前缀缓存全失效，日志的增量比对也失效，
 * 每条请求都把整段历史重写一遍（单会话一天能到 GB 级，重启回读要几十秒）。
 *
 * 代码侧改成确定性 ID 之后，存量日志仍带着膨胀形态：本脚本按新规则重算一遍
 * （归一 item ID → 只写相对上一条的新增部分 → 重算 historyHash/historyCount）。
 * 交换日志只是调试数据，转换不改任何会话事实源。
 *
 * 用法：
 *   bun src/scripts/convert-exchange-logs.ts                 # 只统计，不写盘
 *   bun src/scripts/convert-exchange-logs.ts --apply         # 实际转换
 *   bun src/scripts/convert-exchange-logs.ts --only <sessionId>
 *   bun src/scripts/convert-exchange-logs.ts --keep-original # 留 .converted 供比对
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createHash } from "node:crypto";
import { getSessionsDir } from "../utils/runtime-paths.js";

/** 最近被改动的日志视为可能有进程在写，默认跳过（替换文件会丢掉并发追加）。 */
const ACTIVE_WINDOW_MS = 60_000;

interface Options {
    /** 交换日志所在的状态目录（`.../sessions`）。 */
    dir: string;
    apply: boolean;
    force: boolean;
    only?: string;
    keepOriginal: boolean;
}

function parseOptions(argv: string[]): Options {
    const options: Options = {
        dir: getSessionsDir(),
        apply: false,
        force: false,
        keepOriginal: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--apply") options.apply = true;
        else if (arg === "--force") options.force = true;
        else if (arg === "--keep-original") options.keepOriginal = true;
        else if (arg === "--only") {
            const value = argv[index + 1];
            if (!value) throw new Error("--only 需要 sessionId");
            options.only = value;
            index += 1;
        } else if (arg === "--dir") {
            const value = argv[index + 1];
            if (!value) throw new Error("--dir 需要目录参数");
            options.dir = path.resolve(value);
            index += 1;
        } else {
            throw new Error(`未知参数: ${arg}`);
        }
    }
    return options;
}

/** 与 `utils/logger.ts` 的 historyHash 同一算法：转换后的链才能被运行时续上。 */
function hashOf(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** 与 `orchestrator/responses-input.ts` 同一算法：由 call_id（或工具名+参数）派生稳定 ID。 */
function stableItemId(prefix: "fc" | "ctc", item: any): string {
    const seed = typeof item.call_id === "string" && item.call_id
        ? item.call_id
        : JSON.stringify([item.name ?? null, item.arguments ?? item.input ?? null]);
    return `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}

/** 历史工具调用 item 的 ID 归一：缺失 ID 的项运行时不会补，这里也不动。 */
function normalizeItem(item: any): any {
    if (!item || typeof item !== "object") return item;
    if (item.type !== "function_call" && item.type !== "custom_tool_call") return item;
    if (item.id === undefined) return item;

    const prefix = item.type === "function_call" ? "fc" : "ctc";
    return { ...item, id: stableItemId(prefix, item) };
}

/** 会话链状态：镜像 `utils/logger.ts` 里 SessionChainState 的推进方式。 */
interface ChainState {
    historyField: "input" | "messages";
    count: number;
    hash?: string;
    /** 上一请求的完整历史（已归一 ID），用于重算增量。 */
    full?: any[];
}

interface ConvertStats {
    file: string;
    beforeBytes: number;
    afterBytes: number;
    requests: number;
    fullRewrites: number;
    becameIncremental: number;
}

function collectFiles(sessionsDir: string): string[] {
    const files: string[] = [];

    const pushJsonl = (dir: string): void => {
        let names: string[];
        try {
            names = fs.readdirSync(dir);
        } catch {
            return;
        }
        for (const name of names) {
            if (name.endsWith(".jsonl")) files.push(path.join(dir, name));
        }
    };

    pushJsonl(path.join(sessionsDir, "http"));
    let entries: fs.Dirent[] = [];
    try {
        entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
        return files;
    }
    for (const entry of entries) {
        if (entry.name === "http") continue;
        if (entry.isDirectory()) pushJsonl(path.join(sessionsDir, entry.name, "http"));
    }
    return files.sort();
}

/** 一条 HTTP_REQUEST 的改写结果；content 引用相同表示保持原样。 */
function rewriteRequest(content: any, chain: ChainState | undefined): { content: any; chain: ChainState | undefined } {
    // 带 previous_response_id 的请求由上游续接，运行时把链重置成「没有历史」。
    if (typeof content?.previous_response_id === "string") {
        return { content, chain: undefined };
    }

    const field: "input" | "messages" | undefined = Array.isArray(content?.input) ? "input"
        : Array.isArray(content?.messages) ? "messages" : undefined;
    if (!field) return { content, chain };

    const items: any[] = content[field];
    const base = typeof content.historyBase === "number" ? content.historyBase : 0;
    const prefix = base > 0 && chain?.full && base <= chain.full.length && chain.historyField === field
        ? chain.full.slice(0, base)
        : [];
    const full = [...prefix, ...items].map(normalizeItem);

    const historyHash = hashOf(full);
    const previousCount = chain && chain.count <= full.length && chain.hash === hashOf(full.slice(0, chain.count))
        ? chain.count
        : 0;

    const rewritten = {
        ...content,
        [field]: full.slice(previousCount),
        historyField: field,
        historyBase: previousCount,
        historyCount: full.length,
        historyHash,
    };
    return { content: rewritten, chain: { historyField: field, count: full.length, hash: historyHash, full } };
}

async function convertFile(file: string, options: Options): Promise<ConvertStats> {
    const beforeBytes = fs.statSync(file).size;
    const temp = `${file}.converted`;
    const stats: ConvertStats = { file, beforeBytes, afterBytes: 0, requests: 0, fullRewrites: 0, becameIncremental: 0 };
    const output = options.apply ? fs.createWriteStream(temp) : undefined;
    let chain: ChainState | undefined;
    let afterBytes = 0;

    const reader = readline.createInterface({
        input: fs.createReadStream(file, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });

    try {
        for await (const rawLine of reader) {
            if (!rawLine) continue;
            let line = rawLine;
            if (rawLine.includes('"HTTP_REQUEST"')) {
                const entry = safeParse(rawLine);
                if (entry?.type === "HTTP_REQUEST" && entry.content && typeof entry.content === "object") {
                    const rewritten = rewriteRequest(entry.content, chain);
                    chain = rewritten.chain;
                    stats.requests += 1;
                    if (typeof entry.content.historyBase !== "number" || entry.content.historyBase === 0) {
                        stats.fullRewrites += 1;
                    }
                    if (rewritten.content.historyBase > 0) stats.becameIncremental += 1;
                    if (rewritten.content !== entry.content) line = JSON.stringify({ ...entry, content: rewritten.content });
                }
            }
            const bytes = Buffer.byteLength(line) + 1;
            afterBytes += bytes;
            if (output) output.write(`${line}\n`);
        }
    } finally {
        reader.close();
        if (output) await new Promise<void>(resolve => output.end(resolve));
    }

    stats.afterBytes = options.apply ? fs.statSync(temp).size : afterBytes;
    if (options.apply) {
        await verifyChain(temp);
        if (!options.keepOriginal) fs.renameSync(temp, file);
    }
    return stats;
}

/** 复核转换结果：每条请求的增量条数必须自洽，且尾部链能被运行时原样续上。 */
async function verifyChain(file: string): Promise<void> {
    const reader = readline.createInterface({
        input: fs.createReadStream(file, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });
    let chain: ChainState | undefined;
    let lineNo = 0;
    try {
        for await (const line of reader) {
            lineNo += 1;
            if (!line.includes('"HTTP_REQUEST"')) continue;
            const entry = safeParse(line);
            if (entry?.type !== "HTTP_REQUEST" || !entry.content) continue;
            const content = entry.content;
            const field: "input" | "messages" | undefined = Array.isArray(content.input) ? "input"
                : Array.isArray(content.messages) ? "messages" : undefined;
            if (!field) continue;
            if (content.historyBase + content[field].length !== content.historyCount) {
                throw new Error(`${file}:${lineNo} historyBase+增量 ≠ historyCount`);
            }
            const full = [...(chain?.full?.slice(0, content.historyBase) ?? []), ...content[field]];
            if (hashOf(full) !== content.historyHash) {
                throw new Error(`${file}:${lineNo} historyHash 与重建历史不一致`);
            }
            chain = { historyField: field, count: full.length, hash: content.historyHash, full };
        }
    } finally {
        reader.close();
    }
}

function safeParse(line: string): any {
    try {
        return JSON.parse(line);
    } catch {
        return undefined;
    }
}

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2));
    const files = collectFiles(options.dir).filter(file => !options.only || path.basename(file, ".jsonl") === options.only);
    if (files.length === 0) throw new Error("没有找到交换日志（检查 ZBOT_STATE_DIR 或 --only）");

    let beforeTotal = 0;
    let afterTotal = 0;
    let skipped = 0;
    const now = Date.now();
    for (const file of files) {
        // 可能还有进程在写：替换文件会丢掉并发追加的记录
        if (!options.force && now - fs.statSync(file).mtimeMs < ACTIVE_WINDOW_MS) {
            skipped += 1;
            console.log(`${path.relative(process.cwd(), file)}  跳过（${ACTIVE_WINDOW_MS / 1000}s 内有写入）`);
            continue;
        }
        const stats = await convertFile(file, options);
        beforeTotal += stats.beforeBytes;
        afterTotal += stats.afterBytes;
        const saved = stats.beforeBytes - stats.afterBytes;
        console.log([
            path.relative(process.cwd(), stats.file) || stats.file,
            `请求 ${stats.requests}`,
            `整段重写 ${stats.fullRewrites}`,
            `增量 ${stats.becameIncremental}`,
            `${(stats.beforeBytes / 1e6).toFixed(1)}MB → ${(stats.afterBytes / 1e6).toFixed(1)}MB`,
            `省 ${(saved / 1e6).toFixed(1)}MB`,
        ].join("  "));
    }

    const handled = files.length - skipped;
    const verb = options.apply ? "已转换" : "预计转换";
    console.log(`\n${verb} ${handled} 个文件${skipped > 0 ? `（跳过 ${skipped} 个正在写入的）` : ""}：`
        + `${(beforeTotal / 1e9).toFixed(2)}GB → ${(afterTotal / 1e9).toFixed(2)}GB`);
}

await main();
