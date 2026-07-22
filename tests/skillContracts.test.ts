import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PRODUCTION_STAGE_DEFINITIONS, productionSupervisionStage } from "../src/services/productionStageSkills";
import { parseFrontmatter } from "../src/utils/agent/skillsTools";

const root = process.cwd();
const skillsRoot = path.join(root, "data", "skills");

test("production stages expose only their declared skills and tools", () => {
  assert.deepEqual(PRODUCTION_STAGE_DEFINITIONS.directorPlan.tools, [
    "get_flowData",
    "update_agent_progress",
    "await_user_decision",
    "list_director_plan_generations",
    "read_director_plan_generation",
    "begin_director_plan",
    "append_director_plan_section",
    "commit_director_plan",
  ]);
  assert.deepEqual(PRODUCTION_STAGE_DEFINITIONS.supervisionDirectorPlan.tools, [
    "get_flowData",
    "update_agent_progress",
    "await_user_decision",
    "list_director_plan_generations",
    "read_director_plan_generation",
    "get_director_plan_asset",
    "read_text_asset",
  ]);
  assert.deepEqual(PRODUCTION_STAGE_DEFINITIONS.deriveAssets.tools, [
    "get_flowData",
    "update_agent_progress",
    "await_user_decision",
    "add_deriveAsset",
  ]);
  assert.deepEqual(PRODUCTION_STAGE_DEFINITIONS.generateAssets.tools, [
    "get_flowData",
    "update_agent_progress",
    "await_user_decision",
    "generate_deriveAsset",
  ]);
  assert.deepEqual(PRODUCTION_STAGE_DEFINITIONS.storyboardPanel.tools, [
    "get_flowData",
    "update_agent_progress",
    "await_user_decision",
    "list_storyboard_generations",
    "read_storyboard_generation",
    "list_production_reviews",
    "read_production_review",
    "read_text_asset",
    "update_storyboard_panel_v2",
  ]);
  assert.deepEqual(PRODUCTION_STAGE_DEFINITIONS.supervisionStoryboardPanel.tools, [
    "get_flowData",
    "update_agent_progress",
    "await_user_decision",
    "list_storyboard_generations",
    "read_storyboard_generation",
    "list_production_reviews",
    "read_production_review",
    "read_text_asset",
  ]);
  assert.deepEqual(PRODUCTION_STAGE_DEFINITIONS.supervisionStoryboardTable.tools, [
    "get_flowData",
    "update_agent_progress",
    "await_user_decision",
    "list_storyboard_generations",
    "read_storyboard_generation",
    "list_production_reviews",
    "read_production_review",
    "read_text_asset",
    "record_storyboard_table_review",
  ]);
  assert.deepEqual(PRODUCTION_STAGE_DEFINITIONS.storyboardGenerate.tools, [
    "get_flowData",
    "update_agent_progress",
    "await_user_decision",
    "generate_storyboard",
  ]);
  assert.deepEqual(
    PRODUCTION_STAGE_DEFINITIONS.storyboardTable.tools,
    [
      "get_flowData",
      "update_agent_progress",
      "await_user_decision",
      "list_storyboard_generations",
      "read_storyboard_generation",
      "list_production_reviews",
      "read_production_review",
      "read_text_asset",
      "get_storyboard_generation_draft",
      "prepare_storyboard_table",
      "begin_storyboard_table",
      "append_storyboard_rows",
      "commit_storyboard_table",
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
  assert.deepEqual(
    PRODUCTION_STAGE_DEFINITIONS.supervisionStoryboardPanel.skills.map((skill) => skill.name),
    ["storyboard_prompt_techniques"],
  );
  for (const definition of Object.values(PRODUCTION_STAGE_DEFINITIONS)) {
    assert.equal(definition.skills.some((skill) => skill.name === "director_storyboard"), false);
    assert.equal(definition.skills.some((skill) => skill.name === "director_storyboard_table_style"), false);
  }
});

test("production supervision routes storyboard panel before generic storyboard review", () => {
  assert.equal(productionSupervisionStage("请审核分镜面板"), "supervisionStoryboardPanel");
  assert.equal(productionSupervisionStage("review storyboard panel prompt"), "supervisionStoryboardPanel");
  assert.equal(productionSupervisionStage("请审核分镜表"), "supervisionStoryboardTable");
  assert.equal(productionSupervisionStage("请审核导演规划"), "supervisionDirectorPlan");
});

test("production and script workflow tool contracts match registered tool names", () => {
  const generateSkill = fs.readFileSync(path.join(skillsRoot, "production_execution_generate_assets.md"), "utf8");
  const directorSkill = fs.readFileSync(path.join(skillsRoot, "production_execution_director_plan.md"), "utf8");
  const supervisionSkill = fs.readFileSync(path.join(skillsRoot, "production_agent_supervision.md"), "utf8");
  const scriptDecision = fs.readFileSync(path.join(skillsRoot, "script_agent_decision.md"), "utf8");
  const musicDecision = fs.readFileSync(path.join(skillsRoot, "music_production_agent.md"), "utf8");
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
  assert.match(directorSkill, /人物站位与视轴图/);
  assert.match(directorSkill, /真实空间俯视关系图/);
  assert.match(directorSkill, /初态/);
  assert.match(directorSkill, /关键变位/);
  assert.match(directorSkill, /不得把“画面左\/右”当作人物的真实站位/);
  assert.match(directorSkill, /不得把“放到”改成“推到”/);
  assert.match(directorSkill, /关键可见设定账本/);
  assert.match(directorSkill, /覆盖只能根据顶层父资产 `prompt` 或明确衍生资产 `prompt` 的文字内容判断/);
  assert.match(directorSkill, /`设定已覆盖，图片已生成`、`设定已覆盖，图片待生成` 或 `资产缺口`/);
  assert.match(directorSkill, /覆盖资产 ID\/衍生 ID/);
  assert.match(directorSkill, /图片状态均不能代替 Prompt 覆盖依据/);
  assert.match(supervisionSkill, /图文、轴线、机位半区和资产状态一致/);
  assert.match(supervisionSkill, /实际变位漏图/);
  assert.match(supervisionSkill, /关键物理动作、道具转移和动作结果/);
  assert.match(supervisionSkill, /分析中的“可推断但需确认”不得进入最终清单/);
  assert.match(supervisionSkill, /“角色侧机位”“正反打”或“同侧”本身不构成守轴证明/);
  assert.match(supervisionSkill, /模型不读取或分析图片内容/);
  assert.match(supervisionSkill, /图片状态只记录已生成\/待生成\/未知，不能代替 Prompt 覆盖证明/);
  assert.match(supervisionSkill, /`设定已覆盖，图片已生成`、`设定已覆盖，图片待生成` 或 `资产缺口`/);
  assert.match(supervisionSkill, /不根据用户语句中的关键词猜测/);
  assert.doesNotMatch(supervisionSkill, /愤怒~4 字\/秒/);
  assert.doesNotMatch(supervisionSkill, /出现"正反打"/);
  assert.doesNotMatch(directorSkill, /表格可用 Markdown/);
  assert.match(supervisionSkill, /长叙述格式/);
  assert.match(supervisionSkill, /④段落与节奏规划、⑤分场景执行规划.*字段块\/短列表/);
  assert.doesNotMatch(directorSkill, /<scriptPlan>内容<\/scriptPlan>/);
  assert.doesNotMatch(scriptDecision, /set_planData_|insert_script_to_sqlite/);
  assert.doesNotMatch(fs.readFileSync(path.join(skillsRoot, "production_agent_decision.md"), "utf8"), /prompts:/);
  assert.doesNotMatch(`${scriptDecision}\n${scriptWorkflows}`, /get_planData|<storySkeleton>|<adaptationStrategy>|<scriptItem/);
  assert.match(`${scriptDecision}\n${scriptWorkflows}`, /read_novel_events/);
  assert.match(`${scriptDecision}\n${scriptWorkflows}`, /await_user_decision/);
  assert.match(scriptDecision, /complete_agent_run/);
  assert.match(musicDecision, /complete_agent_run/);
  assert.match(fs.readFileSync(path.join(skillsRoot, "production_agent_decision.md"), "utf8"), /complete_agent_run/);
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
  assert.match(decisionBlock, /"update_agent_progress"/);
  assert.match(decisionBlock, /"complete_agent_run"/);
  assert.match(decisionBlock, /"list_storyboard_generations"/);
  assert.match(decisionBlock, /"read_production_review"/);
  assert.doesNotMatch(decisionBlock, /"declare_storyboard_table_decision"/);
  assert.doesNotMatch(decisionBlock, /toolsNames:\s*\[[^\]]*(?:add_|generate_|begin_|append_|commit_|del_)/);
  assert.match(source, /toolsNames: toolNames/);
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
