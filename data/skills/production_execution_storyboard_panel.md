---
name: production_execution_storyboard_panel
description: 阶段5执行规则：读取正式结构化分镜，激活图片 Prompt 技法，只写分镜面板图片派生字段。
---

# 阶段5：分镜面板图片派生写入

本技能只定义阶段流程、工具调用、事实源边界和禁止项。Prompt 生成方法全部由 `storyboard_prompt_techniques` 定义。

## 规则优先级

1. 正式 `tableRowJson` 中的 `StoryboardTableRow`。
2. 本阶段只写图片派生数据的边界。
3. `storyboard_prompt_techniques` 的 Prompt 编译方法。

`scriptPlan` 只提供全片视觉原则，不能覆盖或补写 `tableRowJson` 中的镜头事实。

## 必须激活的技法

开始生成图片 Prompt 前，必须调用 `activate_skill` 激活：

- `storyboard_prompt_techniques`

本阶段不得激活 `director_storyboard`，不得把画风手册中的固定质量词、英文示例、负向词块或示例剧情注入图片 Prompt。

## 唯一写入范围

本阶段只允许调用 `update_storyboard_panel_v2` 写入：

- `prompt`
- `shouldGenerateImage`
- `associateAssetsIds`
- `mode`

不得新增、删除、重排或重新分组分镜。不得修改 `tableRowJson` 或任何分镜事实。不得触发分镜图生成任务。

## update / replace 模式

默认使用 `mode: "update"`：

- 用于首次写入、补充提示词、普通局部优化。
- 覆盖当前分镜的 `prompt`、`shouldGenerateImage`、`associateAssetsIds`。
- 如果已有图片画布，后端只同步主生成节点提示词和引用信息，不清空探索节点，不清空最终图。

只有用户明确要求“重写、重新写入、清空重做、覆盖分镜图提示词和引用图”时，必须先停下向用户确认。

用户确认后才允许使用 `mode: "replace"`：

- replace 会清空该分镜已有图片结果和图片画布探索，从新的 `prompt` 与 `associateAssetsIds` 重新开始。
- replace 不删除分镜行本身。
- replace 不修改 `tableRowJson`、镜头事实、台词、时长、分组。
- replace 不触发生图任务；必须等待用户后续明确确认生成分镜图。

## 执行流程

1. 调用 `get_flowData("scriptPlan")`、`get_flowData("storyboard")` 和 `get_flowData("assets")`。
   - 任一 `get_flowData` 失败或超时，必须立刻停止并向用户报告；不得凭空补数据，不得继续调用 `update_storyboard_panel_v2`。
2. 只处理 `factStatus === "ready"` 且有合法 `tableRowJson` 的正式分镜。
3. 以真实 `storyboardId` 优先定位；缺少 id 时才使用 `index`。
4. 按 `storyboard_prompt_techniques` 将 `tableRowJson`、参考资产和导演视觉原则编译为图片 Prompt。
5. 调用 `update_storyboard_panel_v2` 写入图片派生字段。
6. 完成后只返回简短确认，并停止本阶段。
7. 必须等待用户明确确认后，才允许进入分镜图生成阶段。

## 阶段禁止项

- 不修改分镜事实。
- 不输出整表文本、标签化正文或完整结构文本。
- 不把聊天内容当作数据交接方式。
- 不生成旧的视频描述字段。
- 不启动图片生成任务。
- 不凭空增加结构化分镜中不存在的剧情、角色、台词、动作、场景状态或视觉状态。
- Base64 不进入 Agent 输出或数据库。
