import u from "@/utils";
import { parseMusicModelKey, resolveMusicModelCapabilities } from "@/services/musicModelCapability";

export type MusicModelSelectionErrorCode = "MUSIC_MODEL_REQUIRED" | "MUSIC_MODEL_UNAVAILABLE";

export class MusicModelSelectionError extends Error {
  constructor(
    readonly code: MusicModelSelectionErrorCode,
    message: string,
    readonly model: string | null = null,
  ) {
    super(message);
    this.name = "MusicModelSelectionError";
  }
}

async function requireProject(projectId: number) {
  const project = await u.db("o_project").where("id", projectId).first();
  if (!project) throw new Error("Project does not exist");
  return project;
}

async function assertAvailableMusicModel(model: string) {
  try {
    const { vendorId } = parseMusicModelKey(model);
    const enabled = await u.db("o_vendorConfig").where({ id: vendorId, enable: 1 }).first();
    if (!enabled) throw new Error("Music vendor is disabled");
    await resolveMusicModelCapabilities(model);
  } catch {
    throw new MusicModelSelectionError(
      "MUSIC_MODEL_UNAVAILABLE",
      "The selected music model is disabled or no longer available. Refresh the music model list and choose another model.",
      model,
    );
  }
  return model;
}

export async function getProjectDefaultMusicModel(projectId: number): Promise<string | null> {
  const project = await requireProject(projectId);
  const model = String(project.musicModel || "").trim();
  return model || null;
}

export async function setProjectDefaultMusicModel(projectId: number, model: string | null): Promise<string | null> {
  await requireProject(projectId);
  const normalized = String(model || "").trim();
  if (normalized) await assertAvailableMusicModel(normalized);
  await u.db("o_project").where("id", projectId).update({ musicModel: normalized || null });
  return normalized || null;
}

export async function resolveMusicExecutionModel(input: {
  projectId: number;
  model?: string | null;
}): Promise<string> {
  const project = await requireProject(input.projectId);
  const explicit = String(input.model || "").trim();
  const projectDefault = String(project.musicModel || "").trim();
  const model = explicit || projectDefault;
  if (!model) {
    throw new MusicModelSelectionError(
      "MUSIC_MODEL_REQUIRED",
      "No music model is selected and this project has no default music model.",
    );
  }
  return assertAvailableMusicModel(model);
}

export function musicModelSelectionErrorData(cause: unknown) {
  if (!(cause instanceof MusicModelSelectionError)) return null;
  return { code: cause.code, model: cause.model };
}
