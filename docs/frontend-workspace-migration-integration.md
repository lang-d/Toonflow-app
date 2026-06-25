# ToonFlow 作品库创建与旧数据迁移前端对接

## 背景

作品库选择现在拆成两个明确动作：

- 创建空作品库：新安装或用户只想选择一个空目录作为作品库。
- 迁移旧数据：用户明确选择把旧 ToonFlow 数据迁移到新的作品库。

前端不要再把“创建空作品库”提交到 `startMigration`。创建空作品库不进入任务中心、不展示“备份数据”、不进入维护页；成功后只提示重启。

## 目录选择

选择作品库目录：

```text
toonflow://selectDirectory?purpose=workspace
```

响应：

```ts
{
  ok: boolean;
  path: string | null;
  purpose: "workspace" | "projectImport";
}
```

用户取消时 `ok=false`，前端不展示错误。

## 状态接口

```text
POST /api/setting/storage/status
```

响应 `data`：

```ts
{
  mode: "legacy" | "workspace";
  workspacePath: string;
  appDataPath: string;
  profileDatabasePath: string;
  workspaceDatabasePath: string;
  projectCount: number;
  totalFiles: number;
  totalBytes: number;
  maintenance: boolean;
  activeTaskCount: number;
  restartRequired: boolean;
  selectionRequired: boolean;
}
```

字段说明：

- `selectionRequired=true`：首次安装，需要展示作品库选择向导。
- `maintenance=true`：旧数据迁移正在进行，前端应禁止生成、保存、删除和编辑。
- `restartRequired=true`：作品库创建或迁移完成后，需要提示用户重启。

## 校验目标目录

创建空作品库和迁移旧数据都先调用：

```text
POST /api/setting/storage/validateTarget
```

请求：

```ts
{ targetPath: string }
```

成功响应：

```ts
{
  targetPath: string;
  freeBytes: number;
  requiredBytes: number;
}
```

目标目录必须是新目录或空目录。后端会校验写权限、剩余空间、符号链接和路径逃逸。错误时直接展示后端 `message`。

## 创建空作品库

适用场景：

- 新安装没有健康旧数据。
- 用户点击“创建作品库”或“创建空作品库”。
- 用户选择 `D:\素材` 这类空目录作为新作品库。

流程：

```text
toonflow://selectDirectory?purpose=workspace
POST /api/setting/storage/validateTarget
POST /api/setting/storage/createWorkspace
```

请求：

```ts
POST /api/setting/storage/createWorkspace

{
  targetPath: string;
}
```

成功响应：

```ts
{
  workspacePath: string;
  restartRequired: true;
}
```

前端行为：

- 不创建任务中心任务。
- 不轮询迁移任务。
- 不显示“备份数据”。
- 不进入“作品库正在迁移或维护”页面。
- 成功后提示“作品库已创建，需要重启 ToonFlow 后生效”。
- 用户确认后调用：

```text
toonflow://appRestart
```

## 扫描旧数据

```text
POST /api/setting/storage/scanLegacy
```

响应 `data`：

```ts
Array<{
  path: string;
  databasePath: string;
  healthy: boolean;
  message: string;
  projectCount: number;
  mediaFiles: number;
  totalFiles: number;
  totalBytes: number;
  current: boolean;
}>
```

只有 `healthy=true` 的候选项才能用于迁移。旧目录在迁移成功后仍会保留。

## 迁移旧数据

适用场景：

- `scanLegacy` 找到健康旧数据。
- 用户明确点击“迁移旧数据”。

流程：

```text
POST /api/setting/storage/scanLegacy
toonflow://selectDirectory?purpose=workspace
POST /api/setting/storage/validateTarget
POST /api/setting/storage/startMigration
```

请求：

```ts
POST /api/setting/storage/startMigration

{
  targetPath: string;
  sourcePath: string;
}
```

`sourcePath` 必须来自 `scanLegacy` 的健康候选项。首次安装状态下如果不传 `sourcePath`，后端会拒绝启动迁移并提示改用 `createWorkspace`。

成功响应：

```ts
{
  taskId: string;
  status: "queued";
  restartRequired: true;
}
```

前端行为：

- 显示任务中心进度。
- 展示维护页。
- 禁止生成、保存、删除和编辑。
- 迁移完成后提示重启。

迁移阶段建议展示：

```text
backup            备份数据
split-database    拆分数据库
copy-media        复制素材
project-snapshots 整理项目
activate          启用作品库
restart-required  等待重启
```

## 首次安装推荐交互

1. 调用 `/api/setting/storage/status`。
2. `selectionRequired=true` 时展示作品库选择向导。
3. 同时调用 `/api/setting/storage/scanLegacy`。
4. 没有健康旧数据时，只展示“创建作品库”。
5. 有健康旧数据时，展示两个动作：“创建空作品库”和“迁移旧数据”。
6. “创建空作品库”调用 `createWorkspace`。
7. “迁移旧数据”调用 `startMigration`，且必须传 `sourcePath`。

## 错误处理

- `validateTarget` 报错时直接展示后端 `message`。
- `createWorkspace` 成功后只提示重启，不展示任务进度。
- `startMigration` 返回 `409` 时，提示用户等待当前活动任务完成。
- `maintenance=true` 只应对应旧数据迁移，不应出现在创建空作品库流程中。
