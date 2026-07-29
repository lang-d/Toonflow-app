import crypto from "node:crypto";
import u from "@/utils";

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 20;

interface StoryboardPanelScopeRow {
  id: number;
  index: number | null;
  prompt: string;
  associateAssetsIds: number[];
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

function snapshotFor(projectId: number, scriptId: number, rows: StoryboardPanelScopeRow[]) {
  const value = JSON.stringify({
    projectId,
    scriptId,
    rows: rows.map((row) => ({
      id: row.id,
      index: row.index,
      prompt: row.prompt,
      associateAssetsIds: row.associateAssetsIds,
      shouldGenerateImage: row.shouldGenerateImage,
      factStatus: row.factStatus,
      tableRowJson: row.tableRowJson,
    })),
  });
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

async function loadStoryboardPanelScope(projectId: number, scriptId: number) {
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
        .whereIn("storyboardId", storyboardIds)
        .orderBy("storyboardId", "asc")
        .orderBy("rowid", "asc")
        .select("storyboardId", "assetId")
    : [];
  const assetsByStoryboard = new Map<number, number[]>();
  for (const link of assetLinks) {
    const storyboardId = Number(link.storyboardId);
    if (!assetsByStoryboard.has(storyboardId)) assetsByStoryboard.set(storyboardId, []);
    assetsByStoryboard.get(storyboardId)!.push(Number(link.assetId));
  }
  const rows: StoryboardPanelScopeRow[] = dbRows.map((row: any) => ({
    id: Number(row.id),
    index: row.index == null ? null : Number(row.index),
    prompt: String(row.prompt || ""),
    associateAssetsIds: assetsByStoryboard.get(Number(row.id)) || [],
    shouldGenerateImage: Number(row.shouldGenerateImage) !== 0,
    factStatus: String(row.factStatus || "legacy"),
    tableRowJson: row.tableRowJson ?? null,
  }));
  return { rows, snapshotId: snapshotFor(projectId, scriptId, rows) };
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
    items: selectedRows.map((row) => ({
      storyboardId: row.id,
      index: row.index,
      factStatus: row.factStatus,
      ...parseTableRow(row.tableRowJson),
    })),
  };
}

