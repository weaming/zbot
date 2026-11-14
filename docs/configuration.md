# 配置

## 配置文件

配置文件是 `~/.zbot/config.yaml`（`ZBOT_CONFIG_FILE` 可指向别的文件）。可从仓库根目录的 `config.example.yaml` 复制模板。它取代了旧版 `~/.zbot/env`：所有用户可编辑的配置都在这里，程序不再读取 `OPENAI_*` 之类的环境变量。

```yaml
providers:
  deepseek:
    protocol: responses          # responses | chat_completions
    baseUrl: https://api.deepseek.com
    apiKey: $DEEPSEEK_API_KEY    # 也可直接写明文
    models: [deepseek-flash, deepseek-v4-pro]
    efforts: [low, high, max]
    hostedTools: [web_search]    # Responses 专用
    # websocket: true           # 显式开启 Responses WebSocket（默认 HTTP）
    store: false

  local:
    protocol: chat_completions
    baseUrl: http://127.0.0.1:3030/v1
    models: []

defaults:
  provider: deepseek
  model: deepseek-flash
  reasoningEffort: auto

runtime:
  reservedOutputTokens: 8192
  archiveRetentionDays: 14

network:
  proxy: http://localhost:7890

mcp:
  serversFile: ~/.zbot/mcp-servers.yaml

tui:
  disableNotifications: false
```

**一个 provider 固定一个协议**，名字就是键名。`baseUrl` 必填；`apiKey` 与 `models` 可省略（本地/局域网服务由服务端决定模型）。`apiKey` 支持 `$NAME` / `${NAME}` 引用进程环境变量（可链式），真值不落盘；引用落空时报错会指出断在哪一环。

`providers` 为空或文件缺失时，启动直接报错并提示位置，不会退回旧的环境变量。

### 模型选择

`/model` 是模型与思考强度的唯一入口：

- `/model`：TUI 浮层，依次选择 provider → 模型（末项「自定义模型」可手输）→ 思考强度 → 是否设为默认。
- `/model <provider> <模型> [强度|auto]`：命令行等价写法；手输配置里没有的模型即**临时模型**，只对当前会话生效、不能设为默认。
- `/model effort [档位|auto]`：查看或设置思考强度。

会话选择随会话保存；设为默认后写入状态目录的 `model-preferences.json`，供没有单独设置模型的会话使用。旧版只记 `protocol`+`model` 的偏好文件会自动映射到协议相同的 provider。

### 思考强度

`/model effort <值>` 设置当前会话的思考强度；`auto` 表示本次请求不发送思考强度参数，使用服务端默认值。会话没设时依次取进程内覆盖（无会话时的 `/model effort`）与配置里的 `defaults.reasoningEffort`，都没有就是 `auto`。

`/model effort` 按当前协议和厂家提供上游实际接收的值，选中的值会原样用于对应请求字段。provider 没配 `efforts` 时使用按协议和厂家区分的内置列表；列表不会逐个查询模型元数据，同一厂家内不同模型仍可能支持不同值。配了 `efforts` 后，`/model effort` 只允许其中的值，发送前会校验并按原值发送。请确保这些值被所选模型支持。`auto` 始终可选，表示省略思考强度参数；不要把它写入 `efforts`。

```yaml
providers:
  deepseek:
    efforts: [low, high, max]
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

其余配置键（都在 `config.yaml` 里）：

| 键 | 用途 |
| --- | --- |
| `providers.<name>.websocket` | Responses 是否走 WebSocket；默认走 HTTP，显式 `true` 才启用。WS 模式下生成中追加的文本会尝试通过 steering 交给当前响应 |
| `providers.<name>.store` | Responses 是否请求上游保存，默认 `false`。Codex Responses 代理要求 `store=false` |
| `providers.<name>.hostedTools` | Responses 托管工具（如 `web_search`、`tool_search`），上游执行；第三方网关按显式声明下发，不因模型名含 `deepseek` 而过滤。官方 DeepSeek 仍按能力白名单过滤；Chat Completions 没有托管工具 |
| `providers.<name>.efforts` | 可选思考强度清单，取代旧 `*_EFFORTS` |
| `providers.<name>.audioInput` | Chat Completions 是否允许下发 `input_audio`；官方 DeepSeek 保持禁用，其他端点优先尊重显式配置。省略时 DeepSeek 风格默认关闭，其余按音频模型名启发式 |
| `providers.<name>.imageInput` | 该服务是否接受图片内容块；省略时视为接受。显式 `false` 时整台接入端都不发图片 |
| `providers.<name>.textOnlyModels` | 纯文本模型名关键词（小写子串匹配）；命中的模型在发请求前把图片块换成文字说明，避免整轮 404。同一张卡上的其他模型不受影响 |
| `providers.<name>.contextWindowTokens` | 该服务的上下文窗口，压过内置模型表 |
| `runtime.contextWindowTokens` | 全局上下文窗口，压过内置模型表 |
| `runtime.reservedOutputTokens` / `autocompactBufferTokens` / `retainTailTokens` / `autocompactRatio` | 压缩与尾部保留预算 |
| `runtime.toolResultSummary` | 工具结果头尾截取阈值（`thresholdTokens` / `headTokens` / `tailTokens`） |
| `runtime.tokenizer` | 是否用真分词（`false` 回退估算，诊断用） |
| `runtime.memoryUserId` | 记忆用户标识，默认 `0` |
| `runtime.identityFile` / `runtime.extraIdentityFile` | 身份文件覆盖与额外身份文件 |
| `runtime.archiveRetentionDays` | 归档会话保留天数，`<= 0` 表示不清理 |
| `runtime.llmLogDeltas` | 协议日志里保留流式增量事件（体积大，排障时开） |
| `runtime.deepseekCostStat` | 非官方端点（局域网网关）也按 DeepSeek 官方价格表估算费用；模型名需同时含 `deepseek` 与 `flash`/`pro`（否则不计） |
| `runtime.applyPatchMode` | `apply_patch` 下发形态：`custom` 自由文本 / `off` 原样下发；省略按模型名启发式（`gpt-*` 用 `custom`） |
| `network.proxy` | 命令行工具与网络请求使用的代理 |
| `network.openaiProxy` | 模型 API 请求使用的代理 |
| `mcp.serversFile` | MCP 服务配置文件，默认 `~/.zbot/mcp-servers.yaml` |
| `tui.disableNotifications` | 关闭终端通知 |
| `tui.debugWheel` | 滚轮诊断日志 |

图片上传策略不提供配置：仅 HTTPS 官方端点 `api.deepseek.com` 使用 Files API，文件保留 30 天；Responses 以 `input_image.file_id` 引用，Chat Completions 以 `file.file_id` 引用。其他端点使用 base64 data URL，分别投影为 Responses 的 `input_image` 或 Chat Completions 的 `image_url`，不会因为模型名含 `deepseek` 就调用官方上传接口。

启用 Responses 存储后，HTTP 与 WebSocket 都会在请求选项和上下文前缀一致时使用 `previous_response_id` 增量续接；旧响应不可用时会重发完整上下文。每个会话的续接基准保存在状态目录 `sessions/responses/`，文件权限为 0600，最大 2 MB，超过 29 天不再使用；清空或删除会话时同时删除。WS 回合经过 steering 后，下一次请求使用完整上下文建立新基准。GPT 的存储请求包含 `reasoning.encrypted_content`，以便回退时重放思考项。

`store=false` 时，WS 在当前连接的缓存有效期间仍可用 `previous_response_id` 增量续接；重连后会重新发送完整上下文。provider 显式设 `store: true` 时，上游若不支持存储会直接报错。

WS 模式的取消依赖 `response.interrupt`：上游对带托管工具（如 `web_search`）的响应可能回 `interrupt_not_supported`，此时 zbot 按「已取消」结束本轮并断开连接，不再把整轮报成请求失败。这也是默认走 HTTP 的原因；需要 steering 与连接复用时再为 provider 打开 `websocket: true`。

会话的协议日志位于 `sessions/http/<会话 ID>.jsonl`：HTTP 记录实际请求、响应或 SSE 事件，WS 记录请求、收到的消息及错误。同一次请求只记一份：请求统一按请求链记录（`requestId`/`parentRequestId` 与输入增量），其余字段与真实网络请求一致；使用 `previous_response_id` 时保留实际发送的增量 `input`，未变化的工具定义只写 `toolsHash`。响应里回显的 `tools` 与请求一致时只写 `toolsRef`（指向写入该份工具定义的请求 `requestId`），不再逐条重复；工具定义变化时仍保留全量。流式增量事件（`response.output_text.delta` 等 `*.delta`）默认不落盘，只保留 `*.done`、`response.completed` 等终态与错误事件；需要逐帧复刻时打开 `runtime.llmLogDeltas`。WS 的控制消息（steer/interrupt）原样记录为 `WS_SEND`。

TUI 的 MCP 服务列表由 `~/.zbot/mcp-servers.yaml` 管理。详见 [MCP 服务配置](mcp.md)。

## 配置和数据目录

默认情况下，zbot 将配置文件、MCP 配置、会话、日志和 OAuth 凭据保存在 `~/.zbot/`。MCP OAuth 凭据保存在 `~/.zbot/mcp-auth/`，应按敏感信息保护。

`ZBOT_CONFIG_FILE` 可指向另一份配置（多实例/测试用），`ZBOT_STATE_DIR` 可改状态目录，`mcp.serversFile` 可指定 MCP 配置文件。其余运行时变量（`ZBOT_SESSION_ID`、`HERDR_*` 等）由程序注入，不是用户配置。

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
