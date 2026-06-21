# 前端对接文档：生产资产批量生图统一任务接口

## 1. 对接目标

生产 Agent 的衍生资产批量生图不再调用旧接口：

```text
POST /api/production/assets/batchGenerateAssetsImage
```

统一改为：

```text
POST /api/assetsGenerate/batchGenerateImageAssets
```

新接口只负责创建统一后台任务，不会同步返回最终图片。前端需要保存接口返回的 `taskId`，继续通过现有任务快照机制更新生成结果。

本次只调整资产批量生图。分镜生图继续使用原有独立接口，不要混用资产接口。

## 2. 资产批量生图

### 请求

```ts
interface BatchGenerateImageAssetsRequest {
  projectId: number;
  model: string;
  resolution: "1K" | "2K" | "4K";
  concurrentCount?: number;
  items: Array<{
    id: number;
    type: "role" | "scene" | "tool";
    name: string;
    prompt: string;
    base64?: string | null;
  }>;
}
```

字段说明：

- `projectId`：当前项目 ID，必须是 number。
- `model`：项目当前图片模型，即 `project.imageModel`。
- `resolution`：项目当前图片质量，即 `project.imageQuality`。
- `items`：从当前 session 的 `assets[].derive[]` 中按选中 ID 收集。
- `base64`：可选参考图；没有时不要传。
- `concurrentCount`：可以继续传用于兼容，但实际并发由后端统一任务 worker 控制，前端不要依赖它判断执行进度。

只允许以下资产类型：

```text
role
scene
tool
```

如果前端历史数据仍使用 `props`，提交前必须转换为 `tool`。`clip`、`storyboard` 和其它类型不得提交到资产生图接口。

禁止传 `storyboard`。后端会返回 HTTP 400，并提示改用分镜生图接口。

### 响应

原始 HTTP 响应：

```ts
interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

interface BatchGenerateImageAssetsResult {
  total: number;
  tasks: Array<{
    assetId: number;
    imageId: number;
    taskId: string;
    legacyTaskId: number;
  }>;
}
```

如果项目 axios 封装已经自动解包 `data`，按现有调用约定读取即可。

响应不包含最终图片 `src`。

## 3. 前端调用改造

当前调用位置：

```text
Toonflow-web/src/stores/productionAgent.ts
```

删除旧调用：

```ts
axios.post("/production/assets/batchGenerateAssetsImage", {
  assetIds,
  projectId,
  scriptId,
  concurrentCount,
});
```

改为：

```ts
const normalizeAssetType = (type?: string) => {
  if (type === "props") return "tool";
  return type;
};

const selectedDeriveAssets = session.assets
  .flatMap((asset) => asset.derive ?? [])
  .filter((asset) => allIds.includes(asset.id))
  .map((asset) => ({
    ...asset,
    type: normalizeAssetType(asset.type),
  }))
  .filter((asset) => ["role", "scene", "tool"].includes(asset.type ?? ""));

const items = selectedDeriveAssets.map((asset) => ({
  id: asset.id,
  type: asset.type,
  name: asset.name ?? "",
  prompt: asset.prompt ?? "",
  base64: asset.base64 ?? undefined,
}));

const { data } = await axios.post(
  "/assetsGenerate/batchGenerateImageAssets",
  {
    projectId: Number(project.id),
    model: project.imageModel,
    resolution: project.imageQuality,
    concurrentCount,
    items,
  },
);

const result = data?.tasks ? data : data?.data;

for (const task of result?.tasks ?? []) {
  const derive = findDeriveAssetById(task.assetId);
  if (!derive) continue;

  derive.taskId = task.taskId;
  derive.legacyTaskId = task.legacyTaskId;
  derive.imageId = task.imageId;
  // 沿用前端现有的“排队中/生成中”状态常量，不新增状态字面量。
}

syncAssetTasks(session);
```

提交前：

- 清理选中资产已有的过期任务绑定。
- 将选中资产设置为现有“排队中”或“生成中”状态。
- 将遗留类型 `props` 转换为 `tool`，过滤 `clip/storyboard`。
- 空 `prompt` 的处理保持当前前端规则。
- 如果过滤后 `items` 为空，不发送请求。

提交后：

- 使用 `assetId` 将任务绑定到对应 derive 资产。
- 保存 `taskId`；`legacyTaskId` 和 `imageId` 按现有数据结构保存。
- 不等待同步 `src`。
- 不因为响应没有图片地址而标记失败。

## 4. 任务状态同步

继续使用现有统一任务快照接口：

```text
POST /api/task/status/snapshot
```

请求：

```ts
interface TaskSnapshotRequest {
  projectId: number;
  scriptId?: number;
  taskIds?: string[];
}
```

建议带上当前页面已绑定的 `taskIds`。如果不传 `taskIds`，后端默认只返回活动任务；带上后可以查询指定任务的最终状态。

响应中的任务状态：

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

前端处理规则：

- `pending/queued/submitting/processing`：保持排队或生成状态。
- `completed`：读取 `result.media`，沿用现有资产任务同步逻辑更新最终图片。
- `failed`：显示 `reason`，清理活动任务绑定。
- `cancelled`：显示取消状态，清理活动任务绑定。
- `phase=provider-processing` 只是后端正在等待供应商，不是失败，不需要新增 UI 状态。
- 前端不需要读取或保存供应商 `providerTaskId`。

## 5. Storyboard 独立链路

分镜批量生图继续使用：

```text
POST /api/production/storyboard/batchGenerateImage
```

请求结构保持不变：

```ts
interface BatchGenerateStoryboardImageRequest {
  storyboardIds: number[];
  projectId: number;
  scriptId: number;
  concurrentCount?: number;
  compulsory?: boolean;
}
```

生产 Agent 当前分镜调用不需要迁移到资产接口。

不要执行以下操作：

- 不要把分镜组装成 `type: "storyboard"` 发送给 `/assetsGenerate/batchGenerateImageAssets`。
- 不要用资产任务的 `assetId/imageId` 映射规则处理分镜。
- 不要修改现有分镜 socket、任务同步或 `storyboard-image` 业务口径。

## 6. 错误处理

旧接口现在返回：

```http
410 Gone
```

前端不要为旧接口增加兼容重试或降级逻辑。

资产接口可能返回：

```http
400 Bad Request
```

典型原因：

- `type` 为 `storyboard`。
- `type` 为遗留值 `props`，但前端未转换成 `tool`。
- `type` 不是 `role/scene/tool`。
- `projectId` 不是 number。
- 必填的模型、清晰度、名称或提示词字段缺失。

请求创建任务失败时，恢复本次选中资产的本地生成状态并显示后端 `message`。

单个后台任务后续失败时，以任务快照中的 `reason` 为准，不要把整批其它任务同时标记失败。

## 7. 供应商异步恢复对前端的影响

后端已经支持图片供应商任务的 `providerTaskId` 持久化和重启后继续轮询。

前端契约没有变化：

- 不新增请求字段。
- 不新增响应字段要求。
- 不感知供应商任务 ID。
- 不自行轮询供应商接口。
- 应用或 API 进程重启后，继续根据 Toonflow `taskId` 查询任务状态。

## 8. 验收清单

- 生产 Agent 资产批量生图不再请求旧接口。
- 请求 `items` 只包含 `role/scene/tool`；遗留 `props` 已转换为 `tool`。
- 一个资产对应一个返回的 `taskId`，且绑定关系使用 `assetId`。
- 创建任务成功后，页面保持排队/生成状态，不要求同步返回 `src`。
- 任务完成后通过快照更新图片；任务失败时只更新对应资产。
- 分镜批量生图仍请求 `/production/storyboard/batchGenerateImage`。
- API 进程重启后，前端仍使用原 Toonflow `taskId` 跟踪任务。
- 前端不保存、不显示、不查询 `providerTaskId`。
