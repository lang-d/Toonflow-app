import fs from "node:fs/promises";
import path from "node:path";
import type { Knex } from "knex";

const MIGRATION_KEY = "migration:storyboard-editor-contract-v1";

interface MigrationOptions {
  createBackup?: boolean;
}

function parseJson(value: unknown, fallback: any) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function normalizePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  let pathname = value;
  try {
    pathname = new URL(value).pathname;
  } catch {
    // Stored values are normally OSS-relative paths.
  }
  return pathname
    .replace(/^\/oss\//, "")
    .replace(/^\/smallImage\//, "")
    .replace(/^\/+/, "")
    .replace(/\?.*$/, "");
}

function assetGroup(type: string) {
  return type === "role" ? "角色" : type === "scene" ? "场景" : type === "tool" ? "道具" : "资产";
}

function imageCandidates(node: any): string[] {
  return [node?.data?.generatedImage, node?.data?.selectedResult?.url]
    .map(normalizePath)
    .filter(Boolean);
}

async function createBackup(knex: Knex): Promise<string> {
  const filename = (knex.client.config.connection as any)?.filename;
  if (!filename || filename === ":memory:") return "";
  const backupDir = path.join(path.dirname(filename), "backups");
  await fs.mkdir(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `db2-before-storyboard-editor-v1-${timestamp}.sqlite`);
  const connection: any = await knex.client.acquireConnection();
  try {
    await connection.backup(backupPath);
  } finally {
    await knex.client.releaseConnection(connection);
  }
  return backupPath;
}

export async function migrateStoryboardEditorContractV1(knex: Knex, options: MigrationOptions = {}) {
  const marker = await knex("o_setting").where("key", MIGRATION_KEY).first();
  if (marker) return { skipped: true, changedFlows: 0, changedStoryboards: 0, backupPath: "" };

  const [flows, storyboards, mappings, assets] = await Promise.all([
    knex("o_imageFlow").select("id", "flowData"),
    knex("o_storyboard").select(
      "id",
      "projectId",
      "scriptId",
      "flowId",
      "filePath",
      "referenceImages",
    ),
    knex("o_assets2Storyboard").orderBy("rowid").select("storyboardId", "assetId"),
    knex("o_assets")
      .leftJoin("o_image", "o_image.id", "o_assets.imageId")
      .select(
        "o_assets.id",
        "o_assets.projectId",
        "o_assets.name",
        "o_assets.type",
        "o_image.filePath",
      ),
  ]);

  const flowsById = new Map(flows.map((row: any) => [Number(row.id), row]));
  const storyboardByFlow = new Map(
    storyboards.filter((row: any) => row.flowId != null).map((row: any) => [Number(row.flowId), row]),
  );
  const associatedIds = new Map<number, number[]>();
  for (const mapping of mappings) {
    const id = Number(mapping.storyboardId);
    const list = associatedIds.get(id) || [];
    list.push(Number(mapping.assetId));
    associatedIds.set(id, list);
  }
  const assetsById = new Map(assets.map((asset: any) => [Number(asset.id), asset]));
  const projectAssets = new Map<number, any[]>();
  for (const asset of assets) {
    const list = projectAssets.get(Number(asset.projectId)) || [];
    list.push(asset);
    projectAssets.set(Number(asset.projectId), list);
  }
  const storyboardImageMap = new Map<string, any[]>();
  for (const storyboard of storyboards) {
    const filePath = normalizePath(storyboard.filePath);
    if (!filePath) continue;
    const key = `${storyboard.projectId}:${storyboard.scriptId}:${filePath}`;
    const list = storyboardImageMap.get(key) || [];
    list.push(storyboard);
    storyboardImageMap.set(key, list);
  }

  const changedFlows = new Map<number, string>();
  const changedReferences = new Map<number, string>();

  for (const [flowId, storyboard] of storyboardByFlow) {
    const row = flowsById.get(flowId);
    if (!row?.flowData) continue;
    const flow = parseJson(row.flowData, { nodes: [], edges: [] });
    flow.nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
    flow.edges = Array.isArray(flow.edges) ? flow.edges : [];
    const before = JSON.stringify(flow);
    const selectedImageUrl = normalizePath(storyboard.filePath);
    flow.projectId = Number(storyboard.projectId);
    flow.scriptId = Number(storyboard.scriptId);
    flow.targetType = "storyboard";
    flow.targetId = Number(storyboard.id);
    flow.selectedImageUrl = selectedImageUrl;

    const generatedNodes = flow.nodes.filter((node: any) => node.type === "generated");
    const selectedMatches = selectedImageUrl
      ? generatedNodes.filter((node: any) => imageCandidates(node).includes(selectedImageUrl))
      : [];
    const marked = generatedNodes.filter((node: any) => node.data?.isPrimary === true);
    let primary: any = null;
    if (selectedMatches.length === 1) primary = selectedMatches[0];
    else if (marked.length === 1) primary = marked[0];
    else if (generatedNodes.length === 1) primary = generatedNodes[0];

    if (marked.length > 1 && !primary) {
      for (const node of generatedNodes) {
        node.data ||= {};
        delete node.data.isPrimary;
      }
    } else if (primary) {
      for (const node of generatedNodes) {
        node.data ||= {};
        node.data.isPrimary = node.id === primary.id;
      }
    }

    const preferredAssets = (associatedIds.get(Number(storyboard.id)) || [])
      .map((id) => assetsById.get(id))
      .filter(Boolean);
    const candidateAssets = preferredAssets.length
      ? preferredAssets
      : projectAssets.get(Number(storyboard.projectId)) || [];

    const enrichReference = (data: any, nodeId: string, index: number) => {
      const filePath = normalizePath(data?.image || data?.previewImage);
      if (!filePath) return;
      const assetMatches = candidateAssets.filter((asset: any) => normalizePath(asset.filePath) === filePath);
      if (assetMatches.length === 1) {
        const asset = assetMatches[0];
        data.source = "asset";
        data.sourceId = Number(asset.id);
        data.label ||= asset.name || `资产 ${asset.id}`;
        data.group ||= assetGroup(asset.type);
        data.type ||= "image";
        return;
      }
      const storyboardKey = `${storyboard.projectId}:${storyboard.scriptId}:${filePath}`;
      const storyboardMatches = (storyboardImageMap.get(storyboardKey) || []).filter(
        (item: any) => Number(item.id) !== Number(storyboard.id),
      );
      if (storyboardMatches.length === 1) {
        data.source = "storyboard";
        data.sourceId = Number(storyboardMatches[0].id);
        data.label ||= `分镜 ${storyboardMatches[0].id}`;
        data.group ||= "分镜引用";
        data.type ||= "image";
        return;
      }
      if (!data.source) {
        data.source = "local";
        data.sourceId = `migration:${flowId}:${nodeId}:${index}`;
        data.label ||= path.posix.basename(filePath);
        data.group ||= "本地上传";
        data.type ||= "image";
      }
    };

    const migratedReferences: any[] = [];
    flow.nodes.forEach((node: any, nodeIndex: number) => {
      node.data ||= {};
      if (node.type === "upload") {
        enrichReference(node.data, String(node.id), nodeIndex);
        if (node.data.source === "local" || node.data.source === "storyboard") {
          migratedReferences.push({
            id: node.data.sourceId,
            source: node.data.source,
            sourceId: node.data.sourceId,
            url: normalizePath(node.data.image || node.data.previewImage),
            previewUrl: normalizePath(node.data.previewImage || node.data.image),
            label: node.data.label || "",
            group: node.data.group || "",
            type: node.data.type || "image",
          });
        }
      } else if (node.type === "generated") {
        (node.data.references || []).forEach((reference: any, index: number) =>
          enrichReference(reference, String(node.id), index),
        );
      }
    });

    if (JSON.stringify(flow) !== before) changedFlows.set(flowId, JSON.stringify(flow));
    const currentReferences = parseJson(storyboard.referenceImages, []);
    if ((!Array.isArray(currentReferences) || currentReferences.length === 0) && migratedReferences.length) {
      changedReferences.set(Number(storyboard.id), JSON.stringify(migratedReferences));
    }
  }

  const hasChanges = changedFlows.size > 0 || changedReferences.size > 0;
  const backupPath = hasChanges && options.createBackup !== false ? await createBackup(knex) : "";
  await knex.transaction(async (trx) => {
    for (const [flowId, flowData] of changedFlows) {
      await trx("o_imageFlow").where("id", flowId).update({ flowData });
    }
    for (const [storyboardId, referenceImages] of changedReferences) {
      await trx("o_storyboard").where("id", storyboardId).update({ referenceImages });
    }
    await trx("o_setting").insert({
      key: MIGRATION_KEY,
      value: JSON.stringify({
        completedAt: Date.now(),
        changedFlows: changedFlows.size,
        changedStoryboards: changedReferences.size,
        backupPath,
      }),
    });
  });

  return {
    skipped: false,
    changedFlows: changedFlows.size,
    changedStoryboards: changedReferences.size,
    backupPath,
  };
}
