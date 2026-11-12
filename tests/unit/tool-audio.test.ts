import { describe, expect, test } from "bun:test";
import {
    describeDroppedMedia,
    partitionToolMedia,
    toolContentToAudioContent,
    toolContentToImageContent,
} from "../../src/tools/tool-interface.js";
import { expandToolMediaMessages } from "../../src/tools/orchestrator/messages.js";
import { prepareRequest, supportsAudioInput } from "../../src/tools/orchestrator/turn-request.js";
import type { ChatMessage } from "../../src/types/session.js";

const WAV_BASE64 = "UklGRg==";
const MP3_BASE64 = "SUQz";

describe("toolContentToAudioContent", () => {
    test("提取 wav 与 mp3，忽略其他容器", () => {
        const content = [
            { type: "audio", mimeType: "audio/wav", data: WAV_BASE64 },
            { type: "audio", mimeType: "audio/mpeg", data: MP3_BASE64 },
            { type: "audio", mimeType: "audio/ogg", data: "b2dn" },
            { type: "audio", mimeType: "audio/flac", data: "ZmxhYw==" },
            { type: "text", text: "[audio audio/wav base64_chars=8]" },
        ];

        expect(toolContentToAudioContent(content)).toEqual([
            { data: WAV_BASE64, format: "wav" },
            { data: MP3_BASE64, format: "mp3" },
        ]);
    });

    test("缺少 data 的音频块被跳过", () => {
        expect(toolContentToAudioContent([{ type: "audio", mimeType: "audio/wav" }])).toEqual([]);
    });
});

describe("expandToolMediaMessages 音频门控", () => {
    const toolMessage = (): ChatMessage => ({
        role: "tool",
        tool_call_id: "call_1",
        name: "read_media_file",
        content: "[audio audio/wav base64_chars=8]",
        audioContent: [{ data: WAV_BASE64, format: "wav" }],
    });

    test("allowAudio 开启时提升为带 input_audio 的 user 消息", () => {
        const expanded = expandToolMediaMessages([toolMessage()], { allowAudio: true });

        expect(expanded).toHaveLength(2);
        expect(expanded[0]).toEqual({
            role: "tool",
            tool_call_id: "call_1",
            name: "read_media_file",
            content: "[audio audio/wav base64_chars=8]",
        });
        expect(expanded[1]).toEqual({
            role: "user",
            content: [
                { type: "text", text: "工具返回了音频，请结合工具结果分析音频内容。" },
                { type: "input_audio", input_audio: { data: WAV_BASE64, format: "wav" } },
            ],
        });
    });

    test("allowAudio 关闭时音频不外发，只保留文本占位符", () => {
        const expanded = expandToolMediaMessages([toolMessage()], { allowAudio: false });

        expect(expanded).toHaveLength(1);
        expect(expanded[0]).not.toHaveProperty("audioContent");
        expect(JSON.stringify(expanded[0])).not.toContain("input_audio");
    });

    test("图片与音频同时存在时合并进同一条 user 消息，提示语同时提到两者", () => {
        const message: ChatMessage = {
            role: "tool",
            tool_call_id: "call_2",
            content: "mixed",
            imageContent: [{ type: "image_asset", image: { id: "img_1" } as any }],
            audioContent: [{ data: WAV_BASE64, format: "wav" }],
        };

        const expanded = expandToolMediaMessages([message], { allowAudio: true });

        expect(expanded).toHaveLength(2);
        const mediaMessage = expanded[1] as { role: string; content: any[] };
        expect(mediaMessage.role).toBe("user");
        expect(mediaMessage.content[0].text).toBe("工具返回了图片与音频，请结合工具结果分析这些内容。");
        expect(mediaMessage.content.some((part) => part.type === "input_audio")).toBe(true);
    });
});

describe("supportsAudioInput", () => {
    test("音频模型开启，DeepSeek 与普通模型关闭", () => {
        expect(supportsAudioInput("gpt-audio-1.5", "https://api.openai.com/v1")).toBe(true);
        expect(supportsAudioInput("gpt-4o-audio-preview", "https://api.openai.com/v1")).toBe(true);
        expect(supportsAudioInput("deepseek-chat", "https://api.deepseek.com")).toBe(false);
        expect(supportsAudioInput("deepseek-flash", "https://api.deepseek.com")).toBe(false);
        expect(supportsAudioInput("gpt-4o", "https://api.openai.com/v1")).toBe(false);
    });
});

describe("audioContent 落盘", () => {
    test("写入回合历史时剔除内联 base64，避免快照膨胀", async () => {
        const { appendCompletedTurn } = await import("../../src/utils/conversation-history.js");

        const session: any = {
            id: "s1", model: "m", cwd: "/tmp",
            contextEpochId: "01J00000000000000000000001",
            turns: [],
            contextState: {
                startedAt: "2026-01-01T00:00:00+08:00",
                reason: "session_start",
                sourceUserTurnCount: 0,
                retainedUserTurnCount: 0,
            },
            totalUserTurnCount: 0, hardTrimCount: 0, compactCount: 0,
        };
        const toolMessage = {
            role: "tool" as const,
            tool_call_id: "call_1",
            name: "read_media_file",
            content: "[audio audio/wav base64_chars=8]",
            audioContent: [{ data: "UklGRg==", format: "wav" as const }],
        };

        appendCompletedTurn(session, ["听一下"], [toolMessage], true);

        const stored = JSON.stringify(session.turns);
        expect(stored).not.toContain("audioContent");
        expect(stored).not.toContain("UklGRg==");
        expect(stored).toContain("[audio audio/wav base64_chars=8]");
    });
});

describe("supportsAudioInput 的 provider.audioInput 覆盖", () => {
    test("audioInput: true 时非音频模型也能上行音频", () => {
        expect(supportsAudioInput("gpt-4o", "https://api.openai.com/v1", true)).toBe(true);
    });

    test("audioInput: false 时音频模型也不上行", () => {
        expect(supportsAudioInput("gpt-audio-1.5", "https://api.openai.com/v1", false)).toBe(false);
    });

    test("没配时按模型名启发式", () => {
        expect(supportsAudioInput("gpt-audio-1.5", "https://api.openai.com/v1")).toBe(true);
        expect(supportsAudioInput("gpt-4o", "https://api.openai.com/v1")).toBe(false);
    });

    test("DeepSeek 官方端点不受覆盖影响，官方模型别名也保持禁用", () => {
        expect(supportsAudioInput("deepseek-chat", "https://api.deepseek.com", true)).toBe(false);
        expect(supportsAudioInput("my-audio-model", "https://api.deepseek.com/v1", true)).toBe(false);
    });

    test("DeepSeek 网关显式配置优先于模型风格，未配置时仍保守禁用", () => {
        const baseURL = "https://gateway.example/v1";
        expect(supportsAudioInput("vendor/deepseek-audio", baseURL, true)).toBe(true);
        expect(supportsAudioInput("vendor/deepseek-audio", baseURL, false)).toBe(false);
        expect(supportsAudioInput("vendor/deepseek-audio", baseURL)).toBe(false);
    });
});

describe("prepareRequest 音频能力与实际请求一致", () => {
    const cases = [
        { model: "deepseek-flash", baseURL: "https://api.deepseek.com/v1", audioInput: true, expected: false },
        { model: "my-audio-model", baseURL: "https://api.deepseek.com/v1", audioInput: true, expected: false },
        { model: "vendor/deepseek-flash", baseURL: "https://gateway.example/v1", audioInput: true, expected: true },
        { model: "vendor/deepseek-audio", baseURL: "https://gateway.example/v1", audioInput: undefined, expected: false },
        { model: "vendor/deepseek-audio", baseURL: "https://gateway.example/v1", audioInput: false, expected: false },
        { model: "gpt-audio-test", baseURL: "https://gateway.example/v1", audioInput: undefined, expected: true },
        { model: "gpt-audio-test", baseURL: "https://gateway.example/v1", audioInput: false, expected: false },
        { model: "deepseek-flash", baseURL: "https://api.deepseek.com.evil.example/v1", audioInput: true, expected: true },
    ];

    for (const { model, baseURL, audioInput, expected } of cases) {
        test(`${model} @ ${baseURL} / audioInput=${audioInput}`, async () => {
            const message: ChatMessage = {
                role: "tool",
                tool_call_id: "call_audio",
                content: "音频",
                audioContent: [{ data: WAV_BASE64, format: "wav" }],
            };
            const prepared = await prepareRequest({
                client: {
                    baseURL,
                    protocol: "chat_completions",
                    transport: { ...(audioInput === undefined ? {} : { audioInput }) },
                },
                model,
                messages: [message],
                tools: [],
                normalizedTools: tools => tools,
                isFirstIteration: true,
                stream: false,
            });
            const serialized = JSON.stringify(prepared.requestBody);
            expect(supportsAudioInput(model, baseURL, audioInput)).toBe(expected);
            expect(serialized.includes("input_audio")).toBe(expected);
            expect(serialized).not.toContain("audioContent");
            expect(message.audioContent).toHaveLength(1);
        });
    }
});

describe("turn_message 事件落盘", () => {
    test("onTurnMessage 收到原对象（run-turn 靠对象身份去重，中间层不得复制）", async () => {
        const { executeWithChat } = await import("../../src/tools/chat-orchestrator.js");
        const persisted: any[] = [];
        let requestCount = 0;
        const client = {
            baseURL: "http://test.invalid",
            create: async () => {
                requestCount++;
                return requestCount === 1
                    ? {
                        choices: [{
                            message: {
                                role: "assistant",
                                tool_calls: [{
                                    id: "call_audio",
                                    type: "function",
                                    function: { name: "read_media_file", arguments: "{}" },
                                }],
                            },
                        }],
                    }
                    : { choices: [{ message: { role: "assistant", content: "好了" } }] };
            },
        };

        const result = await executeWithChat({
            query: "听",
            client,
            model: "gpt-audio-1.5",
            executeTool: async () => ({
                content: "[audio audio/wav base64_chars=8]",
                audioContent: [{ data: "UklGRg==", format: "wav" as const }],
            }),
            onTurnMessage: (message: any) => {
                persisted.push(message);
            },
        });

        const persistedTool = persisted.find((message) => message.role === "tool");
        const turnTool = result.messages.find((message: any) => message.role === "tool");
        expect(persistedTool).toBeDefined();
        // 同一引用：一旦这里改成副本，run-turn 的 includes 去重会恒为 false 并重复落盘
        expect(persistedTool).toBe(turnTool);
        // 中间层不再剔除，剔除由唯一落盘口 persistTurnMessage 负责
        expect(persistedTool.audioContent).toEqual([{ data: "UklGRg==", format: "wav" }]);
    });
});

describe("describeDroppedMedia 媒体未上行说明", () => {
    const wav = { type: "audio", mimeType: "audio/wav", data: "UklGRg==" };
    const ogg = { type: "audio", mimeType: "audio/ogg", data: "b2dn" };
    const png = { type: "image", mimeType: "image/png", data: "iVBORw==" };
    const bmp = { type: "image", mimeType: "image/bmp", data: "Qk0=" };
    const svg = { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" };

    test("音频模型 + wav + png 全部上行时不加说明", () => {
        expect(describeDroppedMedia([wav, png])).toBeUndefined();
    });

    test("端点不支持音频时说明原因", () => {
        const notice = describeDroppedMedia([wav], { audioDropReason: "endpoint" });
        expect(notice).toContain("当前端点不支持音频输入");
        expect(notice).toContain("1 个媒体块中有 1 个未能读取");
    });

    test("音频格式不支持时列出具体 mime", () => {
        const notice = describeDroppedMedia([wav, ogg]);
        expect(notice).toContain("audio/ogg");
        expect(notice).toContain("仅 wav/mp3 可发送");
        expect(notice).toContain("2 个媒体块中有 1 个未能读取");
    });

    test("图片格式不支持时列出具体 mime 并说明仅支持哪些", () => {
        const notice = describeDroppedMedia([png, bmp]);
        expect(notice).toContain("image/bmp");
        expect(notice).toContain("仅 png/jpeg/gif/webp 可发送");
        expect(notice).toContain("2 个媒体块中有 1 个未能读取");
    });

    test("svg 同样被判定为不支持的图片格式", () => {
        const notice = describeDroppedMedia([svg]);
        expect(notice).toContain("image/svg+xml");
    });

    test("图片与音频格式同时不支持时两条原因都列出", () => {
        const notice = describeDroppedMedia([bmp, ogg]);
        expect(notice).toContain("image/bmp");
        expect(notice).toContain("audio/ogg");
        expect(notice).toContain("2 个媒体块中有 2 个未能读取");
    });

    test("Responses 协议即使模型支持音频也说明不上行", () => {
        const notice = describeDroppedMedia([wav], { audioDropReason: "responses" });
        expect(notice).toContain("Responses 协议");
    });

    test("端点拒绝音频时只说明端点原因，不再提格式", () => {
        const notice = describeDroppedMedia([ogg], { audioDropReason: "endpoint" });

        expect(notice).toContain("当前端点不支持音频输入");
        // 端点整批拒绝时提"仅 wav/mp3 可发送"会误导：wav 在该端点同样发不出去
        expect(notice).not.toContain("audio/ogg");
        expect(notice).not.toContain("仅 wav/mp3");
    });

    test("多个同格式不支持的文件按块计数，mime 去重展示", () => {
        const notice = describeDroppedMedia(
            [bmp, { ...bmp, data: "Qk0x" }, ogg],
        );

        expect(notice).toContain("3 个媒体块中有 3 个未能读取");
        // 两个 bmp 只列一次 mime
        expect(notice!.match(/image\/bmp/g)).toHaveLength(1);
    });

    test("全部支持时即使混有多种格式也不加说明", () => {
        const notice = describeDroppedMedia([png, { ...png, data: "iVBORw0==" }, wav]);
        expect(notice).toBeUndefined();
    });

    test("没有媒体块时不加说明", () => {
        expect(describeDroppedMedia([{ type: "text", text: "ok" }])).toBeUndefined();
    });
});

describe("图片格式提取过滤", () => {
    test("bmp/svg 不会被提取成可上行的图片内容", async () => {
        const images = await toolContentToImageContent([
            { type: "image", mimeType: "image/png", data: "iVBORw==", path: "a.png" },
            { type: "image", mimeType: "image/bmp", data: "Qk0=", path: "b.bmp" },
            { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=", path: "c.svg" },
        ]);

        expect(images).toHaveLength(1);
        expect(images[0]!.type).toBe("image_asset");
        expect((images[0] as any).image.mimeType).toBe("image/png");
    });
});

describe("媒体分区与说明的一致性", () => {

    test("m4a/aac/opus/webm 归入音频桶并按格式不支持说明", () => {
        for (const mimeType of ["audio/mp4", "audio/aac", "audio/opus", "audio/webm"]) {
            const notice = describeDroppedMedia([{ type: "audio", mimeType, data: "AA==" }]);
            expect(notice).toContain(mimeType);
            expect(notice).toContain("仅 wav/mp3 可发送");
        }
    });

    test("avif/heic/tiff 归入图片桶并按格式不支持说明", () => {
        for (const mimeType of ["image/avif", "image/heic", "image/tiff"]) {
            const notice = describeDroppedMedia([{ type: "image", mimeType, data: "AA==" }]);
            expect(notice).toContain(mimeType);
            expect(notice).toContain("仅 png/jpeg/gif/webp 可发送");
        }
    });

    test("带参数的 mime 归一化后仍判定为支持", () => {
        const partition = partitionToolMedia([
            { type: "image", mimeType: "image/png;charset=binary", data: "iVBORw==" },
            { type: "audio", mimeType: "audio/wav; codecs=1", data: "UklGRg==" },
        ]);

        expect(partition.supportedImages).toHaveLength(1);
        expect(partition.supportedAudios).toHaveLength(1);
        expect(describeDroppedMedia(
            [{ type: "image", mimeType: "image/png;charset=binary", data: "iVBORw==" }],
        )).toBeUndefined();
    });

    test("image/jpg 归一化为 image/jpeg 后判定为支持", () => {
        const partition = partitionToolMedia([{ type: "image", mimeType: "image/jpg", data: "AA==" }]);
        expect(partition.supportedImages).toHaveLength(1);
        expect(partition.unsupportedImages).toHaveLength(0);
    });

    test("提取数量 + 未支持 + 无载荷 == 媒体块总数", async () => {
        const content = [
            { type: "image", mimeType: "image/png", data: "iVBORw==", path: "a.png" },
            { type: "image", mimeType: "image/bmp", data: "Qk0=" },
            { type: "audio", mimeType: "audio/wav", data: "UklGRg==" },
            { type: "audio", mimeType: "audio/ogg", data: "b2dn" },
            // mime 支持但无载荷
            { type: "image", mimeType: "image/png" },
            // 音频只认内联 base64，仅有 path 也算不可用
            { type: "audio", mimeType: "audio/wav", path: "/tmp/x.wav" },
            { type: "text", text: "无关块" },
        ];

        const partition = partitionToolMedia(content);
        const extracted = (await toolContentToImageContent(content)).length
            + toolContentToAudioContent(content).length;
        const unsupported = partition.unsupportedImages.length + partition.unsupportedAudios.length;
        const unusable = partition.unusableImages.length + partition.unusableAudios.length;

        expect(extracted).toBe(2);
        expect(unsupported).toBe(2);
        expect(unusable).toBe(2);
        // 不变量：三档之和覆盖全部媒体块，不留静默黑洞
        expect(extracted + unsupported + unusable).toBe(6);
    });

    test("图片仅有 path 仍算可用载荷（图片支持按路径读取）", () => {
        const partition = partitionToolMedia([{ type: "image", mimeType: "image/png", path: "/tmp/a.png" }]);

        expect(partition.supportedImages).toHaveLength(1);
        expect(partition.unusableImages).toHaveLength(0);
    });

    test("空 base64 不算可用载荷，归入未上行", () => {
        const notice = describeDroppedMedia([{ type: "image", mimeType: "image/png", data: "" }]);

        expect(notice).toContain("未携带可上行内容");
    });
});

describe("无可用载荷的媒体块", () => {
    test("mime 支持但既无 data 也无 path 时计入未上行并说明", () => {
        const notice = describeDroppedMedia([{ type: "image", mimeType: "image/png" }]);

        expect(notice).toContain("未携带可上行内容");
        expect(notice).toContain("1 个媒体块中有 1 个未能读取");
    });

    test("分区把无载荷块放进 unusable 而不是 supported", () => {
        const partition = partitionToolMedia([
            { type: "image", mimeType: "image/png" },
            { type: "image", mimeType: "image/png", data: "iVBORw==" },
        ]);

        expect(partition.unusableImages).toHaveLength(1);
        expect(partition.supportedImages).toHaveLength(1);
    });

    test("原型链上的键不会被当成合法音频格式", () => {
        const partition = partitionToolMedia([
            { type: "audio", mimeType: "constructor", data: "AA==" },
            { type: "audio", mimeType: "__proto__", data: "AA==" },
        ]);

        expect(partition.supportedAudios).toHaveLength(0);
        expect(partition.unsupportedAudios).toHaveLength(2);
        expect(toolContentToAudioContent([{ type: "audio", mimeType: "constructor", data: "AA==" }])).toEqual([]);
    });
});
