# 塑角造景基础设定生成前端对接

## 目标

塑角造景新增“生成基础设定”能力，用来生成正式资产基础设定 `foundationText` 和图片 `prompt`。

它不是图片生成，也不是旧 AI 润色。生成成功后后端直接写回资产，但不会自动重新生成图片。

## 接口

`POST /api/assets/foundation/generate`

请求：

```ts
{
  projectId: number
  assetIds?: number[]
  type?: "role" | "scene" | "tool"
  mode?: "selected" | "missingOnly" | "all"
  instruction?: string
  overwrite?: boolean
  generatePrompt?: boolean
}
```

返回：

```ts
{
  total: number
  tasks: Array<{
    assetId: number
    taskId: string
    legacyTaskId: number
  }>
  skipped: Array<{
    assetId?: number
    reason: string
  }>
}
```

## 推荐交互

- 选中一个或多个资产后，点击“生成基础设定”。
- 弹出生成台式对话框，允许用户输入本轮指令。
- 首次生成建议传：
  ```json
  {
    "mode": "selected",
    "overwrite": false,
    "generatePrompt": true
  }
  ```
- 用户调整建议传：
  ```json
  {
    "mode": "selected",
    "instruction": "让这个角色更像普通城市妈妈，不要精英感",
    "overwrite": true,
    "generatePrompt": true
  }
  ```
- 一键补缺建议传：
  ```json
  {
    "mode": "missingOnly",
    "generatePrompt": true
  }
  ```

## 轮询

接口只创建任务，不等待模型完成。

后端内部流程是：生成基础设定和图片 Prompt -> 带完整事实源审核 -> 如审核不通过自动重写一次 -> 通过后保存。前端不需要额外调用 rewrite 接口。

当前后端生成时会使用内部中间产物 `visualDesignRationale` 做视觉设计推导，用来提升角色识别度、主角亲和度和服装色彩稳定性。该内容第一版不入库、不返回为正式字段，前端无需展示。

前端可以：

- 用 `/api/task/status/snapshot` 按 `taskIds` 轮询任务。
- 任务完成后刷新 `/api/cornerScape/getAllAssets`。

基础设定状态来自：

- `o_assets.foundationStatus`
- `o_assets.foundationErrorReason`

可能状态：

- `pending`
- `processing`
- `completed`
- `failed`

如果本次也生成图片 prompt，后端仍会同步维护旧字段：

- `promptState`
- `promptErrorReason`

失败展示建议：

```ts
const foundationFailureReason = asset.foundationErrorReason || asset.promptErrorReason || "";
```

当 `foundationStatus === "failed"` 或 `promptState === "生成失败"` 时，详情面板应展示失败原因，避免只显示“生成失败”。常见原因包括 XML 不完整、审核不通过、重写后仍不通过、AI 审核不可用。

## 字段语义

- `describe`：初始描述/旧资产描述/兼容旧流程。提取资产阶段写入这里，不代表正式基础设定完成。
- `foundationText`：正式基础设定，只包含资产事实、辨识锚点和连续性锚点。
- `foundationStatus`：正式基础设定生成状态，使用英文机器状态。
- `foundationErrorReason`：正式基础设定失败原因。
- `prompt`：图片生成 prompt，包含当前画风和视觉表现。
- `visualDesignRationale`：后端内部生成和审核用的视觉设计推导，第一版不作为资产字段返回。

基础设定展示建议：

```ts
const foundationDisplay = asset.foundationText || asset.describe || "";
```

基础设定完成判断：

```ts
const foundationReady = asset.foundationStatus === "completed" && !!asset.foundationText?.trim();
```

不要再用 `describe` 非空判断“设定完成”。

## 与旧 AI 润色的关系

旧接口保留兼容：

- `/api/assetsGenerate/polishAssetsPrompt`
- `/api/assetsGenerate/batchPolishAssetsPrompt`

新塑角造景主流程应使用 `/api/assets/foundation/generate`。
