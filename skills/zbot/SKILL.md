---
name: zbot
description: "用 CLI/HTTP 驱动 zbot 实例：在 herdr 里开新标签页与新会话、查会话、投递消息并等结果、远程执行 slash 命令。当需要让另一个 AI 实例干活（多实例协作）、从脚本给运行中的 zbot 发消息、或无人值守跑长任务时使用。关键词：zbot、herdr spawn、新标签页、session send、session wait、会话投递、多实例、后台任务。"
---

# zbot 操作手册

`zbot`（默认 `~/.bun/bin/zbot`）是终端 AI 助手。**它有两个执行宿主，CLI 只是客户端**：

    TUI（人开的窗口）         ── 持有会话、跑模型回合
    zbot session              ── 只投递、只读取，自己不跑模型

任何「让 zbot 干活」的动作都拆成两步：**找到被持有的会话 → 投递并等结果**（写操作必须有 TUI 持有）。

## 硬边界：CLI 不会自己跑模型

    zbot -p "…"                 → tui_or_backend_required
    zbot session run "…"        → tui_or_backend_required
    zbot session send <id> "…"  → no_holder（目标会话没有进程持有）

遇到 `no_holder` 只有一个选择：`zbot resume <id>` 或用 `zbot herdr spawn` 开一个 TUI 认领它。
不要试图自己 spawn 一次性宿主，这条路被实现禁掉了。

## 找会话

    zbot session list                  # 未归档，最近更新在前
    zbot session list --held           # 只看有实例持有的（可投递的候选）
    zbot session list --all --json     # 含归档，结构化
    zbot session show <id> --turns 5   # 元信息 + 最近几轮
    zbot session show --last --json    # 最近更新的那个会话

`id` 支持完整 ULID、唯一前缀、末几位；有歧义时直接报错并列候选，**不要猜**，用 `list --json` 取名。
省略 `id` = 「当前会话」：先看 `ZBOT_SESSION_ID`，再看 `~/.zbot/current-session.json`。

## 投递并等结果

    zbot session send <id> "改完跑一下测试" --wait          # 一直等到回合终态
    zbot session send <id> "…" --wait=600                  # 显式上限（秒）
    zbot session send <id> "…" --json                      # 只要受理凭证，不等结果
    zbot session wait <id> --msg=<msgId>                   # 中断/断线后继续等这条
    zbot session wait <id> --turn=<turnId> --timeout=60
    zbot session queue <id>                                # 查看排队中的投递

语义要点：

- `--wait` 不带秒数 = 无限等到 `succeeded|failed|cancelled`。固定短超时会丢结果，别用。
- 目标忙时**默认排队**（每会话上限 8 条，满了返回 `queue_full`）；`--no-queue` 才是立即失败。
- `msgId` 由发送方生成、幂等；`--cancel=<msgId>` 只对仍在排队的消息生效。
- 退出码：`0` 成功 / `1` 回合失败或取消 / `2` 显式超时（**消息已投递，不要重发**）/ `130` Ctrl-C 中断等待。
- `130` 之后用同一条 `--msg=<msgId>` 续等，不要重发消息。
- `status: delivered|queued` 只表示受理，不是完成；`wait_lost` 表示进程没了又无终态，别当成功。

**典型用法**：在 herdr 里给另一个项目开一个标签页 + 会话，让它去干活。

    zbot herdr spawn "修掉 lint 报错，只改必要的文件" --title "修 lint" --cwd ~/src/other --json
    # --title / --cwd 必填（标题同时是标签页标签）
    # → sessionId / herdr{workspaceId,tabId,paneId,tab,pane,caller} / msgId / commands / hints
    # commands = {wait?, send, sendAndWait, show, archive, close, closeTab, teardown}：后续动作全用返回里的命令
    # hints = {current?, later, observe}：current 等首条输入这一轮、later 是后续发消息怎么等、observe 看进度
    zbot session wait <id> --msg=<msgId>    # spawn 只等到「首条输入投递成功」就返回，结果用 commands.wait 等

spawn 不会归档、也不会让 TUI 退出：回合结束后 pane 里的 zbot 保持 idle，可继续 `commands.send`；
收尾直接用 `commands.teardown`（= `zbot herdr teardown <id> --tab=<tabId>`：归档 + 关标签页，
投递成功即返回，不等落盘）。单独动作仍有 `archive`（`/archive`：归档并释放）/
`close`（`/close`：只释放）——两者**二选一**，先 archive 再 close 只会得到 `no_holder`；
会话正在跑回合时 teardown 会以 `busy` 拒绝，先 `commands.wait` 等完。

`herdr spawn` 需要 `HERDR_ENV=1`（在 herdr pane 里执行），否则报 `herdr_unavailable`；
不在 herdr 里就退回手工三步：`session new` → `zbot resume <id>`（人开一次 TUI 认领）→ `session send`。

## 改标题（运行时也能改）

    zbot session rename <id> "新标题"

标题是元数据：会话被 TUI 持有时，CLI 通过控制通道交给持有者落盘，回合执行中也能改；
没人持有时 CLI 自己写日志。`--json` 返回的 `title` 是真正生效的值（上限 200 字）。
TUI 内的交互式入口是 ⌘R（同样允许在回合执行中使用）。

## 远程执行 slash 命令

`session send` 的正文**第一个字符就是 `/` 且是完整命令名**时，在目标会话里执行命令并把结果回传（不发给模型）。
命令矩阵的唯一事实源是 `src/commands/slash-command.ts`，常用：

    zbot session send <id> "/sessions --json"      # 列会话
    zbot session send <id> "/new 新任务"            # 在目标实例新建并认领会话
    zbot session send <id> "/cwd ~/src/other"      # 换工作目录
    zbot session send <id> "/model --json"         # 当前模型/可选项
    zbot session send <id> "/skills --json"        # 技能列表
    zbot session send <id> "/compact"              # 压上下文
    zbot session send <id> "/close"                # 释放持有（数据保留）

陷阱：

- 只认完整命令名；`/help extra`、缺参数的 `/tasks status` 直接报 `invalid_command`；`/helpx`、`/` 当普通文本给模型。
- 破坏性命令远程必须带确认词：`/clear confirm`、`/delete confirm`。
- 归档态只接受只读/生命周期命令（`/sessions /keys /skills /help /unarchive /delete`），其余回「先 /unarchive」。
- `/archive`、`/close`、`/delete` 是**先把结果送达、再释放**，所以能拿到回执。

## 状态目录与配置

    ~/.zbot/env                    模型/接口配置（不要 cat 出来，让程序读）
    ~/.zbot/sessions/              会话事件日志（session show 的来源）
    ~/.zbot/current-session.json   当前会话指针
    ~/.zbot/mcp-servers.yaml       MCP 配置（zbot mcp list/add/remove 维护）
    ~/.zbot/skills/                用户级技能（优先）
    ~/.agents/skills/              共享技能（同名时被用户级覆盖）

`ZBOT_STATE_DIR` 可整体改状态目录。改完技能或 MCP 配置不用重启，`/reload` 或
`zbot session send <id> "/reload"` 即可（其他会话执行中会拒绝）。

## 常见坑速查

| 现象 | 原因与处理 |
| --- | --- |
| `tui_or_backend_required` | CLI 不跑模型：开 TUI（或 `herdr spawn`）认领会话 |
| `herdr_unavailable` | 不在 herdr pane 内：手工 `session new` + `resume` |
| `no_holder` | 会话没人持有：`resume` 打开，或先 `session unarchive` |
| `self_target` | 目标就是自己所在的会话：换一个会话 id，本轮的结论直接输出即可 |
| `queue_full` | 排队已满 8 条：等一会儿，先 `session queue` 看清 |
| 退出码 2 | 已投递但超时：用 `wait --msg` 续等，别重发 |
| 退出码 130 | 只是停止等待，目标回合仍在跑 |
| 标题/正文里带 `--json` 被吃掉 | 开关写在 `--` 前面：`rename <id> --json -- "…"` |
| `session list` 看不到刚建的会话 | 归档了（`--all`）；或空会话已被自动清理 |
