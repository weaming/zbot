import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../events/agent-events.js";
import { AppError } from "../utils/app-error.js";
import { extractResumeResult, parseResumeArgs, runResumeCli } from "./resume.js";

function expectCliError(run: () => unknown, code: string): void {
    try {
        run();
    } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe(code);
        return;
    }
    throw new Error(`预期抛出 AppError(${code})`);
}

describe("parseResumeArgs", () => {
    test("默认 TUI 模式只需要 id", () => {
        expect(parseResumeArgs(["01ABC"])).toEqual({
            id: "01ABC",
            print: false,
            prompt: [],
            json: false,
            unarchive: false,
        });
    });

    test("-p 前的开关生效，之后的词都算续聊文本", () => {
        expect(parseResumeArgs(["01ABC", "-p", "--json", "--unarchive", "继续", "修"])).toEqual({
            id: "01ABC",
            print: true,
            prompt: ["继续", "修"],
            json: true,
            unarchive: true,
        });
    });

    test("正文开始后不再解析开关：--json 留在文本里", () => {
        expect(parseResumeArgs(["01ABC", "-p", "解释 --json 的实现", "--print"])).toEqual({
            id: "01ABC",
            print: true,
            prompt: ["解释 --json 的实现", "--print"],
            json: false,
            unarchive: false,
        });
    });

    test("-p 不给文本时留空，交给 stdin", () => {
        expect(parseResumeArgs(["01ABC", "--print"]).prompt).toEqual([]);
    });

    test("-- 之后的短横线文本按正文处理", () => {
        expect(parseResumeArgs(["01ABC", "-p", "--", "-正文"]).prompt).toEqual(["-正文"]);
    });

    test("缺少 id、未知参数、TUI 模式带文本都报 usage", () => {
        expectCliError(() => parseResumeArgs([]), "usage");
        expectCliError(() => parseResumeArgs(["01ABC", "--nope"]), "usage");
        expectCliError(() => parseResumeArgs(["01ABC", "额外文本"]), "usage");
    });

    test("--json 只能与 -p 一起用", () => {
        expectCliError(() => parseResumeArgs(["01ABC", "--json"]), "usage");
    });
});

describe("extractResumeResult", () => {
    function turnMessage(message: Record<string, unknown>): AgentEvent {
        return {
            seq: 1,
            ts: "2026-01-01T00:00:00+08:00",
            sessionId: "01ABC",
            type: "turn_message",
            payload: { turnId: "t1", message: message as never },
        };
    }

    test("取最后一条有正文的 assistant 消息，并累计工具调用", () => {
        const events = [
            turnMessage({ role: "assistant", content: "先跑一下", tool_calls: [{ id: "a" }] }),
            turnMessage({ role: "tool", tool_call_id: "a", content: "ok" }),
            turnMessage({ role: "assistant", content: "最终结论" }),
            turnMessage({ role: "assistant", content: null }),
        ];
        expect(extractResumeResult(events)).toEqual({ content: "最终结论", toolCalls: 1 });
    });

    test("没有 assistant 正文时返回空串", () => {
        expect(extractResumeResult([turnMessage({ role: "tool", tool_call_id: "a", content: "ok" })]))
            .toEqual({ content: "", toolCalls: 0 });
    });
});

describe("runResumeCli", () => {
    test("无 UI 续聊拒绝创建本地宿主", async () => {
        await expect(runResumeCli({
            id: "s1",
            print: true,
            prompt: ["继续"],
            json: false,
            unarchive: false,
        })).rejects.toMatchObject({ code: "tui_or_backend_required" });
    });
});
