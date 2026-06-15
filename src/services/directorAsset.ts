import { v4 as uuid } from "uuid";
import u from "@/utils";

export type DirectorAssetType = "sceneShot" | "blockingShot" | "cameraShot" | "compositionRef";

export interface DirectorAssetSourceRef {
  source?: "asset" | "storyboard" | "local" | "generated" | "directorAsset";
  sourceId?: number | string;
  mediaPath?: string;
  order: number;
  label?: string;
}

export interface CreateDirectorAssetInput {
  base64Data: string;
  projectId: number;
  scriptId?: number | null;
  flowId?: number | null;
  nodeId: string;
  targetType?: "deriveAsset" | "storyboard";
  targetId?: number | null;
  assetType: DirectorAssetType;
  name: string;
  promptFragment?: string;
  sourceRefs: DirectorAssetSourceRef[];
  camera?: unknown;
  stageDraft?: unknown;
}

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const MAX_DIRECTOR_ASSET_BYTES = 25 * 1024 * 1024;

export class DirectorAssetError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "DirectorAssetError";
    this.statusCode = statusCode;
  }
}

function parseImageDataUrl(value: string) {
  const match = value.match(/^data:([^;]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw new DirectorAssetError("base64Data must be an image data URL");
  const mime = match[1].toLowerCase();
  const ext = MIME_TO_EXT[mime];
  if (!ext) throw new DirectorAssetError("Only jpeg, png and webp director screenshots are supported");
  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!buffer.length) throw new DirectorAssetError("Director screenshot is empty");
  if (buffer.length > MAX_DIRECTOR_ASSET_BYTES) throw new DirectorAssetError("Director screenshot is too large");
  return { mime, ext, buffer };
}

function normalizeSourceRefs(sourceRefs: DirectorAssetSourceRef[]) {
  return (sourceRefs || []).map((item, index) => ({
    source: item.source || "local",
    sourceId: item.sourceId ?? null,
    mediaPath: item.mediaPath ? u.mediaRef.normalizeMediaPath(item.mediaPath) : "",
    order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
    label: item.label || "",
  }));
}

async function validateOwnership(trx: any, input: CreateDirectorAssetInput) {
  const project = await trx("o_project").where("id", input.projectId).first("id");
  if (!project) throw new DirectorAssetError("Project does not exist", 404);

  if (input.scriptId != null) {
    const script = await trx("o_script").where({ id: input.scriptId, projectId: input.projectId }).first("id");
    if (!script) throw new DirectorAssetError("Script does not belong to the project", 400);
  }

  if (!input.targetType || input.targetId == null) return;
  if (input.targetType === "storyboard") {
    const storyboard = await trx("o_storyboard").where({ id: input.targetId, projectId: input.projectId }).first("id");
    if (!storyboard) throw new DirectorAssetError("Storyboard target does not belong to the project", 400);
    return;
  }
  const asset = await trx("o_assets").where({ id: input.targetId, projectId: input.projectId }).first("id");
  if (!asset) throw new DirectorAssetError("Asset target does not belong to the project", 400);
}

export async function createDirectorAsset(input: CreateDirectorAssetInput) {
  const { ext, buffer } = parseImageDataUrl(input.base64Data);
  const now = Date.now();
  const savePath = `/${input.projectId}/directorStage/${input.scriptId ?? "common"}/${uuid()}.${ext}`;
  await u.oss.writeFile(savePath, buffer);

  try {
    const result = await u.db.transaction(async (trx: any) => {
      await validateOwnership(trx, input);
      const sourceRefs = normalizeSourceRefs(input.sourceRefs || []);
      const promptFragment = input.promptFragment || "";
      const [assetId] = await trx("o_assets").insert({
        name: input.name,
        prompt: promptFragment,
        remark: JSON.stringify({
          directorAsset: true,
          assetType: input.assetType,
          directorNodeId: input.nodeId,
        }),
        type: "directorAsset",
        describe: promptFragment,
        scriptId: input.scriptId ?? null,
        projectId: input.projectId,
        startTime: now,
        promptState: "\u5df2\u5b8c\u6210",
      });
      const [imageId] = await trx("o_image").insert({
        filePath: savePath,
        type: "directorAsset",
        assetsId: assetId,
        model: "director-stage",
        state: "\u5df2\u5b8c\u6210",
      });
      await trx("o_assets").where("id", assetId).update({ imageId });
      const [directorAssetId] = await trx("o_directorAsset").insert({
        projectId: input.projectId,
        scriptId: input.scriptId ?? null,
        flowId: input.flowId ?? null,
        nodeId: input.nodeId,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        assetId,
        imageId,
        assetType: input.assetType,
        name: input.name,
        promptFragment,
        sourceRefs: JSON.stringify(sourceRefs),
        camera: input.camera == null ? null : JSON.stringify(input.camera),
        stageDraft: input.stageDraft == null ? null : JSON.stringify(input.stageDraft),
        createTime: now,
        updateTime: now,
      });
      const media = await u.mediaRef.toMediaRef(savePath, {
        id: imageId,
        source: "directorAsset",
        sourceId: directorAssetId,
        name: input.name,
      });
      return {
        id: directorAssetId,
        assetId,
        imageId,
        name: input.name,
        assetType: input.assetType,
        media,
      };
    });
    return result;
  } catch (error) {
    await u.oss.deleteFile(savePath).catch(() => {});
    throw error;
  }
}

export async function resolveDirectorAsset(
  id: number,
  options: { projectId?: number; knex?: any; requireActiveAsset?: boolean } = {},
) {
  const db = options.knex ?? u.db;
  const row = await db("o_directorAsset")
    .join("o_assets", "o_assets.id", "o_directorAsset.assetId")
    .join("o_image", "o_image.id", "o_directorAsset.imageId")
    .where("o_directorAsset.id", id)
    .select(
      "o_directorAsset.*",
      "o_assets.projectId as assetProjectId",
      "o_assets.name as assetName",
      "o_image.filePath",
      "o_image.type as imageType",
    )
    .first();
  if (!row) throw new DirectorAssetError(`Director asset ${id} does not exist`, 404);
  if (options.projectId != null && Number(row.projectId) !== Number(options.projectId)) {
    throw new DirectorAssetError(`Director asset ${id} does not belong to the project`, 400);
  }
  return row;
}

export async function deleteDirectorAssetsByAssetIds(assetIds: number[], knex: any = u.db) {
  if (!assetIds.length) return;
  await knex("o_directorAsset").whereIn("assetId", assetIds).delete();
}
