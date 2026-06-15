# Toonflow 前端异步任务协调对接文档

## 背景

后端已将耗时任务从 Electron Main/API 请求线程拆到独立 Task Worker。前端原有接口路径基本保持不变，但生成类接口会额外返回全局 `taskId`，并新增统一任务 Socket、快照和取消接口。

前端目标：

- 不再依赖频繁逐任务轮询作为唯一状态来源。
- 页面进入、重连、休眠恢复时用快照校准。
- 任务状态以后以英文 `status` 为准，中文 `state` 仅用于兼容展示。
- 后端是任务状态唯一事实来源，关闭弹窗或页面不代表取消任务。

---

## 统一状态

```ts
type TaskStatus =
  | "pending"
  | "queued"
  | "submitting"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";
```

兼容中文：

| status | 兼容 state |
| --- | --- |
| pending | 未生成 |
| queued | 排队中 |
| submitting | 提交中 |
| processing | 生成中 / 进行中 |
| completed | 已完成 |
| failed | 生成失败 |
| cancelled | 已取消 |

前端判断逻辑建议：

```ts
const active = ["queued", "submitting", "processing"].includes(task.status);
const terminal = ["completed", "failed", "cancelled"].includes(task.status);
```

---

## 新增 Socket

命名空间：

```text
/api/socket/task
```

认证：

```ts
io("/api/socket/task", {
  auth: { token }
});
```

事件：

```text
task:status
```

事件结构：

```ts
interface TaskStatusEvent {
  eventId: number;
  taskId: string;
  legacyTaskId?: number;
  version: number;
  taskType: "image" | "asset" | "storyboard" | "video" | "prompt" | "audio" | "media";
  projectId: number;
  scriptId?: number;
  targetType?: string;
  targetId?: number | string;
  nodeId?: string;
  status: TaskStatus;
  phase?: string;
  progress?: number;
  result?: {
    url?: string;
    historyId?: number;
    businessId?: number;
    [key: string]: unknown;
  };
  reason?: string;
  updatedAt: number;
}
```

幂等处理：

```ts
const key = event.taskId;
if ((lastVersion[key] ?? 0) >= event.version) return;
lastVersion[key] = event.version;
```

---

## 新增快照接口

```text
POST /api/task/status/snapshot
```

请求：

```ts
{
  projectId: number;
  scriptId?: number;
  taskIds?: string[];
}
```

响应：

```ts
{
  code: 200;
  data: {
    serverTime: number;
    tasks: TaskStatusEvent[];
  };
  message: string;
}
```

使用场景：

- 页面首次进入。
- Socket 重连后。
- Electron 从休眠恢复。
- 前端发现任务状态缺失时。

建议：不要再为每个任务单独请求状态，统一批量快照。

---

## 新增取消接口

```text
POST /api/task/cancel
```

请求：

```ts
{ taskId: string }
```

成功响应：

```ts
{
  code: 200;
  data: {
    taskId: string;
    legacyTaskId: number;
    status: "cancelled";
    state: "已取消";
  };
  message: string;
}
```

限制：

- 只允许取消本地未执行任务。
- 已进入供应商提交、确认、生成阶段的任务会返回 HTTP `409`。
- 即梦当前没有官方取消能力，所以不能取消已提交官方的任务。

前端交互建议：

- `queued` 可以显示“取消排队”。
- `submitting/processing` 不显示取消按钮，或点击后提示“已提交供应商，无法安全取消”。

---

## 新增诊断接口

```text
POST /api/diagnostics/runtime/status
```

响应包含：

- API / Worker / Agent PID。
- event-loop delay。
- CPU、内存。
- 慢 SQL、事务、`SQLITE_BUSY` 统计。
- 活动 Dreamina CLI 子进程。

建议只在调试面板或开发模式展示，不放普通用户主流程。

---

## 现有生成接口响应扩展

### 视频生成

```text
POST /api/production/workbench/generateVideo
```

旧字段保留，新响应增加：

```ts
{
  data: {
    videoId: number;
    taskId: string;
    queueTaskId: number;
  }
}
```

### 批量视频生成

```text
POST /api/production/workbench/batchGenerateVideo
```

每项增加：

```ts
{
  videoId: number;
  trackId: number;
  taskId: string;
  queueTaskId: number;
}
```

### 图片画布异步生成

```text
POST /api/production/editImage/generateFlowImageTask
```

旧字段保留，额外增加：

```ts
{
  data: {
    taskId: number;        // 旧数字任务 ID，兼容 pollImageTask
    unifiedTaskId: string; // 新全局任务 ID，用于 task socket/snapshot/cancel
    state: "生成中";
    status: "queued" | "processing";
  }
}
```

建议前端保存：

```ts
node.data.taskId = data.taskId;          // 兼容旧轮询
node.data.unifiedTaskId = data.unifiedTaskId; // 新任务中心
node.data.status = data.status;
```

### 资产图片生成

```text
POST /api/assetsGenerate/generateAssets
POST /api/assetsGenerate/batchGenerateImageAssets
```

现在接口只入队，不在请求内等待图片生成。返回包含：

```ts
{
  assetId?: number;
  assetsId?: number;
  imageId: number;
  taskId: string;
  legacyTaskId: number;
  status: "queued";
  state: "排队中";
}
```

### 资产提示词润色

```text
POST /api/assetsGenerate/batchPolishAssetsPrompt
```

返回：

```ts
{
  total: number;
  tasks: Array<{
    assetId: number;
    taskId: string;
    legacyTaskId: number;
  }>;
}
```

### 分镜批量生图

```text
POST /api/production/storyboard/batchGenerateImage
```

返回的分镜项会带：

```ts
{
  id: number;
  state: string;
  taskId?: string;
}
```

### 小说事件提取

```text
POST /api/novel/event/generateEvents
```

现在返回任务列表：

```ts
{
  total: number;
  tasks: Array<{
    novelId: number;
    taskId: string;
    legacyTaskId: number;
  }>;
}
```

### 角色音色匹配

```text
POST /api/cornerScape/batchBindAudio
```

现在返回任务列表：

```ts
{
  total: number;
  tasks: Array<{
    assetId: number;
    taskId: string;
    legacyTaskId: number;
  }>;
}
```

---

## 旧轮询接口兼容

以下接口暂时保留：

- `checkVideoStateList`
- `pollImageTask`
- 各资产/分镜旧 polling 接口

但建议前端新增统一任务协调器：

1. 生成接口返回 `taskId` 后写入本地任务表。
2. Socket 接收 `task:status` 更新局部 UI。
3. 页面进入或重连时调用 `/task/status/snapshot`。
4. 旧轮询只作为兼容 fallback。

---

## 缩略图行为变化

现在后端不再在请求线程即时生成缺失缩略图。

当访问：

```text
/oss/xxx.jpg?size=20
```

如果缩略图已存在：返回缩略图。

如果缩略图不存在：本次先返回原图，并将缩略图生成任务入队到 Worker。下一次访问会命中缩略图。

前端无需改接口，但预览组件要接受“第一次可能是原图”的情况。

---

## 推荐前端任务协调器

建议维护一个全局 store：

```ts
interface TaskStoreItem extends TaskStatusEvent {
  source: "socket" | "snapshot" | "submit";
}
```

基础流程：

```ts
submitGenerate()
  -> 保存 taskId
  -> UI 显示 queued
  -> Socket task:status 增量更新
  -> 页面重进 snapshot 校准
```

Socket 断线：

```ts
onReconnect(() => {
  snapshot({ projectId, scriptId, taskIds: knownTaskIds });
});
```

任务终态：

```ts
if (event.status === "completed") {
  // 使用 event.result.media 或调用现有数据刷新接口
}
if (event.status === "failed") {
  // 展示 event.reason
}
```

---

## 联调验收点

1. 启动应用后不再因为后台任务导致窗口无响应。
2. 批量提交资产图、分镜图、视频后，生成接口能立即返回。
3. 任务状态通过 `/api/socket/task` 实时更新。
4. 刷新页面后，`/api/task/status/snapshot` 能恢复活动任务。
5. 本地排队任务可取消，已提交供应商任务返回 409。
6. `checkVideoStateList` 等旧接口仍能工作。
7. 缺失缩略图首次返回原图，不阻塞列表滚动。
8. 诊断接口可看到 API / Worker / Agent 的独立 PID。
