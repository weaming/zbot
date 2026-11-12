/** 测试环境隔离：在模块加载前剔除宿主环境变量，保证断言不受外部配置影响。 */

import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach } from "bun:test";
import { reloadConfig } from "../../src/config/index.js";
import { defaultTestConfig, useConfig } from "./test-config.js";

// 旧 env 配置一律失效：测试只认 config.yaml
for (const key of [
    "OPENAI_MODEL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_CHAT_MODEL",
    "OPENAI_CHAT_MODELS",
    "OPENAI_CHAT_API_KEY",
    "OPENAI_CHAT_BASE_URL",
    "OPENAI_CHAT_EFFORTS",
    "OPENAI_RESPONSES_MODEL",
    "OPENAI_RESPONSES_MODELS",
    "OPENAI_RESPONSES_API_KEY",
    "OPENAI_RESPONSES_BASE_URL",
    "OPENAI_RESPONSES_EFFORTS",
    "OPENAI_RESPONSES_HOSTED_TOOLS",
    "OPENAI_RESPONSES_WEBSOCKET",
    "OPENAI_RESPONSES_STORE",
    "REASONING_EFFORT",
    "OPENAI_REASONING_EFFORT",
    "DEEPSEEK_REASONING_EFFORT",
    "CONTEXT_WINDOW_TOKENS",
    "AUTOCOMPACT_PCT",
    "ZBOT_IDENTITY_FILE",
    "ZBOT_EXTRA_IDENTITY_FILE",
    "ZBOT_TOKENIZER",
    "ZBOT_MEMORY_USER_ID",
    "ZBOT_ARCHIVE_RETENTION_DAYS",
    "ZBOT_LLM_LOG_DELTAS",
    "ZBOT_MCP_SERVERS_FILE",
    "ZBOT_WEB_TOKEN",
    "ZBOT_JOBS_MAX_CONCURRENT",
    "ZBOT_DISABLE_NOTIFICATIONS",
    "ZBOT_TUI_DEBUG_WHEEL",
    "DEEPSEEK_FILES_API",
    "TOOL_AUDIO_INPUT",
    "NETWORK_PROXY",
    "OPENAI_PROXY",
    "ZBOT_ENV_FILE",
]) {
    delete process.env[key];
}

// shell 工具会给子进程注入「所属会话」；测试若继承它，CLI 用例的「当前会话」会指到外面那个会话。
delete process.env.ZBOT_SESSION_ID;

// 宿主机可能本身跑在 herdr pane 里；测试若继承 HERDR_ENV，ChatApp 会真的向那个 pane
// 上报状态/元数据，把用户的 agent 状态改掉。测试进程一律视为不在 herdr 内。
delete process.env.HERDR_ENV;
delete process.env.HERDR_BIN_PATH;
delete process.env.HERDR_PANE_ID;

// 兜底配置：任何用例都不该读到宿主机 ~/.zbot/config.yaml。
// 单测默认关掉真实分词器（runtime.tokenizer: false），真实分词的精度与回退由
// tests/unit/tokenizer.test.ts 单独覆盖。
process.env.ZBOT_CONFIG_FILE = useConfig(defaultTestConfig()).file;
reloadConfig();

// 宿主 shell 常导出 ZBOT_STATE_DIR（如 ~/.zbot），直接用会写到真实状态目录；
// 也不能简单 delete——logger 的 exchange 路径在无变量时会回退 ~/.zbot。
// 统一指向临时目录，让 getSessionsDir 与 logger 落在同一棵隔离树里。
const testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-test-state-"));
process.env.ZBOT_STATE_DIR = testStateDir;

// 兜底：若某测试文件把隔离变量删掉（afterEach 未还原 preload 值），同进程后续用例
// 就会回退到真实 ~/.zbot；每个用例前仅在缺失时补回，不覆盖用例自设的临时目录。
beforeEach(() => {
    if (process.env.ZBOT_STATE_DIR === undefined) process.env.ZBOT_STATE_DIR = testStateDir;
    if (process.env.ZBOT_CONFIG_FILE === undefined) {
        process.env.ZBOT_CONFIG_FILE = useConfig(defaultTestConfig()).file;
    }
    reloadConfig();
    if (process.env.ZBOT_SESSION_ID !== undefined) delete process.env.ZBOT_SESSION_ID;
});

process.on("exit", () => {
    try {
        fs.rmSync(testStateDir, { recursive: true, force: true });
    } catch {
        // 清理失败不影响测试结果
    }
});
