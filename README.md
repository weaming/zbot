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

从未发过消息的空会话会在打开其他会话、退出或 `/close` 时自动删除（有草稿或会话间消息则保留）。

各子命令都支持 `-h` / `--help`（如 `zbot session --help`）。

会话也可以在命令行里增删查改（供其他 AI 或脚本调用）：

```sh
~/.bun/bin/zbot session list            # 当前会话置顶提示，-n 20 只看最近 20 条
~/.bun/bin/zbot session show            # 不带 id = 当前会话；--last 取最近更新的
~/.bun/bin/zbot session send <id> "跑一下测试" --wait          # 一直等到回合终态
~/.bun/bin/zbot session wait <id> --msg=<msgId>                # 中断/断线后继续等结果
~/.bun/bin/zbot herdr spawn "只读复审这次改动" --title 复审 --cwd ~/src/app  # herdr 内：新标签页 + 新会话
~/.bun/bin/zbot herdr teardown <id> --tab=<tabId>              # 收尾：归档 + 关掉那个标签页
```

CLI 只负责把消息投递给运行中的 TUI，不会在本地无 UI 启动模型回合。
没有持有者时，请打开 TUI（或在 herdr 里 `zbot herdr spawn` 开一个）。

文档：[会话命令行](docs/session-cli.md)、[MCP 多服务配置](docs/mcp.md)、[TUI 链接与终端交互](docs/tui-links.md)、[Herdr 集成](docs/herdr.md)。
