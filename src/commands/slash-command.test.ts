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
        // /new 接受可选标题（整段作为标题，可含空格）
        expect(commandArgs("/new 标题")).toEqual(["标题"]);
        expect(commandArgs("/new a b")).toEqual(["a b"]);
    });

    test("/cwd 的路径作为整体参数，可含空格", () => {
        expect(commandArgs("/cwd")).toEqual([]);
        expect(commandArgs("/cwd ~/src/zbot")).toEqual(["~/src/zbot"]);
        expect(commandArgs("/cwd /tmp/a b")).toEqual(["/tmp/a b"]);
    });

    test("/compact 的附加要求作为整体参数，多余分段不丢", () => {
        expect(commandArgs("/compact")).toEqual([]);
        expect(commandArgs("/compact   ")).toEqual([]);
        expect(commandArgs("/compact 重点保留并发结论")).toEqual(["重点保留并发结论"]);
        expect(commandArgs("/compact 保留 A 与 B")).toEqual(["保留 A 与 B"]);
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

    test("/review 接受可选附加说明（整体作为一个参数）", () => {
        expect(commandArgs("/review")).toEqual([]);
        expect(commandArgs("/review 请重点检查并发竞态")).toEqual(["请重点检查并发竞态"]);
        expect(commandArgs("/review a b")).toEqual(["a b"]);
    });

    test("/stop 的可选参数边界", () => {
        expect(commandArgs("/stop")).toEqual([]);
        expect(commandArgs("/stop all")).toEqual(["all"]);
        expect(invalidMessage("/stop a b")).toContain("参数过多");
    });

    test("model/effort/reasoning 合并后只保留 /model：旧命令退回普通文本", () => {
        for (const text of ["/effort", "/effort high", "/thinking auto", "/reasoning", "/reasoning on"]) {
            expect(parseSlashCommand(text).kind).toBe("text");
            expect(isKnownSlashCommand(text)).toBe(false);
        }
        // 强度设置并入 /model effort
        expect(commandArgs("/model effort high")).toEqual(["effort", "high"]);
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

    test("每条命令都有远程执行方式：没有 peer=deny 的漏网项", () => {
        for (const spec of SLASH_COMMAND_SPECS) {
            expect(["host", "prompt"]).toContain(spec.peer);
        }
    });

    test("--json 是独立 token：只对声明支持的视图命令生效", () => {
        const parsed = parseSlashCommand("/sessions --json");
        expect(parsed.kind).toBe("command");
        if (parsed.kind !== "command") return;
        expect(parsed.json).toBe(true);
        expect(parsed.args).toEqual([]);

        const withQuery = parseSlashCommand("/sessions foo --json");
        if (withQuery.kind !== "command") throw new Error("预期是命令");
        expect(withQuery.json).toBe(true);
        expect(withQuery.args).toEqual(["foo"]);

        // 未声明 json 的命令不吞掉这个 token，按参数处理（/stop 只有一个参数位）
        expect(invalidMessage("/stop a --json")).toContain("参数过多");

        // 非独立 token 不是开关：/cwd 的路径整体保留
        const cwd = parseSlashCommand("/cwd /tmp/a--json b");
        if (cwd.kind !== "command") throw new Error("预期是命令");
        expect(cwd.json).toBe(false);
        expect(cwd.args).toEqual(["/tmp/a--json b"]);
    });

    test("/model 的位置参数与 /mcp enable|disable 的参数校验", () => {
        expect(commandArgs("/model chat_completions gpt-4o")).toEqual(["chat_completions", "gpt-4o"]);
        expect(commandArgs("/model responses gpt-5 high")).toEqual(["responses", "gpt-5", "high"]);
        expect(commandArgs("/model effort")).toEqual(["effort"]);
        expect(commandArgs("/model effort high")).toEqual(["effort", "high"]);
        expect(invalidMessage("/model responses")).toContain("需要模型名");
        expect(invalidMessage("/model grpc m")).toContain("协议需要是");
        expect(invalidMessage("/model effort high extra")).toContain("只接受一个取值");
        // use 子命令已删除：它是非法协议名
        expect(invalidMessage("/model use chat_completions gpt-4o")).toContain("协议需要是");
        // 位置参数最多三段：第四段必须报错，不能静默丢弃
        expect(invalidMessage("/model chat_completions gpt-4o high extra")).toContain("参数过多");
        expect(commandArgs("/mcp enable github")).toEqual(["enable", "github"]);
        expect(invalidMessage("/mcp enable")).toContain("需要服务名");
        expect(invalidMessage("/mcp kill github")).toContain("未知子命令");
    });

    test("归档态可执行的命令集合是明确白名单", () => {
        const archived = SLASH_COMMAND_SPECS.filter(spec => spec.archived).map(spec => spec.name);
        expect(archived).toEqual(["sessions", "keys", "unarchive", "delete", "skills", "help"]);
    });
});
