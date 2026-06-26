import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import isPathInside from "is-path-inside";
import u from "@/utils";
import { legacyDataRoot, storageMode, workspaceRoot } from "@/services/storagePaths";

export type TextAssetTargetType =
  | "storyboardTable"
  | "scriptPlan"
  | "agentOutput"
  | "videoPromptDraft"
  | "promptDiagnostic"
  | "reviewReport";

export type TextAssetState = "draft" | "complete" | "incomplete" | "archived";

export interface CreateTextAssetInput {
  projectId: number;
  scriptId?: number | null;
  targetType: TextAssetTargetType;
  targetId?: string | number | null;
  content: string;
  summary?: string;
  extension?: "md" | "json" | "txt";
  state?: TextAssetState;
}

export interface TextAssetContent {
  content: string;
  size: number;
  eof: boolean;
}

const TEXT_ASSET_ROOT = "textAssets";
const PROJECT_TEXT_ROOT = "projects";
const DEFAULT_PAGE_LIMIT = 128 * 1024;
const MAX_PAGE_LIMIT = 1024 * 1024;

function sha256(content: string) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function sanitizeSegment(value: unknown, fallback: string) {
  const cleaned = String(value ?? "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function normalizeRelativePath(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.includes("..")) throw new Error("Invalid text asset path");
  if (!normalized.startsWith(`${TEXT_ASSET_ROOT}/`) && !normalized.startsWith(`${PROJECT_TEXT_ROOT}/`)) {
    throw new Error("Invalid text asset root");
  }
  return normalized;
}

export function resolveTextAssetPath(filePath: string) {
  const relative = normalizeRelativePath(filePath);
  let root: string;
  let target: string;
  if (relative.startsWith(`${PROJECT_TEXT_ROOT}/`)) {
    root = path.resolve(workspaceRoot());
    target = path.resolve(workspaceRoot(), ...relative.split("/"));
  } else {
    root = path.resolve(legacyDataRoot(), TEXT_ASSET_ROOT);
    target = path.resolve(legacyDataRoot(), ...relative.split("/"));
    if (storageMode() === "workspace" && !(target === root || isPathInside(target, root))) {
      root = path.resolve(u.getPath(TEXT_ASSET_ROOT));
      target = path.resolve(u.getPath(relative.split("/")));
    }
  }
  if (target !== root && !isPathInside(target, root)) throw new Error("Invalid text asset path");
  return target;
}

async function nextTextAssetId() {
  const row: any = await u.db("o_textAsset").max("id as id").first();
  return Number(row?.id || 0) + 1;
}

export async function latestTextAsset(input: {
  projectId: number;
  scriptId?: number | null;
  targetType: TextAssetTargetType;
  targetId?: string | number | null;
  state?: TextAssetState;
}) {
  const query = u
    .db("o_textAsset")
    .where({ projectId: input.projectId, targetType: input.targetType })
    .orderBy("version", "desc")
    .orderBy("id", "desc");
  if (input.scriptId == null) query.whereNull("scriptId");
  else query.andWhere("scriptId", input.scriptId);
  if (input.targetId == null) query.whereNull("targetId");
  else query.andWhere("targetId", String(input.targetId));
  if (input.state) query.andWhere("state", input.state);
  return query.first();
}

async function nextVersion(input: {
  projectId: number;
  scriptId?: number | null;
  targetType: TextAssetTargetType;
  targetId?: string | number | null;
}) {
  const query = u.db("o_textAsset").where({ projectId: input.projectId, targetType: input.targetType });
  if (input.scriptId == null) query.whereNull("scriptId");
  else query.andWhere("scriptId", input.scriptId);
  if (input.targetId == null) query.whereNull("targetId");
  else query.andWhere("targetId", String(input.targetId));
  const row: any = await query.max("version as version").first();
  return Number(row?.version || 0) + 1;
}

export async function createTextAsset(input: CreateTextAssetInput) {
  const content = input.content ?? "";
  const now = Date.now();
  const id = await nextTextAssetId();
  const version = await nextVersion(input);
  const ext = input.extension || (input.targetType === "promptDiagnostic" ? "json" : "md");
  const targetId = sanitizeSegment(input.targetId ?? "project", "project");
  const scriptSegment = input.scriptId == null ? "common" : `script-${input.scriptId}`;
  const fileName = `${scriptSegment}-${targetId}-v${version}-${u.uuid()}.${ext}`;
  const relativePath =
    storageMode() === "workspace"
      ? ["projects", String(input.projectId), "text", sanitizeSegment(input.targetType, "text"), fileName].join("/")
      : [TEXT_ASSET_ROOT, String(input.projectId), sanitizeSegment(input.targetType, "text"), fileName].join("/");
  const absolutePath = resolveTextAssetPath(relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, absolutePath);
  const size = Buffer.byteLength(content, "utf8");
  const hash = sha256(content);
  const summary =
    input.summary === undefined ? content.replace(/\s+/g, " ").slice(0, 500).slice(0, 1000) : input.summary.slice(0, 1000);
  await u.db("o_textAsset").insert({
    id,
    projectId: input.projectId,
    scriptId: input.scriptId ?? null,
    targetType: input.targetType,
    targetId: input.targetId == null ? null : String(input.targetId),
    filePath: relativePath,
    summary,
    size,
    hash,
    version,
    state: input.state || "complete",
    createTime: now,
    updateTime: now,
  });
  return {
    id,
    projectId: input.projectId,
    scriptId: input.scriptId ?? null,
    targetType: input.targetType,
    targetId: input.targetId == null ? null : String(input.targetId),
    filePath: relativePath,
    summary,
    size,
    hash,
    version,
    state: input.state || "complete",
    createTime: now,
    updateTime: now,
  };
}

export async function getTextAssetContent(input: {
  id: number;
  projectId: number;
  offset?: number;
  limit?: number;
}): Promise<TextAssetContent> {
  const row = await u.db("o_textAsset").where({ id: input.id, projectId: input.projectId }).first();
  if (!row) throw new Error("Text asset not found");
  const absolutePath = resolveTextAssetPath(String(row.filePath || ""));
  const content = await fs.readFile(absolutePath, "utf8");
  const offset = Math.max(0, Number(input.offset || 0));
  const limit = Math.max(1, Math.min(Number(input.limit || DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT));
  const slice = content.slice(offset, offset + limit);
  return {
    content: slice,
    size: Buffer.byteLength(content, "utf8"),
    eof: offset + slice.length >= content.length,
  };
}

export function summarizeLongText(content: string, textAssetId: number) {
  const compact = content.replace(/\s+/g, " ").trim();
  const head = compact.slice(0, 1200);
  const tail = compact.length > 1800 ? compact.slice(-400) : "";
  return [
    head,
    tail ? `... ${tail}` : "",
    "",
    `[full text asset: ${textAssetId}]`,
  ]
    .filter(Boolean)
    .join("\n");
}
