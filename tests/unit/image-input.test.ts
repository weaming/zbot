/**
 * 图片输入能力来自 provider 配置，不内置模型名单：
 * 同一模型经不同网关能力可能不同，写死在代码里的名单必然过期。
 * 降级必须发生在协议物化之前，所以 Chat Completions 与 Responses 两种形态都要认得。
 */

import { describe, expect, test } from "bun:test";
import { prepareRequest } from "../../src/tools/orchestrator/turn-request.js";
import { dropUnsupportedImages, supportsImageInput } from "../../src/tools/orchestrator/image-input.js";
import type { ChatMessage } from "../../src/types/session.js";
import { TEST_IMAGE_BYTES } from "./image-fixture.js";

/** 造一条带图片块的用户消息。 */
function userWithImage(type: "image_url" | "input_image" = "image_url"): ChatMessage {
    return {
        role: "user",
        content: [
            { type: "text", text: "看图" },
            { type, image: { url: "data:image/png;base64,AA" } },
        ],
    } as unknown as ChatMessage;
}

describe("supportsImageInput", () => {
    test("无配置时接受图片", () => {
        expect(supportsImageInput("gpt-6-sol")).toBe(true);
        expect(supportsImageInput("baidu/ernie-5.5-flash-preview:free")).toBe(true);
    });

    test("imageInput: false 时整台接入端判否，与模型名无关", () => {
        expect(supportsImageInput("gpt-6-sol", { imageInput: false })).toBe(false);
    });

    test("textOnlyModels 按小写子串命中，忽略模型名里的厂商前缀", () => {
        const capability = { textOnlyModels: ["ernie-5.5-flash"] };

        expect(supportsImageInput("baidu/ernie-5.5-flash-preview:free", capability)).toBe(false);
        expect(supportsImageInput("ERNIE-5.5-Flash-Preview", capability)).toBe(false);
        expect(supportsImageInput("workbuddy-ai/deepseek-v4.1-flash", capability)).toBe(true);
    });
});

describe("dropUnsupportedImages", () => {
    const capability = { textOnlyModels: ["ernie-5.5-flash"] };

    test("不支持时把图片块换成说明，保留文本块与其余块", () => {
        const dropped = dropUnsupportedImages("baidu/ernie-5.5-flash-preview:free", [userWithImage()], capability);

        expect(dropped[0].content).toEqual([
            { type: "text", text: "看图" },
            { type: "text", text: "[图片已移除：当前模型不支持图片输入]" },
        ]);
    });

    test("Responses 的 input_image 投影同样降级，不残留 base64", () => {
        const dropped = dropUnsupportedImages("ernie-5.5-flash", [userWithImage("input_image")], capability);
        const serialized = JSON.stringify(dropped);

        expect(serialized).not.toContain("input_image");
        expect(serialized).not.toContain("image/png");
    });

    test("支持图片时原样返回同一数组，不复制消息、不抖前缀", () => {
        const messages = [userWithImage()];

        expect(dropUnsupportedImages("gpt-6-sol", messages, capability)).toBe(messages);
    });

    test("不含图片时原样返回同一数组", () => {
        const messages: ChatMessage[] = [
            { role: "user", content: "你好" },
            { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function" }] } as ChatMessage,
        ];

        expect(dropUnsupportedImages("ernie-5.5-flash", messages, capability)).toBe(messages);
    });

    test("不修改入参消息", () => {
        const messages = [userWithImage()];
        const before = JSON.stringify(messages);

        dropUnsupportedImages("ernie-5.5-flash", messages, capability);

        expect(JSON.stringify(messages)).toBe(before);
    });
});

describe("prepareRequest 的降级位置", () => {
    const chatClient = { baseURL: "http://127.0.0.1:3425/v1", protocol: "chat_completions" as const };
    const responsesClient = { baseURL: "https://api.example.com/v1", protocol: "responses" as const };
    const prepare = (model: string, client: typeof chatClient, imageInput?: { textOnlyModels: string[] }) =>
        prepareRequest({
            client,
            model,
            messages: [userWithImage()],
            tools: [],
            normalizedTools: tools => tools,
            isFirstIteration: true,
            stream: true,
            ...(imageInput ? { imageInput } : {}),
        });

    test("纯文本模型在协议物化前就丢掉图片", async () => {
        const prepared = await prepare("baidu/ernie-5.5-flash-preview:free", chatClient, {
            textOnlyModels: ["ernie-5.5-flash"],
        });
        const serialized = JSON.stringify(prepared.requestBody);

        expect(prepared.requestBody.messages[0].content).toEqual([
            { type: "text", text: "看图" },
            { type: "text", text: "[图片已移除：当前模型不支持图片输入]" },
        ]);
        expect(serialized).not.toContain("data:image/png");
    });

    test("Responses 协议同样降级，且支持图片的模型保留 data URL", async () => {
        const textOnly = await prepare("ernie-5.5-flash", responsesClient, { textOnlyModels: ["ernie-5.5-flash"] });
        expect(JSON.stringify(textOnly.requestBody.input ?? textOnly.requestBody)).not.toContain("data:image/png");

        const withImage = await prepare("gpt-6-sol", responsesClient, { textOnlyModels: ["ernie-5.5-flash"] });
        expect(JSON.stringify(withImage.requestBody)).toContain("data:image/png");
    });
});

describe("图片端点与协议分流", () => {
    const image = {
        type: "image_data",
        image: {
            id: "routing-image",
            filename: "routing.png",
            mimeType: "image/png",
            data: TEST_IMAGE_BYTES.toString("base64"),
        },
    };
    const messages = [
        { role: "user", content: [image] },
        { role: "tool", tool_call_id: "call_image", content: "截图", imageContent: [image] },
    ] as ChatMessage[];

    for (const protocol of ["responses", "chat_completions"] as const) {
        test(`DeepSeek 官方 ${protocol}：用户及工具图片均使用 file_id`, async () => {
            let uploads = 0;
            const prepared = await prepareRequest({
                client: {
                    baseURL: "https://api.deepseek.com/v1",
                    protocol,
                    createResponse: () => {},
                    uploadFileData: async () => ({ id: `file-routing-${++uploads}` }),
                },
                model: "deepseek-flash",
                messages,
                tools: [],
                normalizedTools: tools => tools,
                isFirstIteration: true,
                stream: false,
            });
            const payload = prepared.requestBody;
            expect(uploads).toBe(1);
            expect(JSON.stringify(payload)).not.toContain("base64");
            if (protocol === "responses") {
                expect(payload.input[0].content[0]).toEqual({ type: "input_image", file_id: "file-routing-1" });
                expect(payload.input[1].output[1]).toEqual({ type: "input_image", file_id: "file-routing-1" });
            } else {
                expect(payload.messages[0].content[0]).toEqual({ type: "file", file_id: "file-routing-1" });
                expect(payload.messages[2].content[1]).toEqual({ type: "file", file_id: "file-routing-1" });
            }
        });

        for (const baseURL of ["https://gateway.example/v1", "https://api.deepseek.com.evil.example/v1"]) {
            test(`${protocol} 网关不因 deepseek 模型名上传：${baseURL}`, async () => {
                const prepared = await prepareRequest({
                    client: {
                        baseURL,
                        protocol,
                        createResponse: () => {},
                        uploadFileData: async () => { throw new Error("网关禁止 Files API"); },
                    },
                    model: "vendor/deepseek-flash",
                    messages,
                    tools: [],
                    normalizedTools: tools => tools,
                    isFirstIteration: true,
                    stream: false,
                });
                const first = protocol === "responses"
                    ? prepared.requestBody.input[0].content[0]
                    : prepared.requestBody.messages[0].content[0];
                expect(first.type).toBe(protocol === "responses" ? "input_image" : "image_url");
                const url = protocol === "responses" ? first.image_url : first.image_url.url;
                expect(url).toBe(`data:image/png;base64,${image.image.data}`);
            });
        }
    }

    test("纯文本能力会移除本地、内存及工具图片，不触发官方上传", async () => {
        const result = await prepareRequest({
            client: {
                baseURL: "https://api.deepseek.com",
                protocol: "responses",
                createResponse: () => {},
                uploadFileData: async () => { throw new Error("不应上传"); },
            },
            imageInput: { imageInput: false },
            model: "deepseek-flash",
            messages,
            tools: [],
            normalizedTools: tools => tools,
            isFirstIteration: true,
            stream: false,
        });
        expect(JSON.stringify(result.requestBody)).not.toContain("file_id");
        expect(JSON.stringify(result.requestBody)).toContain("图片已移除");
    });
});
