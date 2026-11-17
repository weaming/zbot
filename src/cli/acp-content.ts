/** ACP 内容与宿主输入/历史之间的转换。 */
import { RequestError, type ContentBlock, type SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "../events/agent-events.js";
import type { ImageAssetRef } from "../types/image.js";
import type { ChatMessage } from "../types/session.js";

type ImageSaver = (data: Buffer, filename: string) => Promise<ImageAssetRef>;
const MAX_CONTENT_CHARS = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export async function parseAcpPrompt(blocks: ContentBlock[], saveImage: ImageSaver): Promise<{
    text: string;
    images: ImageAssetRef[];
}> {
    if (blocks.length > 128) throw RequestError.invalidParams(undefined, "prompt 最多 128 个内容块");
    const texts: string[] = [];
    const imageBlocks: Array<{ data: Buffer; filename: string }> = [];
    let totalImageBytes = 0;
    for (const block of blocks) {
        switch (block.type) {
            case "text": texts.push(block.text); break;
            case "resource_link": texts.push(`[资源 ${block.title ?? block.name}] ${block.uri}`); break;
            case "resource": {
                const resource = block.resource;
                if (!("text" in resource)) throw RequestError.invalidParams(undefined, "仅支持内嵌文本资源");
                texts.push(`[资源 ${resource.uri}]\n${resource.text}`);
                break;
            }
            case "image": {
                const extension = new Map([
                    ["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"], ["image/gif", "gif"],
                ]).get(block.mimeType);
                if (!extension || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(block.data)) {
                    throw RequestError.invalidParams(undefined, "图片必须是 PNG/JPEG/WebP/GIF 的 Base64 数据");
                }
                const data = Buffer.from(block.data, "base64");
                totalImageBytes += data.length;
                if (!data.length || totalImageBytes > MAX_IMAGE_BYTES) {
                    throw RequestError.invalidParams(undefined, "图片总大小须在 1 字节至 4 MiB 之间");
                }
                imageBlocks.push({ data, filename: `acp.${extension}` });
                break;
            }
            default: throw RequestError.invalidParams(undefined, `不支持的输入类型: ${block.type}`);
        }
    }
    const text = texts.join("\n\n").trim();
    if (text.length > MAX_CONTENT_CHARS) throw RequestError.invalidParams(undefined, "prompt 文本超过 2 MiB");
    if (!text && !imageBlocks.length) throw RequestError.invalidParams(undefined, "prompt 不能为空");
    const images: ImageAssetRef[] = [];
    for (const image of imageBlocks) images.push(await saveImage(image.data, image.filename));
    return { text: text || "请分析所附图片。", images };
}

/** 长文本分块，保证单条通知不会突破传输层预算。 */
export function* textUpdates(
    text: string,
    sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk",
): Generator<SessionUpdate> {
    const chars = [...text];
    for (let offset = 0; offset < chars.length; offset += 8192) {
        yield { sessionUpdate, content: { type: "text", text: chars.slice(offset, offset + 8192).join("") } };
    }
}

function* messageUpdates(message: ChatMessage): Generator<SessionUpdate> {
    if (message.role === "user") {
        if (typeof message.content === "string") yield* textUpdates(message.content, "user_message_chunk");
        else {
            for (const block of message.content) {
                if (block.type === "text") yield* textUpdates(block.text, "user_message_chunk");
            }
        }
    } else if (message.role === "assistant") {
        if (typeof message.reasoning === "string") yield* textUpdates(message.reasoning, "agent_thought_chunk");
        if (message.content) yield* textUpdates(message.content, "agent_message_chunk");
        for (const call of message.tool_calls ?? []) {
            yield { sessionUpdate: "tool_call", toolCallId: call.id, title: call.function?.name ?? "tool", status: "pending" };
        }
    } else if (message.role === "tool") {
        yield {
            sessionUpdate: "tool_call_update", toolCallId: message.tool_call_id,
            status: message.isError ? "failed" : "completed",
            content: [{ type: "content", content: { type: "text", text: message.content.slice(0, 32_768) } }],
        };
    }
}

export function* historyUpdates(event: AgentEvent): Generator<SessionUpdate> {
    if (event.type === "user_message") yield* textUpdates(event.payload.text, "user_message_chunk");
    if (event.type === "turn_message") {
        // 用户输入已有独立事实，避免重放两次。
        if (event.payload.message.role !== "user") yield* messageUpdates(event.payload.message);
    }
    if (event.type === "standalone_turn" && !event.payload.injected) {
        for (const message of event.payload.messages) yield* messageUpdates(message);
    }
}
