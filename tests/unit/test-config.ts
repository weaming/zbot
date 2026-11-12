/**
 * 测试用的 config.yaml 夹具：写临时文件并挂到 `ZBOT_CONFIG_FILE`。
 *
 * 配置是进程级单例（带缓存），任何改动都要 `reloadConfig()`；
 * 用例结束后用返回的 restore 还原，避免污染同进程的后续用例。
 */

import fs from "fs";
import os from "os";
import path from "path";
import * as yaml from "js-yaml";
import { reloadConfig } from "../../src/config/index.js";
import { restoreEnv as restoreEnvValue } from "./test-env.js";

/** 默认测试 provider：chat + responses 各一个，模型名固定，断言不依赖宿主机配置。 */
const DEFAULT_TEST_PROVIDERS = {
    "chat-test": {
        protocol: "chat_completions",
        baseUrl: "https://chat.example.com/v1",
        apiKey: "test-chat-key",
        models: ["chat-model-a", "chat-model-b"],
        efforts: ["low", "high"],
    },
    "responses-test": {
        protocol: "responses",
        baseUrl: "https://responses.example.com/v1",
        apiKey: "test-responses-key",
        models: ["responses-model-a"],
        efforts: ["low", "high", "max"],
        hostedTools: ["web_search"],
    },
} as const;

/** 默认测试配置内容（tokenizer 关真分词、memoryUserId 固定 0）。 */
export function defaultTestConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        providers: DEFAULT_TEST_PROVIDERS,
        defaults: { provider: "chat-test", model: "chat-model-a" },
        runtime: { tokenizer: false, memoryUserId: 0 },
        ...overrides,
    };
}

/** 写一份临时配置并生效；返回 restore 用于恢复。 */
export function useConfig(
    config: Record<string, unknown> = defaultTestConfig(),
): { dir: string; file: string; restore: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-test-config-"));
    const file = path.join(dir, "config.yaml");
    fs.writeFileSync(file, yaml.dump(config), "utf8");

    const previous = process.env.ZBOT_CONFIG_FILE;
    process.env.ZBOT_CONFIG_FILE = file;
    reloadConfig();

    return {
        dir,
        file,
        restore: () => {
            restoreEnvValue("ZBOT_CONFIG_FILE", previous);
            reloadConfig();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}
