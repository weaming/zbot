import { createHash } from "node:crypto";

/**
 * 清理可选的输出状态，并修复历史 Responses 工具调用 item ID。
 *
 * 补出来的 ID 必须**确定性**：同一调用每次请求都要得到同一个 ID。上游会按前缀复用
 * 缓存，交换日志的增量比对也按前缀 hash 判定；一旦每次请求换 ID，整段历史都算"变了"，
 * 于是每次请求都全量重写日志、上游缓存全失效（单会话一天能撑到 GB 级）。
 */
export function repairResponsesFunctionCallItemIds(items: any[]): any[] {
  return items.map((item) => {
    if (!item || typeof item !== "object") return item;
    const hasStatus = Object.hasOwn(item, "status")
      && ["function_call", "custom_tool_call", "message", "reasoning"].includes(item.type);
    const hasInvalidFunctionCallId = item.type === "function_call" && item.id !== undefined
      && (typeof item.id !== "string" || !item.id.startsWith("fc"));
    const hasInvalidCustomCallId = item.type === "custom_tool_call" && item.id !== undefined
      && (typeof item.id !== "string" || !item.id.startsWith("ctc"));
    if (!hasStatus && !hasInvalidFunctionCallId && !hasInvalidCustomCallId) return item;

    const inputItem = { ...item };
    delete inputItem.status;
    if (hasInvalidFunctionCallId) inputItem.id = stableItemId("fc", item);
    if (hasInvalidCustomCallId) inputItem.id = stableItemId("ctc", item);
    return inputItem;
  });
}

/**
 * 由调用自身的稳定字段派生 ID：call_id 优先（同一调用的唯一标识），
 * 缺 call_id 的老数据退化为「工具名 + 参数」，两者都在历史里不会变。
 */
function stableItemId(prefix: "fc" | "ctc", item: any): string {
  const seed = typeof item.call_id === "string" && item.call_id
    ? item.call_id
    : JSON.stringify([item.name ?? null, item.arguments ?? item.input ?? null]);
  return `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}
