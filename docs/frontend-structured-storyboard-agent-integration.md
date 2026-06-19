# Toonflow 前端对接文档：分镜表 Agent 结构化返回与存储

## 1. 核心变化

生产 Agent 的分镜表阶段已经改为后端直接写入结构化数据：

```text
Agent
  -> write_storyboard_table_rows_v2
  -> o_storyboardTableDraft
  -> finalize_storyboard_table_v2
  -> o_storyboard / o_videoTrack
  -> update_storyboard_panel_v2
  -> getFlowData
```

前端不再负责：

- 解析 `<storyboardTable>...</storyboardTable>` 并作为正式分镜表保存。
- 解析 `<storyboardItem ...>` 拼装分镜业务字段。
- 将 Agent 流式输出逐条调用 `batchAddStoryboardInfo` 落库。
- 从 `videoDesc`、Markdown 或图片 prompt 中提取结构化分镜字段。

前端只负责：

- 展示 Agent 对话和执行进度。
- Agent 执行完成后重新调用 `getFlowData`。
- 使用后端返回的 `storyboard`、`storyboardTable` 和 `storyboardTableMeta` 更新页面。
- 用户手动编辑分镜时提交明确的结构化字段。

分镜面板 Agent 也已经改为调用后端 `update_storyboard_panel_v2`，只更新已有分镜的图片 prompt、生图开关和资产关联。前端同样不需要解析分镜面板 XML。

后端是分镜表和分镜组的唯一事实源。

---

## 2. 前端必须调整的位置

当前文件：

```text
Toonflow-web/src/stores/productionAgent.ts
```

### 2.1 停止处理 Agent 的分镜 XML

从 `useChat({ xmlTags })` 中移除：

```ts
{ tag: "storyboardTable", keepInMessage: false }
{ tag: "storyboardItem", keepInMessage: false }
```

停止使用以下旧逻辑：

```ts
buildStoryboardItem()
pickStoryboardFacts()
mergeStoryboardFacts()
queueStoryboardItem()
scheduleStoryboardFlush()
flushStoryboardItems()
```

`pendingStoryboardItems` 和 `storyboardFlushTimer` 可以一并删除。

不要再因为收到 `<storyboardItem>` 调用：

```text
POST /api/production/storyboard/batchAddStoryboardInfo
```

该接口暂时保留给手动新增、旧页面和兼容流程，不再作为生产 Agent 的正式写入路径。

### 2.2 Agent 完成后刷新事实数据

当前 `message:update` 只刷新旧缓冲项。调整为：

```ts
socket.on("message:update", async (event) => {
  if (event.status !== "complete") return;
  await setFlowData(session.episodeId);
});
```

建议加入请求去重，避免同一完成事件连续刷新：

```ts
if (session.flowRefreshPending) return;
session.flowRefreshPending = true;
try {
  await setFlowData(session.episodeId);
} finally {
  session.flowRefreshPending = false;
}
```

不要在流式消息尚未完成时频繁保存分镜表，稳定性优先。

### 2.3 `getFlowData` 是刷新入口

接口：

```text
POST /api/production/getFlowData
```

请求：

```ts
{
  projectId: number;
  episodesId: number;
}
```

Agent 完成后，前端必须用该接口返回值整体更新：

```ts
flowData.storyboard
flowData.storyboardTable
flowData.storyboardTableMeta
flowData.workbench
```

前端本地缓存不得覆盖新返回的结构化字段。

---

## 3. 分镜结构类型

前端需要扩展 `Storyboard`：

```ts
type StoryboardFactSource =
  | "storyboardTable"
  | "minimalFallback";

interface StoryboardCharacterFact {
  name: string;
  assetId?: number;
  roleInShot?: string;
  position?: string;
  posture?: string;
  gaze?: string;
  expression?: string;
  handAction?: string;
  movement?: string;
}

interface StoryboardDialogueFact {
  speaker: string;
  text: string;
  voiceTone?: string;
}

interface StoryboardTableRowV2 {
  index: number;
  sceneNo?: string;
  beatId: string;

  groupKey: string;
  groupName: string;
  groupIntent: string;
  groupBoundaryReason: string;

  durationSec: number;
  location: string;
  timeOfDay: string;
  sceneContinuityId?: string;

  visualFacts?: {
    lighting?: string;
    palette?: string;
    spatialAnchors?: string[];
  };

  shotSize: string;
  cameraMove: string;
  cameraAngle?: string;
  composition?: string;

  picture: string;
  action: string;
  characters: StoryboardCharacterFact[];
  visibleEmotion: string;
  dialogue: StoryboardDialogueFact[];
  soundEffects: string[];

  requiredAssets?: Array<{
    name: string;
    type: "role" | "scene" | "tool" | "clip";
    assetId?: number;
    purpose: string;
  }>;

  safetyNotes?: Array<{
    severity: "info" | "warning" | "blocking";
    risk: string;
    saferExpression?: string;
  }>;

  imageBrief?: string;
  videoBrief?: string;
}

interface Storyboard {
  id: number;
  index?: number;
  duration: number;
  trackId?: number;

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
  dialogue?: string;
  sound?: string;
  visibleEmotion?: string;

  tableRowJson?: string;
  factSource?: StoryboardFactSource;

  prompt: string;
  videoDesc: string;
  associateAssetsIds: number[];
  shouldGenerateImage: number;
}
```

`tableRowJson` 当前以 JSON 字符串返回。前端若需要显示人物表演、视觉事实、安全备注等高级字段，可以安全解析：

```ts
function parseStoryboardTableRow(value?: string): StoryboardTableRowV2 | undefined {
  if (!value) return;
  try {
    return JSON.parse(value) as StoryboardTableRowV2;
  } catch {
    return;
  }
}
```

不要根据 `videoDesc` 反向构造 `StoryboardTableRowV2`。

---

## 4. 字段事实口径

### 4.1 数据优先级

前端展示应按以下顺序：

```text
tableRowJson 中的结构化字段
  -> getFlowData.storyboard 的拆列字段
  -> 旧 videoDesc 仅作只读历史展示
```

禁止：

```text
videoDesc -> 前端字符串解析 -> scene/action/dialogue
prompt -> 前端字符串解析 -> 分镜事实
Markdown 表格 -> 前端字符串解析 -> 分镜事实
```

### 4.2 `factSource`

```ts
factSource === "storyboardTable"
```

表示后端拥有可用于视频提示词的结构化事实。

```ts
factSource === "minimalFallback"
```

表示历史分镜缺少完整结构化字段。前端应显示弱提示：

```text
当前分镜来自历史数据，建议重新生成或结构化重整分镜表。
```

不要在前端尝试自动补字段。

### 4.3 `videoDesc` 与 `prompt`

- `videoDesc`：旧链路兼容文本或人工补充，不再是结构化事实源。
- `prompt`：分镜图生成提示词，不是视频叙事事实源。
- `tableRowJson`：完整分镜表事实。
- `scene/picture/action/...`：方便列表和常规页面使用的拆列字段。

---

## 5. 分镜表展示

继续使用：

```ts
flowData.storyboardTable
flowData.storyboardTableMeta
```

后端会根据 `o_storyboard` 结构化数据重建 Markdown。

```ts
interface StoryboardTableMeta {
  source: "structured" | "draft" | "empty";
  rowCount: number;
  complete: boolean;
  hash: string;
  textAssetId?: number;
}
```

UI 判断：

- `structured`：正式结构化分镜表。
- `draft`：仅有历史文本草稿，可能不完整。
- `empty`：没有分镜表。

完整性建议：

```ts
const complete =
  meta?.source === "structured" &&
  meta.complete &&
  meta.rowCount === flowData.storyboard.length;
```

不要把用户编辑后的短 Markdown 直接当成正式结构化分镜表覆盖后端。

---

## 6. 手动编辑与兼容接口

### 6.1 `batchAddStoryboardInfo`

接口暂时保留：

```text
POST /api/production/storyboard/batchAddStoryboardInfo
```

只用于：

- 用户手动新增分镜。
- 旧版兼容页面。
- 非 Agent 的明确结构化导入。

请求应传结构化字段，至少包括：

```ts
{
  projectId: number;
  scriptId: number;
  data: Array<{
    prompt: string;
    duration: number;
    track: string;
    state: string;
    src: string | null;
    videoDesc: string;
    shouldGenerateImage: number;
    associateAssetsIds: number[];

    groupKey: string;
    groupName: string;
    groupIntent: string;
    beatId: string;

    location: string;
    timeOfDay: string;
    sceneContinuityId?: string;
    picture: string;
    action: string;
    shotSize: string;
    cameraMove: string;
    visibleEmotion: string;
    dialogue: string;
    sound: string;

    tableRowJson?: StoryboardTableRowV2;
  }>;
}
```

如果提供 `tableRowJson`，后端会以其生成正式结构化字段。前端不要只传 `videoDesc`。

### 6.2 手动编辑后的刷新

接口成功后使用返回的完整分镜列表更新页面，或重新调用 `getFlowData`。

不要继续使用：

```ts
prompt + duration + videoDesc
```

作为匹配同一分镜的唯一依据。新数据应优先使用后端返回的 `id`。

---

## 7. 历史分镜表结构化重整

新增接口：

```text
POST /api/production/storyboard/restructureStoryboardTable
```

请求：

```ts
{
  projectId: number;
  scriptId: number;
  textAssetId?: number;
  instruction?: string;
}
```

响应：

```ts
{
  code: 200;
  data: {
    batchId: string;
    rows: number;
    groups: number;
    issues: Array<{
      index: number;
      field: string;
      message: string;
    }>;
  };
  message: string;
}
```

这个接口只生成结构化 draft，不覆盖正式分镜。

当前建议交互：

1. 用户点击“结构化重整”。
2. 前端提交历史文本资产 ID 和用户补充要求。
3. 返回有 `issues` 时展示问题，不更新正式分镜。
4. 当前没有面向前端的“应用重整草稿”REST 接口，因此首版前端不要开放该按钮。

该接口当前用于后端诊断和后续重整 UI 预留。正常新生产流程不需要调用。

---

## 8. 分镜组与视频工作台

分镜组由分镜表阶段生成，前端不得在分镜面板重新规划。

页面显示使用：

```ts
storyboard.groupKey
storyboard.groupName
storyboard.groupIntent
storyboard.trackId
```

视频工作台的分镜数量必须来自：

```ts
flowData.storyboard.filter(item => item.trackId === trackId)
```

不要根据：

- 合图数量。
- 引用数量。
- `storyboardItem` XML 数量。
- Markdown 行数。

来判断一个轨道有多少个分镜。

---

## 9. 推荐修改清单

必须修改：

1. 删除生产 Agent Store 中分镜 XML 解析和定时批量落库逻辑。
2. Agent 消息完成后调用 `getFlowData`。
3. 扩展 `Storyboard` 和 `StoryboardTableRowV2` 类型。
4. 保留并展示 `factSource/location/timeOfDay/sceneContinuityId/tableRowJson`。
5. 分镜组数量以后端 `trackId` 关联为准。
6. 不再从 `videoDesc/prompt/Markdown` 解析业务字段。

建议修改：

1. 对 `minimalFallback` 显示历史数据提示。
2. 调试页面提供 `tableRowJson` 查看入口。
3. 手动新增/编辑分镜时使用结构化表单字段。
4. Agent 完成刷新增加请求去重和 loading 状态。

暂不需要修改：

1. 视频生成接口参数。
2. 视频引用排序逻辑。
3. 分镜图生成接口。
4. 资产和合图选择接口。

---

## 10. 发布顺序

这是前后端同步切换：

1. 先部署包含三个 Agent 工具的后端：
   - `write_storyboard_table_rows_v2`
   - `finalize_storyboard_table_v2`
   - `update_storyboard_panel_v2`
2. 确认生产 Agent 已不再输出 `<storyboardTable>` 和 `<storyboardItem>` 作为业务写入。
3. 再发布移除 XML 分镜解析的前端。

前端不得先于后端切换，否则旧后端输出的 `<storyboardItem>` 将无人保存。

---

## 11. 联调验收

### 新分镜表

1. 用户要求 Agent 生成 4 条分镜。
2. 前端不收到或不处理 `<storyboardItem>`。
3. Agent 完成后调用 `getFlowData`。
4. `storyboard.length === 4`。
5. 每条 `factSource === "storyboardTable"`。
6. `tableRowJson` 可解析，`location/picture/action/shotSize/cameraMove` 不为空。
7. `storyboardTableMeta.source === "structured"`。

### 分镜面板

1. 分镜表完成后运行分镜面板 Agent。
2. 前端不处理 `<storyboardItem>`。
3. Agent 使用 `update_storyboard_panel_v2` 更新现有分镜。
4. `storyboard.length` 不增加，不产生重复分镜。
5. 原有 `location/action/dialogue/groupKey/tableRowJson` 不被覆盖。
6. `prompt/shouldGenerateImage/associateAssetsIds` 按分镜图规划更新。

### 分镜组

1. 四条分镜属于同一 `groupKey`。
2. 四条分镜拥有相同 `trackId`。
3. 视频工作台显示“分镜 4”，不受合图数量影响。
4. 生成视频提示词时输出四条分镜描述。

### 历史数据

1. 旧分镜缺少结构化事实时返回 `minimalFallback`。
2. 前端只提示，不自行解析补全。
3. 结构化重整不会自动覆盖正式数据。

### 稳定性

1. Agent 流式输出期间不频繁调用 `batchAddStoryboardInfo/saveFlowData`。
2. Agent 完成只触发一次 `getFlowData`。
3. 刷新页面后结构化分镜和分镜组保持一致。
