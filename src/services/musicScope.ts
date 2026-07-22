import type { MusicScopeMode } from "@/services/musicDirector";

export type MusicScopeInput = {
  projectId: number;
  scriptId?: number | null;
  mode?: MusicScopeMode;
};

export const MUSIC_PROJECT_RUN_SCRIPT_ID = 0;

export function musicProjectIsolationKey(projectId: number) {
  return `musicProductionAgent:${projectId}:project`;
}

export function musicEpisodeIsolationKey(projectId: number, scriptId: number) {
  return `musicProductionAgent:${projectId}:episode:${scriptId}`;
}

export function resolveMusicIsolationKey(input: MusicScopeInput) {
  if (input.mode === "episode") {
    if (input.scriptId == null) throw new Error("scriptId is required in episode mode");
    return musicEpisodeIsolationKey(input.projectId, Number(input.scriptId));
  }
  return musicProjectIsolationKey(input.projectId);
}

export function musicAgentRunScriptId(input: Required<Pick<MusicScopeInput, "projectId">> & MusicScopeInput) {
  if (input.mode === "episode") {
    if (input.scriptId == null) throw new Error("scriptId is required in episode mode");
    return Number(input.scriptId);
  }
  return MUSIC_PROJECT_RUN_SCRIPT_ID;
}
