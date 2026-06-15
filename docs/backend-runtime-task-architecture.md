# Toonflow 后端运行时与统一任务架构

## 进程关系

Electron 启动后不再直接加载 Express、SQLite、Sharp 或供应商代码。

```text
Electron Main
├─ API Utility Process
│  ├─ Express / Socket.IO
│  ├─ 轻量查询与任务入队
│  └─ Agent Socket IPC 代理
├─ Task Worker Utility Process
│  ├─ 统一任务调度
│  ├─ 视频供应商队列
│  ├─ 图片、提示词、音色和小说事件任务
│  └─ 缩略图与后台媒体处理
├─ Agent Utility Process
│  └─ productionAgent / scriptAgent 流式会话
└─ Dreamina CLI 等供应商子进程
```

Main 只负责窗口、协议和子进程生命周期。API、Worker、Agent 使用独立 PID 和独立
SQLite 连接。子进程异常按 1、3、10 秒重启，连续失败三次后停止自动重启。退出时
等待 15 秒，超时才强制终止。

## 统一任务

`o_tasks` 是任务状态唯一事实来源，业务专用任务表继续保存供应商细节。核心字段：

- `taskId`：全局字符串 ID。
- `taskType`：`image | asset | storyboard | video | prompt | audio | media`。
- `status`：`pending | queued | submitting | processing | completed | failed | cancelled`。
- `phase`：供应商或处理器内部阶段。
- `handler/payloadJson/resultJson`：Worker 处理器及紧凑输入输出。
- `priority/availableAt`：优先级和可执行时间。
- `leaseOwner/leaseExpiresAt`：原子领取租约。
- `attempt/maxAttempts`：执行次数；不确定是否扣费的任务不会自动重提。
- `providerTaskId`：可安全恢复的官方任务凭据。
- `version`：事件顺序版本。

`o_taskEvent` 保存紧凑状态事件。事件不包含 Base64、完整 CLI 输出或大型业务对象，
默认保留 7 天。

## 调度流程

```text
API 短事务入队
  → Worker 按 priority、createdAt、项目公平性扫描
  → 条件更新原子领取
  → 事务外执行供应商、Sharp 和文件操作
  → 短事务写业务状态、任务状态和事件
  → Socket 推送 task:status
```

默认 Worker 并发：

| 类型 | 并发 |
| --- | ---: |
| 文本/提示词 | 4 |
| 图片 | 2 |
| 资产 | 2 |
| 分镜 | 2 |
| 音频 | 2 |
| 媒体处理 | 2 |

视频继续按 `vendorId + providerAccountId + providerModelKey` 的模型配置控制并发。调度
批量读取模型配置、容量阻塞和活动数量，不再逐模型执行 N+1 查询。

## 重启恢复

- 本地 `queued` 任务保留并继续调度。
- 有 `providerTaskId` 的供应商任务恢复查询，不重新提交。
- Worker 执行中断且没有官方凭据的任务标记失败。
- 无处理器的同步旧任务在重启后标记为“软件重启导致任务中断”。
- 已提交但无法确认是否扣费的任务不会自动重提。

## API 与 Socket

### `POST /api/task/status/snapshot`

请求：

```json
{ "projectId": 1, "scriptId": 2, "taskIds": ["optional-task-id"] }
```

响应包含 `serverTime` 和紧凑任务数组。用于页面进入、Socket 重连和休眠恢复。

### `POST /api/task/cancel`

仅允许取消尚未执行的本地任务。已经提交供应商的任务返回 HTTP 409。

### `POST /api/diagnostics/runtime/status`

返回 Main、API、Worker、Agent 的 PID、CPU、内存、event-loop delay，以及 API/Worker
数据库查询统计、慢 SQL、`SQLITE_BUSY` 次数和活动 Dreamina CLI PID。

### Socket

命名空间：`/api/socket/task`

事件：`task:status`

前端使用 `taskId + version` 丢弃旧事件。断线不影响后台任务，重连后调用快照接口。

## 数据库与媒体

- API `busy_timeout=500ms`，Worker `busy_timeout=5000ms`。
- WAL、`synchronous=NORMAL` 保持启用。
- 超过 50ms 的 SQL 和超过 100ms 的事务会记录诊断。
- 供应商模型列表缓存 15 秒；转译后的供应商 VM 按代码和配置签名缓存。
- 缩略图缺失时立即返回原图，并将去重任务交给 Worker；同一缩略图最多生成一次。
- 任务 payload、事件和日志禁止保存媒体 Base64。

## 验证记录

2026-06-13 本地验证：

- TypeScript：通过。
- API 契约：前端 138、后端 191、静态匹配 137，1 个 Dreamina 动态路径在白名单。
- 集成测试：35/35 通过。
- 正式构建：通过，生成三个 Runtime bundle。
- 隔离冷启动：通过。

冷启动示例 PID：

```json
{
  "api": 32128,
  "worker": 27148,
  "agent": 37020
}
```

该 PID 仅为一次临时数据目录冒烟测试记录，不是固定值。
