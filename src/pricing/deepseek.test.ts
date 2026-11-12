import { describe, expect, test } from "bun:test";
import {
    deepSeekCostYuan,
    deepSeekPhaseInfo,
    deepSeekSnapshotAt,
    endpointHost,
    formatCostYuan,
    goDurationMinutes,
    isDeepSeekCostStatEnabled,
    isDeepSeekPeakTime,
    isOfficialDeepSeekEndpoint,
    normalizeDeepSeekModel,
    officialDeepSeekCostYuan,
    resolvePricingMode,
} from "./deepseek.js";

// 北京时间 = UTC+8：北京周一 09:00 即 UTC 周一 01:00
const MON_09_BJT = Date.parse("2026-09-07T01:00:00Z"); // 09:00 高峰开始
const MON_1159_BJT = Date.parse("2026-09-07T03:59:00Z");
const MON_1200_BJT = Date.parse("2026-09-07T04:00:00Z"); // 高峰结束
const MON_1400_BJT = Date.parse("2026-09-07T06:00:00Z");
const MON_1759_BJT = Date.parse("2026-09-07T09:59:00Z");
const MON_1800_BJT = Date.parse("2026-09-07T10:00:00Z");
const MON_0859_BJT = Date.parse("2026-09-07T00:59:00Z");
const SAT_1000_BJT = Date.parse("2026-09-12T02:00:00Z");
const MON_1000_BJT = Date.parse("2026-09-07T02:00:00Z");
const FRI_1830_BJT = Date.parse("2026-09-11T10:30:00Z");
// 2026-09-10 12:00（北京）起 Flash 系列降价：09-07 属旧价段，09-12 起属新价段
const CUT_1159_BJT = Date.parse("2026-09-10T03:59:00Z");
const CUT_1200_BJT = Date.parse("2026-09-10T04:00:00Z");
const OLD_OFFPEAK_BJT = Date.parse("2026-09-08T14:00:00Z"); // 北京 09-08 周二 22:00（旧价段空闲）
const NEW_PEAK_BJT = Date.parse("2026-09-16T02:00:00Z"); // 北京 09-16 周三 10:00（新价段高峰）

describe("normalizeDeepSeekModel", () => {
    test("官方模型名严格匹配到 flash / pro 两档", () => {
        expect(normalizeDeepSeekModel("deepseek-v4-flash")).toBe("flash");
        expect(normalizeDeepSeekModel("deepseek-v4-flash-0731")).toBe("flash");
        expect(normalizeDeepSeekModel("deepseek-v4-pro")).toBe("pro");
        expect(normalizeDeepSeekModel("deepseek-v4-pro-0813")).toBe("pro");
        // vision 与 flash 同价，归入 flash 档
        expect(normalizeDeepSeekModel("deepseek-v4-flash-vision-exp")).toBe("flash");
        expect(normalizeDeepSeekModel("deepseek-v4.1-flash")).toBeUndefined();
        expect(normalizeDeepSeekModel("deepseek-flash")).toBe("flash");
        expect(normalizeDeepSeekModel("DEEPSEEK-V4-FLASH")).toBe("flash");
    });

    test("严格模式不认第三方网关名与价格表外模型", () => {
        expect(normalizeDeepSeekModel("workbuddy-ai/deepseek-v4.1-flash-sg")).toBeUndefined();
        expect(normalizeDeepSeekModel("deepseek-chat")).toBeUndefined();
        expect(normalizeDeepSeekModel("deepseek-reasoner")).toBeUndefined();
        expect(normalizeDeepSeekModel("")).toBeUndefined();
        expect(normalizeDeepSeekModel(undefined)).toBeUndefined();
        expect(normalizeDeepSeekModel("gpt-5.6-luna")).toBeUndefined();
    });

    test("宽松模式要同时含 deepseek 与 flash / pro（前缀后缀随意）", () => {
        expect(normalizeDeepSeekModel("workbuddy-ai/deepseek-v4.1-flash-sg", true)).toBe("flash");
        expect(normalizeDeepSeekModel("deepseek-v4.1-flash", true)).toBe("flash");
        expect(normalizeDeepSeekModel("vllm/deepseek-pro-0813", true)).toBe("pro");
    });

    test("宽松模式拒绝不含 deepseek 的别名与缺关键词的名字", () => {
        expect(normalizeDeepSeekModel("any-flash", true)).toBeUndefined();
        expect(normalizeDeepSeekModel("pro-coder", true)).toBeUndefined();
        expect(normalizeDeepSeekModel("gpt-5.6-luna", true)).toBeUndefined();
        expect(normalizeDeepSeekModel("deepseek-chat", true)).toBeUndefined();
        expect(normalizeDeepSeekModel("", true)).toBeUndefined();
    });

    test("flash 优先于 pro：同时含两关键词时归 flash", () => {
        expect(normalizeDeepSeekModel("deepseek-flash-pro", true)).toBe("flash");
    });
});

describe("isOfficialDeepSeekEndpoint", () => {
    test("仅 host 为 api.deepseek.com 视为官方", () => {
        expect(isOfficialDeepSeekEndpoint("https://api.deepseek.com")).toBe(true);
        expect(isOfficialDeepSeekEndpoint("https://api.deepseek.com/v1")).toBe(true);
        expect(isOfficialDeepSeekEndpoint("https://api.deepseek.com/anthropic")).toBe(true);
        expect(isOfficialDeepSeekEndpoint("https://api.deepseek.com.evil.example")).toBe(false);
        expect(isOfficialDeepSeekEndpoint("https://gateway.example.com/v1")).toBe(false);
        expect(isOfficialDeepSeekEndpoint("https://api.openai.com/v1")).toBe(false);
        expect(isOfficialDeepSeekEndpoint("not a url")).toBe(false);
        expect(isOfficialDeepSeekEndpoint(undefined)).toBe(false);
    });

    test("endpointHost 提取 host（小写、剔路径与查询）", () => {
        expect(endpointHost("https://api.deepseek.com/anthropic")).toBe("api.deepseek.com");
        expect(endpointHost("https://API.DeepSeek.com/v1?key=***")).toBe("api.deepseek.com");
        expect(endpointHost("not a url")).toBeUndefined();
        expect(endpointHost(undefined)).toBeUndefined();
    });
});

describe("isDeepSeekCostStatEnabled", () => {
    test("配置为真时开启", () => {
        expect(isDeepSeekCostStatEnabled(true)).toBe(true);
    });

    test("默认关闭", () => {
        expect(isDeepSeekCostStatEnabled(false)).toBe(false);
        expect(isDeepSeekCostStatEnabled()).toBe(false);
    });
});

describe("resolvePricingMode", () => {
    test("官方端点恒计费且用严格匹配", () => {
        expect(resolvePricingMode("api.deepseek.com", {})).toEqual({ looseModel: false });
        expect(resolvePricingMode("api.deepseek.com", { enableCostStat: true })).toEqual({ looseModel: false });
    });

    test("第三方端点仅开关打开后计费，且用宽松匹配", () => {
        expect(resolvePricingMode("127.0.0.1", {})).toBeUndefined();
        expect(resolvePricingMode("gateway.example.com", { enableCostStat: false })).toBeUndefined();
        expect(resolvePricingMode("127.0.0.1", { enableCostStat: true })).toEqual({ looseModel: true });
    });
});

describe("isDeepSeekPeakTime", () => {
    test("工作日 9-12 与 14-18 为高峰（含起不含止）", () => {
        expect(isDeepSeekPeakTime(MON_09_BJT)).toBe(true);
        expect(isDeepSeekPeakTime(MON_1159_BJT)).toBe(true);
        expect(isDeepSeekPeakTime(MON_1200_BJT)).toBe(false);
        expect(isDeepSeekPeakTime(MON_1400_BJT)).toBe(true);
        expect(isDeepSeekPeakTime(MON_1759_BJT)).toBe(true);
        expect(isDeepSeekPeakTime(MON_1800_BJT)).toBe(false);
        expect(isDeepSeekPeakTime(MON_0859_BJT)).toBe(false);
    });

    test("周末全天空闲", () => {
        expect(isDeepSeekPeakTime(SAT_1000_BJT)).toBe(false);
    });
});

describe("deepSeekPhaseInfo", () => {
    test("高峰时段内返回下次切谷边界（分钟精度）", () => {
        const info = deepSeekPhaseInfo(MON_1000_BJT);
        expect(info.phase).toBe("peak");
        expect(goDurationMinutes(info.switchInMs)).toBe("2h"); // 10:00 → 12:00
    });

    test("午间空闲段切到下午高峰", () => {
        const noon = Date.parse("2026-09-07T04:30:00Z"); // 北京 12:30
        const info = deepSeekPhaseInfo(noon);
        expect(info.phase).toBe("offpeak");
        expect(goDurationMinutes(info.switchInMs)).toBe("1h30m"); // → 14:00
    });

    test("周五晚空闲跨周末到下周一 09:00 高峰", () => {
        const info = deepSeekPhaseInfo(FRI_1830_BJT);
        expect(info.phase).toBe("offpeak");
        expect(goDurationMinutes(info.switchInMs)).toBe("62h30m"); // 18:30 → 下周一 09:00
    });

    test("边界前 1 分钟内向上取整为 1m", () => {
        const beforeEnd = Date.parse("2026-09-07T09:59:30Z"); // 北京 17:59:30，距 18:00 半分钟
        const info = deepSeekPhaseInfo(beforeEnd);
        expect(info.phase).toBe("peak");
        expect(goDurationMinutes(info.switchInMs)).toBe("1m");
    });
});

describe("goDurationMinutes", () => {
    test("Go Duration 风格（分钟精度、无前导零）", () => {
        expect(goDurationMinutes(45_000)).toBe("1m");
        expect(goDurationMinutes(90_000)).toBe("2m");
        expect(goDurationMinutes(60 * 60 * 1000)).toBe("1h");
        expect(goDurationMinutes(2 * 60 * 60 * 1000 + 3 * 60 * 1000)).toBe("2h3m");
        expect(goDurationMinutes(62 * 60 * 60 * 1000 + 30 * 60 * 1000)).toBe("62h30m");
    });
});

/** flash 的一次 usage（promptTokens = 缓存命中 + 未命中）。 */
function flashUsage(cacheHit: number, cacheMiss: number, completion: number) {
    return {
        model: "deepseek-v4-flash",
        promptTokens: cacheHit + cacheMiss,
        cacheHitTokens: cacheHit,
        cacheMissTokens: cacheMiss,
        completionTokens: completion,
    };
}

describe("deepSeekSnapshotAt", () => {
    test("按调用时刻选段，09-10 12:00 为分界（含起）", () => {
        expect(deepSeekSnapshotAt(CUT_1159_BJT).effectiveFrom).toBe("2026-08-17T00:00:00+08:00");
        expect(deepSeekSnapshotAt(CUT_1200_BJT).effectiveFrom).toBe("2026-09-10T12:00:00+08:00");
        // 早于最早段（历史定价体系不同）按最早段近似
        expect(deepSeekSnapshotAt(Date.parse("2026-01-01T00:00:00Z")).effectiveFrom).toBe("2026-08-17T00:00:00+08:00");
    });

    test("Flash 系列降价自 09-10 12:00 生效，Pro 不变", () => {
        const oldPrices = deepSeekSnapshotAt(CUT_1159_BJT).models;
        const newPrices = deepSeekSnapshotAt(CUT_1200_BJT).models;
        expect([oldPrices.flash.offpeak.cacheHit, oldPrices.flash.offpeak.cacheMiss, oldPrices.flash.offpeak.output]).toEqual([0.05, 1.5, 4.5]);
        expect([newPrices.flash.offpeak.cacheHit, newPrices.flash.offpeak.cacheMiss, newPrices.flash.offpeak.output]).toEqual([0.02, 1.0, 4.0]);
        expect([newPrices.flash.peak.cacheHit, newPrices.flash.peak.cacheMiss, newPrices.flash.peak.output]).toEqual([0.04, 2.0, 8.0]);
        expect(newPrices.pro).toEqual(oldPrices.pro);
    });

    test("价格表只有 flash / pro 两档（vision 已并入 flash）", () => {
        for (const snapshot of [deepSeekSnapshotAt(CUT_1159_BJT), deepSeekSnapshotAt(CUT_1200_BJT)]) {
            expect(Object.keys(snapshot.models).sort()).toEqual(["flash", "pro"]);
        }
    });
});

describe("deepSeekCostYuan", () => {
    test("三部分计价：旧价段高峰（09-07 周一 10:00）", () => {
        expect(deepSeekCostYuan(flashUsage(1_000_000, 1_000_000, 0), MON_1000_BJT)).toBeCloseTo(0.1 + 3.0, 6);
    });

    test("旧价段空闲为高峰一半（09-08 周二 22:00）", () => {
        expect(deepSeekCostYuan(flashUsage(1_000_000, 0, 0), OLD_OFFPEAK_BJT)).toBeCloseTo(0.05, 6);
    });

    test("新价段（09-10 12:00 起）：空闲 0.02/1/4，高峰为其两倍", () => {
        expect(deepSeekCostYuan(flashUsage(1_000_000, 1_000_000, 1_000_000), CUT_1200_BJT)).toBeCloseTo(0.02 + 1.0 + 4.0, 6);
        expect(deepSeekCostYuan(flashUsage(1_000_000, 1_000_000, 1_000_000), NEW_PEAK_BJT)).toBeCloseTo(0.04 + 2.0 + 8.0, 6);
    });

    test("严格模式不认 v4.1 别名：官方端点按 0 计（有开关才走宽松匹配）", () => {
        const usage = { ...flashUsage(1_000_000, 1_000_000, 1_000_000), model: "deepseek-v4.1-flash" };
        expect(deepSeekCostYuan(usage, CUT_1200_BJT)).toBe(0);
        expect(deepSeekCostYuan(usage, CUT_1200_BJT, true)).toBeCloseTo(0.02 + 1.0 + 4.0, 6);
    });

    test("输出（含 reasoning）按输出单价计，Pro 两段同价", () => {
        const proOutput = { model: "deepseek-v4-pro", promptTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, completionTokens: 1_000_000 };
        expect(deepSeekCostYuan(proOutput, MON_1000_BJT)).toBeCloseTo(27.0, 6);
        expect(deepSeekCostYuan(proOutput, NEW_PEAK_BJT)).toBeCloseTo(27.0, 6);
    });

    test("价格表外模型返回 0", () => {
        const usage = { model: "deepseek-chat", promptTokens: 1_000_000, cacheHitTokens: 0, cacheMissTokens: 1_000_000, completionTokens: 0 };
        expect(deepSeekCostYuan(usage, MON_1000_BJT)).toBe(0);
    });
});

describe("officialDeepSeekCostYuan", () => {
    const usage = {
        model: "deepseek-v4-flash",
        promptTokens: 2_000_000,
        cacheHitTokens: 1_000_000,
        cacheMissTokens: 1_000_000,
        completionTokens: 0,
    };
    const settings = { model: "deepseek-v4-flash", apiBase: "https://api.deepseek.com" };

    test("官方接入按峰谷计费", () => {
        expect(officialDeepSeekCostYuan(usage, MON_09_BJT, settings)).toBeCloseTo(3.1, 6);
        // 周六 10:00 属空闲，且 09-12 已在新价段：0.02 + 1.0
        expect(officialDeepSeekCostYuan(usage, SAT_1000_BJT, settings)).toBeCloseTo(1.02, 6);
    });

    test("第三方接入不计费", () => {
        expect(officialDeepSeekCostYuan(usage, MON_09_BJT, { model: "deepseek-v4-flash", apiBase: "https://gateway.example.com/v1" })).toBe(0);
    });

    test("非 deepseek 模型不计费", () => {
        expect(officialDeepSeekCostYuan({ ...usage, model: "gpt-5.6-luna" }, MON_09_BJT, settings)).toBe(0);
    });

    test("落盘时的 apiHost 优先于当前配置（历史不受换端点影响）", () => {
        const relaySettings = { model: "deepseek-v4-flash", apiBase: "https://gateway.example.com/v1" };
        // 历史走官方：现在配置换成中转，仍按官方计费
        expect(officialDeepSeekCostYuan({ ...usage, apiHost: "api.deepseek.com" }, MON_09_BJT, relaySettings)).toBeCloseTo(3.1, 6);
        // 历史走中转：现在配置换成官方，仍不计费
        expect(officialDeepSeekCostYuan({ ...usage, apiHost: "gateway.example.com" }, MON_09_BJT, settings)).toBe(0);
    });

    test("开启 deepseekCostStat 后局域网网关也按官方价计费（仍需模型命中价格表）", () => {
        const lanSettings = { model: "deepseek-v4-flash", apiBase: "http://127.0.0.1:3030/v1", enableCostStat: true };
        expect(officialDeepSeekCostYuan({ ...usage, apiHost: "127.0.0.1" }, MON_09_BJT, lanSettings)).toBeCloseTo(3.1, 6);
        expect(officialDeepSeekCostYuan({ ...usage, apiHost: "192.168.1.10", model: "gpt-5.6-luna" }, MON_09_BJT, lanSettings)).toBe(0);
        // 开关关闭时局域网端点仍不计
        expect(officialDeepSeekCostYuan({ ...usage, apiHost: "127.0.0.1" }, MON_09_BJT, { ...lanSettings, enableCostStat: false })).toBe(0);
    });

    test("开关打开时第三方网关名（含前缀/后缀）按 flash 档计费", () => {
        const relaySettings = { model: "workbuddy-ai/deepseek-v4.1-flash-sg", apiBase: "http://127.0.0.1:3425", enableCostStat: true };
        const relayUsage = { ...usage, model: "workbuddy-ai/deepseek-v4.1-flash-sg", apiHost: "127.0.0.1" };
        // 与官方同一时刻同价：高峰 0.1 + 3.0
        expect(officialDeepSeekCostYuan(relayUsage, MON_09_BJT, relaySettings)).toBeCloseTo(3.1, 6);
        // 开关关闭则不计
        expect(officialDeepSeekCostYuan(relayUsage, MON_09_BJT, { ...relaySettings, enableCostStat: false })).toBe(0);
    });

    test("官方端点保持严格匹配，即使开关打开也不放宽", () => {
        const settingsWithFlag = { model: "workbuddy-ai/deepseek-v4.1-flash-sg", apiBase: "https://api.deepseek.com", enableCostStat: true };
        expect(officialDeepSeekCostYuan({ ...usage, model: "workbuddy-ai/deepseek-v4.1-flash-sg", apiHost: "api.deepseek.com" }, MON_09_BJT, settingsWithFlag)).toBe(0);
    });
});

describe("formatCostYuan", () => {
    test("各量级展示", () => {
        expect(formatCostYuan(0)).toBe("¥0");
        expect(formatCostYuan(0.004)).toBe("¥<0.01");
        expect(formatCostYuan(0.37)).toBe("¥0.37");
        expect(formatCostYuan(12.345)).toBe("¥12.35");
        expect(formatCostYuan(1234.5)).toBe("¥1,235");
    });
});
