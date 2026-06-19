---
name: production_execution_storyboard_panel
description: 阶段5执行规则：读取正式结构化分镜，激活图片 Prompt 技法，只写图片派生字段。
---

# 阶段5：分镜面板图片派生写入

本技能只定义阶段流程、工具调用、事实源边界和禁止项。Prompt 生成方法放在 `storyboard_prompt_techniques` 与风格专属 `director_storyboard` 中。

## 规则优先级

1. 正式 `tableRowJson` 中的 `StoryboardTableRow`。
2. 本阶段只写图片派生数据的边界。
3. `storyboard_prompt_techniques` 和 `director_storyboard` 的 Prompt 方法。

如果技法内容与本阶段边界冲突，只采用 Prompt 方法，不采用旧事实源或旧输出格式。

## 必须激活的技法

开始生成图片 Prompt 前，必须调用 `activate_skill` 激活：

- `storyboard_prompt_techniques`
- `director_storyboard`

激活后按技法完成内容忠实、首帧识别、参考图标注、朝向与空间连续、画质约束和逐字段校验。

## 唯一写入范围

本阶段只允许调用 `update_storyboard_panel_v2` 写入：

- `prompt`
- `shouldGenerateImage`
- `associateAssetsIds`

不得新增、删除、重排或重新分组分镜。不得修改 `tableRowJson` 或任何分镜事实。不得触发分镜图生成任务。

## 执行流程

1. 调用 `get_flowData("storyboard")` 和 `get_flowData("assets")`。
2. 只处理 `factStatus === "ready"` 且有合法 `tableRowJson` 的正式分镜。
3. 以真实 `storyboardId` 优先定位；缺少 id 时才使用 `index`。
4. 根据结构化分镜对象生成图片 Prompt：
   - `picture`
   - `location`
   - `shotSize`
   - `action`
   - `characters[].action`
   - `characters[].orientation`
   - `characters[].spatialPosition`
   - `visibleEmotion`
   - `requiredAssets`
5. 调用 `update_storyboard_panel_v2` 写入图片派生字段。
6. 完成后只返回简短确认，并停止本阶段。
7. 必须等待用户明确确认后，才允许进入分镜图生成阶段。

## 图片参考规则

- `associateAssetsIds` 只保存真实资产 ID，顺序必须与 Prompt 中引用顺序一致。
- Base64 不进入 Agent 输出或数据库。
- Prompt 中的角色、场景、道具必须能追溯到 `requiredAssets` 或结构化画面事实。
- 不得把台词和音效扩写成画面内容；只有当结构化字段明确出现可见动作或可见物件时才写入画面。

## 阶段禁止项

- 不修改分镜事实。
- 不输出整表文本、标签化正文或完整结构文本。
- 不把聊天内容当作数据交接方式。
- 不生成旧的视频描述字段。
- 不启动图片生成任务。
- 不凭空增加结构化分镜中不存在的剧情、角色、台词、动作、场景状态或视觉状态。
