import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

function safeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numericDuration(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function createTrackId(trx: any) {
  let trackId = Date.now();
  while (await trx("o_videoTrack").where({ id: trackId }).first()) {
    trackId += 1;
  }
  return trackId;
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
    duration: z.number().optional(),
    groupName: z.string().optional(),
    groupIntent: z.string().optional(),
    storyboardIds: z.array(z.number()).optional(),
  }),
  async (req, res) => {
    const { projectId, scriptId, duration, groupName, groupIntent, storyboardIds = [] } = req.body;
    const project = await u.db("o_project").where({ id: projectId }).first();
    if (!project) return res.status(400).send(error("项目不存在"));
    const script = await u.db("o_script").where({ id: scriptId, projectId }).first();
    if (!script) return res.status(400).send(error("剧集不存在或不属于当前项目"));

    const uniqueStoryboardIds = [...new Set(storyboardIds.map((id: number) => Number(id)).filter(Number.isFinite))];
    let track: any;
    try {
      track = await u.db.transaction(async (trx) => {
        const storyboards = uniqueStoryboardIds.length
          ? await (trx as any)("o_storyboard").where({ projectId, scriptId }).whereIn("id", uniqueStoryboardIds).select("id", "duration")
          : [];
        if (storyboards.length !== uniqueStoryboardIds.length) {
          throw new Error("部分分镜不存在或不属于当前项目剧集");
        }

        const trackId = await createTrackId(trx);
        const manualGroupKey = `manual-${trackId}`;
        const manualGroupName = safeText(groupName) || "手动视频组";
        const manualGroupIntent = safeText(groupIntent);
        const resolvedDuration =
          typeof duration === "number"
            ? duration
            : storyboards.reduce((total: number, row: any) => total + numericDuration(row.duration), 0);

        await trx("o_videoTrack").insert({
          id: trackId,
          projectId,
          scriptId,
          duration: resolvedDuration,
          archived: 0,
          state: "未生成",
          reason: "",
          prompt: "",
          groupKey: manualGroupKey,
          groupName: manualGroupName,
          groupIntent: manualGroupIntent,
          groupPlanJson: JSON.stringify({ source: "manual", storyboardIds: uniqueStoryboardIds }),
          reviewState: "pending",
          reviewIssuesJson: "[]",
        });

        if (uniqueStoryboardIds.length) {
          await (trx as any)("o_storyboard").where({ projectId, scriptId }).whereIn("id", uniqueStoryboardIds).update({
            trackId,
            groupKey: manualGroupKey,
            groupName: manualGroupName,
            groupIntent: manualGroupIntent,
          });
        }

        return {
          id: trackId,
          duration: resolvedDuration,
          prompt: "",
          state: "未生成",
          reason: "",
          groupKey: manualGroupKey,
          groupName: manualGroupName,
          groupIntent: manualGroupIntent,
          musicPlan: null,
          reviewState: "pending",
          reviewIssues: [],
          selectVideoId: null,
          medias: [],
          videoList: [],
        };
      });
    } catch (e) {
      return res.status(400).send(error(u.error(e).message));
    }

    res.status(200).send(success({ trackId: track.id, track }));
  },
);
