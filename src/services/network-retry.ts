/**
 * 对话主链路的网络重试与熔断。
 *
 * 只认连接类错误、5xx 与 408：指数退避（0.5s 起、×2、带 jitter、最多重试 3 次）。
 * 同一 provider 连续 5 次重试仍失败就熔断 60s，期间直接报错不再打上游；
 * 冷却结束后只放一次半开探测，成功则关闭熔断，失败则继续冷却。
 */

/** 单次重试链最多重试几次（不含首次请求）。 */
export const MAX_RETRY_ATTEMPTS = 3;
/** 退避起点、上限与抖动幅度（0.75～1.25 倍）。 */
export const RETRY_BASE_DELAY_MS = 500;
export const RETRY_MAX_DELAY_MS = 8_000;
/** 同一 provider 连续失败多少次后熔断，以及冷却时长。 */
export const CIRCUIT_FAILURE_THRESHOLD = 5;
export const CIRCUIT_COOLDOWN_MS = 60_000;

const RETRYABLE_CODES = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
]);

const RETRYABLE_MESSAGE = /socket hang up|fetch failed|other side closed|connection (?:reset|closed)|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i;

/** 熔断打开时抛出的错误：调用方据此给出可读提示，不再重试。 */
export class CircuitOpenError extends Error {
    constructor(readonly key: string, readonly retryAfterMs: number) {
        super(`${key} 连续失败已熔断，${Math.ceil(retryAfterMs / 1000)}s 后再试`);
        this.name = "CircuitOpenError";
    }
}

export interface RetryInfo {
    /** 第几次重试（从 1 开始）。 */
    attempt: number;
    delayMs: number;
    error: unknown;
}

export interface NetworkRetryOptions {
    /** 熔断维度：一般用 provider 的 baseURL。 */
    key: string;
    signal?: AbortSignal;
    /** 默认只把网络类错误视为可重试；调用方可以额外排除「已输出内容」等不可重放场景。 */
    isRetryable?: (error: unknown) => boolean;
    onRetry?: (info: RetryInfo) => void;
    /** 测试注入点：默认真实等待与随机抖动。 */
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
    random?: () => number;
}

interface BreakerState {
    failures: number;
    /** 0 表示关闭；否则为熔断截止时间戳。 */
    openedUntil: number;
    isProbing: boolean;
}

/** 判断错误是否属于「重试可能有用」的网络问题。 */
export function isRetryableNetworkError(error: any): boolean {
    const status = Number(error?.status ?? error?.response?.status);
    if (Number.isFinite(status) && status > 0) return status === 408 || status >= 500;

    const code = String(error?.code ?? error?.cause?.code ?? error?.errno ?? "");
    if (RETRYABLE_CODES.has(code)) return true;

    const name = String(error?.name ?? "");
    if (name === "APIConnectionError" || name === "APIConnectionTimeoutError" || name === "TimeoutError") return true;

    return RETRYABLE_MESSAGE.test(String(error?.message ?? ""));
}

/** 按 provider 维度记录连续失败的熔断器（进程内状态）。 */
class CircuitBreaker {
    private readonly states = new Map<string, BreakerState>();

    acquire(key: string, now = Date.now()): { isProbe: boolean } | { retryAfterMs: number } {
        const state = this.states.get(key);
        if (!state || state.openedUntil === 0) return { isProbe: false };
        if (now < state.openedUntil) return { retryAfterMs: state.openedUntil - now };
        // 冷却到期：只放一次探测，其余请求继续按熔断失败
        if (state.isProbing) return { retryAfterMs: Math.max(1_000, state.openedUntil - now) };
        state.isProbing = true;
        return { isProbe: true };
    }

    recordSuccess(key: string): void {
        this.states.delete(key);
    }

    recordFailure(key: string, now = Date.now()): void {
        const state = this.states.get(key) ?? { failures: 0, openedUntil: 0, isProbing: false };
        this.states.set(key, state);

        // 半开探测失败或已经熔断：重新计时冷却
        if (state.isProbing || state.openedUntil > now) {
            state.isProbing = false;
            state.openedUntil = now + CIRCUIT_COOLDOWN_MS;
            state.failures = 0;
            return;
        }
        state.failures += 1;
        if (state.failures >= CIRCUIT_FAILURE_THRESHOLD) {
            state.failures = 0;
            state.openedUntil = now + CIRCUIT_COOLDOWN_MS;
        }
    }

    reset(): void {
        this.states.clear();
    }
}

const circuit = new CircuitBreaker();

/** 退避序列：0.5s → 1s → 2s，抖动 ±25%，并受上限约束。 */
export function networkBackoffDelay(attempt: number, random: () => number = Math.random): number {
    const base = Math.min(RETRY_MAX_DELAY_MS, resolveBaseDelayMs() * 2 ** attempt);
    return Math.round(base * (0.75 + random() * 0.5));
}

/** 起点延迟可由环境变量覆盖：测试压到毫秒级，避免用例真等 3.5s。 */
function resolveBaseDelayMs(): number {
    const configured = Number(process.env.ZBOT_RETRY_BASE_DELAY_MS);
    return Number.isFinite(configured) && configured >= 0 ? configured : RETRY_BASE_DELAY_MS;
}

/** 可被取消的等待；手动重试循环与 withNetworkRetry 共用。 */
export function retrySleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("请求已取消", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
    });
}

/** 手动重试循环的开场：熔断中直接抛 CircuitOpenError，不放请求出去。 */
export function requireRetryPermit(key: string): void {
    const lease = circuit.acquire(key);
    if ("retryAfterMs" in lease) throw new CircuitOpenError(key, lease.retryAfterMs);
}

export function reportNetworkSuccess(key: string): void {
    circuit.recordSuccess(key);
}

export function reportNetworkFailure(key: string): void {
    circuit.recordFailure(key);
}

/**
 * 跑一次可能因网络失败的操作，失败按退避重试。
 *
 * 只有「可重试错误」才计入熔断计数：业务错误（4xx、参数非法）直接抛出，不影响熔断。
 */
export async function withNetworkRetry<T>(
    run: () => Promise<T>,
    options: NetworkRetryOptions,
): Promise<T> {
    const { key, signal, isRetryable = isRetryableNetworkError, onRetry } = options;
    const wait = options.wait ?? retrySleep;
    const random = options.random ?? Math.random;

    requireRetryPermit(key);

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
        try {
            const result = await run();
            reportNetworkSuccess(key);
            return result;
        } catch (error) {
            if (signal?.aborted) throw error;
            if (!isRetryable(error)) throw error;
            lastError = error;
            if (attempt === MAX_RETRY_ATTEMPTS) break;

            const delayMs = networkBackoffDelay(attempt, random);
            onRetry?.({ attempt: attempt + 1, delayMs, error });
            await wait(delayMs, signal);
        }
    }

    reportNetworkFailure(key);
    throw lastError;
}

/** 清空熔断状态（测试与 /reload 后重置用）。 */
export function resetNetworkCircuit(): void {
    circuit.reset();
}
