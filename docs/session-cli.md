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
zbot resume <id>                       # 载入旧会话，打开 TUI
zbot resume <id> -p --json "继续修 lint"  # 无 UI 续聊一轮，输出最终结果
```

子命令别名：`ls` = `list`，`cat` = `show`，`rm` = `delete`。

`--` 之后的参数一律按正文/标题处理，所以开关要写在 `--` 前面：`rename <id> --json -- "标题里带 --json"`。

`id` 支持完整 id、唯一前缀或末几位；前缀与后缀各命中不同会话也算歧义，会列出候选并报错。

`show` 默认最近 3 轮，`--turns N` 指定轮数，`--all` 全部；非 `--full` 时单条消息按 200 列截断，`--full` 输出完整正文（仍会剥掉终端控制序列）。

所有子命令都支持 `--json`（`show`/`list`/`new`/`send`/`rename`/`archive`/`unarchive`/`delete`）。

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
