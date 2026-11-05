# zbot

zbot 是一个基于 Bun 的终端 AI 助手，提供 TUI 界面。

## 安装

需要先安装 [Bun](https://bun.sh/)：

```sh
git clone https://github.com/weaming/zbot.git
cd zbot
bun install
make build-pack
```

产物是单个可执行文件，运行时借用系统 bun。

| 目标 | 产物 | 说明 |
| --- | --- | --- |
| `make build-pack` | 5.4 MB | 需要目标机有 bun |
| `make build-cli` | 66 MB | 内嵌 bun 运行时，无需安装 |

## 配置

```sh
mkdir -p ~/.zbot
cp env.example ~/.zbot/env
vi ~/.zbot/env
```

填写 `OPENAI_MODEL`。旧的 `OPENAI_*` 配置按 Chat Completions 使用；云端服务填写 `OPENAI_API_KEY`，本地或局域网服务可省略密钥。兼容接口可按需调整 `OPENAI_BASE_URL`。

Responses API 和 Chat Completions 可使用各自的 `OPENAI_RESPONSES_*` 与 `OPENAI_CHAT_*` 配置。DeepSeek 两种协议的 Base URL 都是 `https://api.deepseek.com`。配置多个协议或模型后，在 TUI 输入 `/model` 可为当前会话选择模型。

## 使用

```sh
~/.bun/bin/zbot            # 每次启动都新建一个空会话；旧会话用 resume 或会话面板打开
~/.bun/bin/zbot resume <id>
```

从未发过消息的空会话会在退出或 `/close` 时自动删除（有草稿或会话间消息则保留）。

各子命令都支持 `-h` / `--help`（如 `zbot serve --help`）。

会话也可以在命令行里增删查改（供其他 AI 或脚本调用）：

```sh
~/.bun/bin/zbot session list            # 当前会话置顶提示，-n 20 只看最近 20 条
~/.bun/bin/zbot session show            # 不带 id = 当前会话；--last 取最近更新的
~/.bun/bin/zbot session send <id> "跑一下测试" --wait          # 一直等到回合终态
~/.bun/bin/zbot session wait <id> --msg=<msgId>                # 中断/断线后继续等结果
~/.bun/bin/zbot resume <id> -p --json "继续"
```

也可以常驻成无 UI 宿主，用 HTTP 发布任务、SSE 订阅进度：

```sh
~/.bun/bin/zbot serve --port 8787 --cwd ~/src/project
```

```sh
TOKEN=$(cat ~/.zbot/serve/token)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"title":"跑测试"}' http://127.0.0.1:8787/api/sessions
curl -sN -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8787/api/sessions/<id>/events?since=0"
```

发布任务并排队执行（服务端负责并发、串行、超时与重试），带一个最小 Web 界面：

```sh
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"prompt":"修一下 lint 报错","workspace":"'"$HOME"'/src/zbot"}' http://127.0.0.1:8787/api/jobs
open http://127.0.0.1:8787/
```

界面首次打开会要求输入令牌（读自 `~/.zbot/serve/token`），之后记在浏览器 localStorage；
首次打开 `http://127.0.0.1:8787/` 时在页面上粘贴令牌即可（存在本机 localStorage，之后自动带上）。

文档：[会话命令行](docs/session-cli.md)、[serve 接口](docs/serve-api.md)、[MCP 多服务配置](docs/mcp.md)、[TUI 链接与终端交互](docs/tui-links.md)、[Herdr 集成](docs/herdr.md)。
