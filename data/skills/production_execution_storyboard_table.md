---
name: production_execution_storyboard_table
description: 阶段4执行规则：读取剧本、导演规划和资产，激活分镜表技法，并通过结构化分批工具原子提交 StoryboardTableRow。
---

# 阶段4：结构化分镜表写入

本技能只定义执行流程、事实源边界、结构化写入契约和禁止项。拆镜方法、镜头连续性、机位串联、资产选择、台词时长、情绪表达等创作细则只看 `storyboard_table_techniques` 与当前导演手册的 `director_storyboard_table_narrative`。

## 规则优先级

1. 后端结构化工具和 `StoryboardTableRow` 契约。
2. 本阶段的事实源边界和禁止项。
3. `storyboard_table_techniques` 与当前导演手册 `director_storyboard_table_narrative` 中的创作方法。

工具、状态、唯一写入方式和失败处理以本技能为准；字段口径、资产锚定、时长、`soundEffects`、分组、机位串联和连续性以 `storyboard_table_techniques` 为准；题材拆镜、对话反应、节奏钩子以当前 `director_storyboard_table_narrative` 补充，但不得覆盖工程契约。

如果技法内容与本阶段工具边界冲突，只吸收创作方法，不采用旧输出格式或旧事实源；题材方法只能来自当前加载的导演叙事手册。

## 必须激活的技法

开始写分镜前，必须调用 `activate_skill` 激活：

- `storyboard_table_techniques`
- `director_storyboard_table_narrative`

激活后按技法完成拆镜、导演规划对齐、镜头串联、视觉连续性、资产引用、台词时长、转场与分组设计。
不得激活 `director_storyboard_table_style`；分镜表只继承 `scriptPlan` 中已确定的视觉方案。

## 唯一写入方式

分镜事实只能通过以下工具写入；`prepare_storyboard_table` 只保存本轮内存预演，不写数据库：

1. `prepare_storyboard_table`
2. `begin_storyboard_table`
3. `append_storyboard_rows`
4. `commit_storyboard_table`

续接失败草稿时，先用只读工具 `get_storyboard_generation_draft` 按页读取原 generation；需要用户决定时调用 `await_user_decision`。这两个工具都不是分镜事实写入入口。

不得输出整张表文本、标签化正文、完整结构文本，或要求前端从聊天内容中恢复分镜事实。不得读取或生成旧的视频描述字段作为事实。

## 执行流程

### 同一 Agent 内部预演

预演与正式分镜必须由当前 `storyboardTableAgent` 在同一次流式运行、同一份上下文中完成。禁止启动独立模型重复分析剧本。预演调用 `prepare_storyboard_table`，只保存在本轮工具闭包中，不写数据库，也不是用户可见的额外阶段。

- 先在内部建立剧情事实、情绪曲线、镜头功能、时长、轴线与连续性 ledger；`prepare_storyboard_table` 只提交正式写表必须锁定的紧凑结构，不重复提交完整画面、台词、动作、资产或情绪文本。
- 预演镜头 index 必须严格为 `0..N-1`；分组必须按顺序完整覆盖这些 index，不能遗漏、重复或越界。
- 仅当预演返回 `ready` 才能开始 generation；`begin_storyboard_table` 的总行数与 groups 必须原样使用工具返回值。
- 若单条不可分割长镜头超过动态模型能力，提交 `needs_user`，等待用户选择更换模型或明确授权重新设计镜头；不得先写表、自动拆镜或默认建议后期拼接。
- 写表期间若发现必须增加、删除、移动镜头或改变分组，停止追加，重新调用 `prepare_storyboard_table`，再重新 `begin_storyboard_table`。旧草稿由后端标记 superseded 并保留诊断；不得在旧 generation 上制造索引漂移。

1. 调用 `get_flowData` 读取 `script`、`scriptPlan`、`assets`。
2. 激活本阶段要求的通用分镜表技法与当前题材叙事技法。
3. 按 `storyboard_table_techniques` 建立剧情事实、情绪曲线、场景机位、站位连续性和镜头经济 ledger。
4. 调用 `prepare_storyboard_table` 提交连续 index、事件标识覆盖、预计整数时长、轴线侧、连续性承接、可切点、不可拆长镜与完整分组计划。
5. 使用准备工具返回的总行数与分组调用 `begin_storyboard_table`。
6. 按 `index` 提交 5–10 条一批的 `StoryboardTableRow`。
7. 如果工具调用中断，可重试完全相同内容；同一 generation 内不得用不同内容覆盖已写入 index。
8. 全部 index 写满后调用 `commit_storyboard_table`。
9. 成功后只回复简短结果；系统会自动启动独立只读审核。

## 审核后返修

当用户针对分镜表审核报告提出自然语言调整意见时，当前正式分镜表是唯一返修基线，不是失败草稿：

1. 先理解用户本轮自然语言。历史审核报告只作参考，不能把旧报告或上一次待办自动当成用户本轮的返修授权；语义不清时只追问，不创建 generation。
2. 用户明确提出新的分镜工作时，按新的工作目标读取当前事实，不继承旧审核返修范围。
3. 用户明确要求针对审核调整、指定某版为基线，或引用“刚才/上一份/那几个建议”时，先调用 `list_production_reviews` / `read_production_review` / `list_storyboard_generations` / `read_storyboard_generation` 定位并读取审核报告全文和基线版本。
4. 再调用 `get_flowData` 读取当前 `storyboard`、`scriptPlan` 与 `assets`，核对当前正式事实、用户要求和被指定的基线差异。
5. 新建 generation，并完整提交修订后的分镜表；不得用图片 Prompt、聊天文本、Memory 摘要、结构化 suggestion rows 或旧 `videoDesc` 恢复事实。
6. 未被用户要求调整的分镜必须保留既有结构化事实；只有被点名镜头及为轴线、站位、动作终态承接所必需的相邻镜头可以改写。
7. 不得自行扩大返修范围，不得在返修中启动分镜面板或分镜图生成；提交后由系统再次安排只读审核。

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

## StoryboardTableRow 写入契约

每条分镜必须通过工具写入完整 `StoryboardTableRow`。字段含义、填写边界和质量规则不在本执行层展开，统一遵守 `storyboard_table_techniques`。

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

## 阶段禁止项

- 不输出整张表文本或标签化正文。
- 不把聊天内容当作数据交接方式。
- 不生成图片 Prompt；图片 Prompt 属于阶段5。
- 不把聊天文本、展示文本、图片 Prompt、历史旧描述当作分镜事实。
- 不写 BGM 到 `soundEffects`；BGM 只可作为分镜组后期建议，由下游派生。
