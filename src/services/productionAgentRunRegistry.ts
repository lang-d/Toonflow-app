import type { AgentRunContext } from "@/services/agentRun";

type ProductionAgentRunControl = {
  runId: string;
  controller: AbortController;
  runContext: AgentRunContext;
};

const controls = new Map<string, ProductionAgentRunControl>();

function controlKey(isolationKey: string, runId: string) {
  return `${isolationKey}:${runId}`;
}

export function registerProductionAgentRunControl(isolationKey: string, control: ProductionAgentRunControl) {
  controls.set(controlKey(isolationKey, control.runId), control);
}

export function stopProductionAgentRunControl(isolationKey: string, runId: string) {
  const control = controls.get(controlKey(isolationKey, runId));
  if (!control) return null;
  control.runContext.abortReason = "user_stop";
  control.controller.abort();
  return { runId: control.runId };
}

export function clearProductionAgentRunControl(isolationKey: string, runId: string) {
  controls.delete(controlKey(isolationKey, runId));
}
