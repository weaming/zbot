import { describe, expect, test } from "bun:test";
import { parseAcpPrompt, textUpdates } from "./acp-content.js";

describe("ACP 内容转换", () => {
    test("接受基线资源链接与嵌入文本，不自动读取外部 URI", async () => {
        const result = await parseAcpPrompt([
            { type: "text", text: "检查" },
            { type: "resource_link", uri: "file:///work/file.ts", name: "file.ts" },
            { type: "resource", resource: { uri: "memory:///context", text: "上下文" } },
        ], async () => { throw new Error("不能保存图片"); });
        expect(result.text).toBe("检查\n\n[资源 file.ts] file:///work/file.ts\n\n[资源 memory:///context]\n上下文");
        expect(result.images).toEqual([]);
    });

    test("先验证所有输入再保存图片，拒绝未知类型、空正文和无效 Base64", async () => {
        let saved = 0;
        const save = async (_data: Buffer, filename: string) => {
            saved++;
            return { id: "image", path: "/asset", filename, mimeType: "image/png", sizeBytes: 1 };
        };
        await expect(parseAcpPrompt([{ type: "text", text: " " }], save)).rejects.toMatchObject({ code: -32602 });
        await expect(parseAcpPrompt([{ type: "image", mimeType: "image/png", data: "invalid" }], save)).rejects.toMatchObject({ code: -32602 });
        await expect(parseAcpPrompt([
            { type: "image", mimeType: "image/png", data: "YQ==" },
            { type: "audio", mimeType: "audio/wav", data: "YQ==" },
        ], save)).rejects.toMatchObject({ code: -32602 });
        expect(saved).toBe(0);
        const image = await parseAcpPrompt([{ type: "image", mimeType: "image/png", data: "YQ==" }], save);
        expect(image.images).toHaveLength(1);
        expect(image.text).toBe("请分析所附图片。");
    });

    test("大段 Unicode 文本分块不会拆断代理对", () => {
        const text = "你好🙂".repeat(5000);
        const updates = [...textUpdates(text, "agent_message_chunk")];
        expect(updates.length).toBeGreaterThan(1);
        expect(updates.map(update => "content" in update && "text" in update.content ? update.content.text : "").join("")).toBe(text);
        expect(JSON.stringify(updates)).not.toContain("\\ud83d");
    });
});
