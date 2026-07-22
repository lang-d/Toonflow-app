import type { AgentRunContext } from "@/services/agentRun";

type MusicAgentRunControl = {
  runId: string;
  controller: AbortController;
  runContext: AgentRunContext;
};

const controls = new Map<string, MusicAgentRunControl>();

export function registerMusicAgentRunControl(isolationKey: string, control: MusicAgentRunControl) {
  controls.set(isolationKey, control);
}

export function getMusicAgentRunControl(isolationKey: string) {
  return controls.get(isolationKey) || null;
}

export function stopMusicAgentRunControl(isolationKey: string) {
  const control = controls.get(isolationKey);
  if (!control) return null;
  control.runContext.abortReason = "user_stop";
  control.controller.abort();
  return { runId: control.runId };
}

export function clearMusicAgentRunControl(isolationKey: string, runId: string) {
  const control = controls.get(isolationKey);
  if (control?.runId === runId) controls.delete(isolationKey);
}
