# 生产审阅非阻塞前端调整说明

## 1. 文档目的

本文档用于指导前端将“生产审阅”从视频生成准入条件调整为建议和提醒功能。

后端完成本次调整后，以下接口不再因为开放的高优先级审阅建议或轨道 `reviewState="blocked"` 返回审阅阻塞错误：

```text
POST /production/workbench/generateVideo
POST /production/workbench/batchGenerateVideo
```

生产审阅仍负责：

- 标记问题严重程度。
- 提供修改建议和风险说明。
- 支持接受、忽略、反馈和重新审阅。
- 使用红色等高可见性样式提醒高优先级问题。

生产审阅不再负责：

- 禁用视频生成按钮。
- 阻止前端发送合法的视频生成请求。
- 替用户决定是否可以继续生成。

本文档只描述前端后续调整。前端源码不包含在本次后端提交中。

## 2. 后端行为变化

### 2.1 已取消的准入限制

单条和批量视频生成接口不再执行以下判断：

- `o_videoTrack.reviewState === "blocked"`。
- 当前轨道或分镜组存在 `status="open"` 且 `severity="blocking"` 的生产审阅建议。
- 返回 `Video generation is blocked by open production review issues` 专用 400。

因此，前端不需要也不应继续复制这套准入判断。

### 2.2 保持不变的接口契约

以下字段和数据格式保持不变：

```ts
type ProductionReviewSeverity = "info" | "warning" | "blocking";
type ProductionReviewState = "pending" | "passed" | "hasIssues" | "blocked";
```

- `severity="blocking"` 仍表示最高优先级建议。
- `reviewState="blocked"` 仍可能由审阅服务生成并通过接口返回。
- 已有审阅数据不迁移、不降级，也不会被自动接受或忽略。
- 视频生成接口的请求参数和成功响应结构不变。
- 任务创建、任务状态和视频队列逻辑不变。

前端必须将这些值视为展示和交互状态，不能再将其解释为视频生成权限。

### 2.3 仍会阻止请求的工程校验

“审阅非阻塞”不表示所有错误都可以忽略。后端仍会对确定性的无效请求返回 400，包括：

- 轨道不存在，或轨道不属于当前项目、剧本。
- 轨道没有可用分镜。
- 分镜尚未完成结构化事实整理。
- 视频提示词为空。
- 模型不支持请求的时长或分辨率组合。
- 引用不存在、归属错误或引用数量超过模型限制。
- 请求参数类型或必填字段不合法。

这些校验属于请求有效性或模型能力约束，前端应继续保留对应检查和错误提示。

## 3. 单条视频生成调整

文件：

```text
src/views/production/components/workbench/generate/index.vue
```

### 3.1 删除本地审阅准入判断

在 `generateVideo()` 中删除以下行为：

- 调用 `isTrackBlocked(currentTrack.value)`。
- 查找开放的 blocking 审阅并拼接阻塞提示。
- 展示 `Video generation is blocked by open production review issues` 或同义文案。
- 因审阅状态提前 `return`。

同时删除不再使用的 `isTrackBlocked` import。

调整后的调用原则：

```ts
// 伪代码，只表达调用顺序
async function generateVideo() {
  validateStructuredStoryboardFacts();
  validatePrompt();
  validateRequiredParameters();
  await confirmGenerationWhenNeeded();

  return request("/production/workbench/generateVideo", payload);
}
```

无论当前轨道的 `reviewState` 是 `blocked`、`hasIssues`、`passed` 还是 `pending`，只要工程参数合法，就应发送生成请求。

### 3.2 必须保留的检查

- 空提示词检查。
- 结构化分镜事实完整性检查。
- 模型、时长、分辨率和引用参数检查。
- 现有生成确认弹窗。
- 接口通用错误处理。

接口失败时使用现有通用错误提取逻辑，不再识别“审阅阻塞生成”专用错误结构。

## 4. 批量视频生成调整

文件：

```text
src/views/production/components/workbench/generate/components/track.vue
```

在批量生成方法中：

- 删除从已勾选轨道中查找 `isTrackBlocked(track)` 的逻辑。
- 删除因为任意轨道存在开放 blocking 建议而中断整个批次的分支。
- 删除不再使用的 `isTrackBlocked` import。
- 不过滤带有 `reviewState="blocked"` 的合法轨道。
- 将所有通过工程校验的已选轨道提交给 `/production/workbench/batchGenerateVideo`。

以下现有检查必须保留：

- 未选择任何轨道。
- 轨道提示词为空。
- 必填生成参数不完整。
- 模型时长或分辨率不支持。
- 分镜事实未就绪。
- 引用参数无效。

批量请求不得因为审阅建议而丢弃部分轨道，也不得静默缩小提交范围。

## 5. 审阅展示语义调整

### 5.1 工具函数

文件：

```text
src/utils/productionReview.ts
```

建议调整：

- 保留 `isBlockingReview()` 和 `getBlockingReview()`，用于识别最高优先级建议、排序和红色提醒。
- 删除 `isTrackBlocked()`，或至少停止导出，避免它再次被用于生成准入。
- `getSeverityLabel("blocking")` 返回“高优先级”，不再返回“阻塞”。
- `getReviewMessage()` 使用通用接口错误提取，不再依赖后端 `data.blockingReview` 专用结构。
- `countOpenReviews()` 可以继续统计 blocking 数量，但展示名称改为“高优先级”。

注意：不要把 `blocking` 自动转换为 `warning`。内部枚举和严重程度保持不变，只调整用户可见语义和按钮控制逻辑。

### 5.2 审阅面板

`ProductionReviewPanel.vue` 应进行以下展示调整：

- `Blocking N` 改为“高优先级 N”。
- blocking 卡片继续使用 danger/红色主题并保持最高排序优先级。
- 高优先级提示区域明确显示“仅供参考，可继续生成”。
- 保留接受、忽略、反馈、重新计算和回滚等现有操作。
- 不隐藏安全风险，不降低卡片视觉权重。

建议提示文案：

```text
发现高优先级审阅建议。建议生成前确认；这些建议仅供参考，你仍可继续生成。
```

### 5.3 轨道列表和当前轨道

轨道列表中的 `Blocked` 标签改为“高优先级”或“需审阅”，保留 danger 主题。

当前轨道顶部不要直接输出内部 `reviewState`，统一映射为：

| reviewState | 用户文案 |
| --- | --- |
| `blocked` | 高优先级提醒 |
| `hasIssues` | 有审阅建议 |
| `passed` | 审阅通过 |
| `pending` | 待审阅 |

这些标签只表达审阅状态，不控制生成按钮的 disabled 状态。

## 6. i18n 要求

新增或调整的用户文案必须进入现有语言资源，不要继续在组件内增加硬编码英文。

建议使用统一命名空间：

```text
workbench.productionReview.state.pending
workbench.productionReview.state.passed
workbench.productionReview.state.hasIssues
workbench.productionReview.state.blocked
workbench.productionReview.severity.info
workbench.productionReview.severity.warning
workbench.productionReview.severity.blocking
workbench.productionReview.summary.open
workbench.productionReview.summary.highPriority
workbench.productionReview.summary.warning
workbench.productionReview.highPriorityHint
```

中文建议值：

| Key | zh-CN |
| --- | --- |
| `state.pending` | 待审阅 |
| `state.passed` | 审阅通过 |
| `state.hasIssues` | 有审阅建议 |
| `state.blocked` | 高优先级提醒 |
| `severity.info` | 提示 |
| `severity.warning` | 警告 |
| `severity.blocking` | 高优先级 |
| `summary.open` | 待处理 |
| `summary.highPriority` | 高优先级 |
| `summary.warning` | 警告 |
| `highPriorityHint` | 发现高优先级审阅建议。建议生成前确认；这些建议仅供参考，你仍可继续生成。 |

需要同步补齐项目当前支持的全部语言文件，并通过 `i18n:check`。

## 7. 错误处理

前端不应再包含以下专用分支或文案：

```text
Video generation is blocked by open production review issues
```

生成接口返回错误时：

1. 优先使用项目现有通用错误提取方法。
2. 展示后端返回的 `message`。
3. 参数校验错误按现有方式展示 `data.issues`。
4. 不根据 `reviewState` 或 `severity` 改写接口错误。

后端部署本次修复后，正常情况下不会再返回审阅阻塞专用 400。如果仍然出现该文案，应优先确认运行版本或构建产物是否已更新，而不是在前端绕过接口错误。

## 8. 验收清单

### 8.1 单条生成

- 当前轨道存在开放 blocking 建议时，点击生成仍会发出请求。
- `reviewState="blocked"` 时生成按钮仍可用。
- 合法请求调用 `/production/workbench/generateVideo`。
- 空提示词和结构化分镜事实缺失仍在前端阻止请求。
- 后端返回其他工程校验错误时，页面正常展示错误。

### 8.2 批量生成

- 已选轨道包含 blocking 建议时，仍提交完整批次。
- 不过滤 `reviewState="blocked"` 的轨道。
- 合法请求调用 `/production/workbench/batchGenerateVideo`。
- 未选择轨道、提示词为空或参数不完整时仍不发送请求。

### 8.3 审阅展示

- 页面不再出现 `Blocked`、“阻塞生成”或其他准入含义文案。
- blocking 建议仍以红色高优先级样式展示。
- 页面明确提示审阅建议仅供参考、可以继续生成。
- 用户仍可接受、忽略、反馈和重新审阅。
- 内部 `severity`、`reviewState` 和接口数据格式未发生变化。

### 8.4 前端验证命令

```powershell
yarn.cmd type-check
yarn.cmd build
yarn.cmd i18n:check
```

## 9. 实施边界

- 本次后端提交不修改任何前端源码。
- 前端实现时不要求后端新增接口或字段。
- 不修改生产审阅的生成、保存、接受、忽略和反馈流程。
- 不修改视频任务状态机、供应商调用或队列处理。
- 不以“非阻塞”为理由取消确定性的工程校验。
