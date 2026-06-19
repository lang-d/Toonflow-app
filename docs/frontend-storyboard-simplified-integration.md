# 前端对接文档：结构化分镜表链路简化

本文档对应后端“分镜表链路简化”后的前端调整口径。

核心目标：前端保持现有主要页面字段不大改，但所有业务事实统一来自后端的 `tableRowJson` 映射结果；前端不再解析 Markdown、XML、`videoDesc`、Prompt 或 Agent 聊天文本。

## 1. 总原则

```text
tableRowJson = 唯一分镜业务事实源
getFlowData.storyboard[] = 后端从 tableRowJson 映射出来的兼容展示字段
storyboardTable = 后端从 tableRowJson 确定性渲染的 Markdown，只展示/导出
prompt/referenceImages/src = 分镜图派生数据
视频 Prompt = 后端从 tableRowJson 编译出来的派生数据
```

前端需要遵守：

- 不解析 Agent 最终聊天文本里的 JSON、Markdown 或 XML。
- 不解析 `storyboardTable` 再反写分镜。
- 不解析 `videoDesc` 提取字段。
- 不从图片 Prompt、视频 Prompt 反推分镜事实。
- `draft`、`legacy` 分镜可以展示、编辑、生成分镜图，但不能生成视频 Prompt 或视频。
- 图片参考只保存 ID、顺序和路径信息；Base64 只在后端图片任务执行时临时读取，不进入前端状态和数据库事实。

## 2. 前端类型建议

### 2.1 正式分镜事实结构

```ts
export type StoryboardFactStatus = "draft" | "ready" | "legacy";

export interface StoryboardTableRow {
  version: 1;
  index: number;
  sceneNo?: string;

  groupKey: string;
  groupName: string;
  groupIntent: string;
  beatId: string;

  durationSec: number;

  location: string;
  timeOfDay: string;
  sceneContinuityId?: string;

  picture: string;
  shotSize: string;
  cameraMove: string;
  cameraAngle?: string;
  transitionFromPrevious?: string;

  action: string;

  characters: Array<{
    assetId?: number;
    name: string;
    action: string;
    orientation: string;
    spatialPosition: string;
    posture?: string;
    expression?: string;
    gaze?: string;
    handAction?: string;
    movement?: string;
  }>;

  visibleEmotion: string;

  dialogue: Array<{
    speaker: string;
    text: string;
    voiceTone?: string;
  }>;

  soundEffects: string[];

  requiredAssets: Array<{
    assetId: number;
    name: string;
    type: "role" | "scene" | "tool" | "clip";
    order: number;
  }>;
}
```

删除旧的前端事实依赖：

- `visualFacts`
- `composition`
- `safetyNotes`
- `imageBrief`
- `videoBrief`
- `groupBoundaryReason`
- 从 `videoDesc` 中拆字段

### 2.2 `getFlowData.storyboard[]` 兼容对象

前端仍可继续读取现有扁平字段。后端会从 `tableRowJson` 做 Schema 校验后映射出来。

```ts
export interface ProductionStoryboardItem {
  id: number;
  index: number;

  duration: number;
  prompt: string;
  associateAssetsIds: number[];
  src: string | null;
  state: string;

  // 旧字段仍可能存在，但不要再作为事实源使用
  videoDesc?: string;

  // 后端从 tableRowJson 映射的兼容展示字段
  scene: string;
  picture: string;
  action: string;
  shotSize: string;
  cameraMove: string;
  dialogue: string;
  sound: string;
  visibleEmotion: string;
  location: string;
  timeOfDay: string;
  sceneContinuityId?: string;

  groupKey: string;
  groupName: string;
  groupIntent: string;
  beatId: string;
  trackId?: number | null;

  tableRowJson?: string;
  factStatus: StoryboardFactStatus;
  factVersion?: number;
  factSource?: "storyboardTable" | "minimalFallback";

  shouldGenerateImage: number;
  reason?: string;
  flowId?: number | null;
  referenceImages?: unknown[];
}
```

前端使用建议：

- 列表、卡片、分镜表面板：优先直接用扁平字段显示。
- 详情编辑器：如需要编辑人物、台词、资产顺序等完整结构，再 `JSON.parse(tableRowJson)`。
- 视频工作台门禁：只看 `factStatus === "ready"`，不要依赖 `factSource`。
- `factSource === "minimalFallback"` 只代表后端用了最小兼容展示，不代表可以生成视频。

## 3. `getFlowData` 对接

接口保持：

```ts
POST /api/production/getFlowData

{
  projectId: number;
  episodesId: number;
}
```

返回中与分镜相关：

```ts
{
  script: string;
  scriptPlan: string;
  assets: unknown[];
  storyboard: ProductionStoryboardItem[];
  storyboardTable: string;
  storyboardTableMeta?: {
    source?: string;
    rowCount?: number;
    readyCount?: number;
    draftCount?: number;
    legacyCount?: number;
  };
  directorAssets: unknown[];
  workbench: unknown[];
}
```

前端调整：

1. Agent 完成后继续调用 `getFlowData` 刷新即可。
2. 不要再从 Agent 聊天消息里提取分镜表。
3. 不要把 `storyboardTable` 当成可编辑事实。
4. 如果 `o_agentWorkData` 不存在，后端仍会正常返回数据库里的分镜，前端不需要特殊兜底。
5. `storyboardTable` 第一版仍返回，是为了避免前端分镜表节点立刻改接口；后续可以再改成打开节点时按需请求。

## 4. Agent 生成完成后的前端行为

新的 Agent 工具是后端内部工具，前端不需要直接调用：

```text
begin_storyboard_table
→ append_storyboard_rows
→ commit_storyboard_table
```

前端只需要：

```text
用户发起生产 Agent
→ 流式展示 Agent 过程文本
→ Agent 结束或工具提交完成事件到达
→ 调用 getFlowData
→ 用返回的 storyboard/storyboardTable 刷新页面
```

注意：

- Agent 最终聊天消息只会是简短说明，例如“分镜表已完成，共 61 条分镜、24 个分组。”
- 聊天文本中不会包含完整表、JSON、Markdown 或 XML。
- 如果最终聊天文本流中断，但后端已经 commit，前端重新调用 `getFlowData` 仍能拿到正式分镜。
- 如果 Agent 在中途断掉，正式分镜不会被半张表覆盖；前端刷新后看到的仍是上一版正式分镜。

## 5. 分镜表节点

`getFlowData.storyboardTable` 现在是后端从 `tableRowJson` 确定性渲染出来的 Markdown。

前端可以继续：

- 展示 Markdown 分镜表。
- 复制/导出 Markdown。

前端禁止：

- 编辑 Markdown 后保存为正式分镜。
- 解析 Markdown 得到分镜字段。
- 把 Markdown 写入 `o_agentWorkData` 或作为工作区事实源。

如果要编辑分镜，请走单条编辑接口，提交结构化字段或完整 `tableRowJson`。

## 6. 手动新增分镜

接口保持：

```ts
POST /api/production/storyboard/addStoryboard
```

前端仍可沿用现有字段，但建议补充结构化字段。

```ts
{
  projectId: number;
  scriptId: number;

  prompt: string;
  duration: number;
  state: string;
  shouldGenerateImage: number;
  src: string | null;

  // 兼容字段仍需传，建议传空字符串；后端不会从这里提取事实
  videoDesc: "";

  associateAssetsIds?: number[];
  referenceImages?: unknown[];

  // 推荐：直接传完整结构化事实
  tableRowJson?: StoryboardTableRow;

  // 或者传结构化字段，由后端组装 tableRowJson
  groupKey?: string;
  groupName?: string;
  groupIntent?: string;
  beatId?: string;

  scene?: string;
  location?: string;
  timeOfDay?: string;
  sceneContinuityId?: string;

  picture?: string;
  action?: string;
  shotSize?: string;
  cameraMove?: string;
  cameraAngle?: string;
  transitionFromPrevious?: string;

  visibleEmotion?: string;
  characters?: StoryboardTableRow["characters"];
  dialogueItems?: StoryboardTableRow["dialogue"];
  soundEffects?: string[];
  requiredAssets?: StoryboardTableRow["requiredAssets"];
}
```

返回重点：

```ts
{
  id: number;
  tableRowJson: string;
  factStatus: "ready" | "draft";
  issues: Array<{
    path?: Array<string | number>;
    message: string;
  }>;
}
```

前端行为：

- `factStatus === "ready"`：正常进入分镜图、视频 Prompt、视频生成链路。
- `factStatus === "draft"`：保存成功，但展示“草稿/待补齐”状态；允许生成分镜图；禁用视频 Prompt 和视频生成。
- 有 `issues` 时，在编辑器里提示缺失字段，不要尝试用 `videoDesc` 自动补字段。

## 7. 手动编辑分镜

接口保持：

```ts
POST /api/production/storyboard/editStoryboardInfo
```

建议请求：

```ts
{
  id: number;

  prompt: string;
  duration: number;
  associateAssetsIds?: number[];
  referenceImages?: unknown[];

  // 兼容字段，建议传空字符串；后端不会从这里提取事实
  videoDesc: "";

  // 推荐：提交用户明确编辑过的结构化字段
  tableRowJson?: StoryboardTableRow;

  scene?: string;
  location?: string;
  timeOfDay?: string;
  sceneContinuityId?: string;
  picture?: string;
  action?: string;
  shotSize?: string;
  cameraMove?: string;
  cameraAngle?: string;
  transitionFromPrevious?: string;
  visibleEmotion?: string;
  characters?: StoryboardTableRow["characters"];
  dialogueItems?: StoryboardTableRow["dialogue"];
  soundEffects?: string[];
  requiredAssets?: StoryboardTableRow["requiredAssets"];
}
```

后端行为：

- 读取原有 `tableRowJson`。
- 只覆盖前端明确提交的结构化字段。
- 保留未编辑的人物、台词、资产和镜头信息。
- 重新校验并更新 `factStatus`。
- 不从任何文本字段推断缺失值。

前端行为：

- 编辑成功后重新拉取 `getFlowData`，或用接口返回值局部更新。
- 如果编辑导致字段不完整，状态会变为 `draft`，视频相关按钮需要禁用。

## 8. 批量新增分镜

接口保持：

```ts
POST /api/production/storyboard/batchAddStoryboardInfo
```

请求：

```ts
{
  projectId: number;
  scriptId: number;
  data: Array<{
    prompt: string;
    duration: number;
    state: string;
    src: string | null;
    shouldGenerateImage: number;

    videoDesc?: "";
    associateAssetsIds?: number[];
    referenceImages?: unknown[];

    tableRowJson?: StoryboardTableRow;

    groupKey?: string;
    groupName?: string;
    groupIntent?: string;
    beatId?: string;

    scene?: string;
    location?: string;
    timeOfDay?: string;
    sceneContinuityId?: string;

    picture?: string;
    action?: string;
    shotSize?: string;
    cameraMove?: string;
    cameraAngle?: string;
    transitionFromPrevious?: string;

    visibleEmotion?: string;
    characters?: StoryboardTableRow["characters"];
    dialogue?: string | StoryboardTableRow["dialogue"];
    sound?: string;
    soundEffects?: string[];
    requiredAssets?: StoryboardTableRow["requiredAssets"];
  }>;
}
```

前端注意：

- 批量新增仍不等于 Agent 全表提交。
- 批量新增失败或部分草稿时，按返回的 `factStatus` 展示门禁。

## 9. 分镜图面板

分镜图派生数据不放进 `tableRowJson`。

前端继续使用：

```ts
{
  prompt: string;
  shouldGenerateImage: number;
  referenceImages?: unknown[];
  associateAssetsIds?: number[];
  src?: string | null;
}
```

规则：

- 分镜图 Agent 只改 `prompt`、`shouldGenerateImage` 和图片参考 ID。
- 不改 `tableRowJson`。
- 不写 `videoDesc`。
- 图片参考保存 ID、顺序、文件路径等元信息。
- 前端不要保存或传递 Base64 作为长期状态。

## 10. 视频工作台门禁

视频 Prompt 接口保持：

```ts
POST /api/production/workbench/generateVideoPrompt

{
  trackId: number;
  projectId: number;
  info: Array<{
    id: number;
    sources: "storyboard" | "assets" | "merged" | "directorAsset";
  }>;
  model: string;
  mode: string;
  promptPrefix?: string;
  promptSuffix?: string;
}
```

前端需要在调用前做一次轻量门禁：

```ts
const hasUnreadyStoryboard = selectedStoryboards.some(
  item => item.factStatus !== "ready"
);
```

如果存在非 `ready`：

- 禁用“生成视频提示词”。
- 禁用“生成视频”。
- 提示：`请先补齐结构化分镜事实后再生成视频。`

后端也会强制阻断：

```text
draft/legacy/非法 tableRowJson
→ 无法生成视频 Prompt
→ 无法生成视频
```

不要再做旧逻辑回退：

- 不回退到 `videoDesc`。
- 不回退到 Markdown 分镜表。
- 不回退到 Prompt。

## 11. 历史数据状态

历史分镜如果没有合法 `tableRowJson`：

```ts
factStatus = "legacy";
```

前端展示建议：

| 状态 | 展示 | 分镜图 | 编辑 | 视频 Prompt/视频 |
|---|---|---|---|---|
| `ready` | 正常 | 允许 | 允许 | 允许 |
| `draft` | 显示“草稿/待补齐” | 允许 | 允许 | 禁止 |
| `legacy` | 显示“旧数据/待整理” | 允许 | 允许 | 禁止 |

历史整理入口：

- 可以引导用户使用 AI 结构化整理。
- 整理结果必须通过后端结构化工具提交。
- 前端不要接收一段 JSON 文本再自行解析保存。

## 12. 前端改造 checklist

### 类型和状态

- [ ] 新增 `StoryboardTableRow` 类型。
- [ ] 新增 `StoryboardFactStatus` 类型。
- [ ] `ProductionStoryboardItem` 增加 `tableRowJson`、`factStatus`、`factVersion`、`factSource`、`location`、`timeOfDay`、`sceneContinuityId`、`groupKey`、`groupName`、`groupIntent`、`beatId`。

### 生产 Agent

- [ ] Agent 最终消息只作为日志展示。
- [ ] 删除从聊天文本提取 `<storyboardTable>`、`<storyboardItem>`、JSON、Markdown 的逻辑。
- [ ] Agent 完成后调用 `getFlowData` 刷新。
- [ ] 流中断时允许用户手动刷新，刷新后以后端正式数据为准。

### 分镜表节点

- [ ] 继续展示 `getFlowData.storyboardTable`。
- [ ] 标记为只读展示/导出内容。
- [ ] 删除 Markdown 编辑后反向保存为分镜事实的入口。

### 分镜列表/卡片/详情

- [ ] 列表继续使用扁平字段展示。
- [ ] 完整详情从 `tableRowJson` 读取。
- [ ] `factStatus !== "ready"` 时显示状态标签。

### 手动新增/编辑

- [ ] 新增和编辑尽量提交结构化字段或完整 `tableRowJson`。
- [ ] 兼容字段 `videoDesc` 可以继续传，但传空字符串即可。
- [ ] 有 `issues` 时展示缺失项。
- [ ] 不从 `videoDesc`、Prompt 或 Markdown 自动补字段。

### 分镜图

- [ ] 分镜图面板继续使用 `prompt`、`shouldGenerateImage`、`referenceImages`、`associateAssetsIds`、`src`。
- [ ] 不把图片 Prompt 写入 `tableRowJson`。
- [ ] 不保存 Base64。

### 视频工作台

- [ ] 生成视频 Prompt 前检查 `factStatus === "ready"`。
- [ ] `draft/legacy` 禁用视频 Prompt 和视频生成。
- [ ] 删除回退到 `videoDesc` 的前端提示或逻辑。

## 13. 验收用例

- [ ] 生产 Agent 完成后，前端只通过 `getFlowData` 获得分镜，不解析聊天内容。
- [ ] 10、30、60、100 条分镜都能正常展示。
- [ ] Agent 最终文本截断时，刷新后仍能看到已 commit 的正式分镜。
- [ ] 分镜表 Markdown 可以展示，但不能反向覆盖分镜事实。
- [ ] 手动新增字段完整时返回 `ready`。
- [ ] 手动新增字段不完整时返回 `draft`，仍可生成分镜图，但不能生成视频。
- [ ] 历史 `legacy` 分镜可展示和编辑，但不能生成视频。
- [ ] 视频工作台对 `draft/legacy` 明确禁用。
- [ ] 图片参考只保存 ID/路径，不保存 Base64。
- [ ] 修改单条分镜后，列表、Markdown、分镜图 Prompt、视频 Prompt 都来自同一份结构化事实。

## 14. 一句话迁移口径

前端可以把这次改造理解成：

```text
以前：前端/后端/Agent 都可能从文本里找分镜事实
现在：只有 tableRowJson 是事实，其他字段全部是展示或派生
```

