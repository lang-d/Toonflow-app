import { jsonSchema, tool } from "ai";
import { z } from "zod";
import u from "@/utils";
import {
  buildUniqueBaseAssetIndex,
  listBaseVisualAssets,
  normalizeScriptAssetName,
  scriptAssetMatchKey,
  toVisualAssetType,
} from "@/services/scriptAssetBinding";
import { updateUnifiedTask } from "@/services/taskCoordinator";
import type { o_script } from "@/types/database";

const NewAssetSchema = z.object({
  name: z.string().describe("Asset name from the script."),
  desc: z.string().describe("Reusable visual description for downstream asset foundation work."),
  type: z.enum(["role", "tool", "scene"]).describe("Base visual asset type."),
  scriptIds: z.array(z.number()).describe("Script ids where this asset appears."),
});

const ExistingAssetRefSchema = z.object({
  type: z.enum(["role", "tool", "scene"]).describe("Existing base visual asset type."),
  name: z.string().describe("Existing asset name."),
  scriptIds: z.array(z.number()).describe("Script ids where this asset appears."),
});

type NewAsset = z.infer<typeof NewAssetSchema>;
type ExistingAssetRef = z.infer<typeof ExistingAssetRefSchema>;

export interface ScriptAssetExtractionPayload {
  projectId: number;
  scriptIds: number[];
  groupSize?: number;
}

export interface ScriptAssetExtractionResult extends Record<string, unknown> {
  scriptIds: number[];
  createdAssetIds: number[];
  reusedAssetIds: number[];
  assetCount: number;
}

function normalizeIds(ids: unknown[]) {
  return [...new Set(ids.map(Number).filter(Number.isFinite))];
}

export function chunkScriptAssetExtractionIds(scriptIds: number[], groupSize = 5) {
  const size = Math.max(1, Math.min(5, Math.floor(Number(groupSize) || 5)));
  const normalized = normalizeIds(scriptIds);
  const chunks: number[][] = [];
  for (let index = 0; index < normalized.length; index += size) {
    chunks.push(normalized.slice(index, index + size));
  }
  return chunks;
}

function formatScriptsForPrompt(scripts: o_script[]) {
  return scripts
    .map((script) => `===== Script ID: ${script.id} ${script.name || ""} =====\n${script.content || ""}`)
    .join("\n\n");
}

function buildAssetExtractionRules() {
  return [
    "Existing asset refs must include name, type and scriptIds. Do not return an existing ref without type.",
    "Only base visual assets in the provided existing asset list can be reused; derivative, audio, video or director assets must not be referenced.",
    "newAssets[].desc is not marketing copy. It is a reusable factual source for later character/scene/prop foundation work.",
    "Role desc should include identity/relationship/story function and stable appearance or temperament cues. If unknown, say it is unspecified instead of inventing.",
    "Scene desc should include spatial function, stable layout or key objects, default state, and relation to story/characters.",
    "Prop desc should include usage, physical form, real material or markings, and relation to story/characters.",
    "Do not put long original script passages, storyboard shots, camera instructions, composition, stylized lighting or render texture into desc.",
    "Each desc should be concise but specific, prioritizing reusable asset facts and continuity anchors.",
    "Information content is not a standalone base asset by default. Chat records, transfer records, recordings, call logs, notification text and screen contents must be attached to a carrier asset such as a phone, computer, recorder, paper file or printed voucher.",
    "Phones, computers, recorders, folders and paper vouchers may be extracted as tool assets when they carry story function, but their desc must describe stable appearance/ownership only, not specific screen text, amounts, chat partners, recording content or plot evidence.",
    "Only extract an information record as a standalone tool when the script clearly turns it into a physical or independent object, such as printed chat records, a paper transfer voucher, a labeled audio file stored as evidence, or a separate document.",
  ].join("\n");
}

async function loadPromptText() {
  const promptData = await u.db("o_prompt").where("type", "scriptAssetExtraction").first();
  return String(promptData?.useData || promptData?.data || "");
}

async function persistExtractionResult(input: {
  projectId: number;
  scriptIds: number[];
  newAssets: NewAsset[];
  existingRefs: ExistingAssetRef[];
}): Promise<ScriptAssetExtractionResult> {
  const scriptIds = normalizeIds(input.scriptIds);
  if (!input.newAssets.length && !input.existingRefs.length) {
    throw new Error("AI 未返回任何资产");
  }

  return u.db.transaction(async (trx: any) => {
    const existingAssets = await listBaseVisualAssets(trx, input.projectId);
    const existingIndex = buildUniqueBaseAssetIndex(existingAssets);

    const toInsertByKey = new Map<string, NewAsset>();
    for (const asset of input.newAssets) {
      const type = toVisualAssetType(asset.type);
      const name = normalizeScriptAssetName(asset.name);
      if (!type || !name) continue;
      const key = scriptAssetMatchKey({ name: asset.name, type });
      if (existingIndex.unique.has(key) || existingIndex.duplicates.has(key) || toInsertByKey.has(key)) continue;
      toInsertByKey.set(key, asset);
    }

    const insertedKeys = new Set<string>();
    const toInsert = [...toInsertByKey.values()];
    if (toInsert.length) {
      await trx("o_assets").insert(
        toInsert.map((asset) => ({
          name: asset.name,
          type: asset.type,
          describe: asset.desc,
          projectId: input.projectId,
          startTime: Date.now(),
        })),
      );
      for (const asset of toInsert) {
        insertedKeys.add(scriptAssetMatchKey(asset));
      }
    }

    const allAssets = await listBaseVisualAssets(trx, input.projectId);
    const assetIndex = buildUniqueBaseAssetIndex(allAssets);
    const validScriptIdSet = new Set(scriptIds);
    const scriptAssetRows: { scriptId: number; assetId: number }[] = [];
    const boundAssetIds = new Set<number>();
    const createdAssetIds = new Set<number>();

    const collectBinding = (asset: { name: unknown; type: unknown; scriptIds: number[] }) => {
      const key = scriptAssetMatchKey(asset);
      if (assetIndex.duplicates.has(key)) return;
      const assetId = Number(assetIndex.unique.get(key)?.id);
      if (!Number.isFinite(assetId)) return;
      boundAssetIds.add(assetId);
      if (insertedKeys.has(key)) createdAssetIds.add(assetId);
      for (const scriptId of asset.scriptIds) {
        const sid = Number(scriptId);
        if (!validScriptIdSet.has(sid)) continue;
        scriptAssetRows.push({ scriptId: sid, assetId });
      }
    };

    input.newAssets.forEach(collectBinding);
    input.existingRefs.forEach(collectBinding);

    const uniqueRows = [...new Map(scriptAssetRows.map((row) => [`${row.scriptId}_${row.assetId}`, row])).values()];
    await trx("o_scriptAssets").whereIn("scriptId", scriptIds).delete();
    if (uniqueRows.length) await trx("o_scriptAssets").insert(uniqueRows);
    await trx("o_script").whereIn("id", scriptIds).update({ extractState: 1, errorReason: null });

    const created = [...createdAssetIds];
    const reused = [...boundAssetIds].filter((assetId) => !createdAssetIds.has(assetId));
    return {
      scriptIds,
      createdAssetIds: created,
      reusedAssetIds: reused,
      assetCount: boundAssetIds.size,
    };
  });
}

export async function executeScriptAssetExtractionTask(payload: ScriptAssetExtractionPayload, task?: any) {
  const projectId = Number(payload.projectId);
  const scriptIds = normalizeIds(payload.scriptIds || []);
  if (!projectId || !scriptIds.length) throw new Error("缺少项目或剧本信息");

  try {
    if (task?.id) {
      await updateUnifiedTask(task.id, { status: "processing", phase: "extracting", progress: 10 });
    }
    const scripts = await u.db("o_script").where("projectId", projectId).whereIn("id", scriptIds).select("*");
    const foundIds = new Set(scripts.map((script: o_script) => Number(script.id)));
    const missingIds = scriptIds.filter((scriptId) => !foundIds.has(scriptId));
    if (missingIds.length) throw new Error(`未找到对应剧本: ${missingIds.join(",")}`);

    await u.db("o_script").where("projectId", projectId).whereIn("id", scriptIds).update({
      extractState: 0,
      errorReason: null,
    });

    const existingAssets = await listBaseVisualAssets(u.db, projectId);
    const existingAssetsList = existingAssets
      .map((asset: any) => `${asset.name}(${asset.type})${asset.describe ? `: ${String(asset.describe).slice(0, 120)}` : ""}`)
      .join("\n");
    const existingHint = existingAssetsList
      ? `\n\nExisting base visual assets:\n${existingAssetsList}\nReuse these via existingAssetRefs when they appear in the scripts. New assets must be returned in newAssets.`
      : "";

    let collectedNew: NewAsset[] = [];
    let collectedExisting: ExistingAssetRef[] = [];
    const resultTool = tool({
      description: "Submit the extracted script assets.",
      inputSchema: jsonSchema<{ newAssets: NewAsset[]; existingAssetRefs: ExistingAssetRef[] }>(
        z
          .object({
            newAssets: z.array(NewAssetSchema).describe("Newly discovered base visual assets."),
            existingAssetRefs: z.array(ExistingAssetRefSchema).describe("References to existing base visual assets."),
          })
          .toJSONSchema(),
      ),
      execute: async ({ newAssets, existingAssetRefs }) => {
        collectedNew = Array.isArray(newAssets) ? newAssets : [];
        collectedExisting = Array.isArray(existingAssetRefs) ? existingAssetRefs : [];
        return "ok";
      },
    });

    const promptText = await loadPromptText();
    const output = await u.Ai.Text("universalAi").invoke({
      messages: [
        {
          role: "system",
          content: [
            promptText,
            buildAssetExtractionRules(),
            "Extract role, scene and prop assets from the provided scripts. Return all results through resultTool.",
            "Multiple scripts are separated by ===== Script ID: xxx =====. Use scriptIds to mark where each asset appears.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
        {
          role: "user",
          content: `Existing asset context:${existingHint}\n\nExtract assets for these ${scripts.length} scripts:\n\n${formatScriptsForPrompt(scripts)}`,
        },
      ],
      tools: { resultTool },
    });

    void output;
    if (task?.id) await updateUnifiedTask(task.id, { phase: "saving", progress: 80 });
    return await persistExtractionResult({
      projectId,
      scriptIds,
      newAssets: collectedNew,
      existingRefs: collectedExisting,
    });
  } catch (error) {
    const reason = u.error(error).message;
    await u.db("o_script").where("projectId", projectId).whereIn("id", scriptIds).update({
      extractState: -1,
      errorReason: reason,
    });
    throw error;
  }
}

export async function listActiveScriptAssetExtractionScriptIds(projectId: number) {
  const rows = await u
    .db("o_tasks")
    .where({ projectId, handler: "script-asset-extract" })
    .whereIn("status", ["pending", "queued", "submitting", "processing"])
    .select("payloadJson");
  const active = new Set<number>();
  for (const row of rows) {
    try {
      const payload = JSON.parse(String(row.payloadJson || "{}"));
      for (const scriptId of normalizeIds(payload.scriptIds || [])) active.add(scriptId);
    } catch {
      // Ignore malformed legacy task payloads.
    }
  }
  return active;
}
