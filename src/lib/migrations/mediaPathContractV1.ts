import fs from "node:fs/promises";
import path from "node:path";
import type { Knex } from "knex";

const MIGRATION_KEY = "migration:media-path-contract-v1";

function normalizePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  let pathname = value.trim().split("?")[0];
  try {
    pathname = new URL(pathname).pathname;
  } catch {}
  return pathname
    .replace(/^\/oss\//i, "")
    .replace(/^\/smallImage\//i, "")
    .replace(/^smallImage\//i, "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

function parseJson(value: unknown, fallback: any) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function cleanNode(node: any) {
  if (!node?.data) return node;
  if (node.data.image) node.data.image = normalizePath(node.data.image);
  if (node.data.previewImage) node.data.previewImage = normalizePath(node.data.previewImage);
  if (node.data.generatedImage) node.data.generatedImage = normalizePath(node.data.generatedImage);
  if (node.data.media?.path || node.data.media?.url) node.data.media.path = normalizePath(node.data.media.path || node.data.media.url);
  if (node.data.resultMedia?.path || node.data.resultMedia?.url) {
    node.data.resultMedia.path = normalizePath(node.data.resultMedia.path || node.data.resultMedia.url);
  }
  if (node.data.selectedResult?.url) node.data.selectedResult.url = normalizePath(node.data.selectedResult.url);
  if (node.data.selectedResult?.media?.path || node.data.selectedResult?.media?.url) {
    node.data.selectedResult.media.path = normalizePath(node.data.selectedResult.media.path || node.data.selectedResult.media.url);
  }
  if (Array.isArray(node.data.references)) {
    node.data.references = node.data.references.map((item: any) => ({
      ...item,
      image: normalizePath(item.image),
      previewImage: normalizePath(item.previewImage),
      media: item.media?.path || item.media?.url ? { ...item.media, path: normalizePath(item.media.path || item.media.url) } : item.media,
    }));
  }
  return node;
}

async function backup(knex: Knex) {
  const filename = (knex.client.config.connection as any)?.filename;
  if (!filename || filename === ":memory:") return "";
  const backupDir = path.join(path.dirname(filename), "backups");
  await fs.mkdir(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `db2-before-media-path-v1-${timestamp}.sqlite`);
  const connection: any = await knex.client.acquireConnection();
  try {
    await connection.backup(backupPath);
  } finally {
    await knex.client.releaseConnection(connection);
  }
  return backupPath;
}

async function cleanColumn(knex: Knex, table: string, column: string) {
  if (!(await knex.schema.hasTable(table)) || !(await knex.schema.hasColumn(table, column))) return 0;
  const rows = await knex(table).select("id", column).whereNotNull(column);
  let changed = 0;
  for (const row of rows) {
    const next = normalizePath(row[column]);
    if (next && next !== row[column]) {
      await knex(table).where("id", row.id).update({ [column]: next });
      changed += 1;
    }
  }
  return changed;
}

export async function migrateMediaPathContractV1(knex: Knex, options: { createBackup?: boolean } = {}) {
  const marker = await knex("o_setting").where("key", MIGRATION_KEY).first();
  if (marker) return { skipped: true, changed: 0, backupPath: "" };

  const backupPath = options.createBackup === false ? "" : await backup(knex);
  let changed = 0;
  changed += await cleanColumn(knex, "o_image", "filePath");
  changed += await cleanColumn(knex, "o_storyboard", "filePath");
  changed += await cleanColumn(knex, "o_video", "filePath");
  changed += await cleanColumn(knex, "o_workbenchMergedReference", "filePath");
  changed += await cleanColumn(knex, "o_editImageTask", "url");

  if (await knex.schema.hasTable("o_imageFlow")) {
    const flows = await knex("o_imageFlow").select("id", "flowData");
    for (const row of flows) {
      const flow = parseJson(row.flowData, null);
      if (!flow) continue;
      const before = JSON.stringify(flow);
      if (flow.selectedImageUrl) flow.selectedImageUrl = normalizePath(flow.selectedImageUrl);
      if (flow.selectedMediaPath) flow.selectedMediaPath = normalizePath(flow.selectedMediaPath);
      if (Array.isArray(flow.nodes)) flow.nodes = flow.nodes.map(cleanNode);
      const after = JSON.stringify(flow);
      if (after !== before) {
        await knex("o_imageFlow").where("id", row.id).update({ flowData: after });
        changed += 1;
      }
    }
  }

  await knex("o_setting").insert({ key: MIGRATION_KEY, value: JSON.stringify({ changed, backupPath, time: Date.now() }) });
  return { skipped: false, changed, backupPath };
}
