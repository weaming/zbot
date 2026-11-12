/**
 * 真实分词器（DeepSeek V4，HF tokenizer.json）：token 计数的事实来源。
 *
 * - 懒加载：首次用到时才读取词表（约 100ms），不进 TUI 启动路径；
 * - 缓存：`StoredChatMessage` 内容不可变，按消息 id 记账，判定只算新增消息；
 * - 回退：词表不可用、或模型不是 DeepSeek 系（各家 tokenizer 不同）时，
 *   退回 `token-estimator.ts` 的启发式估算，保证调用方永远拿得到值。
 *
 * 纯 JS 实现（`deepseek-tokenizer.ts`）：不依赖原生模块，单文件分发时零磁盘写入。
 * 对外仍为 async，与既有调用链保持一致。
 */

import fs from "node:fs";
import { getRuntimeConfig } from "../config/index.js";
import path from "node:path";
import tokenizerFile from "../../assets/deepseek-v4-tokenizer.tokjson" with { type: "file" };
import { DeepSeekTokenizer, type TokenizerJSON } from "./deepseek-tokenizer.js";
import type { ChatMessage, ConversationTurn, StoredChatMessage } from "../types/session.js";
import {
    estimateContentMediaTokens,
    estimateMediaTokens,
    estimateTextTokens,
    getReasoningContent,
    splitContentParts,
} from "./token-estimator.js";

/** 单条消息的结构开销（role / 分隔符），真实分词只数内容，这部分按常数补。 */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** 单条 tool_call 的结构开销（type / 字段名）。 */
const TOOL_CALL_OVERHEAD_TOKENS = 10;

let loading: Promise<DeepSeekTokenizer | null> | undefined;
/**
 * 已精确统计过的消息，键 = 消息 id + 模型 + 内容长度。
 *
 * 同一条消息可能以两种形态参与计数：原文（会话历史）与投影后的截取版（构造请求前）。
 * 两者 id 相同而内容不同，键里必须带内容指纹，否则先算的那种会污染另一种，
 * 压缩判定（投影口径）与压缩切分（原文口径）会互相给出错误结果。
 */
const messageCache = new Map<string, number>();
const MESSAGE_CACHE_MAX_ENTRIES = 20_000;

function messageCacheKey(message: ChatMessage | StoredChatMessage, model?: string): string | undefined {
    const id = "id" in message ? message.id : undefined;
    if (!id) return undefined;
    const contentLength = typeof message.content === "string" ? message.content.length : -1;
    return `${id}|${model ?? ""}|${contentLength}`;
}

function rememberMessageTokens(key: string, tokens: number): void {
    if (messageCache.size >= MESSAGE_CACHE_MAX_ENTRIES) {
        const oldest = messageCache.keys().next().value;
        if (oldest !== undefined) messageCache.delete(oldest);
    }
    messageCache.set(key, tokens);
}

/** 关闭真分词（诊断/测试用）：`runtime.tokenizer: false`。 */
function tokenizerDisabled(): boolean {
    return !getRuntimeConfig().tokenizer;
}

/** 真分词只对 DeepSeek 系精确：其它 provider 应该带自己的 tokenizer 或退回估算。 */
export function supportsRealTokenizer(model?: string): boolean {
    if (!model) return true;
    return model.toLowerCase().includes("deepseek");
}

/** 词表随 bundle 一起分发：相对路径按 bundle 目录解析（file loader 在构建后给的是相对路径）。 */
function resolveTokenizerFile(): string {
    return path.isAbsolute(tokenizerFile) ? tokenizerFile : path.resolve(import.meta.dir, tokenizerFile);
}

/** 懒加载分词器；失败只警告一次，之后永久走回退路径。 */
export function loadTokenizer(): Promise<DeepSeekTokenizer | null> {
    loading ??= loadTokenizerOnce();
    return loading;
}

function loadTokenizerOnce(): Promise<DeepSeekTokenizer | null> {
    return (async (): Promise<DeepSeekTokenizer | null> => {
        try {
            return new DeepSeekTokenizer(readTokenizerJSON());
        } catch (error) {
            console.warn("⚠️ [tokenizer] 加载失败，回退启发式估算:", (error as Error)?.message ?? error);
            return null;
        }
    })();
}

/**
 * 读取词表 JSON。
 * 单文件分发时启动器经 fd 注入，直接从内存解析；否则读随包分发的文件。
 */
function readTokenizerJSON(): TokenizerJSON {
    const file = resolveTokenizerFile();
    if (!fs.existsSync(file)) throw new Error(`词表文件不存在: ${file}`);
    return JSON.parse(fs.readFileSync(file, "utf8")) as TokenizerJSON;
}


/** 文本的精确 token 数；分词器不可用或模型不匹配时回退启发式估算。 */
export async function countTextTokens(text: string, model?: string): Promise<number> {
    if (!text) return 0;
    if (tokenizerDisabled() || !supportsRealTokenizer(model)) return estimateTextTokens(text);

    const tokenizer = await loadTokenizer();
    if (!tokenizer) return estimateTextTokens(text);

    const ids = tokenizer.encode(text);
    return ids.length > 0 ? ids.length : estimateTextTokens(text);
}

/** 单条消息的精确 token 数（内容 + 思维链 + tool_calls 参数 + 媒体估值 + 结构开销）。 */
async function countMessageTokens(
    message: ChatMessage | StoredChatMessage,
    model?: string,
): Promise<number> {
    const cacheKey = messageCacheKey(message, model);
    const cached = cacheKey ? messageCache.get(cacheKey) : undefined;
    if (cached !== undefined) return cached;

    let tokens = MESSAGE_OVERHEAD_TOKENS;
    // user 消息带图时 content 是内容数组：文本照常分词，图片/音频按固定档位估值
    const parts = splitContentParts(message.content);
    for (const text of parts.texts) tokens += await countTextTokens(text, model);
    tokens += estimateContentMediaTokens(parts);
    // reasoning_content 随 assistant 消息上行并计入上游输入，漏算会让判定低估整段思维链
    const reasoning = getReasoningContent(message);
    if (reasoning) tokens += await countTextTokens(reasoning, model);
    tokens += estimateMediaTokens(message);
    if ("tool_calls" in message && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
            tokens += TOOL_CALL_OVERHEAD_TOKENS;
            if (call.function?.name) tokens += await countTextTokens(call.function.name, model);
            if (call.function?.arguments) tokens += await countTextTokens(call.function.arguments, model);
            if (call.custom?.name) tokens += await countTextTokens(call.custom.name, model);
            if (typeof call.custom?.input === "string") tokens += await countTextTokens(call.custom.input, model);
        }
    }

    if (cacheKey) rememberMessageTokens(cacheKey, tokens);
    return tokens;
}

/** 一组消息的精确 token 数。 */
export async function countMessagesTokens(
    messages: Array<ChatMessage | StoredChatMessage>,
    model?: string,
): Promise<number> {
    let total = 0;
    for (const message of messages) total += await countMessageTokens(message, model);
    return total;
}

/** 一组回合的精确 token 数。 */
export async function countTurnsTokens(turns: ConversationTurn[], model?: string): Promise<number> {
    let total = 0;
    for (const turn of turns) {
        total += await countMessagesTokens(turn.messages, model);
    }
    return total;
}
