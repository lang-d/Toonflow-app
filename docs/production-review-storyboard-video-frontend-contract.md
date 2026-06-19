# 生产台审校、分镜组、视频提示词与配乐建议前端对接文档

## 1. 核心口径

- 后端不会用代码正则清理“提示词污染”，也不会自动改写用户手动编辑过的视频提示词。
- 视频提示词生成仍走“模型专属 Prompt + AI 生成”流程，后端只组织导演事实、分镜组事实、引用顺序和用户前后置约束。
- 审校阶段由 AI 返回结构化建议，用户接受后才把 `suggestedRevision` 写入业务数据。
- `info` / `warning` 只展示建议，不阻断生成。
- `blocking` 会阻断视频生成，用户需要接受、忽略不可忽略项或重新生成/手动修正后再继续。
- BGM 建议只用于后期参考，不进入视频提示词，不传给视频模型。

## 2. 分镜字段扩展

分镜对象新增可选字段：

```ts
{
  groupKey?: string;
  groupName?: string;
  groupIntent?: string;
  beatId?: string;
}
```

涉及接口：

```text
POST /api/production/storyboard/batchAddStoryboardInfo
POST /api/production/storyboard/addStoryboard
POST /api/production/storyboard/getStoryboardData
POST /api/production/getStoryboardData
POST /api/production/workbench/getGenerateData
```

前端生成分镜表时建议直接传 `groupKey/groupName/groupIntent/beatId`。旧项目没有这些字段时，后端继续按原 `track/trackId` 兼容，不自动重组旧分镜。

## 3. 视频轨道字段扩展

`getGenerateData.trackList[]` 增加：

```ts
{
  groupKey?: string;
  groupName?: string;
  groupIntent?: string;
  musicPlan?: TrackBgmSuggestion | null;
  reviewState?: "pending" | "passed" | "hasIssues" | "blocked";
  reviewIssues?: ProductionReviewSuggestion[];
}
```

`TrackBgmSuggestion`：

```ts
{
  groupKey: string;
  mood: string;
  intensity: 1 | 2 | 3 | 4 | 5;
  tempoBpm?: string;
  rhythm: string;
  instrumentation: string[];
  entryPoint: string;
  exitPoint: string;
  syncPoints: string[];
  avoid: string[];
  postNote: string;
}
```

展示建议：在视频工作台的分镜组信息旁展示 BGM 参考卡，不要拼到提示词编辑器。

## 4. 审校建议对象

```ts
type ProductionReviewSuggestion = {
  id: number;
  projectId: number;
  scriptId?: number | null;
  targetType:
    | "directorPlan"
    | "asset"
    | "deriveAsset"
    | "storyboardTable"
    | "storyboard"
    | "storyboardGroup"
    | "storyboardImage"
    | "videoPrompt"
    | "bgmSuggestion"
    | "videoResult";
  targetId: string | number;
  parentId?: number | null;
  version: number;
  issueType: string;
  severity: "info" | "warning" | "blocking";
  message: string;
  reason?: string;
  proposedAction?: string;
  proposedPatch?: unknown;
  status: "open" | "accepted" | "ignored" | "revised" | "resolved";
  createTime: number;
  updateTime: number;
};
```

视频提示词 AI 审校常见 `issueType`：

```ts
"prompt_pollution" | "abstract_emotion" | "continuity_conflict" | "bgm_in_prompt" | "safety_risk" | "model_mismatch" | "ai_review"
```

如果 AI 给出完整修订版，后端会把它放入 `proposedPatch.values.prompt`。只有调用接受接口后才会写入 `o_videoTrack.prompt`。

## 5. 通用审校接口

```text
POST /api/production/review/list
POST /api/production/review/detail
POST /api/production/review/createFeedback
POST /api/production/review/recalculate
POST /api/production/review/accept
POST /api/production/review/ignore
POST /api/production/review/rollback
```

`list` 请求示例：

```ts
{
  projectId: number;
  scriptId?: number;
  targetType?: string;
  targetId?: string | number;
  status?: "open" | "accepted" | "ignored" | "revised" | "resolved";
}
```

操作请求：

```ts
{ id: number }
```

反馈：

```ts
{
  suggestionId: number;
  comment: string;
  mode: "note" | "recalculate";
}
```

建议交互：

- `accept`：应用 `proposedPatch`。视频提示词建议会写入 AI 建议修订版。
- `ignore`：忽略当前建议。
- `rollback`：仅对已接受且带 `previous` 快照的建议有效，恢复接受前内容。
- `createFeedback(mode: "note")`：只记录用户意见。
- `recalculate`：记录用户意见，把旧建议标记为 `revised`，并按目标重新跑审校。视频提示词会重新调用 AI 审校。

## 6. 分镜表审校

```text
POST /api/production/storyboard/reviewStoryboardTable
```

请求：

```ts
{ projectId: number; scriptId: number }
```

返回：

```ts
{
  groups: StoryboardGroupPlan[];
  suggestions: ProductionReviewSuggestion[];
}
```

该接口只生成建议，不直接改分镜或轨道。

应用用户确认的建议：

```text
POST /api/production/storyboard/applyStoryboardTableReview
```

请求：

```ts
{ suggestionIds: number[] }
```

## 7. 视频工作台审校

```text
POST /api/production/workbench/reviewVideoTracks
```

请求：

```ts
{
  projectId: number;
  scriptId?: number;
  trackIds?: number[];
}
```

行为：

- 对每个轨道读取当前 `prompt`、分镜组事实、分镜数据和 BGM 元数据。
- AI 审校提示词污染、抽象情绪、BGM 混入、时间/光影冲突、分镜图事实冲突和安全风险。
- 返回建议，不自动写回 prompt。

应用用户确认的建议：

```text
POST /api/production/workbench/applyVideoTrackReview
```

请求：

```ts
{ suggestionIds: number[] }
```

## 8. 视频提示词生成

`generateVideoPrompt` 和 `batchGeneratePrompt` 请求不变。

后端内部流程：

1. 根据 `model` 读取用户绑定的模型 Prompt；没有绑定时读取内置视频 Prompt。
2. 按前端传入顺序组织 `storyboard | assets | merged | directorAsset` 引用。
3. 补充分镜组事实和用户前后置约束。
4. 调用文本模型生成候选视频提示词。
5. 只做工程校验：空 prompt 阻断，过大 payload 给 warning。
6. 如需审校，由前端调用 `reviewVideoTracks`。

## 9. 视频生成阻断

单个视频生成和批量视频生成提交前检查：

- prompt 不能为空。
- 模型输入数量/类型不能超过限制。
- 轨道 `reviewState === "blocked"`。
- 目标为 `storyboardGroup | videoPrompt | videoResult` 的 open blocking 建议。

存在 blocking 时返回：

```ts
{
  code: 400;
  message: "Video generation is blocked by open production review issues";
  data: { blockingReview?: ProductionReviewSuggestion; trackId?: number };
}
```

前端建议：

- `info`：普通提示，可折叠。
- `warning`：建议卡，可接受、忽略、反馈、重算。
- `blocking`：红色阻断卡，禁用生成按钮，引导用户处理。

## 10. 联调验收

- 分镜表生成后刷新，`groupKey/groupName/groupIntent/beatId` 不丢。
- `getGenerateData` 能显示分镜组和 BGM 建议。
- 视频提示词生成后不会因为代码词表被自动删词。
- `reviewVideoTracks` 返回 AI 审校建议和可选 `suggestedRevision`。
- 接受视频提示词建议后，轨道 prompt 才被更新。
- 忽略建议后 prompt 不变。
- 用户反馈后重算，会生成新版建议，旧建议变为 `revised`。
- 有 open blocking 建议时，视频生成返回 400。
- BGM 建议不会出现在视频生成 payload 中。
