# Toonflow Web 即梦视频模型设置与队列状态对接文档

## 1. 对接目标

前端需要完成两项调整：

1. 为即梦视频模型提供按模型版本分组的并发数和官方最长工作时间设置。
2. 使用新的持久化视频队列接口展示本地等待、官方确认、官方处理中、容量阻塞和官方排队位置。

后端接口已经实现。本次前端不需要修改视频生成、批量生成和视频状态查询接口。

## 2. Axios 响应约定

当前前端 Axios 响应拦截器已经返回后端响应体：

```ts
{
  code: number;
  data: T;
  message: string;
}
```

因此：

```ts
const { data } = await axios.post("/setting/dreamina/queueStatus");
```

这里的 `data` 已经是接口业务数据，不需要再读取 `data.data`。

## 3. 当前前端问题

### 3.1 队列响应仍按旧数组解析

以下页面仍使用：

```ts
Array.isArray(data) ? data : []
```

涉及文件：

```text
src/components/setting/components/DreaminaCliPanel.vue
src/views/task/index.vue
```

后端现在返回：

```ts
{
  summary: DreaminaQueueSummary[];
  tasks: DreaminaQueueTask[];
}
```

所以旧判断会把有效结果清空。

### 3.2 即梦模型编辑入口被隐藏

`vendorConfig.vue` 当前对即梦供应商隐藏编辑按钮：

```vue
v-if="!isDreaminaVendor"
```

同时 `VideoModel`、`modelFormData` 和提交对象均没有 `queueConfig`，因此用户无法修改并发数。

### 3.3 使用了旧的 `status.queue`

`POST /setting/dreamina/status` 返回的 `queue` 是旧的 CLI 进程内队列状态，不是当前持久化视频生成队列。

视频任务页面和即梦设置页面均应以：

```text
POST /setting/dreamina/queueStatus
```

作为唯一队列状态来源。

## 4. 队列状态接口

### 请求

```text
POST /setting/dreamina/queueStatus
```

无请求参数：

```ts
{}
```

### TypeScript 类型

```ts
interface DreaminaQueueSummary {
  providerModelKey: string;
  configuredConcurrent: number;
  maxWorkHours: number;
  knownActive: number;
  occupiedSlots: number;
  submitting: number;
  confirming: number;
  processing: number;
  waiting: number;
  total: number;
  capacityBlocked: boolean;
  blockedUntil?: number;
  queueIndex?: number;
  queueLength?: number;
  lastProviderCode?: string;
}

type VideoQueueStatus =
  | "queued"
  | "submitting"
  | "confirming"
  | "processing";

interface DreaminaQueueTask {
  id: number;
  videoId: number;
  model: string;
  providerModelKey: string;
  providerAccountId?: string | null;
  providerSubmittedAt?: number | null;
  providerWorkElapsedSec: number;
  submitId?: string | null;
  phase: string;
  status: VideoQueueStatus;
  state: "排队中" | "提交中" | "生成中";
  nextSubmitTime?: number | null;
  nextPollTime?: number | null;
  pollCount?: number | null;
  providerQueueStatus?: number | null;
  providerQueueIndex?: number | null;
  providerQueueLength?: number | null;
  startTime: number;
  updateTime: number;
}

interface DreaminaQueueStatusData {
  summary: DreaminaQueueSummary[];
  tasks: DreaminaQueueTask[];
}
```

### 调用示例

```ts
const dreaminaQueueSummary = ref<DreaminaQueueSummary[]>([]);
const dreaminaQueueTasks = ref<DreaminaQueueTask[]>([]);

async function fetchDreaminaQueueStatus() {
  try {
    const { data } = await axios.post<DreaminaQueueStatusData>(
      "/setting/dreamina/queueStatus",
    );

    dreaminaQueueSummary.value = Array.isArray(data?.summary)
      ? data.summary
      : [];
    dreaminaQueueTasks.value = Array.isArray(data?.tasks)
      ? data.tasks
      : [];
  } catch {
    dreaminaQueueSummary.value = [];
    dreaminaQueueTasks.value = [];
  }
}
```

### 字段含义

| 字段 | 含义 |
| --- | --- |
| `configuredConcurrent` | 用户为该模型版本配置的最大官方活动任务数 |
| `maxWorkHours` | 从首次取得官方 `submitId` 起计算的最长官方工作时间 |
| `knownActive` | 已确认存在于即梦官方的活动任务数，当前等于 `processing` |
| `occupiedSlots` | Toonflow 已占用的模型槽位数，等于 `submitting + confirming + processing` |
| `submitting` | 正在执行 CLI 提交命令的任务数 |
| `confirming` | 已取得 `submitId`，等待官方记录可查询的任务数 |
| `processing` | 官方已经确认、正在排队或生成的任务数 |
| `waiting` | Toonflow 本地排队、提交中或容量等待任务数 |
| `capacityBlocked` | 最近提交遇到官方并发限制，正在等待再次探测 |
| `blockedUntil` | 下次允许容量探测的时间戳 |
| `queueIndex` | 即梦官方队列位置 |
| `queueLength` | 即梦官方队列总长度 |
| `lastProviderCode` | 最近供应商返回码，仅用于诊断 |
| `providerSubmittedAt` | 首次取得官方 `submitId` 的时间戳，本地排队阶段为空 |
| `providerWorkElapsedSec` | 已消耗的官方工作秒数，本地排队阶段为 0 |

注意：

- `queueIndex/queueLength` 是即梦官方队列，不是 Toonflow 本地队列。
- `lastProviderCode = "1310"` 不代表当前任务失败。应结合 `capacityBlocked` 判断当前是否仍处于容量阻塞。
- `summary/tasks` 为空表示当前没有活动任务，是正常结果。
- 本地 `queued/capacity_wait` 不受 `maxWorkHours` 限制，可以一直等待，直到获得提交机会或用户取消。

### 取消本地排队

```text
POST /production/workbench/cancelVideoGenerationTask
```

请求：

```ts
{ taskId: number }
```

成功响应：

```ts
{
  taskId: number;
  videoId: number;
  status: "cancelled";
  state: "已取消";
}
```

只有本地 `queued/capacity_wait`、尚无 `submitId` 的任务可以显示取消按钮。接口返回 HTTP `409` 表示调度器已经抢占任务，或任务可能已经提交官方；前端应刷新队列状态，不要自动重试取消。视频状态查询会返回“已取消”，活动队列接口不会继续返回该任务。
- 接口只返回活动任务，不返回已完成和已失败历史。

### 官方队列状态

```ts
function getProviderQueueLabel(status?: number | null) {
  if (status === 1) return "官方排队中";
  if (status === 2) return "官方生成中";
  if (status === 3) return "结果处理中";
  return "等待官方状态";
}
```

## 5. 任务中心页面调整

删除旧类型：

```ts
interface DreaminaQueueItem {
  key: string;
  running: number;
  waiting: number;
  limit: number;
}
```

改用 `DreaminaQueueSummary`。

汇总示例：

```ts
const dreaminaQueueStats = computed(() =>
  dreaminaQueueSummary.value.reduce(
    (result, item) => {
      result.active += item.knownActive;
      result.confirming += item.confirming;
      result.waiting += item.waiting;
      result.blocked += item.capacityBlocked ? 1 : 0;
      return result;
    },
    {
      active: 0,
      confirming: 0,
      waiting: 0,
      blocked: 0,
    },
  ),
);
```

建议顶部展示：

```text
即梦队列：官方活动 1 / 确认中 0 / 本地等待 3
```

若存在 `capacityBlocked`：

```text
部分模型容量已满，任务将在后台自动等待
```

任务详情可展示：

```text
Seedance 2.0
状态：官方排队中
官方队列：4151 / 304244
已轮询：53 次
```

不要向用户展示“预计完成时间”，即梦当前没有提供可靠 ETA。

### 刷新策略

- 页面进入时立即查询。
- 用户点击任务列表刷新时查询。
- 页面可见期间每 15-30 秒查询一次。
- 页面隐藏或离开时停止定时器。
- 不需要跟随即梦后端的 60/120 秒供应商轮询频率。

## 6. 即梦设置页面调整

`DreaminaCliPanel.vue` 的“队列状态”按钮应直接展示：

```ts
data.summary
data.tasks
```

不能继续写入旧的：

```ts
status.queue
```

建议将安装登录状态与视频生成队列状态拆成两个独立状态对象：

```ts
const status = ref<DreaminaStatus | null>(null);
const queueStatus = ref<DreaminaQueueStatusData>({
  summary: [],
  tasks: [],
});
```

## 7. 视频模型队列设置

### 模型列表来源

```text
POST /setting/vendorConfig/getVendorList
```

从返回列表中获取：

```ts
const dreaminaVendor = vendors.find((item) => item.id === "dreamina");
const videoModels = dreaminaVendor?.models.filter(
  (item) => item.type === "video",
);
```

视频模型类型需要增加：

```ts
interface QueueConfig {
  maxConcurrent?: number;
  pollInitialDelaySec?: number;
  pollMinIntervalSec?: number;
  pollMaxIntervalSec?: number;
  maxWorkHours?: number;
  maxWaitHours?: number; // 旧字段兼容一版，前端不要再保存
}

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: unknown[];
  audio: "optional" | boolean;
  durationResolutionMap: {
    duration: number[];
    resolution: string[];
  }[];
  queueConfig?: QueueConfig;
}
```

### 首版需要开放的设置

建议只开放：

```ts
{
  maxConcurrent: number; // 1-20，Dreamina 默认 1
  maxWorkHours: number;  // 1-72，默认 6，从取得官方 submit_id 起计算
}
```

`pollInitialDelaySec/pollMinIntervalSec/pollMaxIntervalSec` 暂不建议在 UI 展示。Dreamina 当前使用后端固定自适应策略：

- 确认任务：60 秒。
- 官方排队：120 秒。
- 官方生成：60 秒。
- 容量等待：90 秒加随机抖动。

### 模型版本分组

同版本的文生视频、图生视频、多帧视频和多模态视频共享一个槽位。

前端设置页只应显示四个模型组：

```text
dreamina:seedance2.0
dreamina:seedance2.0fast
dreamina:seedance2.0_vip
dreamina:seedance2.0fast_vip
```

可使用：

```ts
function getDreaminaProviderModelKey(modelName: string) {
  const version = modelName.split(":").at(-1)?.trim().toLowerCase() || "default";
  const aliases: Record<string, string> = {
    "seedance2.0-fast": "seedance2.0fast",
    "seedance2.0_fast": "seedance2.0fast",
    "seedance2.0-fast-vip": "seedance2.0fast_vip",
    "seedance2.0-fast_vip": "seedance2.0fast_vip",
    "seedance2.0_fast_vip": "seedance2.0fast_vip",
    "seedance2.0fastvip": "seedance2.0fast_vip",
    "seedance2.0-vip": "seedance2.0_vip",
    "seedance2.0vip": "seedance2.0_vip",
  };
  return `dreamina:${aliases[version] || version}`;
}
```

按该键分组，每组选择任意一个模型作为保存代表。

### 保存接口

```text
POST /setting/vendorConfig/upVendorModel
```

请求必须携带完整模型对象：

```ts
const representative = group.models[0];

await axios.post("/setting/vendorConfig/upVendorModel", {
  id: "dreamina",
  modelName: representative.modelName,
  model: {
    ...representative,
    queueConfig: {
      ...(representative.queueConfig || {}),
      maxConcurrent: form.maxConcurrent,
      maxWorkHours: form.maxWorkHours,
    },
  },
});
```

后端会把 `queueConfig` 自动同步到相同 `providerModelKey` 的全部视频命令模型。

保存成功后重新调用：

```text
POST /setting/vendorConfig/getVendorList
POST /setting/dreamina/queueStatus
```

不要直接修改前端内存模型后假定已保存。

### 刷新模型后的配置

调用：

```text
POST /setting/dreamina/refreshModels
```

后端会按照 `providerModelKey` 保留已有 `queueConfig`，不会因为刷新 CLI 模型列表而重置用户并发设置。

## 8. 推荐交互

即梦模型卡片仍不开放模型名称、模型 ID、命令模式、分辨率等元数据编辑，避免破坏 CLI 动态发现结果。

在“即梦官方 CLI”面板增加独立的“视频队列设置”区域：

```text
Seedance 2.0
并发任务数       [1]
官方最长工作时间 [6] 小时

Seedance 2.0 Fast
并发任务数       [1]
官方最长工作时间 [6] 小时
```

每个模型组提供保存按钮，或统一提供一个“保存队列设置”按钮逐组提交。

若模型组当前有活动任务，修改并发数只影响后续调度，不中断已经提交的官方任务。

## 9. 状态显示建议

| 后端状态 | 前端文案 |
| --- | --- |
| `queued` | 本地排队中 |
| `submitting` | 正在提交 |
| `confirming` | 正在确认官方任务 |
| `processing` + `providerQueueStatus=1` | 即梦排队中 |
| `processing` + `providerQueueStatus=2` | 即梦生成中 |
| `processing` + 无官方状态 | 已提交，等待即梦状态 |
| `capacityBlocked=true` | 模型容量已满，等待自动重试 |

`ret=1310/ExceedConcurrencyLimit` 不是失败，不应显示红色错误。

## 10. 联调验收

1. 设置页能看到四个 Seedance 2.0 模型版本的队列配置。
2. 修改 `seedance2.0` 并发数后，同版本所有视频命令模型的 `queueConfig.maxConcurrent` 一致。
3. 刷新即梦模型后，并发配置不会恢复默认值。
4. `/queueStatus` 返回 `summary/tasks` 时，设置页和任务中心不再显示空队列。
5. `processing=1` 时显示一个官方活动任务。
6. `queueIndex/queueLength` 能显示即梦官方排队位置。
7. `capacityBlocked=true` 时显示等待提示，不显示生成失败。
8. 接口返回空数组时页面正常显示“暂无活动任务”。
9. 离开任务页面后停止状态轮询。
10. 前端不再读取 `/setting/dreamina/status` 中的旧 `queue` 字段。
