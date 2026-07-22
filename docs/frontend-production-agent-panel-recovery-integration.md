# Production Agent 面板恢复对接

## 目标

后端已经把 Production Agent 的真实运行状态、历史对话和运行轨迹拆成三个只读来源。前端在菜单切换、页面刷新、Socket 重连后恢复 Agent 面板时，不能只依赖 Memory 文本，也不能把运行轨迹混排成用户或 Agent 对话。

本文件只描述 `Toonflow-web` 后续接入方式。本轮不修改前端仓库。

## 恢复顺序

进入 Production Agent 面板、切回菜单、刷新页面或 Socket 重连后，对当前 `projectId + scriptId + agentKey` scope 执行：

1. 调用 `/agent/run/status`，取得 `activeRun` 与 `latestRun`。
2. 调用 `/agents/getMemory`，按 Memory `createTime` 恢复用户与 Agent 对话。
3. 如果 `latestRun.runId` 存在，调用 `/agent/run/detail`，读取 `timeline` 作为流程轨迹。
4. 调用业务数据接口刷新正式分镜表、审核建议、任务状态等业务视图。

Socket 事件只作为实时提示；恢复视图以接口返回为准。

## Memory 历史

`/agents/getMemory` 保持旧字段兼容：

```ts
type AgentMemoryMessage = {
  id: number;
  role: "user" | "assistant";
  name?: string;
  status: "complete";
  datetime: string;
  createTime: number;
  content: Array<{
    type: "markdown";
    status: "complete";
    data: string;
    ext?: AgentMemoryExt;
  }>;
  ext?: AgentMemoryExt;
};

type AgentMemoryExt = {
  fullTextAsset?: FullTextAssetMeta;
  fullTextAssets?: FullTextAssetMeta[];
};

type FullTextAssetMeta = {
  id: number;
  size: number;
  summary: string | null;
  targetType: string;
};
```

当 markdown 中出现 `[full text asset: N]` 时，后端会在 message 或 content 的 `ext` 中补充轻量元信息。历史接口不会直接返回完整长文。

展示建议：

- 默认展示 markdown 摘要和 `fullTextAsset.summary`。
- 用户展开长文内容时，使用 `/textAsset/getContent` 按 `id`、`offset`、`limit` 分页读取。
- 不要因为 markdown 截断或只有摘要，就判定审核内容丢失。
- 长文资产可能是 Agent 过程输出或转录，不等同于正式审核结论；正式结论以聊天消息中的最终回复和 run 状态为准。

聊天消息排序只使用 Memory `createTime`。本轮后端已保证用户消息使用原始用户消息时间，`assistant:decision` 使用初始决策消息时间，避免“派发返修”在历史恢复时排到审核完成之后。

## Run Detail Timeline

`/agent/run/detail` 继续返回原始 `events`，并新增后端归一化的 `timeline`：

```ts
type AgentRunTimelineItem = {
  id: number;
  eventType: string;
  kind: string;
  createdAt: number;
  stage: string | null;
  subAgent: string | null;
  status: string | null;
  payload: unknown;
};
```

`timeline` 按事件发生时间升序排列，用于展示流程轨迹或诊断状态。它只描述运行事实，不是 Agent 上下文，也不是聊天消息。

关键 `kind` 包括：

- `stage`
- `storyboard_table_decision`
- `storyboard_table_preflight_started`
- `storyboard_table_preflight_completed`
- `storyboard_table_preflight_failed`
- `storyboard_table_generation_started`
- `storyboard_table_batch_appended`
- `storyboard_table_committed`
- `storyboard_table_review_started`
- `storyboard_table_review_recorded`
- `storyboard_table_review_failed`
- `finished`

流程轨迹排序只使用 `createdAt`。不要把 `timeline` 项与 Memory 对话按同一时间轴混排；建议作为 Agent 面板的“执行进度/运行轨迹”区域展示。

## 分镜表审核恢复

分镜表提交并完成只读审核后，`latestRun` 应恢复为：

```text
status = awaiting_user
currentStage = supervisionStoryboardTable
currentSubAgent = supervisionStoryboardTableAgent
```

此时前端应保留自然语言输入框，等待用户说明下一步。不要拼接固定指令、不要做关键词判断、不要自动把旧审核建议当成返修授权。

如果用户随后输入返修说明，新的决策由后端 Agent 理解并声明；前端只等待新的 run 状态、Memory 和业务数据刷新。

## 验收

菜单切走再切回后，Agent 面板必须能同时恢复：

- 用户本轮指令，来自 `/agents/getMemory`。
- 决策派发内容，来自 `/agents/getMemory`，顺序早于同轮执行和审核。
- 执行返修、分镜写入、提交、审核保存等流程事实，来自 `/agent/run/detail.timeline`。
- 长文/过程输出入口，来自 `fullTextAsset` 元信息，展开时通过 `/textAsset/getContent` 分页读取；不要命名为“完整报告”。
- `awaiting_user` 状态和自然语言输入入口，来自 `/agent/run/status` 或 `/agent/run/detail.run`。

恢复后的视觉顺序应与 run events 一致：用户指令、决策派发、执行返修、审核完成、等待用户决定。
