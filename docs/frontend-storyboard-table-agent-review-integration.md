# 分镜表审核与技术事实前端对接

## 目的

分镜表由同一个 `storyboardTableAgent` 在一次流式运行中完成内部预演与正式写表；内部预演不是独立 Agent，也不要求用户操作。正式提交后，后端才自动安排独立的 `supervisionStoryboardTableAgent` 只读审核。

本次后端已补齐分镜技术事实投影。本文件定义 `Toonflow-web` 后续改造，不要求新增审核操作面板，也不要求用户手动编辑机位、站位或时长字段。

## 数据来源

主工作台继续调用：

```http
POST /production/getFlowData
```

```json
{ "projectId": 1, "episodesId": 3 }
```

返回的 `storyboard[]` 除原字段外，包含：

```ts
type StoryboardTechnicalFacts = {
  sceneContinuityId: string | null;
  cameraAngle: string | null;
  transitionFromPrevious: string | null;
  shotSize: string | null;
  cameraMove: string | null;
  characters: Array<{
    assetId?: number;
    name: string;
    spatialPosition: string;
    orientation: string;
    posture?: string;
    gaze?: string;
    handAction?: string;
    action: string;
  }>;
  requiredAssets: Array<{
    assetId: number;
    name: string;
    type: "role" | "scene" | "tool" | "clip";
    order: number;
  }>;
};
```

`POST /production/getStoryboardData` 与 `POST /production/storyboard/getStoryboardData` 也返回相同的技术事实，供预览或独立分镜列表使用。

前端应优先使用这些投影字段。旧分镜或兼容接口缺字段时，允许从 `tableRowJson` 作只读回退；不得把 Raw JSON 作为常规展示或编辑入口。

## 分镜表展示

保留现有镜头、资产、Prompt、图片、时长和操作列，并新增独立技术列：

| 列 | 字段 | 显示规则 |
| --- | --- | --- |
| 场景连续性 | `sceneContinuityId`、`transitionFromPrevious` | 第一行显示连续场景标识；第二行显示上一镜承接或转场。 |
| 轴线 / 机位 | `cameraAngle` | 原样显示完整机位签名，例如 `主对抗轴A｜A2｜轴线南侧｜林知秋正面｜朝陈默方向`；不可截断为“正面/侧面”。 |
| 景别 / 运镜 | `shotSize`、`cameraMove` | 景别为主行，运镜为次行。 |
| 人物站位 / 朝向 | `characters` | 每个可见人物显示姓名、`spatialPosition` 与 `orientation`；姿态、视线、手部状态可作为次级文本或 tooltip。 |

表格可以横向滚动。技术列是只读的导演事实视图，不在分镜面板 Prompt 编辑弹窗中增加逐字段人工返修表单。

`characters` 是结构化分镜事实，不是旧接口中用于头像展示的资产缩略图数组。需要显示角色头像时，仍使用资产引用或现有参考图逻辑。

## 审核与对话恢复

分镜表提交后，当前 Production Agent Run 会进入：

```text
status = awaiting_user
currentStage = supervisionStoryboardTable
currentSubAgent = supervisionStoryboardTableAgent
```

`resultJson` 只用于恢复状态，形状如下：

```ts
{
  source: "supervisionStoryboardTable";
  generationId: string;
  revision: number;
  suggestionIds: number[];
  suggestionCount: number;
}
```

页面进入、返回菜单或 Socket 重连后：

1. 查询当前 Production scope 的 Agent Run 状态。
2. 读取同一 scope 的 Agent Memory，展示审核 Agent 已写入的报告文本。
3. 调用 `/production/getFlowData` 刷新正式分镜和技术列。
4. 当 run 为 `awaiting_user` 且 stage 为 `supervisionStoryboardTable` 时，恢复审核报告和自然语言输入入口；不得自动重发分镜生成或审核请求。

## 构建状态

分镜表构建期间只展示三个用户可理解的阶段，不展示内部工具名、generation ID 或预演 JSON：

1. `storyboardTable/storyboardTableAgent` 且尚未 begin：`正在整理剧情与镜头节奏`。
2. 已开始分批写入：`正在写入分镜`。
3. `supervisionStoryboardTable/supervisionStoryboardTableAgent`：`正在进行独立审核`。

后台仍保留模型 chunk stream。前端不应因为准备阶段暂时没有工具结果而显示“卡住”，应继续依据 run 心跳和状态判断。

## 审核决策

审核报告、当前分镜和运行状态恢复后，用户继续通过现有 Agent 输入框以自然语言说明下一步。前端不拼接固定指令、不根据关键词推断用户意图，也不新增逐条接受、忽略或手工返修 UI。

决策 Agent 理解本轮输入后，自行声明其理解的续接意图；前端只等待新的 run 状态和业务数据刷新。正常审核完成后不显示“调用审核”或“重新审核”。只有 run 为 `failed` 且 `retryTarget=storyboardTableReview` 时才显示“重试独立审核”，并且重试不得重新生成分镜表。

前端不得调用历史的 `reviewStoryboardTable`、`applyStoryboardTableReview` 或 `resolveBatch` 来修改分镜表。

## 刷新与状态

- 审核是只读的：收到审核报告不代表分镜表被修改，也不应刷新或清空现有图片、Prompt、资产引用。
- 审核报告包含全局问题和逐镜问题；全局问题可能没有单独 storyboardId，前端不得因此丢弃。
- 用户要求返修后，页面按现有 Agent Run 与业务刷新机制等待新的正式 generation；不要依据聊天流局部替换单行数据。
- 新 generation 提交后会再次自动审核。页面应重新读取 Agent Memory 与 `/production/getFlowData`，而不是复用上一轮建议。
- `o_productionReviewSuggestion` 是后端恢复用记录；本轮不新增前端逐项接受、忽略、回滚或手动编辑审核建议的 UI。

## 验收场景

- 分镜表完成后，审核原文可在聊天历史中完整恢复，用户可直接继续自然语言对话；分镜表和已有面板图不被自动改写。
- 用户不会看到 `prepare_storyboard_table`、`record_storyboard_table_review` 等内部工具名，也不会被要求手动调用审核。
- 返回页面后，表格显示完整轴线机位签名、人物真实站位和朝向；不要求用户打开 Raw JSON。
- 用户输入“第21镜改为8秒，其他不动”后，页面等待 Agent 修订；修订完成后刷新为新正式表并显示新审核报告。
- 用户输入“保持当前版本，继续分镜面板”后，不触发分镜表重写。
- 菜单切换、Socket 断开和重连都不能丢失 `awaiting_user` 的审核上下文或自动重发请求。
