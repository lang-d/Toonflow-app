# Toonflow 固定 API 与进程恢复前端对接文档

## 1. 固定入口

桌面端、开发环境和打包环境统一使用：

```text
API: http://127.0.0.1:10588/api
OSS: http://127.0.0.1:10588/oss/<path>
```

`toonflow://getAppUrl` 保留，固定返回：

```json
{
  "url": "http://127.0.0.1:10588/api"
}
```

前端不得持久化历史随机端口，也不得从媒体 URL 反推 API 地址。Axios 的 `baseURL` 可直接使用固定地址；Electron 内仍建议在启动时读取一次 `toonflow://getAppUrl`，用于保持协议边界一致。

## 2. Socket 地址

所有 Socket.IO 连接继续通过固定 API 入口：

```text
任务: http://127.0.0.1:10588/api/socket/task
生产 Agent: http://127.0.0.1:10588/api/socket/productionAgent
剧本 Agent: http://127.0.0.1:10588/api/socket/scriptAgent
```

API 进程短暂重启时地址不变，允许 Socket.IO 使用自身重连机制。禁止因为 API 重启刷新整个窗口。

## 3. 恢复顺序

任务 Socket 重连成功后：

1. 重新完成 Socket 鉴权。
2. 调用 `POST /api/task/status/snapshot`。
3. 使用快照覆盖本地任务状态。
4. 再继续消费 `task:status` 事件。
5. 使用 `taskId + version` 忽略旧事件。

前端关闭编辑器或页面切换不得取消后台任务。Worker 暂不可用时，新任务仍可成功入队并保持 `queued`，恢复后由 Worker 领取。

Agent 进程暂不可用时，Agent Socket 返回：

```ts
{
  code: "AGENT_UNAVAILABLE";
  message: string;
}
```

普通 API、任务查询和后台队列不受 Agent 故障影响。Agent 恢复后，现有 Socket 会在后端重新挂接；前端也应允许用户重新发起 Agent 会话。

## 4. 请求重试规则

允许自动重试：

- GET 或等价的只读查询。
- 任务快照和状态查询。
- 已带稳定幂等键、且后端明确支持幂等的请求。

禁止自动重试：

- 图片、视频、音频生成。
- 保存、删除、导入。
- Agent 消息提交。
- 任何可能重复扣费或产生重复业务记录的写请求。

非幂等请求遇到连接中断时，应提示用户通过任务快照或业务列表确认结果，不能直接重发。

## 5. 故障状态

### API 不可用

- 展示“本地服务正在恢复”。
- 暂停新请求。
- 保留用户尚未提交的编辑内容。
- Socket 和查询请求可按退避策略重连。

端口 `10588` 被其它程序占用时，Electron 启动页会直接展示诊断，不会切换随机端口。

### Worker 不可用

- 查询和普通编辑继续可用。
- 新后台任务显示 `queued`。
- 不把 Worker 暂不可用显示为业务生成失败。

### Agent 不可用

- 只禁用 Agent 会话入口。
- 不影响画布、资产、任务中心和视频队列。
- 展示后端返回的 `AGENT_UNAVAILABLE`。

## 6. 运行诊断

```text
POST /api/diagnostics/runtime/status
```

响应包含：

- 固定 `apiUrl`。
- Main/API/Worker/Agent 的 PID、状态、心跳、重启次数和最近错误。
- Worker、Agent 的 IPC 连接状态。
- event-loop、CPU、内存、数据库和外部 CLI 进程指标。

该接口用于诊断，不应成为普通页面恢复的依赖。

## 7. 联调验收

1. 连续重启应用，Axios、Socket 和媒体地址始终不变。
2. API 进程重启后窗口不刷新，Socket 自动重连并用任务快照校准。
3. Worker 重启期间任务保持 `queued`，恢复后继续执行。
4. Agent 重启不影响普通 API 和任务队列。
5. 端口被占用时显示明确错误，不访问随机端口。
6. 前端存储中不存在旧随机 API 地址。
7. 非幂等生成请求断线后不会被自动重发。
