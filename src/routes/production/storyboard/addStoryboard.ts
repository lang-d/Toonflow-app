import express from "express";
import { z } from "zod";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  serializeStoryboardReferences,
  StoryboardContractError,
  updateTrackDuration,
  validateNewStoryboardRelations,
} from "@/services/storyboardEditor";
import { bindImageFlowToStoryboard } from "@/services/imageFlow";
import { deriveStoryboardGroupMeta } from "@/services/storyboardGroupPlanner";
import { buildTrackBgmSuggestion } from "@/services/musicSuggestion";
import {
  assetIdsFromStoryboardRow,
  buildStoryboardDraftRow,
  sceneContinuityIdRequestSchema,
  storyboardRowToDbPatch,
  storyboardTableRowV2Schema,
} from "@/services/storyboardTableContract";

const router = express.Router();
const referenceSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    source: z.enum(["local", "storyboard"]),
    sourceId: z.union([z.string(), z.number()]).nullable().optional(),
    url: z.string(),
    previewUrl: z.string().optional(),
    label: z.string().optional(),
    group: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

export default router.post(
  "/",
  validateFields({
    prompt: z.string(),
    duration: z.number().nonnegative(),
    state: z.string(),
    videoDesc: z.string(),
    shouldGenerateImage: z.number(),
    src: z.string().nullable(),
    scriptId: z.number(),
    projectId: z.number(),
    flowId: z.number().nullable().optional(),
    associateAssetsIds: z.array(z.number()).default([]),
    referenceImages: z.array(referenceSchema).default([]),
    groupKey: z.string().optional(),
    groupName: z.string().optional(),
    groupIntent: z.string().optional(),
    beatId: z.string().optional(),
    scene: z.string().optional(),
    picture: z.string().optional(),
    action: z.string().optional(),
    shotSize: z.string().optional(),
    cameraMove: z.string().optional(),
    dialogue: z.string().optional(),
    sound: z.string().optional(),
    visibleEmotion: z.string().optional(),
    location: z.string().optional(),
    timeOfDay: z.string().optional(),
    sceneContinuityId: sceneContinuityIdRequestSchema,
    characters: z.array(z.any()).optional(),
    dialogueItems: z.array(z.any()).optional(),
    soundEffects: z.array(z.string()).optional(),
    requiredAssets: z.array(z.any()).optional(),
    tableRowJson: z.any().optional(),
  }),
  async (req, res) => {
    try {
      const result = await u.db.transaction(async (trx: any) => {
        const currentCountRow = await trx("o_storyboard")
          .where({ projectId: req.body.projectId, scriptId: req.body.scriptId })
          .count({ count: "*" })
          .first();
        const index = Number(currentCountRow?.count || 0);
        const factObject = buildStoryboardDraftRow(
          {
            ...(req.body.tableRowJson && typeof req.body.tableRowJson === "object" ? req.body.tableRowJson : {}),
            index,
            duration: req.body.duration,
            scene: req.body.scene,
            location: req.body.location,
            timeOfDay: req.body.timeOfDay,
            sceneContinuityId: req.body.sceneContinuityId,
            picture: req.body.picture,
            action: req.body.action,
            shotSize: req.body.shotSize,
            cameraMove: req.body.cameraMove,
            visibleEmotion: req.body.visibleEmotion,
            groupKey: req.body.groupKey,
            groupName: req.body.groupName,
            groupIntent: req.body.groupIntent,
            beatId: req.body.beatId,
            characters: req.body.characters,
            dialogue: req.body.dialogueItems ?? req.body.dialogue,
            soundEffects: req.body.soundEffects ?? req.body.sound,
            requiredAssets: req.body.requiredAssets,
          },
          index,
        );
        const parsedFact = storyboardTableRowV2Schema.safeParse(factObject);
        const groupMeta = deriveStoryboardGroupMeta(
          parsedFact.success ? { tableRowJson: JSON.stringify(parsedFact.data) } : req.body,
          index,
        );
        const musicPlan = buildTrackBgmSuggestion({
          groupKey: groupMeta.groupKey,
          scene: req.body.location || req.body.scene || "",
          event: groupMeta.groupIntent,
          groupIntent: groupMeta.groupIntent,
          totalDuration: req.body.duration,
        });
        const trackId = Date.now();
        await trx("o_videoTrack").insert({
          id: trackId,
          scriptId: req.body.scriptId,
          projectId: req.body.projectId,
          duration: req.body.duration,
          groupKey: groupMeta.groupKey,
          groupName: groupMeta.groupName,
          groupIntent: groupMeta.groupIntent,
          musicPlanJson: JSON.stringify(musicPlan),
          reviewState: "pending",
          reviewIssuesJson: "[]",
        });
        const [id] = await trx("o_storyboard").insert({
          ...(parsedFact.success
            ? storyboardRowToDbPatch(parsedFact.data, 1)
            : {
                tableRowJson: JSON.stringify(factObject),
                factStatus: "draft",
                factVersion: 1,
                factRevision: 1,
                duration: String(req.body.duration),
                videoDesc: "",
              }),
          prompt: req.body.prompt,
          state: req.body.state,
          filePath: req.body.src ? u.replaceUrl(req.body.src) : "",
          trackId,
          shouldGenerateImage: req.body.src ? 1 : req.body.shouldGenerateImage,
          scriptId: req.body.scriptId,
          projectId: req.body.projectId,
          flowId: req.body.flowId ?? null,
          referenceImages: serializeStoryboardReferences(req.body.referenceImages),
          groupKey: groupMeta.groupKey,
          groupName: groupMeta.groupName,
          groupIntent: groupMeta.groupIntent,
          beatId: groupMeta.beatId || null,
          index,
          createTime: Date.now(),
        });
        const assetIds = await validateNewStoryboardRelations(
          trx,
          { id: Number(id), projectId: req.body.projectId, scriptId: req.body.scriptId },
          [
            ...new Set([
              ...req.body.associateAssetsIds,
              ...(parsedFact.success ? assetIdsFromStoryboardRow(parsedFact.data) : []),
            ]),
          ],
          req.body.referenceImages,
        );
        if (assetIds.length) {
          await trx("o_assets2Storyboard").insert(assetIds.map((assetId) => ({ storyboardId: id, assetId })));
        }
        if (req.body.flowId) {
          await bindImageFlowToStoryboard(trx, req.body.flowId, {
            projectId: req.body.projectId,
            scriptId: req.body.scriptId,
            targetId: Number(id),
            selectedImageUrl: req.body.src || "",
          });
        }
        await updateTrackDuration(trx, trackId);
        return {
          id: Number(id),
          flowId: req.body.flowId ?? null,
          associateAssetsIds: assetIds,
          referenceImages: req.body.referenceImages,
          groupKey: groupMeta.groupKey,
          groupName: groupMeta.groupName,
          groupIntent: groupMeta.groupIntent,
          beatId: groupMeta.beatId,
          scene: req.body.scene || null,
          picture: req.body.picture || null,
          action: req.body.action || null,
          shotSize: req.body.shotSize || null,
          cameraMove: req.body.cameraMove || null,
          dialogue: req.body.dialogue || null,
          sound: req.body.sound || null,
          visibleEmotion: req.body.visibleEmotion || null,
          tableRowJson: JSON.stringify(factObject),
          factStatus: parsedFact.success ? "ready" : "draft",
          issues: parsedFact.success ? [] : parsedFact.error.issues,
          musicPlan,
          duration: req.body.duration,
        };
      });
      return res.status(200).send(success(result));
    } catch (cause) {
      if (cause instanceof StoryboardContractError) {
        return res.status(400).send(error(cause.message, { issues: cause.issues }));
      }
      throw cause;
    }
  },
);
