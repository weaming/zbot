/**
 * 图片输入能力：某个接入端收不收图片，以及收不了时怎么把图片降级成文本。
 *
 * 能力来自 provider 配置（`imageInput` / `textOnlyModels`），本模块不内置模型名单：
 * 同一个模型经不同网关的能力可能不同，且上游能力会随版本变化，写死在代码里必然过期。
 * 只回答「能不能收图片」这一件事：音频能力见 `turn-request.ts`，图片上传见 `utils/image-assets.ts`。
 */

import type { ChatMessage } from "../../types/session.js";

/** 接入端的图片能力：省略即「接受图片」。 */
export interface ImageInputCapability {
    /** provider 级开关：显式 `false` 时整台接入端都不发图片。 */
    imageInput?: boolean;
    /** 纯文本模型名关键词（调用方已小写）：命中即视为不吃图片。 */
    textOnlyModels?: readonly string[];
}

/** 图片被去掉后替进原文位置的说明，让模型知道内容存在但没收到。 */
const DROPPED_IMAGE_TEXT = "[图片已移除：当前模型不支持图片输入]";

/** 图片块在本模块认得的形态（含 Responses 的 `input_image` 投影）。 */
const IMAGE_BLOCK_TYPES: ReadonlySet<string> = new Set(["image_url", "input_image", "image_asset", "image_data"]);

/** 判定接入端是否接受图片内容块：provider 开关优先，其次模型名单，都没有就收。 */
export function supportsImageInput(model: string, capability: ImageInputCapability = {}): boolean {
    if (capability.imageInput === false) return false;
    const name = model.toLowerCase();
    return !(capability.textOnlyModels ?? []).some(hint => name.includes(hint));
}

/** 消息里的图片块（没有数组型内容、或不含图片时返回 undefined）。 */
function imageBlocks(message: ChatMessage): any[] | undefined {
    if (typeof message.content === "string" || !Array.isArray(message.content)) return undefined;
    const content = message.content as any[];
    return content.some(block => IMAGE_BLOCK_TYPES.has(block?.type)) ? content : undefined;
}

/**
 * 接入端收不了图片时把图片块降级成文本说明，其余块原样保留。
 * 收得下或无图片时原样返回，不复制消息，避免抖动请求前缀。
 */
export function dropUnsupportedImages(
    model: string,
    messages: ChatMessage[],
    capability: ImageInputCapability = {},
): ChatMessage[] {
    if (supportsImageInput(model, capability)) return messages;

    let changed = false;
    const dropped: ChatMessage[] = messages.map((message): ChatMessage => {
        if (message.role === "tool" && message.imageContent?.length) {
            changed = true;
            const { imageContent: _imageContent, ...textMessage } = message;
            return { ...textMessage, content: `${message.content}\n${DROPPED_IMAGE_TEXT}` };
        }
        const content = imageBlocks(message);
        if (!content) return message;
        changed = true;
        const replaced = content.map(block => IMAGE_BLOCK_TYPES.has(block?.type)
            ? { type: "text" as const, text: DROPPED_IMAGE_TEXT }
            : block);
        // assistant 的 content 只能是文本，消息级 cast 交给这里收口，免得污染整个模块
        return { ...message, content: replaced } as ChatMessage;
    });
    return changed ? dropped : messages;
}
