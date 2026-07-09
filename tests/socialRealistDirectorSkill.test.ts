import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const manualRoot = path.join(process.cwd(), "data", "skills", "story_skills", "Social_realist_drama");
const planningPath = path.join(manualRoot, "driector_skills", "director_planning_narrative.md");
const tablePath = path.join(manualRoot, "driector_skills", "director_storyboard_table_narrative.md");

function manualContent() {
  return `${fs.readFileSync(planningPath, "utf8")}\n${fs.readFileSync(tablePath, "utf8")}`;
}

test("social realist drama is an independent director manual", () => {
  assert.equal(fs.existsSync(path.join(manualRoot, "README.md")), true);
  assert.match(fs.readFileSync(planningPath, "utf8"), /^---\nname: director_planning_narrative/m);
  assert.match(fs.readFileSync(tablePath, "utf8"), /^---\nname: director_storyboard_table_narrative/m);
  assert.equal(
    fs.existsSync(
      path.join(process.cwd(), "data", "skills", "art_skills", "realpeople_modern_city", "driector_skills", "director_social_realist_drama.md"),
    ),
    false,
  );
});

test("social realist drama provides executable pressure-drama directing methods", () => {
  const content = manualContent();
  for (const phrase of [
    "现实压力诊断框架",
    "关系位移",
    "短剧连载节奏",
    "拆镜触发条件",
    "证据特写",
    "旁观者沉默",
    "空间后果",
    "关键沉默通常 2-4 秒",
  ]) {
    assert.match(content, new RegExp(phrase));
  }
});

test("social realist drama stays generic and visual-style independent", () => {
  const content = manualContent();
  for (const phrase of ["欠薪", "婚姻财产", "职场维权", "家庭责任", "熟人背刺"]) {
    assert.doesNotMatch(content, new RegExp(`专用于${phrase}`));
  }
  assert.match(content, /适用于任意视觉风格/);
  assert.match(content, /规则、钱、照护、体面、工作交付、公共评价、流程\/制度/);
  assert.match(content, /家庭账本/);
  assert.match(content, /工作现金流/);
  assert.match(content, /熟人关系/);
  assert.doesNotMatch(content, /十五万|陈默|周承言|林知秋|15\s*万|8\s*万/);
  assert.doesNotMatch(content, /讨债|餐馆|医院|法院/);
  assert.doesNotMatch(content, /4000K|5500K|真人摄影|真人实拍|镜头品牌|渲染|模型提示词|prompt/);
});

test("social realist drama keeps music as a downstream boundary", () => {
  const content = manualContent();
  assert.match(content, /独立配乐阶段/);
  assert.match(content, /BGM 只写/);
  assert.doesNotMatch(content, /主题曲|片尾曲|cue sheet|音乐模型/);
});
