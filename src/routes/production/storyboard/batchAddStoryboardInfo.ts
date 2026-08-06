import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { resolveStoryboardReferences, serializeStoryboardReferences } from "@/services/storyboardEditor";
import { deriveStoryboardGroupMeta, syncVideoTracksForStoryboards } from "@/services/storyboardGroupPlanner";
import {
  assetIdsFromStoryboardRow,
  buildStoryboardDraftRow,
  sceneContinuityIdRequestSchema,
  storyboardRowToDbPatch,
  storyboardTableRowV2Schema,
} from "@/services/storyboardTableContract";
import { buildStoryboardVideoFact } from "@/services/storyboardFacts";
import { getProjectDefaultVideoPolicy } from "@/services/videoModelPolicy";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    data: z.array(
      z.object({
        prompt: z.string(),
        duration: z.number(),
        track: z.string().optional(),
        state: z.string(),
        src: z.string().nullable(),
        videoDesc: z.string().optional(),
        shouldGenerateImage: z.number(),
        associateAssetsIds: z.array(z.number()).default([]),
        referenceImages: z.array(z.any()).default([]),
        groupKey: z.string().optional(),
        groupName: z.string().optional(),
        groupIntent: z.string().optional(),
        beatId: z.string().optional(),
        scene: z.string().optional(),
        location: z.string().optional(),
        timeOfDay: z.string().optional(),
        sceneContinuityId: sceneContinuityIdRequestSchema,
        picture: z.string().optional(),
        action: z.string().optional(),
        shotSize: z.string().optional(),
        cameraMove: z.string().optional(),
        cameraAngle: z.string().optional(),
        transitionFromPrevious: z.string().optional(),
        dialogue: z.union([z.string(), z.array(z.any())]).optional(),
        sound: z.string().optional(),
        soundEffects: z.array(z.string()).optional(),
        visibleEmotion: z.string().optional(),
        characters: z.array(z.any()).optional(),
        requiredAssets: z.array(z.any()).optional(),
        tableRowJson: z.any().optional(),
      }),
    ),
    scriptId: z.number(),
    projectId: z.number(),
  }),
  async (req, res) => {
    const { data, scriptId, projectId } = req.body;
    if (!data.length) return res.status(400).send(error("Storyboard data cannot be empty"));
    const durationPolicy = await getProjectDefaultVideoPolicy(projectId);

    await u.db.transaction(async (trx: any) => {
      const countRow = await trx("o_storyboard")
        .where({ scriptId, projectId })
        .count({ count: "*" })
        .first();
      const startIndex = Number(countRow?.count || 0);
      for (const [offset, item] of data.entries()) {
        const index = startIndex + offset;
        const groupMeta = deriveStoryboardGroupMeta(item, index);
        const factObject = buildStoryboardDraftRow(
          {
            ...(item.tableRowJson && typeof item.tableRowJson === "object" ? item.tableRowJson : {}),
            ...item,
            index,
            durationSec: item.duration,
            groupKey: item.groupKey || groupMeta.groupKey,
            beatId: item.beatId || groupMeta.beatId,
            soundEffects: item.soundEffects ?? item.sound,
          },
          index,
        );
        const parsed = storyboardTableRowV2Schema.safeParse(factObject);
        const [id] = await trx("o_storyboard").insert({
          ...(parsed.success
            ? storyboardRowToDbPatch(parsed.data, 1, groupMeta)
            : {
                tableRowJson: JSON.stringify(factObject),
                factStatus: "draft",
                factVersion: 2,
                factRevision: 1,
                duration: String(item.duration),
                videoDesc: "",
                groupKey: groupMeta.groupKey,
                groupName: groupMeta.groupName,
                groupIntent: groupMeta.groupIntent,
                beatId: groupMeta.beatId || null,
              }),
          projectId,
          scriptId,
          index,
          prompt: item.prompt,
          state: item.state,
          filePath: item.src ? u.replaceUrl(item.src) : "",
          shouldGenerateImage: item.shouldGenerateImage,
          referenceImages: serializeStoryboardReferences(item.referenceImages),
          createTime: Date.now(),
        });
        const assetIds = [
          ...new Set([
            ...item.associateAssetsIds,
            ...(parsed.success ? assetIdsFromStoryboardRow(parsed.data) : []),
          ]),
        ];
        if (assetIds.length) {
          await trx("o_assets2Storyboard").insert(assetIds.map((assetId) => ({ assetId, storyboardId: id })));
        }
      }
      const storyboards = await trx("o_storyboard").where({ scriptId, projectId }).orderBy("index", "asc");
      await syncVideoTracksForStoryboards(trx, { projectId, scriptId, storyboards, durationPolicy });
    });

    const rows = await u.db("o_storyboard").where({ scriptId, projectId }).orderBy("index", "asc");
    const result = await Promise.all(
      rows.map(async (item: any) => {
        const assetIds = await u
          .db("o_assets2Storyboard")
          .where("storyboardId", item.id)
          .orderBy("rowid")
          .pluck("assetId");
        const normalizedAssetIds = assetIds.map(Number).filter(Number.isFinite);
        const fact = buildStoryboardVideoFact(item, normalizedAssetIds);
        return {
          id: item.id,
          index: item.index,
          trackId: item.trackId,
          prompt: item.prompt,
          duration: Number(fact.duration || 0),
          state: item.state,
          src: item.filePath ? await u.oss.getSmallImageUrl(item.filePath) : "",
          associateAssetsIds: normalizedAssetIds,
          tableRowJson: item.tableRowJson,
          factStatus: fact.factStatus,
          factSource: fact.factSource,
          scene: fact.scene,
          location: fact.location,
          timeOfDay: fact.timeOfDay,
          picture: fact.picture,
          action: fact.action,
          shotSize: fact.shotSize,
          cameraMove: fact.cameraMove,
          dialogue: fact.dialogue,
          sound: fact.sound,
          visibleEmotion: fact.visibleEmotion,
          groupKey: fact.groupKey,
          groupName: fact.groupName,
          groupIntent: fact.groupIntent,
          beatId: fact.beatId,
          referenceImages: await resolveStoryboardReferences(item.referenceImages),
        };
      }),
    );
    return res.status(200).send(success(result));
  },
);
