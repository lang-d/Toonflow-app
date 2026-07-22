import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const toolsSource = fs.readFileSync(path.join(repoRoot, "src", "agents", "productionAgent", "tools.ts"), "utf8");
const deriveSkill = fs.readFileSync(path.join(repoRoot, "data", "skills", "production_execution_derive_assets.md"), "utf8");

test("derive asset tool requires prompt and writes it separately from describe", () => {
  assert.match(toolsSource, /addDeriveAssetInputSchema/);
  assert.match(toolsSource, /prompt:\s*z\.string\(\)\.min\(1\)/);
  assert.match(toolsSource, /promptMode:\s*z\.enum\(\["preserve", "replace"\]\)/);
  assert.match(toolsSource, /describe:\s*deriveAsset\.desc/);
  assert.match(toolsSource, /prompt:\s*deriveAsset\.prompt/);
  assert.match(toolsSource, /update\(baseData\)/);
  assert.doesNotMatch(toolsSource, /where\("id", deriveAsset\.id\)\.update\(data\)/);
});

test("derive asset image generation submits tasks in the backend and reports per-asset results", () => {
  assert.match(toolsSource, /submitImageGeneration<GenerateDeriveAssetAck>\(socket,\s*"generateDeriveAsset"/);
  assert.match(toolsSource, /enqueueAssetImageGeneration/);
  assert.match(toolsSource, /ack\?\.success === false/);
  assert.match(toolsSource, /normalizeGenerateDeriveAssetResult/);
  assert.match(toolsSource, /summarizeGenerateDeriveAssetResult/);
  assert.doesNotMatch(toolsSource, /emitWithAckTimeout<GenerateDeriveAssetAck>\(socket,\s*"generateDeriveAsset"/);
  assert.doesNotMatch(toolsSource, /new Promise\(\(resolve\) => socket\.emit\("generateDeriveAsset"/);
  assert.doesNotMatch(toolsSource, /return "开始生成衍生资产"/);
});

test("derive asset skill keeps desc and prompt responsibilities separate", () => {
  assert.match(deriveSkill, /desc.*中文视觉差异说明，不是生图提示词/);
  assert.match(deriveSkill, /prompt.*可直接用于生成资产设定图的中文提示语/);
  assert.match(deriveSkill, /用户只要求“补提示词”时，只能补 `prompt`，不得覆盖 `desc`/);
  assert.match(deriveSkill, /prompt.*默认沿用父资产的设定图版式/);
  assert.match(deriveSkill, /只有用户明确要求改变版式、构图或视角时/);
  assert.match(deriveSkill, /`assets` 顶层数组中的条目才是父资产/);
  assert.match(deriveSkill, /不能把 `derive\[\]` 中的资产当成父资产/);
  assert.match(deriveSkill, /不得扫描全项目后批量重写无关资产/);
  assert.match(deriveSkill, /禁止用 `desc` 替代 `prompt`/);
  assert.match(deriveSkill, /promptMode/);
  assert.match(deriveSkill, /明确要求“重新写入、重做、修正、覆盖提示词”时必须使用 `replace`/);
});

test("derive asset skill preflights script facts against prompt coverage before writing", () => {
  assert.match(deriveSkill, /先做只读 Prompt 覆核/);
  assert.match(deriveSkill, /剧本关键事实 → 最终清单条目 → 覆盖资产 ID\/衍生 ID → Prompt 覆盖依据/);
  assert.match(deriveSkill, /覆盖判断只读取父资产和衍生资产的 `prompt`/);
  assert.match(deriveSkill, /不读取或分析图片内容/);
  assert.match(deriveSkill, /`图片已生成`、`图片待生成` 或 `未知`/);
  assert.match(deriveSkill, /立即停止本轮，\*\*不得调用\*\* `add_deriveAsset`/);
  assert.match(deriveSkill, /调用 `await_user_decision`/);
  assert.match(deriveSkill, /不得自行新增清单外衍生资产/);
});

test("derive asset skill describes typed asset sheets instead of storyboard frames", () => {
  assert.match(deriveSkill, /角色衍生资产/);
  assert.match(deriveSkill, /`assetsId` 必须等于顶层父资产 `assets\[i\]\.id`/);
  assert.match(deriveSkill, /不得等于 `derive\[j\]\.id`/);
  assert.match(deriveSkill, /只读取顶层父资产 `prompt` 中的版式事实/);
  assert.match(deriveSkill, /禁止写[“"]?三视图/);
  assert.match(deriveSkill, /父资产是四视图时写四视图/);
  assert.match(deriveSkill, /父资产是三视图时写三视图/);
  assert.match(deriveSkill, /保持同一角色身份一致/);
  assert.match(deriveSkill, /场景衍生资产/);
  assert.match(deriveSkill, /保持同一空间结构一致/);
  assert.match(deriveSkill, /视角方向和可见区域/);
  assert.match(deriveSkill, /道具衍生资产/);
  assert.match(deriveSkill, /默认沿用父道具资产的设定图版式/);
  assert.match(deriveSkill, /保持原始造型和材质识别一致/);
  assert.match(deriveSkill, /物理变化/);
  assert.match(deriveSkill, /不是分镜图，也不是某个镜头中的剧情瞬间/);
});

test("derive asset skill derives layout only from top-level parent prompt", () => {
  assert.match(deriveSkill, /`derive\[\]` 的 `name\/desc\/prompt\/src`/);
  assert.match(deriveSkill, /全部不能用来判断“三视图\/四视图”/);
  assert.match(deriveSkill, /顶层父资产 `src` 或 `media` 不参与本轮判断/);
  assert.match(deriveSkill, /覆盖、身份状态和设定图版式都只以顶层父资产 `prompt` 为依据/);
  assert.match(deriveSkill, /人像特写\+正视图\+侧视图\+后视图/);
  assert.match(deriveSkill, /四视图一致性/);
  assert.match(deriveSkill, /禁止写“三视图”“3视图”“白底三视图版式”/);
  assert.match(deriveSkill, /兄弟衍生的特殊历史状态/);
  assert.match(deriveSkill, /不能反推父资产版式/);
  assert.match(deriveSkill, /只有用户明确要求“沿用某个已有衍生资产的三视图\/白底3视图”/);
  assert.match(deriveSkill, /版式判定与输出前自检/);
  assert.match(deriveSkill, /最终 `prompt` 中的视图数量必须与顶层父资产 prompt 一致/);
});

test("derive asset skill blocks prompt pollution and temporal action language", () => {
  assert.match(deriveSkill, /禁止过程动作/);
  assert.match(deriveSkill, /先……然后……最终/);
  assert.match(deriveSkill, /cinematic/);
  assert.match(deriveSkill, /photorealistic/);
  assert.match(deriveSkill, /胶片颗粒/);
  assert.match(deriveSkill, /不使用 `@Image`、`@图4`/);
  assert.match(deriveSkill, /禁止抽象心理和氛围代替可见事实/);
});
