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
const mainProcess = fs.readFileSync(path.join(repoRoot, "scripts", "main.ts"), "utf8");
const toolsSource = fs.readFileSync(path.join(repoRoot, "src", "agents", "productionAgent", "tools.ts"), "utf8");

test("storyboard panel reads planning and facts without loading the legacy storyboard style skill", () => {
  assert.match(panelSkill, /get_flowData\("scriptPlan"\)/);
  assert.match(panelSkill, /get_flowData\("storyboard"\)/);
  assert.match(panelSkill, /get_flowData\("assets"\)/);
  assert.match(panelSkill, /只允许调用 `update_storyboard_panel_v2`/);
  assert.match(panelSkill, /不得激活 `director_storyboard`/);
  assert.doesNotMatch(panelSkill, /-\s+`director_storyboard`\s*$/m);
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
  assert.doesNotMatch(toolsSource, /emitWithAckTimeout<FlowData>\(socket,\s*"getFlowData"/);
});

test("production skills require stop-on-failure and normalized storyboard generation status wording", () => {
  assert.match(tableSkill, /terminal: true/);
  assert.match(tableSkill, /GENERATION_SUPERSEDED/);
  assert.match(tableSkill, /COMMIT_IN_PROGRESS/);
  assert.match(tableSkill, /writing \/ invalid \/ failed \/ committing \/ superseded \/ committed \/ expired/);
  assert.match(directorSkill, /get_flowData.*失败或超时/);
  assert.match(directorSkill, /o_textAsset\(targetType="scriptPlan"\)/);
  assert.match(panelSkill, /get_flowData.*失败或超时/);
  assert.match(panelSkill, /不得继续调用 `update_storyboard_panel_v2`/);
});

test("storyboard prompt technique defines a static Chinese prompt and ordered Image references", () => {
  assert.match(promptSkill, /单一静态画面/);
  assert.match(promptSkill, /静态性高于动作语义完整性/);
  assert.match(promptSkill, /除 `@ImageN` 外全部使用中文/);
  assert.match(promptSkill, /`@ImageN` 必须对应 `associateAssetsIds\[N - 1\]`/);
  assert.match(promptSkill, /左侧、右侧或中央/);
  assert.match(promptSkill, /正面、背面或侧面/);
  assert.match(promptSkill, /两次、第二次、再次、反复、重新/);
  assert.match(promptSkill, /已经、放回、停下、转身离开、没有接、未继续、没再说/);
  assert.match(promptSkill, /所有事实也必须能在同一时刻成立/);
});

test("storyboard prompt technique freezes dynamic interactions into one visible state", () => {
  assert.match(promptSkill, /“某人递来物件”可冻结为/);
  assert.match(promptSkill, /“某人没有接”必须改写为可见状态/);
  assert.match(promptSkill, /“擦两次围裙后放回身侧”只能选择/);
  assert.match(promptSkill, /林秋岚右手停在围裙上/);
  assert.match(promptSkill, /背景餐桌上的手机屏幕亮着/);
});

test("storyboard prompt technique rejects quality filler and limits style to the director plan", () => {
  assert.match(promptSkill, /`scriptPlan` 只提供“视觉风格与画面基调”/);
  assert.match(promptSkill, /视觉风格.*最多一句/);
  assert.match(promptSkill, /禁止自动加入“真人摄影、电影级、4K、8K、极致细节/);
  assert.match(promptSkill, /不从画风手册复制固定画质锁定词/);
});

test("packaged startup refreshes builtin skills without replacing user skills", () => {
  assert.match(mainProcess, /ALWAYS_REFRESH_SYSTEM_ENTRIES = new Set\(\["serve", "web", "skills"\]\)/);
  assert.match(mainProcess, /const userDir = path\.resolve\(app\.getPath\("userData"\), "user"\)/);
});
