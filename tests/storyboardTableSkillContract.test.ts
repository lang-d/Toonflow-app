import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const skillsRoot = path.join(process.cwd(), "data", "skills");
const text = fs.readFileSync(path.join(skillsRoot, "production_execution_storyboard_table.md"), "utf8");

test("storyboard table skill keeps group metadata outside V3 rows", () => {
  assert.match(text, /`groupKey` 是稳定 ASCII 标识/);
  assert.match(text, /展示名称(?:与|和)组意图属于正式 group plan，不重复写进每一行/);
  assert.match(text, /V3 禁止出现.*行级 `groupName`.*行级 `groupIntent`/s);
});

test("generic storyboard technique is the sole source of shot-size and dialogue-duration guidance", () => {
  const techniques = fs.readFileSync(
    path.join(skillsRoot, "production_skills", "storyboard_table_techniques.md"),
    "utf8",
  );
  const supervision = fs.readFileSync(
    path.join(skillsRoot, "production_supervision_storyboard_table.md"),
    "utf8",
  );

  assert.match(techniques, /本镜新增信息/);
  assert.match(techniques, /3[–-]4\.5 个汉字\/秒/);
  assert.match(techniques, /画外继续说/);
  assert.match(techniques, /屏幕、纸张、照片、镜面、仪表或远端画面/);
  assert.match(techniques, /另一项交给画外声或前后镜承接/);
  assert.match(techniques, /连续镜头若都没有新增事实.*应合并或缩短/);
  assert.match(techniques, /(?:无关的空镜和装饰物|没有新增信息的连续中景、机械景别轮换或无关插入镜)/);
  assert.match(text, /景别选择、对白画面处理和时长估算的唯一技法来源/);
  assert.match(supervision, /明显无法(?:容纳于|在) `durationSec`(?: 内完成)?/);
  assert.match(supervision, /可读视觉载体.*同一构图无法自然承载两者/);
  assert.match(supervision, /相邻静场.*相邻镜证据/);
  assert.match(supervision, /插入镜(?:是否提供台词之外的新事实、反应或物件状态|没有提供新信息)/);
});

test("generic techniques and supervision explicitly address irrational shot splitting", () => {
  const techniques = fs.readFileSync(
    path.join(skillsRoot, "production_skills", "storyboard_table_techniques.md"),
    "utf8",
  );
  const supervision = fs.readFileSync(
    path.join(skillsRoot, "production_supervision_storyboard_table.md"),
    "utf8",
  );

  assert.match(techniques, /视觉中心.*转到另一中心/);
  assert.match(techniques, /同一人物同一连续动作拆成重复/);
  assert.match(techniques, /若切开后下一镜必须重复上镜动作才能看懂/);
  assert.match(techniques, /为填满模型最大秒数.*强并/);
  assert.match(supervision, /多个独立视觉中心/);
  assert.match(supervision, /切点落在不能自然中断/);
  assert.match(supervision, /机械更换景别/);
  assert.match(supervision, /为填满视频模型最大时长而合并/);
});

test("active genre storyboard manuals do not prescribe shot sizes, seconds, ratios, or dialogue cuts", () => {
  const storySkillsRoot = path.join(skillsRoot, "story_skills");
  const manuals = fs
    .readdirSync(storySkillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      path.join(
        storySkillsRoot,
        entry.name,
        "driector_skills",
        "director_storyboard_table_narrative.md",
      ),
    )
    .filter((file) => fs.existsSync(file));

  assert.equal(manuals.length, 23);

  const forbidden = [
    { name: "specific shot-size preset", pattern: /远景|全景|中全景|中景|中近景|近景|特写/ },
    { name: "numeric seconds", pattern: /\d+(?:\.\d+)?\s*(?:[-–—~到至]\s*\d+(?:\.\d+)?\s*)?(?:秒|s\b)/i },
    { name: "shot ratio", pattern: /\d+\s*[%％]/ },
    { name: "fixed dialogue cutting", pattern: /(?:一句|每句|每轮)[^\n]{0,20}(?:一镜|镜头|切)/ },
  ];

  for (const file of manuals) {
    const manual = fs.readFileSync(file, "utf8");
    assert.match(manual, /通用分镜技法/);
    for (const rule of forbidden) {
      assert.doesNotMatch(manual, rule.pattern, `${path.relative(storySkillsRoot, file)}: ${rule.name}`);
    }
  }
});
