import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadProductionStage, PRODUCTION_STAGE_DEFINITIONS } from "../src/services/productionStageSkills";
import { STYLE_SKILL_PREVIOUS_HASHES } from "../src/services/builtinSkillSync";
import { rebuildDirectorSkillContent, rebuildDirectorSkills } from "../scripts/rebuildDirectorSkills";

const skillsRoot = path.join(process.cwd(), "data", "skills");
const visualRoot = path.join(skillsRoot, "art_skills");
const directorRoot = path.join(skillsRoot, "story_skills");

function packages(root: string) {
  return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function skillPath(root: string, packageName: string, fileName: string) {
  return path.join(root, packageName, "driector_skills", fileName);
}

function readSkill(root: string, packageName: string, fileName: string) {
  return fs.readFileSync(skillPath(root, packageName, fileName), "utf8").replace(/\r\n/g, "\n");
}

function sha256(file: string) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function upgradedDirectorSkills() {
  const skills: Array<{ path: string; kind: "visual" | "narrative" | "storyboard" }> = [];
  for (const packageName of Object.keys(visualRequirements)) {
    skills.push({ path: skillPath(visualRoot, packageName, "director_planning_style.md"), kind: "visual" });
  }
  for (const packageName of Object.keys(genreRequirements)) {
    skills.push(
      { path: skillPath(directorRoot, packageName, "director_planning_narrative.md"), kind: "narrative" },
      { path: skillPath(directorRoot, packageName, "director_storyboard_table_narrative.md"), kind: "storyboard" },
    );
  }
  return skills;
}

const visualRequirements: Record<string, RegExp[]> = {
  "2D_90s_japanese_anime": [/赛璐璐/, /有限动画/, /手绘背景/, /动作张数/],
  "2D_chinese_guofeng": [/水墨留白/, /卷轴式横向层次/, /建筑中轴/, /礼仪站位/],
  "2D_flat_design": [/色块/, /可识别剪影/, /遮挡、尺度、垂直位置/, /透视层级/],
  "2D_mature_urban_romance": [/公共空间/, /私密空间/, /动机光/, /双方动作反馈/],
  "3D_anime_render": [/卡通渲染/, /角色绑定/, /前景遮挡/, /动作轴线/],
  "3D_chinese_traditional": [/礼制空间/, /建筑中轴/, /权力站位/, /模拟与碰撞空间/],
  "3D_clay_stopmotion": [/实体尺度/, /逐格动作/, /微缩布景/, /接触点/],
  "3D_guofeng_cyber": [/传统为主、科技介入/, /系统状态色/, /数据线路/, /触发链/],
  "realpeople_ancient_chinese": [/史实不明确/, /自然光/, /礼仪动作/, /安全替代/],
  "realpeople_modern_city": [/真实场地/, /动机光/, /镜头覆盖/, /玻璃、镜面/, /曝光重点/],
};

const genreRequirements: Record<string, { planning: RegExp[]; table: RegExp[] }> = {
  Comedy_humor: { planning: [/铺垫段/, /误导段/, /反应链/], table: [/触发镜/, /反应镜/, /包袱前/] },
  Coming_of_age: { planning: [/成长链/, /错误段/, /可比较的行为证据/], table: [/关系距离/, /时间省略/, /成长节点/] },
  Family_warmth: { planning: [/家庭任务/, /照料/, /代际站位/], table: [/餐桌/, /厨房、门口/, /生活动作/] },
  Historical_epic: { planning: [/制度/, /命令如何传递/, /个人选择影响群体/], table: [/命令链/, /仪式和列阵/, /敌我/] },
  Horror_supernatural: { planning: [/威胁规则/, /未知边界/, /逃生地理/], table: [/负空间/, /主观镜/, /门状态/] },
  Hot_blooded_action: { planning: [/攻防链/, /能量阶段/, /伙伴分工/], table: [/攻击方向/, /接触点/, /伤势、武器/] },
  Mystery_thriller: { planning: [/线索真值/, /公平误导/, /知情变化/], table: [/线索镜头等级/, /观察者/, /回看式揭示/] },
  Psychological_drama: { planning: [/权力四项状态/, /主客观边界/, /话语策略/], table: [/空间控制转移/, /有动机的轴线变化/, /主观段/] },
  Scifi_post_apocalypse: { planning: [/世界规则/, /资源账/, /生存行动链/], table: [/技术状态/, /撤退方向/, /携带物/] },
  Sweet_romance_novel: { planning: [/关系推进阶梯/, /边界/, /双方目标/], table: [/触碰/, /对方反馈/, /退路/] },
  Urban_workplace_drama: { planning: [/职权/, /证据状态/, /谈判动作/], table: [/座次/, /持有权/, /权限被行使/] },
  Xianxia_fantasy: { planning: [/修行规则/, /能力条件与代价/, /誓约压力/], table: [/法术路径/, /招式镜/, /阶序/] },
};

visualRequirements.realpeople_island_survival = [/海陆方向/, /潮线/, /盐雾/, /现场声/, /人物站位/];
visualRequirements.realpeople_republican_period = [/统一棕黄滤镜/, /年代空间/, /门框、窗格、廊柱/, /木材漆面/, /唱片噪声/];
visualRequirements.realpeople_professional_documentary = [/观察式摄影/, /权限调度/, /玻璃、金属、白色织物和显示器/, /复述、确认、记录、交接/, /英雄宣传光/];
visualRequirements.realpeople_sports_cinematic = [/场地标线/, /固定广角/, /中长焦/, /运动织物/, /无目的慢动作/];
visualRequirements.realpeople_rural_naturalism = [/地域色彩/, /生活生产空间/, /土、石、砖、木、瓦/, /贫困奇观/, /文旅航拍/];
genreRequirements.Survival_island = {
  planning: [/环境时钟/, /生存状态账本/, /场前条件/, /知识权/, /岛屿拓扑/, /冲突时按以下优先级取舍/],
  table: [/信息建立/, /动作准备/, /状态写回/, /变化前条件/, /条件化区域覆盖/, /机位半区/],
};
genreRequirements.Ancient_political_intrigue = {
  planning: [/正式权力/, /实际控制/, /信息账本/, /承诺或人情/, /命令链/],
  table: [/等级空间/, /座次/, /门槛/, /文书信物/, /见证者/],
};
genreRequirements.Wuxia_jianghu = {
  planning: [/武学边界/, /兵器与有效距离/, /意图显露/, /优势变化/, /默认仙术/],
  table: [/起势与意图/, /接触\/回避/, /动作轴线/, /群战地理/, /兵器归属/],
};
genreRequirements.Crime_investigation = {
  planning: [/已发生事实/, /可观察痕迹/, /调查假设/, /调查行动链/, /不等于证据/],
  table: [/信息取得拆镜/, /原始位置\/来源/, /现场与调查轴线/, /审讯/, /证物/],
};
genreRequirements.Republican_espionage = {
  planning: [/身份与情报账本/, /公开身份/, /掩护目标/, /反监视链/, /不得默认叛徒/],
  table: [/监视与跟踪拆镜/, /接头与情报交接/, /最后可见位置/, /情报载体/, /年代连续/],
};
genreRequirements.Medical_rescue = {
  planning: [/患者与信息账本/, /医疗行动因果/, /角色分工与权限/, /隐私信息/, /不(?:是|提供)现实医疗建议/],
  table: [/状态变化拆镜/, /患者初始状态/, /操作侧/, /患者转运/, /设备声/],
};
genreRequirements.Legal_judicial = {
  planning: [/争议与程序账本/, /各方主张/, /程序行动链/, /决定权限/, /不是法律意见/],
  table: [/程序事件拆镜/, /发言权限/, /证据展示/, /座次/, /决定.*生效/],
};
genreRequirements.Sports_competition = {
  planning: [/比赛状态账本/, /比分\/计时\/回合/, /竞技行动链/, /对手是行动主体/, /不得补写犯规/],
  table: [/竞技动作拆镜/, /场地轴线/, /队形/, /比分时间/, /替补、暂停、休息/],
};
genreRequirements.Rural_hometown = {
  planning: [/生活与关系账本/, /生产节律/, /地域空间/, /返乡不自动等于和解/, /文旅宣传/],
  table: [/生活与劳动拆镜/, /家庭与社区空间/, /往返路线/, /季节/, /贫困凝视/],
};

test("only the production-agent manual contracts are treated as active", () => {
  const activeNames = new Set(Object.values(PRODUCTION_STAGE_DEFINITIONS).flatMap((definition) => definition.skills.map((skill) => skill.name)));
  assert.equal(activeNames.has("director_planning_style"), true);
  assert.equal(activeNames.has("director_planning_narrative"), true);
  assert.equal(activeNames.has("director_storyboard_table_narrative"), true);
  assert.equal(activeNames.has("director_storyboard_table_style"), false);
  assert.equal(activeNames.has("director_storyboard"), false);

  assert.deepEqual(PRODUCTION_STAGE_DEFINITIONS.directorPlan.skills.map((skill) => skill.name), [
    "director_planning_style",
    "director_planning_narrative",
  ]);
  assert.deepEqual(PRODUCTION_STAGE_DEFINITIONS.storyboardTable.skills.map((skill) => skill.name), [
    "storyboard_table_techniques",
    "director_storyboard_table_narrative",
  ]);
  assert.deepEqual(PRODUCTION_STAGE_DEFINITIONS.storyboardPanel.skills.map((skill) => skill.name), [
    "storyboard_prompt_techniques",
  ]);
});

test("all 352 director combinations and every storyboard topic resolve through the real stage loader", async () => {
  const visualPackages = packages(visualRoot);
  const directorPackages = packages(directorRoot);
  assert.equal(visualPackages.length, 16);
  assert.equal(directorPackages.length, 22);

  for (const visual of visualPackages) {
    assert.match(readSkill(visualRoot, visual, "director_planning_style.md"), /^---\nname: director_planning_style/m);
  }
  for (const director of directorPackages) {
    assert.match(readSkill(directorRoot, director, "director_planning_narrative.md"), /^---\nname: director_planning_narrative/m);
    assert.match(
      readSkill(directorRoot, director, "director_storyboard_table_narrative.md"),
      /^---\nname: director_storyboard_table_narrative/m,
    );
  }

  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.info = () => undefined;
  console.warn = () => undefined;
  try {
    let combinations = 0;
    for (const visual of visualPackages) {
      for (const director of directorPackages) {
        for (const stage of ["directorPlan", "supervisionDirectorPlan"] as const) {
          const loaded = await loadProductionStage({ stage, artStyle: visual, directorManual: director });
          assert.deepEqual(loaded.definition.skills.map((skill) => skill.name), [
            "director_planning_style",
            "director_planning_narrative",
          ], `${stage}: ${visual} + ${director}`);
          assert.match(loaded.prompt, /director_planning_style/);
          assert.match(loaded.prompt, /director_planning_narrative/);
          assert.doesNotMatch(loaded.prompt, /<name>director_storyboard_table_style<\/name>|<name>director_storyboard<\/name>/);
        }
        combinations += 1;
      }
    }
    assert.equal(combinations, 352);

    for (const director of directorPackages) {
      for (const stage of ["storyboardTable", "supervisionStoryboardTable"] as const) {
        const loaded = await loadProductionStage({ stage, artStyle: visualPackages[0], directorManual: director });
        assert.deepEqual(loaded.definition.skills.map((skill) => skill.name), [
          "storyboard_table_techniques",
          "director_storyboard_table_narrative",
        ], `${stage}: ${director}`);
        assert.match(loaded.prompt, /storyboard_table_techniques/);
        assert.match(loaded.prompt, /director_storyboard_table_narrative/);
        assert.doesNotMatch(loaded.prompt, /<name>director_storyboard_table_style<\/name>|<name>director_storyboard<\/name>/);
      }
    }
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
  }
});

test("the 20 new Director manuals contain domain methods without execution-layer disclaimers", () => {
  const newVisuals = [
    "realpeople_republican_period",
    "realpeople_professional_documentary",
    "realpeople_sports_cinematic",
    "realpeople_rural_naturalism",
  ];
  const newTopics = [
    "Ancient_political_intrigue",
    "Wuxia_jianghu",
    "Crime_investigation",
    "Republican_espionage",
    "Medical_rescue",
    "Legal_judicial",
    "Sports_competition",
    "Rural_hometown",
  ];
  const confusedResponsibilities = /执行层|数据库|持久化|模型参数|废弃\s*Skill|状态写回/;

  for (const visual of newVisuals) {
    const content = readSkill(visualRoot, visual, "director_planning_style.md");
    assert.doesNotMatch(content, confusedResponsibilities, visual);
    assert.match(content, /曝光/);
    assert.match(content, /轴线/);
    assert.match(content, /材质/);
    assert.match(content, /现场声|声音/);
    assert.ok(content.split("\n").length >= 65, visual);
  }

  for (const topic of newTopics) {
    for (const file of ["director_planning_narrative.md", "director_storyboard_table_narrative.md"]) {
      const content = readSkill(directorRoot, topic, file);
      assert.doesNotMatch(content, confusedResponsibilities, `${topic}/${file}`);
      assert.match(content, /事实|确认/);
      assert.match(content, /空间|方向|轴线|路线/);
      assert.match(content, /变化|连续/);
    }
  }
});

test("all active type-specific Director manuals contain their distinct direction methods", () => {
  for (const [packageName, requirements] of Object.entries(visualRequirements)) {
    const content = readSkill(visualRoot, packageName, "director_planning_style.md");
    assert.match(content, /轴线/);
    assert.match(content, /导演规划应用检查|声音与检查/);
    assert.match(content, /禁止|不得/);
    assert.match(content, /新增|增加|添加|补写|待确认|默认|虚构|推断/);
    for (const requirement of requirements) assert.match(content, requirement, packageName);
  }

  for (const [packageName, requirements] of Object.entries(genreRequirements)) {
    const planning = readSkill(directorRoot, packageName, "director_planning_narrative.md");
    const table = readSkill(directorRoot, packageName, "director_storyboard_table_narrative.md");
    assert.match(planning, /导演规划应用检查|检查与禁止/);
    assert.match(planning, /禁止|不得/);
    assert.match(table, /边界/);
    assert.doesNotMatch(table, /director_storyboard_table_style/);
    for (const requirement of requirements.planning) assert.match(planning, requirement, `${packageName} planning`);
    for (const requirement of requirements.table) assert.match(table, requirement, `${packageName} storyboard`);
  }
});

test("active Director manuals have one hierarchy and contain no execution-layer contract", () => {
  const executionPattern = /activate_skill|begin_\w+|append_\w+|commit_\w+|写入数据库|任务状态|状态流转/;
  for (const skill of upgradedDirectorSkills()) {
    const content = fs.readFileSync(skill.path, "utf8").replace(/\r\n/g, "\n");
    const topLevelHeadings = [...content.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim());
    assert.equal(content.includes("Production Agent 执行层（合并升级）"), false, skill.path);
    assert.equal(new Set(topLevelHeadings).size, topLevelHeadings.length, `duplicate heading: ${skill.path}`);
    assert.doesNotMatch(content, /^#{3,6}\s+[一二三四五六七八九十]+、/m, `nested original manual: ${skill.path}`);
    assert.doesNotMatch(content, executionPattern, `execution responsibility leaked into ${skill.path}`);
  }

  const executionSkills = [
    fs.readFileSync(path.join(skillsRoot, "production_execution_director_plan.md"), "utf8"),
    fs.readFileSync(path.join(skillsRoot, "production_execution_storyboard_table.md"), "utf8"),
  ].join("\n");
  assert.match(executionSkills, /activate_skill/);
  assert.match(executionSkills, /begin_director_plan/);
  assert.match(executionSkills, /append_storyboard_rows/);
  assert.match(executionSkills, /commit_storyboard_table/);
});

test("Survival_island preserves factual survival constraints without inventing an island plot", () => {
  const planning = readSkill(directorRoot, "Survival_island", "director_planning_narrative.md");
  const table = readSkill(directorRoot, "Survival_island", "director_storyboard_table_narrative.md");

  assert.match(planning, /岛屿区域及其相对方向/);
  assert.match(planning, /日照阶段、天气、温度、潮位趋势和可行动窗口/);
  assert.match(planning, /获得、消耗、转移、损坏、遗失、不可用、未知/);
  assert.match(planning, /场前条件 → 当前目标 → 可见尝试 → 阻力 → 代价 → 状态变化 → 下一场压力/);
  assert.match(planning, /知识权.*路线决定权.*资源保管权.*照料责任.*风险承担/);
  assert.match(planning, /连接路线、可辨地标、人物可见范围、现场声可传播或被遮挡的条件、退路和潮汐边界/);
  assert.match(planning, /荒岛常见元素.*补写/);
  assert.match(planning, /信号是否被发出、是否被接收、何时到达都不可自行保证/);
  assert.match(planning, /浪声、风穿植被/);
  assert.match(planning, /剧本事实与既有资产 > 空间和状态连续 > 人物可执行行动 > 类型氛围/);
  assert.match(table, /信息建立 → 人物评估 → 动作准备 → 接触阻力 → 结果确认 → 状态写回/);
  assert.match(table, /变化前条件、造成变化的关键动作、变化后状态/);
  assert.match(table, /寻找或观察/);
  assert.match(table, /采集或取用/);
  assert.match(table, /搬运或转移/);
  assert.match(table, /搭建或修补/);
  assert.match(table, /照料/);
  assert.match(table, /求援或联络/);
  assert.match(table, /海在画面哪一侧/);
  assert.match(table, /潮间带/);
  assert.match(table, /林地或林缘/);
  assert.match(table, /洞穴或洞口：只有事实确认时使用/);
  assert.match(table, /分队、折返、失散、会合、潮位变化或跨区域转场/);
  assert.match(table, /环境建立镜头.*行动中景.*物件或伤病状态近景.*反应镜头/);
  assert.match(table, /方向、距离及是否被风、植被、岩面或洞口遮蔽/);
  assert.match(table, /行动者 → 受影响者 → 观察者或回应者/);
  assert.doesNotMatch(`${planning}\n${table}`, /activate_skill|begin_\w+|append_\w+|commit_\w+|数据库写入|任务状态/);
  assert.doesNotMatch(`${planning}\n${table}`, /director_storyboard_table_style|director_storyboard\.md/);
});

test("realpeople_island_survival gives conditional live-action photography decisions without preset distress", () => {
  const style = readSkill(visualRoot, "realpeople_island_survival", "director_planning_style.md");

  for (const method of ["晴天直射", "阴天漫射", "树冠筛光", "雨前与雨后", "黄昏", "夜间有限光源"]) {
    assert.match(style, new RegExp(method));
  }
  assert.match(style, /行动与面部信息 → 关键物件和落脚面 → 环境高光 → 氛围暗部/);
  assert.match(style, /海平线/);
  assert.match(style, /潮线/);
  assert.match(style, /林缘/);
  assert.match(style, /稳定机位.*肩扛跟随.*手持.*远景/);
  assert.match(style, /湿沙颜色加深.*干沙更松散/);
  assert.match(style, /金属区分裸露反光、盐雾失光与已确认锈蚀/);
  assert.match(style, /风、浪和植被声需要保持镜头间方位连续/);
  assert.match(style, /不代替现场安全流程/);
  assert.doesNotMatch(style, /默认湿衣|默认晒伤|默认伤病|默认火源|默认营地设施|默认救援/);
});

test("Director rebuild is idempotent and the checked-in manuals are already stable", () => {
  const baseline = [
    "---",
    "name: director_planning_style",
    "description: sample",
    "metaData: director_skills",
    "---",
    "",
    "# Sample",
    "",
    "## 一、色彩",
    "",
    "原始色彩知识。",
    "",
    "## 二、空间",
    "",
    "原始空间知识。",
  ].join("\n");
  const broken = `${baseline}\n\n## Production Agent 执行层（合并升级）\n\n桥接文字。\n\n### 职责边界\n\n只读取事实。\n\n### 色光决策\n\n保留光源逻辑。\n\n### 输出要求\n\n写明选择依据。\n`;
  const rebuilt = rebuildDirectorSkillContent(baseline, broken, "visual");
  assert.equal(rebuildDirectorSkillContent(baseline, rebuilt, "visual"), rebuilt);
  assert.doesNotMatch(rebuilt, /Production Agent 执行层/);
  assert.match(rebuilt, /原始色彩知识/);
  assert.match(rebuilt, /保留光源逻辑/);
  assert.deepEqual(rebuildDirectorSkills(), []);
});

test("reference samples remain unchanged", () => {
  assert.equal(
    sha256(skillPath(visualRoot, "realpeople_urban_modern", "director_planning_style.md")),
    "1fe84d2d960f7e44c839eb30568c9bf6577f19546b7ec3e7ff10299986da486a",
  );
  assert.equal(
    sha256(skillPath(directorRoot, "Social_realist_drama", "director_planning_narrative.md")),
    "d6285ef94a4a7718986b19ead9fef419d2a2f3f43bbc1fa19d5c935dfdb131e6",
  );
  assert.equal(
    sha256(skillPath(directorRoot, "Social_realist_drama", "director_storyboard_table_narrative.md")),
    "bbe5624a2385678e3762242f7e8dc02d89fd3c1f95baba31f30fa156bd4625ba",
  );
});

test("startup sync includes the 94 upgraded active Director and Art skills", () => {
  const entries = Object.keys(STYLE_SKILL_PREVIOUS_HASHES);
  const newPackageIds = [
    "Ancient_political_intrigue",
    "Wuxia_jianghu",
    "Crime_investigation",
    "Republican_espionage",
    "Medical_rescue",
    "Legal_judicial",
    "Sports_competition",
    "Rural_hometown",
    "realpeople_republican_period",
    "realpeople_professional_documentary",
    "realpeople_sports_cinematic",
    "realpeople_rural_naturalism",
  ];
  assert.equal(entries.length, 94);
  assert.equal(entries.some((entry) => entry.endsWith("/director_storyboard_table_style.md")), false);
  assert.equal(entries.some((entry) => entry.endsWith("/director_storyboard.md")), false);
  assert.equal(entries.some((entry) => entry.endsWith("/art_storyboard_video.md")), false);
  assert.equal(entries.some((entry) => entry.includes("realpeople_urban_modern")), false);
  assert.equal(entries.filter((entry) => entry.startsWith("art_skills/")).length, 70);
  assert.equal(entries.filter((entry) => entry.includes("/art_prompt/")).length, 60);
  assert.equal(entries.filter((entry) => entry.startsWith("story_skills/")).length, 24);
  for (const packageId of newPackageIds) {
    assert.equal(entries.some((entry) => entry.includes(`/${packageId}/`) || entry.startsWith(`${packageId}/`)), false, packageId);
  }
  for (const [entry, hashes] of Object.entries(STYLE_SKILL_PREVIOUS_HASHES)) {
    assert.ok(Array.isArray(hashes));
    assert.ok(hashes.length >= 2);
    if (entry.includes("/driector_skills/director_")) assert.ok(hashes.length >= 7, entry);
  }
});
