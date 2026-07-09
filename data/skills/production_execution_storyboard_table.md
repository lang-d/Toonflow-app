---
name: production_execution_storyboard_table
description: 阶段4执行规则：读取剧本、导演规划和资产，激活分镜表技法，并通过结构化分批工具原子提交 StoryboardTableRow。
---

# 阶段4：结构化分镜表写入

本技能只定义执行流程、事实源边界、字段契约和禁止项。分镜设计方法、镜头连续性、资产选择、台词时长等细则放在 `storyboard_table_techniques` 与当前导演手册的 `director_storyboard_table_narrative` 中。

## 规则优先级

1. 后端结构化工具和 `StoryboardTableRow` 契约。
2. 本阶段的事实源边界和禁止项。
3. `storyboard_table_techniques` 与当前导演手册 `director_storyboard_table_narrative` 中的创作方法。

字段、工具、资产、状态、时长、`soundEffects`、分组契约以 `storyboard_table_techniques` 为准；题材拆镜、对话反应、节奏钩子以当前 `director_storyboard_table_narrative` 补充，但不得覆盖工程契约。

如果技法内容与本阶段工具边界冲突，只吸收创作方法，不采用旧输出格式或旧事实源；题材方法只能来自当前加载的导演叙事手册。

## 必须激活的技法

开始写分镜前，必须调用 `activate_skill` 激活：

- `storyboard_table_techniques`
- `director_storyboard_table_narrative`

激活后按技法完成拆镜、导演规划对齐、视觉连续性、资产引用、台词时长、转场与分组设计。
不得激活 `director_storyboard_table_style`；分镜表只继承 `scriptPlan` 中已确定的视觉方案。

## 唯一写入方式

分镜事实只能通过以下工具写入：

1. `begin_storyboard_table`
2. `append_storyboard_rows`
3. `commit_storyboard_table`

续接失败草稿时，先用只读工具 `get_storyboard_generation_draft` 按页读取原 generation；需要用户决定时调用 `await_user_decision`。这两个工具都不是分镜事实写入入口。

不得输出整张表文本、标签化正文、完整结构文本，或要求前端从聊天内容中恢复分镜事实。不得读取或生成旧的视频描述字段作为事实。

## 执行流程

1. 调用 `get_flowData` 读取 `script`、`scriptPlan`、`assets`。
2. 激活本阶段要求的通用分镜表技法与当前题材叙事技法。
3. 先从 `scriptPlan` 建立“场次执行映射”：
   - 表演出口 → `characters[].action` / `characters[].expression/gaze/handAction/posture/movement`；`visibleEmotion` 只写当前画面可见的情绪表现摘要。
   - 空间关系 → `characters[].spatialPosition`。
   - 镜头距离策略 → `shotSize` / `cameraMove`。
   - 连续性锚点 → `location` / `timeOfDay` / `picture` / `requiredAssets`。
   - 环境声 → `soundEffects`。
4. 再完成全局规划：
   - 总分镜数。
   - 全部分镜组。
   - 每组 `groupKey/groupName/groupIntent/storyboardIndexes`。
5. 调用 `begin_storyboard_table` 创建 generation。
6. 按 `index` 提交 5–10 条一批的 `StoryboardTableRow`。
7. 如果工具调用中断，可重试完全相同内容；同一 generation 内不得用不同内容覆盖已写入 index。
8. 全部 index 写满后调用 `commit_storyboard_table`。
9. 成功后只回复简短结果：`分镜表已完成，共 N 条分镜、M 个分组。`

## 提交失败处理

- `commit_storyboard_table` 返回 `committed` 时，才视为分镜表完成。
- `commit_storyboard_table` 返回 `invalid` 时，本轮写入立即锁定；不得再次调用 begin/append/commit，也不得新建 generation 绕过失败。
- `invalid` 后必须解释全部校验问题，给出明确调整方向，并调用 `await_user_decision` 提出一个具体问题；不得只输出工程字段名。
- 用户下一轮确认调整时，必须先按 `generationId` 调用 `get_storyboard_generation_draft` 读取失败草稿，再创建新 generation；不得把当前正式分镜表误当成失败草稿。
- `commit_storyboard_table` 返回 `failed`、`GENERATION_SUPERSEDED` 或 `COMMIT_IN_PROGRESS` 时，本轮必须停止并报告工程失败。
- 所有机器状态字段均使用小写：`writing / invalid / failed / committing / superseded / committed / expired`；`GENERATION_SUPERSEDED`、`COMMIT_IN_PROGRESS` 只作为 `error.code`，不是状态。
- 不得在同一轮里反复调用 `commit_storyboard_table`。
- 不得在同一轮里新建 generation 试图绕过失败。
- 遇到 `COMMIT_IN_PROGRESS` 时，只能回复：`提交仍被后端任务占用，请稍后重试或重新开始分镜表生成。`

## StoryboardTableRow 契约

每条分镜必须完整符合以下字段：

```ts
{
  version: 1;
  index: number;
  sceneNo?: string;

  groupKey: string;
  groupName: string;
  groupIntent: string;
  beatId: string;

  durationSec: number;

  location: string;
  timeOfDay: string;
  sceneContinuityId?: string;

  picture: string;
  shotSize: string;
  cameraMove: string;
  cameraAngle?: string;
  transitionFromPrevious?: string;

  action: string;

  characters: Array<{
    assetId?: number;
    name: string;
    action: string;
    orientation: string;
    spatialPosition: string;
    posture?: string;
    expression?: string;
    gaze?: string;
    handAction?: string;
    movement?: string;
  }>;

  visibleEmotion: string;

  dialogue: Array<{
    speaker: string;
    text: string;
    voiceTone?: string;
  }>;

  soundEffects: string[];

  requiredAssets: Array<{
    assetId: number;
    name: string;
    type: "role" | "scene" | "tool" | "clip";
    order: number;
  }>;
}
```

## 字段口径

| 创作含义 | 结构字段 |
|---|---|
| 画面描述 | `picture` |
| 场景 | `location` |
| 时长 | `durationSec` |
| 景别 | `shotSize` |
| 运镜 | `cameraMove` |
| 全局动作概述 | `action` |
| 角色动作 | `characters[].action` |
| 朝向 | `characters[].orientation` |
| 空间关系 | `characters[].spatialPosition` |
| 可见情绪 | `visibleEmotion` |
| 台词 | `dialogue` |
| 音效 | `soundEffects` |
| 关联资产 | `requiredAssets` |

## `visibleEmotion` 字段边界

`visibleEmotion` 不是剧情解读栏，也不是关系变化栏。它只写当前这一帧画面中能直接看见的情绪表现。

必须写：

- 面部：嘴角、眉眼、眼眶、咬唇、绷脸、低头、回避视线等。
- 身体：肩背、手部、呼吸、站姿、停顿、步伐、僵住、后退等。
- 语气出口：哽住、压低、急促、停顿、吞字等。

禁止写：

- “从 A 到 B 的情绪转换”“形成反差”“关系破裂”“内心复杂”“沉默但不说”等剧情解释。
- “安静——累了但不停”“王姨温和——和之前的大嗓门形成反差”这类带破折号的概括句。
- 台词内容、事件因果、人物心理判断。

示例：

- 不合格：`安静——从嘈杂到空旷的情绪转换`
- 合格：`脚步放慢，肩背松垮，视线落在空摊位上`
- 不合格：`王姨认真关心；林若溪沉默——被戳中但不说`
- 合格：`王姨身体前倾、眉心收紧；林若溪垂眼，嘴唇抿住`

## `scriptPlan` 到分镜字段映射

写入每条分镜前，必须先对齐导演规划：

| 导演规划字段 | 分镜字段 |
|---|---|
| 表演出口 | `characters[].action`、`characters[].expression/gaze/handAction/posture/movement`、`visibleEmotion` |
| 空间关系 | `characters[].spatialPosition`、`characters[].orientation` |
| 镜头距离策略 | `shotSize`、`cameraMove`、`cameraAngle` |
| 连续性锚点 | `location`、`timeOfDay`、`sceneContinuityId`、`picture`、`requiredAssets` |
| 环境声 | `soundEffects` |

不得把导演规划整段复制进 `picture` 或 `action`。分镜表要把导演规划拆成可拍摄的单镜事实。

## `requiredAssets` 口径

`requiredAssets` 不是“镜头主体列表”，而是画面生成需要保持一致的全部可辨识参考资产：

- 主体资产：镜头主要拍摄的角色、场景、道具或片段。
- 必要场景资产：画面所在空间可辨识时必须引用对应场景资产；有匹配场景衍生状态时优先引用衍生资产。
- 可辨识背景资产：背景里能看清的角色、场景区域、道具、衍生状态需要引用。
- 可辨识交互资产：角色手持、佩戴、触碰、遮挡、操作的道具或角色必须引用。

边界：

- 完全不可辨识的远景、模糊人群、抽象背景纹理、临时杂物不强制引用。
- assets 中不存在的对象不能编造 `assetId`；可以作为剧本事实写入 `picture` 或 `action`，但不能进入 `requiredAssets`。
- 同一父资产在单条分镜中不要同时引用父资产和匹配衍生资产；画面需要衍生状态时用衍生资产。
- `requiredAssets.order` 从 0 开始，主体资产优先，其次场景/背景/交互资产；同类镜头尽量保持稳定顺序。

## 分组硬规则

- `groupKey` 是机器 ID，必须使用 ASCII 稳定格式：`G01`、`G02`、`G03`……按分镜组顺序从 1 开始两位补零递增。
- 禁止把中文标题、动作词、事件名或分组名写入 `groupKey`；例如不得写 `围剿`、`反击`、`钩子`。
- `groupName` 才能写中文事件名或展示名；例如 `groupKey: "G01", groupName: "围剿"`。
- 分镜组是一次视频生成单元，不是场次。
- 单个场次可以拆成多个分镜组。
- 每组 `storyboardIndexes` 必须连续递增。
- 每组 `durationSec` 总和必须小于等于后端注入的项目默认视频模型最大支持时长。
- 跨场景、跨时间、跨连续事件目标或跨戏剧功能时必须新建分镜组。
- `storyboardIndexes` 必须完整覆盖全部分镜，不能重复或缺失。

## 阶段禁止项

- 不输出整张表文本或标签化正文。
- 不把聊天内容当作数据交接方式。
- 不生成图片 Prompt；图片 Prompt 属于阶段5。
- 不把聊天文本、展示文本、图片 Prompt、历史旧描述当作分镜事实。
- 不写 BGM 到 `soundEffects`；BGM 只可作为分镜组后期建议，由下游派生。
