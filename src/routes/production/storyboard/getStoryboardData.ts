import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { buildStoryboardVideoFact } from "@/services/storyboardFacts";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    scriptId: z.number(),
    page: z.number(),
    limit: z.number(),
    name: z.string().optional().nullable(),
  }),
  async (req, res) => {
    const { scriptId, page, limit, name } = req.body;
    const offset = (page - 1) * limit;

    const storyboardData = await u
      .db("o_storyboard")
      .where({ scriptId })
      .modify((qb) => {
        if (name) {
          qb.andWhere("title", "like", `%${name}%`);
        }
      })
      .offset(offset)
      .limit(limit);
    const data = await Promise.all(
      storyboardData.map(async (i: any) => {
        const fact = buildStoryboardVideoFact(i, []);
        return {
          id: i.id,
          prompt: i.prompt,
          state: i.state,
          src: i.filePath ? await u.oss.getSmallImageUrl(i.filePath!) : "",
          groupKey: i.groupKey,
          groupName: i.groupName,
          groupIntent: i.groupIntent,
          beatId: i.beatId,
          scene: fact.scene,
          shotDescription: fact.shotDescription,
          picture: fact.picture,
          action: fact.action,
          shotSize: fact.shotSize,
          cameraMove: fact.cameraMove,
          cameraAngle: fact.cameraAngle || undefined,
          transitionFromPrevious: fact.transitionFromPrevious || undefined,
          dialogue: fact.dialogue,
          sound: fact.sound,
          visibleEmotion: fact.visibleEmotion,
          location: fact.location,
          timeOfDay: fact.timeOfDay,
          sceneContinuityId: fact.sceneContinuityId || undefined,
          characters: fact.characters,
          requiredAssets: fact.requiredAssets,
          tableRowJson: i.tableRowJson,
          factSource: fact.factSource,
          factStatus: fact.factStatus,
          factVersion: fact.factVersion,
          duration: fact.duration == null ? undefined : Number(fact.duration),
        };
      }),
    );
    const totalQuery = (await u
      .db("o_storyboard")
      .where({ scriptId })
      .modify((qb) => {
        if (name) {
          qb.andWhere("title", "like", `%${name}%`);
        }
      })
      .count("* as total")
      .first()) as any;

    res.status(200).send(success({ data: data, total: totalQuery?.total }));
  },
);
