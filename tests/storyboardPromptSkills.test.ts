import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const skillsRoot = path.join(repoRoot, "data", "skills");
const panelSkill = fs.readFileSync(path.join(skillsRoot, "production_execution_storyboard_panel.md"), "utf8");
const genSkill = fs.readFileSync(path.join(skillsRoot, "production_execution_storyboard_gen.md"), "utf8");
const tableSkill = fs.readFileSync(path.join(skillsRoot, "production_execution_storyboard_table.md"), "utf8");
const directorSkill = fs.readFileSync(path.join(skillsRoot, "production_execution_director_plan.md"), "utf8");
const promptSkill = fs.readFileSync(path.join(skillsRoot, "production_skills", "storyboard_prompt_techniques.md"), "utf8");
const tableTechnique = fs.readFileSync(path.join(skillsRoot, "production_skills", "storyboard_table_techniques.md"), "utf8");
const supervisionSkill = fs.readFileSync(path.join(skillsRoot, "production_agent_supervision.md"), "utf8");
const decisionSkill = fs.readFileSync(path.join(skillsRoot, "production_agent_decision.md"), "utf8");
const mainProcess = fs.readFileSync(path.join(repoRoot, "scripts", "main.ts"), "utf8");
const toolsSource = fs.readFileSync(path.join(repoRoot, "src", "agents", "productionAgent", "tools.ts"), "utf8");
const agentSource = fs.readFileSync(path.join(repoRoot, "src", "agents", "productionAgent", "index.ts"), "utf8");

test("storyboard panel reads planning and facts without loading the legacy storyboard style skill", () => {
  assert.match(panelSkill, /get_flowData\("scriptPlan"\)/);
  assert.match(panelSkill, /get_flowData\("storyboard"\)/);
  assert.match(panelSkill, /get_flowData\("assets"\)/);
  assert.match(panelSkill, /只允许调用 `update_storyboard_panel_v2`/);
  assert.match(panelSkill, /不得激活 `director_storyboard`/);
  assert.match(panelSkill, /不得激活或读取 `director_storyboard_table_style`/);
  assert.match(panelSkill, /不得根据 `artStyle` 名、视觉手册名、导演手册名或题材名自行补风格/);
  assert.doesNotMatch(panelSkill, /-\s+`director_storyboard`\s*$/m);
});

test("director plan owns the overall visual scheme inherited by later stages", () => {
  assert.match(directorSkill, /### ② 整体视觉方案与画面基调/);
  assert.match(directorSkill, /只写段落级\/场次级视觉方向/);
  assert.match(directorSkill, /不得写图片 Prompt、视频 Prompt、模型标签/);
  assert.match(directorSkill, /人物站位与视轴图/);
  assert.match(directorSkill, /真实空间俯视关系图/);
  assert.match(directorSkill, /每场必须有一张 `初态` 图/);
  assert.match(directorSkill, /单人场景保持简短/);
  assert.match(directorSkill, /仅当走位、主轴线、人物关系或空间控制权发生实际变化时/);
  assert.match(directorSkill, /未知锚点直接写 `\[缺口\] 未确认`/);
  assert.match(directorSkill, /图中用 `\[事实\]` 标记/);
  assert.match(directorSkill, /用 `\[规划\]` 标记/);
  assert.match(directorSkill, /\[缺口\] 未确认/);
  assert.match(directorSkill, /不得把“放到”改成“推到”/);
  assert.match(directorSkill, /不能补成门、窗、床或其他结构/);
  assert.doesNotMatch(directorSkill, /北 \/ 窗/);
  assert.doesNotMatch(directorSkill, /南 \/ 门/);
  assert.match(supervisionSkill, /②整体视觉方案与画面基调/);
  assert.match(supervisionSkill, /单人场景也需简短标出人物、已知锚点、朝向和主要机位半区/);
  assert.match(supervisionSkill, /实际变位时补关键变位图/);
});

test("storyboard table and supervision do not activate the visual table style skill", () => {
  assert.match(tableSkill, /`storyboard_table_techniques`/);
  assert.match(tableSkill, /`director_storyboard_table_narrative`/);
  assert.match(tableSkill, /不得激活 `director_storyboard_table_style`/);
  assert.doesNotMatch(tableSkill, /-\s+`director_storyboard_table_style`\s*$/m);
  assert.match(supervisionSkill, /加载 `storyboard_table_techniques` 与当前导演手册的 `director_storyboard_table_narrative`/);
  assert.match(supervisionSkill, /禁止调用 `director_storyboard_table_style`/);
});

test("generic storyboard table contracts stay topic agnostic", () => {
  const genericText = `${tableSkill}\n${tableTechnique}\n${supervisionSkill}`;
  for (const term of ["证据镜头", "现实压力", "公共暴露"]) {
    assert.doesNotMatch(genericText, new RegExp(term));
  }
});

test("storyboard table persists camera and blocking decisions for panel handoff", () => {
  assert.match(tableTechnique, /分镜面板交接契约/);
  assert.match(tableTechnique, /`cameraAngle` 使用标准机位签名/);
  assert.match(tableTechnique, /轴线｜机位组｜轴线侧\/半区｜人物视角｜镜头朝向/);
  assert.match(tableTechnique, /画面右侧中景；真实站位：已确认锚点旁/);
  assert.match(tableTechnique, /人物站位与视轴图/);
  assert.match(tableTechnique, /不可把俯视图中的左右位置机械抄成屏幕左右/);
  assert.match(tableTechnique, /关键变位时，必须从该变位动作开始更新真实站位/);
  assert.match(tableTechnique, /不得假设图片模型能从父场景主视图可靠反推反向空间/);
  assert.match(tableTechnique, /不得把父场景自动当成覆盖/);
  assert.match(tableTechnique, /分析中的“可推断但需确认”不得写入可用 ledger/);
  assert.match(tableTechnique, /只有标为 `已验证可用` 的现有资产可证明支持/);
  assert.match(tableTechnique, /不得把导演图中的 `\[规划\]` 或 `\[缺口\]` 当成参考图已证实的空间事实/);
  assert.match(tableTechnique, /“角色侧”或“正反打”等模糊值/);
  assert.match(tableTechnique, /正反打默认保持同一轴线侧/);
});

test("storyboard table runs an independent advisory review after commit", () => {
  assert.match(tableSkill, /审核后返修/);
  assert.match(tableSkill, /当前正式分镜表是唯一返修基线/);
  assert.match(tableTechnique, /生成前内部草算与提交前自检/);
  assert.match(supervisionSkill, /record_storyboard_table_review/);
  assert.match(agentSource, /supervisionStoryboardTableAgent/);
  assert.match(agentSource, /Recent awaiting-user run hint/);
  assert.match(agentSource, /list_production_reviews/);
  assert.match(agentSource, /read_storyboard_generation/);
  assert.match(agentSource, /agent_output_archived/);
  assert.doesNotMatch(agentSource, /first declare your interpreted intent/);
  assert.doesNotMatch(agentSource, /reviewStoryboardTable/);
});

test("storyboard table review waits for a persisted audit receipt and reports startup failures", () => {
  assert.match(agentSource, /modelKey:\s*"productionAgent:supervisionAgent"/);
  assert.match(agentSource, /storyboard_table_review_started/);
  assert.match(agentSource, /storyboard_table_review_recorded/);
  assert.match(agentSource, /storyboard_table_review_failed/);
  assert.match(agentSource, /Storyboard table review ended without recording its audit report/);
  assert.match(agentSource, /setFailed\(/);
  assert.match(toolsSource, /storyboard_table_review_recorded/);
  assert.doesNotMatch(toolsSource, /suggestionCount:\s*result\.count/);
  assert.match(toolsSource, /storyboard_prepare_started/);
  assert.match(toolsSource, /storyboard_prepare_completed/);
  assert.match(toolsSource, /update_agent_progress/);
});

test("production decision memory uses the original message times for recovery ordering", () => {
  assert.match(agentSource, /memory\.add\("user", text, \{ createTime: ctx\.userMessageTime \}\)/);
  assert.match(agentSource, /const decisionMessageTime = new Date\(ctx\.msg\.datetime\)\.getTime\(\)/);
  assert.match(
    agentSource,
    /memory\.add\("assistant:decision", removeAllXmlTags\(completion\.text\), \{ createTime: decisionMessageTime \}\)/,
  );
});

test("storyboard preparation runs inside the table agent before generation", () => {
  assert.match(tableSkill, /同一 Agent 内部预演/);
  assert.match(tableSkill, /`prepare_storyboard_table`/);
  assert.match(tableSkill, /同一次流式运行、同一份上下文/);
  assert.match(tableTechnique, /禁止为了模型时长删减台词、压缩表演、改变镜头顺序或增加填充空镜/);
  assert.match(supervisionSkill, /组边界节奏审校/);
  assert.match(decisionSkill, /不得自动拆镜或默认提出后期拼接/);
  assert.match(toolsSource, /prepare_storyboard_table/);
  assert.match(agentSource, /progressTitle:/);
  assert.match(toolsSource, /storyboardProgress \|\| msg\.thinking/);
  assert.doesNotMatch(agentSource, /planStoryboardGroupsBeforeGeneration/);
  assert.doesNotMatch(agentSource, /storyboardGroupPlanningAgent/);
});

test("storyboard panel supports update and confirmed full replace modes", () => {
  assert.match(toolsSource, /mode:\s*z\.enum\(\["update", "replace"\]\)/);
  assert.match(toolsSource, /applyStoryboardPanelImageFieldsWithDb/);
  assert.match(panelSkill, /默认使用 `mode: "update"`/);
  assert.match(panelSkill, /必须先停下向用户确认/);
  assert.match(panelSkill, /用户确认后才允许使用 `mode: "replace"`/);
  assert.match(panelSkill, /清空该分镜已有图片结果和图片画布探索/);
  assert.match(panelSkill, /replace 不修改 `tableRowJson`/);
});

test("storyboard image generation uses generate_storyboard and backend task submission", () => {
  assert.match(genSkill, /generate_storyboard\(\{ ids: \[分镜ID列表\] \}\)/);
  assert.match(genSkill, /后端统一走 `image-flow`/);
  assert.doesNotMatch(genSkill, /generate_storyboard_images/);
  assert.match(toolsSource, /submitImageGeneration<GenerateStoryboardAck>\(socket,\s*"generateStoryboard"/);
  assert.match(toolsSource, /enqueueStoryboardImageGeneration/);
  assert.match(toolsSource, /ack\?\.success === false/);
  assert.match(toolsSource, /normalizeGenerateStoryboardResult/);
  assert.doesNotMatch(toolsSource, /emitWithAckTimeout<GenerateStoryboardAck>\(socket,\s*"generateStoryboard"/);
  assert.doesNotMatch(toolsSource, /new Promise\(\(resolve\) => socket\.emit\("generateStoryboard"/);
  assert.doesNotMatch(toolsSource, /return "开始生成分镜"/);
});

test("production agent reads flow data from backend facts and marks terminal storyboard commit failures", () => {
  assert.match(toolsSource, /buildProductionFlowData/);
  assert.match(toolsSource, /terminal:\s*true/);
  assert.match(toolsSource, /storyboardValidationDecisionSummary/);
  assert.match(toolsSource, /GENERATION_SUPERSEDED/);
  assert.match(toolsSource, /storyboardGenerationLastFailure/);
  assert.doesNotMatch(toolsSource, /emitWithAckTimeout<FlowData>\(socket,\s*"getFlowData"/);
});

test("production skills require stop-on-failure and normalized storyboard generation status wording", () => {
  assert.match(tableSkill, /本轮写入立即锁定/);
  assert.match(tableSkill, /调用 `await_user_decision`/);
  assert.match(tableSkill, /GENERATION_SUPERSEDED/);
  assert.match(tableSkill, /COMMIT_IN_PROGRESS/);
  assert.match(tableSkill, /writing \/ invalid \/ failed \/ committing \/ superseded \/ committed \/ expired/);
  assert.match(directorSkill, /get_flowData.*失败或超时/);
  assert.match(directorSkill, /begin_director_plan → append_director_plan_section → commit_director_plan/);
  assert.match(directorSkill, /只有返回 `status=committed` 才算完成/);
  assert.doesNotMatch(directorSkill, /完整输出 `<scriptPlan>/);
  assert.match(panelSkill, /get_flowData.*失败或超时/);
  assert.match(panelSkill, /不得继续调用 `update_storyboard_panel_v2`/);
});

test("storyboard prompt technique defines a static Chinese prompt and ordered Image references", () => {
  assert.match(promptSkill, /单张静态画面/);
  assert.match(promptSkill, /静态性高于动作语义完整性/);
  assert.match(promptSkill, /除 `@ImageN` 外全部使用中文/);
  assert.match(promptSkill, /`@ImageN` 必须对应 `associateAssetsIds\[N - 1\]`/);
  assert.match(promptSkill, /左侧、右侧或中央/);
  assert.match(promptSkill, /正面、背面或侧面/);
  assert.match(promptSkill, /过程、次数、前史和后续结果/);
  assert.match(promptSkill, /不再、没有、无法看见、未显示/);
  assert.match(promptSkill, /所有事实也必须能在同一时刻成立/);
});

test("storyboard prompt technique freezes dynamic interactions into one visible state", () => {
  assert.match(promptSkill, /“某人递来物件”可冻结为/);
  assert.match(promptSkill, /“某人没有接”必须改写为可见状态/);
  assert.match(promptSkill, /“拿起可读物件查看内容”只能选择一个瞬间/);
  assert.match(promptSkill, /角色A位于画面左侧中景/);
  assert.match(promptSkill, /右手停在摊开的信件边缘/);
});

test("storyboard panel compiles camera, blocking, references, and hard conflicts", () => {
  assert.match(promptSkill, /场景连续性 ledger/);
  assert.match(promptSkill, /从 `cameraAngle` 读取标准机位签名，不重新选择轴线或机位/);
  assert.match(promptSkill, /`characters\[\]\.posture`.*硬约束/);
  assert.match(promptSkill, /最小充分引用/);
  assert.match(promptSkill, /P0 参考/);
  assert.match(promptSkill, /P1 参考/);
  assert.match(promptSkill, /参考资产与用途/);
  assert.match(promptSkill, /`shouldGenerateImage: false`/);
  assert.match(promptSkill, /压力释放、视觉句号、沉默对照、被证实/);
  assert.match(panelSkill, /阻断分镜和原因/);
});

test("storyboard panel review is read-only and waits for user-directed repair", () => {
  assert.match(supervisionSkill, /## 分镜面板审核/);
  assert.match(supervisionSkill, /机位继承/);
  assert.match(supervisionSkill, /人物空间忠实/);
  assert.match(supervisionSkill, /最小充分引用/);
  assert.match(supervisionSkill, /问题归属与返修边界/);
  assert.match(supervisionSkill, /报告展示后必须等待用户确认；不得自动派发返修/);
  assert.match(supervisionSkill, /报告是最终结论，不是过程转录/);
  assert.match(supervisionSkill, /审核通过的分镜不逐镜列出/);
  assert.match(supervisionSkill, /不设置固定字数上限；以简洁、完整表达结论为准/);
  assert.match(decisionSkill, /写入成功后会自动执行只读分镜面板审核/);
  assert.match(decisionSkill, /审核后不得自动返修/);
  assert.match(agentSource, /stage: "supervisionStoryboardPanel"/);
  assert.match(agentSource, /只读审核，不得执行返修/);
});

test("storyboard prompt technique rejects quality filler and limits style to the director plan", () => {
  assert.match(promptSkill, /`scriptPlan` 只提供短视觉原则/);
  assert.match(promptSkill, /视觉风格.*最多一句/);
  assert.match(promptSkill, /不主动添加任何风格锚词、画质词、媒介词或负向词/);
  assert.match(promptSkill, /不自行读取或复制视觉手册里的固定模板/);
  assert.match(promptSkill, /不根据 `artStyle` 名、视觉手册名、导演手册名或题材名推导/);
});

test("packaged startup refreshes builtin skills without replacing user skills", () => {
  assert.match(mainProcess, /ALWAYS_REFRESH_SYSTEM_ENTRIES = new Set\(\["serve", "web", "skills"\]\)/);
  assert.match(mainProcess, /const userDir = path\.resolve\(app\.getPath\("userData"\), "user"\)/);
});
