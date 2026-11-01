import { describe, expect, test } from "bun:test";
import {
  planToolExecution,
  stripToolOrder,
  truncateAssistantToolCalls,
  withOrderParam,
} from "../../src/tools/orchestrator/tool-order.js";
import { runToolBatch, type ToolLoopHost } from "../../src/tools/orchestrator/tool-loop.js";
import type { ToolCall } from "../../src/types/tool-call.js";

function call(id: string, args: unknown = {}): ToolCall {
  return { id, name: `tool_${id}`, args, rawArgs: JSON.stringify(args) };
}

type ExecResult = string | { content: string; isError?: boolean };

function makeHost(execute: (name: string, args: any) => Promise<ExecResult>): ToolLoopHost & {
  trace: string[];
} {
  const trace: string[] = [];
  let toolId = 0;
  return {
    trace,
    executeTool: async (name, args) => {
      trace.push(`start:${name}`);
      const content = await execute(name, args);
      trace.push(`end:${name}`);
      return content;
    },
    emit: () => {},
    nextToolId: () => ++toolId,
    assertNotAborted: () => {},
  };
}

const ORDER = "_order";

describe("stripToolOrder", () => {
  test("只剥掉 _order，其余参数保留", () => {
    expect(stripToolOrder({ [ORDER]: 1, path: "a.ts" })).toEqual({ path: "a.ts" });
  });

  test("没有该字段时返回原对象，避免无谓拷贝", () => {
    const args = { path: "a.ts" };
    expect(stripToolOrder(args)).toBe(args);
  });
});

describe("planToolExecution", () => {
  test("全部没有 _order：一起并发", () => {
    const plan = planToolExecution([call("a"), call("b")]);
    expect(plan.stages).toHaveLength(0);
    expect(plan.parallel.map(item => item.index)).toEqual([0, 1]);
  });

  test("数字字符串也当顺序，非法值视为没写", () => {
    const plan = planToolExecution([
      call("a", { [ORDER]: "2" }),
      call("b", { [ORDER]: "abc" }),
      call("c", { [ORDER]: 1 }),
    ]);
    expect(plan.stages.map(stage => stage.map(item => item.call.id))).toEqual([["c"], ["a"]]);
    expect(plan.parallel.map(item => item.call.id)).toEqual(["b"]);
  });

  test("按 _order 升序分阶段，相同值并在一组", () => {
    const plan = planToolExecution([
      call("a", { [ORDER]: 2 }),
      call("b", { [ORDER]: 1 }),
      call("c", { [ORDER]: 1 }),
    ]);
    expect(plan.stages.map(stage => stage.map(item => item.call.id))).toEqual([["b", "c"], ["a"]]);
    expect(plan.parallel).toHaveLength(0);
  });

  test("部分有序：有序进串行链，其余进并发组", () => {
    const plan = planToolExecution([
      call("a"),
      call("b", { [ORDER]: 1 }),
      call("c"),
    ]);
    expect(plan.stages.map(stage => stage.map(item => item.call.id))).toEqual([["b"]]);
    expect(plan.parallel.map(item => item.call.id)).toEqual(["a", "c"]);
  });
});

describe("withOrderParam", () => {
  test("注入 _order 且不污染原 schema", () => {
    const schema = { type: "object", properties: { path: { type: "string" } } };
    const injected = withOrderParam(schema);
    expect(Object.keys(injected.properties)).toEqual(["path", ORDER]);
    expect(Object.keys(schema.properties)).toEqual(["path"]);
    expect(withOrderParam(schema)).toBe(injected);
  });

  test("非对象参数与已存在字段时原样返回", () => {
    expect(withOrderParam(undefined)).toBeUndefined();
    const custom = { type: "string" };
    expect(withOrderParam(custom)).toBe(custom);
  });
});

describe("truncateAssistantToolCalls", () => {
  const assistant = {
    role: "assistant" as const,
    content: "",
    tool_calls: [{ id: "c1" }, { id: "c2" }, { id: "c3" }],
    response_output: [
      { type: "message", role: "assistant" },
      { type: "function_call", call_id: "c1" },
      { type: "function_call", call_id: "c2" },
      { type: "function_call", call_id: "c3" },
    ],
  };

  test("tool_calls 与 response_output 一起裁，文本项保留", () => {
    const truncated = truncateAssistantToolCalls(assistant as any, new Set(["c1"]));
    expect(truncated.tool_calls.map((item: any) => item.id)).toEqual(["c1"]);
    expect(truncated.response_output.map((item: any) => item.type)).toEqual(["message", "function_call"]);
  });

  test("无需裁剪时返回原对象", () => {
    expect(truncateAssistantToolCalls(assistant as any, new Set(["c1", "c2", "c3"]))).toBe(assistant);
  });
});

describe("runToolBatch", () => {
  test("没有 _order 的整批并发执行", async () => {
    let running = 0;
    let peak = 0;
    const host = makeHost(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await Bun.sleep(5);
      running -= 1;
      return "ok";
    });

    const outcome = await runToolBatch(host, [call("a"), call("b"), call("c")]);

    expect(peak).toBe(3);
    expect(outcome.executed.size).toBe(3);
    expect(outcome.failedIndex).toBeNull();
  });

  test("有 _order 时逐条串行，且排在无 _order 的并发组之前", async () => {
    const host = makeHost(async name => name);

    const outcome = await runToolBatch(host, [
      call("loose"),
      call("second", { [ORDER]: 2 }),
      call("first", { [ORDER]: 1 }),
    ]);

    expect(host.trace).toEqual([
      "start:tool_first", "end:tool_first",
      "start:tool_second", "end:tool_second",
      "start:tool_loose", "end:tool_loose",
    ]);
    // 入列结果仍按原下标
    expect(outcome.results.map(result => result.index)).toEqual([0, 1, 2]);
  });

  test("相同 _order 的调用并行执行，不同阶段之间串行", async () => {
    let running = 0;
    let peak = 0;
    const host = makeHost(async name => {
      running += 1;
      peak = Math.max(peak, running);
      await Bun.sleep(5);
      running -= 1;
      return name;
    });

    const outcome = await runToolBatch(host, [
      call("third", { [ORDER]: 2 }),
      call("first", { [ORDER]: 1 }),
      call("alsoFirst", { [ORDER]: 1 }),
    ]);

    // 第一阶段两条并行，第二阶段单独一条，峰值 2 而不是 3
    expect(peak).toBe(2);
    expect(host.trace.slice(0, 2).sort()).toEqual(["start:tool_alsoFirst", "start:tool_first"]);
    expect(host.trace.indexOf("start:tool_third")).toBeGreaterThan(host.trace.indexOf("end:tool_first"));
    expect(outcome.failedIndex).toBeNull();
  });

  test("串行链失败即中止整批，跳过的调用不产出结果", async () => {
    const host = makeHost(async name => {
      if (name === "tool_second") throw new Error("boom");
      return "ok";
    });

    const outcome = await runToolBatch(host, [
      call("first", { [ORDER]: 1 }),
      call("second", { [ORDER]: 2 }),
      call("third", { [ORDER]: 3 }),
      call("loose"),
    ]);

    expect(host.trace).toEqual(["start:tool_first", "end:tool_first", "start:tool_second"]);
    expect(outcome.failedIndex).toBe(1);
    expect([...outcome.executed].sort()).toEqual([0, 1]);
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[1]!.failed).toBe(true);
  });

  test("工具自报 isError（非零退出码）同样中止串行链", async () => {
    const host = makeHost(async name =>
      name === "tool_second" ? { content: "exit code 7", isError: true } : "ok");

    const outcome = await runToolBatch(host, [
      call("first", { [ORDER]: 1 }),
      call("second", { [ORDER]: 2 }),
      call("third", { [ORDER]: 3 }),
      call("loose"),
    ]);

    expect(host.trace).toEqual([
      "start:tool_first", "end:tool_first",
      "start:tool_second", "end:tool_second",
    ]);
    expect(outcome.failedIndex).toBe(1);
    expect(outcome.results[1]!.failed).toBe(true);
  });

  test("失败标记随工具消息落盘：重开/回放时才不会把失败当成功", async () => {
    const host = makeHost(async name =>
      name === "tool_bad" ? { content: "exit code 7", isError: true } : "ok");

    const outcome = await runToolBatch(host, [call("good"), call("bad")]);

    expect(outcome.results[0]!.message).not.toHaveProperty("isError");
    expect(outcome.results[1]!.message.isError).toBe(true);

    // 抛异常与自报失败要落成同一个标记
    const thrown = await runToolBatch(
      makeHost(async () => {
        throw new Error("boom");
      }),
      [call("boom")],
    );
    expect(thrown.results[0]!.message.isError).toBe(true);
  });

  test("同一阶段内部分失败：整组结果照样汇报，只有后续阶段被跳过", async () => {
    const host = makeHost(async name =>
      name === "tool_bad" ? { content: "exit code 7", isError: true } : "ok");

    const outcome = await runToolBatch(host, [
      call("good", { [ORDER]: 1 }),
      call("bad", { [ORDER]: 1 }),
      call("later", { [ORDER]: 2 }),
      call("loose"),
    ]);

    // 同阶段两条都跑完并全部进结果，失败那条也带上错误内容
    expect(outcome.results.map(result => result.callId)).toEqual(["good", "bad"]);
    expect(outcome.results.map(result => result.failed)).toEqual([false, true]);
    expect([...outcome.executed].sort()).toEqual([0, 1]);
    expect(outcome.failedIndex).toBe(1);
    // 后续阶段与尾部并发组一个都没启动
    expect(host.trace).not.toContain("start:tool_later");
    expect(host.trace).not.toContain("start:tool_loose");
  });

  test("执行前剥掉 _order，工具拿不到调度字段", async () => {
    const seen: unknown[] = [];
    const host = makeHost(async (_name, args) => {
      seen.push(args);
      return "ok";
    });

    await runToolBatch(host, [call("a", { [ORDER]: 1, path: "x" })]);

    expect(seen).toEqual([{ path: "x" }]);
  });
});

describe("executeWithChat 顺序编排", () => {
  function toolCallResponse(steps: Array<{ id: string; args: Record<string, unknown> }>) {
    return {
      choices: [{
        message: {
          role: "assistant",
          content: "",
          tool_calls: steps.map(step => ({
            id: step.id,
            type: "function",
            function: { name: "step", arguments: JSON.stringify(step.args) },
          })),
        },
        finish_reason: "tool_calls",
      }],
    };
  }

  async function run(steps: Array<{ id: string; args: Record<string, unknown> }>) {
    const { executeWithChat } = await import("../../src/tools/chat-orchestrator.js");
    const persisted: any[] = [];
    const requests: any[] = [];
    const responses = [toolCallResponse(steps), {
      choices: [{ message: { content: "done" }, finish_reason: "stop" }],
    }];
    let index = 0;

    await executeWithChat({
      query: "go",
      client: {
        baseURL: "http://llm-server:8080/v1",
        create: async (body: any) => {
          requests.push(body);
          return responses[index++];
        },
      },
      model: "test-model",
      executeTool: async (_name: string, args: any) => {
        if (args.fail) throw new Error("boom");
        if (args.exit) return { content: `exit code ${args.exit}`, isError: true };
        return "ok";
      },
      onTurnMessage: message => {
        persisted.push(message);
      },
    });
    return { persisted, requests };
  }

  test("串行链中断：assistant 只留实际执行的调用，跳过的调用不进历史", async () => {
    const { persisted } = await run([
      { id: "c1", args: { _order: 1 } },
      { id: "c2", args: { _order: 2, fail: true } },
      { id: "c3", args: { _order: 3 } },
    ]);

    const assistant = persisted.find(message => message.role === "assistant" && message.tool_calls);
    expect(assistant.tool_calls.map((call: any) => call.id)).toEqual(["c1", "c2"]);

    const toolMessages = persisted.filter(message => message.role === "tool");
    expect(toolMessages.map(message => message.tool_call_id)).toEqual(["c1", "c2"]);
    expect(toolMessages[1]!.content).toContain("boom");
  });

  test("全部成功：assistant 保留整批调用，入列顺序与调用顺序一致", async () => {
    const { persisted } = await run([
      { id: "c1", args: { _order: 2 } },
      { id: "c2", args: { _order: 1 } },
      { id: "c3", args: {} },
    ]);

    const assistant = persisted.find(message => message.role === "assistant" && message.tool_calls);
    expect(assistant.tool_calls.map((call: any) => call.id)).toEqual(["c1", "c2", "c3"]);

    const toolMessages = persisted.filter(message => message.role === "tool");
    expect(toolMessages.map(message => message.tool_call_id)).toEqual(["c1", "c2", "c3"]);
  });

  test("工具自报失败：后续与并行调用都不执行，下一次请求里也没有它们的调用与结果", async () => {
    const { persisted, requests } = await run([
      { id: "c1", args: { _order: 1 } },
      { id: "c2", args: { _order: 2, exit: 7 } },
      { id: "c3", args: { _order: 3 } },
      { id: "c4", args: {} },
    ]);

    const toolMessages = persisted.filter(message => message.role === "tool");
    expect(toolMessages.map(message => message.tool_call_id)).toEqual(["c1", "c2"]);
    expect(toolMessages[1]!.content).toContain("exit code 7");

    // 成对性：下一次请求里 assistant 的调用与 tool 结果必须一一对应
    const second = requests[1]!;
    const callIds = second.messages
      .filter((message: any) => message.role === "assistant")
      .flatMap((message: any) => (message.tool_calls ?? []).map((call: any) => call.id));
    const resultIds = second.messages
      .filter((message: any) => message.role === "tool")
      .map((message: any) => message.tool_call_id);
    expect(callIds).toEqual(["c1", "c2"]);
    expect(resultIds).toEqual(["c1", "c2"]);
  });

  test("同阶段部分失败：该组结果全部进历史，后续阶段消失", async () => {
    const { persisted, requests } = await run([
      { id: "c1", args: { _order: 1 } },
      { id: "c2", args: { _order: 1, exit: 7 } },
      { id: "c3", args: { _order: 2 } },
      { id: "c4", args: {} },
    ]);

    const toolMessages = persisted.filter(message => message.role === "tool");
    expect(toolMessages.map(message => message.tool_call_id)).toEqual(["c1", "c2"]);
    expect(toolMessages[1]!.content).toContain("exit code 7");

    const second = requests[1]!;
    const callIds = second.messages
      .filter((message: any) => message.role === "assistant")
      .flatMap((message: any) => (message.tool_calls ?? []).map((call: any) => call.id));
    expect(callIds).toEqual(["c1", "c2"]);
  });
});
