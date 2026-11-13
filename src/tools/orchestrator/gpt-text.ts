import { isGptModel } from "../../utils/responses-transport.js";

const CITE_START = "\uE200cite\uE202";
const CITE_END = "\uE201";

/** 按增量移除 GPT 引用标记，只缓存可能尚未完整到达的起始符。 */
export class GptTextFilter {
  private pending = "";
  private isCitation = false;
  private readonly isEnabled: boolean;

  constructor(model?: string) {
    this.isEnabled = isGptModel(model);
  }

  push(text: string): string {
    if (!this.isEnabled) return text;

    let result = "";
    for (const char of text) {
      if (this.isCitation) {
        if (char === CITE_END) this.isCitation = false;
        continue;
      }

      this.pending += char;
      while (this.pending && !CITE_START.startsWith(this.pending)) {
        result += this.pending[0];
        this.pending = this.pending.slice(1);
      }
      if (this.pending === CITE_START) {
        this.pending = "";
        this.isCitation = true;
      }
    }
    return result;
  }

  finish(): string {
    const tail = this.pending;
    this.pending = "";
    this.isCitation = false;
    return tail;
  }
}

export function cleanGptText(text: string, model?: string): string {
  const filter = new GptTextFilter(model);
  return filter.push(text) + filter.finish();
}
