import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const source = fs.readFileSync(path.join(process.cwd(), "src", "socket", "routes", "productionAgent.ts"), "utf8");
const runRegistrySource = fs.readFileSync(path.join(process.cwd(), "src", "services", "productionAgentRunRegistry.ts"), "utf8");

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

test("production agent archives every supervision report and still archives other long outputs", () => {
  assert.match(
    productionAgentSource,
    /const shouldArchiveFullOutput = archiveOutput === true \|\| memoryContent\.length > 4000/,
  );
  assert.ok((productionAgentSource.match(/archiveOutput: true/g) || []).length >= 3);
  assert.match(productionAgentSource, /process transcript \(\$\{fullResponse\.length\} chars\)/);
});

test("production agent requires a model-declared terminal state", () => {
  assert.match(source, /let finalStatus: AgentRunStatus = "failed"/);
  assert.match(source, /AGENT_TERMINAL_DECLARATION_MISSING/);
  assert.match(source, /"terminal_declaration_missing"/);
  assert.match(productionAgentSource, /"complete_agent_run"/);
  assert.match(productionAgentSource, /recordAgentModelStreamFinished/);
});

test("production agent abort is addressed by isolation key and run id without locally faking a terminal status", () => {
  assert.match(runRegistrySource, /new Map<string, ProductionAgentRunControl>/);
  assert.match(runRegistrySource, /function controlKey\(isolationKey: string, runId: string\)/);
  assert.match(runRegistrySource, /stopProductionAgentRunControl\(isolationKey: string, runId: string\)/);
  assert.match(runRegistrySource, /control\.runContext\.abortReason = "user_stop"/);
  assert.match(source, /registerProductionAgentRunControl\(context\.isolationKey/);
  assert.match(source, /clearProductionAgentRunControl\(context\.isolationKey, createdRun\.run\.runId\)/);
  assert.match(source, /socket\.on\("abort", async \(data: \{ runId\?: string \}/);
  assert.match(source, /stopProductionAgentRunControl\(context\.isolationKey, runId\)/);
  assert.match(source, /recordAgentRunEvent\(runId, "abort_unavailable"/);
  assert.match(source, /broadcastRunUpdate\(\{ status: "running", run: activeRun, stopping: true \}\)/);
  assert.match(
    source,
    /else if \(runContext\.abortReason === "user_stop"\) \{\s*finalStatus = "cancelled";\s*finalReason = "用户已停止当前 Production Agent chat。";/,
  );
  assert.match(source, /finishAgentRun\(createdRun\.run\.runId, \{\s*status: finalStatus,/);
  assert.doesNotMatch(source, /finishAgentRun\(runId, \{\s*status: "cancelled"/);
});
