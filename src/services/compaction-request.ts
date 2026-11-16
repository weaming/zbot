import type { ChatMessage } from "../types/session.js";
import { isRequestBodyTooLargeError } from "../utils/provider-context-limit.js";

const MAX_SPLIT_DEPTH = 8;
const MAX_REQUESTS = 32;

interface CompactionResponse {
    content: string;
}

interface CompactionRequestOptions<Response extends CompactionResponse> {
    history: ChatMessage[];
    run: (history: ChatMessage[]) => Promise<Response>;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
}

/** 按字节平衡切分历史，工具调用与连续结果保持在同一组内。 */
function splitHistory(history: ChatMessage[]): [ChatMessage[], ChatMessage[]] | undefined {
    const sizes = history.map(message => Buffer.byteLength(JSON.stringify(message)));
    const totalBytes = sizes.reduce((total, size) => total + size, 0);
    let prefixBytes = 0;
    let bestDistance = Infinity;
    let splitIndex = 0;

    for (let index = 1; index < history.length; index++) {
        prefixBytes += sizes[index - 1]!;
        if (history[index]!.role === "tool") continue;
        const distance = Math.abs(totalBytes / 2 - prefixBytes);
        if (distance >= bestDistance) continue;
        bestDistance = distance;
        splitIndex = index;
    }

    return splitIndex > 0 ? [history.slice(0, splitIndex), history.slice(splitIndex)] : undefined;
}

/** 仅在摘要请求遇到 413 时分段摘要，再合并；全部成功前不交付部分结果。 */
export async function runCompactionRequest<Response extends CompactionResponse>(
    options: CompactionRequestOptions<Response>,
): Promise<Response> {
    let requests = 0;
    return summarize(options.history, 0);

    async function summarize(history: ChatMessage[], depth: number): Promise<Response> {
        if (options.signal?.aborted) throw new DOMException("User terminated the request", "AbortError");
        if (requests >= MAX_REQUESTS) throw new Error("分段压缩请求次数达到上限，请提高网关请求体上限后重试");
        requests++;
        try {
            const response = await options.run(history);
            if (options.signal?.aborted) throw new DOMException("User terminated the request", "AbortError");
            if (!response.content.trim()) throw new Error("上下文压缩结果为空");
            return response;
        } catch (error) {
            if (options.signal?.aborted) throw new DOMException("User terminated the request", "AbortError");
            if (!isRequestBodyTooLargeError(error)) throw error;
            const parts = depth < MAX_SPLIT_DEPTH ? splitHistory(history) : undefined;
            if (!parts) {
                throw new Error(
                    "摘要请求超过 provider 请求体大小限制（HTTP 413），无法继续安全拆分。"
                    + "请提高网关请求体上限，或减小单条消息、附件及工具定义。",
                    { cause: error },
                );
            }

            options.onProgress?.("🗜️ 摘要请求体超过 provider 大小限制，正在分段压缩并合并...");
            const summaries: ChatMessage[] = [];
            for (const history of parts) {
                const response = await summarize(history, depth + 1);
                summaries.push({
                    role: "user",
                    content: `<conversation_summary_part index="${summaries.length + 1}">\n`
                        + `${response.content.trim()}\n</conversation_summary_part>`,
                });
            }
            return summarize(summaries, depth + 1);
        }
    }
}
