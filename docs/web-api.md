# web 接口

`zbot web` 是无 UI 的长驻宿主：它与会话 TUI 各自组装同一个 `SessionHost`，两者互不依赖，可同时运行（会话归属由控制 socket 互斥）。仅供远程开发自用，后续可能移除；命令不在 `zbot help` 总览里宣传。

## 启动

```sh
zbot web [--port 8787] [--bind 127.0.0.1] [--cwd <目录>] [--token <令牌>]
```

- 默认只绑 `127.0.0.1`。
- `--cwd` 是新建会话与工具的默认基准。
- 令牌优先级：`--token` > `config.yaml` 的 `web.token` > `~/.zbot/web/token`（首次启动自动生成，权限 0600）。
- 任务库位于 `~/.zbot/web/db/jobs.sqlite`。
- 所有 `/api` 请求带 `Authorization: Bearer <token>`；不再接受 `?token=`（URL 会被缓存、写进历史与反代日志）。
  页面首次进入在输入框里粘贴令牌，存在 localStorage；SSE 与图片都由前端 fetch 带 header 取回。
- **界面壳不需要令牌**（否则没法在页面里输入令牌）：`GET /` 与 `GET /ui` 公开，页面里输入一次后存 localStorage；
  数据接口（`/jobs`、`/sessions`、`/endpoints` 等）一律要令牌。

## 路由

| 方法与路径 | 说明 |
| --- | --- |
| `GET /` | Web 界面（单页，公开） |
| `GET /ui` | 同上（别名，保留兼容） |
| `GET /api`（端点清单） | 端点清单（JSON，需令牌） |
| `GET /api/healthz` | 存活与活跃会话数 |
| `GET /api/sessions` | 会话摘要列表 |
| `POST /api/sessions` | 建会话并立即认领，body `{cwd?, title?}`，返回 `{sessionId}` |
| `GET /api/sessions/:id` | 单个会话摘要，不存在 404 |
| `GET /api/sessions/:id/events?since=<seq>` | 会话事件（一次性 JSON） |
| `GET /api/sessions/:id/live?since=<seq>` | 会话事件（SSE 长连接）；除持久化帧外还有 `event: live` 实时增量 |
| `POST /api/sessions/:id/messages` | body `{text, wait?}`；不带 `wait` 返回 202 并后台执行，带 `wait: true` 等到回合结束 |
| `POST /api/sessions/:id/cancel` | 中止当前回合 |
| `POST /api/sessions/:id/inputs` | 随时输入：body `{text, mode?}`；空闲直接开跑，忙则排队 |
| `GET /api/sessions/:id/inputs` | 查看排队数量 `{request, turn}` |

### 随时输入（回合中追加）

和 TUI 一致：回合进行中继续输入时不打断当前推理，而是排队，到点再带给模型。

- `mode: "request"`（默认）：**下一次请求前**附加，模型当前回合就能看到（每次请求前消费，取走即清空）
- `mode: "turn"`：等**当前回合结束后**作为新回合的第一条消息，不插进正在跑的推理里；多条排队输入会合成一段，不会拆成多个回合
- 会话空闲时无论哪种模式都直接开始新一轮，返回 `{started: true}`
- 队列在服务端（不是浏览器）：刷新页面、换设备后排队内容仍在，runner 驱动的回合也能消费

## 任务（Jobs）

会话接口是「直接驱动一次对话」，Job 接口是「提交一件要交付的事」：排队、并发、超时、重试与状态都由服务端负责；
执行输出留在会话里，任务本身不再保存一份「结果」，结论写在评论（`/jobs/:id/comments`）里。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/jobs` | body `{prompt, workspace?, idempotencyKey?, priority?, timeoutSec?, model?, maxAttempts?, freshSession?, retriedFrom?}`；新建 201，幂等命中 200 |
| `GET /api/jobs?state=&limit=` | 任务列表（`state` 逗号分隔，如 `queued,running`） |
| `GET /api/jobs/:id` | 单个任务 |
| `GET /api/jobs/events?since=<seq>` | 列表状态（一次性 JSON） |
| `GET /api/jobs/live?since=<seq>` | **列表状态流**（SSE），推所有任务的状态变迁 |
| `GET /api/jobs/:id/events?sessionId=&since=` | 任务会话事件（一次性 JSON） |
| `GET /api/jobs/:id/live?sessionId=&since=` | 任务会话事件（SSE，含 `event: live`）；未开始时 404 |
| `POST /api/jobs/:id/cancel` | 取消；已结束返回 409 |

### 卡片：属性、评论、会话、看板拖拽

| 方法与路径 | 说明 |
| --- | --- |
| `PATCH /api/jobs/:id` | 改属性：`title / description / workspace / labels / dueAt / meta / mcpServers / priority / timeoutSec`；执行中拒绝（409） |
| `GET /api/jobs/:id/comments` | 评论列表（软删除的默认不返回） |
| `POST /api/jobs/:id/comments` | `{body, sessionId?}`，作者记 `user` |
| `PATCH /api/jobs/:id/comments/:cid` | 改正文（已删除的拒绝） |
| `DELETE /api/jobs/:id/comments/:cid` | 软删除，保留历史 |
| `GET /api/jobs/:id/sessions` | 该卡片的执行会话列表（每次 attempt 一条，人工新建为 `branch`） |
| `POST /api/jobs/:id/sessions` | `{prompt?}` 手动开一个新会话（同卡片下换思路继续） |
| `GET /api/jobs/:id/events?sessionId=` | 指定看哪个会话的事件；不填看最近一个 |
| `POST /api/jobs/:id/move` | `{column}` 卡片放哪一列：`todo / doing / done / cancelled`；只改摆放位置，不改任务状态 |
| `POST /api/jobs/:id/start` | 开始执行：排队中的任务 → `autoStart: true` 并 kick 调度器 |
| `POST /api/jobs/:id/archive` | 归档：从看板隐藏，状态与历史保留（运行中拒绝） |
| `POST /api/jobs/:id/unarchive` | 取消归档 |
| `DELETE /api/jobs/:id` | 彻底删除任务单：评论、执行会话记录、状态事件一并删除（对话本身保留） |
| `GET /api/jobs/mcp/servers` | 可勾选的 MCP 来源（按 server 聚合工具数） |

列表默认不返回已归档任务；`GET /api/jobs?archived=1` 才带上。

**触发方式**：创建只入队不执行。卡片落到「待办」并标「未开始」，用户在卡片详情点「开始」（`POST /api/jobs/:id/start`）后 `autoStart` 置 true，调度器才会领走；拖拽卡片本身不触发执行。

**看板列**：卡片放在哪一列由拖拽决定（`input.column`），与任务状态完全解耦——任务跑完不会自动跳列，拖动也不会启动、取消或移动任务。「已取消」只是一列，不代表任务状态。

老卡片没有 `column` 字段时按状态兜底推导一次：queued → 待办、leased/running → 进行中、succeeded → 已完成、cancelled → 已取消、失败类 → 待办。

**卡片属性**（`JobInput`）：

| 字段 | 说明 |
| --- | --- |
| `prompt` / `workspace` | 任务正文与工作目录（必填） |
| `title` / `description` | 卡片标题与富说明（描述给人看，prompt 给模型） |
| `labels` | 标签数组，看板筛选用 |
| `dueAt` | 截止时间（ISO8601） |
| `meta` | 自定义键值对，纯展示 |
| `mcpServers` | 本任务允许的 MCP server；**不填 = 全部，空数组 = 不用任何 MCP** |
| `timeoutSec` | 回合超时（秒），超时即取消并判 failed；界面不再提供输入，缺省 30 分钟 |

**AI 评论**：agent 在任务执行期间会拿到 `job_comment` 工具，写进同一张卡片的评论流（作者记 `agent`，绑定当时执行的会话），人机评论是同一条时间线。

## 界面辅助接口

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/assets` | 上传图片：body `{data（base64 或 data URL）, filename}`，落盘后返回引用，随消息发送时带上 |
| `GET /api/assets/:id` | 读图片。前端带 `Authorization` fetch 成 blob URL 再交给 `<img>`；id 形如 `img_<20 位 hex>` |
| `GET /api/fs/dirs?path=` | 目录补全：按输入前缀返回最多 20 个子目录（只列目录名，不读文件） |

**安全边界**：`fs/dirs` 能枚举本机任意目录，`assets` 能往状态目录写文件。两者都只依赖「仅绑回环 + 持有令牌」，
令牌等价于本机 shell 权限——不要外借。若要暴露到局域网，先加 root 白名单。

### 状态机

```
queued ──► leased ──► running ──► succeeded / failed / cancelled
   │          │            │
   └──────────┴────────────┴──► lost（租约过期，副作用未知）
```

- 终态不可逆：想再跑一次就新建任务（`retriedFrom` 记录来源）。
- `lost` 不自动重试：worker 失联时回合可能已经改过文件，只能人工确认后重跑。
- 状态只服务端调度内部使用，Web 界面不展示（看板列由用户拖拽决定，与状态无关）。

### 幂等与调度

- `idempotencyKey` 的作用域是 `(source, key)`（`source` 默认 `http`），由唯一索引保证并发下也只建一条；重复提交返回既有任务（200 而非 201）。
- 并发上限由 `config.yaml` 的 `web.jobsMaxConcurrent` 控制（默认 2，上限 16）；**同一 `workspace` 强制串行**，避免两次任务同时改同一个仓库。
- 排队中的任务直接出队取消；在跑的任务会中止对应回合。
- 任务绑定的会话是复用的：重试保留失败上下文，想让重试从干净上下文开始就传 `freshSession: true`。
- 服务端每 1/3 租约周期续租；进程崩溃后租约过期，下次启动会把遗留任务标 `lost`。

## 行为约定

- **事件流推持久化事实**：每帧带 `id: <seq>` 与 `data: <AgentEvent JSON>`，可用 `Last-Event-ID`（重连时优先）或 `since` 断线续传；瞬态的逐 token 片段不在此接口范围。
- **一次性拉取**：`?format=json` 返回 `AgentEvent[]`（与 SSE 的 `data` 同形状），按 `since` 过滤。
- **不漏不重**：服务端先订阅、后回放，回放期间到达的事件进缓冲，回放结束后按 seq 去重补推。
- **忙时拒绝**：会话已有回合在跑时 `POST .../messages` 返回 409，不会排队。
- **不夺权**：会话被其他实例（另一个 TUI / web）持有时同样返回 409，本服务不做协商式接管。
- **202 只代表已受理**：不带 `wait` 时后台执行，失败只写服务端日志；要结果就带 `wait: true`。
- **回合结果**：`wait: true` 返回 `{ok, aborted}`；`aborted: true` 表示回合被取消（不是失败）。
- **心跳**：空闲每 15s 发一行 SSE 注释（`: ping`），服务端禁用空闲超时以便长连接停留。

## 时间轴重置

会话被 `truncate`（时间点恢复）或 `delete` 时，服务端下发具名事件并把游标归零：

```
id: 0
event: reset
data: {}
```

`EventSource` 的 `onmessage` 收不到具名事件，客户端需要 `addEventListener("reset", ...)`，收到后清空本地状态。`id: 0` 让浏览器的 `Last-Event-ID` 一并归零，避免重连时带着失效游标永久静默。

用 `format=json` 一次性拉取的客户端没有推送通道可依赖：truncate 后旧游标只会一直返回空数组，客户端需自行用「返回为空且会话仍在推进」或「`max(seq)` 变小」判定游标失效，并从 `since=0` 重取。

`GET /api/sessions/:id/live` 对未知会话返回空流（不报 404），因为事件流是「订阅该 id 的时间轴」，会话之后可能被创建。

## 错误码

| 状态 | 含义 |
| --- | --- |
| 400 | `text` 为空，或 `since` 不是非负整数 |
| 401 | 令牌缺失或错误 |
| 404 | 路径不存在或会话不存在 |
| 405 | 方法不支持 |
| 409 | 会话正在执行中 / 已归档需先取消归档 / 由其他实例持有 |
| 500 | 服务端内部错误（细节只写服务端日志） |
