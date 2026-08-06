import { createHash } from "node:crypto";
import u from "@/utils";
import {
  buildProductionFlowDataKey,
  type ProductionFlowDataKey,
} from "@/services/productionFlowData";

export const PRODUCTION_RESOURCE_TEXT_DEFAULT_LIMIT = 16_000;
export const PRODUCTION_RESOURCE_TEXT_MAX_LIMIT = 64 * 1024;
export const PRODUCTION_RESOURCE_COLLECTION_DEFAULT_LIMIT = 10;
export const PRODUCTION_RESOURCE_COLLECTION_MAX_LIMIT = 20;

export const PRODUCTION_RESOURCE_KEYS = [
  "script",
  "scriptPlan",
  "storyboardTable",
  "assets",
  "assetAudioBindings",
  "storyboard",
] as const;

export type ProductionResourceKey = (typeof PRODUCTION_RESOURCE_KEYS)[number];
export type ProductionResourceOperation = "stat" | "search" | "read";
type ProductionResourceValue = string | unknown[];

type ResourceLocator = {
  v: 1;
  projectId: number;
  scriptId: number;
  key: string;
  version: string;
};

type ResourceCursor = {
  v: 1;
  resourceRef: string;
  operation: "search" | "read";
  query?: string;
  position: number;
};

export interface ProductionResourceAdapter {
  key: string;
  kind: "text" | "collection";
  version(projectId: number, scriptId: number): Promise<string>;
  load(projectId: number, scriptId: number): Promise<ProductionResourceValue>;
}

const adapters = new Map<string, ProductionResourceAdapter>();

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function encodeOpaque(prefix: string, value: unknown) {
  return `${prefix}${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

function decodeOpaque<T>(prefix: string, value: string): T {
  if (!value.startsWith(prefix)) throw new Error("INVALID_RESOURCE_REFERENCE");
  try {
    return JSON.parse(Buffer.from(value.slice(prefix.length), "base64url").toString("utf8")) as T;
  } catch {
    throw new Error("INVALID_RESOURCE_REFERENCE");
  }
}

async function scriptVersion(projectId: number, scriptId: number) {
  const script = await u.db("o_script").where({ projectId, id: scriptId }).first(
    "id",
    "content",
    "contentTextAssetId",
    "createTime",
  );
  if (!script) throw new Error("RESOURCE_NOT_FOUND");
  const textAsset = script.contentTextAssetId
    ? await u.db("o_textAsset").where({ projectId, id: script.contentTextAssetId }).first("id", "hash", "version", "updateTime")
    : null;
  return hash({ script, textAsset });
}

async function scriptPlanVersion(projectId: number, scriptId: number) {
  const asset = await u
    .db("o_textAsset")
    .where({ projectId, scriptId, targetType: "scriptPlan", state: "complete" })
    .orderBy("version", "desc")
    .orderBy("id", "desc")
    .first("id", "hash", "version", "size", "updateTime");
  const workData = await u
    .db("o_agentWorkData")
    .where("projectId", String(projectId))
    .andWhere("episodesId", String(scriptId))
    .first("id", "data");
  return hash({ asset: asset || null, fallback: asset ? null : workData || null });
}

async function storyboardVersion(projectId: number, scriptId: number) {
  const rows = await u
    .db("o_storyboard")
    .where({ projectId, scriptId })
    .orderBy("index", "asc")
    .orderBy("id", "asc")
    .select("*");
  const links = rows.length
    ? await u
        .db("o_assets2Storyboard")
        .whereIn(
          "storyboardId",
          rows.map((row: any) => Number(row.id)),
        )
        .orderBy("rowid")
        .select("storyboardId", "assetId")
    : [];
  const tasks = rows.length
    ? await u
        .db("o_editImageTask")
        .where("targetType", "storyboard")
        .whereIn(
          "targetId",
          rows.map((row: any) => Number(row.id)),
        )
        .select("id", "targetId", "nodeId", "status", "state", "reason", "updateTime")
    : [];
  const taskIds = tasks.map((task: any) => Number(task.id)).filter(Number.isFinite);
  const unifiedTasks = taskIds.length
    ? await u
        .db("o_tasks")
        .where("businessType", "image-flow")
        .whereIn("businessId", taskIds)
        .select("taskId", "businessId", "status")
    : [];
  return hash({ rows, links, tasks, unifiedTasks });
}

async function assetsVersion(projectId: number, scriptId: number) {
  const scriptAssets = await u.db("o_scriptAssets").where({ scriptId }).orderBy("assetId").select("assetId");
  const parentIds = scriptAssets.map((row: any) => Number(row.assetId)).filter(Number.isFinite);
  const bindings = parentIds.length
    ? await u.db("o_assetsRole2Audio").whereIn("assetsRoleId", parentIds).orderBy("assetsRoleId").select("assetsRoleId", "assetsAudioId")
    : [];
  const audioIds = bindings.map((row: any) => Number(row.assetsAudioId)).filter(Number.isFinite);
  const allParentIds = [...new Set([...parentIds, ...audioIds])];
  const rows = allParentIds.length
    ? await u
        .db("o_assets")
        .where({ projectId })
        .andWhere((query: any) => query.whereIn("id", allParentIds).orWhereIn("assetsId", allParentIds))
        .orderBy("id")
        .select("*")
    : [];
  const imageIds = rows.map((row: any) => Number(row.imageId)).filter(Number.isFinite);
  const images = imageIds.length
    ? await u.db("o_image").whereIn("id", imageIds).orderBy("id").select("id", "filePath", "state", "errorReason")
    : [];
  return hash({ scriptAssets, rows, bindings, images });
}

function createFlowDataAdapter(
  key: ProductionResourceKey,
  kind: ProductionResourceAdapter["kind"],
  version: ProductionResourceAdapter["version"],
): ProductionResourceAdapter {
  return {
    key,
    kind,
    version,
    async load(projectId, scriptId) {
      return (await buildProductionFlowDataKey(projectId, scriptId, key as ProductionFlowDataKey)) as ProductionResourceValue;
    },
  };
}

export function registerProductionResourceAdapter(adapter: ProductionResourceAdapter) {
  adapters.set(adapter.key, adapter);
}

registerProductionResourceAdapter(createFlowDataAdapter("script", "text", scriptVersion));
registerProductionResourceAdapter(createFlowDataAdapter("scriptPlan", "text", scriptPlanVersion));
registerProductionResourceAdapter(createFlowDataAdapter("storyboardTable", "text", storyboardVersion));
registerProductionResourceAdapter(createFlowDataAdapter("assets", "collection", assetsVersion));
registerProductionResourceAdapter(createFlowDataAdapter("assetAudioBindings", "collection", assetsVersion));
registerProductionResourceAdapter(createFlowDataAdapter("storyboard", "collection", storyboardVersion));

export function isProductionResourceKey(value: string): value is ProductionResourceKey {
  return (PRODUCTION_RESOURCE_KEYS as readonly string[]).includes(value);
}

export async function createProductionResourceRef(projectId: number, scriptId: number, key: string) {
  const adapter = adapters.get(key);
  if (!adapter) throw new Error(`RESOURCE_ADAPTER_NOT_FOUND: ${key}`);
  const version = await adapter.version(projectId, scriptId);
  const locator: ResourceLocator = { v: 1, projectId, scriptId, key, version };
  return {
    resourceRef: encodeOpaque("production-resource:", locator),
    resourceType: adapter.kind,
    key,
    version,
    readUnit: adapter.kind === "text" ? "character" : "item",
  };
}

function parseCursor(cursor: string, resourceRef: string, operation: "search" | "read", query?: string) {
  const parsed = decodeOpaque<ResourceCursor>("production-cursor:", cursor);
  if (
    parsed.v !== 1 ||
    parsed.resourceRef !== resourceRef ||
    parsed.operation !== operation ||
    (operation === "search" && parsed.query !== query)
  ) {
    throw new Error("INVALID_RESOURCE_CURSOR");
  }
  return parsed.position;
}

function createCursor(input: Omit<ResourceCursor, "v">) {
  return encodeOpaque("production-cursor:", { v: 1, ...input });
}

async function resolveResource(scope: { projectId: number; scriptId: number }, resourceRef: string) {
  const locator = decodeOpaque<ResourceLocator>("production-resource:", resourceRef);
  if (
    locator.v !== 1 ||
    locator.projectId !== scope.projectId ||
    locator.scriptId !== scope.scriptId ||
    !adapters.has(locator.key)
  ) {
    throw new Error("RESOURCE_SCOPE_MISMATCH");
  }
  const adapter = adapters.get(locator.key);
  if (!adapter) throw new Error(`RESOURCE_ADAPTER_NOT_FOUND: ${locator.key}`);
  const currentVersion = await adapter.version(scope.projectId, scope.scriptId);
  if (currentVersion !== locator.version) throw new Error("RESOURCE_CHANGED");
  return { locator, adapter, currentVersion };
}

export async function accessProductionResource(
  scope: { projectId: number; scriptId: number },
  input: {
    resourceRef: string;
    operation: ProductionResourceOperation;
    query?: string;
    position?: number;
    cursor?: string;
    limit?: number;
  },
) {
  const { locator, adapter, currentVersion } = await resolveResource(scope, input.resourceRef);
  if (input.operation === "stat") {
    const value = await adapter.load(scope.projectId, scope.scriptId);
    return {
      resourceRef: input.resourceRef,
      key: locator.key,
      resourceType: adapter.kind,
      version: currentVersion,
      readUnit: adapter.kind === "text" ? "character" : "item",
      size: value.length,
    };
  }

  const operation = input.operation;
  const cursorPosition = input.cursor
    ? parseCursor(input.cursor, input.resourceRef, operation, input.query)
    : undefined;
  const requestedPosition = Number(cursorPosition ?? input.position);
  const position = Math.max(0, Math.floor(Number.isFinite(requestedPosition) ? requestedPosition : 0));
  const value = await adapter.load(scope.projectId, scope.scriptId);

  if (operation === "read") {
    const maxLimit = adapter.kind === "text" ? PRODUCTION_RESOURCE_TEXT_MAX_LIMIT : PRODUCTION_RESOURCE_COLLECTION_MAX_LIMIT;
    const defaultLimit = adapter.kind === "text" ? PRODUCTION_RESOURCE_TEXT_DEFAULT_LIMIT : PRODUCTION_RESOURCE_COLLECTION_DEFAULT_LIMIT;
    const limit = Math.min(maxLimit, Math.max(1, Math.floor(Number(input.limit) || defaultLimit)));
    const end = Math.min(value.length, position + limit);
    const eof = end >= value.length;
    return {
      resourceRef: input.resourceRef,
      key: locator.key,
      version: currentVersion,
      returnedRange: { unit: adapter.kind === "text" ? "character" : "item", start: position, end },
      content: adapter.kind === "text" ? (value as string).slice(position, end) : undefined,
      items: adapter.kind === "collection" ? (value as unknown[]).slice(position, end) : undefined,
      nextCursor: eof ? null : createCursor({ resourceRef: input.resourceRef, operation, position: end }),
      eof,
    };
  }

  const query = String(input.query || "");
  if (!query) throw new Error("RESOURCE_SEARCH_QUERY_REQUIRED");
  const maxResults = adapter.kind === "text" ? 20 : PRODUCTION_RESOURCE_COLLECTION_MAX_LIMIT;
  const limit = Math.min(maxResults, Math.max(1, Math.floor(Number(input.limit) || 10)));
  const hits: Array<{ position: number; preview: string }> = [];
  let nextPosition = position;
  if (adapter.kind === "text") {
    const source = value as string;
    const sourceLower = source.toLocaleLowerCase();
    const queryLower = query.toLocaleLowerCase();
    let searchFrom = position;
    while (hits.length < limit) {
      const found = sourceLower.indexOf(queryLower, searchFrom);
      if (found < 0) {
        nextPosition = source.length;
        break;
      }
      hits.push({ position: found, preview: source.slice(Math.max(0, found - 80), Math.min(source.length, found + query.length + 80)) });
      searchFrom = found + Math.max(1, query.length);
      nextPosition = searchFrom;
    }
    const eof = sourceLower.indexOf(queryLower, nextPosition) < 0;
    return {
      resourceRef: input.resourceRef,
      key: locator.key,
      version: currentVersion,
      query,
      returnedRange: { unit: "character", start: position, end: nextPosition },
      hits,
      nextCursor: eof ? null : createCursor({ resourceRef: input.resourceRef, operation, query, position: nextPosition }),
      eof,
    };
  }

  const items = value as unknown[];
  let index = position;
  for (; index < items.length && hits.length < limit; index += 1) {
    const serialized = JSON.stringify(items[index]);
    const found = serialized.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
    if (found >= 0) hits.push({ position: index, preview: serialized.slice(Math.max(0, found - 80), found + query.length + 80) });
  }
  const eof = index >= items.length;
  return {
    resourceRef: input.resourceRef,
    key: locator.key,
    version: currentVersion,
    query,
    returnedRange: { unit: "item", start: position, end: index },
    hits,
    nextCursor: eof ? null : createCursor({ resourceRef: input.resourceRef, operation, query, position: index }),
    eof,
  };
}
