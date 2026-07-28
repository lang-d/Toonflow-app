import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRIPT_SUB_AGENT_TOOL_NAMES } from "../src/agents/scriptAgent/toolPolicy";

const root = path.resolve(__dirname, "..");
const skillsRoot = path.join(root, "data", "skills");
const read = (name: string) => fs.readFileSync(path.join(skillsRoot, name), "utf8");

const files = {
  decision: read("script_agent_decision.md"),
  skeleton: read("script_execution_skeleton.md"),
  adaptation: read("script_execution_adaptation.md"),
  script: read("script_execution_script.md"),
  supervision: read("script_agent_supervision.md"),
};

test("rebuilt Script Agent skills exclude retired transport and fixed-formula contracts", () => {
  const all = Object.values(files).join("\n");
  assert.doesNotMatch(all, /<storySkeleton>|<adaptationStrategy>|<scriptItem>|<scriptData>/);
  assert.doesNotMatch(all, /get_planData|set_planData_|insert_script_to_sqlite/);
  assert.doesNotMatch(all, /关键词路由|前端回写|前端页面/);
  assert.doesNotMatch(all, /150\s*字\s*\/\s*分钟|150\s*字每分钟|每集\s*\d+\s*字/);
  assert.doesNotMatch(all, /10%|30%|50%|70%|90%|情绪[^\n]{0,8}\d+%/);
  assert.doesNotMatch(all, /A\s*\/\s*B\s*\/\s*C\s*\/\s*D|A、B、C、D/);
  assert.doesNotMatch(all, /情绪高于逻辑|情绪压过逻辑/);
});

test("decision skill separates intent, authorization, delegation, and Run terminal state", () => {
  assert.match(files.decision, /新建某项产物/);
  assert.match(files.decision, /局部或整体修订/);
  assert.match(files.decision, /删除指定剧本/);
  assert.match(files.decision, /审核故事骨架、改编策略或剧本/);
  assert.match(files.decision, /必须保留的事实、段落、场次和命名/);
  assert.match(files.decision, /审核结果只构成问题记录和修复建议/);
  assert.match(files.decision, /complete_agent_run/);
  assert.match(files.decision, /await_user_decision/);
  assert.doesNotMatch(files.decision, /save_story_skeleton|save_adaptation_strategy|upsert_project_script/);
});

test("skeleton skill restores causal, character, information, structure, and change-ledger methods", () => {
  for (const marker of [
    "事实账本",
    "核心吸引力",
    "中心戏剧问题",
    "外部目标",
    "内部需要",
    "## 因果链",
    "## 人物系统",
    "## 世界规则与信息揭示",
    "## 宏观结构选择",
    "## 分集规划（任务需要且集数已确认时）",
    "## 取舍与变更账本",
    "## 条件化商业设计",
  ]) assert.match(files.skeleton, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(files.skeleton, /来源位置 \| 原内容\/功能 \| 处理方式 \| 理由 \| 替代承载/);
  assert.match(files.skeleton, /只有当用户目标或已确认项目配置明确要求/);
  assert.match(files.skeleton, /不预设付费点位置、集数比例、类型占比或固定反转频率/);
});

test("adaptation skill restores protected facts, transformation ledger, character, information, and audiovisualization", () => {
  for (const marker of [
    "改编目标与边界",
    "忠实度边界",
    "受保护事实",
    "原素材处理体系",
    "保留",
    "压缩",
    "合并",
    "重排",
    "转移",
    "删除",
    "视听化转换",
    "人物弧与关系策略",
    "世界规则与信息策略",
    "剧本执行边界",
  ]) assert.match(files.adaptation, new RegExp(marker));
  assert.match(files.adaptation, /来源位置 \| 已确认内容与原功能 \| 操作 \| 决策理由 \| 替代表达或承载/);
  assert.match(files.adaptation, /(?:只有|仅)当用户目标或已确认配置要求分集商业短剧方法时/);
  assert.match(files.adaptation, /不规定镜头、焦段、机位、运镜、光位、剪辑点或分镜构图/);
});

test("script skill contains the selected Markdown screenplay template and continuity method", () => {
  assert.match(files.script, /# \{作品名\} EP\{NN\}：\{集标题\}/);
  assert.match(files.script, /# 目标时长：\{已确认值\}/);
  assert.match(files.script, /## 剧情梗概/);
  assert.match(files.script, /\{场号\} \{场景名\} \{日\/夜或已确认时间\} \{内\/外\}/);
  assert.match(files.script, /人物：\{本场实际出现人物\}/);
  assert.match(files.script, /△\{可表演、可见且具有物理因果的行动\}/);
  assert.match(files.script, /OS\/VO：\{仅在必要、来源明确且项目允许时使用\}/);
  assert.match(files.script, /进入状态和预期离开状态/);
  assert.match(files.script, /进入条件[\s\S]*人物目标[\s\S]*阻力[\s\S]*选择与行动[\s\S]*可见结果[\s\S]*离场压力/);
  assert.match(files.script, /第一行标题必须与传给 `upsert_project_script\.name` 的名称一致/);
  assert.match(files.script, /不得用常见行业规格、字数换算或固定短剧公式代替事实/);
});

test("supervision skill provides target-specific evidence reviews without auto-revision", () => {
  assert.match(files.supervision, /## 故事骨架审核/);
  assert.match(files.supervision, /## 改编策略审核/);
  assert.match(files.supervision, /## 剧本审核/);
  assert.match(files.supervision, /具体位置/);
  assert.match(files.supervision, /事实依据/);
  assert.match(files.supervision, /影响/);
  assert.match(files.supervision, /修复方向/);
  assert.match(files.supervision, /### 必须处理/);
  assert.match(files.supervision, /### 建议处理/);
  assert.match(files.supervision, /### 风险或待确认/);
  assert.match(files.supervision, /record_script_review/);
  assert.doesNotMatch(files.supervision, /save_story_skeleton|save_adaptation_strategy|upsert_project_script|delete_project_script/);
});

test("specialists receive factual readers and only their authorized content mutation tools", () => {
  const commonReaders = [
    "get_script_project_context",
    "read_script_workspace",
    "list_project_materials",
    "read_project_material",
    "get_project_context_pack",
  ];
  for (const tools of Object.values(SCRIPT_SUB_AGENT_TOOL_NAMES)) {
    for (const reader of commonReaders) assert.ok(tools.includes(reader as never), `${reader} missing`);
  }
  for (const key of ["storySkeleton", "adaptationStrategy"] as const) {
    assert.ok(SCRIPT_SUB_AGENT_TOOL_NAMES[key].includes("read_novel_text"));
  }

  const contentMutators = ["save_story_skeleton", "save_adaptation_strategy", "upsert_project_script", "delete_project_script", "record_script_review"];
  assert.deepEqual(SCRIPT_SUB_AGENT_TOOL_NAMES.storySkeleton.filter((tool) => contentMutators.includes(tool)), ["save_story_skeleton"]);
  assert.deepEqual(SCRIPT_SUB_AGENT_TOOL_NAMES.adaptationStrategy.filter((tool) => contentMutators.includes(tool)), ["save_adaptation_strategy"]);
  assert.deepEqual(SCRIPT_SUB_AGENT_TOOL_NAMES.script.filter((tool) => contentMutators.includes(tool)), ["upsert_project_script", "delete_project_script"]);
  assert.deepEqual(SCRIPT_SUB_AGENT_TOOL_NAMES.supervision.filter((tool) => contentMutators.includes(tool)), ["record_script_review"]);
});
