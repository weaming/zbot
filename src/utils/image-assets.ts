import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { getRuntimeConfig } from "../config/index.js";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import axios from "axios";
import type {
    DeepSeekFileContent,
    ImageAssetRef,
    ImageDataRef,
    ImageUrlRef,
    UserContent,
} from "../types/image.js";
import { getSessionsDir, getStateDir } from "./runtime-paths.js";
import { sanitizeSessionId } from "./session-id.js";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function getImageAssetsDir(sessionId?: string): string {
    if (sessionId === undefined) return getStateDir("assets", "images");
    const safeId = sanitizeSessionId(sessionId);
    if (!safeId || safeId !== sessionId) throw new Error(`会话 ID 无效：${sessionId}`);
    return getSessionsDir("assets", safeId);
}

function detectImageType(input: Buffer, filename: string): {
    mimeType: ImageAssetRef["mimeType"];
    extension: string;
} {
    if (input.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
        return { mimeType: "image/jpeg", extension: ".jpg" };
    }
    if (input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        return { mimeType: "image/png", extension: ".png" };
    }
    if (input.subarray(0, 4).toString("ascii") === "GIF8") {
        return { mimeType: "image/gif", extension: ".gif" };
    }
    if (input.subarray(0, 4).toString("ascii") === "RIFF" && input.subarray(8, 12).toString("ascii") === "WEBP") {
        return { mimeType: "image/webp", extension: ".webp" };
    }

    const extension = path.extname(filename).toLowerCase();
    const mimeTypeByExtension: Record<string, ImageAssetRef["mimeType"]> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
    };
    const mimeType = mimeTypeByExtension[extension];
    if (!mimeType) throw new Error("无法识别图片格式");
    return { mimeType, extension: extension === ".jpeg" ? ".jpg" : extension };
}

/** 将图片原文件写入资产目录，调用方只拿到可复用的本地引用。 */
async function writeImageAsset(
    input: Buffer,
    filename: string,
    mimeType: string,
    extension: string,
    sessionId?: string,
): Promise<ImageAssetRef> {
    const digest = crypto.createHash("sha256").update(input).digest("hex");
    const id = `img_${digest.slice(0, 20)}`;
    const assetPath = path.join(getImageAssetsDir(sessionId), `${id}${extension}`);

    await fs.promises.mkdir(path.dirname(assetPath), { recursive: true });
    if (!fs.existsSync(assetPath)) {
        const tempPath = `${assetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        try {
            await fs.promises.writeFile(tempPath, input);
            await fs.promises.rename(tempPath, assetPath);
        } finally {
            await fs.promises.rm(tempPath, { force: true });
        }
    }

    return {
        id,
        path: assetPath,
        filename: path.basename(filename) || "clipboard.jpg",
        mimeType,
        sizeBytes: input.length,
    };
}

export async function createImageAsset(input: Buffer, filename = "clipboard.jpg"): Promise<ImageAssetRef> {
    if (input.length > MAX_IMAGE_BYTES) throw new Error("图片大小超过 32 MiB");
    const imageType = detectImageType(input, filename);
    return writeImageAsset(input, filename, imageType.mimeType, imageType.extension);
}

/** 工具图片按会话落盘；内容哈希保证同一会话中的重复图片只保存一次。 */
export async function createToolImageAsset(
    input: Buffer,
    filename: string,
    mimeType: string,
    sessionId?: string,
): Promise<ImageAssetRef> {
    if (!mimeType.startsWith("image/")) throw new Error(`工具图片 MIME 类型无效：${mimeType}`);
    const subtype = mimeType.slice(6).split(/[+;]/, 1)[0]?.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const extension = subtype === "jpeg" ? ".jpg" : `.${subtype || "bin"}`;
    const displayFilename = `${path.parse(filename).name || "tool-image"}${extension}`;
    return writeImageAsset(input, displayFilename, mimeType, extension, sessionId);
}

export async function deleteSessionImageAssets(sessionId: string): Promise<void> {
    await fs.promises.rm(getImageAssetsDir(sessionId), { recursive: true, force: true });
}

/** 把本地图片或外部图片引用转换为 OpenAI 兼容的图片内容块。 */
function materializeImageAsset(image: ImageAssetRef): unknown {
    try {
        const data = fs.readFileSync(image.path).toString("base64");
        return {
            type: "image_url" as const,
            image_url: {
                url: `data:${image.mimeType};base64,${data}`,
                detail: "original" as const,
            },
        };
    } catch (error: any) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
        return {
            type: "text" as const,
            text: `[图片文件不可用：${image.path}]`,
        };
    }
}

function materializeImageContent(content: UserContent): unknown {
    if (typeof content === "string") return content;

    return Promise.all(content.map(async block => {
        if (block.type === "text") return block;
        if (block.type === "image_url") {
            return {
                type: "image_url" as const,
                image_url: { url: block.image.url },
            };
        }
        if (block.type === "image_data") {
            return {
                type: "image_url" as const,
                image_url: {
                    url: `data:${block.image.mimeType};base64,${block.image.data}`,
                    detail: "original" as const,
                },
            };
        }

        if (block.type === "image_asset") {
            return materializeImageAsset(block.image);
        }

        // 非图片块（如 input_audio）原样透传：这里曾无条件兜底成图片资产，会把音频块读成 undefined.path 抛错
        return block;
    }));
}

export async function materializeImageMessages(messages: any[]): Promise<any[]> {
    return Promise.all(messages.map(async message => {
        if (message?.role !== "user" || typeof message.content === "string") return message;
        return { ...message, content: await materializeImageContent(message.content) };
    }));
}

const DEEPSEEK_FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEEPSEEK_FILE_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_DEEPSEEK_FILES_API = "https://api.deepseek.com/files";
const deepSeekFileIds = new Map<string, { promise: Promise<string>; expiresAt: number }>();
const DEEPSEEK_MAX_IMAGE_SIDE = 4096;

interface DeepSeekFileResponse {
    id?: string;
    file_id?: string;
}

export interface DeepSeekFileUploadOptions {
    filesAPI?: string;
    apiKey?: string;
}

async function resizeDeepSeekImage(
    data: Buffer,
    filename: string,
    mimeType: string,
    maxSide: number,
): Promise<ImageDataRef> {
    const safeFilename = path.basename(filename) || "image.bin";
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "zbot-image-"));
    const inputPath = path.join(tempDir, safeFilename);
    const outputPath = path.join(tempDir, "resized.jpg");

    try {
        await fs.promises.writeFile(inputPath, data);
        let width: number;
        let height: number;

        if (process.platform === "darwin") {
            const result = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", inputPath]);
            const dimensions = [...result.stdout.matchAll(/pixel(Width|Height):\s*(\d+)/g)];
            width = Number(dimensions.find(match => match[1] === "Width")?.[2]);
            height = Number(dimensions.find(match => match[1] === "Height")?.[2]);
        } else {
            const result = await execFileAsync("magick", ["identify", "-format", "%w %h", inputPath]);
            [width, height] = result.stdout.trim().split(/\s+/).map(Number);
        }

        if (!width || !height) throw new Error(`无法读取图片尺寸：${filename}`);
        if (Math.max(width, height) <= maxSide) {
            return {
                id: crypto.createHash("sha256").update(data).digest("hex"),
                data: data.toString("base64"),
                filename,
                mimeType,
            };
        }

        if (process.platform === "darwin") {
            await execFileAsync("sips", [
                "-Z", String(maxSide), "-s", "format", "jpeg", "-s", "formatOptions", "90",
                inputPath, "--out", outputPath,
            ]);
        } else {
            await execFileAsync("magick", [inputPath, "-resize", `${maxSide}x${maxSide}>`, "-quality", "90", outputPath]);
        }

        const resized = await fs.promises.readFile(outputPath);
        return {
            id: crypto.createHash("sha256").update(resized).digest("hex"),
            data: resized.toString("base64"),
            filename: `${path.parse(safeFilename).name || "image"}.jpg`,
            mimeType: "image/jpeg",
        };
    } catch (error: any) {
        if (error?.code === "ENOENT") {
            const tool = process.platform === "darwin" ? "sips" : "ImageMagick（magick）";
            throw new Error(`图片处理需要安装 ${tool}`);
        }
        throw error;
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
}

async function readImageUrl(image: ImageUrlRef): Promise<ImageDataRef> {
    const match = image.url.match(/^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i);
    if (!match) throw new Error(`无法解析图片数据：${image.filename}`);
    const data = Buffer.from(match[2]!, "base64");
    return {
        id: crypto.createHash("sha256").update(data).digest("hex"),
        data: data.toString("base64"),
        filename: image.filename,
        mimeType: match[1]!,
    };
}

/** 返回 DeepSeek Files API 地址；自定义部署可在 config.yaml 里覆盖。 */
export function resolveDeepSeekFilesAPI(_apiBase?: string): string {
    const configured = getRuntimeConfig().deepseekFilesApi?.trim();
    return configured || DEFAULT_DEEPSEEK_FILES_API;
}

/** 向由部署方负责鉴权的 Files API 上传原始图片。 */
export async function uploadDeepSeekFile(
    imagePath: string,
    options?: DeepSeekFileUploadOptions,
): Promise<string> {
    const data = await fs.promises.readFile(imagePath);
    return uploadDeepSeekFileData(
        data,
        path.basename(imagePath) || "image.jpg",
        "application/octet-stream",
        options,
    );
}

/** 向 Files API 上传内存中的图片数据。 */
export async function uploadDeepSeekFileData(
    data: string | Buffer,
    filename: string,
    mimeType: string,
    options?: DeepSeekFileUploadOptions,
): Promise<string> {
    const filesAPI = options?.filesAPI?.trim() || resolveDeepSeekFilesAPI();
    if (!filesAPI) {
        throw new Error("无法确定 DeepSeek Files API，请在 config.yaml 里设置 runtime.deepseekFilesApi");
    }

    const fileData = typeof data === "string" ? Buffer.from(data, "base64") : data;
    const boundary = `zbot-${crypto.randomUUID()}`;
    const safeFilename = path.basename(filename) || "image.jpg";
    const escapedFilename = safeFilename.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    const field = (name: string, value: string): Buffer => Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );
    const fileHeader = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${escapedFilename}"\r\n` +
        `Content-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`,
    );
    const body = Buffer.concat([
        field("purpose", "user_data"),
        field("expires_after[anchor]", "created_at"),
        field("expires_after[seconds]", String(7 * 24 * 60 * 60)),
        fileHeader,
        fileData,
        Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    let response;
    try {
        response = await axios.post<DeepSeekFileResponse>(filesAPI, body, {
            timeout: 10 * 60 * 1000,
            maxBodyLength: body.length,
            headers: {
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "Content-Length": String(body.length),
                ...(options?.apiKey?.trim() ? { Authorization: `Bearer ${options.apiKey.trim()}` } : {}),
            },
            proxy: false,
        });
    } catch (error: any) {
        const status = error.response?.status ? `HTTP ${error.response.status}: ` : "";
        const detail = typeof error.response?.data === "string"
            ? error.response.data
            : error.message;
        throw new Error(`DeepSeek Files API 上传失败（${status}${detail}）`);
    }

    const fileID = response.data.id || response.data.file_id;
    if (!fileID) {
        throw new Error("DeepSeek Files API 响应缺少 file_id");
    }
    return fileID;
}

/** 将图片上传到 DeepSeek Files API，并在当前进程内复用七天有效的 file_id。 */
export async function materializeDeepSeekImageMessages(
    messages: any[],
    uploadFile: (image: ImageAssetRef | ImageDataRef) => Promise<string>,
): Promise<any[]> {
    const uploadImage = async (image: ImageAssetRef | ImageDataRef): Promise<string> => {
        const cached = deepSeekFileIds.get(image.id);
        const now = Date.now();
        let fileIdPromise = cached && cached.expiresAt > now
            ? cached.promise
            : undefined;
        if (!fileIdPromise) {
            fileIdPromise = uploadFile(image);
            deepSeekFileIds.set(image.id, {
                promise: fileIdPromise,
                expiresAt: now + DEEPSEEK_FILE_TTL_MS - DEEPSEEK_FILE_REFRESH_MARGIN_MS,
            });
            void fileIdPromise.catch(() => deepSeekFileIds.delete(image.id));
        }
        return fileIdPromise;
    };

    return Promise.all(messages.map(async message => {
        if (message?.role !== "user" || typeof message.content === "string") return message;

        const content = await Promise.all(message.content.map(async (block: any) => {
            if (block.type === "text") return block;
            if (block.type === "file") return block;

            if (block.type === "image_url") {
                if (!block.image.url.startsWith("data:")) {
                    return {
                        type: "image_url" as const,
                        image_url: { url: block.image.url },
                    };
                }

                const image = await readImageUrl(block.image);
                const prepared = await resizeDeepSeekImage(
                    Buffer.from(image.data, "base64"),
                    image.filename,
                    image.mimeType,
                    DEEPSEEK_MAX_IMAGE_SIDE,
                );
                if (prepared.id === image.id) {
                    return {
                        type: "image_url" as const,
                        image_url: { url: block.image.url },
                    };
                }
                const fileId = await uploadImage(prepared);
                return {
                    type: "file",
                    file_id: fileId,
                } satisfies DeepSeekFileContent;
            }

            if (block.type === "image_asset") {
                let data: Buffer;
                try {
                    data = await fs.promises.readFile(block.image.path);
                } catch (error: any) {
                    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
                    return materializeImageAsset(block.image);
                }
                const prepared = await resizeDeepSeekImage(
                    data,
                    block.image.filename,
                    block.image.mimeType,
                    DEEPSEEK_MAX_IMAGE_SIDE,
                );
                if (prepared.id !== crypto.createHash("sha256").update(data).digest("hex")) {
                    return {
                        type: "image_url" as const,
                        image_url: {
                            url: `data:${prepared.mimeType};base64,${prepared.data}`,
                            detail: "original" as const,
                        },
                    };
                }
                return materializeImageAsset(block.image);
            }

            if (block.type === "image_data") {
                const prepared = await resizeDeepSeekImage(
                    Buffer.from(block.image.data, "base64"),
                    block.image.filename,
                    block.image.mimeType,
                    DEEPSEEK_MAX_IMAGE_SIDE,
                );
                const fileId = await uploadImage(prepared);
                return {
                    type: "file",
                    file_id: fileId,
                } satisfies DeepSeekFileContent;
            }

            return block;
        }));
        return { ...message, content };
    }));
}
