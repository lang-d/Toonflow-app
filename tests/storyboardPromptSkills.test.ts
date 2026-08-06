import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const skill = (file: string) => fs.readFileSync(path.join(root, "data", "skills", file), "utf8");
const director = skill("production_execution_director_plan.md");
const directorReview = skill("production_supervision_director_plan.md");
const table = skill("production_execution_storyboard_table.md");
const tableTechnique = skill("production_skills/storyboard_table_techniques.md");
const tableReview = skill("production_supervision_storyboard_table.md");
const panel = skill("production_execution_storyboard_panel.md");
const panelTechnique = skill("production_skills/storyboard_prompt_techniques.md");
const panelReview = skill("production_supervision_storyboard_panel.md");
const stageSource = fs.readFileSync(path.join(root, "src", "services", "productionStageSkills.ts"), "utf8");
const agentSource = fs.readFileSync(path.join(root, "src", "agents", "productionAgent", "index.ts"), "utf8");
const toolsSource = fs.readFileSync(path.join(root, "src", "agents", "productionAgent", "tools.ts"), "utf8");
const seedance = fs.readFileSync(path.join(root, "data", "modelPrompt", "video", "seedance2Multi-parameterMode.md"), "utf8");
const otherVideoProfiles = [
  "universalMulti-parameterMode.md",
  "universalFirstAndLastFrameMode.md",
  "wan2.6Single-imageFirstFrameMode.md",
].map((file) => fs.readFileSync(path.join(root, "data", "modelPrompt", "video", file), "utf8"));

test("director plan is a compact scene baseline rather than a pre-shot camera plan", () => {
  for (const key of [
    "inputCheck",
    "directorPrinciples",
    "visualScheme",
    "continuity",
    "rhythm",
    "sceneExecution",
    "soundBoundary",
    "transitions",
    "derivedAssets",
  ]) assert.match(director, new RegExp(`\\b${key}\\b`));
  assert.match(director, /一个核心导演目标，最多三项执行原则/);
  assert.match(director, /不做 BGM、配器、主题旋律或音乐 Prompt 设计/);
  assert.match(director, /普通硬切不列清单/);
  assert.match(director, /不得输出：[\s\S]*`axis-map`、逐场机位图/);
  assert.doesNotMatch(director, /```axis-map/);
});

test("director videoStyle is one stable public visual sentence", () => {
  assert.match(director, /公开媒介名称 → 轮廓\/造型语言 → 稳定材质表现 → 整体光色原则/);
  assert.match(director, /只适用于某个镜头或场景的内容(?:就)?不属于 `videoStyle`/);
  assert.match(director, /不从 `sceneExecution`、`rhythm` 或 `derivedAssets` 复制/);
  assert.match(directorReview, /只含媒介、轮廓\/造型、稳定材质和整体光色原则/);
  assert.match(directorReview, /不含内部(?:目录)? ID、场景\/天气\/人物\/道具\/动作/);
});

test("new storyboard writes use V3 as one chronological source", () => {
  assert.match(table, /type StoryboardTableRowV3/);
  assert.match(table, /version: 3/);
  assert.match(table, /V3 禁止出现 `picture`、`action`、`characters`、`visibleEmotion`/);
  assert.match(tableTechnique, /最早成立的可见状态 → 触发 → 连续变化 → 结束状态/);
  assert.match(tableTechnique, /若切开后下一镜必须重复上镜动作才能看懂/);
  assert.match(tableTechnique, /关键转折的可见表演/);
  assert.match(tableTechnique, /触发 → 一组必要的可见变化 → 结束状态/);
  assert.match(tableTechnique, /可读视觉载体.*独立反应或行动.*视觉中心/);
  assert.match(tableTechnique, /连续镜头若都没有新增事实.*应合并或缩短/);
  assert.match(tableTechnique, /普通对白、静态说明.*不为[“”]增加表演[“”]强行添加表情/);
  assert.match(table, /不另设情绪标签，不为普通对白补表情/);
  assert.match(table, /载体内容和另一人物的独立反应或行动硬塞同镜/);
  assert.match(table, /连续静场.*应合并或缩短/);
  assert.doesNotMatch(tableTechnique, /characters\[\]\./);
  assert.doesNotMatch(tableTechnique, /标准机位签名/);
});

test("preflight and grouping are not optimized to fill a model duration", () => {
  assert.match(table, /不以填满模型最大时长为目标/);
  assert.match(tableTechnique, /不是越接近(?:模型最大时长|上限)越好/);
  assert.match(tableTechnique, /为填满模型最大秒数.*强并/);
  assert.doesNotMatch(table, /indivisibleLongTake|axisSide|continuityHandoff|canCutAfter/);
});

test("storyboard writes expose factual post-write inspection and partial downstream results", () => {
  assert.match(stageSource, /"inspect_storyboard_table_change"/);
  assert.match(toolsSource, /inspect_storyboard_table_change:\s*tool\(/);
  assert.match(toolsSource, /inspectStoryboardTableChange\(\{/);
  assert.doesNotMatch(toolsSource, /repair_storyboard_table/);
  assert.match(toolsSource, /status:\s*issues\.length === 0 \? \("complete" as const\) : \("partial" as const\)/);
  assert.match(toolsSource, /updatedIds,/);
  assert.match(toolsSource, /failedTargets:/);
  assert.match(toolsSource, /submittedIds,/);
  assert.match(table, /本 generation 只调用一次 `commit_storyboard_table`/);
  assert.match(table, /inspect_storyboard_table_change/);
});

test("storyboard panel derives one earliest frame from version-native facts", () => {
  assert.match(panel, /read_storyboard_panel_targets/);
  assert.match(panel, /read_storyboard_panel_sources/);
  assert.match(panel, /禁止(?:读取|调用)[^\n]*`get_flowData\("storyboard"\)`/);
  assert.match(panel, /V3 的 `shotDescription` 是时间顺序事实/);
  assert.match(panel, /顶层返回当前正式导演规划的短 `videoStyle`/);
  assert.match(panel, /不读取导演规划全文/);
  assert.match(panelTechnique, /最早可信状态/);
  assert.match(panelTechnique, /(?:首个动作必然推出|动作成立所必需)的最小前态/);
  assert.match(panelTechnique, /不得继续取后续更戏剧化或更方便绘制的帧/);
  assert.match(panel, /由触发事件才出现的微表情或反应.*不得提前画入首帧/);
  assert.match(panel, /`voiceTone`、题材习惯和人物资产都不是补写视觉表演的依据/);
  assert.match(panelTechnique, /`@ImageN` 必须严格对应 `associateAssetsIds\[N - 1\]`/);
  assert.match(stageSource, /"read_storyboard_panel_targets"/);
  assert.match(stageSource, /"read_storyboard_panel_sources"/);
  const panelStage = stageSource.match(/storyboardPanel:\s*\{[\s\S]*?\n  \},\n  storyboardGenerate:/)?.[0] || "";
  const panelReviewStage = stageSource.match(/supervisionStoryboardPanel:\s*\{[\s\S]*?\n  \},\n\};/)?.[0] || "";
  assert.doesNotMatch(panelStage, /list_storyboard_generations|read_storyboard_generation/);
  assert.doesNotMatch(panelReviewStage, /list_storyboard_generations|read_storyboard_generation/);
  assert.match(agentSource, /shotDescription/);
  assert.match(agentSource, /update_storyboard_panel/);
});

test("reviews audit V3 chronology and splitting without restoring deleted fields", () => {
  assert.match(tableReview, /最早可见状态 → 触发 → 连续变化 → 结束状态/);
  assert.match(tableReview, /同一连续动作在相邻镜头中重复发生/);
  assert.match(tableReview, /多个独立视觉中心/);
  assert.match(tableReview, /可读视觉载体.*另一人物的独立反应或行动/);
  assert.match(tableReview, /相邻静场.*只有能列出相邻镜证据时才报告/);
  assert.match(tableReview, /关键可见表演/);
  assert.match(tableReview, /缺少可见表演证据/);
  assert.match(tableReview, /普通对白、静态说明.*不要求补微表情/);
  assert.match(tableReview, /V3 不审核 `picture`、`action`、`visibleEmotion`、`characters\[\]`/);
  assert.match(panelReview, /动作中途或结束结果/);
  assert.match(panelReview, /由触发才出现的反应是否没有被提前画入首帧/);
  assert.match(panelReview, /不得从 `voiceTone`、题材习惯或人物资产推断未写明的视觉表演/);
  assert.match(panelReview, /当前目标字段名、(?:该字段|目标字段)逐字证据/);
  assert.match(panelReview, /新发现（基线不可判定）/);
  assert.match(panelReview, /禁止(?:使用|调用) `get_flowData\("storyboard"\)`/);
});

test("Seedance profile branches V3 initial-frame handling on visualStart", () => {
  assert.match(seedance, /`visualStart=storyboardReference`/);
  assert.match(seedance, /唯一初始视觉依据/);
  assert.match(seedance, /不(?:再)?用文字复述人物站位、景别、机位、构图/);
  assert.match(seedance, /`visualStart=textFallback`/);
  assert.match(seedance, /完整 `shotDescription`/);
  assert.match(seedance, /`shotDescription` 是 V3 的唯一时间事实正文/);
  assert.match(seedance, /不要另行设计(?:一套)?情绪表演/);
  assert.match(seedance, /已明确的视线、表情、呼吸、手部或姿态变化，按其发生时段执行/);
  assert.match(seedance, /`voiceTone`.*不推断或新增视觉表情/);
  assert.match(seedance, /不要查找或推断 `visibleEmotion`、`characters\[\]`/);
  assert.match(seedance, /可为 Seedance 2\.0 重组、压缩和强化提示语/);
  assert.match(seedance, /不得替换或反转人物\/物件、空间方向、动作结果、时间顺序与因果/);
  const outputExample = seedance.match(/## 输出\s*([\s\S]*?)## 自检/)?.[1] || "";
  assert.match(outputExample, /开拍画面：\{有对应分镜图时沿用 @ImageN；无分镜图时依据本条分镜事实建立\}/);
  assert.doesNotMatch(outputExample, /textFallback|storyboardReference|visualStart/);
});

test("all active video profiles consume the same reduced handoff contract", () => {
  for (const profile of otherVideoProfiles) {
    assert.match(profile, /visualStart=storyboardReference/);
    assert.match(profile, /visualStart=textFallback/);
    assert.match(profile, /`shotDescription`.*V3.*唯一/);
    assert.match(profile, /不要查找或推断 `visibleEmotion`、`characters\[\]`/);
    assert.match(profile, /`voiceTone`.*(?:视觉表情|视觉)/);
    assert.doesNotMatch(profile, /Emotion: \{visibleEmotion\}|Characters: \{characters\}|\{groupIntent\}/);
  }
});

test("deprecated visual storyboard manuals remain outside active stages", () => {
  assert.doesNotMatch(stageSource, /director_storyboard_table_style/);
  assert.doesNotMatch(stageSource, /director_storyboard\.md/);
  assert.match(table, /不得激活已废弃的 `director_storyboard_table_style` 或 `director_storyboard`/);
});
