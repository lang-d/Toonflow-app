# 剧本大文本前端对接

后端不再把剧本正文、故事骨架或改编策略保存在 SQLite 正文字段中。正文保存为项目 `text` 目录下的 UTF-8 Markdown 文件，接口通过文本资产元数据提供按需读取入口。

后端没有 5000 字业务限制。现有前端必须移除 `scriptEpisodeLength`、字符计数上限和超限禁用保存逻辑，否则页面仍会在请求到达后端前阻止保存。`100mb` 是 HTTP 请求体安全上限，不是剧本字数规则。

## 剧本列表

推荐请求：

```http
POST /script/getScrptApi
Content-Type: application/json

{
  "projectId": 12,
  "name": "",
  "includeContent": false
}
```

每项响应：

```ts
type TextAssetRef = {
  id: number;
  size: number;       // UTF-8 字节数
  hash: string;       // SHA-256
  updateTime: number;
};

type ScriptListItem = {
  id: number;
  name: string;
  contentAsset: TextAssetRef | null;
  extractState?: number | null;
  errorReason?: string | null;
  createTime?: number | null;
  relatedAssets: Array<{ id: number; name: string }>;
  assetExtraction?: unknown;
};
```

`includeContent` 省略或为 `true` 时，后端仍返回 `content`，用于兼容当前构建物。新前端必须使用 `false`，避免列表一次加载所有剧本正文。

## Script Agent 工作区

推荐请求：

```http
POST /scriptAgent/workspaceDetail
Content-Type: application/json

{
  "projectId": 12,
  "includeContent": false
}
```

响应数据：

```ts
{
  workspaceId: number;
  stageAssets: {
    storySkeleton: TextAssetRef | null;
    adaptationStrategy: TextAssetRef | null;
  };
  scripts: Array<{
    id: number;
    name: string;
    contentAsset: TextAssetRef | null;
  }>;
}
```

兼容模式下仍会返回 `storySkeleton`、`adaptationStrategy` 和各剧本的 `content`。元数据模式不返回这些正文属性，前端不能把“属性缺失”解释为内容为空。

## 按需读取正文

使用列表或工作区返回的文本资产 ID：

```http
POST /textAsset/getContent
Content-Type: application/json

{
  "projectId": 12,
  "id": 345,
  "offset": 0,
  "limit": 131072
}
```

响应：

```ts
{
  content: string;
  size: number; // 完整文件的 UTF-8 字节数
  eof: boolean;
}
```

循环读取时使用 `offset += response.content.length`，直到 `eof === true`。`offset` 和 `limit` 按字符串字符位置计算，`size` 是文件字节数，不能直接把 `size` 当作下一页 offset。

后端同时校验 `projectId` 和当前业务引用。跨项目资产、已被新版本替换的旧资产和已删除资产统一返回 404，前端不能保留旧资产 ID 作为版本历史入口。

## 保存与刷新

- `/script/addScript`、`/script/updateScript`、`/script/batchAddScript` 继续提交完整 `content`，请求结构不变。
- `/scriptAgent/saveWorkspaceStage` 和 `/scriptAgent/upsertScript` 同样继续提交完整 `content`。
- 保存成功后重新获取列表或工作区元数据，不要继续沿用旧 `contentAsset.id`。
- 打开编辑弹窗时再读取正文；关闭弹窗后可释放正文状态，列表只保留元数据。
- 空正文允许 `contentAsset` 为 `null`；编辑器按空字符串初始化。
- 文件缺失或损坏时显示后端错误并允许重试，不要用本地空文本覆盖服务器记录。

## 前端需要删除的限制

- `scriptEpisodeLength: 5000` 默认配置及设置项。
- `content.length > scriptEpisodeLength` 的保存禁用条件。
- 单集和批量添加页面上的 `当前字数/5000` 限制提示。
- 任何基于 5000 字对上传文本进行截断或拒绝的逻辑。

可以保留实时字数统计作为信息展示，但不能再作为保存条件。
