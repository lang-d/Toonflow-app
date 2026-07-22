import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const source = fs.readFileSync(path.join(process.cwd(), "src", "socket", "routes", "productionAgent.ts"), "utf8");

test("production agent disconnect detaches the client without aborting the run", () => {
  assert.match(source, /recordAgentRunEvent\(currentRunContext\.runId, "client_detached"/);
  assert.match(source, /recordAgentRunEvent\(activeRun\.runId, "client_resumed"/);
  assert.doesNotMatch(source, /abortReason\s*=\s*"socket_disconnect"/);
  assert.doesNotMatch(source, /socket\.on\("disconnect"[\s\S]{0,800}abortController\?\.abort\(\)/);
  assert.doesNotMatch(source, /Socket disconnected before the Production Agent chat completed/);
});

test("production agent broadcasts lifecycle updates to the script room and restores latest terminal runs", () => {
  assert.match(source, /function productionAgentRoom\(context: ProductionAgentSocketContext\)/);
  assert.match(source, /socket\.join\(productionAgentRoom\(context\)\)/);
  assert.match(source, /socket\.leave\(productionAgentRoom\(context\)\)/);
  assert.match(source, /const createScopedResTool = \(\) =>/);
  assert.match(source, /new ResTool\([\s\S]{0,180}nsp\.to\(productionAgentRoom\(context\)\)\.emit\(event, \.\.\.args\)/);
  assert.match(source, /nsp\.to\(productionAgentRoom\(context\)\)\.emit\("agent:run:update"/);
  assert.match(source, /failed to restore run state after context update/);
  assert.match(source, /getLatestAgentRun\(scope\)/);
  assert.match(source, /latestRun[\s\S]{0,400}terminal: latestRun\.status !== "running"/);
});

const productionAgentSource = fs.readFileSync(
  path.join(process.cwd(), "src", "agents", "productionAgent", "index.ts"),
  "utf8",
);

test("storyboard panel review falls back to awaiting_user without overriding the model decision", () => {
  assert.match(productionAgentSource, /stage: "supervisionStoryboardPanel"/);
  assert.match(productionAgentSource, /!parentCtx\.runContext\.terminalIntent[\s\S]{0,260}setAwaitingUser/);
  assert.match(productionAgentSource, /reason: summarizeAgentReason\(reviewResponse \|\| response\)/);
  assert.match(productionAgentSource, /parentCtx\.runContext\.stopForTerminal\(\)/);
});

test("production agent only archives long outputs as process transcripts", () => {
  assert.match(productionAgentSource, /const shouldArchiveFullOutput = memoryContent\.length > 4000/);
  assert.doesNotMatch(productionAgentSource, /stage\.startsWith\("supervision"\)/);
  assert.match(productionAgentSource, /process transcript \(\$\{fullResponse\.length\} chars\)/);
});

test("production agent requires a model-declared terminal state", () => {
  assert.match(source, /let finalStatus: AgentRunStatus = "failed"/);
  assert.match(source, /AGENT_TERMINAL_DECLARATION_MISSING/);
  assert.match(source, /"terminal_declaration_missing"/);
  assert.match(productionAgentSource, /"complete_agent_run"/);
  assert.match(productionAgentSource, /recordAgentModelStreamFinished/);
});
