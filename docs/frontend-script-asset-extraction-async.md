# 剧本资产提取异步接口对接说明

## Summary

`POST /api/script/extractAssets` 已改为统一任务中心异步接口。前端点击“提取资产”后不等待资产结果，应该注册返回的每个 `taskId`，通过任务中心监听任务状态，任务结束后再刷新业务数据。

## Start Extraction

请求保持不变：

```json
{
  "projectId": 1,
  "scriptIds": [1, 2, 3, 4, 5, 6],
  "groupSize": 5
}
```

后端规则：

- `groupSize` 默认 `5`。
- 允许范围为 `1-5`。
- 后端会按最多 5 个剧本一个任务拆分。
- 某个任务失败只影响本组剧本，不影响其他组。

响应：

```json
{
  "total": 2,
  "tasks": [
    {
      "scriptIds": [1, 2, 3, 4, 5],
      "taskId": "uuid",
      "legacyTaskId": 123,
      "status": "queued",
      "targetType": "scriptAssetExtraction",
      "targetId": "1,2,3,4,5"
    }
  ],
  "skipped": [
    {
      "scriptId": 6,
      "reason": "active_task_exists"
    }
  ]
}
```

## Status Contract

新状态契约统一使用任务中心状态：

```text
queued | processing | completed | failed | cancelled
```

前端不要再用 `o_script.extractState` 作为长任务生命周期判断。`extractState` 只作为旧页面兼容字段保留。

建议任务中心 domain：

```text
scriptAssetExtraction
```

建议显示名：

```text
剧本资产提取
```

## Result Retrieval

任务中心只负责状态通知，不作为业务数据源。

当某个 `scriptAssetExtraction` 任务进入 `completed` 或 `failed` 后，前端调用：

```text
POST /api/script/getScrptApi
```

重新获取脚本列表、关联资产、失败原因和当前活跃提取任务。

`getScrptApi` 中每个脚本会包含：

```json
{
  "assetExtraction": {
    "status": "queued",
    "taskId": "uuid",
    "legacyTaskId": 123,
    "reason": ""
  }
}
```

没有活跃提取任务时：

```json
{
  "assetExtraction": null
}
```

## Notes

- `o_tasks.resultJson` 只保存轻量摘要，例如 `scriptIds/createdAssetIds/reusedAssetIds/assetCount`。
- 最终业务结果始终以 `/script/getScrptApi` 和资产业务接口为准。
- `skipped.reason = active_task_exists` 表示该剧本已经有活跃提取任务，前端可以提示“已有提取任务进行中”或静默忽略。

