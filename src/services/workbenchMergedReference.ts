import sharp from "sharp";
import pLimit from "p-limit";
import u from "@/utils";
import {
  resolveWorkbenchReferences,
  ResolvedWorkbenchReference,
  StoredSourceReference,
  WorkbenchReferenceInput,
} from "@/services/workbenchReference";

export type MergeType = "storyboard" | "assets";

export interface CreateMergedReferenceInput {
  projectId: number;
  scriptId: number;
  trackId: number;
  mergeType: MergeType;
  refs: Array<
    WorkbenchReferenceInput & {
      order: number;
      label?: string;
      category?: string;
      parentName?: string;
      name?: string;
      index?: number;
    }
  >;
}

const mergeLimit = pLimit(2);
const maxSourceBytes = 25 * 1024 * 1024;
const maxSourcePixels = 40_000_000;
const maxOutputSide = 8192;
const cellWidth = 640;
const imageHeight = 520;
const labelHeight = 92;
const gap = 20;
const outerPadding = 24;
const categoryHeaderHeight = 56;

function escapeXml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeCategory(value: unknown): "role" | "scene" | "tool" | "clip" | "other" {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "role" || normalized.includes("角色")) return "role";
  if (normalized === "scene" || normalized.includes("场景")) return "scene";
  if (normalized === "tool" || normalized === "prop" || normalized.includes("道具")) return "tool";
  if (normalized === "clip" || normalized.includes("片段")) return "clip";
  return "other";
}

function getColumns(count: number, mergeType: MergeType) {
  if (mergeType === "storyboard") {
    if (count <= 3) return count;
    if (count === 4) return 2;
    if (count <= 6) return 3;
  }
  return count > 9 ? 4 : 3;
}

async function prepareImage(item: ResolvedWorkbenchReference) {
  const source = await u.oss.getFile(item.filePath);
  if (source.length > maxSourceBytes) throw new Error(`引用 ${item.id} 超过 25MB 限制`);
  const metadata = await sharp(source).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (!width || !height) throw new Error(`引用 ${item.id} 不是有效图片`);
  if (width * height > maxSourcePixels) throw new Error(`引用 ${item.id} 超过 4000 万像素限制`);
  return sharp(source)
    .rotate()
    .resize(cellWidth, imageHeight, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .jpeg({ quality: 90 })
    .toBuffer();
}

function textSvg(width: number, height: number, text: string, options: { fontSize?: number; dark?: boolean; bold?: boolean } = {}) {
  const fontSize = options.fontSize ?? 30;
  const fill = options.dark ? "#ffffff" : "#202124";
  const background = options.dark ? "#30343b" : "#f5f6f8";
  const weight = options.bold ? 700 : 500;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="${background}"/>
      <text x="${width / 2}" y="${height / 2}" dominant-baseline="middle" text-anchor="middle"
        font-family="Microsoft YaHei, SimHei, Noto Sans CJK SC, sans-serif" font-size="${fontSize}"
        font-weight="${weight}" fill="${fill}">${escapeXml(text)}</text>
    </svg>`,
  );
}

function assetLabel(item: ResolvedWorkbenchReference) {
  if (item.parentName && item.name && item.parentName !== item.name) return `${item.parentName}+${item.name}`;
  return item.name || `资产${item.id}`;
}

function truncateLabel(value: string, maxLength = 20) {
  const characters = Array.from(value);
  return characters.length > maxLength ? `${characters.slice(0, maxLength - 1).join("")}…` : value;
}

async function renderStoryboard(items: ResolvedWorkbenchReference[], labels: string[]) {
  const columns = getColumns(items.length, "storyboard");
  const rows = Math.ceil(items.length / columns);
  const cellHeight = imageHeight + labelHeight;
  const width = outerPadding * 2 + columns * cellWidth + Math.max(0, columns - 1) * gap;
  const height = outerPadding * 2 + rows * cellHeight + Math.max(0, rows - 1) * gap;
  const overlays: sharp.OverlayOptions[] = [];
  const images = await Promise.all(items.map(prepareImage));
  items.forEach((item, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const left = outerPadding + column * (cellWidth + gap);
    const top = outerPadding + row * (cellHeight + gap);
    overlays.push({ input: images[index], left, top });
    overlays.push({
      input: textSvg(cellWidth, labelHeight, labels[index] || item.name || `P${index + 1}`, { bold: true }),
      left,
      top: top + imageHeight,
    });
  });
  return sharp({
    create: { width, height, channels: 3, background: { r: 235, g: 237, b: 240 } },
  })
    .composite(overlays)
    .resize({ width: maxOutputSide, height: maxOutputSide, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function renderAssets(items: ResolvedWorkbenchReference[]) {
  const order = ["role", "scene", "tool", "clip", "other"] as const;
  const titles = { role: "角色", scene: "场景", tool: "道具", clip: "片段", other: "其他" };
  const grouped = order
    .map((category) => ({ category, items: items.filter((item) => normalizeCategory(item.category) === category) }))
    .filter((group) => group.items.length);
  const columns = getColumns(items.length, "assets");
  const cellHeight = imageHeight + labelHeight;
  const width = outerPadding * 2 + columns * cellWidth + Math.max(0, columns - 1) * gap;
  const groupHeights = grouped.map((group) => categoryHeaderHeight + gap + Math.ceil(group.items.length / columns) * cellHeight + gap);
  const height = outerPadding * 2 + groupHeights.reduce((sum, value) => sum + value, 0);
  const overlays: sharp.OverlayOptions[] = [];
  let top = outerPadding;
  for (const group of grouped) {
    overlays.push({
      input: textSvg(width - outerPadding * 2, categoryHeaderHeight, titles[group.category], { dark: true, bold: true }),
      left: outerPadding,
      top,
    });
    top += categoryHeaderHeight + gap;
    const images = await Promise.all(group.items.map(prepareImage));
    group.items.forEach((item, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const left = outerPadding + column * (cellWidth + gap);
      const itemTop = top + row * cellHeight;
      overlays.push({ input: images[index], left, top: itemTop });
      overlays.push({
        input: textSvg(cellWidth, labelHeight, truncateLabel(assetLabel(item)), { fontSize: 26, bold: true }),
        left,
        top: itemTop + imageHeight,
      });
    });
    top += Math.ceil(group.items.length / columns) * cellHeight + gap;
  }
  return sharp({
    create: { width, height, channels: 3, background: { r: 235, g: 237, b: 240 } },
  })
    .composite(overlays)
    .resize({ width: maxOutputSide, height: maxOutputSide, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
}

function sameSourceRefs(left: StoredSourceReference[], right: StoredSourceReference[]) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item.id === right[index]?.id && item.sources === right[index]?.sources);
}

export async function createMergedReference(input: CreateMergedReferenceInput) {
  return mergeLimit(async () => {
    const project = await u.db("o_project").where("id", input.projectId).first();
    if (!project) throw new Error("项目不存在");
    const script = await u.db("o_script").where({ id: input.scriptId, projectId: input.projectId }).first();
    if (!script) throw new Error("剧集不存在或不属于当前项目");
    const track = await u.db("o_videoTrack").where({ id: input.trackId, projectId: input.projectId, scriptId: input.scriptId }).first();
    if (!track) throw new Error("轨道不存在或归属关系错误");

    const unique = new Set(input.refs.map((item) => `${item.sources}:${item.id}`));
    if (unique.size !== input.refs.length) throw new Error("引用列表包含重复素材");
    if (input.refs.some((item) => item.sources !== input.mergeType)) throw new Error("引用来源与合图类型不一致");

    const orderedRefs = [...input.refs].sort((a, b) => a.order - b.order);
    const resolved = await resolveWorkbenchReferences(orderedRefs, {
      projectId: input.projectId,
      scriptId: input.scriptId,
      storyboardTrackId: input.mergeType === "storyboard" ? input.trackId : undefined,
    });
    if (resolved.some((item) => item.fileType !== "image")) throw new Error("合图只支持图片引用");

    const storedRefs: StoredSourceReference[] = resolved.map((item, index) => ({
      id: item.id,
      sources: item.sources as "storyboard" | "assets",
      order: orderedRefs[index].order,
      label: input.mergeType === "storyboard" ? orderedRefs[index].label || item.name : assetLabel(item),
      category: input.mergeType === "assets" ? normalizeCategory(item.category) : undefined,
      parentName: item.parentName,
      name: item.name,
      index: item.index,
    }));
    const labels = storedRefs.map((item, index) => item.label || `P${index + 1}`);
    const buffer = input.mergeType === "storyboard" ? await renderStoryboard(resolved, labels) : await renderAssets(resolved);
    const filePath = `/${input.projectId}/workbench/merged/${u.uuid()}.jpg`;
    await u.oss.writeFile(filePath, buffer);

    try {
      const id = await u.db.transaction(async (trx) => {
        const active = await trx("o_workbenchMergedReference")
          .where({ trackId: input.trackId, mergeType: input.mergeType, state: "active" })
          .select("id", "sourceRefs");
        const duplicateIds = active
          .filter((row: any) => sameSourceRefs(JSON.parse(row.sourceRefs || "[]"), storedRefs))
          .map((row: any) => row.id);
        if (duplicateIds.length) {
          await trx("o_workbenchMergedReference").whereIn("id", duplicateIds).update({ state: "archived", updateTime: Date.now() });
        }
        const now = Date.now();
        const [insertedId] = await trx("o_workbenchMergedReference").insert({
          projectId: input.projectId,
          scriptId: input.scriptId,
          trackId: input.trackId,
          mergeType: input.mergeType,
          name: input.mergeType === "storyboard" ? "合并分镜图" : "合并资产图",
          filePath,
          fileType: "image",
          prompt: "",
          sourceRefs: JSON.stringify(storedRefs),
          position: Math.min(...orderedRefs.map((item) => item.order)),
          state: "active",
          createTime: now,
          updateTime: now,
        });
        return Number(insertedId);
      });
      return {
        id,
        sources: "merged" as const,
        src: await u.oss.getFileUrl(filePath),
        fileType: "image" as const,
        name: input.mergeType === "storyboard" ? "合并分镜图" : "合并资产图",
        prompt: "",
      };
    } catch (error) {
      try {
        await u.oss.deleteFile(filePath);
      } catch {}
      throw error;
    }
  });
}
