import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
    CIRCUIT_COOLDOWN_MS,
    CIRCUIT_FAILURE_THRESHOLD,
    CircuitOpenError,
    isRetryableNetworkError,
    resetNetworkCircuit,
    withNetworkRetry,
} from "./network-retry.js";

const START = new Date("2030-01-01T00:00:00Z");

/** 不计等待、抖动用 0.5（系数 1.0）的重试环境：退避序列可直接断言。 */
function fastOptions(key: string) {
    const delays: number[] = [];
    return {
        delays,
        options: {
            key,
            wait: async (ms: number) => { delays.push(ms); },
            random: () => 0.5,
        },
    };
}

function connectionError(): Error {
    const error: any = new Error("socket hang up");
    error.code = "ECONNRESET";
    return error;
}

beforeEach(() => {
    resetNetworkCircuit();
    setSystemTime(START);
});

afterEach(() => {
    setSystemTime();
    resetNetworkCircuit();
});

describe("网络错误分类", () => {
    test("连接类错误、5xx 与 408 可重试", () => {
        expect(isRetryableNetworkError(connectionError())).toBe(true);
        expect(isRetryableNetworkError(Object.assign(new Error("boom"), { status: 502 }))).toBe(true);
        expect(isRetryableNetworkError(Object.assign(new Error("timeout"), { status: 408 }))).toBe(true);
        expect(isRetryableNetworkError(Object.assign(new Error("conn"), { name: "APIConnectionError" }))).toBe(true);
        expect(isRetryableNetworkError(new Error("fetch failed"))).toBe(true);
    });

    test("业务错误、限流与取消不算网络错误", () => {
        expect(isRetryableNetworkError(Object.assign(new Error("bad"), { status: 400 }))).toBe(false);
        expect(isRetryableNetworkError(Object.assign(new Error("auth"), { status: 401 }))).toBe(false);
        expect(isRetryableNetworkError(Object.assign(new Error("rate"), { status: 429 }))).toBe(false);
        expect(isRetryableNetworkError(new DOMException("请求已取消", "AbortError"))).toBe(false);
    });
});

describe("退避重试", () => {
    test("可重试错误按 0.5s/1s/2s 退避，第 3 次重试成功后返回", async () => {
        const { options, delays } = fastOptions("provider-a");
        let calls = 0;

        const result = await withNetworkRetry(async () => {
            calls += 1;
            if (calls <= 3) throw connectionError();
            return "ok";
        }, options);

        expect(result).toBe("ok");
        expect(calls).toBe(4);
        expect(delays).toEqual([500, 1_000, 2_000]);
    });

    test("重试次数耗尽后抛出原错误", async () => {
        const { options, delays } = fastOptions("provider-b");
        let calls = 0;

        const failure = await withNetworkRetry(async () => {
            calls += 1;
            throw connectionError();
        }, options).catch(error => error);

        expect(calls).toBe(4);
        expect(delays).toHaveLength(3);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe("socket hang up");
    });

    test("业务错误直接抛出，不重试也不影响熔断计数", async () => {
        const { options, delays } = fastOptions("provider-c");
        let calls = 0;

        await expect(withNetworkRetry(async () => {
            calls += 1;
            throw Object.assign(new Error("invalid request"), { status: 400 });
        }, options)).rejects.toThrow("invalid request");

        expect(calls).toBe(1);
        expect(delays).toEqual([]);
    });

    test("自定义 isRetryable 可挡掉不可重放的错误", async () => {
        const { options, delays } = fastOptions("provider-d");
        let calls = 0;

        await expect(withNetworkRetry(async () => {
            calls += 1;
            const error: any = connectionError();
            error.hasEmitted = true;
            throw error;
        }, {
            ...options,
            isRetryable: (error: any) => !error.hasEmitted && isRetryableNetworkError(error),
        })).rejects.toThrow("socket hang up");

        expect(calls).toBe(1);
        expect(delays).toEqual([]);
    });
});

describe("按 provider 熔断", () => {
    async function exhaustChain(key: string): Promise<void> {
        const { options } = fastOptions(key);
        await withNetworkRetry(async () => {
            throw connectionError();
        }, options).catch(() => undefined);
    }

    test("连续 5 次重试链失败后熔断，冷却期间直接报错", async () => {
        for (let index = 0; index < CIRCUIT_FAILURE_THRESHOLD; index += 1) await exhaustChain("provider-e");

        let calls = 0;
        const failure = await withNetworkRetry(async () => {
            calls += 1;
            return "ok";
        }, fastOptions("provider-e").options).catch(error => error);

        expect(calls).toBe(0);
        expect(failure).toBeInstanceOf(CircuitOpenError);
        expect((failure as CircuitOpenError).key).toBe("provider-e");

        // 别的 provider 不受影响
        await expect(withNetworkRetry(async () => "ok", fastOptions("provider-f").options)).resolves.toBe("ok");
    });

    test("冷却结束只放一次半开探测，成功即关闭熔断", async () => {
        for (let index = 0; index < CIRCUIT_FAILURE_THRESHOLD; index += 1) await exhaustChain("provider-g");
        setSystemTime(new Date(START.getTime() + CIRCUIT_COOLDOWN_MS + 1));

        const probe = fastOptions("provider-g");
        await expect(withNetworkRetry(async () => "ok", probe.options)).resolves.toBe("ok");

        // 熔断已关闭：后续请求正常放行
        await expect(withNetworkRetry(async () => "ok", fastOptions("provider-g").options)).resolves.toBe("ok");
    });

    test("半开探测失败会重新熔断", async () => {
        for (let index = 0; index < CIRCUIT_FAILURE_THRESHOLD; index += 1) await exhaustChain("provider-h");
        setSystemTime(new Date(START.getTime() + CIRCUIT_COOLDOWN_MS + 1));

        const probe = fastOptions("provider-h");
        await withNetworkRetry(async () => {
            throw connectionError();
        }, probe.options).catch(() => undefined);

        const failure = await withNetworkRetry(async () => "ok", fastOptions("provider-h").options).catch(error => error);
        expect(failure).toBeInstanceOf(CircuitOpenError);
    });
});
