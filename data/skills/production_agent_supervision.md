---
name: production_agent_supervision.md
description: >-
  Production Agent 监督层旧入口索引。活跃审核阶段已拆分为三份独立 Skill，本文件不再由阶段加载器执行。
---

# Production Agent 监督层兼容索引

当前活跃审核 Skill：

- 导演规划：`production_supervision_director_plan.md`
- 分镜表：`production_supervision_storyboard_table.md`
- 分镜面板：`production_supervision_storyboard_panel.md`

三份 Skill 分别维护本阶段的四遍审核协议、专业审核维度和报告边界。不要在本兼容索引中追加审核规则，避免重新形成跨阶段混合指令。

现有 `run_sub_agent_supervision({ prompt })` 工具契约保持不变，实际加载文件由 Production 阶段定义决定。
