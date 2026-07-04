import { Knex } from "knex";
import { VISUAL_ASSET_TYPES, VisualAssetType, isVisualAssetType } from "@/services/assetTypes";

export function normalizeScriptAssetName(name: unknown) {
  return String(name ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

export function scriptAssetMatchKey(input: { name: unknown; type: unknown }) {
  return `${String(input.type)}:${normalizeScriptAssetName(input.name)}`;
}

export function isBaseVisualAsset(row: any) {
  return isVisualAssetType(row?.type) && row?.assetsId == null;
}

export async function listBaseVisualAssets(db: Knex | Knex.Transaction, projectId: number) {
  return db("o_assets")
    .where("projectId", projectId)
    .whereIn("type", VISUAL_ASSET_TYPES as unknown as string[])
    .whereNull("assetsId")
    .select("id", "name", "type", "describe");
}

export function buildUniqueBaseAssetIndex(rows: any[]) {
  const grouped = new Map<string, any[]>();
  for (const row of rows) {
    if (!isBaseVisualAsset(row)) continue;
    const key = scriptAssetMatchKey(row);
    if (!normalizeScriptAssetName(row.name)) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  }

  const unique = new Map<string, any>();
  const duplicates = new Set<string>();
  for (const [key, items] of grouped) {
    if (items.length === 1) {
      unique.set(key, items[0]);
    } else {
      duplicates.add(key);
    }
  }
  return { unique, duplicates };
}

export async function collectAssetTreeIds(db: Knex | Knex.Transaction, assetIds: number[]) {
  const roots = [...new Set(assetIds.map(Number).filter(Number.isFinite))];
  if (!roots.length) return [];
  const rows = await db("o_assets")
    .whereIn("id", roots)
    .orWhereIn("assetsId", roots)
    .select("id");
  return [...new Set(rows.map((row: any) => Number(row.id)).filter(Number.isFinite))];
}

export async function cleanupAssetRelations(db: Knex | Knex.Transaction, assetIds: number[]) {
  const ids = [...new Set(assetIds.map(Number).filter(Number.isFinite))];
  if (!ids.length) return;
  await db("o_scriptAssets").whereIn("assetId", ids).delete();
  await db("o_assets2Storyboard").whereIn("assetId", ids).delete();
  await db("o_directorAsset").whereIn("assetId", ids).delete();
  await db("o_assetsRole2Audio").whereIn("assetsRoleId", ids).orWhereIn("assetsAudioId", ids).delete();
}

export async function validateScriptAssetIds(db: Knex | Knex.Transaction, projectId: number, assetIds: number[]) {
  const requested = [...new Set(assetIds.map(Number).filter(Number.isFinite))];
  if (!requested.length) return { validAssetIds: [] as number[], invalidAssetIds: [] as number[] };

  const rows = await db("o_assets")
    .where("projectId", projectId)
    .whereIn("id", requested)
    .whereIn("type", VISUAL_ASSET_TYPES as unknown as string[])
    .whereNull("assetsId")
    .select("id");
  const validSet = new Set(rows.map((row: any) => Number(row.id)));
  return {
    validAssetIds: requested.filter((id) => validSet.has(id)),
    invalidAssetIds: requested.filter((id) => !validSet.has(id)),
  };
}

export async function replaceScriptAssetBindings(input: {
  db: Knex | Knex.Transaction;
  scriptId: number;
  projectId: number;
  assetIds: number[];
}) {
  const { validAssetIds, invalidAssetIds } = await validateScriptAssetIds(input.db, input.projectId, input.assetIds);
  if (invalidAssetIds.length) {
    throw new Error(`Invalid script asset ids for project ${input.projectId}: ${invalidAssetIds.join(", ")}`);
  }

  await input.db("o_scriptAssets").where({ scriptId: input.scriptId }).delete();
  if (validAssetIds.length) {
    await input.db("o_scriptAssets").insert(validAssetIds.map((assetId) => ({ scriptId: input.scriptId, assetId })));
  }
  return validAssetIds;
}

export function toVisualAssetType(value: unknown): VisualAssetType | null {
  return isVisualAssetType(value) ? value : null;
}
