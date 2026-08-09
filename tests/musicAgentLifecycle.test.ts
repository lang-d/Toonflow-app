import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const socketSource = fs.readFileSync(path.join(root, "src", "socket", "routes", "musicProductionAgent.ts"), "utf8");
const sharedLifecycleSource = fs.readFileSync(path.join(root, "src", "socket", "routes", "sharedAgentLifecycle.ts"), "utf8");
const sharedRuntimeSource = fs.readFileSync(path.join(root, "src", "agents", "shared", "runtime.ts"), "utf8");
const sharedToolsSource = fs.readFileSync(path.join(root, "src", "agents", "shared", "tools.ts"), "utf8");
const agentRunSource = fs.readFileSync(path.join(root, "src", "services", "agentRun.ts"), "utf8");
const scopeSource = fs.readFileSync(path.join(root, "src", "services", "musicScope.ts"), "utf8");
const docsSource = fs.readFileSync(path.join(root, "docs", "frontend-production-music-integration.md"), "utf8");

test("music agent owns a detached run lifecycle without changing production routes", () => {
  assert.match(socketSource, /createAgentRun/);
  assert.match(sharedLifecycleSource, /recordAgentRunEvent\(activeRun\.runId, "client_resumed"/);
  assert.match(socketSource, /recordAgentRunEvent\(activeRun\.runId, "client_detached"/);
  assert.match(socketSource, /stopMusicAgentRunControl/);
  assert.doesNotMatch(socketSource, /socket\.on\("disconnect"[\s\S]{0,800}controller\.abort\(\)/);
  assert.match(socketSource, /submittedTasks/);
  assert.match(socketSource, /recordAgentTaskSubmitted\(runContext\.runId, task\)/);
  assert.match(agentRunSource, /agent_task_submitted: "agent_task_submitted"/);
  assert.doesNotMatch(socketSource, /refreshTargets/);
});

test("music socket switching preserves independent episode runs", () => {
  assert.doesNotMatch(socketSource, /music production agent is running; stop it before switching context/);
  assert.match(socketSource, /const chatContext = context/);
  assert.match(socketSource, /registerMusicAgentRunControl\(chatContext\.isolationKey/);
  assert.match(socketSource, /clearMusicAgentRunControl\(chatContext\.isolationKey/);
  assert.match(socketSource, /broadcastRunUpdate\(\{ status: "running", run: createdRun\.run \}, chatContext\)/);
});

test("music scope contains only run and memory isolation facts", () => {
  assert.match(scopeSource, /MUSIC_PROJECT_RUN_SCRIPT_ID = 0/);
  assert.match(scopeSource, /musicAgentRunScriptId/);
  assert.doesNotMatch(scopeSource, /refreshTargets|latestRun|activeRun|stage/);
});

test("music frontend contract uses the common run, timeline, task and memory recovery chain", () => {
  assert.match(docsSource, /Agent Run scriptId/);
  assert.match(docsSource, /\/agents\/getMemory/);
  assert.match(docsSource, /\/agent\/run\/detail/);
  assert.match(docsSource, /\/task\/status\/snapshot/);
  assert.match(docsSource, /isolated: true/);
  assert.match(docsSource, /disconnect\(\)/);
  assert.match(docsSource, /stage\/state` 已删除/);
  assert.match(docsSource, /MUSIC_PROMPT_CONFIG_INVALID/);
  assert.match(docsSource, /missingRequiredConfigKeys/);
  assert.match(docsSource, /proposedAction/);
  assert.match(docsSource, /AGENT_TERMINAL_DECLARATION_MISSING/);
});

test("music agent respects a declared terminal state before interpreting stream aborts", () => {
  const agentSource = fs.readFileSync(path.join(root, "src", "agents", "musicProductionAgent", "index.ts"), "utf8");
  assert.match(socketSource, /if \(runContext\.terminalIntent\) \{[\s\S]{0,260}finalStatus = runContext\.terminalIntent\.status/);
  assert.match(socketSource, /AGENT_TERMINAL_DECLARATION_MISSING/);
  assert.match(agentSource, /runAgentRuntime\(\{/);
  assert.match(agentSource, /createSharedAgentTools\(\{/);
  assert.match(sharedToolsSource, /const complete_agent_run = tool\(/);
  assert.match(sharedToolsSource, /const get_agent_task_status = tool\(/);
  assert.match(sharedToolsSource, /outcome\?: "completed" \| "task_submitted"/);
  assert.match(sharedRuntimeSource, /recordAgentModelStreamFinished/);
  assert.match(sharedRuntimeSource, /input\.runContext\?\.terminalIntent && !turnTimedOut/);
  assert.match(agentSource, /terminalCorrection:\s*\{/);
  assert.match(agentSource, /return \{ await_user_decision, complete_agent_run \}/);
  assert.match(sharedRuntimeSource, /toolChoice: "required"/);
  assert.match(sharedRuntimeSource, /Boolean\(input\.runContext\?\.terminalIntent\)/);
  assert.doesNotMatch(sharedToolsSource, /stopForTerminal/);
  assert.match(sharedRuntimeSource, /agent_terminal_correction_scheduled/);
  assert.match(sharedRuntimeSource, /AGENT_TERMINAL_CORRECTION_FAILED/);
  assert.match(sharedRuntimeSource, /agent_tool_started/);
  assert.match(sharedRuntimeSource, /agent_tool_finished/);
  assert.match(sharedRuntimeSource, /agent_turn_timeout/);
  assert.match(agentRunSource, /agent_turn_phase: "agent_turn_phase"/);
  assert.match(agentRunSource, /agent_terminal_correction_scheduled: "agent_terminal_correction_scheduled"/);
});

test("music agent uses independent decision, execution and supervision model roles", () => {
  const agentSource = fs.readFileSync(path.join(root, "src", "agents", "musicProductionAgent", "index.ts"), "utf8");
  const directorSource = fs.readFileSync(path.join(root, "src", "services", "musicDirector.ts"), "utf8");
  const reviewerSource = fs.readFileSync(path.join(root, "src", "services", "musicReviewer.ts"), "utf8");
  assert.match(agentSource, /musicProductionAgent:decisionAgent/);
  assert.match(agentSource, /musicProductionAgent:executionAgent/);
  assert.match(agentSource, /musicProductionAgent:supervisionAgent/);
  assert.match(directorSource, /modelKey: "musicProductionAgent:executionAgent"/);
  assert.match(reviewerSource, /modelKey: "musicProductionAgent:supervisionAgent"/);
});
