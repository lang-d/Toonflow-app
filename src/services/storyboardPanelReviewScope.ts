import crypto from "node:crypto";
import u from "@/utils";
import { getCommittedDirectorPlanVideoStyle } from "@/services/directorPlanGeneration";
import { parseStoryboardTableRow } from "@/services/storyboardTableContract";

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 20;

interface StoryboardPanelScopeRow {
  id: number;
  index: number | null;
  prompt: string;
  associateAssetsIds: number[];
  associateAssets: Array<{ assetId: number; name: string | null }>;
  shouldGenerateImage: boolean;
  factStatus: string;
  tableRowJson: unknown;
}

interface ReadStoryboardPanelTargetsInput {
  projectId: number;
  scriptId: number;
  snapshotId?: string;
  offset?: number;
  limit?: number;
  storyboardIds?: number[];
}

interface ReadStoryboardPanelSourcesInput {
  projectId: number;
  scriptId: number;
  snapshotId: string;
  storyboardIds: number[];
}

function normalizeIds(values: number[] | undefined) {
  return [...new Set((values || []).map(Number).filter(Number.isFinite))];
}

function parseTableRow(value: unknown) {
  if (value && typeof value === "object") return { tableRowJson: value, sourceError: null };
  if (typeof value !== "string" || !value.trim()) {
    return { tableRowJson: null, sourceError: "missing_table_row_json" };
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { tableRowJson: null, sourceError: "invalid_table_row_json" };
    }
    return { tableRowJson: parsed, sourceError: null };
  } catch {
    return { tableRowJson: null, sourceError: "invalid_table_row_json" };
  }
}

function staticPanelSource(value: unknown, factStatus: string) {
  const parsed = parseTableRow(value);
  if (!parsed.tableRowJson) {
    return {
      sourceError: parsed.sourceError || "invalid_table_row_json",
      source: null,
    };
  }
  const row = parseStoryboardTableRow(parsed.tableRowJson);
  if (!row || factStatus !== "ready") {
    return {
      sourceError: factStatus === "draft" ? "storyboard_fact_not_ready" : "invalid_table_row_json",
      source: null,
    };
  }
  if (row.version === 3) {
    return {
      sourceError: null,
      source: {
        version: 3,
        shotDescription: row.shotDescription,
        shotSize: row.shotSize,
        cameraAngle: row.cameraAngle || null,
        requiredAssets: row.requiredAssets,
      },
    };
  }
  return {
    sourceError: null,
    source: {
      version: row.version,
      picture: row.picture,
      shotSize: row.shotSize,
      cameraAngle: row.cameraAngle || null,
      requiredAssets: row.requiredAssets,
    },
  };
}

function snapshotFor(projectId: number, scriptId: number, rows: StoryboardPanelScopeRow[], videoStyle: string) {
  const value = JSON.stringify({
    projectId,
    scriptId,
    videoStyle,
    rows: rows.map((row) => ({
      id: row.id,
      index: row.index,
      prompt: row.prompt,
      associateAssetsIds: row.associateAssetsIds,
      associateAssets: row.associateAssets,
      shouldGenerateImage: row.shouldGenerateImage,
      factStatus: row.factStatus,
      tableRowJson: row.tableRowJson,
    })),
  });
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

async function loadStoryboardPanelScope(projectId: number, scriptId: number) {
  const videoStyle = await getCommittedDirectorPlanVideoStyle({ projectId, scriptId });
  const dbRows = await u
    .db("o_storyboard")
    .where({ projectId, scriptId })
    .orderBy("index", "asc")
    .orderBy("id", "asc")
    .select("id", "index", "prompt", "shouldGenerateImage", "factStatus", "tableRowJson");
  const storyboardIds = dbRows.map((row: any) => Number(row.id)).filter(Number.isFinite);
  const assetLinks = storyboardIds.length
    ? await u
        .db("o_assets2Storyboard")
        .whereIn("o_assets2Storyboard.storyboardId", storyboardIds)
        .leftJoin("o_assets", "o_assets.id", "o_assets2Storyboard.assetId")
        .orderBy("o_assets2Storyboard.storyboardId", "asc")
        .orderBy("o_assets2Storyboard.rowid", "asc")
        .select("o_assets2Storyboard.storyboardId", "o_assets2Storyboard.assetId", "o_assets.name as assetName")
    : [];
  const assetsByStoryboard = new Map<number, Array<{ assetId: number; name: string | null }>>();
  for (const link of assetLinks) {
    const storyboardId = Number(link.storyboardId);
    if (!assetsByStoryboard.has(storyboardId)) assetsByStoryboard.set(storyboardId, []);
    assetsByStoryboard.get(storyboardId)!.push({
      assetId: Number(link.assetId),
      name: link.assetName == null ? null : String(link.assetName),
    });
  }
  const rows: StoryboardPanelScopeRow[] = dbRows.map((row: any) => ({
    id: Number(row.id),
    index: row.index == null ? null : Number(row.index),
    prompt: String(row.prompt || ""),
    associateAssets: assetsByStoryboard.get(Number(row.id)) || [],
    associateAssetsIds: (assetsByStoryboard.get(Number(row.id)) || []).map((asset) => asset.assetId),
    shouldGenerateImage: Number(row.shouldGenerateImage) !== 0,
    factStatus: String(row.factStatus || "legacy"),
    tableRowJson: row.tableRowJson ?? null,
  }));
  return { rows, videoStyle, snapshotId: snapshotFor(projectId, scriptId, rows, videoStyle) };
}

function assertSnapshot(expected: string | undefined, actual: string) {
  if (expected && expected !== actual) {
    throw new Error("分镜面板审核对象已变化，请从第一页重新读取当前目标字段并重新开始本轮审核");
  }
}

function selectRowsById(rows: StoryboardPanelScopeRow[], storyboardIds: number[]) {
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const missing = storyboardIds.filter((id) => !rowById.has(id));
  if (missing.length) {
    throw new Error(`分镜不属于当前项目/剧本或不存在：${missing.join(", ")}`);
  }
  return storyboardIds.map((id) => rowById.get(id)!);
}

export async function readStoryboardPanelTargets(input: ReadStoryboardPanelTargetsInput) {
  const scope = await loadStoryboardPanelScope(input.projectId, input.scriptId);
  assertSnapshot(input.snapshotId, scope.snapshotId);
  const requestedIds = normalizeIds(input.storyboardIds);
  const offset = Math.max(0, Number(input.offset || 0));
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(input.limit || DEFAULT_PAGE_SIZE)));
  const selectedRows = requestedIds.length
    ? selectRowsById(scope.rows, requestedIds)
    : scope.rows.slice(offset, offset + limit);
  const nextOffset = requestedIds.length || offset + selectedRows.length >= scope.rows.length
    ? null
    : offset + selectedRows.length;
  return {
    snapshotId: scope.snapshotId,
    total: scope.rows.length,
    offset: requestedIds.length ? null : offset,
    limit: requestedIds.length ? null : limit,
    nextOffset,
    items: selectedRows.map((row) => ({
      storyboardId: row.id,
      index: row.index,
      prompt: row.prompt,
      associateAssetsIds: row.associateAssetsIds,
      shouldGenerateImage: row.shouldGenerateImage,
    })),
  };
}

export async function readStoryboardPanelSources(input: ReadStoryboardPanelSourcesInput) {
  const storyboardIds = normalizeIds(input.storyboardIds);
  if (!storyboardIds.length) throw new Error("至少需要一个分镜 ID");
  if (storyboardIds.length > MAX_PAGE_SIZE) throw new Error(`单次最多读取 ${MAX_PAGE_SIZE} 个分镜来源`);
  const scope = await loadStoryboardPanelScope(input.projectId, input.scriptId);
  assertSnapshot(input.snapshotId, scope.snapshotId);
  const selectedRows = selectRowsById(scope.rows, storyboardIds);
  return {
    snapshotId: scope.snapshotId,
    videoStyle: scope.videoStyle,
    items: selectedRows.map((row) => ({
      storyboardId: row.id,
      index: row.index,
      factStatus: row.factStatus,
      ...staticPanelSource(row.tableRowJson, row.factStatus),
    })),
  };
}

/**
 * Builds one immutable, version-native fact package for a single model-only
 * storyboard-panel audit. This is deliberately a read-only transport shape:
 * it does not classify issues, score prompts, or mutate panel fields.
 */
export async function readStoryboardPanelReviewBundle(input: { projectId: number; scriptId: number }) {
  const scope = await loadStoryboardPanelScope(input.projectId, input.scriptId);
  return {
    snapshotId: scope.snapshotId,
    videoStyle: scope.videoStyle,
    total: scope.rows.length,
    items: scope.rows.map((row) => ({
      storyboardId: row.id,
      index: row.index,
      prompt: row.prompt,
      associateAssets: row.associateAssets.map((asset, position) => ({
        reference: `@Image${position + 1}`,
        ...asset,
      })),
      shouldGenerateImage: row.shouldGenerateImage,
      factStatus: row.factStatus,
      ...staticPanelSource(row.tableRowJson, row.factStatus),
    })),
  };
}
