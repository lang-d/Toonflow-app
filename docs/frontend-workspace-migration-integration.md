# Toonflow 作品库与工程迁移前端对接文档

## 1. 基本口径

- 应用数据、用户配置和作品库由后端分开管理。
- 前端不得自行拼接数据库路径、项目媒体磁盘路径或修改 `runtime.json`。
- 目录选择必须调用 Electron 安全协议。
- 作品库迁移和项目导入均为统一后台任务，使用现有 `task:status` 与 `/api/task/status/snapshot`。
- 迁移完成后必须提示用户重启，不要在当前进程内继续写新作品库。

## 2. 目录选择

选择作品库：

```text
toonflow://selectDirectory?purpose=workspace
```

选择待导入项目目录：

```text
toonflow://selectDirectory?purpose=projectImport
```

响应：

```ts
{
  ok: boolean;
  path: string | null;
  purpose: "workspace" | "projectImport";
}
```

用户取消时 `ok=false`，不显示错误提示。

打开后端返回的作品库或项目目录：

```text
toonflow://openDirectory?path=<encodeURIComponent(absolutePath)>
```

只允许打开 Toonflow 当前作品库或应用数据目录内的文件夹。

## 3. 作品库状态

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

- `selectionRequired=true`：全新安装，应展示首次作品库选择。
- `mode=legacy`：当前仍在旧混合数据目录运行，可提示迁移。
- `maintenance=true`：禁用所有生成、保存和删除操作。
- `restartRequired=true`：迁移已完成，展示重启按钮。

## 4. 扫描旧数据

```text
POST /api/setting/storage/scanLegacy
```

响应 `data` 为候选数组：

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

只允许选择 `healthy=true` 的候选进行迁移。旧目录在迁移成功后仍会保留。

## 5. 校验目标目录

```text
POST /api/setting/storage/validateTarget
```

请求：

```ts
{ targetPath: string }
```

成功：

```ts
{
  targetPath: string;
  freeBytes: number;
  requiredBytes: number;
}
```

目标必须是全新目录或空目录。后端会校验写权限、空间、符号链接和路径逃逸。

## 6. 开始迁移

```text
POST /api/setting/storage/startMigration
```

请求：

```ts
{
  targetPath: string;
  sourcePath?: string;
}
```

- 从扫描结果迁移时传 `sourcePath`。
- 迁移当前作品库时可省略 `sourcePath`。

成功：

```ts
{
  taskId: string;
  status: "queued";
  restartRequired: true;
}
```

活动供应商任务存在时返回 HTTP `409`。本地 `queued` 任务不属于供应商活动任务，可由用户先取消。

任务阶段：

```text
backup
split-database
copy-media
project-snapshots
activate
restart-required
```

迁移期间 API 对普通写请求返回：

```ts
{
  code: 503;
  data: { maintenance: true };
  message: "Workspace migration is in progress";
}
```

任务完成后调用：

```text
toonflow://appRestart
```

## 7. 准备复制单个工程

```text
POST /api/project/preparePortableCopy
```

请求：

```ts
{ projectId: number }
```

响应：

```ts
{
  taskId: string;
  status: "queued" | "processing";
  directory: string;
}
```

等待任务 `completed` 后再开放“打开目录/复制工程”。项目目录包含：

```text
manifest.json
project.toonflow
media/
```

不要在快照任务完成前提示用户复制。

## 8. 导入单个工程

1. 调用 `toonflow://selectDirectory?purpose=projectImport`。
2. 将返回目录提交：

```text
POST /api/project/importPortableProject
```

```ts
{ sourceDirectory: string }
```

响应：

```ts
{
  taskId: string;
  status: "queued";
}
```

完成事件的 `result`：

```ts
{
  projectId: number;
  importedAsCopy: boolean;
  directory: string;
  warnings: string[];
}
```

项目 ID 冲突时后端自动导入为副本。导入文件中的活动任务会被标记为中断，不会重新提交供应商。

## 9. 首次启动交互

推荐顺序：

1. 获取 `/setting/storage/status`。
2. `selectionRequired=true` 时展示作品库向导。
3. 同时调用 `/setting/storage/scanLegacy`。
4. 有健康旧数据时提供“迁移旧数据”；否则提供“创建空作品库”。
5. 选择目标目录并调用 `validateTarget`。
6. 调用 `startMigration`，使用统一任务中心展示进度。
7. 完成后重启。

设置页应长期提供：

- 当前作品库路径及空间占用。
- 打开作品库。
- 迁移作品库。
- 导入工程。
- 项目内“准备复制工程”。

## 10. 联调验收

- 首次选择 D/E 盘后，重启仍使用同一路径。
- 旧版目录能显示项目数、媒体数、大小和健康状态。
- 有 `submitting/processing/confirming` 任务时迁移按钮被阻止。
- 迁移进度由任务事件驱动，不新增定时高频轮询。
- 迁移失败后当前作品库仍可继续使用。
- 准备复制完成前不可打开复制目录。
- 导入副本后图片、音频、视频和画布可正常访问。
- 前端不读取或展示 `profile.sqlite`、`workspace.sqlite`、`project.toonflow` 内容。
