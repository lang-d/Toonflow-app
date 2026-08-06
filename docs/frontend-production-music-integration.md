# 配乐模块前端对接

配乐页面不使用专用阶段状态接口。`POST /production/music/stage/state` 已删除，也不提供兼容或回退。

## 音乐模型选择与执行端点（2026-08）

本节优先于下方历史说明。前端只负责传递用户选择，后端负责验证并冻结实际执行模型；不得用 Prompt 版本的建议模型覆盖当前选择。

### 项目默认音乐模型

```ts
POST /production/music/model/default

// 读取（请求体不含 model）
{ projectId: number }

// 设置
{ projectId: number; model: "vendorId:modelName" }

// 清除
{ projectId: number; model: null }
```

响应 `data.musicModel` 为精确的 `vendor:modelName` 或 `null`。页面模型选择器必须保存原始模型键，不能保存显示名；选择后调用该接口设置项目默认值。不得在无默认值时静默选择目录中的第一项。

### 编译与生成

- `POST /production/music/library/compilePrompt`
- `POST /production/music/cue/compilePrompt`
- `POST /production/music/library/generate`
- `POST /production/music/cue/generate`

四个接口均接受可选 `model?: string`。后端使用顺序固定为：本次请求的精确模型 → 项目默认音乐模型；两者均不存在时返回 `data.code = "MUSIC_MODEL_REQUIRED"`，且不创建任务或候选。

Prompt 版本上的 `model` 只表示编译来源或历史建议，不是执行端点。`generic` 与 `modelSpecific` Prompt 均可在本次执行模型确定后生成，供应商请求契约由实际模型适配器检查。

统一任务的 `model`、任务 payload、Worker、候选版本都记录同一实际执行模型。任务和候选列表应展示该值对应的供应商，不能根据 Prompt 版本反推。

当前 `best:chirp-fenix` 已暂停：不出现在可用模型目录中。旧页面或缓存若仍提交它，后端在入队前返回 `data.code = "MUSIC_MODEL_UNAVAILABLE"`；前端应刷新模型目录并提示用户重新选择，不能静默切换到其他供应商。历史 Best Prompt、失败候选和审核记录仍可查看。

## Scope

| 范围 | isolationKey | Agent Run scriptId |
| --- | --- | --- |
| 项目配乐 | `musicProductionAgent:${projectId}:project` | `0` |
| 分集用乐 | `musicProductionAgent:${projectId}:episode:${scriptId}` | 实际 `scriptId` |

项目层的 `scriptId = 0` 只用于 Agent Run 查询；Music Bible、计划、作品库等项目资产接口不传该值。

## 页面恢复

进入页面、切换菜单、切换分集或 Socket 重连后，按下面顺序读取事实。Socket 事件仅用于即时更新，不能作为恢复来源。

1. `POST /agent/run/status`：读取该 Music Agent scope 的生命周期状态。
2. `POST /agent/run/detail`：读取 `timeline`、工具事件与最近一次模型 `agent_progress`。
3. `POST /task/status/snapshot`：读取异步任务。默认只返回活动任务；需要最近终态时传入 `includeTerminal: true`，可用 `targetTypes`、`taskIds`、`limit` 过滤。
4. 读取正式音乐资产接口：Bible、Plan、Cue、作品库、歌词、Prompt 和音频版本。
5. `POST /agents/getMemory`：恢复对话消息，不用 Memory 推断任务或资产事实。

`agent:run:update`、`agent_progress` 和任务 `targetType` 都是事实提示。页面按自身展示目标重新拉取相应业务接口，不使用后端返回的 `stage` 或 `refreshTargets` 映射。

常见任务 `targetType`：`musicBible`、`musicPlan`、`musicPrompt`、`musicLyrics`、`musicCueAsset`、`musicLibraryVersion`。前端可据此刷新对应业务数据，但不应将它们转换成另一套后端阶段枚举。

## 状态展示

- Run 生命周期来自 `/agent/run/status`：`running`、`awaiting_user`、`completed`、`failed`、`cancelled`、`interrupted`。
- `completed` 表示模型已经显式声明当前 Agent 回合完成；异步音乐任务仍需通过任务快照和音乐业务接口单独确认。
- `errorJson.code === "AGENT_TERMINAL_DECLARATION_MISSING"` 时，模型/供应商流在没有声明终态的情况下结束。前端显示现有失败态、重新读取 Run detail 与音乐数据，并允许用户显式重试；不得自动重发消息或把已入队任务视为失败。
- 当前业务进度来自 `/agent/run/detail.timeline` 中 `kind: "agent_progress"` 的最近事件。它包含模型提交的 `stage`、`subAgent`、`title`、`detail`、`phase`，不改变 Run 生命周期。
- timeline 的 `model_stream_finished` 与 `terminal_declaration_missing` 仅用于诊断，不与聊天消息混排，也不替代任务或音乐资产状态。
- 异步任务状态来自 `/task/status/snapshot`。`includeTerminal: true` 时按更新时间返回近期完成、失败或取消任务及 `reason`。

不要将 timeline 当成聊天消息混排：聊天按 Memory `createTime` 排序；timeline 按 event `createdAt` 排序，作为独立的执行轨迹显示。

## Prompt 与音频

Prompt 版本包含 `promptMode`：

- `generic`：无模型绑定，可以保存、编辑、复制、审核，并可作为后续模型专用版本的 `basedOnId`。
- `modelSpecific`：必须有精确 `vendor:model` 和实际 `profileSource`；其模型只表示该版本的编译来源。

通用 Prompt 与模型专用 Prompt 都可生成；生成接口必须传当前精确模型，或让后端使用项目默认模型。后端会在创建任务前用实际执行模型的适配器检查请求契约。

Music Agent 使用下列数据与执行工具：

- `list_available_music_models`、`read_music_model_profile` 查询真实模型和 Profile。
- `compile_generic_music_prompt`、`review_generic_music_prompt` 处理通用 Prompt。
- `compile_model_music_prompt`、`review_model_music_prompt` 处理模型专用 Prompt。
- `update_agent_progress` 报告业务进度。

用户指定模型时，Agent 先查询模型目录和 Profile；模型不存在或没有专用 Profile 时，由 Agent 根据用户意图选择通用 Prompt、说明配置缺失或等待用户决定。后端不会按模型名称、别名或缺省参数替 Agent 分流。

## 模型专用 Prompt 保存与审核

- 模型 Profile 可以声明 `requiredGenerationConfig`。前端提交 `modelSpecific` Prompt 时，必须把当前版本完整的 `generationConfig` 一并提交，只覆盖用户实际修改的字段；不能只回传时长后删除模型字段。
- 切换 `model` 或 `profileSource` 时不得复用旧模型配置，应重新调用模型专用编译接口。后端只会在 `basedOnId`、`promptMode`、`model` 和 `profileSource` 都一致时机械保留基础版本配置。
- 保存接口返回 `400` 且 `data.code === "MUSIC_PROMPT_CONFIG_INVALID"` 时，读取 `data.missingRequiredConfigKeys` 并提示重新编译。前端不得猜测或补造这些字段。
- `POST /production/review/list` 返回的审核项必须完整显示 `message`、`reason` 和 `proposedAction`；不能只显示摘要 `message`。阻断项的原因与建议来自审核模型，不由前端或后端拼接。
- `passed` 只表示该精确 Prompt 版本可被显式生成。仅用户调用音频生成接口后才会创建任务和候选音频版本；任务完成后再通过任务快照和音乐库详情刷新版本列表。
- 历史上缺少模型 Profile 必填配置的版本保持历史记录。不要在客户端补写 `title`、`tags` 等字段；重新编译后使用新版本。

## 计划推荐

音乐计划可包含可选 `recommendedProduction`：`workKey`、`editionKey`、`reason`。后端只解析这些键是否对应真实作品和编曲版本；任一键无法解析时返回 `null`，不会补选其他作品或版本。

## 音频目标时长与实际时长

- 对 `durationControl: "targetOnly"` 的模型，`generationConfig.durationSec` 是创作目标，不是供应商承诺的精确成品时长。
- 页面应显示“目标约 N 秒，实际时长由模型决定”，不得显示“模型将生成 N 秒”。需要严格长度时，由用户对完成版本显式调用现有裁剪流程。
- 音乐库版本的 `generationDurationSec` 在完成后表示后端从实际媒体探测到的秒数；`generationConfig.durationSec` 和 `effectiveMusicDurationSec` 继续表示请求目标与建议用乐时长。
- 后端会在正式资产落库前校验媒体可解码性和模型声明的最长时长。超限输出进入 `failed`，不会显示为可选完成版本。
- 前端不得根据目标时长覆盖播放器的媒体时长；播放器仍以音频文件元数据为准。

## 候选版本与裁剪

- 一次生成请求可能返回多个候选音频。后端将每个媒体校验通过的候选分别保存为同一编曲版的独立音乐库版本；不按实时长、标签或其他后端规则自动选择其中任一个。
- 任务 `result` 可含 `libraryVersionIds`、`musicCueAssetIds`、`candidateCount` 与 `failedCandidates`。页面在任务终态后仍要重新读音乐库详情，以它作为最终版本列表。
- 候选版本应供用户试听和显式“选为当前版本”。严格时长由用户显式发起裁剪；裁剪面板的默认选区应为 `0 ~ min(目标秒数, 实际秒数)`，不应自动生成、裁剪或选中衍生版本。

### 下载候选音频

项目音乐库候选和分集 Cue 候选均使用同一个二进制下载接口：

```ts
POST /production/music/download

{
  projectId: number;
  targetType: "libraryVersion" | "cueAsset";
  targetId: number;
}
```

- `libraryVersion` 适用于原始生成版本，也适用于裁剪后生成的版本；裁剪完成后重新读取音乐库详情，并将新版本作为普通 `libraryVersion` 下载，不需要根据 `derivationType` 分支。
- `cueAsset` 适用于分集 Cue 的直接生成候选。仅当候选为 `complete` 且具备可播放音频时显示下载入口。
- 响应是音频二进制流，包含 `Content-Type`、`Content-Length` 与 `Content-Disposition`；服务端会暴露这些响应头供跨域 Web 页面读取。前端用认证请求获取 Blob，优先使用 `Content-Disposition` 中的 `filename*` 作为保存名；缺失时可按候选版本号和响应 `Content-Type` 生成回退名。
- 当前 `@/utils/axios` 响应拦截器只返回 `response.data`，无法读取下载文件名。下载逻辑应使用原生 `fetch` 或独立 Axios 实例发送同样的 `Authorization` 请求头，以同时取得 Blob 与响应头；错误响应仍按现有 `{ code, message, data }` 解析。
- 创建临时对象 URL 后触发浏览器下载，并在触发后释放该 URL。不要直接依赖 OSS/媒体 URL 的 `download` 属性，也不要把下载操作视为选择版本、绑定 Cue 或裁剪操作。

## Socket

- 会话必须使用上表中的 isolation key，并使用独立 Socket Manager（`isolated: true`）。
- 路由卸载、菜单切换、分集切换不得发送 `disconnect()` 或 `stop()`；只有用户明确停止、登出或应用退出时释放会话。
- 重新连接后先完成 `updateContext`，再使用通用恢复链读取 Run、Timeline、任务和业务资产。
