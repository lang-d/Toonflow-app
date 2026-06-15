# Toonflow 前端 API 迁移对接文档

## 1. 全局响应约定

所有 `/api/*` 接口统一返回：

```ts
interface ApiResponse<T> {
  code: number;
  data: T | null;
  message: string;
}
```

- HTTP 状态码与 `code` 一致。
- 成功通常为 `200`。
- 参数校验失败为 `400`，详情位于 `data.issues`。
- 前端 Axios 拦截器已经返回 `response.data`，因此页面代码中的 `const { data } = await axios.post(...)` 仍得到业务数据。

校验错误：

```ts
{
  code: 400;
  data: {
    issues: Array<{
      path: string;
      message: string;
      code: string;
    }>;
  };
  message: "参数错误";
}
```

## 2. 任务状态

新增机器字段：

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

兼容期内仍返回中文 `state`。前端业务判断应改用 `status`，中文 `state` 只用于旧页面展示。

| status | 旧 state |
| --- | --- |
| `pending` | `未生成` |
| `queued` | `排队中` |
| `submitting` | `提交中` |
| `processing` | `生成中` / `进行中` |
| `completed` | `已完成` |
| `failed` | `生成失败` |
| `cancelled` | `已取消` |

## 3. 图片画布标准调用

### 3.1 保存或更新画布

唯一接口：

```text
POST /production/editImage/saveImageFlow
```

```ts
interface SaveImageFlowRequest {
  flowId?: number | null;
  projectId: number;
  scriptId: number;
  targetType: "deriveAsset" | "storyboard";
  targetId: number;
  nodes: unknown[];
  edges: unknown[];
  selectedMediaPath?: string;
}

interface SaveImageFlowResponse {
  flowId: number;
  id: number; // 兼容一版，值与 flowId 相同
}
```

前端打开编辑器后，应尽早调用此接口取得 `flowId`。后续每次保存都继续调用同一接口，不再区分新增和更新。

当 `selectedMediaPath` 非空时，后端在同一事务中更新画布和目标资产/分镜最终图片；为空时只绑定 `flowId`，不会清空已有图片。

### 3.2 创建异步生成任务

```text
POST /production/editImage/generateFlowImageTask
```

```ts
interface GenerateFlowImageTaskRequest {
  projectId: number;
  scriptId: number;
  flowId: number;
  nodeId: string;
  targetType: "deriveAsset" | "storyboard";
  targetId: number;
  referenceMediaPaths: string[];
  model: `${string}:${string}`;
  quality: "1K" | "2K" | "4K";
  ratio: `${number}:${number}`;
  prompt: string;
}

interface GenerateFlowImageTaskResponse {
  taskId: number;
  nodeId: string;
  flowId: number;
  status: "processing";
  state: "生成中";
  legacy: false;
}
```

后端会在创建、完成和失败时直接更新对应 flow 节点。多个生成节点必须传各自真实的 Vue Flow `node.id`，禁止使用资产 ID 代替。

当前缺少 `flowId/nodeId/targetType/targetId` 的请求仍可提交，但只进入 legacy 分支，无法保证页面关闭后恢复到原节点。

### 3.3 轮询单个任务

```text
POST /production/editImage/pollImageTask
```

请求：

```ts
{ taskId: number }
```

响应：

```ts
interface PollImageTaskResponse {
  taskId: number;
  nodeId: string;
  status: "processing" | "completed" | "failed";
  state: "生成中" | "已完成" | "生成失败";
  media?: MediaRef;
  historyId?: number;
  reason?: string;
}
```

旧 `{ taskIds: number[] }` 暂时保留，下一版删除。

### 3.4 查询目标历史

```text
POST /production/editImage/getImageHistory
```

```ts
interface GetImageHistoryRequest {
  projectId: number;
  scriptId: number;
  targetType: "deriveAsset" | "storyboard";
  targetId: number;
}
```

历史严格按 `targetType + targetId` 隔离，返回时间倒序结果。衍生资产不再使用专用历史接口。

### 3.5 推荐调用顺序

1. 打开编辑器，使用已有 `flowId` 调用 `getImageFlow`；无 `flowId` 时创建本地空画布。
2. 调用 `saveImageFlow`，传完整目标信息，保存返回的 `flowId`。
3. 用户点击生成时，把真实 `nodeId` 和 `flowId` 传给 `generateFlowImageTask`。
4. 使用单个 `taskId` 调用 `pollImageTask`，业务判断只看 `status`。
5. 用户选定最终结果后，再调用 `saveImageFlow`，同时传 `selectedMediaPath`。
6. 重新打开编辑器时，后端保存的节点包含 `taskId/status/reason/historyId`，可直接恢复轮询。

## 4. 兼容接口迁移

| 旧接口 | 新接口 | 处理 |
| --- | --- | --- |
| `/production/editImage/updateImageFlow` | `/production/editImage/saveImageFlow` | 改为 upsert |
| `/production/editImage/generateFlowImage` | `/production/editImage/generateFlowImageTask` | 同步接口已弃用 |
| `/production/editImage/getAssetImageHistory` | `/production/editImage/getImageHistory` | 使用统一目标字段 |
| `/production/assets/updateAssetsUrl` | `/production/editImage/saveImageFlow` | 传 `targetType: "deriveAsset"` |
| `/production/storyboard/updateStoryboardUrl` | `/production/editImage/saveImageFlow` | 传 `targetType: "storyboard"` |
| `/assets/polishAssetsPrompt` | `/assetsGenerate/polishAssetsPrompt` | 旧路径保留一版 |
| `/assets/generateAssets` | `/assetsGenerate/generateAssets` | 旧路径保留一版 |

`generateAssets` 的 `model/resolution` 现在可省略，后端会读取项目的 `imageModel/imageQuality`；新前端仍建议显式传值，便于用户确认实际模型和费用。

## 5. 前端待删除或替换

以下调用没有新增后端实现：

| 旧调用 | 处理 |
| --- | --- |
| `/video/getVideo` | 改用 `/production/workbench/getVideoList` |
| `/video/generateVideo` | 改用 `/production/workbench/generateVideo` |
| `/video/getVideoConfigs` | 删除旧 store 调用 |
| `/video/deleteVideoConfig` | 删除旧 store 调用 |
| `/production/workbench/videoPolling` | 改用 `/production/workbench/checkVideoStateList` |
| `/project/getSingleProject` | 改用 `/general/getSingleProject` |
| `/setting/skillManagement/scanSkills` | 删除遗留调用 |

Dreamina 的 `/setting/dreamina/${action}` 是受控动态路径，保留现有前端封装。

## 6. 联调验收

1. 新建画布返回 `flowId`，更新仍返回同一个 `flowId`。
2. 保存最终图片时，目标卡片和画布在一次请求后同时更新。
3. 同一画布两个生成节点同时提交，`taskId/status/result` 不串节点。
4. 生成中关闭编辑器，再打开后能从节点恢复轮询。
5. 轮询成功返回 `status=completed`、`url` 和 `historyId`。
6. 失败返回 `status=failed` 和明确 `reason`。
7. 衍生资产与分镜历史互不混入。
8. 参数错误读取 `message`，字段详情读取 `data.issues`。

完整静态契约清单位于 `docs/api-contract-inventory.json`，后端联调前运行：

```bash
yarn api:check
```
