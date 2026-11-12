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
cp config.example.yaml ~/.zbot/config.yaml
vi ~/.zbot/config.yaml
```

在 `providers` 里配置模型服务（一个 provider 固定一个协议：`responses` 或 `chat_completions`），`apiKey` 可写 `$ENV_NAME` 引用进程环境里的密钥。云端服务需要密钥，本地或局域网服务可省略；兼容接口按需改 `baseUrl`。

`defaults` 决定默认 provider 与模型；配置多个 provider/模型后，在 TUI 输入 `/model` 可为当前会话切换，并可手输配置里没有的临时模型。完整键表见 [配置文档](docs/configuration.md)。

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
