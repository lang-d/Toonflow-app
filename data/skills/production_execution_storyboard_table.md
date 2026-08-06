---
name: production_execution_storyboard_table
description: 阶段4执行规则：以 StoryboardTableRow V3 分批写入并原子提交正式分镜表。
---

# 阶段4：结构化分镜表写入

本 Skill 只定义事实读取、V3 写入契约、工具顺序和失败处理。拆镜、景别、时长与连续性方法来自 `storyboard_table_techniques`；题材 Skill 只补充该题材必须可见的事实、因果、关系和状态。

## 职责与事实来源

- 只生成或返修分镜表，不生成分镜图、图片 Prompt、视频 Prompt 或资产。
- 剧本决定事件、动作、台词和因果；正式导演规划提供场面目标、必要空间约束和连续性基线；正式资产只提供可引用 ID。
- 返修时读取指定 generation/revision、完整审核报告和全部授权问题，不用 Memory 摘要替代正式内容。
- 不把导演分析、轴线预演、视觉说明或旧 `videoDesc` 填入逐镜事实。
- 激活 `storyboard_table_techniques` 与当前 `director_storyboard_table_narrative`；不得加载废弃视觉分镜 Skill。

## V3 正式结构

```ts
type StoryboardTableRowV3 = {
  version: 3;
  index: number;
  sceneNo?: string;
  groupKey: string;
  beatId: string;
  durationSec: number;
  location: string;
  timeOfDay: string;
  sceneContinuityId?: string;
  shotDescription: string;
  shotSize: string;
  cameraMove?: string;
  cameraAngle?: string;
  transitionFromPrevious?: string;
  dialogue: Array<{ speaker: string; text: string; voiceTone?: string }>;
  soundEffects: string[];
  requiredAssets: Array<{
    assetId: number;
    name: string;
    type: "role" | "scene" | "tool" | "clip";
    order: number;
  }>;
};
```

V3 禁止出现 `picture`、`action`、`characters`、`visibleEmotion`、行级 `groupName` 或行级 `groupIntent`，也不得把这些字段编码进字符串。

`groupKey` 是稳定 ASCII 标识。展示名称和组意图属于正式 group plan，不重复写进每一行。

`shotDescription` 按自然时间顺序写：

```text
最早成立的可见状态 → 触发 → 连续变化 → 结束状态
```

最早状态可以直接写明，也可以使用首个动作必然推出的前态，或相邻正式镜头已明确交接且本镜继续保持的状态。不得因此补写未提供的精确站位、朝向、背景布局、后续才出现的人物或物件、动作结果以及资产没有提供的外形细节。

人物反应只有在关系位移、信息接收、判断、克制、犹豫、态度翻转或情绪失控等关键转折中承担新增信息时，才写入 `shotDescription`。将其写成触发后的视线、面部、呼吸、手部或姿态变化及可继承结果；不另设情绪标签，不为普通对白补表情，也不把一整套表演清单编码进字符串。

## 准备与写入

1. 读取 `script`、`scriptPlan`、`assets`；先依据通用技法完成拆镜和分组。景别选择、对白画面处理和时长估算的唯一技法来源是 `storyboard_table_techniques`。
2. 调用 `prepare_storyboard_table`，只提交：

```ts
{
  status: "ready" | "needs_user";
  summary: string;
  shots: Array<{ index: number; estimatedDurationSec: number }>;
  groups: Array<{
    groupKey: string;
    groupName: string;
    groupIntent: string;
    storyboardIndexes: number[];
    estimatedDurationSec: number;
  }>;
}
```

3. `needs_user` 时说明真实缺口并等待，不创建 generation。`ready` 时调用无重复参数的 `begin_storyboard_table`。
4. 从 index 0 起按后端 `nextIndex`，每批 5–10 行调用 `append_storyboard_rows`；中断重试只能重送完全相同的批次。
5. 全部行写入后，本 generation 只调用一次 `commit_storyboard_table`。返回 `committed` 后立即调用 `inspect_storyboard_table_change`，由模型根据用户目标判断本次正式写入是否符合意图；有问题时读取所需正式版本，重新 prepare 并写入一个新 generation，再次检验。检验工具只返回事实，不替模型判断正确性。

分组只服从连续行动和真实切点，不以填满模型最大时长为目标。

## 写入前自检

- 每镜只有一个清楚的视觉中心和一个可连续理解的主要行动；独立行动不得为凑时长硬并。涉及可读视觉载体时，不得同时把载体内容和另一人物的独立反应或行动硬塞同镜。
- 一个连续动作不得因装饰性换景别被重复拆写；相邻镜头不得重复同一动作。连续静场若没有各自新增事实、动作结果、必要反应或空间/声音交接，应合并或缩短。
- 台词、必要停顿、可见反应和动作能在 `durationSec` 内完成。
- 关键反应已写成可见表演链；若它与完整动作不能在当前景别和时长内同时清楚呈现，已选择自然切点或真正优先的信息。
- `shotDescription` 的开头能成为单帧起点，结尾能与下一镜自然承接。
- 景别服务本镜新增信息，连续中景不是默认答案。
- `requiredAssets` 只使用当前项目正式资产 ID；台词原文、说话者和顺序保持不变。

## 失败处理

- prepare 结构失败：读取 `phase=prepare` 和全部 issues，修正准备数据；此时尚未创建 generation。
- begin/append/commit 失败：报告返回的真实 phase、generationId 和 issues，不把它描述成未发生的数据库或网络故障。
- commit 返回 `invalid` 后，本轮停止所有分镜写入；归并问题并等待用户决定，不新建 generation 逃避当前错误。
- commit 返回 `failed` 后立即停止并报告真实错误。
- commit 成功而审核失败时，正式 Revision 已保留，只重试审核，不重写分镜表。
- 如果整轮没有调用 `prepare_storyboard_table`，这是没有发起写入尝试，不得描述为 commit 失败，也不得自动重跑模型。

完成后只报告 revision、行数、分组数和模型对检验事实的结论，不在聊天中复制整张分镜表。

不得激活已废弃的 `director_storyboard_table_style` 或 `director_storyboard`。
