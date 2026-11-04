# 配置

## 环境变量

首次运行前，在 `~/.zbot/env` 配置模型服务：

```dotenv
# Shared fallback settings
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=your-model-name

# Independent Responses API profile
# DeepSeek 示例；也可使用 OpenAI 或兼容服务的配置
OPENAI_RESPONSES_API_KEY=your-api-key
OPENAI_RESPONSES_BASE_URL=https://api.deepseek.com
OPENAI_RESPONSES_MODEL=deepseek-flash
OPENAI_RESPONSES_MODELS=
OPENAI_RESPONSES_EFFORTS=

# Independent Chat Completions profile
OPENAI_CHAT_API_KEY=your-api-key
OPENAI_CHAT_BASE_URL=https://api.deepseek.com
OPENAI_CHAT_MODEL=deepseek-flash
OPENAI_CHAT_MODELS=
OPENAI_CHAT_EFFORTS=
```

云端服务需要填写 `OPENAI_API_KEY`。如果 `OPENAI_BASE_URL` 指向本机或局域网地址，可以留空或省略密钥。

旧的共享 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL` 配置始终按 Chat Completions 使用。Responses API 请配置 `OPENAI_RESPONSES_*`；Chat Completions 可使用 `OPENAI_CHAT_*`。独立协议配置中的 API Key 和 Base URL 未填写时会回退到共享的 `OPENAI_*` 值。`*_MODEL` 设置默认模型，`*_MODELS` 可用逗号配置多个可切换模型；默认模型也会出现在候选列表中。上例展示 DeepSeek 配置；若两种协议共用密钥，也可只填写共享的 `OPENAI_API_KEY`。

只配置一套专属协议时会自动使用该配置；两套都配置且未设置全局默认时，初始使用 Chat Completions。通过 TUI 的 `/model` 可以选择协议和模型，并设置全局默认。DeepSeek 支持两种协议，两者 Base URL 均为 `https://api.deepseek.com`（不带 `/v1`）；兼容服务需实现所选协议。

TUI 中只需输入 `/model`，再依次选择协议、模型，以及是否设为默认（默认选“否”）。当前选择会保存到该会话，重新打开会话时自动恢复；选择“是”会同时更新默认模型，供没有单独设置模型的会话使用。只有一个可选组合时，命令会提示配置多个协议或模型。默认模型保存在 TUI 状态目录的 `model-preferences.json`。

### 思考强度

在 TUI 中输入 `/model effort` 查看当前值，或输入 `/model effort <值>` 设置当前会话的思考强度（`/model` 是模型与强度的唯一入口）。设置会随会话保存；`auto` 表示本次请求不发送思考强度参数，使用服务端默认值，并优先于全局 effort 环境变量。未设置会话值时，环境变量按 `REASONING_EFFORT`、`OPENAI_REASONING_EFFORT`、`DEEPSEEK_REASONING_EFFORT` 的顺序读取。

`/model effort` 按当前协议和厂家提供上游实际接收的值，选中的值会原样用于对应请求字段。未配置或留空时使用按协议和厂家区分的内置列表；列表不会逐个查询模型元数据，同一厂家内不同模型仍可能支持不同值。配置 `*_EFFORTS` 后，`/model effort` 只允许配置中的值，发送前会校验并按原值发送。请确保这些值被所选模型支持。`auto` 始终可选，表示省略思考强度参数；不要把它写入 `*_EFFORTS`。

```dotenv
OPENAI_CHAT_EFFORTS=low,high,max
OPENAI_RESPONSES_EFFORTS=low,high,max
```

各协议字段和厂家支持的值不同，具体还受所选模型限制：

| 协议 | 厂家 / 模型 | 请求字段 | 厂家支持的值 | zbot 处理 |
| --- | --- | --- | --- | --- |
| Responses | OpenAI | `reasoning.effort` | `none`、`minimal`、`low`、`medium`、`high`、`xhigh`；具体模型支持范围不同 | 直接发送选择值 |
| Responses | Codex Responses 服务（当前 3060 endpoint） | `reasoning.effort` | `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`（按该服务返回的错误提示） | 直接发送选择值 |
| Responses | DeepSeek | `reasoning.effort` | 原生值：`none`、`low`、`high`、`max` | 直接发送选择值 |
| Chat Completions | OpenAI 及兼容服务 | `reasoning_effort` | OpenAI 模型支持 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`；具体模型支持范围不同 | 直接发送选择值 |
| Chat Completions | DeepSeek | `reasoning_effort` 和 `thinking.type` | `reasoning_effort` 原生值：`none`、`low`、`high`、`max`；`thinking.type` 为 `enabled` 或 `disabled` | `none` 原样发送以关闭思考；其他值通过 `reasoning_effort` 原样发送并设置 `thinking.type=enabled` |

`auto` 不发送强度设置，由服务端使用默认值。DeepSeek 也为兼容旧客户端接受 `minimal`、`medium`、`xhigh`、`ultra` 等别名并在服务端映射；内置候选只展示原生值。字段格式和兼容行为见其 [思考模式文档](https://api-docs.deepseek.com/guides/thinking_mode/) 与 [Responses API 文档](https://api-docs.deepseek.com/api/create-response/)。OpenAI 的值也会因模型而异，详见 [Responses API](https://platform.openai.com/docs/api-reference/responses/create) 和 [Chat Completions](https://platform.openai.com/docs/api-reference/chat/create) 文档。兼容服务可能采用不同的字段或支持范围。

可从仓库根目录的 `env.example` 复制模板。也可以通过 `ZBOT_ENV_FILE` 指定其他文件路径。不要把真实密钥提交到仓库。

可选项：

| 变量 | 用途 |
| --- | --- |
| `OPENAI_CHAT_EFFORTS` | Chat Completions 可选思考强度，逗号分隔 |
| `OPENAI_RESPONSES_EFFORTS` | Responses API 可选思考强度，逗号分隔 |
| `OPENAI_RESPONSES_WEBSOCKET` | `true` 或 `1` 启用 WebSocket，`false` 或 `0` 使用 HTTP；未设置时 GPT 模型默认启用，其他模型默认使用 HTTP。生成中追加的文本会尝试通过 steering 交给当前响应 |
| `OPENAI_RESPONSES_STORE` | `true` 或 `1` 请求上游保存 Responses，`false` 或 `0` 禁用；未设置时所有模型默认关闭。Codex Responses 代理要求 `store=false` |
| `OPENAI_RESPONSES_HOSTED_TOOLS` | Responses 可选托管工具（如 `web_search,tool_search`），上游执行；Chat Completions 无托管工具 |
| `APPLY_PATCH_MODE` | `apply_patch`（MCP codex 等）的下发形态：`custom` 自由文本（模型直接输出补丁原文）、`off` 原样下发（`function` 为历史值，等价 `off`）。默认 `gpt-*` 用 `custom`，其余（含 DeepSeek）原样 |
| `ZBOT_MEMORY_USER_ID` | 记忆用户标识，默认 `0` |
| `ZBOT_LLM_LOG_DELTAS` | `true` 或 `1` 时把流式增量事件（`*.delta`）也写入协议日志；默认丢弃，只保留终态与控制事件 |
| `NETWORK_PROXY` | 网络和命令行工具使用的代理；TUI 会将容器默认代理地址调整为 `http://localhost:7890` |
| `OPENAI_PROXY` | 模型 API 请求使用的代理 |

启用 Responses 存储后，HTTP 与 WebSocket 都会在请求选项和上下文前缀一致时使用 `previous_response_id` 增量续接；旧响应不可用时会重发完整上下文。每个会话的续接基准保存在状态目录 `sessions/responses/`，文件权限为 0600，最大 2 MB，超过 29 天不再使用；清空或删除会话时同时删除。WS 回合经过 steering 后，下一次请求使用完整上下文建立新基准。GPT 的存储请求包含 `reasoning.encrypted_content`，以便回退时重放思考项。

`store=false` 时，WS 在当前连接的缓存有效期间仍可用 `previous_response_id` 增量续接；重连后会重新发送完整上下文。显式设置 `OPENAI_RESPONSES_STORE=true` 时，上游若不支持存储会直接报错。

会话的协议日志位于 `sessions/http/<会话 ID>.jsonl`：HTTP 记录实际请求、响应或 SSE 事件，WS 记录请求、收到的消息及错误。同一次请求只记一份：请求统一按请求链记录（`requestId`/`parentRequestId` 与输入增量），其余字段与真实网络请求一致；使用 `previous_response_id` 时保留实际发送的增量 `input`，未变化的工具定义只写 `toolsHash`。响应里回显的 `tools` 与请求一致时只写 `toolsRef`（指向写入该份工具定义的请求 `requestId`），不再逐条重复；工具定义变化时仍保留全量。流式增量事件（`response.output_text.delta` 等 `*.delta`）默认不落盘，只保留 `*.done`、`response.completed` 等终态与错误事件；需要逐帧复刻时设 `ZBOT_LLM_LOG_DELTAS=1`。WS 的控制消息（steer/interrupt）原样记录为 `WS_SEND`。

TUI 的 MCP 服务列表由 `~/.zbot/mcp-servers.yaml` 管理。详见 [MCP 服务配置](mcp.md)。

## 配置和数据目录

默认情况下，zbot 将环境文件、MCP 配置、会话、日志和 OAuth 凭据保存在 `~/.zbot/`。MCP OAuth 凭据保存在 `~/.zbot/mcp-auth/`，应按敏感信息保护。

可用 `ZBOT_MCP_SERVERS_FILE` 指定 MCP 配置文件。可用 `ZBOT_ENV_FILE` 指定环境文件。

## 构建独立命令

安装 Bun 和项目依赖后，在仓库根目录运行：

```fish
bun install
make build-cli
```

命令会构建可执行文件 `zbot`，默认写入 `~/.bun/bin/zbot`。图片缩放在 macOS 使用系统自带的 `sips`；其他平台使用 ImageMagick 的 `magick` 命令。确保 `~/.bun/bin` 在 `PATH` 中即可直接运行 `zbot`。可通过 `ZBOT_TUI_BIN` 覆盖输出路径：

```fish
set -x ZBOT_TUI_BIN "$HOME/.local/bin/zbot"
make build-cli
```
