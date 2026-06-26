---
name: production_execution_storyboard_table
description: 阶段4执行规则：读取剧本、导演规划和资产，激活分镜表技法，并通过结构化分批工具原子提交 StoryboardTableRow。
---

# 阶段4：结构化分镜表写入

本技能只定义执行流程、事实源边界、字段契约和禁止项。分镜设计方法、镜头连续性、资产选择、台词时长等细则放在 `storyboard_table_techniques` 与风格技法中。

## 规则优先级

1. 后端结构化工具和 `StoryboardTableRow` 契约。
2. 本阶段的事实源边界和禁止项。
3. `storyboard_table_techniques`、`director_storyboard_table_narrative`、`director_storyboard_table_style` 中的创作方法。

如果技法内容与本阶段工具边界冲突，只吸收创作方法，不采用旧输出格式或旧事实源。

## 必须激活的技法

开始写分镜前，必须调用 `activate_skill` 激活：

- `storyboard_table_techniques`
- `director_storyboard_table_narrative`
- `director_storyboard_table_style`

激活后按技法完成拆镜、导演规划对齐、视觉连续性、资产引用、台词时长、转场与分组设计。

## 唯一写入方式

分镜事实只能通过以下工具写入：

1. `begin_storyboard_table`
2. `append_storyboard_rows`
3. `commit_storyboard_table`

不得输出整张表文本、标签化正文、完整结构文本，或要求前端从聊天内容中恢复分镜事实。不得读取或生成旧的视频描述字段作为事实。

## 执行流程

1. 调用 `get_flowData` 读取 `script`、`scriptPlan`、`assets`。
2. 激活本阶段要求的通用技法与风格技法。
3. 先完成全局规划：
   - 总分镜数。
   - 全部分镜组。
   - 每组 `groupKey/groupName/groupIntent/storyboardIndexes`。
4. 调用 `begin_storyboard_table` 创建 generation。
5. 按 `index` 提交 5–10 条一批的 `StoryboardTableRow`。
6. 如果工具调用中断，可重试完全相同内容；同一 generation 内不得用不同内容覆盖已写入 index。
7. 全部 index 写满后调用 `commit_storyboard_table`。
8. 成功后只回复简短结果：`分镜表已完成，共 N 条分镜、M 个分组。`

## 提交失败处理

- `commit_storyboard_table` 返回 `committed` 时，才视为分镜表完成。
- `commit_storyboard_table` 返回 `invalid` 或 `failed` 时，必须立刻停止本阶段执行，并向用户报告简短失败原因。
- `commit_storyboard_table` 返回 `terminal: true`、`GENERATION_SUPERSEDED` 或 `COMMIT_IN_PROGRESS` 时，本轮必须停止；不得自动重新 `begin_storyboard_table`。
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
