import { describe, expect, test } from "bun:test";
import { repairResponsesFunctionCallItemIds } from "../../src/tools/orchestrator/responses-input.js";

describe("Responses input repair", () => {
  test("replaces an invalid function_call item ID and preserves its call ID", () => {
    const call = {
      type: "function_call",
      id: "call_nf6z7KGHANvp7uUZb1WhPzpx",
      call_id: "call_nf6z7KGHANvp7uUZb1WhPzpx",
    };

    const [repaired] = repairResponsesFunctionCallItemIds([call]);

    expect(repaired.id).toMatch(/^fc/);
    expect(repaired.call_id).toBe(call.call_id);
    expect(repaired).not.toBe(call);
  });

  test("derives the same ID for the same call across requests", () => {
    const call = { type: "function_call", id: "call_stable", call_id: "call_stable", name: "bash" };

    const first = repairResponsesFunctionCallItemIds([call])[0];
    const second = repairResponsesFunctionCallItemIds([{ ...call }])[0];

    // 请求体会逐字节比较（上游前缀缓存 + 日志增量），ID 不能每次请求都变
    expect(second.id).toBe(first.id);
  });

  test("derives different IDs for different calls", () => {
    const one = repairResponsesFunctionCallItemIds([
      { type: "function_call", id: "call_a", call_id: "call_a", name: "bash" },
    ])[0];
    const two = repairResponsesFunctionCallItemIds([
      { type: "function_call", id: "call_b", call_id: "call_b", name: "bash" },
    ])[0];

    expect(one.id).not.toBe(two.id);
  });

  test("falls back to tool name and arguments when call_id is missing", () => {
    const call = { type: "custom_tool_call", id: "ctc_bad", name: "apply_patch", input: "*** Begin Patch" };

    const first = repairResponsesFunctionCallItemIds([call])[0];
    const second = repairResponsesFunctionCallItemIds([{ ...call }])[0];

    expect(first.id).toMatch(/^ctc_/);
    expect(second.id).toBe(first.id);
  });

  test("preserves valid function_call IDs and unrelated items", () => {
    const call = { type: "function_call", id: "fc_original", call_id: "call_original" };
    const message = { type: "message", id: "msg_original" };

    const repaired = repairResponsesFunctionCallItemIds([call, message]);

    expect(repaired).toEqual([call, message]);
    expect(repaired[0]).toBe(call);
    expect(repaired[1]).toBe(message);
  });

  test("removes output status without modifying the original item", () => {
    const call = { type: "function_call", id: "fc_original", status: "completed" };

    const [repaired] = repairResponsesFunctionCallItemIds([call]);

    expect(repaired).toEqual({ type: "function_call", id: "fc_original" });
    expect(repaired).not.toBe(call);
    expect(call.status).toBe("completed");
  });

  test("preserves required hosted tool statuses during replay", () => {
    const hostedItems = [
      { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", queries: ["nginx"] } },
      { type: "file_search_call", id: "fs_1", status: "completed", queries: ["nginx"] },
      { type: "code_interpreter_call", id: "ci_1", status: "completed", code: "print(1)" },
      { type: "image_generation_call", id: "ig_1", status: "completed", result: "image" },
      { type: "tool_search_call", id: "ts_1", status: "completed", call_id: "call_1" },
    ];

    const repaired = repairResponsesFunctionCallItemIds(hostedItems);

    expect(repaired).toEqual(hostedItems);
    repaired.forEach((item, index) => expect(item).toBe(hostedItems[index]));
  });
});
