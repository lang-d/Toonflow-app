import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const skillsRoot = path.join(repoRoot, "data", "skills");
const panelSkill = fs.readFileSync(path.join(skillsRoot, "production_execution_storyboard_panel.md"), "utf8");
const genSkill = fs.readFileSync(path.join(skillsRoot, "production_execution_storyboard_gen.md"), "utf8");
const tableSkill = fs.readFileSync(path.join(skillsRoot, "production_execution_storyboard_table.md"), "utf8");
const directorSkill = fs.readFileSync(path.join(skillsRoot, "production_execution_director_plan.md"), "utf8");
const promptSkill = fs.readFileSync(path.join(skillsRoot, "production_skills", "storyboard_prompt_techniques.md"), "utf8");
const tableTechnique = fs.readFileSync(path.join(skillsRoot, "production_skills", "storyboard_table_techniques.md"), "utf8");
const supervisionSkill = fs.readFileSync(path.join(skillsRoot, "production_agent_supervision.md"), "utf8");
const mainProcess = fs.readFileSync(path.join(repoRoot, "scripts", "main.ts"), "utf8");
const toolsSource = fs.readFileSync(path.join(repoRoot, "src", "agents", "productionAgent", "tools.ts"), "utf8");

test("storyboard panel reads planning and facts without loading the legacy storyboard style skill", () => {
  assert.match(panelSkill, /get_flowData\("scriptPlan"\)/);
  assert.match(panelSkill, /get_flowData\("storyboard"\)/);
  assert.match(panelSkill, /get_flowData\("assets"\)/);
  assert.match(panelSkill, /只允许调用 `update_storyboard_panel_v2`/);
  assert.match(panelSkill, /不得激活 `director_storyboard`/);
  assert.match(panelSkill, /不得激活或读取 `director_storyboard_table_style`/);
  assert.match(panelSkill, /不得根据 `artStyle` 名、视觉手册名、导演手册名或题材名自行补风格/);
  assert.doesNotMatch(panelSkill, /-\s+`director_storyboard`\s*$/m);
});

test("director plan owns the overall visual scheme inherited by later stages", () => {
  assert.match(directorSkill, /### ② 整体视觉方案与画面基调/);
  assert.match(directorSkill, /只写段落级\/场次级视觉方向/);
  assert.match(directorSkill, /不得写图片 Prompt、视频 Prompt、模型标签/);
  assert.match(supervisionSkill, /②整体视觉方案与画面基调/);
});

test("storyboard table and supervision do not activate the visual table style skill", () => {
  assert.match(tableSkill, /`storyboard_table_techniques`/);
  assert.match(tableSkill, /`director_storyboard_table_narrative`/);
  assert.match(tableSkill, /不得激活 `director_storyboard_table_style`/);
  assert.doesNotMatch(tableSkill, /-\s+`director_storyboard_table_style`\s*$/m);
  assert.match(supervisionSkill, /加载 `storyboard_table_techniques` 与当前导演手册的 `director_storyboard_table_narrative`/);
  assert.match(supervisionSkill, /禁止调用 `director_storyboard_table_style`/);
});

test("generic storyboard table contracts stay topic agnostic", () => {
  const genericText = `${tableSkill}\n${tableTechnique}\n${supervisionSkill}`;
  for (const term of ["证据镜头", "现实压力", "公共暴露", "空间后果"]) {
    assert.doesNotMatch(genericText, new RegExp(term));
  }
});

test("storyboard panel supports update and confirmed full replace modes", () => {
  assert.match(toolsSource, /mode:\s*z\.enum\(\["update", "replace"\]\)/);
  assert.match(toolsSource, /applyStoryboardPanelImageFieldsWithDb/);
  assert.match(panelSkill, /默认使用 `mode: "update"`/);
  assert.match(panelSkill, /必须先停下向用户确认/);
  assert.match(panelSkill, /用户确认后才允许使用 `mode: "replace"`/);
  assert.match(panelSkill, /清空该分镜已有图片结果和图片画布探索/);
  assert.match(panelSkill, /replace 不修改 `tableRowJson`/);
});

test("storyboard image generation uses generate_storyboard and waits for ack", () => {
  assert.match(genSkill, /generate_storyboard\(\{ ids: \[分镜ID列表\] \}\)/);
  assert.match(genSkill, /后端统一走 `image-flow`/);
  assert.doesNotMatch(genSkill, /generate_storyboard_images/);
  assert.match(toolsSource, /emitWithAckTimeout<GenerateStoryboardAck>\(socket,\s*"generateStoryboard"/);
  assert.match(toolsSource, /ack\?\.success === false/);
  assert.match(toolsSource, /normalizeGenerateStoryboardResult/);
  assert.doesNotMatch(toolsSource, /new Promise\(\(resolve\) => socket\.emit\("generateStoryboard"/);
  assert.doesNotMatch(toolsSource, /return "开始生成分镜"/);
});

test("production agent reads flow data from backend facts and marks terminal storyboard commit failures", () => {
  assert.match(toolsSource, /buildProductionFlowData/);
  assert.match(toolsSource, /terminal:\s*true/);
  assert.match(toolsSource, /VALIDATION_FAILED/);
  assert.match(toolsSource, /GENERATION_SUPERSEDED/);
  assert.match(toolsSource, /storyboardGenerationLastFailure/);
  assert.doesNotMatch(toolsSource, /emitWithAckTimeout<FlowData>\(socket,\s*"getFlowData"/);
});

test("production skills require stop-on-failure and normalized storyboard generation status wording", () => {
  assert.match(tableSkill, /terminal: true/);
  assert.match(tableSkill, /GENERATION_SUPERSEDED/);
  assert.match(tableSkill, /COMMIT_IN_PROGRESS/);
  assert.match(tableSkill, /writing \/ invalid \/ failed \/ committing \/ superseded \/ committed \/ expired/);
  assert.match(directorSkill, /get_flowData.*失败或超时/);
  assert.match(directorSkill, /begin_director_plan → append_director_plan_section → commit_director_plan/);
  assert.match(directorSkill, /只有返回 `status=committed` 才算完成/);
  assert.doesNotMatch(directorSkill, /完整输出 `<scriptPlan>/);
  assert.match(panelSkill, /get_flowData.*失败或超时/);
  assert.match(panelSkill, /不得继续调用 `update_storyboard_panel_v2`/);
});

test("storyboard prompt technique defines a static Chinese prompt and ordered Image references", () => {
  assert.match(promptSkill, /单张静态画面/);
  assert.match(promptSkill, /静态性高于动作语义完整性/);
  assert.match(promptSkill, /除 `@ImageN` 外全部使用中文/);
  assert.match(promptSkill, /`@ImageN` 必须对应 `associateAssetsIds\[N - 1\]`/);
  assert.match(promptSkill, /左侧、右侧或中央/);
  assert.match(promptSkill, /正面、背面或侧面/);
  assert.match(promptSkill, /过程、次数、前史和后续结果/);
  assert.match(promptSkill, /不再、没有、无法看见、未显示/);
  assert.match(promptSkill, /所有事实也必须能在同一时刻成立/);
});

test("storyboard prompt technique freezes dynamic interactions into one visible state", () => {
  assert.match(promptSkill, /“某人递来物件”可冻结为/);
  assert.match(promptSkill, /“某人没有接”必须改写为可见状态/);
  assert.match(promptSkill, /“拿起可读物件查看内容”只能选择一个瞬间/);
  assert.match(promptSkill, /角色A位于画面左侧中景/);
  assert.match(promptSkill, /右手停在摊开的信件边缘/);
});

test("storyboard prompt technique rejects quality filler and limits style to the director plan", () => {
  assert.match(promptSkill, /`scriptPlan` 只提供短视觉原则/);
  assert.match(promptSkill, /视觉风格.*最多一句/);
  assert.match(promptSkill, /不主动添加任何风格锚词、画质词、媒介词或负向词/);
  assert.match(promptSkill, /不自行读取或复制视觉手册里的固定模板/);
  assert.match(promptSkill, /不根据 `artStyle` 名、视觉手册名、导演手册名或题材名推导/);
});

test("packaged startup refreshes builtin skills without replacing user skills", () => {
  assert.match(mainProcess, /ALWAYS_REFRESH_SYSTEM_ENTRIES = new Set\(\["serve", "web", "skills"\]\)/);
  assert.match(mainProcess, /const userDir = path\.resolve\(app\.getPath\("userData"\), "user"\)/);
});
