# 导演规划分段提交前端对接

## 变更范围

导演规划正式产物已改为后端 Agent 工具链提交：

`begin_director_plan -> append_director_plan_section -> commit_director_plan`

前端不参与章节拼接、XML 解析或正式版本保存。正式导演规划仍通过现有生产台 flowData 获取。

## 前端需要调整

1. 从 Production Agent socket 的 `xmlTags` 中删除 `scriptPlan`。
2. 删除 `onXmlTag` 中将 `<scriptPlan>` 写入 `flowData.scriptPlan` 并调用 `setFlowData` 的逻辑。
3. 保留 `script` 的 XML 兼容逻辑，导演规划不再使用 XML。
4. Agent 消息完成后，继续调用现有 flowData 刷新逻辑。后端 commit 成功后，刷新结果中的 `scriptPlan` 即为新正式版本。
5. 切换剧集时继续保留当前按 `scriptId` 隔离的 socket/session；不要因为页面切换主动断开其他剧集正在执行的 session。

## FlowData 字段

```ts
interface DirectorPlanGenerationState {
  current: null | {
    generationId: string;
    state: string;
    textAssetId?: number | null;
    version?: number | null;
    updatedAt: number;
  };
  lastFailure: null | {
    generationId: string;
    state: "invalid" | "failed" | string;
    errorJson?: string | null;
    updatedAt: number;
  };
}

interface ProductionFlowData {
  scriptPlan: string;
  directorPlanGeneration: DirectorPlanGenerationState;
}
```

## 状态处理

- `writing` / `committing`：显示导演规划仍在后台生成，不覆盖当前正式 `scriptPlan`。
- `committed`：刷新 flowData；使用返回的正式 `scriptPlan`。可用 `textAssetId/version` 标识本次版本。
- `invalid` / `failed`：显示 `lastFailure.errorJson` 中的可读原因；保留当前正式版本，但不得把它展示为本次生成结果。
- 页面刷新或 socket 重连后，以 flowData 的 `directorPlanGeneration` 恢复状态，不依赖历史聊天文本。

## 完成事件

执行 Agent 成功时返回轻量结果：

```json
{
  "status": "committed",
  "generationId": "uuid",
  "textAssetId": 123,
  "version": 10
}
```

该结果用于触发刷新和界面提示，不作为导演规划正文数据源。正文只读取 flowData 的 `scriptPlan`。

失败时返回 `invalid/failed` 和诊断，不会创建空版本，也不会触发对旧版本的自动审核。

## 数据保留说明

- 正式 `scriptPlan`：长期保留。
- generation 章节正文：24 小时后由后端惰性清理。
- generation 状态、错误摘要和长 Agent 输出：保留 7 天后惰性清理。
- 前端无需发起清理请求，也无需维护 TTL 定时器。
