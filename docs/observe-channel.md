# 观察通道（observe socket）

外部界面（GUI、远程前端、脚本）要「先查一遍再跟着看」时，走观察通道，不要复用控制 socket，
也不要靠 tail 事件日志猜进度。

```
~/.zbot/sessions/observe/<sessionId>.sock
```

## 与控制通道的分工

| | 控制 socket（`sessions/control/<id>.sock`） | 观察 socket（`sessions/observe/<id>.sock`） |
| --- | --- | --- |
| 表达归属 | **是**（bind 成功即持有） | 否，纯旁路 |
| 能做的操作 | 投递消息、查/撤销排队、消费结果、改名、协商释放 | 快照、订阅、心跳 |
| 语义 | 有投递与消费，必须可靠 | 只读，可丢、可重来 |
| 协议版本 | 与控制客户端绑定 | 独立版本，可单独演进 |

**归属只由控制 socket 表达。** 观察 socket 残留、不存在或版本不兼容，都不影响「谁持有这个会话」；
反过来，观察 socket 绑定失败只降级（界面回退到日志/命令行），绝不影响投递与回合执行。

## 帧

newline-delimited JSON。请求都带 `id`，回复带同一个 `id`。

| 请求 | 说明 |
| --- | --- |
| `{type:"hello", id, version}` | 握手；`version` 必须与宿主支持的版本一致（目前为 `1`），否则 `hello_result.ok=false` 并说明原因 |
| `{type:"snapshot", id, since?, limit?}` | 取 `since` 之后的一段持久化事件；`limit` 上限 200 |
| `{type:"subscribe", id, since?}` | 订阅；之后先补 `since` 之后的持久化事件，再持续推送 |
| `{type:"unsubscribe", id}` | 退订，连接保留 |
| `{type:"ping", id}` | 心跳 |

回复：`hello_result`（含 `sessionId/title/busy/lastSeq`）、`snapshot_result`（`events/lastSeq/more`）、
`subscribed`、`unsubscribed`、`pong`、`error`（`code`: `forbidden` / `bad_request` / `unsupported_version` / `internal`）。

推送：

- `{type:"events", events}`：持久化事实，带 `seq`，**严格递增**。
- `{type:"live", frame}`：瞬态信号（正在生成的正文 `text`、思考位 `think`、回合收尾 `end`），
  **不带 seq**，断线后由持久化事件补齐，不参与游标。
- `{type:"gap", fromSeq, toSeq}`：这条连接落后太多被丢帧，客户端应从 `toSeq` 重新 `snapshot`，
  不要把空隙当成「没发生」。

## 客户端该怎么做

1. `hello` 确认版本；
2. `snapshot(0)` 拿第一页，`more=true` 就带 `since=lastSeq` 继续；
3. `subscribe(since=lastSeq)`——服务端会补 `since` 之后的事件，所以中间不会有空隙；
4. 按 `seq` 去重（服务端已过滤，但重连与重放仍可能重复，去重是客户端的责任）；
5. 收到 `gap` 或断线，回到第 2 步；
6. 只读：投递、查排队、改名、释放会话一律走控制通道。

## 隔离与背压

- 每条连接一个状态机，慢消费者只影响自己：单连接积压超过 4 MiB 就丢事件帧并发 `gap`，
  瞬态帧直接跳过；不会阻塞宿主事件循环，也不会拖慢控制通道。
- 观察通道不参与归属、不消费结果、不占控制通道的投递槽。
- 事件视图只保留界面渲染需要的字段（`events/session-event-view.ts`），工具输出全文与推理正文不下发；
  需要原文时按需从事件日志读取。

## 与远程接口的关系

观察通道和远程接口的 SSE 用同一份事件视图（`events/session-event-view.ts`）与同一份瞬态信号
（`events/live-stream.ts`，由宿主的 `notify` 统一喂入）。区别只是传输形态：
SSE 给浏览器，observe socket 给本机前端；两者都不改变磁盘上的事件日志与重放语义。
