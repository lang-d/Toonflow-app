import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PRODUCTION_STAGE_DEFINITIONS } from "../src/services/productionStageSkills";
import { parseFrontmatter } from "../src/utils/agent/skillsTools";

const root = process.cwd();
const skillsRoot = path.join(root, "data", "skills");

test("production stages expose only their declared skills and tools", () => {
  assert.deepEqual(PRODUCTION_STAGE_DEFINITIONS.directorPlan.tools, [
    "get_flowData",
    "begin_director_plan",
    "append_director_plan_section",
    "commit_director_plan",
  ]);
  assert.deepEqual(PRODUCTION_STAGE_DEFINITIONS.supervisionDirectorPlan.tools, [
    "get_flowData",
    "get_director_plan_asset",
  ]);
  assert.deepEqual(PRODUCTION_STAGE_DEFINITIONS.deriveAssets.tools, ["get_flowData", "add_deriveAsset"]);
  assert.deepEqual(PRODUCTION_STAGE_DEFINITIONS.generateAssets.tools, ["get_flowData", "generate_deriveAsset"]);
  assert.deepEqual(PRODUCTION_STAGE_DEFINITIONS.storyboardPanel.tools, ["get_flowData", "update_storyboard_panel_v2"]);
  assert.deepEqual(PRODUCTION_STAGE_DEFINITIONS.storyboardGenerate.tools, ["get_flowData", "generate_storyboard"]);
  assert.deepEqual(
    PRODUCTION_STAGE_DEFINITIONS.storyboardTable.tools,
    [
      "get_flowData",
      "get_storyboard_generation_draft",
      "begin_storyboard_table",
      "append_storyboard_rows",
      "commit_storyboard_table",
      "await_user_decision",
    ],
  );
  assert.deepEqual(
    PRODUCTION_STAGE_DEFINITIONS.storyboardTable.skills.map((skill) => skill.name),
    ["storyboard_table_techniques", "director_storyboard_table_narrative"],
  );
  assert.deepEqual(
    PRODUCTION_STAGE_DEFINITIONS.supervisionStoryboardTable.skills.map((skill) => skill.name),
    ["storyboard_table_techniques", "director_storyboard_table_narrative"],
  );
  assert.deepEqual(
    PRODUCTION_STAGE_DEFINITIONS.storyboardPanel.skills.map((skill) => skill.name),
    ["storyboard_prompt_techniques"],
  );
  for (const definition of Object.values(PRODUCTION_STAGE_DEFINITIONS)) {
    assert.equal(definition.skills.some((skill) => skill.name === "director_storyboard"), false);
    assert.equal(definition.skills.some((skill) => skill.name === "director_storyboard_table_style"), false);
  }
});

test("production and script workflow tool contracts match registered tool names", () => {
  const generateSkill = fs.readFileSync(path.join(skillsRoot, "production_execution_generate_assets.md"), "utf8");
  const directorSkill = fs.readFileSync(path.join(skillsRoot, "production_execution_director_plan.md"), "utf8");
  const supervisionSkill = fs.readFileSync(path.join(skillsRoot, "production_agent_supervision.md"), "utf8");
  const scriptDecision = fs.readFileSync(path.join(skillsRoot, "script_agent_decision.md"), "utf8");
  const scriptWorkflows = ["script_execution_skeleton.md", "script_execution_adaptation.md", "script_execution_script.md"]
    .map((file) => fs.readFileSync(path.join(skillsRoot, file), "utf8"))
    .join("\n");
  assert.match(generateSkill, /generate_deriveAsset/);
  assert.doesNotMatch(generateSkill, /generate_assets_images/);
  assert.match(directorSkill, /begin_director_plan/);
  assert.match(directorSkill, /append_director_plan_section/);
  assert.match(directorSkill, /commit_director_plan/);
  assert.match(directorSkill, /content.*只提交该 section 的正文/);
  assert.match(directorSkill, /④ 段落与节奏规划、⑤ 分场景执行规划.*禁止使用 Markdown 表格/);
  assert.doesNotMatch(directorSkill, /表格可用 Markdown/);
  assert.match(supervisionSkill, /长叙述格式/);
  assert.match(supervisionSkill, /④段落与节奏规划、⑤分场景执行规划.*字段块\/短列表/);
  assert.doesNotMatch(directorSkill, /<scriptPlan>内容<\/scriptPlan>/);
  assert.doesNotMatch(scriptDecision, /set_planData_|insert_script_to_sqlite/);
  assert.doesNotMatch(fs.readFileSync(path.join(skillsRoot, "production_agent_decision.md"), "utf8"), /prompts:/);
  assert.doesNotMatch(`${scriptDecision}\n${scriptWorkflows}`, /get_novel_events\(ids/);
  assert.match(`${scriptDecision}\n${scriptWorkflows}`, /get_novel_events\(\{ chapterIndexs/);
});

test("all active builtin manual files honor stable contract names", () => {
  const contracts = [
    ["art_skills", "driector_skills", "director_planning_style.md", "director_planning_style"],
    ["story_skills", "driector_skills", "director_planning_narrative.md", "director_planning_narrative"],
    ["story_skills", "driector_skills", "director_storyboard_table_narrative.md", "director_storyboard_table_narrative"],
  ] as const;

  for (const [rootName, subDir, fileName, expectedName] of contracts) {
    const packagesRoot = path.join(skillsRoot, rootName);
    for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(packagesRoot, entry.name, subDir, fileName);
      assert.equal(fs.existsSync(file), true, `${entry.name} missing ${fileName}`);
      assert.equal(parseFrontmatter(fs.readFileSync(file, "utf8")).name, expectedName, file);
    }
  }
});

test("production decision and subagents use code-level tool filtering", () => {
  const source = fs.readFileSync(path.join(root, "src", "agents", "productionAgent", "index.ts"), "utf8");
  const decisionBlock = source.slice(source.indexOf("export async function runDecisionAI"), source.indexOf("async function createSubAgent"));
  assert.match(decisionBlock, /toolsNames:\s*\[\s*"get_flowData",\s*"await_user_decision"\s*\]/);
  assert.doesNotMatch(decisionBlock, /toolsNames:\s*\[[^\]]*(?:add_|update_|generate_|begin_|append_|commit_|del_)/);
  assert.match(source, /toolsNames: toolNames/);
  assert.match(source, /allowsDerivedAssetDelete/);
  assert.match(source, /\.\.\.stage\.definition\.tools, "del_deriveAsset"/);
  assert.doesNotMatch(source, /scanSkills\(|createArtSkills|useProductionSkills/);
});

test("video prompt compiler does not read visual manuals or hardcode urban style", () => {
  const source = fs.readFileSync(path.join(root, "src", "services", "videoPromptCompiler.ts"), "utf8");
  assert.doesNotMatch(source, new RegExp(["art", "storyboard", "video"].join("_")));
  assert.doesNotMatch(source, new RegExp(["visual", "Manual", "Source"].join("")));
  assert.doesNotMatch(source, new RegExp(["resolve", "Manual", "File"].join("")));
  assert.doesNotMatch(source, /都市写实摄影 \/ 真人实拍质感 \/ 现代都市纪实/);
  assert.doesNotMatch(source, /真人实拍质感/);
});
