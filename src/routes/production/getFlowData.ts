import express from "express";
import { z } from "zod";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { resolveStoryboardReferences } from "@/services/storyboardEditor";
import { renderStoryboardTableFromRows } from "@/services/storyboardTableText";
import { buildStoryboardVideoFact } from "@/services/storyboardFacts";
import { getDeriveAssetPromptSnapshot } from "@/services/imageFlow";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    episodesId: z.number(),
  }),
  async (req, res) => {
    const { projectId, episodesId }: { projectId: number; episodesId: number } = req.body;
    try {
      const [storedWorkData, scriptData, scriptAssets] = await Promise.all([
        u
          .db("o_agentWorkData")
          .where("projectId", String(projectId))
          .andWhere("episodesId", String(episodesId))
          .select("data")
          .first(),
        u.db("o_script").where({ projectId, id: episodesId }).first(),
        u.db("o_scriptAssets").where("scriptId", episodesId),
      ]);
      const assetIds = scriptAssets.map((item) => Number(item.assetId)).filter(Number.isFinite);
      const boundAudioRows = assetIds.length
        ? await u.db("o_assetsRole2Audio").whereIn("assetsRoleId", assetIds).select("assetsAudioId")
        : [];
      const flowAssetIds = [
        ...new Set([...assetIds, ...boundAudioRows.map((item) => Number(item.assetsAudioId)).filter(Number.isFinite)]),
      ];
      const assetsData = flowAssetIds.length
        ? await u
            .db("o_assets")
            .leftJoin("o_image", "o_assets.imageId", "o_image.id")
            .select("o_assets.*", "o_image.filePath", "o_image.state", "o_image.errorReason")
            .whereIn("o_assets.id", flowAssetIds)
            .whereNull("o_assets.assetsId")
            .where("o_assets.projectId", projectId)
        : [];
      const childAssetsData = flowAssetIds.length
        ? await u
            .db("o_assets")
            .leftJoin("o_image", "o_assets.imageId", "o_image.id")
            .select("o_assets.*", "o_image.filePath", "o_image.state", "o_image.errorReason")
            .where("o_assets.projectId", projectId)
            .whereIn("o_assets.assetsId", flowAssetIds)
            .whereNotNull("o_assets.assetsId")
        : [];
      const directorAssetsRows = await u
        .db("o_directorAsset")
        .join("o_assets", "o_assets.id", "o_directorAsset.assetId")
        .join("o_image", "o_image.id", "o_directorAsset.imageId")
        .where("o_directorAsset.projectId", projectId)
        .andWhere((query: any) => {
          query.where("o_directorAsset.scriptId", episodesId).orWhereNull("o_directorAsset.scriptId");
        })
        .select(
          "o_directorAsset.id",
          "o_directorAsset.assetId",
          "o_directorAsset.imageId",
          "o_directorAsset.assetType",
          "o_directorAsset.name",
          "o_directorAsset.promptFragment",
          "o_image.filePath",
        );
      const directorAssets = directorAssetsRows.map((item: any) => ({
        id: item.id,
        assetId: item.assetId,
        imageId: item.imageId,
        name: item.name,
        type: "directorAsset",
        assetType: item.assetType,
        prompt: item.promptFragment || "",
        source: "directorAsset",
        sourceId: item.id,
        filePath: item.filePath || "",
      }));
      const assets = await Promise.all(
        assetsData.map(async (item) => ({
          id: item.id,
          name: item.name ?? "",
          type: item.type ?? "",
          prompt: item.prompt ?? "",
          desc: item.describe ?? "",
          src: item.filePath ? await u.oss.getSmallImageUrl(item.filePath) : "",
          flowId: item.flowId,
          derive: await Promise.all(
            childAssetsData
              .filter((child) => Number(child.assetsId) === Number(item.id))
              .map(async (child) => {
                const promptSnapshot = await getDeriveAssetPromptSnapshot(u.db, {
                  projectId,
                  targetId: child.id,
                  flowId: child.flowId,
                  fallbackPrompt: child.prompt,
                });
                return {
                  id: child.id,
                  assetsId: item.id,
                  name: child.name ?? "",
                  type: child.type,
                  prompt: promptSnapshot.prompt,
                  nodeId: promptSnapshot.nodeId,
                  desc: child.describe ?? "",
                  src: child.filePath ? await u.oss.getSmallImageUrl(child.filePath) : "",
                  state: child.state ?? "未生成",
                  errorReason: child.errorReason ?? "",
                  flowId: child.flowId,
                };
              }),
          ),
        })),
      );

      const storyboardRows = await u
        .db("o_storyboard")
        .where({ projectId, scriptId: episodesId })
        .orderBy("index", "asc")
        .orderBy("id", "asc");
      const storyboardIds = storyboardRows.map((item) => Number(item.id));
      const assetLinks = storyboardIds.length
        ? await u
            .db("o_assets2Storyboard")
            .whereIn("storyboardId", storyboardIds)
            .orderBy("rowid")
            .select("storyboardId", "assetId")
        : [];
      const assetMap = new Map<number, number[]>();
      for (const link of assetLinks) {
        const storyboardId = Number(link.storyboardId);
        if (!assetMap.has(storyboardId)) assetMap.set(storyboardId, []);
        assetMap.get(storyboardId)!.push(Number(link.assetId));
      }
      const storyboard = await Promise.all(
        storyboardRows.map(async (item) => {
          const associateAssetsIds = assetMap.get(Number(item.id)) || [];
          const fact = buildStoryboardVideoFact(item, associateAssetsIds);
          return {
            id: item.id,
            index: item.index,
            duration: Number(fact.duration || 0),
            prompt: item.prompt || "",
            associateAssetsIds,
            src: item.filePath ? await u.oss.getSmallImageUrl(item.filePath) : "",
            state: item.state,
            videoDesc: fact.rawVideoDesc,
            scene: fact.scene,
            picture: fact.picture,
            action: fact.action,
            shotSize: fact.shotSize,
            cameraMove: fact.cameraMove,
            dialogue: fact.dialogue,
            sound: fact.sound,
            visibleEmotion: fact.visibleEmotion,
            location: fact.location,
            timeOfDay: fact.timeOfDay,
            sceneContinuityId: fact.tableRow?.sceneContinuityId || null,
            tableRowJson: item.tableRowJson,
            factSource: fact.factSource,
            factStatus: fact.factStatus,
            factVersion: item.factVersion || 1,
            groupKey: fact.groupKey,
            groupName: fact.groupName,
            groupIntent: fact.groupIntent,
            beatId: fact.beatId,
            trackId: item.trackId,
            shouldGenerateImage: item.shouldGenerateImage,
            reason: item.reason ?? "",
            flowId: item.flowId,
            referenceImages: await resolveStoryboardReferences(item.referenceImages),
          };
        }),
      );
      const rendered = await renderStoryboardTableFromRows(projectId, episodesId);
      const latestGenerationFailure = await u
        .db("o_storyboardGeneration")
        .where({ projectId, scriptId: episodesId })
        .whereIn("state", ["invalid", "failed"])
        .orderBy("updatedAt", "desc")
        .first("generationId", "state", "expectedRowCount", "errorJson", "updatedAt");
      const stored = storedWorkData?.data ? JSON.parse(storedWorkData.data) : {};
      const flowData = {
        ...stored,
        script: scriptData?.content ?? "",
        scriptPlan: stored.scriptPlan || "",
        assets,
        storyboard,
        storyboardTable: rendered.content,
        storyboardTableMeta: rendered.meta,
        storyboardGenerationLastFailure: latestGenerationFailure
          ? {
              generationId: latestGenerationFailure.generationId,
              state: latestGenerationFailure.state,
              expectedRowCount: latestGenerationFailure.expectedRowCount,
              errorJson: latestGenerationFailure.errorJson,
              updatedAt: latestGenerationFailure.updatedAt,
            }
          : null,
        directorAssets,
        workbench: stored.workbench || { videoList: [] },
      };
      return res.status(200).send(success(flowData));
    } catch (cause) {
      return res.status(400).send(error(u.error(cause).message));
    }
  },
);
