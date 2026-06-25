# 生产页衍生资产统一画布生图前端对接

## 目标

生产页衍生资产的卡片生成和 Agent 批量生成统一调用后端画布任务。前端不再调用
`/assetsGenerate/batchGenerateImageAssets` 生成衍生资产，也不再把画布空 prompt 写回
`o_assets.prompt`。

基础资产页面和分镜页面保持原有接口不变。

## 批量生成接口

```http
POST /api/production/assets/batchGenerateAssetsImage
```

请求：

```json
{
  "projectId": 1781970050416,
  "scriptId": 27,
  "assetIds": [1001, 1002],
  "model": "vendor:model",
  "quality": "2K",
  "ratio": "16:9",
  "concurrentCount": 3
}
```

- `scriptId` 仅表示本次任务的发起剧集，用于任务中心、日志和输出目录。
- 衍生资产及其画布是项目级共享实体，不要求画布最初的 `scriptId` 与本次相同。
- 后端会校验 `scriptId` 属于 `projectId`，以及衍生资产和父资产属于该项目。
- `ratio` 保持兼容传参；生产页衍生资产外部批量生成的实际比例以后端返回的
  `tasks[].ratio` 为准。
- 如果衍生资产已有画布主生成节点且节点 `ratio` 非空，后端会使用该节点比例。
- 如果没有画布、没有生成节点或节点 `ratio` 为空，后端默认使用 `16:9`。

返回：

```json
{
  "total": 2,
  "successCount": 1,
  "failedCount": 1,
  "tasks": [
    {
      "assetId": 1001,
      "taskId": 301,
      "unifiedTaskId": "task-uuid",
      "legacyTaskId": 301,
      "flowId": 88,
      "nodeId": "generated-node-id",
      "status": "processing",
      "state": "生成中",
      "prompt": "本次实际使用的提示词",
      "model": "vendor:model",
      "quality": "2K",
      "ratio": "16:9"
    }
  ],
  "errors": [
    {
      "assetId": 1002,
      "error": "请先填写生图提示语"
    }
  ]
}
```

- `tasks` 只包含真实创建成功、可注册 taskCenter 的任务，保持旧语义。
- `errors` 只包含任务创建失败的资产，不要注册 taskCenter。
- 前端应保存每个成功项的 `flowId`、`nodeId`、`unifiedTaskId` 和 `prompt`。
- 对 `errors` 中的资产恢复卡片状态，并把 `error` 写入 `errorReason` 供卡片 tooltip 或消息提示展示。
- 任务中心建议使用 `flowImage` 域，并以 `projectId + assetId + nodeId + unifiedTaskId` 作为任务键。

请求结构非法仍会返回 400。单个资产的业务失败，例如缺 prompt、资产不属于项目、画布绑定异常，不会阻断其他资产；
接口会返回 200，并把失败项放入 `errors`。

## prompt 与画布规则

- 后端优先使用画布主生成节点的非空 prompt。
- 主节点为空时，使用 `o_assets.prompt` 初始化节点。
- 两者均为空时，接口返回“请先填写生图提示语”。
- 画布主生成节点的非空 `ratio` 是衍生资产当前执行比例；外部卡片和 Agent 批量生成都会跟随它。
- 新建衍生资产画布或主生成节点时，默认 `ratio` 为 `16:9`。
- 前端不要用项目 `videoRatio` 初始化衍生资产生成节点比例；分镜节点仍继续使用项目比例。
- 多个生成节点没有主节点时，后端选择最后一个生成节点并标记为主节点。
- 没有画布时，后端自动创建父资产参考节点、主生成节点和连线。

生产页加载数据时，`/api/production/getFlowData` 返回的衍生资产 `prompt` 已是有效执行
prompt：主节点优先，资产默认 prompt 兜底；同时可能返回 `nodeId`。

## 需要移除的旧前端行为

1. 生产页衍生资产卡片和 Agent `generateDeriveAsset` 不再调用：

   ```text
   /api/assetsGenerate/batchGenerateImageAssets
   ```

2. 卡片生成前不要调用 `/api/assets/updateAssets` 持久化 `row.prompt`。
3. 画布保存回调不要把 `prompt: ""` 写入 `/api/assets/updateAssets`。
4. Agent `addDeriveAsset` Socket 回调需要同步：

   ```text
   name, describe, prompt, promptMode, flowId, nodeId
   ```

5. Agent `generateDeriveAsset` Socket 回调必须返回后端批量接口的完整结果：

   ```ts
   {
     success: true,
     message: {
       total,
       tasks,
       successCount,
       failedCount,
       errors,
     },
   }
   ```

   不能只因为 socket 事件已触发就返回“已启动”。如果提交接口整体失败，返回
   `{ success: false, message: errorMessage }`。

## Agent promptMode

Agent 的 `add_deriveAsset` 工具增加：

```ts
promptMode?: "preserve" | "replace"
```

- `preserve` 为默认值：更新资产默认 prompt；画布主节点为空时才同步。
- `replace`：更新资产默认 prompt，并覆盖共享画布主节点 prompt。

用户明确要求重新写入、修正、重做或覆盖提示词时，Agent 使用 `replace`。

## 任务完成

后端任务成功后会在同一事务中：

- 更新对应 `flowId + nodeId` 的节点结果和实际 prompt。
- 新增 `o_image` 历史记录。
- 更新 `o_assets.flowId/imageId`。
- 更新画布 `selectedImageUrl`。

前端收到任务完成事件后，使用返回的 `media` 更新卡片预览即可；重新打开画布会读取到相同结果。
失败任务不会替换资产此前的成功图片。

## 前端比例口径

- 生产页衍生资产新建生成节点：默认显示 `16:9`。
- 用户在画布节点手动改为 `1:1`、`9:16` 等比例后，后端会保存并在后续外部生成时继续使用。
- 外部卡片和 Agent 批量生成没有独立比例选择，不应把项目 `videoRatio` 当成衍生资产最终比例。
- 注册任务中心和更新卡片状态时，以批量接口返回的 `tasks[].ratio` 为准。
- 分镜画布、分镜生图和项目视频比例逻辑不变。
