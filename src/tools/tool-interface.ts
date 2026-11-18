import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createToolImageAsset } from "../utils/image-assets.js";
import { SUPPORTED_IMAGE_MIME_TYPES, type ImageAssetContent, type ImageDataContent } from "../types/image.js";
import type { ToolResultPolicy } from "../types/session.js";
import { AUDIO_MIME_TO_FORMAT, type AudioContent } from "../types/audio.js";

export type ToolImageContent = ImageAssetContent | ImageDataContent;

export interface ToolContentBlock {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    path?: string;
    [key: string]: any;
}

export interface ToolExecutionResult {
    content: ToolContentBlock[];
    isError?: boolean;
    contextPolicy?: ToolResultPolicy;
    _fullHistory?: any[]; // OpenAI-orchestrator 返回完整对话历史（可选）
}

export interface ToolExecutionOutput {
    content: string;
    imageContent?: ToolImageContent[];
    audioContent?: AudioContent[];
    contextPolicy?: ToolResultPolicy;
    /** 工具自己判定失败（非零退出码、校验不过等）。抛异常之外的失败必须走这里，否则调度层看不见。 */
    isError?: boolean;
}

export type ToolExecutionResponse = string | ToolExecutionOutput;

export interface ExecutableTool {
    name: string;
    description?: string;
    tags?: string[];
    source?: string;
    inputSchema: any;
    execute: (args: any, signal?: AbortSignal) => Promise<ToolExecutionResult>;
    /** 来源 MCP server 名（同步时用于按 server 清理过期工具） */
    fromServer?: string;
    /** 内部标记：MCP 配置 defer=true；仅 Responses tool_search 请求会投影为 defer_loading。 */
    deferLoading?: boolean;
    /**
     * 内部标记：MCP 配置 lazy=true。模型不支持 tool_search 时默认不下发，
     * 只有该工具所属 server 在本会话被临时启用（/mcp）才进入工具定义。
     */
    lazy?: boolean;
    /** 工具级默认策略：结果要求完整保留时声明（如读文件、补丁、代码探索），执行结果可覆盖。 */
    contextPolicy?: ToolResultPolicy;
    /**
     * 会话级工具：默认不下发给模型，只有调用方按会话显式请求时才注入。
     */
    sessionScoped?: boolean;
}

export function ok(text: string): ToolExecutionResult {
    return { content: [{ type: "text", text }] };
}

export function err(text: string): ToolExecutionResult {
    return { content: [{ type: "text", text }], isError: true };
}

export function normalizeToolContent(content: any): ToolContentBlock[] {
    if (!Array.isArray(content)) return [];

    return content.map((item) => {
        if (!item || typeof item !== "object") {
            return { type: "text", text: String(item ?? "") };
        }

        const block: ToolContentBlock = { ...item };
        if (!block.type) {
            if (typeof block.text === "string") {
                block.type = "text";
            } else {
                return { type: "text", text: JSON.stringify(item) };
            }
        }

        return block;
    });
}

/** @public */
export function toolContentToText(content: ToolContentBlock[]): string {
    return normalizeToolContent(content)
        .map((block) => {
            if (block.type === "text") return String(block.text ?? "");
            if (block.type === "image" || block.type === "audio" || block.type === "blob") {
                const mimeType = block.mimeType || "application/octet-stream";
                const size = typeof block.data === "string" ? block.data.length : 0;
                return `[${block.type} ${mimeType} base64_chars=${size}]`;
            }
            if (typeof block.text === "string") return block.text;
            return JSON.stringify(block);
        })
        .filter(Boolean)
        .join("\n");
}

export function toolResultToText(result: ToolExecutionResult): string {
    return toolContentToText(result.content);
}

/** mime 归一化：去参数（`;charset=`）、小写，并纠正非标准别名。 */
function normalizeMimeType(mimeType?: string): string {
    const base = (mimeType ?? "").split(/[+;]/, 1)[0]?.trim().toLowerCase() ?? "";
    // 上游官方只接受 image/jpeg，image/jpg 会 400
    return base === "image/jpg" || base === "image/pjpeg" ? "image/jpeg" : base;
}

/**
 * 媒体块分区：提取与「未上行」说明共用同一份谓词，避免两侧口径漂移。
 *
 * 三档：格式支持且载荷可用（supported）、格式不被上游接受（unsupported）、
 * mime 合法但既无 data 也无 path（unusable，提取不出任何内容）。
 */
export interface ToolMediaPartition {
    supportedImages: ToolContentBlock[];
    unsupportedImages: ToolContentBlock[];
    unusableImages: ToolContentBlock[];
    supportedAudios: ToolContentBlock[];
    unsupportedAudios: ToolContentBlock[];
    unusableAudios: ToolContentBlock[];
}

/**
 * 载荷是否可用于提取。
 * 音频没有按路径上行的通道（只吃内联 base64），因此 path 只对图片算可用；
 * 空字符串同理不算 —— 否则会生成 0 字节资产，上游收到 `base64,` 后 4xx。
 */
function hasUsablePayload(block: ToolContentBlock, allowPath: boolean): boolean {
    if (typeof block.data === "string" && block.data.length > 0) return true;
    return allowPath && Boolean(block.path);
}

export function partitionToolMedia(content: ToolContentBlock[]): ToolMediaPartition {
    const partition: ToolMediaPartition = {
        supportedImages: [],
        unsupportedImages: [],
        unusableImages: [],
        supportedAudios: [],
        unsupportedAudios: [],
        unusableAudios: [],
    };

    for (const block of normalizeToolContent(content)) {
        const isImage = block.type === "image";
        if (!isImage && block.type !== "audio") continue;

        const mime = normalizeMimeType(block.mimeType);
        const supported = isImage
            ? SUPPORTED_IMAGE_MIME_TYPES.has(mime)
            // 用 hasOwn：`"constructor" in obj` 会沿原型链命中，静默放行无效 mime
            : Object.hasOwn(AUDIO_MIME_TO_FORMAT, mime);

        if (!supported) {
            (isImage ? partition.unsupportedImages : partition.unsupportedAudios).push(block);
        } else if (!hasUsablePayload(block, isImage)) {
            (isImage ? partition.unusableImages : partition.unusableAudios).push(block);
        } else {
            (isImage ? partition.supportedImages : partition.supportedAudios).push(block);
        }
    }
    return partition;
}

/**
 * 提取工具结果里的音频块，转成 OpenAI `input_audio` 可用的形态。
 * 仅 wav/mp3 可上行；其余容器不入列，由调用方在结果里说明。
 */
export function toolContentToAudioContent(content: ToolContentBlock[]): AudioContent[] {
    return partitionToolMedia(content).supportedAudios.flatMap((block): AudioContent[] => {
        if (typeof block.data !== "string") return [];
        const mime = normalizeMimeType(block.mimeType);
        if (!Object.hasOwn(AUDIO_MIME_TO_FORMAT, mime)) return [];
        return [{ data: block.data, format: AUDIO_MIME_TO_FORMAT[mime]! }];
    });
}

/** 将工具返回的图片转换为可在后续模型请求中恢复的图片引用。 */
export async function toolContentToImageContent(content: ToolContentBlock[], sessionId?: string): Promise<ToolImageContent[]> {
    const images = await Promise.all(
        partitionToolMedia(content).supportedImages.map(async (block, index): Promise<ToolImageContent[]> => {
            const mimeType = normalizeMimeType(block.mimeType);

            // 空 base64 不算可用数据：交给下面的 path 分支按文件读取
            if (typeof block.data === "string" && block.data.length > 0) {
                const filename = block.path ? path.basename(block.path) : `tool-image-${index + 1}`;
                const image = await createToolImageAsset(Buffer.from(block.data, "base64"), filename, mimeType, sessionId);
                return [{ type: "image_asset", image } satisfies ImageAssetContent];
            }

            if (block.path) {
                try {
                    const input = await fs.promises.readFile(block.path);
                    const image = await createToolImageAsset(input, path.basename(block.path), mimeType, sessionId);
                    return [{ type: "image_asset", image } satisfies ImageAssetContent];
                } catch (error: any) {
                    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
                }
                return [{
                    type: "image_asset" as const,
                    image: {
                        id: `tool_path_${createHash("sha256").update(block.path).digest("hex").slice(0, 20)}`,
                        path: block.path,
                        filename: path.basename(block.path),
                        mimeType,
                        sizeBytes: 0,
                    },
                } satisfies ImageAssetContent];
            }

            return [];
        }),
    );
    return images.flat();
}

const JSON_COMPACTION_TOOL_KEYWORDS = [
    'longport',
    'jin10',
    'news',
    'weather',
    'qweather',
    'caiyun',
    'amap',
    'okx',
    'quote',
    'calendar',
];

/** 仅压缩结构化数据查询工具的 JSON 输出，保留文件与命令工具的原始文本格式。 */
export function canCompactJsonToolOutput(toolName: string): boolean {
    const normalizedToolName = toolName.toLowerCase();
    return JSON_COMPACTION_TOOL_KEYWORDS.some((keyword) => normalizedToolName.includes(keyword));
}

/** 对白名单工具的完整 JSON 对象或数组进行无损紧凑序列化，其他文本保持原样。 */
export function compactJsonToolOutput(text: string, toolName: string): string {
    if (!canCompactJsonToolOutput(toolName)) return text;
    try {
        const value = JSON.parse(text);
        if (!Array.isArray(value) && (value === null || typeof value !== 'object')) {
            return text;
        }
        return JSON.stringify(value);
    } catch {
        return text;
    }
}

/** 单条工具输出上限：一条消息就能把会话日志撑到几十 MB，这里兜住。 */
const MAX_TOOL_OUTPUT_CHARS = 1_000_000;
/** 截断时头部/尾部各占的比例：开头是结构或错误信息，结尾常是结论，中间最可丢。 */
const TOOL_OUTPUT_HEAD_RATIO = 0.7;
const TOOL_OUTPUT_TAIL_RATIO = 0.2;

/**
 * 工具输出的落盘/上送护栏：
 * - 去掉 NUL：二进制垃圾（cat 到图片、日志里的 \0）会被 JSON 转义成 6 字节，
 *   一条 60 MB 的输出里绝大部分都是这种转义，对模型也毫无意义；
 * - 超长则保留头尾 + 省略说明，绝不整条塞进会话日志与下一次请求。
 */
export function capToolOutput(text: string, maxChars = MAX_TOOL_OUTPUT_CHARS): string {
    const cleaned = text.includes("\u0000") ? text.replace(/\u0000/g, "") : text;
    if (cleaned.length <= maxChars) return cleaned;

    const headChars = Math.floor(maxChars * TOOL_OUTPUT_HEAD_RATIO);
    const tailChars = Math.floor(maxChars * TOOL_OUTPUT_TAIL_RATIO);
    const omitted = cleaned.length - headChars - tailChars;
    return `${cleaned.slice(0, headChars)}`
        + `\n\n…[工具输出过长，已省略中间 ${omitted} 个字符（原长 ${cleaned.length}）；`
        + "需要完整内容请重跑并缩小范围]\n\n"
        + `${cleaned.slice(-tailChars)}`;
}

/** 音频无法上行时的原因，用于选择说明文案。 */
export type AudioDropReason = "responses" | "endpoint";

/**
 * 图片/音频块无法作为模型可读内容上行时，在工具结果末尾说明具体原因。
 *
 * 否则模型只看到 `[image|audio <mime> base64_chars=N]` 占位符，会误以为内容是空的。
 * 分区来自 partitionToolMedia，与提取端共用同一份谓词，避免「说明」与「实际上行」漂移。
 * provider 能力判定留在调用方（audioDropReason），本函数只依赖内容本身。
 */
export function describeDroppedMedia(
    content: ToolContentBlock[],
    options: { audioDropReason?: AudioDropReason } = {},
): string | undefined {
    const partition = partitionToolMedia(content);
    const reasons: string[] = [];
    let dropped = 0;

    const total = partition.supportedImages.length + partition.unsupportedImages.length
        + partition.unusableImages.length
        + partition.supportedAudios.length + partition.unsupportedAudios.length
        + partition.unusableAudios.length;

    const unusable = partition.unusableImages.length + partition.unusableAudios.length;
    if (unusable > 0) {
        dropped += unusable;
        reasons.push(`${unusable} 个媒体块未携带可上行内容（无内联 base64 数据）`);
    }

    if (partition.unsupportedImages.length > 0) {
        dropped += partition.unsupportedImages.length;
        reasons.push(
            `已跳过不支持的图片格式 ${listMimeTypes(partition.unsupportedImages)}`
            + `（仅 ${SUPPORTED_IMAGE_FORMATS} 可发送）`,
        );
    }

    const rejectedAudio = partition.supportedAudios.length + partition.unsupportedAudios.length;
    if (rejectedAudio > 0) {
        if (options.audioDropReason) {
            // 端点整批拒绝时不再提格式，否则会误导模型换成另一种同样发不出的容器
            dropped += rejectedAudio;
            reasons.push(options.audioDropReason === "responses"
                ? "当前使用 Responses 协议，音频不随工具结果上行"
                : "当前端点不支持音频输入");
        } else if (partition.unsupportedAudios.length > 0) {
            dropped += partition.unsupportedAudios.length;
            reasons.push(
                `已跳过不支持的音频格式 ${listMimeTypes(partition.unsupportedAudios)}`
                + `（仅 ${AUDIO_FORMATS} 可发送）`,
            );
        }
    }

    if (dropped === 0 || reasons.length === 0) return undefined;
    // 分数自带分母说明，避免模型把 1/1 猜成别的东西
    const scope = dropped === total ? "媒体未上行" : "部分媒体未上行";
    return `\n\n[${scope}：${total} 个媒体块中有 ${dropped} 个未能读取。${reasons.join("；")}。以上仅为文件元信息]`;
}

/** 图片可发送的容器列表，直接取自白名单。 */
const SUPPORTED_IMAGE_FORMATS = [...SUPPORTED_IMAGE_MIME_TYPES]
    .map((mime) => mime.split("/")[1] ?? mime)
    .join("/");

/** 音频可发送的容器列表，直接取自格式表。 */
const AUDIO_FORMATS = [...new Set(Object.values(AUDIO_MIME_TO_FORMAT))].join("/");

/** 去重并保留出现顺序，缺失 mime 时统一记为未知格式。 */
function listMimeTypes(blocks: ToolContentBlock[]): string {
    return [...new Set(blocks.map((block) => block.mimeType || "未知格式"))].join("、");
}
