import u from "@/utils";
import { replaceScriptAssetBindings } from "@/services/scriptAssetBinding";

export const STORY_ARTIFACT_TYPES = ["idea", "bible", "outline", "episodeOutline", "sceneCard", "script", "review", "research"] as const;
export const STORY_ARTIFACT_STATUSES = ["draft", "active", "archived", "published"] as const;
export const STORY_ANNOTATION_STATUSES = ["open", "applied", "dismissed", "resolved"] as const;

export type StoryArtifactType = (typeof STORY_ARTIFACT_TYPES)[number];
export type StoryArtifactStatus = (typeof STORY_ARTIFACT_STATUSES)[number];
export type StoryAnnotationStatus = (typeof STORY_ANNOTATION_STATUSES)[number];

export interface StoryArtifactInput {
  projectId: number;
  type: StoryArtifactType;
  title: string;
  content: string;
  contentJson?: unknown;
  parentId?: number | null;
  status?: StoryArtifactStatus;
}

export interface StoryAnnotationInput {
  projectId: number;
  artifactId: number;
  blockId?: string | null;
  startOffset?: number | null;
  endOffset?: number | null;
  selectedText: string;
  comment: string;
}

function parseJson(value: unknown) {
  if (typeof value !== "string" || !value) return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringifyJson(value: unknown) {
  if (value == null || value === "") return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function normalizeArtifact(row: any) {
  if (!row) return null;
  return {
    ...row,
    contentJson: parseJson(row.contentJson),
    version: Number(row.version || 1),
  };
}

export function normalizeAnnotation(row: any) {
  if (!row) return null;
  return {
    ...row,
    artifactVersion: Number(row.artifactVersion || 1),
    startOffset: row.startOffset == null ? null : Number(row.startOffset),
    endOffset: row.endOffset == null ? null : Number(row.endOffset),
  };
}

async function assertProject(projectId: number) {
  const project = await u.db("o_project").where("id", projectId).first("id");
  if (!project) throw new Error("Project not found");
}

export async function listArtifacts(input: {
  projectId: number;
  type?: StoryArtifactType;
  status?: StoryArtifactStatus;
  includeArchived?: boolean;
}) {
  let query = u.db("o_storyArtifact").where("projectId", input.projectId);
  if (input.type) query = query.where("type", input.type);
  if (input.status) query = query.where("status", input.status);
  if (!input.includeArchived && !input.status) query = query.whereNot("status", "archived");
  const rows = await query.orderBy("updateTime", "desc").orderBy("id", "desc");
  return rows.map(normalizeArtifact);
}

export async function getArtifact(projectId: number, artifactId: number) {
  const row = await u.db("o_storyArtifact").where({ id: artifactId, projectId }).first();
  if (!row) throw new Error("Story artifact not found");
  return normalizeArtifact(row);
}

export async function createArtifact(input: StoryArtifactInput) {
  await assertProject(input.projectId);
  const now = Date.now();
  let version = 1;
  if (input.parentId) {
    const parent = await u.db("o_storyArtifact").where({ id: input.parentId, projectId: input.projectId }).first();
    if (!parent) throw new Error("Parent story artifact not found");
    version = Number(parent.version || 1) + 1;
  }
  const [id] = await u.db("o_storyArtifact").insert({
    projectId: input.projectId,
    type: input.type,
    title: input.title,
    content: input.content,
    contentJson: stringifyJson(input.contentJson),
    version,
    parentId: input.parentId ?? null,
    status: input.status ?? "draft",
    createTime: now,
    updateTime: now,
  });
  return getArtifact(input.projectId, Number(id));
}

export async function updateArtifact(input: {
  id: number;
  projectId: number;
  title?: string;
  content?: string;
  contentJson?: unknown;
  status?: StoryArtifactStatus;
}) {
  await getArtifact(input.projectId, input.id);
  const updateData: Record<string, unknown> = { updateTime: Date.now() };
  if (input.title != null) updateData.title = input.title;
  if (input.content != null) updateData.content = input.content;
  if (Object.prototype.hasOwnProperty.call(input, "contentJson")) updateData.contentJson = stringifyJson(input.contentJson);
  if (input.status != null) updateData.status = input.status;
  await u.db("o_storyArtifact").where({ id: input.id, projectId: input.projectId }).update(updateData);
  return getArtifact(input.projectId, input.id);
}

export async function archiveArtifact(projectId: number, artifactId: number) {
  return updateArtifact({ id: artifactId, projectId, status: "archived" });
}

export async function listAnnotations(input: {
  projectId: number;
  artifactId: number;
  status?: StoryAnnotationStatus;
}) {
  await getArtifact(input.projectId, input.artifactId);
  let query = u.db("o_storyAnnotation").where({ projectId: input.projectId, artifactId: input.artifactId });
  if (input.status) query = query.where("status", input.status);
  const rows = await query.orderBy("createTime", "asc").orderBy("id", "asc");
  return rows.map(normalizeAnnotation);
}

export async function createAnnotation(input: StoryAnnotationInput) {
  const artifact = await getArtifact(input.projectId, input.artifactId);
  const now = Date.now();
  const [id] = await u.db("o_storyAnnotation").insert({
    projectId: input.projectId,
    artifactId: input.artifactId,
    artifactVersion: artifact.version,
    blockId: input.blockId ?? null,
    startOffset: input.startOffset ?? null,
    endOffset: input.endOffset ?? null,
    selectedText: input.selectedText,
    comment: input.comment,
    status: "open",
    createTime: now,
    updateTime: now,
  });
  return normalizeAnnotation(await u.db("o_storyAnnotation").where({ id }).first());
}

export async function updateAnnotationStatus(input: {
  projectId: number;
  ids: number[];
  status: StoryAnnotationStatus;
}) {
  if (!input.ids.length) return [];
  await u.db("o_storyAnnotation").where("projectId", input.projectId).whereIn("id", input.ids).update({
    status: input.status,
    updateTime: Date.now(),
  });
  const rows = await u.db("o_storyAnnotation").where("projectId", input.projectId).whereIn("id", input.ids).orderBy("id", "asc");
  return rows.map(normalizeAnnotation);
}

export async function reviseArtifactWithAnnotations(input: {
  projectId: number;
  sourceArtifactId: number;
  title?: string;
  content: string;
  contentJson?: unknown;
  changeSummary?: string;
  annotationIds?: number[];
}) {
  const source = await getArtifact(input.projectId, input.sourceArtifactId);
  const openAnnotations = await listAnnotations({ projectId: input.projectId, artifactId: input.sourceArtifactId, status: "open" });
  const annotationIds = input.annotationIds?.length ? input.annotationIds : openAnnotations.map((item: any) => Number(item.id));
  const next = await createArtifact({
    projectId: input.projectId,
    type: source.type,
    title: input.title || source.title,
    content: input.content,
    contentJson: input.contentJson ?? source.contentJson,
    parentId: input.sourceArtifactId,
    status: "draft",
  });
  if (annotationIds.length) {
    await updateAnnotationStatus({ projectId: input.projectId, ids: annotationIds, status: "applied" });
  }
  await u.db("o_storyRevisionMap").insert({
    projectId: input.projectId,
    sourceArtifactId: input.sourceArtifactId,
    newArtifactId: next.id,
    annotationIds: JSON.stringify(annotationIds),
    changeSummary: input.changeSummary ?? "",
    createTime: Date.now(),
  });
  return next;
}

export async function publishArtifactToScript(input: {
  projectId: number;
  artifactId: number;
  scriptId?: number | null;
  name?: string;
  assets?: number[];
}) {
  const artifact = await getArtifact(input.projectId, input.artifactId);
  if (artifact.type !== "script") throw new Error("Only script artifacts can be published to script");
  const now = Date.now();
  let scriptId = input.scriptId ?? null;
  const name = input.name || artifact.title || "Untitled Script";
  if (scriptId) {
    const row = await u.db("o_script").where({ id: scriptId, projectId: input.projectId }).first();
    if (!row) throw new Error("Target script not found");
    await u.db("o_script").where({ id: scriptId, projectId: input.projectId }).update({
      name,
      content: artifact.content,
    });
  } else {
    const inserted = await u.db("o_script").insert({
      projectId: input.projectId,
      name,
      content: artifact.content,
      createTime: now,
    });
    scriptId = Number(inserted[0]);
  }
  if (input.assets) {
    await replaceScriptAssetBindings({
      db: u.db,
      scriptId,
      projectId: input.projectId,
      assetIds: input.assets,
    });
  }
  await updateArtifact({ id: input.artifactId, projectId: input.projectId, status: "published" });
  return { scriptId, artifactId: input.artifactId };
}

export async function getStoryContext(projectId: number) {
  const [project, scripts, novels, artifacts] = await Promise.all([
    u.db("o_project").where("id", projectId).first(),
    u.db("o_script").where("projectId", projectId).select("id", "name", "content").orderBy("id", "asc"),
    u.db("o_novel").where("projectId", projectId).select("id", "chapterIndex", "chapter", "event").orderBy("chapterIndex", "asc"),
    listArtifacts({ projectId, includeArchived: false }),
  ]);
  return { project, scripts, novels, artifacts };
}
