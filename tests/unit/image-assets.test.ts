import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import {
    createImageAsset,
    deleteSessionImageAssets,
    materializeDeepSeekImageMessages,
    materializeImageMessages,
    uploadDeepSeekFile,
} from "../../src/utils/image-assets.js";
import { toolContentToImageContent } from "../../src/tools/tool-interface.js";
import { toUserContent } from "../../src/types/image.js";
import { createTestImageFile, TEST_IMAGE_BYTES } from "./image-fixture.js";

describe("image assets", () => {
    let stateDir: string;
    let previousStateDir: string | undefined;

    beforeEach(() => {
        stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-image-assets-"));
        previousStateDir = process.env.ZBOT_STATE_DIR;
        process.env.ZBOT_STATE_DIR = stateDir;
    });

    afterEach(() => {
        if (previousStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
        else process.env.ZBOT_STATE_DIR = previousStateDir;
        fs.rmSync(stateDir, { recursive: true, force: true });
    });

    test("落盘时保留原始图片格式与字节", async () => {
        const originalPath = createTestImageFile(stateDir);
        const original = fs.readFileSync(originalPath);
        const asset = await createImageAsset(original, "test-image.png");

        expect(asset.mimeType).toBe("image/png");
        expect(asset.sizeBytes).toBe(original.length);
        expect(fs.existsSync(asset.path)).toBe(true);
        expect(fs.readFileSync(asset.path).subarray(0, 8)).toEqual(TEST_IMAGE_BYTES.subarray(0, 8));
        expect(fs.readFileSync(asset.path)).toEqual(original);
        expect(asset.path).not.toBe(originalPath);
    });

    test("工具图片按会话落盘并复用，历史消息只保存引用", async () => {
        const blocks = [{
            type: "image",
            data: "aGVsbG8=",
            mimeType: "image/png",
            path: "/missing/external/image.png",
        }];
        const imageContent = await toolContentToImageContent(blocks, "session-one");
        const second = await toolContentToImageContent(blocks, "session-one");
        const otherSession = await toolContentToImageContent(blocks, "session-two");

        expect(imageContent).toHaveLength(1);
        expect(imageContent[0]).toMatchObject({
            type: "image_asset",
            image: {
                mimeType: "image/png",
            },
        });
        expect(second).toEqual(imageContent);
        const image = (imageContent[0] as { image: { path: string } }).image;
        expect(fs.readFileSync(image.path).toString()).toBe("hello");
        expect(JSON.stringify(imageContent)).not.toContain("aGVsbG8=");

        const request = await materializeImageMessages([{ role: "user", content: imageContent }]);
        expect(request[0].content[0].image_url.url).toBe("data:image/png;base64,aGVsbG8=");

        await deleteSessionImageAssets("session-one");
        expect(fs.existsSync(image.path)).toBe(false);
        expect(fs.existsSync((otherSession[0] as { image: { path: string } }).image.path)).toBe(true);
        await expect(deleteSessionImageAssets("../")).rejects.toThrow("会话 ID 无效");
        await expect(deleteSessionImageAssets("")).rejects.toThrow("会话 ID 无效");
    });

    test("历史图片文件不存在时降级为文本，不阻断请求", async () => {
        const missingPath = path.join(stateDir, "deleted.png");
        await expect(materializeImageMessages([{
            role: "user",
            content: [{
                type: "image_asset",
                image: {
                    id: "deleted-image",
                    path: missingPath,
                    filename: "deleted.png",
                    mimeType: "image/png",
                    sizeBytes: 10,
                },
            }],
        }])).resolves.toEqual([{
            role: "user",
            content: [{ type: "text", text: `[图片文件不可用：${missingPath}]` }],
        }]);
    });

    test("旧会话内嵌图片仍能发送给模型", async () => {
        const messages = await materializeImageMessages([{
            role: "user",
            content: [{
                type: "image_data",
                image: { id: "old", data: "aGVsbG8=", filename: "old.png", mimeType: "image/png" },
            }],
        }]);
        expect(messages[0].content[0].image_url.url).toBe("data:image/png;base64,aGVsbG8=");
    });

    test("只有外部路径的工具图片也复制到会话资产目录", async () => {
        const sourcePath = createTestImageFile(stateDir);
        const content = await toolContentToImageContent([{
            type: "image",
            path: sourcePath,
            mimeType: "image/png",
        }], "session-path-only");
        const assetPath = (content[0] as { image: { path: string } }).image.path;

        expect(assetPath).not.toBe(sourcePath);
        fs.unlinkSync(sourcePath);
        expect(fs.readFileSync(assetPath)).toEqual(TEST_IMAGE_BYTES);
    });

    test("Files API 上传使用原始 multipart 请求并设置三十天有效期", async () => {
        const originalPath = createTestImageFile(stateDir);
        const original = fs.readFileSync(originalPath);
        let requestBody = Buffer.alloc(0);
        let requestHeaders: Record<string, string | string[] | undefined> = {};

        const server = createServer((request, response) => {
            const chunks: Buffer[] = [];
            requestHeaders = request.headers;
            request.on("data", chunk => chunks.push(Buffer.from(chunk)));
            request.on("end", () => {
                requestBody = Buffer.concat(chunks);
                response.setHeader("Content-Type", "application/json");
                response.end(JSON.stringify({ id: "file-api-test" }));
            });
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });

        try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("无法获取测试 Files API 地址");
            await expect(uploadDeepSeekFile(originalPath, {
                filesAPI: `http://127.0.0.1:${address.port}/files`,
            })).resolves.toBe("file-api-test");
            expect(requestHeaders.authorization).toBeUndefined();
            expect(requestHeaders["content-type"]).toContain("multipart/form-data; boundary=");
            expect(requestBody.toString()).toContain('name="purpose"');
            expect(requestBody.toString()).toContain("user_data");
            expect(requestBody.toString()).toContain('name="expires_after[anchor]"');
            expect(requestBody.toString()).toContain("created_at");
            expect(requestBody.toString()).toContain('name="expires_after[seconds]"');
            expect(requestBody.toString()).toContain("2592000");
            expect(requestBody.includes(original)).toBe(true);
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    test("DeepSeek 本地图片上传 Files API", async () => {
        const originalPath = createTestImageFile(stateDir);
        const original = fs.readFileSync(originalPath);
        const image = {
            id: "img-test-files-api",
            path: originalPath,
            filename: "test-image.png",
            mimeType: "image/png" as const,
            sizeBytes: original.length,
        };
        const uploadedData: string[] = [];
        const messages = [
            {
                role: "user",
                content: [
                    { type: "text", text: "分析图片" },
                    { type: "image_asset", image },
                ],
            },
        ];

        const materialized = await materializeDeepSeekImageMessages(messages, async asset => {
            uploadedData.push(asset.data);
            return "file-test-1";
        });

        expect(uploadedData).toEqual([original.toString("base64")]);
        expect(materialized[0].content).toEqual([
            { type: "text", text: "分析图片" },
            {
                type: "file",
                file_id: "file-test-1",
            },
        ]);
    });

    test("data URL 直接物化为 image_url，不读取本地文件", async () => {
        const image = {
            url: `data:image/png;base64,${TEST_IMAGE_BYTES.toString("base64")}`,
            filename: "photo.jpg",
            mimeType: "image/jpeg",
        };
        const messages = [{
            role: "user",
            content: toUserContent({ text: "分析这张图", images: [image] }),
        }];

        await expect(materializeImageMessages(messages)).resolves.toEqual([{
            role: "user",
            content: [
                { type: "text", text: "分析这张图" },
                {
                    type: "image_url",
                    image_url: { url: image.url },
                },
            ],
        }]);
    });

    test("外链下载后普通接口转 base64，DeepSeek 上传 Files API", async () => {
        const original = TEST_IMAGE_BYTES;
        const server = createServer((_request, response) => {
            response.setHeader("Content-Type", "image/png");
            response.end(original);
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });

        try {
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("无法获取图片测试服务器地址");
            const image = {
                url: `http://127.0.0.1:${address.port}/image.jpg`,
                filename: "image.jpg",
                mimeType: "image/png",
            };
            const messages = [{
                role: "user",
                content: toUserContent({ text: "分析这张图", images: [image] }),
            }];
            const inline = await materializeImageMessages(messages);
            expect(inline[0].content[1].image_url.url).toBe(
                `data:image/png;base64,${TEST_IMAGE_BYTES.toString("base64")}`,
            );
            await expect(materializeDeepSeekImageMessages(messages, async image => {
                expect(image.data).toBe(TEST_IMAGE_BYTES.toString("base64"));
                return "file-external";
            })).resolves.toEqual([{
                role: "user",
                content: [
                    { type: "text", text: "分析这张图" },
                    { type: "file", file_id: "file-external" },
                ],
            }]);
        } finally {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    test("工具返回的内存图片在 DeepSeek 请求中上传为文件", async () => {
        const uploaded: Array<{ data: string; filename: string; mimeType: string }> = [];
        const messages = [{
            role: "user",
            content: [
                { type: "text", text: "分析工具图片" },
                {
                    type: "image_data",
                    image: {
                        id: "tool-image-data",
                        data: TEST_IMAGE_BYTES.toString("base64"),
                        filename: "result.png",
                        mimeType: "image/png",
                    },
                },
            ],
        }];

        await expect(materializeDeepSeekImageMessages(messages, async image => {
            if (!("data" in image)) throw new Error("测试图片应为内存数据");
            uploaded.push({ data: image.data, filename: image.filename, mimeType: image.mimeType });
            return "file-tool-image";
        })).resolves.toEqual([{
            role: "user",
            content: [
                { type: "text", text: "分析工具图片" },
                { type: "file", file_id: "file-tool-image" },
            ],
        }]);
        expect(uploaded).toEqual([{
            data: TEST_IMAGE_BYTES.toString("base64"),
            filename: "result.png",
            mimeType: "image/png",
        }]);
    });

    test("内容相同的图片并发上传去重，账号作用域之间隔离", async () => {
        const messages = [{
            role: "user",
            content: [{
                type: "image_data",
                image: {
                    id: "not-trusted",
                    data: TEST_IMAGE_BYTES.toString("base64"),
                    filename: "cache.png",
                    mimeType: "image/png",
                },
            }],
        }];
        const scope = `cache-${stateDir}`;
        let uploads = 0;
        const upload = async () => `file-cache-${++uploads}`;
        const results = await Promise.all([
            materializeDeepSeekImageMessages(messages, upload, scope),
            materializeDeepSeekImageMessages(messages, upload, scope),
        ]);
        expect(uploads).toBe(1);
        expect(results[0]).toEqual(results[1]);
        await materializeDeepSeekImageMessages(messages, async () => {
            throw new Error("同账号跨回调应复用缓存");
        }, scope);
        await materializeDeepSeekImageMessages(messages, upload, `${scope}-other-account`);
        expect(uploads).toBe(2);
    });

    test("上传失败不污染缓存，下一次可以重传", async () => {
        const messages = [{
            role: "user",
            content: [{
                type: "image_data",
                image: {
                    id: "retry-image",
                    data: TEST_IMAGE_BYTES.toString("base64"),
                    filename: "retry.png",
                    mimeType: "image/png",
                },
            }],
        }];
        const scope = `retry-${stateDir}`;
        await expect(materializeDeepSeekImageMessages(messages, async () => {
            throw new Error("上传失败");
        }, scope)).rejects.toThrow("上传失败");
        const retry = await materializeDeepSeekImageMessages(messages, async () => "file-retry", scope);
        expect(retry[0].content[0]).toEqual({ type: "file", file_id: "file-retry" });
    });
});
