# Herdr 集成

zbot TUI 在 [Herdr](https://herdr.dev) pane 内运行时，自动把自身发现为一个 agent，
并上报生命周期状态与展示元数据。全部走官方 CLI（`$HERDR_BIN_PATH`），
仅在 `HERDR_ENV=1` 且 `HERDR_PANE_ID` / `HERDR_BIN_PATH` 齐全时生效，否则完全 no-op。

## 发现与状态

- source 固定为 `custom:zbot`，agent label 为 `zbot`。对应 Herdr 文档
  "Integrate your own agent" 的自定义集成路径，不依赖内置 kind。
- 上报命令：`herdr pane report-agent <pane> --source custom:zbot --agent zbot --state ...`。
- 状态聚合是 **pane 级**：任一已持有会话在跑（含压缩、续跑、群消息驱动的回合）即
  `working`；任一 `ask_user` 在等作答或启动期 provider 配置无效即 `blocked`
  （blocked 优先）；否则 `idle`。
- Herdr 的 `done` 不是上报值：它是 Herdr 对「未被看到的 idle」的展示派生。
- `--seq` 以当前时钟微秒为下界严格递增。Herdr 会丢弃同一 source 上不大于上次值的报告，
  这样进程被强杀后重启也不会被旧 seq 卡住。
- 退出时先清展示元数据，再 `pane release-agent` 交还生命周期权威。

## 展示元数据

`herdr pane report-metadata` 属于展示层，不改变语义状态：

- `title`：当前会话标题；
- `display_agent`：`zbot`；
- token：`model`（当前会话模型）、`session`（会话 id 后 8 位）。

Herdr 的展示字段按 source 整组替换，所以每次上报都带全量 title/display_agent；
token 是逐键 patch，清理由 `--clear-token` 完成。字段内容会去掉控制字符并截断到 80 字符。
不使用 `--ttl-ms`：metadata 常驻到下次替换或退出清理。

## 交互

Herdr 的 `agent prompt`、`agent wait`、`agent send-keys` 都作用在终端表面：
文本 + Enter 进入 zbot 的普通输入路径，`blocked` 状态让 `agent wait --until blocked` 可用。
zbot 不是 Herdr 内置 kind，因此以下能力**不**提供：

- `herdr agent start --kind zbot`（用 `pane split` + shell 启动 `zbot` 即可）；
- `herdr integration install zbot`；
- 基于官方集成的 session 自动恢复。

## 兼容边界（待 Herdr 侧支持）

- **session id/path 不上报**：Herdr 0.9.5 只持久化官方 source（`herdr:*`）的
  `agent_session`，`custom:*` 的 `--agent-session-id/--agent-session-path` 会被忽略，
  也不会参与恢复。zbot 不伪造官方 source，只用 metadata token 暴露会话信息。
  已用 `herdr pane report-agent-session` + `herdr pane get` 实测确认。
- **结构化 transcript 未实现**：Herdr 的公开契约里没有「自定义 agent transcript 文件格式」；
  Alma 侧也没有公开稳定的 transcript 导入协议（只观察到其按 Herdr `agent_session`
  读取 claude/codex/pi 的会话文件）。zbot 自有 JSONL 事件日志不是这两者认可的格式，
  在格式有公开契约前不臆造。
- **仅 TUI 上报**：`zbot serve` 是后台宿主，不占用交互 pane，也不上报状态；无 UI 的 `-p`
  运行已禁用，避免绕过 TUI 或后台宿主直接执行模型回合。

## 验证

在 Herdr pane 内运行 zbot 后：

```sh
herdr pane get "$HERDR_PANE_ID"     # 看 title / display_agent / tokens / agent_status
herdr agent get zbot                # 看 agent 状态
herdr agent wait zbot --until blocked --timeout 1000
```

单测（两个文件都 mock 了进程级模块，按测试约定分开跑）：

```sh
bun test tests/unit/herdr-reporter.test.ts
bun test tests/unit/tui-app-question.test.ts
```
