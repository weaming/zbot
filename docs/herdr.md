# Herdr 集成

zbot TUI 在 [Herdr](https://herdr.dev) pane 内运行时，自动把自身发现为一个 agent，
并上报生命周期状态与展示元数据。全部走官方 CLI（`$HERDR_BIN_PATH`），
仅在 `HERDR_ENV=1` 且 `HERDR_PANE_ID` / `HERDR_BIN_PATH` 齐全时生效，否则完全 no-op。

## 一条命令开新标签页 + 新会话

```sh
zbot herdr spawn "只读复审这次改动" --title "复审" --cwd ~/src/neta-app --json
```

等价于手工的四步：新建标签页 → 新建会话 → 在标签页里 `zbot resume <id>` → `zbot session send`。
只能在 herdr 内运行（`HERDR_ENV=1`），否则报 `herdr_unavailable`。

- `--title` 与 `--cwd` **必填**：标题同时是新标签页的默认标签（要分开写就用 `--label`），
  目录决定标签页与会话的 cwd（相对路径按调用方 cwd 解析）。不给就报 `usage`，不猜。
- 位置参数是首条用户输入；不给就只建标签页与会话。
- `ZBOT_STATE_DIR` / `ZBOT_ENV_FILE` 会通过 `herdr tab create --env` 转发给新 pane：
  新 pane 继承的是 herdr server 的环境，不转发会读到另一个状态目录。
- 默认 `--no-focus`：不抢调用方焦点；要切过去加 `--focus`。
- 等新 TUI 认领会话（`--ready-timeout=秒`，默认 30）后才投递首条输入，**投递成功即返回**，不等回合结果。
- `--json` 输出：`sessionId` / `title` / `cwd` / `delivered` / `msgId` / `commands` / `hints`，
  `herdr` 元数据（`workspaceId`/`tabId`/`paneId`、`tab` 与 `pane` 的 `herdr tab get`/`pane get` 快照、`caller` 调用方 pane），
  以及 `commands` 后续动作（调用方不用自己拼；没投递首条输入时没有 `wait`）：

| 字段 | 命令 | 用途 |
| --- | --- | --- |
| `commands.wait` | `zbot session wait <id> --msg=<msgId>` | 等这一轮结果；中断/断线后同一条续等，不重发 |
| `commands.send` | `zbot session send <id> "<文本>"` | 继续发消息（TUI 空闲即执行，忙则排队） |
| `commands.show` | `zbot session show <id>` | 看进度/复盘 |
| `commands.archive` | `zbot session send <id> "/archive"` | 归档**并**释放持有；会话被持有时 `session archive` 会被 held 拒绝，所以走持有者 |
| `commands.close` | `zbot session send <id> "/close"` | 只释放持有、不归档（数据保留；从未用过的空会话会被删） |
| `commands.closeTab` | `herdr tab close <tabId>` | 只关这个标签页（pane 里的 TUI 随之退出） |
| `commands.teardown` | `zbot herdr teardown <id> --tab=<tabId>` | 收尾一把梭：归档 + 关标签页（见下一节） |
| `commands.sendAndWait` | `zbot session send <id> "<文本>" --wait` | 后续消息「发完即等」，一条命令拿到结果 |

`hints` 把「等结果」分两档说清楚：`hints.current` 只等首条输入这一轮（没投递就没有该字段），
`hints.later` 是你后续自己发消息时怎么等（`commands.sendAndWait` 一条即得；要在中断/断线后按轮续等，
就先 `send --json` 拿 msgId 再 `wait --msg=`）。`hints.observe` 里 `zbot session show <id> --json --lite`
任何环境都成立；在 herdr 里**还可以**用 `herdr pane read <paneId> --lines 40` / `herdr pane get <paneId>`
看终端与 pane 状态。

`archive` 与 `close` 二选一：两者都会释放持有，先 archive 再 close 只会得到 `no_holder`。
释放之后才关标签页；直接关标签页等于给 pane 里的 TUI 发挂断信号，也会释放会话。

## 收尾：zbot herdr teardown

```sh
zbot herdr teardown <id> --tab=<tabId>      # 等价 commands.teardown
zbot herdr teardown <id> --json             # 不给 --tab 时按 pane 元数据自动匹配
```

归档会话 + 关掉它的标签页，**投递成功就返回**，不等归档落盘、不等进程退出：

- 会话被 TUI 持有且空闲 → 投 `/archive`（持有者归档并自行释放），随后关标签页；
  probe 之后持有者刚好退出（`no_holder`）时退回自己落盘归档，不会整条失败；
- 会话没有持有者 → CLI 自己写 `session_archived`，再关标签页；
- 会话正在执行回合 → 拒绝（`busy`）：先 `commands.wait` 等这一轮结束，别把跑着的工作拔掉；
- 标签页定位：`--tab` → `--pane` → 按 pane 元数据的 `tokens.session`（会话 id 后 8 位）或会话标题在本 workspace 内匹配；
  匹配不到就只归档，结果里给 `note` 提示用 `--tab` 指定。

- 投递后会读一次归档态（≤0.5s 确认窗口），确认到就真的关标签页，确认不到按「持有者异步处理」如实回报；
- 关标签页失败（已被手动关、herdr 偶发报错）不影响归档成果，只在 `herdr.note` 里说明。

结果字段：`delivered`（是否投递给持有者）/ `archived`（`true` = 已确认归档，`null` = 已投递但未确认）/
`herdr{tabId,paneId,tabClosed,note?}` / `commands.show` / `hint`。
标签页匹配用 `--workspace`（缺省 `$HERDR_WORKSPACE_ID`），跨 workspace 的同名 tab 不会被误关。

失败面：`herdr_unavailable`（不在 herdr 里）、`herdr_failed`（标签页/pane 创建失败，错误里带
`resumeCommand` / `teardownCommand` / `closeTabCommand`）、`not_ready`（超时没人认领，或认领后 TUI 又退出，带 tab/pane 与重投、收尾命令）；
首条输入投递失败还会原样透出 `busy` / `queue_full` / `bad_reply` / `connect` 等 code，并附同样的接手与
`teardownCommand` 字段；`busy` 在 teardown 上表示撞上执行中的回合。

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
- **仅 TUI 上报**：只有 TUI 占用 pane 并上报状态；独立的长驻宿主不占交互 pane、也不上报。
  无 UI 的 `-p` 运行已禁用，避免绕过持有者直接执行模型回合。

## 验证

在 Herdr pane 内运行 zbot 后：

```sh
herdr pane get "$HERDR_PANE_ID"     # 看 title / display_agent / tokens / agent_status
herdr agent get zbot                # 看 agent 状态
herdr agent wait zbot --until blocked --timeout 1000
```

单测（两个文件都 mock 了进程级模块，按测试约定分开跑）：

```sh
bun test src/cli/herdr                    # spawn / teardown 的解析与失败面
bun test tests/unit/herdr-reporter.test.ts
bun test tests/unit/tui-app-question.test.ts
```
