/**
 * 事件分页参数：`limit` 指定一页条数，`before` 是"取更早"的游标（seq 严格更小）。
 *
 * 不带 limit 时接口保持原来的全量语义——CLI 与其他读端仍按整份日志工作，
 * 只有浏览器时间线需要"先看最后一屏，再往上翻"。
 */

/** 单页上限：再大就失去分页意义，也挡不住一次拉满整份日志。 */
const MAX_LIMIT = 1000;

export interface EventPageParams {
    /** 缺省表示全量。 */
    limit?: number;
    /** 缺省表示从最新一条开始往前取。 */
    before: number;
}

export function parseEventPage(url: URL): EventPageParams | { error: string } {
    const rawLimit = url.searchParams.get("limit")?.trim();
    const rawBefore = url.searchParams.get("before")?.trim();
    if (rawBefore !== undefined && rawBefore !== "" && !/^\d+$/.test(rawBefore)) {
        return { error: "before 必须是非负整数" };
    }
    const before = rawBefore ? Number.parseInt(rawBefore, 10) : Number.MAX_SAFE_INTEGER;
    if (!rawLimit) return { before };
    if (!/^\d+$/.test(rawLimit)) return { error: "limit 必须是正整数" };
    const limit = Number.parseInt(rawLimit, 10);
    if (limit <= 0) return { error: "limit 必须是正整数" };
    return { limit: Math.min(limit, MAX_LIMIT), before };
}
