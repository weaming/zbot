import { expect, test } from "bun:test";
import { executeWithChat } from "../chat-orchestrator.js";
import { collectChatStream } from "./chat-stream.js";
import { collectResponsesStream } from "./responses-stream.js";
import { cleanGptText, GptTextFilter } from "./gpt-text.js";

const CITATION = "\uE200cite\uE202turn0search1\uE202turn0search6\uE201";
const RAW_TEXT = `结论。${CITATION}后文`;

test("GPT 标记在任意分片处拆开时均被清理", () => {
  for (let index = 0; index <= RAW_TEXT.length; index++) {
    const filter = new GptTextFilter("openai/gpt-5");
    const actual = filter.push(RAW_TEXT.slice(0, index)) + filter.push(RAW_TEXT.slice(index)) + filter.finish();
    expect(actual).toBe("结论。后文");
  }
  expect(cleanGptText(`${CITATION}${CITATION}`, "GPT-5")).toBe("");
  expect(cleanGptText("正文\uE200cite\uE202turn0", "gpt-5")).toBe("正文");
  expect(cleanGptText("正文\uE200cit", "gpt-5")).toBe("正文\uE200cit");
  expect(cleanGptText("正文\uE200其他\uE201", "gpt-5")).toBe("正文\uE200其他\uE201");
});

for (const model of ["gpt-5", "deepseek-chat"]) {
  for (const protocol of ["responses", "chat_completions"] as const) {
    for (const isStream of [false, true]) {
      test(`${model} ${protocol} stream=${isStream} 正文、事件与持久化一致`, async () => {
        const expected = model === "gpt-5" ? "结论。后文" : RAW_TEXT;
        const events: any[] = [];
        const deltas: any[] = [];
        const annotation = { type: "url_citation", url: "https://example.com", title: "来源" };
        const output = [{ type: "message", content: [{ type: "output_text", text: RAW_TEXT, annotations: [annotation] }] }];
        async function* responseEvents() {
          for (const char of RAW_TEXT) yield { type: "response.output_text.delta", delta: char };
          yield { type: "response.completed", response: { output } };
        }
        async function* chatChunks() {
          for (const char of RAW_TEXT) yield { choices: [{ delta: { content: char } }] };
          yield { choices: [{ delta: {}, finish_reason: "stop" }] };
        }
        const result = await executeWithChat({
          query: "test",
          model,
          stream: isStream,
          client: {
            baseURL: "http://test.invalid",
            protocol,
            create: async () => isStream ? chatChunks() : {
              choices: [{ message: { role: "assistant", content: RAW_TEXT }, finish_reason: "stop" }],
            },
            createResponse: async () => isStream ? responseEvents() : { output },
          },
          onEvent: event => events.push(event),
          onStreamDelta: async delta => { deltas.push(delta); },
        });
        expect(result.content).toBe(expected);
        expect(result.messages.find(message => message.role === "assistant")?.content).toBe(expected);
        if (isStream) {
          expect(events.filter(event => event.type === "text_delta").map(event => event.delta).join("")).toBe(expected);
          expect(deltas.map(delta => delta.text ?? "").join("")).toBe(expected);
        }
        if (protocol === "responses") {
          expect(events).toContainEqual({ type: "citations", items: [{ url: annotation.url, title: annotation.title }] });
          expect(output[0]!.content[0]!.text).toBe(RAW_TEXT);
        }
      });
    }
  }
}

test("GPT 中断响应的部分正文不泄露未闭合引用", async () => {
  for (const protocol of ["responses", "chat_completions"]) {
    async function* events(): AsyncIterable<any> {
      const text = "正文\uE200cite\uE202turn0";
      yield protocol === "responses"
        ? { type: "response.output_text.delta", delta: text }
        : { choices: [{ delta: { content: text } }] };
      throw new Error("连接中断");
    }
    const collect = protocol === "responses" ? collectResponsesStream : collectChatStream;
    try {
      await collect(events(), () => {}, undefined, "gpt-5");
      throw new Error("应抛出连接错误");
    } catch (error: any) {
      expect(error.message).toBe("连接中断");
      expect(error.partialMessage.content).toBe("正文");
    }
  }
});

test("GPT Responses 仅有 done 事件时也清理正文", async () => {
  async function* events(): AsyncIterable<any> {
    yield { type: "response.output_text.done", text: RAW_TEXT };
  }
  const text: string[] = [];
  await collectResponsesStream(events(), event => {
    if (event.type === "text_delta") text.push(event.delta);
  }, undefined, "gpt-5");
  expect(text.join("")).toBe("结论。后文");
});
