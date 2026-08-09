# 前端对接：视频统一任务状态

本次后端重构不改变生成、批量生成和取消接口，也不要求新增前端流程。前端继续使用接口返回的统一 `taskId` 订阅任务中心状态；`queueTaskId` 仅用于旧视频任务明细兼容。

## 状态显示

前端应以统一任务事件的 `status / phase / progress` 为准：

| 字段 | 值 | 建议显示 |
| --- | --- | --- |
| `status` | `queued` | 排队中 |
| `phase` | `remote_unavailable` | 等待云端实例恢复 |
| `phase` | `remote_unavailable_reconcile` | 正在确认云端实例状态 |
| `phase` | `remote_reconcile` | 正在确认云端任务是否仍存在 |
| `status` | `processing` | 处理中 |
| `status` | `completed` | 已完成 |
| `status` | `failed` | 生成失败，并显示 `reason` |

## `progress=null`

`null` 表示供应商没有提供可信百分比，不等于 `0`，也不等于“沿用旧值”。前端应显示不定进度动画或只显示阶段文本。

合并增量事件时必须判断字段是否存在，并保留显式 `null`：

```ts
if (Object.prototype.hasOwnProperty.call(incoming, "progress")) {
  current.progress = incoming.progress; // number | null
}
```

不要使用下面的写法：

```ts
current.progress = incoming.progress ?? current.progress;
```

后一种写法会在 Zealman 明确返回 `null` 时恢复旧的伪进度。

## 接口兼容

- 单项生成响应仍包含 `videoId / taskId / queueTaskId`。
- 批量生成的每一项仍包含 `videoId / trackId / taskId / queueTaskId`。
- 取消接口和请求结构不变；只允许取消尚未提交供应商的本地排队任务。
- 不再需要前端读取 `o_videoGenerationTask.status` 推断任务生命周期。

