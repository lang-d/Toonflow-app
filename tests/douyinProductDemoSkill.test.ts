import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getArtPrompt } from "../src/utils/getArtPrompt";
import { loadProductionStage } from "../src/services/productionStageSkills";

const root = path.join(process.cwd(), "data", "skills");
const visual = "realpeople_douyin_product_demo";
const director = "douyin_product_demo";
const assetManuals = [
  "art_character",
  "art_character_derivative",
  "art_scene",
  "art_scene_derivative",
  "art_prop",
  "art_prop_derivative",
] as const;

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");
}

test("Douyin product-demo visual assets preserve references without inventing commercial facts", () => {
  for (const manual of assetManuals) {
    const content = getArtPrompt(visual, "art_skills", manual).replace(/\r\n/g, "\n");
    assert.match(content, new RegExp(`^---\\nname: ${manual}$`, "m"), manual);
    assert.match(content, /assetFoundation/, manual);
    assert.match(content, /visualDesignRationale/, manual);
    assert.match(content, /<assetImagePrompt>/, manual);
    assert.equal((content.match(/```text\n/g) || []).length, 1, manual);
    assert.doesNotMatch(content, /Seedance|@reference|https?:\/\//i, manual);
  }

  const prop = read(`art_skills/${visual}/art_prompt/art_prop.md`);
  const propDerivative = read(`art_skills/${visual}/art_prompt/art_prop_derivative.md`);
  const style = read(`art_skills/${visual}/driector_skills/director_planning_style.md`);
  assert.match(prop, /参考资产存在时，外观、包装、颜色和确认标识以参考为准/);
  assert.match(prop, /不虚构品牌、文字、参数、认证或功效/);
  assert.match(propDerivative, /同一商品/);
  assert.match(propDerivative, /不换物、不新增功能/);
  assert.match(style, /项目比例为竖屏时/);
  assert.match(style, /不凭空加入平台界面、字幕条、价格贴片或互动图标/);
});

test("Douyin product-demo director manuals load through existing Production stages", async () => {
  const originalInfo = console.info;
  console.info = () => undefined;
  try {
    const planning = await loadProductionStage({ stage: "directorPlan", artStyle: visual, directorManual: director });
    const table = await loadProductionStage({ stage: "storyboardTable", artStyle: visual, directorManual: director });
    const review = await loadProductionStage({ stage: "supervisionStoryboardTable", artStyle: visual, directorManual: director });
    assert.match(planning.prompt, /真人抖音商品实拍讲解/);
    assert.match(planning.prompt, /抖音商品实拍讲解/);
    assert.match(table.prompt, /<name>director_storyboard_table_narrative<\/name>/);
    assert.match(review.prompt, /<name>director_storyboard_table_narrative<\/name>/);
    const storyboardNarrative = read(`story_skills/${director}/driector_skills/director_storyboard_table_narrative.md`);
    assert.match(storyboardNarrative, /只承担一个明确的新增视觉中心/);
    assert.match(storyboardNarrative, /不预设固定商品特写数量、固定秒数/);
  } finally {
    console.info = originalInfo;
  }
});
