---
name: production_execution_storyboard_panel
description: 阶段5执行规则：从版本原生正式分镜中选择可信首帧，只写分镜图派生字段。
---

# 阶段5：分镜面板图片派生

## 职责

- 只把正式分镜事实转成单张分镜图 Prompt，并选择首帧真实可见的参考资产。
- 不重新拆镜，不修改正式 `tableRowJson` 或 `factRevision`，不生成视频 Prompt。
- V3 的 `shotDescription` 是时间顺序事实，不等于要求把完整动作过程画进一张图。

## 读取顺序

1. 用 `read_storyboard_panel_targets` 分页取得全部目标和 `snapshotId`。
2. 按同批 storyboardId 调用 `read_storyboard_panel_sources`。来源必须是 `ready`；Draft 或无效来源不能生成分镜图。该工具顶层返回当前正式导演规划的短 `videoStyle`，不读取导演规划全文。
3. 仅在需要确认资产外观时读取 `get_flowData("assets")`；禁止读取混合目标与来源的 `get_flowData("storyboard")`。
4. 激活 `storyboard_prompt_techniques`，按 index 逐条编译。
5. 调用 `update_storyboard_panel`，只写 `prompt`、`shouldGenerateImage` 和首帧可见的 `associateAssetsIds`。
6. 按工具返回的 `complete | partial`、实际更新 ID 和失败项判断本次写入；`partial` 时由模型分析失败目标并继续补写或报告，不得声称全部完成。

## V3 首帧选择

从 `shotDescription` 中选择“最早明确、可见，并能自然启动后续动作”的状态。允许的来源：

- 描述直接写明的初始位置、姿态、持物或正在进行的动作；
- 首个动作必然推出的最小前态；
- 相邻正式镜头已明确交接且本镜继续保持的状态。

不得补写未提供的精确站位、朝向、背景布局、后续才进入的人物/物件、动作完成结果或资产未提供的外形。不能因为后续状态更好画，就跳过最早可信状态另选中途帧或结束帧。

若最早状态已明确包含可见表情、视线、姿态或接触关系，图片 Prompt 必须保留该首帧事实。由触发事件才出现的微表情或反应属于后续视频变化，不得提前画入首帧；`voiceTone`、题材习惯和人物资产都不是补写视觉表演的依据。

`shotSize` 决定构图范围；`cameraAngle` 只有确实影响首帧构图时使用；`videoStyle` 只提供整集稳定媒介与视觉表现，不补充当前场景事实。

## 历史版本

V1/V2 原生使用 `picture` 作为静态首帧来源，不把 `picture + action` 拼成 V3，也不读取后续 action 另选画面。

## 资产子集

- `requiredAssets` 是本镜全过程可能用到的正式资产，不代表全部在首帧可见。
- `associateAssetsIds` 只绑定选定首帧中真实可见且确有外观约束作用的子集。
- 后续进入画面的人物、后续拿出的道具、画外声音来源不得提前绑定或写入图片 Prompt。
- `@ImageN` 与 `associateAssetsIds[N-1]` 必须一一对应。

## 无可信首帧

如果 V3 描述无法得到可信首帧、必要资产缺失，或参考图与首帧事实无法保守兼容：

- 调用 `update_storyboard_panel` 将该镜 `shouldGenerateImage` 设为 `false`；
- 报告 storyboardId/index、缺失的上游事实和原因；
- 归属为分镜表或资产问题，不在面板阶段脑补修复。

不得把轻微措辞偏好、可选机位留空当作阻断。
