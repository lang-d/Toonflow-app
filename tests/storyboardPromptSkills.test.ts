import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const skillsRoot = path.join(process.cwd(), "data", "skills");
const panelSkill = fs.readFileSync(path.join(skillsRoot, "production_execution_storyboard_panel.md"), "utf8");
const promptSkill = fs.readFileSync(
  path.join(skillsRoot, "production_skills", "storyboard_prompt_techniques.md"),
  "utf8",
);
const mainProcess = fs.readFileSync(path.join(process.cwd(), "scripts", "main.ts"), "utf8");

test("storyboard panel reads planning and facts without loading the legacy storyboard style skill", () => {
  assert.match(panelSkill, /get_flowData\("scriptPlan"\)/);
  assert.match(panelSkill, /get_flowData\("storyboard"\)/);
  assert.match(panelSkill, /get_flowData\("assets"\)/);
  assert.match(panelSkill, /只允许调用 `update_storyboard_panel_v2`/);
  assert.match(panelSkill, /不得激活 `director_storyboard`/);
  assert.doesNotMatch(panelSkill, /-\s+`director_storyboard`\s*$/m);
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
  assert.match(promptSkill, /视觉风格：.*最多一句/);
  assert.match(promptSkill, /禁止自动加入“真人摄影、电影级、4K、8K、极致细节/);
  assert.match(promptSkill, /不从画风手册复制固定画质锁定词/);
});

test("packaged startup refreshes builtin skills without replacing user skills", () => {
  assert.match(mainProcess, /ALWAYS_REFRESH_SYSTEM_ENTRIES = new Set\(\["serve", "web", "skills"\]\)/);
  assert.match(mainProcess, /const userDir = path\.resolve\(app\.getPath\("userData"\), "user"\)/);
});
