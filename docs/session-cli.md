# 会话命令行

`zbot session <子命令>` 直接读写 `$ZBOT_STATE_DIR`（默认 `~/.zbot`）下的会话，用于让其他 AI 或脚本操作会话，而不必进入 TUI。

```sh
zbot session list                 # 未归档会话（最近更新在前；当前会话额外提示一行）
zbot session list -n 10           # 只看最近 10 条
zbot session list --held          # 只看有实例持有（运行中/闲置未释放）的会话
zbot session list --all --json    # 含归档，结构化输出
zbot session show                 # 当前会话：元信息 + 最近 3 轮消息
zbot session show --last          # 最近更新的会话
zbot session show <id>            # 指定会话
zbot session show <id> --turns 10 # 看最近 10 轮
zbot session show <id> --all --full --json
zbot session new --title "排查 CI" --cwd ~/src/infra
zbot session rename <id> "新标题"
zbot session rename <id> -- "修复 --json 输出"   # 标题里带 - 开头片段时用 -- 分隔
zbot session archive <id>
zbot session unarchive <id>
zbot session delete <id> --json
zbot session send <id> "跑一下测试" --wait             # 一直等到回合终态
zbot session send <id> "跑一下测试" --wait=300         # 显式上限；超时退出码 2，不要重发
zbot session send <id> "顺便修下 lint" --wait          # 目标忙时排队，回合结束后执行
zbot session send <id> --cancel=<msgId>               # 撤销排队中的消息
zbot session wait <id> --msg=<msgId>                  # 中断/断线后继续等这条消息的结果
zbot session wait <id> --turn=<turnId> --timeout=60   # 按回合等（show --json 有 turnId）
zbot session wait                                     # 等当前会话最近一轮进入终态
zbot session queue <id> --json                        # 查看排队中的消息
zbot session show <id> --json --since=<seq>           # 事件级增量读取
zbot session show <id> --json --lite                  # 精简视图（不含完整消息）
zbot resume <id>                       # 载入旧会话，打开 TUI
```

`zbot -p`、`zbot resume <id> -p` 和 `zbot session run` 不再在 CLI 进程内直接执行模型。
CLI 投递只通过控制通道交给已运行的 TUI/后台持有者；也可通过 `zbot serve` 的任务接口提交后台任务。

普通启动 `zbot`（不带参数）每次都会**新建一个空会话**并进入 TUI：新建总是分配新的 ULID，
不会复用或覆盖上一次的会话；旧会话用 `zbot resume <id>` 或 TUI 的会话面板（⌘P）打开。

**空会话自动清理**：TUI 退出（⌃D / 正常退出）或 `/close` 时，本实例持有、且从未产生过内容
（日志里只有 `session_created` 与建会话时的 `lazy_mcp_changed`）、也没有未发送草稿的会话会被自动删除，
不留下 0 轮会话。判定用**白名单**：其余任何事件——回合、会话间投递、改标题、`/cwd`、`/model`、
`/clear`（会落一条 `session_cleared`）、归档态，甚至以后新增的事件类型——都按「有内容」保留；
日志读不出来时也保留。
删除成功后若「当前会话」指针正指向它，指针一并清掉。
`session new` 建的空会话不会在命令行退出时被删（需要显式 `session delete`），
被 TUI 打开后若一直没用，退出时同样按空会话处理。

子命令别名：`ls` = `list`，`cat` = `show`，`rm` = `delete`。

`--` 之后的参数一律按正文/标题处理，所以开关要写在 `--` 前面：`rename <id> --json -- "标题里带 --json"`。

`id` 支持完整 id、唯一前缀或末几位；前缀与后缀各命中不同会话也算歧义，会列出候选并报错。
`show` / `wait` 的 id 可以省略：按 `ZBOT_SESSION_ID` → TUI 最近进入的会话（`~/.zbot/current-session.json`）
的顺序确定「当前会话」，都没有时报用法错误。指针只是便捷入口，不参与归属判定。

`show` 默认最近 3 轮，`--turns N` 指定轮数，`--all` 全部；非 `--full` 时单条消息按 200 列截断，`--full` 输出完整正文（仍会剥掉终端控制序列）。

所有子命令都支持 `--json`（`show`/`list`/`new`/`send`/`rename`/`archive`/`unarchive`/`delete`）。

## 排队投递（send）

目标会话正在跑回合时，`send` 默认**排队**而不是拒绝：消息落盘为 `peer_message`（带 `queued`），
当前回合结束、会话空闲后自动执行本轮，结果照常回传。

```sh
zbot session send <id> "改完记得跑测试" --json
# {"sessionId":"…","msgId":"…","delivered":true,"status":"queued","queued":true,"position":1,"expiresAt":"…"}
zbot session send <id> "再补一条" --wait --json       # 排队 + 执行都等，直到终态
zbot session send <id> "紧急纠偏" --no-queue          # 忙时立即失败（旧行为）
zbot session send <id> --cancel=<msgId> --json        # {"cancelled":true}
zbot session queue <id> --json                        # 队列快照（position/msgId/from/queuedAt/expiresAt）
```

- **有界**：每会话最多 8 条排队；满了返回 `queue_full`（`delivered:false`），不静默丢。
- **幂等**：`msgId` 由发送方生成；重复投递同一 `msgId` 不会重复执行，ack 仍返回 `queued`/已受理状态。
- **超时**：`--expires=秒`（默认 270）是排队有效期，不是执行时限；到期未执行会回传
  `stopReason:"expired"` 的结果，并从队列移除。
- **取消**：`--cancel=<msgId>` 只对仍在排队的消息生效；已在执行返回 `cancelled:false, reason:"running"`。
- **返回值**：`status` 只说投递事实——`delivered`（已受理，本轮执行）/`queued`（已受理，排队中），
  都不是完成。只有 `--wait` 才等到终态并输出 `status: succeeded|failed|cancelled`；
  回合被取消（aborted/interrupted/cancelled）时按 `peer_cancelled` 报错、退出码 1，不当作成功。
- **边界**：队列在持有会话的进程内；宿主进程退出时队列随之消失（事件日志仍可复盘）。
  跨进程可靠投递仍以 `--wait` 拿到明确结果为准，不做重启后自动重放。

## 等待结果（wait）

`session send --wait` 与 `session wait` 共用同一套等待逻辑：

```sh
zbot session send <id> "跑测试" --wait                  # 一直等到终态
zbot session send <id> "跑测试" --wait=600              # 显式上限（秒）
zbot session wait <id> --msg=<msgId>                    # 按入站消息继续等（中断/断线后）
zbot session wait <id> --turn=<turnId> --timeout=60     # 按回合等
zbot session wait <id>                                  # 等最近一轮
zbot session wait                                       # 当前会话的最近一轮
```

- **默认无限等**：不带秒数的 `--wait` / 不带 `--timeout` 的 `wait` 会一直等到回合进入
  `succeeded` / `failed` / `cancelled` 终态；固定短超时不再静默丢掉已投递的结果。
- **Ctrl-C 只停止等待**：不取消目标回合，也不重发消息；之后用同一条
  `zbot session wait <id> --msg=<msgId>` 继续等即可（`--json` 错误码 `interrupted`，退出码 130）。
- **两个事实源**：事件日志（`user_message.msgId` / `turn_commit.msgId` 关联，内容取该回合最后一条
  assistant 消息）与持有者的控制通道（`PeerResult` 推送 + 只读 `query_pending` 补查）。
  命令类消息没有回合事件，只有控制通道能给结果；模型回合即使推送丢失也能从日志复盘。
- **不误报完成**：ack（`delivered`/`queued`）不算结果；目标进程消失且没有终态记录时报
  `wait_lost`，不会把投递当成功。
- **并发与重复**：`msgId` 幂等，重复推送的结果只采纳一次；`query_pending` 只读不消费，
  多个等待方/断线重连可以同时查询同一条结果。
- 退出码：`0` 成功；`1` 回合失败/取消（终态事实仍打印，`--json` 仍是结果对象）；
  `2` 显式超时（消息已投递，不要重发）；`130` Ctrl-C 中断等待。
- 目标 id 必须是已落盘会话（或一个正被持有、尚未落盘的完整 ULID）：写错的 ULID 直接 `not_found`，
  不会等几秒再报「结果丢失」。

## 会话间命令（send）

`session send` 投递的文本如果**第一个字符就是 `/`** 且是 zbot 支持的完整命令名，
就在目标会话里执行并把结果回传给调用方（不发给模型）。**所有命令都可远程执行**：
面板类命令有等价的文本视图与非交互参数，交互类命令有 `set/enable/disable` 参数，
生命周期命令有确认词与「先回结果、再释放」的退出顺序。

### 通用规则

- 只认完整命令名：`/helpx`、`/Help`、`/`、前导空格的 `" /help"` 一律按普通文本交给模型。
- 已识别命令逐项校验参数：`/help extra`、`/tasks status`（缺 task_id）、`/model foo`
  等返回明确错误（`stopReason=invalid_command`），既不跑模型也不当普通文本。
- 视图类命令支持 `--json`：独立 token 才算开关，输出与文本表达同一事实。
- 未知 `/xxx` 仍是普通文本；`/review [附加说明]` 仍是模型指令，附加说明拼在固定指令之后。
- 命令在「本次投递已占住的会话互斥」里执行，不重抢、不代释；忙时按现有每会话有界
  FIFO 排队（`--queue`/默认、`--expires`、`--cancel`、msgId 幂等），不另建队列。
- **目标会话无人持有**（进程退出、归档后释放）时，`send` 返回 `no_holder`，不会本地接管或启动模型。
  先用 `zbot resume <id>` 在 TUI 打开会话；归档态用 `zbot session unarchive <id>` 解档后再恢复。
- 归档态会话只接受只读/生命周期命令（白名单见下表 `归档` 列），且**不写目标时间线**：
  往 `session_archived` 之后追加任何事件都会把它悄悄解除归档。其余命令回明确错误
  「先 `/unarchive`」。

### 命令矩阵

| 命令 | TUI 语义 | 远程协议（`session send`） |
| --- | --- | --- |
| `/new [标题]` | 新建会话并切换焦点 | 在本实例创建并认领子会话（同 `session_spawn`），返回 id/标题/cwd；不改变 TUI 焦点 |
| `/sessions [查询] [--json]` | 会话面板（搜索/切换/重命名/归档/删除） | 会话列表（id/标题/cwd/轮数/归档/是否执行中/持有者），按 id/标题/cwd 过滤；JSON 同形。切换/改名/归档/删除各有独立命令 |
| `/tasks [list\|status\|wait\|stop] … [--json]` | 后台任务管理 | 同语义动作与视图 |
| `/ps [--json]` | 运行中的后台任务 | 任务列表 |
| `/stop [id\|all]` | 终止后台任务 | 同语义 |
| `/reload` | 重载技能与 MCP | 同语义（其他会话执行中时明确拒绝） |
| `/keys [--json]` | 快捷键面板 | 快捷键清单（分组/键位/说明） |
| `/continue` | 补跑中断的工具或下一次请求 | 直接执行，返回「已继续/没有可继续的上下文」 |
| `/clear [confirm]` | 清空历史（截断重建） | 破坏性：远程必须带 `confirm`；会话保留可用且 cwd 不变 |
| `/archive` | 归档（可在面板查看） | **结果送达后**归档并释放持有；排队中的投递按 cancelled 收尾 |
| `/unarchive` | 取消归档 | 恢复可写（归档态白名单内可用） |
| `/delete confirm` | 彻底删除 | 破坏性，必须带 `confirm`；**结果送达后**删除并释放 |
| `/close` | 关闭（释放持有，数据保留；从未用过的空会话会删除） | **结果送达后**释放持有，不写归档事件（关闭请求本身已让会话有内容，不会被删） |
| `/compact [附加要求]` | 压缩上下文 | 与 TUI 共用压缩实现；附加要求进入压缩提示 |
| `/cwd [路径] [--json]` | 查看/切换工作目录 | 同语义（路径可含空格） |
| `/model [--json]` \| `/model <协议> <模型> [强度\|auto]` \| `/model effort [档位\|auto]` | 无参 = 交互式菜单：协议 → 模型 → 思考强度（目标模型可用档位+auto，默认当前档位/不支持则 auto）→ 是否设为默认；带参数 = 同一条命令的文字形式 | 查看当前与可选项；位置参数校验组合并按**目标模型**的档位校验/归一化强度（省略则保留原档位，不支持才回落 auto），选择立即落盘、下一回合生效；`effort` 查看/设置强度。统一入口，只有这一处写选择 |
| `/effort` `/thinking` `/reasoning` | 已随统一入口删除 | 不再是命令：整条按普通文本交给模型（与未知 `/xxx` 一致） |
| `/mcp [--json] \| /mcp enable\|disable <服务名>` | 面板查看状态、勾选会话级 lazy 启用 | 查看服务状态与 tool_search 情况；`enable/disable` 覆盖本会话启用集 |
| `/system [--json]` | 显示 system prompt | 同语义 |
| `/skills [--json]` | 技能列表 | 同语义 |
| `/help [--json]` | 帮助 | 同语义 |

`归档` 列白名单：`/sessions` `/keys` `/skills` `/help` `/unarchive` `/delete`。

命令矩阵与参数协议在 `src/commands/slash-command.ts`（唯一事实源），TUI 输入与
`session send` 共用同一份解析；执行器在 `src/host/peer-command.ts`（宿主层，
复用真实业务能力，不复制 TUI 面板实现）。

## 无 TUI 的执行边界

`session run` 保留为兼容入口，但会返回 `tui_or_backend_required`，不会创建一次性宿主。
`zbot -p` 与 `zbot resume <id> -p` 同样拒绝直接执行。要从 CLI 发起回合，目标 session
必须由 TUI 或后台实例持有，然后用 `session send` 投递；后台独立任务使用 `zbot serve`。

## 增量读取（show）

长会话不必每次取全量：

```sh
zbot session show <id> --json --since=1200      # 只取 seq > 1200 的事件（含 lastSeq，可直接续读）
zbot session show <id> --json --after-turn=40   # 只取第 40 轮之后的回合
zbot session show <id> --json --lite            # 回合只给摘要：messageCount/lastAssistant/toolNames
zbot session show <id> --all --full --json      # 完整历史（原有能力）
```

- `--since` 切到**事件视图**：`{sessionId, lastSeq, events:[{seq,ts,type,summary}]}`，适合按游标轮询。
- 回合视图（默认/`--turns`/`--all`/`--after-turn`）始终带顶层 `lastSeq` 与 `totalTurns`；
  `--lite` 不含 `messages`，单条消息摘要在 300 字内截断。
- 人类模式同样支持：`--since` 每个事件一行，`--lite` 每轮一行摘要。

## 恢复旧会话（resume）

`zbot resume <id>` 用于「进入」已有会话，而不是新建：

- 不带 `-p`：载入该会话并打开 TUI。
- `zbot resume <id> -p`：已禁用，CLI 不会创建一次性宿主执行模型回合；请去掉 `-p` 打开 TUI。
- `--unarchive`：目标会话已归档时先恢复；缺省拒绝，避免误改归档历史。
- 恢复前会**不协商地**认领会话。被其他实例（TUI/serve）持有时直接失败，提示改用
  `zbot session send`；不会抢锁造成双写。
- `id` 规则与 `session` 子命令一致（完整 id / 唯一前缀 / 末几位）。

`resume -p` 会返回 `tui_or_backend_required`。

## 读写规则

- `list` / `show` 只读事件日志，任何时候都能执行，会话正被 TUI 打开也安全。
- `new` / `rename` / `archive` / `unarchive` / `delete` 要求目标会话**没有被任何实例持有**（控制 socket 无监听者），否则拒绝并提示去持有它的实例里操作。写入在会话锁内完成，避免与 TUI 双写事件序列。
- `send` 是唯一要求"有实例持有"的子命令：它通过控制 socket 把消息投递给运行中的会话；不带 `--wait` 时只投递不等结果（结果不会回传），带 `--wait` 时一直等到对方回合终态并把最终输出打到 stdout（`--wait=秒` 才是显式上限，秒数必须写成 `--wait=秒`）。
- `send` 的正文以 `-` 开头时用 `--` 分隔：`zbot session send <id> -- "-正文"`。
- 新建的会话不会被认领，等 TUI 打开它才真正开始执行。

## 输出与退出码

默认人类可读；`--json` 给结构化数据。键集合固定，缺省值为 `null`（不用判 `undefined`）：

- `list --json`：`sessionId` / `current`（是否当前会话）/ `title` / `cwd` / `turns`（轮数）/ `createdAt` / `updatedAt` / `archived` / `status`（`idle` | `held`；`mine` 只在进程内出现，命令行不会给出）/ `holderPid` / `busy` / `modelSelection`，日志损坏时多一个 `corrupted: true`。`status` 只表示归属，归档另由 `archived` 表达。
- `show --json`：上面的元信息（轮数字段叫 `totalTurns`）+ `compactCount` / `lastPromptTokens` / `turnDetails[]`（`index` / `id` / `status` / `messages[]` 原样消息）。`turns`（数字）只出现在 `list`，`turnDetails`（明细）只出现在 `show`。
- `new --json`：`sessionId` / `cwd` / `title`。
- `send --json`：投递后 `sessionId` / `msgId` / `delivered` / `status`（`delivered` | `queued`）；
  `--wait` 成功时是完整结果（`ok` / `text` / `stopReason` / `msgId` / `turnId` / `status` / `source` / `delivered`）。
- `wait --json`：`sessionId` / `msgId` / `turnId` / `status`（`succeeded` | `failed` | `cancelled`）/ `ok` /
  `content` / `stopReason` / `error` / `source`（`events` | `peer`）/ `waitedMs`。退出码见上文。
- `rename --json`：`sessionId` / `action:"rename"` / `title`；`archive`/`unarchive`：`action` + `archived`；`delete`：`action:"delete"` / `deleted` / `turns`。

失败时 `--json` 会在 stdout 输出 `{"error":{"code","message",…}}`，`code` 取值：`not_found`（不存在）、`ambiguous`（id 有歧义）、`usage`（参数/用法错误）、`held`（被实例持有或取锁失败）、`no_holder`（无人持有，仅 send）、`busy`（对方执行中）、`unreachable`、`bad_reply`（协议异常）、`peer_failed`（对方回合失败，`partialText` 带部分输出）、`peer_cancelled`（对方回合已取消）、
`wait_timeout`（显式超时）、`wait_lost`（目标消失且没有终态）、`no_turn`（会话还没有回合可等）、
`interrupted`（Ctrl-C 停止等待）、`failed`（其余）。

日志损坏（文件在但读不出有效事件）的会话仍会出现在 `list`（多 `corrupted: true`，状态列“日志损坏”，更新时间取文件 mtime），`show` 也会显示“日志 损坏”提示。

退出码：`0` 成功；`1` 一般失败；`2` `wait_timeout` —— 消息**已投递**，不要重发。
