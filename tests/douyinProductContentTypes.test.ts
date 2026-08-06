import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadProductionStage } from "../src/services/productionStageSkills";

const skillsRoot = path.join(process.cwd(), "data", "skills", "story_skills");
const visual = "realpeople_douyin_product_demo";

const manualRequirements = {
  douyin_product_comparison: {
    planning: [/同条件观察/, /成对/, /整体优劣/],
    table: [/先让比较成立/, /单一观察变量/, /伪造对称/],
  },
  douyin_product_scenario_story: {
    planning: [/商品必须由行动召唤/, /一条可追踪的行动路线/, /持续惊喜/],
    table: [/行动先于商品/, /同一行动路线/, /夸张反转/],
  },
  douyin_product_process_demo: {
    planning: [/状态账/, /操作几何/, /无依据跳变/],
    table: [/开始状态 → 触发该变化的关键操作 → 结束状态/, /整体镜/, /无依据跳变/],
  },
  douyin_product_buying_guide: {
    planning: [/攻略不是清单，也不是背书/, /选购视点与拍摄逻辑/, /可复核的选择过程/],
    table: [/条件先于结论/, /对应覆盖/, /不是排行榜/],
  },
} as const;

function read(manual: string, file: string) {
  return fs.readFileSync(path.join(skillsRoot, manual, "driector_skills", file), "utf8").replace(/\r\n/g, "\n");
}

test("Douyin content-type manuals preserve their distinct evidence boundaries", () => {
  for (const [manual, requirements] of Object.entries(manualRequirements)) {
    const planning = read(manual, "director_planning_narrative.md");
    const table = read(manual, "director_storyboard_table_narrative.md");
    assert.match(planning, /^---\nname: director_planning_narrative/m, manual);
    assert.match(table, /^---\nname: director_storyboard_table_narrative/m, manual);
    assert.doesNotMatch(`${planning}\n${table}`, /固定镜头数量|固定前三秒模板|品类脚本公式/);
    for (const requirement of requirements.planning) assert.match(planning, requirement, `${manual} planning`);
    for (const requirement of requirements.table) assert.match(table, requirement, `${manual} table`);
  }
});

test("Douyin content-type manuals load through the existing Production stages", async () => {
  const originalInfo = console.info;
  console.info = () => undefined;
  try {
    for (const manual of Object.keys(manualRequirements)) {
      const planning = await loadProductionStage({ stage: "directorPlan", artStyle: visual, directorManual: manual });
      const table = await loadProductionStage({ stage: "storyboardTable", artStyle: visual, directorManual: manual });
      const review = await loadProductionStage({ stage: "supervisionStoryboardTable", artStyle: visual, directorManual: manual });
      assert.match(planning.prompt, /director_planning_narrative/);
      assert.match(table.prompt, /director_storyboard_table_narrative/);
      assert.match(review.prompt, /director_storyboard_table_narrative/);
    }
  } finally {
    console.info = originalInfo;
  }
});
