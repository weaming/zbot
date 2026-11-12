import { afterEach, describe, expect, test } from "bun:test";
import { readEnvValue, resolveEnvReference } from "./env-ref.js";

const TOUCHED = ["ZBOT_REF_KEY", "ZBOT_REF_ALIAS", "ZBOT_REF_LOOP_A", "ZBOT_REF_LOOP_B"];

function writeEnv(entries: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(entries)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

afterEach(() => writeEnv(Object.fromEntries(TOUCHED.map(key => [key, undefined]))));

describe("配置值里的环境变量引用", () => {
    test("不是引用的值原样返回", () => {
        expect(resolveEnvReference("sk-plain")).toBe("sk-plain");
        expect(resolveEnvReference("sk-含$符号")).toBe("sk-含$符号");
    });

    test("$NAME 与 ${NAME} 都取目标环境变量的值", () => {
        writeEnv({ ZBOT_REF_KEY: "sk-real" });

        expect(resolveEnvReference("$ZBOT_REF_KEY")).toBe("sk-real");
        expect(resolveEnvReference("${ZBOT_REF_KEY}")).toBe("sk-real");
        expect(resolveEnvReference("  $ZBOT_REF_KEY  ")).toBe("sk-real");
    });

    test("链式引用一路展开到真实值", () => {
        writeEnv({ ZBOT_REF_KEY: "sk-real", ZBOT_REF_ALIAS: "$ZBOT_REF_KEY" });

        expect(resolveEnvReference("$ZBOT_REF_ALIAS")).toBe("sk-real");
    });

    test("目标未设置或成环时按空值处理", () => {
        writeEnv({ ZBOT_REF_LOOP_A: "$ZBOT_REF_LOOP_B", ZBOT_REF_LOOP_B: "$ZBOT_REF_LOOP_A" });

        expect(resolveEnvReference("$ZBOT_REF_MISSING")).toBe("");
        expect(resolveEnvReference("${ZBOT_REF_MISSING}")).toBe("");
        expect(resolveEnvReference("$ZBOT_REF_LOOP_A")).toBe("");
    });

    test("readEnvValue 区分未设置与引用落空", () => {
        writeEnv({ ZBOT_REF_KEY: "$ZBOT_REF_MISSING", ZBOT_REF_ALIAS: "$ZBOT_REF_KEY" });

        expect(readEnvValue("ZBOT_REF_NOT_DEFINED_AT_ALL")).toBeUndefined();
        expect(readEnvValue("ZBOT_REF_ALIAS")).toBe("");
    });
});
