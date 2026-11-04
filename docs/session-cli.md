# 会话命令行

`zbot session <子命令>` 直接读写 `$ZBOT_STATE_DIR`（默认 `~/.zbot`）下的会话，用于让其他 AI 或脚本操作会话，而不必进入 TUI。

```sh
zbot session list                 # 未归档会话
zbot session list --all --json    # 含归档，结构化输出
zbot session show <id>            # 元信息 + 最近 3 轮消息
zbot session show <id> --turns 10 # 看最近 10 轮
zbot session show <id> --all --full --json
zbot session new --title "排查 CI" --cwd ~/src/infra
zbot session rename <id> "新标题"
zbot session rename <id> -- "修复 --json 输出"   # 标题里带 - 开头片段时用 -- 分隔
zbot session archive <id>
zbot session unarchive <id>
zbot session delete <id> --json
zbot session send <id> "跑一下测试" --wait=300
zbot session send <id> "顺便修下 lint" --wait=300      # 目标忙时排队，回合结束后执行
zbot session send <id> --cancel=<msgId>               # 撤销排队中的消息
zbot session queue <id> --json                        # 查看排队中的消息
zbot session run "跑测试并修 lint" --json          # 新建会话并立即执行（原子认领）
zbot session show <id> --json --since=<seq>           # 事件级增量读取
zbot session show <id> --json --lite                  # 精简视图（不含完整消息）
zbot resume <id>                       # 载入旧会话，打开 TUI
zbot resume <id> -p --json "继续修 lint"  # 无 UI 续聊一轮，输出最终结果
```

子命令别名：`ls` = `list`，`cat` = `show`，`rm` = `delete`。

`--` 之后的参数一律按正文/标题处理，所以开关要写在 `--` 前面：`rename <id> --json -- "标题里带 --json"`。

`id` 支持完整 id、唯一前缀或末几位；前缀与后缀各命中不同会话也算歧义，会列出候选并报错。

`show` 默认最近 3 轮，`--turns N` 指定轮数，`--all` 全部；非 `--full` 时单条消息按 200 列截断，`--full` 输出完整正文（仍会剥掉终端控制序列）。

所有子命令都支持 `--json`（`show`/`list`/`new`/`send`/`rename`/`archive`/`unarchive`/`delete`）。

## 排队投递（send）

目标会话正在跑回合时，`send` 默认**排队**而不是拒绝：消息落盘为 `peer_message`（带 `queued`），
当前回合结束、会话空闲后自动执行本轮，结果照常回传。

```sh
zbot session send <id> "改完记得跑测试" --json
# {"sessionId":"…","msgId":"…","delivered":true,"queued":true,"position":1,"expiresAt":"…"}
zbot session send <id> "再补一条" --wait=300 --json   # 排队 + 执行都计入 --wait
zbot session send <id> "紧急纠偏" --no-queue          # 忙时立即失败（旧行为）
zbot session send <id> --cancel=<msgId> --json        # {"cancelled":true}
zbot session queue <id> --json                        # 队列快照（position/msgId/from/queuedAt/expiresAt）
```

- **有界**：每会话最多 8 条排队；满了返回 `queue_full`（`delivered:false`），不静默丢。
- **幂等**：`msgId` 由发送方生成；重复投递同一 `msgId` 不会重复执行，ack 仍返回 `queued`/已受理状态。
- **超时**：`--expires=秒`（默认 270）是排队有效期，不是执行时限；到期未执行会回传
  `stopReason:"expired"` 的结果，并从队列移除。
- **取消**：`--cancel=<msgId>` 只对仍在排队的消息生效；已在执行返回 `cancelled:false, reason:"running"`。
- **返回值**：`queued:false` 表示已在本轮执行；`queued:true` 表示已受理待执行；两者都 `delivered:true`。
  等待结果时（`--wait`）统一按结果回传处理；取消/过期会得到 `ok:false` 的结果。
- **边界**：队列在持有会话的进程内；宿主进程退出时队列随之消失（事件日志仍可复盘）。
  跨进程可靠投递仍以 `--wait` 拿到明确结果为准，不做重启后自动重放。

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
- **目标会话无人持有**（进程退出、归档后释放）时，`send` 由本进程临时接管执行这一条：
  命令直接跑（`/review` 转成模型指令）、普通文本跑一轮模型，结束后释放
  （`--json` 带 `executedLocally: true`）。这是 `/archive` 之后还能 `send /unarchive` 的原因。
  该路径沿用调用方的 `ZBOT_STATE_DIR`，`--queue`/`--expires` 无意义，也没有 msgId 幂等
  （重复调用即重复执行）。
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
| `/close` | 关闭（释放持有，数据保留） | **结果送达后**释放持有，不写归档事件 |
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

## 创建并执行（run）

`session new` 只落 `session_created` 事件，不认领会话，因此随后 `session send` 会因为没有持有者而失败。
`session run` 把「新建 → 认领 → 执行一轮 → 释放」合成一条命令，适合 AI 一次性派活：

```sh
zbot session run "跑测试并修掉失败用例" --title "修 CI" --cwd ~/src/infra --json
# {"sessionId":"…","content":"…","aborted":false,"toolCalls":12}
```

- 与 `resume -p` 共用执行骨架；会话在命令结束后保留（可继续 `show` / `resume`）。
- 认领是原子的：创建后立即 bind 控制 socket，其他实例无法并发认领，不存在双写竞态。
- 失败语义同 `resume -p`：`--json` 输出结构化错误，退出码 0/1/130/143。
- 需要「先建会话、稍后再派活」时仍用 `session new` + `resume`。

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
- `zbot resume <id> -p [文本]`：无 UI 续聊一轮，把本回合最终 assistant 文本写到 stdout；
  未给文本时从 stdin 读。加 `--json` 输出 `{sessionId, content, aborted, toolCalls}`。
- 开关必须写在续聊文本之前：正文开始后不再解析开关（避免正文里的 `--json` 被吞掉）；
  首个正文词以 `-` 开头时用 `--` 分隔，例如 `zbot resume <id> -p -- --json 是什么意思`。
- `--unarchive`：目标会话已归档时先恢复；缺省拒绝，避免误改归档历史。
- 恢复前会**不协商地**认领会话。被其他实例（TUI/serve）持有时直接失败，提示改用
  `zbot session send`；不会抢锁造成双写。
- `id` 规则与 `session` 子命令一致（完整 id / 唯一前缀 / 末几位）。

无 UI 恢复的失败码：`not_found` / `ambiguous` / `usage` / `session_busy`（含 `holderPid` 与
`reason`）/ `session_claim_failed`（bind 等内部错误）/ `session_archived` 等；
`--json` 时错误对象与其他子命令同形。

## 读写规则

- `list` / `show` 只读事件日志，任何时候都能执行，会话正被 TUI 打开也安全。
- `new` / `rename` / `archive` / `unarchive` / `delete` 要求目标会话**没有被任何实例持有**（控制 socket 无监听者），否则拒绝并提示去持有它的实例里操作。写入在会话锁内完成，避免与 TUI 双写事件序列。
- `send` 是唯一要求"有实例持有"的子命令：它通过控制 socket 把消息投递给运行中的会话；不带 `--wait` 时只投递不等结果（结果不会回传），带 `--wait[=秒]` 时把对方回合的最终输出打到 stdout（默认等 300 秒，秒数必须写成 `--wait=秒`）。
- `send` 的正文以 `-` 开头时用 `--` 分隔：`zbot session send <id> -- "-正文"`。
- 新建的会话不会被认领，等 TUI 打开它才真正开始执行。

## 输出与退出码

默认人类可读；`--json` 给结构化数据。键集合固定，缺省值为 `null`（不用判 `undefined`）：

- `list --json`：`sessionId` / `title` / `cwd` / `turns`（轮数）/ `createdAt` / `updatedAt` / `archived` / `status`（`idle` | `held`；`mine` 只在进程内出现，命令行不会给出）/ `holderPid` / `busy` / `modelSelection`，日志损坏时多一个 `corrupted: true`。`status` 只表示归属，归档另由 `archived` 表达。
- `show --json`：上面的元信息（轮数字段叫 `totalTurns`）+ `compactCount` / `lastPromptTokens` / `turnDetails[]`（`index` / `id` / `status` / `messages[]` 原样消息）。`turns`（数字）只出现在 `list`，`turnDetails`（明细）只出现在 `show`。
- `new --json`：`sessionId` / `cwd` / `title`。
- `send --json`：投递后 `sessionId` / `msgId` / `delivered`；`--wait` 成功时是完整结果（`ok` / `text` / `stopReason` / `msgId` / `delivered`）。
- `rename --json`：`sessionId` / `action:"rename"` / `title`；`archive`/`unarchive`：`action` + `archived`；`delete`：`action:"delete"` / `deleted` / `turns`。

失败时 `--json` 会在 stdout 输出 `{"error":{"code","message",…}}`，`code` 取值：`not_found`（不存在）、`ambiguous`（id 有歧义）、`usage`（参数/用法错误）、`held`（被实例持有或取锁失败）、`no_holder`（无人持有，仅 send）、`busy`（对方执行中）、`unreachable`、`bad_reply`（协议异常）、`peer_failed`（对方回合失败，`partialText` 带部分输出）、`wait_timeout`、`failed`（其余）。

日志损坏（文件在但读不出有效事件）的会话仍会出现在 `list`（多 `corrupted: true`，状态列“日志损坏”，更新时间取文件 mtime），`show` 也会显示“日志 损坏”提示。

退出码：`0` 成功；`1` 一般失败；`2` `wait_timeout` —— 消息**已投递**，不要重发。
