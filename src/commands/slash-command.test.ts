import { describe, expect, test } from "bun:test";
import { isKnownSlashCommand, parseSlashCommand, SLASH_COMMAND_SPECS } from "./slash-command.js";

/** 断言是命令并返回 args（测试里读起来更短）。 */
function commandArgs(text: string): string[] {
    const parsed = parseSlashCommand(text);
    if (parsed.kind !== "command") throw new Error(`预期是命令：${text} → ${parsed.kind}`);
    return parsed.args;
}

function invalidMessage(text: string): string {
    const parsed = parseSlashCommand(text);
    if (parsed.kind !== "invalid") throw new Error(`预期参数非法：${text} → ${parsed.kind}`);
    return parsed.message;
}

describe("parseSlashCommand", () => {
    test("只有原文第一个字符是 / 才识别：前导空格/空串都算文本", () => {
        expect(parseSlashCommand("").kind).toBe("text");
        expect(parseSlashCommand("   ").kind).toBe("text");
        expect(parseSlashCommand(" /help").kind).toBe("text");
        expect(parseSlashCommand("\t/help").kind).toBe("text");
        expect(parseSlashCommand("请解释 /help").kind).toBe("text");
    });

    test("只认完整命令名：未知与相似前缀都回落成文本", () => {
        expect(parseSlashCommand("/").kind).toBe("text");
        expect(parseSlashCommand("/nope").kind).toBe("text");
        expect(parseSlashCommand("/helpx").kind).toBe("text");
        expect(parseSlashCommand("/Help").kind).toBe("text");
        // 前缀不是命令名的一部分：/task 不是 /tasks
        expect(parseSlashCommand("/task list").kind).toBe("text");
        expect(parseSlashCommand("/help").kind).toBe("command");
    });

    test("无参数命令：空参数合法，多余参数报明确错误", () => {
        expect(commandArgs("/help")).toEqual([]);
        expect(commandArgs("/help   ")).toEqual([]);
        expect(invalidMessage("/help extra")).toContain("参数过多");
        expect(invalidMessage("/model gpt-4")).toContain("用法：/model");
        expect(invalidMessage("/new 标题")).toContain("参数过多");
    });

    test("/cwd 的路径作为整体参数，可含空格", () => {
        expect(commandArgs("/cwd")).toEqual([]);
        expect(commandArgs("/cwd ~/src/zbot")).toEqual(["~/src/zbot"]);
        expect(commandArgs("/cwd /tmp/a b")).toEqual(["/tmp/a b"]);
    });

    test("/tasks 逐项校验子命令与参数", () => {
        expect(commandArgs("/tasks")).toEqual([]);
        expect(commandArgs("/tasks list")).toEqual(["list"]);
        expect(commandArgs("/tasks status t1")).toEqual(["status", "t1"]);
        expect(commandArgs("/tasks wait t1 30")).toEqual(["wait", "t1", "30"]);
        expect(invalidMessage("/tasks foo")).toContain("未知子命令");
        expect(invalidMessage("/tasks status")).toContain("需要 task_id");
        expect(invalidMessage("/tasks wait t1 abc")).toContain("非负整数");
        expect(invalidMessage("/tasks list extra")).toContain("不接受额外参数");
        expect(invalidMessage("/tasks status t1 30")).toContain("只有 wait 接受秒数");
    });

    test("/stop 与 /effort 的可选参数边界", () => {
        expect(commandArgs("/stop")).toEqual([]);
        expect(commandArgs("/stop all")).toEqual(["all"]);
        expect(invalidMessage("/stop a b")).toContain("参数过多");
        expect(commandArgs("/effort high")).toEqual(["high"]);
        expect(invalidMessage("/effort high extra")).toContain("参数过多");
    });

    test("isKnownSlashCommand 与解析结果一致", () => {
        expect(isKnownSlashCommand("/help")).toBe(true);
        expect(isKnownSlashCommand("/help extra")).toBe(true);
        expect(isKnownSlashCommand("/helpx")).toBe(false);
        expect(isKnownSlashCommand(" /help")).toBe(false);
        expect(isKnownSlashCommand("hello")).toBe(false);
    });

    test("命令矩阵不含重复名", () => {
        const names = SLASH_COMMAND_SPECS.map(spec => spec.name);
        expect(new Set(names).size).toBe(names.length);
    });
});
