# 导演规划分段提交前端对接

## 正式写入

导演规划由后端 Agent 工具链提交：

```text
begin_director_plan → append_director_plan_section → commit_director_plan
```

前端不参与章节拼接、XML 解析或版本保存。Agent 完成后刷新 `/production/getFlowData`，以 `scriptPlan` 和 `directorPlanGeneration` 为准。

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
    state: string;
    errorJson?: string | null;
    updatedAt: number;
  };
}
```

## 导演规划展示变化

新版导演规划仍保留九章节，但不再要求输出 `axis-map`、逐场机位图、逐镜景别/顺序或完整配乐设计。历史版本中的 `axis-map` 仍按普通 Markdown 代码块兼容展示；前端不需要继续建设或维护专用 SVG 渲染器。

前端只需：

- 用现有 Markdown 预览完整 `scriptPlan`；
- 对历史 `axis-map` 保持原文可读，不丢失正文；
- 不从导演规划中解析机位、轴线、分镜或视频 Prompt；
- 不把旧版本内容写回新版本。

## `videoStyle`

`videoStyle` 与导演规划 generation 同版本保存，是后端视频 Prompt 编译使用的短风格锚点。它不新增前端编辑字段，本轮也不要求前端展示。

其职责只包括整集稳定的媒介、轮廓/造型、材质和整体光色原则；场景、天气、动作和机位不属于该字段。历史记录不迁移，重新生成或返修导演规划后生效。

新版本由导演 Agent 生成一句自然语言，使用公开媒介名称，不包含内部目录 ID；前端不得把它扩展成场景执行说明或生成参数。

## 状态

- `writing / committing`：保留当前正式 `scriptPlan`，显示后台处理中。
- `committed`：刷新 flowData，使用新 `textAssetId/version`。
- `invalid / failed`：显示失败原因，继续保留旧正式版本。
- 页面刷新和 socket 重连后以 flowData 恢复，不依赖聊天 transcript。

## 前端无需改动的范围

- 不新增数据库/API 字段；
- 不解析 `videoStyle` 生成视频参数；
- 不实现导演轴线图编辑器；
- 不处理 generation 临时内容的 TTL。
