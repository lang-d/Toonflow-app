import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import isPathInside from "is-path-inside";
import { v4 as uuid } from "uuid";
import u from "@/utils";
import { projectDirectory } from "@/services/storagePaths";
import { createTextAsset, getTextAssetContent, latestTextAsset } from "@/services/textAsset";
import { readBuiltinDataFile } from "@/services/builtinData";

export const PROJECT_MATERIAL_CATEGORIES = [
  "outline",
  "character",
  "world",
  "scene",
  "prop",
  "visual",
  "director",
  "music",
  "notes",
] as const;

export type ProjectMaterialCategory = (typeof PROJECT_MATERIAL_CATEGORIES)[number];
export type ProjectMaterialState = "ready" | "unsupported" | "failed" | "archived";

export interface ProjectMaterialRow {
  id: number;
  projectId: number;
  category: ProjectMaterialCategory;
  name: string;
  filePath: string;
  mime: string;
  ext: string;
  size: number;
  textPath?: string | null;
  textSize?: number | null;
  summary?: string | null;
  state: ProjectMaterialState;
  createTime: number;
  updateTime: number;
}

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "json", "csv"]);
const DEFAULT_PAGE_LIMIT = 64 * 1024;
const MAX_PAGE_LIMIT = 512 * 1024;
const CONTEXT_PACK_TAG = "projectContextPack";
const CONTEXT_PACK_TARGET_ID = "project";
const CONTEXT_PACK_REQUIRED_HEADINGS = [
  "项目硬事实",
  "连续性锚点",
  "资产复用参考",
  "视觉与导演参考",
  "配乐参考",
  "缺资料与不确定项",
];

const MIME_EXTENSIONS: Record<string, string> = {
  "application/json": "json",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/plain": "txt",
};

export function isProjectMaterialCategory(value: unknown): value is ProjectMaterialCategory {
  return PROJECT_MATERIAL_CATEGORIES.includes(value as ProjectMaterialCategory);
}

function sanitizeFileName(value: string, fallback = "material") {
  const parsed = path.parse(String(value || fallback).replace(/[\\/]+/g, "-"));
  const base = (parsed.name || fallback)
    .replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || fallback;
}

function normalizeExt(value: unknown, fallback = "txt") {
  const ext = String(value || "")
    .replace(/^\./, "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .toLowerCase()
    .slice(0, 16);
  return ext || fallback;
}

function extFromName(name: string) {
  return normalizeExt(path.extname(name), "");
}

function extFromMime(mime: string) {
  return MIME_EXTENSIONS[String(mime || "").toLowerCase()] || "";
}

function isTextMaterial(mime: string, ext: string) {
  return String(mime || "").toLowerCase().startsWith("text/") || TEXT_EXTENSIONS.has(ext);
}

function parseBase64Data(input: { base64Data?: string; mime?: string; name: string }) {
  if (!input.base64Data) return null;
  const dataUrl = input.base64Data.match(/^data:([^;]+);base64,([\s\S]+)$/i);
  const mime = (dataUrl?.[1] || input.mime || "application/octet-stream").toLowerCase();
  const raw = dataUrl?.[2] || input.base64Data;
  const buffer = Buffer.from(raw.replace(/\s/g, ""), "base64");
  const ext = normalizeExt(extFromName(input.name) || extFromMime(mime) || mime.split("/")[1], "bin");
  return { buffer, mime, ext };
}

function summarizeText(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function materialRelativePath(projectId: number, category: ProjectMaterialCategory, fileName: string) {
  return ["projects", String(projectId), "materials", category, fileName].join("/");
}

export function resolveProjectMaterialPath(filePath: string) {
  const normalized = String(filePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized.startsWith("projects/") || normalized.includes("..")) throw new Error("Invalid project material path");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 5 || parts[2] !== "materials") throw new Error("Invalid project material path");
  const projectId = parts[1];
  const root = path.resolve(projectDirectory(projectId), "materials");
  const target = path.resolve(projectDirectory(projectId), ...parts.slice(2));
  if (target !== root && !isPathInside(target, root)) throw new Error("Invalid project material path");
  return target;
}

async function nextProjectMaterialId() {
  const row: any = await u.db("o_projectMaterial").max("id as id").first();
  return Number(row?.id || 0) + 1;
}

async function writeMaterialFile(relativePath: string, content: Buffer | string) {
  const absolutePath = resolveProjectMaterialPath(relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, content);
  await fs.rename(tempPath, absolutePath);
  return absolutePath;
}

function publicMaterialRow(row: any): ProjectMaterialRow {
  return {
    id: Number(row.id),
    projectId: Number(row.projectId),
    category: row.category,
    name: row.name || "",
    filePath: row.filePath || "",
    mime: row.mime || "",
    ext: row.ext || "",
    size: Number(row.size || 0),
    textPath: row.textPath || null,
    textSize: row.textSize == null ? null : Number(row.textSize || 0),
    summary: row.summary || "",
    state: row.state || "ready",
    createTime: Number(row.createTime || 0),
    updateTime: Number(row.updateTime || 0),
  };
}

export async function saveProjectMaterial(input: {
  projectId: number;
  category: ProjectMaterialCategory;
  name: string;
  base64Data?: string;
  textContent?: string;
  mime?: string;
}) {
  if (!isProjectMaterialCategory(input.category)) throw new Error("Invalid project material category");
  const project = await u.db("o_project").where("id", input.projectId).first("id");
  if (!project) throw new Error("Project does not exist");
  if (!input.base64Data && input.textContent == null) throw new Error("base64Data or textContent is required");

  const now = Date.now();
  const id = await nextProjectMaterialId();
  const parsed = parseBase64Data(input);
  const textContent = input.textContent == null ? null : String(input.textContent);
  const displayName = String(input.name || "material").trim() || "material";
  const safeName = sanitizeFileName(displayName);
  const ext = normalizeExt(parsed?.ext || extFromName(displayName) || extFromMime(input.mime || "") || "txt");
  const mime = parsed?.mime || input.mime || (TEXT_EXTENSIONS.has(ext) ? "text/plain" : "application/octet-stream");
  const fileName = `${uuid()}-${safeName}.${ext}`;
  const filePath = materialRelativePath(input.projectId, input.category, fileName);
  const fileBuffer = parsed?.buffer || Buffer.from(textContent || "", "utf8");
  await writeMaterialFile(filePath, fileBuffer);

  let textPath: string | null = null;
  let textSize: number | null = null;
  let summary = "";
  let state: ProjectMaterialState = "unsupported";
  if (textContent != null) {
    const textFilePath = materialRelativePath(input.projectId, input.category, `${uuid()}-${safeName}.txt`);
    await writeMaterialFile(textFilePath, textContent);
    textPath = textFilePath;
    textSize = Buffer.byteLength(textContent, "utf8");
    summary = summarizeText(textContent);
    state = "ready";
  } else if (isTextMaterial(mime, ext)) {
    const text = fileBuffer.toString("utf8");
    textSize = Buffer.byteLength(text, "utf8");
    summary = summarizeText(text);
    state = "ready";
  }

  const row = {
    id,
    projectId: input.projectId,
    category: input.category,
    name: displayName,
    filePath,
    mime,
    ext,
    size: fileBuffer.length,
    textPath,
    textSize,
    summary,
    state,
    createTime: now,
    updateTime: now,
  };
  await u.db("o_projectMaterial").insert(row);
  return publicMaterialRow(row);
}

export async function listProjectMaterials(input: {
  projectId: number;
  category?: ProjectMaterialCategory;
  includeArchived?: boolean;
}) {
  const query = u.db("o_projectMaterial").where({ projectId: input.projectId }).orderBy("createTime", "desc").orderBy("id", "desc");
  if (input.category) query.andWhere("category", input.category);
  if (!input.includeArchived) query.whereNot("state", "archived");
  const rows = await query;
  return rows.map(publicMaterialRow);
}

export async function readProjectMaterial(input: {
  id: number;
  projectId?: number;
  offset?: number;
  limit?: number;
}) {
  const query = u.db("o_projectMaterial").where({ id: input.id });
  if (input.projectId != null) query.andWhere("projectId", input.projectId);
  const row = await query.first();
  if (!row || row.state === "archived") throw new Error("Project material not found");
  const readablePath = row.textPath || (isTextMaterial(row.mime || "", row.ext || "") ? row.filePath : "");
  if (!readablePath) throw new Error("Project material has no readable text");
  const absolutePath = resolveProjectMaterialPath(readablePath);
  const content = await fs.readFile(absolutePath, "utf8");
  const offset = Math.max(0, Number(input.offset || 0));
  const limit = Math.max(1, Math.min(Number(input.limit || DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT));
  const slice = content.slice(offset, offset + limit);
  return {
    id: Number(row.id),
    projectId: Number(row.projectId),
    category: row.category,
    name: row.name || "",
    content: slice,
    size: Buffer.byteLength(content, "utf8"),
    offset,
    limit,
    eof: offset + slice.length >= content.length,
  };
}

export async function archiveProjectMaterial(input: { projectId: number; id: number }) {
  const existing = await u.db("o_projectMaterial").where({ projectId: input.projectId, id: input.id }).first();
  if (!existing || existing.state === "archived") throw new Error("Project material not found");
  await u.db("o_projectMaterial").where({ projectId: input.projectId, id: input.id }).update({
    state: "archived",
    updateTime: Date.now(),
  });
  return { id: input.id, archived: true };
}

async function readMaterialSnippet(id: number, projectId: number) {
  try {
    const data = await readProjectMaterial({ id, projectId, limit: 24 * 1024 });
    return data.content;
  } catch {
    return "";
  }
}

async function readContextPackSkill(fileName: string, fallback: string) {
  const skill = await readBuiltinDataFile("skills", fileName);
  return skill?.content || fallback;
}

function extractXmlContent(text: string, tag: string) {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const content = String(text || "").match(pattern)?.[1]?.trim() || "";
  return content;
}

export function extractProjectContextPackXml(text: string) {
  return extractXmlContent(text, CONTEXT_PACK_TAG);
}

function parseReviewJson(value: string) {
  const raw = String(value || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  return JSON.parse(fenced || raw);
}

function normalizeReviewIssue(item: any) {
  const severity = ["info", "warning", "blocking"].includes(item?.severity) ? item.severity : "warning";
  return {
    severity,
    message: String(item?.message || item?.reason || "参考包审核提示").slice(0, 500),
    reason: String(item?.reason || "").slice(0, 1000),
  };
}

function localReviewProjectContextPack(content: string) {
  const issues: Array<{ severity: "info" | "warning" | "blocking"; message: string; reason?: string }> = [];
  const text = String(content || "").trim();
  if (text.length < 80) {
    issues.push({ severity: "blocking", message: "参考包内容过短", reason: "模型输出没有形成可用的项目级制作参考。" });
  }
  for (const heading of CONTEXT_PACK_REQUIRED_HEADINGS) {
    if (!new RegExp(`(^|\\n)#{1,3}\\s*${heading}(\\s|$)`).test(text)) {
      issues.push({ severity: "blocking", message: `缺少章节：${heading}` });
    }
  }
  if (!/(暂无明确资料|不确定|缺资料|待补充)/.test(text)) {
    issues.push({
      severity: "warning",
      message: "未显式标出缺资料或不确定项",
      reason: "参考包应避免把推断写成确定事实。",
    });
  }
  return issues;
}

async function reviewProjectContextPack(content: string) {
  const localIssues = localReviewProjectContextPack(content);
  const reviewSkill = await readContextPackSkill(
    "project_context_pack_review.md",
    "你是项目制作参考包审核器。输出 JSON：{\"status\":\"passed|blocked\",\"issues\":[{\"severity\":\"info|warning|blocking\",\"message\":\"...\",\"reason\":\"...\"}]}。",
  );
  let aiIssues: ReturnType<typeof localReviewProjectContextPack> = [];
  try {
    const result = await u.Ai.Text("universalAi").invoke({
      system: reviewSkill,
      messages: [{ role: "user", content }],
    });
    const parsed = parseReviewJson(String((result as any).text || ""));
    const issues = Array.isArray(parsed?.issues) ? parsed.issues : [];
    aiIssues = issues.map(normalizeReviewIssue);
    if (parsed?.status === "blocked" && !aiIssues.some((item) => item.severity === "blocking")) {
      aiIssues.push({ severity: "blocking", message: "参考包审核未通过" });
    }
  } catch (error) {
    aiIssues = [
      {
        severity: "warning",
        message: "AI 审核结果不可解析，已仅使用本地基础审核",
        reason: u.error(error).message,
      },
    ];
  }
  const issues = [...localIssues, ...aiIssues];
  return {
    status: issues.some((item) => item.severity === "blocking") ? "blocked" : "passed",
    issues,
  };
}

function buildProjectContextPackSystemPrompt(flowSkill: string, techniqueSkill: string) {
  return [
    flowSkill,
    "",
    techniqueSkill,
    "",
    `你必须一次性输出完整 XML：<${CONTEXT_PACK_TAG}>Markdown 正文</${CONTEXT_PACK_TAG}>。`,
    "禁止输出多个 projectContextPack 标签，禁止把正文放在 XML 外要求前端解析。",
  ].join("\n");
}

export async function saveProjectContextPack(input: { projectId: number; content: string }) {
  const content = String(input.content || "").trim();
  if (!content) throw new Error("Project context pack content is required");
  const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 12);
  return createTextAsset({
    projectId: input.projectId,
    scriptId: null,
    targetType: "projectContextPack",
    targetId: CONTEXT_PACK_TARGET_ID,
    content,
    summary: `projectContextPack ${hash}`,
    extension: "md",
    state: "complete",
  });
}

export async function generateProjectContextPack(input: number | {
  projectId: number;
  instruction?: string;
  previousContent?: string;
}) {
  const projectId = typeof input === "number" ? input : Number(input.projectId);
  const instruction = typeof input === "number" ? "" : String(input.instruction || "").trim();
  const previousContent = typeof input === "number" ? "" : String(input.previousContent || "").trim();
  const materials = await listProjectMaterials({ projectId });
  const readable = materials.filter((item) => item.state === "ready");
  const grouped = new Map<ProjectMaterialCategory, ProjectMaterialRow[]>();
  for (const material of readable) {
    const list = grouped.get(material.category) || [];
    list.push(material);
    grouped.set(material.category, list);
  }
  const materialSections: string[] = [];
  for (const category of PROJECT_MATERIAL_CATEGORIES) {
    const list = grouped.get(category) || [];
    if (!list.length) continue;
    const snippets = await Promise.all(
      list.slice(0, 5).map(async (item) => {
        const snippet = await readMaterialSnippet(item.id, projectId);
        return `### ${item.name}\n${snippet.slice(0, 6000)}`;
      }),
    );
    materialSections.push(`## ${category}\n${snippets.join("\n\n")}`);
  }
  if (!materialSections.length && !previousContent) throw new Error("No readable project materials");
  const project = await u.db("o_project").where("id", projectId).first();
  const [flowSkill, techniqueSkill] = await Promise.all([
    readContextPackSkill("project_context_pack_flow.md", "你是项目制作参考包 Agent，只根据项目资料生成项目级制作参考包。"),
    readContextPackSkill("project_context_pack_technique.md", "输出制作约束，不输出资料摘要文章。"),
  ]);
  const system = buildProjectContextPackSystemPrompt(flowSkill, techniqueSkill);
  const prompt = [
    previousContent ? "请根据用户本轮指令调整上一版项目制作参考包。" : "请根据项目资料生成项目制作参考包。",
    instruction ? `用户本轮指令：${instruction}` : "用户本轮指令：无",
    "",
    `项目名称：${project?.name || ""}`,
    `项目简介：${project?.intro || ""}`,
    `项目类型：${project?.type || ""}`,
    `画风：${project?.artStyle || ""}`,
    "",
    previousContent ? `【上一版项目制作参考包】\n${previousContent.slice(0, 12000)}\n` : "",
    materialSections.length ? "【项目资料】" : "【项目资料】\n本次未提供新的可读项目资料，请基于上一版和用户指令调整。",
    materialSections.join("\n\n"),
  ].join("\n");
  const result = await u.Ai.Text("universalAi").invoke({
    system,
    messages: [{ role: "user", content: prompt }],
  });
  const content = extractProjectContextPackXml(String((result as any).text || ""));
  if (!content) throw new Error("Project context pack generation did not return complete XML");
  const review = await reviewProjectContextPack(content);
  if (review.status === "blocked") {
    throw new Error(`Project context pack review failed: ${review.issues.map((item) => item.message).join("; ")}`);
  }
  const asset = await saveProjectContextPack({ projectId, content });
  return { contextPack: asset, content, review };
}

export async function getProjectContextPack(projectId: number) {
  const row = await latestTextAsset({
    projectId,
    scriptId: null,
    targetType: "projectContextPack",
    targetId: CONTEXT_PACK_TARGET_ID,
    state: "complete",
  });
  if (!row) return null;
  const content = await getTextAssetContent({ id: Number(row.id), projectId, limit: MAX_PAGE_LIMIT });
  return { ...row, content: content.content, eof: content.eof, size: content.size };
}
