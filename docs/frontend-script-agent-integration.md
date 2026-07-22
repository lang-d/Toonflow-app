# 剧本 Agent 前端对接契约

本契约取代旧的 XML 流解析、`getPlanData` Socket callback、`/scriptAgent/setPlanData` 与 `/scriptAgent/updateData`。前端不是剧本 Agent 的保存方；它只发送自然语言、展示实时状态、读取后端工作台事实并提交用户手工编辑。

## 1. Scope 与 Socket

剧本 Agent 是项目级 Agent：

```ts
const agentKey = "scriptAgent";
const scriptId = 0;
const isolationKey = `${projectId}:scriptAgent`;
```

连接 `/socket/scriptAgent` 时，`handshake.auth` 必须同时带 `token`、`projectId` 和 `isolationKey`。连接成功后立刻发送：

```ts
socket.emit("updateContext", { projectId, isolationKey }, callback);
```

仅在 callback 返回 `{ success: true }` 后允许发送 `chat`。切菜单、隐藏面板和短暂断线不得发送 `stop`；用户明确点击停止时才发送 `stop`。切项目时必须先确认当前 scope 没有 active run，再 `updateContext`。

## 2. 页面恢复顺序

每次进入剧本页、Socket 重新连接或收到终态 Run 更新时，按以下顺序恢复：

1. `POST /agent/run/status`

   ```json
   { "agentKey": "scriptAgent", "projectId": 12, "scriptId": 0 }
   ```

2. 若 `activeRun` 存在，或需要展示上一次结果，调用 `POST /agent/run/detail`：

   ```json
   { "runId": "..." }
   ```

3. `POST /scriptAgent/workspace/detail`

   ```json
   { "projectId": 12 }
   ```

4. `POST /agents/getMemory`，传入 `projectId` 与 `agentType: "scriptAgent"` 恢复聊天记录；该接口会按固定的 Script Agent scope 查询，不接收 `isolationKey` 参数。

不要依赖是否收到完整流式消息判断任务是否完成。聊天消息是交互记录，Run/timeline 是生命周期事实，workspace 是骨架、策略和剧本的唯一事实来源。

## 3. Workspace API

### 读取工作台

`POST /scriptAgent/workspace/detail`

响应 `data`：

```ts
{
  workspaceId: number;
  storySkeleton: string;
  adaptationStrategy: string;
  scripts: Array<{ id: number; name: string; content: string }>;
}
```

### 保存骨架或策略

`POST /scriptAgent/workspace/save-stage`

```ts
{
  projectId: number;
  stage: "storySkeleton" | "adaptationStrategy";
  content: string;
}
```

### 新增或更新剧本

`POST /scriptAgent/scripts/upsert`

```ts
{
  projectId: number;
  id?: number; // 更新时必须是当前项目的精确 ID
  name: string;
  content: string;
}
```

### 删除剧本

`POST /scriptAgent/scripts/delete`

```ts
{ "projectId": number, "id": number }
```

当当前 project scope 有 `running` Script Agent Run 时，以上三个写接口会返回 HTTP `409`。前端应刷新 `/agent/run/status`，显示当前 Run 的状态，并避免用本地草稿覆盖 Agent 正在保存的事实。

## 4. 实时事件

所有事件只会发给同一 `projectId` 的 `scriptAgent:${projectId}` room：

| 事件 | 用途 | 前端动作 |
| --- | --- | --- |
| `agent:run:update` | Run 创建、模型进度、完成、失败、取消、等待用户 | 更新运行态；收到 `progress` 时更新进度块；收到终态或 `terminalPersistenceFailed` 时重新读取 Run detail 和 workspace。 |
| `scriptAgent:workspace:update` | Agent 工具已保存骨架、策略或剧本 | 立即重新读取 `/scriptAgent/workspace/detail`；不得从聊天文本提取正文。 |
| `message` / `content:add` / `content:update` / `message:update` | 实时聊天展示 | 仅渲染聊天，不触发工作台保存。 |

`agent:run:update` 的公共字段：

```ts
{
  agentKey: "scriptAgent";
  projectId: number;
  scriptId: 0;
  serverTime: number;
  status: "running" | "awaiting_user" | "completed" | "failed" | "cancelled" | "interrupted";
  run?: AgentRun;
  activeRun?: AgentRun;
  progress?: { stage: string; subAgent?: string; title: string; detail?: string; phase?: string };
}
```

`scriptAgent:workspace:update`：

```ts
{
  projectId: number;
  scriptId: 0;
  kind: "stage" | "script";
  stage?: "storySkeleton" | "adaptationStrategy";
  action?: "created" | "updated" | "deleted";
  scriptRecordId?: number;
}
```

## 5. Run、审核与用户输入

- `running`：模型仍在执行；面板展示 Run detail 的 timeline 与最后一个 `progress`。
- `awaiting_user`：模型已经通过 `await_user_decision` 结束本轮。展示 `run.reason` 与 `run.resultJson.question/options/context`，继续使用普通输入框发送下一轮自然语言。
- `completed`：模型已通过 `complete_agent_run` 明确声明本轮完成，不代表自动进入下一创作阶段。
- `failed`、`cancelled`、`interrupted`：展示 `reason`，重新读取 workspace 后保留已经成功保存的事实。若 `errorJson.code === "AGENT_TERMINAL_DECLARATION_MISSING"`，表示模型/供应商流没有声明终态；允许用户重新发起，但不得把它当作已保存产物或自动补发请求。若 `interrupted` 的 timeline 含 `runtime_restarted`，表示上一个 Agent runtime 已终止，不能把本地流恢复为仍在执行。

Run detail 的 timeline 还可能包含：

- `model_stream_finished`：仅含脱敏结束诊断（结束原因、步骤数、工具调用数、文本长度），不含 Prompt、工具参数或消息全文。
- `terminal_declaration_missing`：当前流自然结束但没有模型终态声明；它与最终 `failed` 一起用于排查模型/供应商兼容性。

审核正文不是普通聊天摘要。审核 Agent 保存的文本会以 `agent_output_archived` 事件出现于 `/agent/run/detail.events`，其 payload 包含：

```ts
{
  category: "scriptAgentReview";
  target: "storySkeleton" | "adaptationStrategy" | "script";
  textAssetId: number;
  summary: string;
  size: number;
}
```

需要展示全文时，前端通过既有 `/textAsset/getContent` 分页读取 `textAssetId`。不要把审核建议自动转换为返修命令；下一轮由用户自然语言和模型读取审核事实后决定。

## 6. 必须删除的旧逻辑

- XML `<storySkeleton>`、`<adaptationStrategy>`、`<scriptItem>` 解析与本地 `planData` 回写。
- Socket `getPlanData` listener/callback。
- 流完成时调用 `/scriptAgent/setPlanData`。
- `/scriptAgent/updateData`、`/scriptAgent/setPlanData` 的请求封装。
- 通过聊天文本、XML 是否到达或本地 loading 状态推断 Agent 完成度。
