import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const socketSource = fs.readFileSync(path.join(root, "src", "socket", "routes", "scriptAgent.ts"), "utf8");
const toolsSource = fs.readFileSync(path.join(root, "src", "agents", "scriptAgent", "tools.ts"), "utf8");
const agentSource = fs.readFileSync(path.join(root, "src", "agents", "scriptAgent", "index.ts"), "utf8");
const skillSource = fs.readFileSync(path.join(root, "data", "skills", "script_agent_decision.md"), "utf8");

test("script agent cannot report a natural stream end as completed", () => {
  assert.match(socketSource, /let finalStatus: AgentRunStatus = "failed"/);
  assert.match(socketSource, /AGENT_TERMINAL_DECLARATION_MISSING/);
  assert.match(socketSource, /"terminal_declaration_missing"/);
});

test("script agent exposes explicit completion and stream diagnostics to the model lifecycle", () => {
  assert.match(toolsSource, /complete_agent_run/);
  assert.match(toolsSource, /runContext\.setCompleted/);
  assert.doesNotMatch(toolsSource, /runContext\.stopForTerminal/);
  assert.match(agentSource, /onToolResultObserved/);
  assert.match(agentSource, /stopForTerminal/);
  assert.match(agentSource, /recordAgentModelStreamFinished/);
  assert.match(skillSource, /complete_agent_run/);
  assert.match(skillSource, /update_agent_progress.*不能作为本轮结束/);
});
