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

本阶段不决定项目画风。分镜图 Prompt 的空间、可见性和静态画面规则是通用规则；具体媒介、材质、色彩、渲染方式和风格锚词必须来自当前项目已激活的 art skill 或 `scriptPlan`。

## 事实源边界

- `tableRowJson` 是当前镜头事实唯一来源：人物、动作、朝向、空间关系、景别、场景、可见道具和可见情绪都以它为准。
- `assets` 只提供外观、基础设定和可用参考图；不得从资产描述里新增本镜头没有出现的动作、道具状态、人物关系或剧情信息。
- `scriptPlan` 只提供短视觉原则和已经确定的场景视觉状态；不得用导演规划补写 `tableRowJson` 中没有的逐镜光线、机位、动作或心理解释。
- `dialogue` 和 `soundEffects` 不直接进入图片 Prompt；除非它们已经在 `picture/action/characters` 等视觉字段中转化为可见动作、物件或状态。

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
   - 如果 `tableRowJson` 中存在单张图无法同时成立的空间冲突，不得硬塞全部信息；必须选择当前镜头最核心、最可见的画面事实。
   - 被舍弃的信息不得写入 Prompt，也不得回写分镜表；它只能由其他分镜或后续人工调整处理。
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

## Prompt 自检流程

阶段5写入前必须先自检 Prompt，而不是把自然语言剧情描述直接写入。

1. 先为每条正式分镜生成候选 Prompt。
2. 按 `storyboard_prompt_techniques` 逐条自检候选 Prompt。
3. 如果发现时间推进、心理解释、声音内容、否定解释句或双机位冲突，必须先重写该条 Prompt。
4. 自检通过后再调用 `update_storyboard_panel_v2` 写入。
5. 自检和重写都不得修改 `tableRowJson`，不得重写分镜表，不得启动分镜图生成。
6. 重写时必须保持 `associateAssetsIds` 不因文字裁剪而丢失画面仍可见的背景资产、交互道具或衍生资产。
