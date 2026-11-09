/** 判定同一会话时允许的短 id 最短长度：短于此只认完全相等，避免 "1" 之类的巧合匹配。 */
const MIN_SUFFIX_MATCH_LENGTH = 8;

/** 会话 id → 文件名安全形式（事件日志/锁/快照统一口径）。 */
export function sanitizeSessionId(sessionId: string): string {
    return sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
}

/** 短 id：列表、日志与工具文案里惯用末 8 位。 */
export function shortSessionId(sessionId: string): string {
    return sessionId.length > 8 ? sessionId.slice(-8) : sessionId;
}

/** 会话 id 是否是完整 ULID（Crockford Base32，26 位，去掉 I L O U）。 */
export function isUlid(sessionId: string): boolean {
    return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(sessionId);
}

/**
 * 两个 id 是否指向同一个会话：大小写不敏感（ULID 是 Crockford Base32），
 * 允许一方是另一方的末几位（列表与提示里惯用末 8 位短 id）。
 */
export function isSameSession(left: string | undefined, right: string | undefined): boolean {
    const a = (left ?? "").trim().toUpperCase();
    const b = (right ?? "").trim().toUpperCase();
    if (!a || !b) return false;
    if (a === b) return true;
    const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
    return shorter.length >= MIN_SUFFIX_MATCH_LENGTH && longer.endsWith(shorter);
}
