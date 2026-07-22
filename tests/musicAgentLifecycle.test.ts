import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const socketSource = fs.readFileSync(path.join(root, "src", "socket", "routes", "musicProductionAgent.ts"), "utf8");
const scopeSource = fs.readFileSync(path.join(root, "src", "services", "musicScope.ts"), "utf8");
const docsSource = fs.readFileSync(path.join(root, "docs", "frontend-production-music-integration.md"), "utf8");

test("music agent owns a detached run lifecycle without changing production routes", () => {
  assert.match(socketSource, /createAgentRun/);
  assert.match(socketSource, /recordAgentRunEvent\(activeRun\.runId, "client_resumed"/);
  assert.match(socketSource, /recordAgentRunEvent\(activeRun\.runId, "client_detached"/);
  assert.match(socketSource, /stopMusicAgentRunControl/);
  assert.doesNotMatch(socketSource, /socket\.on\("disconnect"[\s\S]{0,800}controller\.abort\(\)/);
  assert.match(socketSource, /submittedTasks/);
  assert.doesNotMatch(socketSource, /refreshTargets/);
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
  const toolsSource = fs.readFileSync(path.join(root, "src", "agents", "musicProductionAgent", "tools.ts"), "utf8");
  const agentSource = fs.readFileSync(path.join(root, "src", "agents", "musicProductionAgent", "index.ts"), "utf8");
  assert.match(socketSource, /if \(runContext\.terminalIntent\) \{[\s\S]{0,260}finalStatus = runContext\.terminalIntent\.status/);
  assert.match(socketSource, /AGENT_TERMINAL_DECLARATION_MISSING/);
  assert.match(toolsSource, /complete_agent_run/);
  assert.match(agentSource, /recordAgentModelStreamFinished/);
});
