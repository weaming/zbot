import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import {
    interpolateConfig,
    interpolateEnvVars,
    loadMcpServersConfig,
    normalizeParsedConfig,
    resolvePathWithTilde,
    validateRequiredEnv,
} from "../../src/mcp/config.js";

describe("mcp config", () => {
    test("resolvePathWithTilde 正确展开波浪号", () => {
        expect(resolvePathWithTilde("~/test/path")).toBe(path.join(os.homedir(), "test/path"));
        expect(resolvePathWithTilde("~")).toBe(os.homedir());
        expect(resolvePathWithTilde("/absolute/path")).toBe("/absolute/path");
    });

    test("interpolateEnvVars 正确替换环境变量", () => {
        process.env.TEST_MCP_KEY = "secret_123";
        expect(interpolateEnvVars("https://api.com?key=${TEST_MCP_KEY}")).toBe(
            "https://api.com?key=secret_123",
        );
        delete process.env.TEST_MCP_KEY;
    });

    test("validateRequiredEnv 检查环境变量是否存在", () => {
        process.env.TEST_EXISTING_VAR = "hello";
        expect(
            validateRequiredEnv({
                name: "test",
                type: "http",
                requiredEnv: ["TEST_EXISTING_VAR"],
            }),
        ).toEqual({ valid: true });

        expect(
            validateRequiredEnv({
                name: "test",
                type: "http",
                requiredEnv: ["TEST_NON_EXISTING_VAR_XYZ"],
            }),
        ).toEqual({ valid: false, missingEnv: "TEST_NON_EXISTING_VAR_XYZ" });

        delete process.env.TEST_EXISTING_VAR;
    });

    test("normalizeParsedConfig 兼容多种 YAML 结构", () => {
        // 数组结构
        const arrayYaml = [{ name: "s1", type: "http" }, { name: "s2", type: "stdio" }];
        expect(normalizeParsedConfig(arrayYaml).map((s) => s.name)).toEqual(["s1", "s2"]);

        // servers 包装结构
        const serversYaml = { servers: [{ name: "s3", type: "sse" }] };
        expect(normalizeParsedConfig(serversYaml).map((s) => s.name)).toEqual(["s3"]);

        // mcpServers 字典结构
        const mcpServersYaml = {
            mcpServers: {
                chrome: { command: "npx", args: ["chrome"], type: "stdio" },
            },
        };
        const normalized = normalizeParsedConfig(mcpServersYaml);
        expect(normalized.length).toBe(1);
        expect(normalized[0].name).toBe("chrome");
        expect(normalized[0].command).toBe("npx");
    });

    test("mcpServers 映射可配置多个独立客户端", () => {
        const normalized = normalizeParsedConfig({
            mcpServers: {
                local: { type: "stdio", command: "node" },
                remote: { type: "http", url: "https://example.com/mcp" },
            },
        });

        expect(normalized.map(server => server.name)).toEqual(["local", "remote"]);
        expect(normalized.map(server => server.type)).toEqual(["stdio", "http"]);
    });

    test("配置文件不存在时返回空数组（没有则不连）", () => {
        const nonExistentPath = path.join(os.tmpdir(), "non_existent_mcp_config.yaml");
        const configs = loadMcpServersConfig({
            configPath: nonExistentPath,
        });
        expect(configs).toEqual([]);
    });

    test("loadMcpServersConfig 正确解析 yaml 文件并支持协议版本与 stdio 配置", () => {
        const tmpFile = path.join(os.tmpdir(), `mcp_test_${Date.now()}.yaml`);
        const yamlContent = `
- name: direct-amap
  type: sse
  url: https://mcp.amap.com/sse
  protocolVersion: "2026-07-28"
  includeTools:
    - "maps_*"

- name: legacy-server
  type: http
  url: http://127.0.0.1:8080/mcp
  protocolVersion: "2025-11-25"
  defer: true
  lazy: true

- name: local-stdio
  type: stdio
  command: node
  args:
    - "./server.js"
  excludeTools:
    - "dangerous_*"
`;
        fs.writeFileSync(tmpFile, yamlContent, "utf-8");

        try {
            const configs = loadMcpServersConfig({ configPath: tmpFile });
            expect(configs.length).toBe(3);
            expect(configs[0].name).toBe("direct-amap");
            expect(configs[0].protocolVersion).toBe("2026-07-28");
            expect(configs[0].includeTools).toEqual(["maps_*"]);

            expect(configs[1].name).toBe("legacy-server");
            expect(configs[1].protocolVersion).toBe("2025-11-25");
            expect(configs[1].defer).toBe(true);
            expect(configs[1].lazy).toBe(true);

            expect(configs[2].name).toBe("local-stdio");
            expect(configs[2].type).toBe("stdio");
            expect(configs[2].command).toBe("node");
            expect(configs[2].excludeTools).toEqual(["dangerous_*"]);
        } finally {
            fs.unlinkSync(tmpFile);
        }
    });
});
