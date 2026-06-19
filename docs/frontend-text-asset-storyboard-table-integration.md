# Toonflow 前端对接文档：大文本资产化与分镜表截断治理

## 1. 核心口径

后端已经完成兼容修复，现有 `getFlowData/saveFlowData` 路径不变。

本次变更后的事实源规则：

- `o_storyboard` 是分镜表事实源。
- `storyboardTable` 是后端根据结构化分镜重建出来的展示稿。
- `o_agentWorkData.data.storyboardTable` 仅作为历史草稿 fallback。
- Agent 原始长输出、分镜表展示稿、诊断报告等大文本会保存为文本资产文件，数据库只保存索引。
- 前端不要再把截断的 `storyboardTable` 当作事实源覆盖后端数据。

## 2. `getFlowData` 返回扩展

接口不变：

```txt
POST /api/production/getFlowData
```

请求不变：

```ts
{
  projectId: number;
  episodesId: number;
}
```

返回中新增：

```ts
{
  storyboardTable: string;
  storyboardTableMeta?: {
    source: "structured" | "draft" | "empty";
    rowCount: number;
    complete: boolean;
    hash: string;
    textAssetId?: number;
  };
  storyboard: Array<any>;
}
```

字段说明：

- `source="structured"`：后端从 `o_storyboard` 重建，可信。
- `source="draft"`：没有结构化分镜，只能展示历史草稿。
- `source="empty"`：没有分镜表。
- `rowCount`：后端识别到的表格行数。
- `textAssetId`：如果后端已经保存了完整展示稿文件，可用该 ID 分页读取。

前端建议：

- 分镜表展示优先使用 `storyboardTable`。
- 完整性判断优先看 `storyboardTableMeta.source` 和 `rowCount`。
- 如果 `source="draft"`，UI 可提示“当前为历史草稿，建议重新生成/整理分镜表”。
- 不再用前端本地缓存的旧 `storyboardTable` 覆盖接口返回结果。

## 3. `saveFlowData` 保存口径

接口不变：

```txt
POST /api/production/saveFlowData
```

请求结构不变，但前端需要注意：

- 可以继续提交原来的 `data`。
- 后端会自动忽略 `assets/storyboard/directorAssets/storyboardTableMeta` 等可重建大对象。
- 如果前端提交的 `storyboardTable` 行数少于后端结构化分镜行数，后端不会覆盖完整表。

响应现在可能返回 warning：

```ts
{
  code: 200;
  data: {
    warnings: string[];
  };
  message: string;
}
```

前端建议：

- 保存成功仍按 `code === 200` 处理。
- 如果 `data.warnings` 非空，可在开发调试区或轻提示展示。
- 不需要为了实时编辑效果频繁保存完整 Markdown 表。
- 分镜表编辑完成后，应该优先保存结构化分镜数据，而不是只保存 Markdown。

## 4. 文本资产读取接口

新增接口：

```txt
POST /api/textAsset/getContent
```

请求：

```ts
{
  projectId: number;
  id: number;
  offset?: number;
  limit?: number;
}
```

响应：

```ts
{
  code: 200;
  data: {
    content: string;
    size: number;
    eof: boolean;
  };
  message: string;
}
```

用途：

- 查看完整 Agent 原始输出。
- 查看完整分镜表展示稿历史版本。
- 查看长 prompt 诊断或审校报告。

前端建议：

- 普通页面默认不需要调用。
- 只有用户点击“查看完整输出 / 查看诊断文件 / 查看历史稿”时再分页读取。
- `offset/limit` 用于大文本分页，建议每次 64KB 到 128KB。
- 不要把读取出来的大文本再次塞回 `saveFlowData`。

## 5. 截断问题 UI 建议

当出现以下情况：

```ts
storyboardTableMeta.source === "structured"
storyboardTableMeta.rowCount === storyboard.length
```

说明后端已经从结构化分镜重建完整表，前端无需再提示截断。

当出现：

```ts
storyboardTableMeta.source === "draft"
```

说明当前只有历史草稿，前端可提示：

```txt
当前分镜表来自历史草稿，可能不完整。建议重新生成分镜表或重新写入结构化分镜。
```

当 `saveFlowData` 返回 warning：

```txt
Ignored incomplete storyboardTable (...)
```

说明前端提交的是短表，后端已保护完整结构化分镜。前端应刷新 `getFlowData`，以服务端返回为准。

## 6. 前端需要调整清单

必须调整：

- 读取 `storyboardTableMeta`，不要只判断 `storyboardTable` 文本长度。
- 保存后如果有 `warnings`，不要当失败处理。
- 避免把旧缓存中的短 `storyboardTable` 覆盖当前服务端返回。

建议调整：

- 分镜表展示以 `getFlowData.storyboardTable` 为准。
- 分镜数量以 `getFlowData.storyboard.length` 为准。
- 分镜表完整性以 `storyboardTableMeta` 为准。
- 对 `source="draft"` 做弱提示。
- 大文本详情页接入 `/api/textAsset/getContent`。

暂时不需要调整：

- 不需要修改 `getFlowData/saveFlowData` 路径。
- 不需要为了修复截断强行让前端自己拼 Markdown 表。
- 不需要把每次 Agent 流式输出都实时落成完整分镜表。

## 7. 联调验收

用当前 ep003 类似数据验证：

1. `getFlowData.storyboard.length` 返回完整结构化分镜数量，例如 61。
2. `getFlowData.storyboardTable` 展示完整 61 行，而不是历史截断 31 行。
3. `storyboardTableMeta.source === "structured"`。
4. 前端保存页面后，再刷新仍是完整表。
5. 如果前端提交短表，后端返回 warning，但刷新后完整表仍存在。
6. 点击查看文本资产时，`/api/textAsset/getContent` 能分页返回内容。

## 8. 注意事项

- 文本资产不是媒体资产，不走 `/oss`。
- 文本资产接口必须传 `projectId`，后端会做项目隔离。
- 文本资产内容只用于查看、诊断、历史稿，不是结构化业务事实源。
- 后续新功能如果产生超长文本，也应走文本资产，不要塞进 `o_agentWorkData/memories/o_tasks` 的大字段。
