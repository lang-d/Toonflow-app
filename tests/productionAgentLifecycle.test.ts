import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const source = fs.readFileSync(path.join(process.cwd(), "src", "socket", "routes", "productionAgent.ts"), "utf8");
const runRegistrySource = fs.readFileSync(path.join(process.cwd(), "src", "services", "productionAgentRunRegistry.ts"), "utf8");
const agentProxySource = fs.readFileSync(path.join(process.cwd(), "src", "socket", "routes", "agentProxy.ts"), "utf8");
const sharedLifecycleSource = fs.readFileSync(path.join(process.cwd(), "src", "socket", "routes", "sharedAgentLifecycle.ts"), "utf8");
const sharedRuntimeSource = fs.readFileSync(path.join(process.cwd(), "src", "agents", "shared", "runtime.ts"), "utf8");

test("production agent disconnect detaches the client without aborting the run", () => {
  assert.match(source, /recordAgentRunEvent\(runId, "client_detached"/);
  assert.match(sharedLifecycleSource, /recordAgentRunEvent\(activeRun\.runId, "client_resumed"/);
  assert.doesNotMatch(source, /abortReason\s*=\s*"socket_disconnect"/);
  assert.doesNotMatch(source, /socket\.on\("disconnect"[\s\S]{0,800}abortController\?\.abort\(\)/);
  assert.doesNotMatch(source, /Socket disconnected before the Production Agent chat completed/);
});

test("production agent broadcasts lifecycle updates to the script room and restores latest terminal runs", () => {
  assert.match(source, /function productionAgentRoom\(context: ProductionAgentSocketContext\)/);
  assert.match(source, /socket\.join\(productionAgentRoom\(context\)\)/);
  assert.match(source, /socket\.leave\(productionAgentRoom\(context\)\)/);
  assert.match(source, /const createScopedResTool = \(targetContext: ProductionAgentSocketContext\) =>/);
  assert.match(source, /createSharedAgentResTool\(/);
  assert.match(sharedLifecycleSource, /new ResTool\([\s\S]{0,220}sharedAgentRoom\(agentKey, scope\)/);
  assert.match(source, /\.to\(productionAgentRoom\(targetContext\)\)[\s\S]{0,100}\.emit\("agent:run:update"/);
  assert.match(source, /let runStateRestoreBarrier = createRunStateRestoreBarrier\(\{/);
  assert.match(source, /await runStateRestoreBarrier\.wait\(context\)/);
  assert.match(sharedLifecycleSource, /getLatestAgentRun\(sharedAgentRunScope/);
  assert.match(sharedLifecycleSource, /latestRun[\s\S]{0,400}terminal: latestRun\.status !== "running"/);
  assert.match(source, /getResumableAgentInterruption/);
  assert.match(source, /agent_run_resumed_from/);
  assert.match(source, /kind: "resumable_interruption"/);
});

test("production socket switching does not stop or block a run in another episode scope", () => {
  assert.doesNotMatch(source, /production agent is running; stop it before switching context/);
  assert.doesNotMatch(source, /let abortController|let currentRunContext|let heartbeatTimer/);
  assert.match(source, /const chatContext = context/);
  assert.match(source, /const currentController = new AbortController\(\)/);
  assert.match(source, /attachedRuns\.set\(createdRun\.run\.runId, chatContext\.isolationKey\)/);
  assert.match(source, /clearProductionAgentRunControl\(chatContext\.isolationKey, createdRun\.run\.runId\)/);
});

test("production agent uses the restored Run lifecycle instead of chat acknowledgements", () => {
  assert.match(source, /socket\.on\("chat", async \(data: ProductionAgentChatRequest\) =>/);
  assert.doesNotMatch(source, /ProductionAgentChatAck|clientMessageId|chat_accepted|chat_rejected|acknowledgementSent/);

  const updateContextAt = source.indexOf('socket.on("updateContext"');
  const updateContextSuccessAt = source.indexOf("callback?.({ success: true })", updateContextAt);
  const updateContextRestoreAt = source.indexOf("await previousRestoreBarrier.wait(previousContext)", updateContextAt);
  assert.ok(updateContextRestoreAt > updateContextAt && updateContextSuccessAt > updateContextRestoreAt);

  const chatAt = source.indexOf('socket.on("chat"');
  const restoreAt = source.indexOf("await chatRestoreBarrier.wait(chatContext)", chatAt);
  const activeRunAt = source.indexOf("activeRun = await getActiveAgentRun", chatAt);
  const createdAt = source.indexOf("createdRun = await createAgentRun({", chatAt);
  const runningAt = source.indexOf('broadcastRunUpdate({ status: "running", run: createdRun.run }, chatContext)', chatAt);
  const modelAt = source.indexOf("await agent.runDecisionAI(ctx)", chatAt);
  assert.ok(restoreAt > chatAt && activeRunAt > restoreAt);
  assert.ok(createdAt > activeRunAt && runningAt > createdAt && modelAt > runningAt);

  assert.match(source, /code: "CHAT_STATE_RESTORE_FAILED"/);
  assert.match(source, /code: "RUN_ALREADY_RUNNING"/);
  assert.match(source, /code: "CHAT_ACCEPT_FAILED"/);
  assert.match(source, /const emitChatRejected = \(/);
  assert.match(agentProxySource, /kind === "productionAgent" \|\| kind === "musicProductionAgent"/);
  assert.match(agentProxySource, /socket\.emit\("agent:run:update", \{/);
  assert.match(agentProxySource, /rejected: true,[\s\S]{0,100}code: "AGENT_UNAVAILABLE"/);
  assert.doesNotMatch(agentProxySource, /rejectPendingCallbacks|clientMessageId|accepted: false/);
  assert.doesNotMatch(source, /resultJson\.options|render.*options|chat.*options/i);
});

const productionAgentSource = fs.readFileSync(
  path.join(process.cwd(), "src", "agents", "productionAgent", "index.ts"),
  "utf8",
);
const agentContextSource = fs.readFileSync(
  path.join(process.cwd(), "src", "services", "agentContextCompaction.ts"),
  "utf8",
);
const productionStageSkillsSource = fs.readFileSync(
  path.join(process.cwd(), "src", "services", "productionStageSkills.ts"),
  "utf8",
);

test("storyboard panel execution returns objective results and review remains a separate model decision", () => {
  const panelExecution = productionAgentSource.match(
    /const run_sub_agent_storyboard_panel = tool\([\s\S]*?\n  \}\);\n\n  let storyboardPanelReviewFailure/,
  )?.[0];
  assert.ok(panelExecution);
  assert.match(panelExecution, /const response = await runAgent\([\s\S]*?return response;/);
  assert.doesNotMatch(panelExecution, /runStoryboardPanelSingleReview/);
  assert.doesNotMatch(panelExecution, /setAwaitingUser/);
  assert.doesNotMatch(panelExecution, /stopForTerminal/);
  assert.match(productionAgentSource, /const run_storyboard_panel_review = tool\(/);
  assert.match(productionAgentSource, /runStoryboardPanelSingleReview\(\{/);
  assert.match(productionAgentSource, /STORYBOARD_PANEL_REVIEW_FAILED/);
  assert.match(productionAgentSource, /if \(storyboardPanelReviewFailure\) throw new Error\(storyboardPanelReviewFailure\)/);
  assert.match(productionAgentSource, /storyboard_panel_single_review_failed/);
  assert.doesNotMatch(productionAgentSource, /report it without reading the full panel as a substitute/);
});

test("production agent archives full child transcripts and structured panel reviews outside Memory", () => {
  assert.match(
    productionAgentSource,
    /archiveOutput === true \|\| continuationFailure \|\| fullTranscript\.length > 4000/,
  );
  assert.ok((productionAgentSource.match(/archiveOutput: true/g) || []).length >= 2);
  assert.match(productionAgentSource, /process transcript \(\$\{input\.content\.length\} chars\)/);
  assert.match(productionAgentSource, /Storyboard panel structured review \(\$\{review\.result\.items\.length\} issues\)/);
  assert.doesNotMatch(productionAgentSource, /memory\.add\(memoryKey/);
});

test("production agent requires a model-declared terminal state", () => {
  assert.match(source, /let finalStatus: AgentRunStatus = "failed"/);
  assert.match(source, /AGENT_TERMINAL_DECLARATION_MISSING/);
  assert.match(source, /"terminal_declaration_missing"/);
  assert.match(productionAgentSource, /"complete_agent_run"/);
  assert.match(productionAgentSource, /recordAgentModelStreamFinished/);
  assert.match(productionAgentSource, /while \(!ctx\.runContext\?\.terminalIntent\)/);
  assert.match(productionAgentSource, /consumeAgentTurn\(/);
  assert.match(productionAgentSource, /agent_turn_continued/);
});

test("production decision agent delegates technical Turn execution to the shared runtime", () => {
  assert.match(productionAgentSource, /export async function runDecisionAI\(ctx: AgentContext\)[\s\S]{0,5000}runAgentRuntime\(\{/);
  assert.match(sharedRuntimeSource, /while \(!input\.runContext\?\.terminalIntent\)/);
  assert.match(sharedRuntimeSource, /recordAgentModelStreamFinished/);
  assert.match(sharedRuntimeSource, /agent_resumable_checkpoint/);
  assert.match(productionAgentSource, /requireTerminalIntent: false/);
  assert.match(sharedRuntimeSource, /input\.requireTerminalIntent === false[\s\S]{0,120}!isRecoverableTurn\(turn\)/);
  assert.match(sharedRuntimeSource, /const previousStop = input\.runContext\?\.requestStop/);
  assert.match(sharedRuntimeSource, /input\.runContext\.requestStop = previousStop/);
});

test("production agent uses one bounded continuation path for decision and child Turns", () => {
  assert.ok((productionAgentSource.match(/continueProductionAgentContext\(\{/g) || []).length >= 2);
  assert.ok((productionAgentSource.match(/createProductionAgentTurnInputGuard\(\{/g) || []).length >= 2);
  assert.ok((productionAgentSource.match(/stopWhen: turnInputGuard\.stopWhen/g) || []).length >= 2);
  assert.ok((productionAgentSource.match(/force: providerContextOverflow \|\| Boolean\(contextBoundary\)/g) || []).length >= 2);
  assert.doesNotMatch(productionAgentSource, /prepareStep: turnInputGuard\.prepareStep/);
  assert.doesNotMatch(productionAgentSource, /checkpointText:|finalStepText/);
  assert.match(agentContextSource, /\.invoke\(\{/);
  assert.match(agentContextSource, /maxRetries: 0/);
  assert.doesNotMatch(agentContextSource, /agentWorkingContextSchema|parseAiJsonWithSchema/);
  assert.match(productionAgentSource, /agent_turn_context_boundary/);
  assert.match(productionAgentSource, /context_budget_boundary/);
  assert.doesNotMatch(agentContextSource, /MAX_AGENT_TURN_INCREMENTAL_CONTEXT_CHARS|maxIncrementalChars|incremental_context/);
  assert.match(productionAgentSource, /AGENT_CONTEXT_OVERFLOW_REPEATED/);
  assert.match(productionAgentSource, /agent_resumable_checkpoint/);
  assert.match(productionAgentSource, /PRODUCTION_AGENT_MAX_CONSECUTIVE_LENGTH_TURNS = 4/);
  assert.match(productionAgentSource, /AGENT_CONSECUTIVE_LENGTH_LIMIT/);
  assert.match(productionAgentSource, /agent_context_compaction_failed/);
  assert.match(productionAgentSource, /agent_continuation_exhausted/);
  assert.doesNotMatch(productionAgentSource, /Re-read authoritative facts with tools if needed/);
  assert.doesNotMatch(productionAgentSource, /recentToolResults:/);
});

test("production stage Skills are stable Turn instructions rather than transient activation results", () => {
  assert.match(productionStageSkillsSource, /buildPreloadedProductionSkillPrompt/);
  assert.match(productionStageSkillsSource, /<skill_content name=/);
  assert.match(productionStageSkillsSource, /tools: skillTools \? \{ read_skill_file: skillTools\.read_skill_file \} : \{\}/);
  assert.doesNotMatch(productionStageSkillsSource, /prompt: skills\.length \? buildSkillPrompt/);
  assert.doesNotMatch(productionAgentSource, /严格按当前分镜表监督 Skill 的四遍协议执行/);
});

test("production agent abort is addressed by isolation key and run id without locally faking a terminal status", () => {
  assert.match(runRegistrySource, /new Map<string, ProductionAgentRunControl>/);
  assert.match(runRegistrySource, /function controlKey\(isolationKey: string, runId: string\)/);
  assert.match(runRegistrySource, /stopProductionAgentRunControl\(isolationKey: string, runId: string\)/);
  assert.match(runRegistrySource, /control\.runContext\.abortReason = "user_stop"/);
  assert.match(source, /registerProductionAgentRunControl\(chatContext\.isolationKey/);
  assert.match(source, /clearProductionAgentRunControl\(chatContext\.isolationKey, createdRun\.run\.runId\)/);
  assert.match(source, /socket\.on\("abort", async \(data: \{ runId\?: string \}/);
  assert.match(source, /stopProductionAgentRunControl\(context\.isolationKey, runId\)/);
  assert.match(source, /recordAgentRunEvent\(runId, "abort_unavailable"/);
  assert.match(source, /broadcastRunUpdate\(\{ status: "running", run: activeRun, stopping: true \}\)/);
  assert.match(source, /runContext\.bindRootStop\(\(\) => currentController\.abort\(\)\)/);
  assert.match(source, /if \(runContext\.abortReason === "user_stop"\) \{[\s\S]{0,220}else if \(runContext\.terminalIntent\)/);
  assert.match(sharedRuntimeSource, /onToolResultObserved: \(\{ success \}\) => \{[\s\S]{0,140}stopForTerminal/);
  assert.match(source, /finishAgentRun\(createdRun\.run\.runId, \{\s*status: finalStatus,/);
  assert.doesNotMatch(source, /finishAgentRun\(runId, \{\s*status: "cancelled"/);
});
