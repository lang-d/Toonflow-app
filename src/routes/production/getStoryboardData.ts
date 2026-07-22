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
  }),
  async (req, res) => {
    const { scriptId } = req.body;
    const storyboardData = await u.db("o_storyboard").where({ scriptId }).orderBy("index", "asc");
    const data = await Promise.all(
      storyboardData.map(async (i) => {
        return {
          ...i,
          filePath: i.filePath ? await u.oss.getSmallImageUrl(i.filePath!) : "",
        };
      }),
    );

    //获取相关资产
    const storyboardIds = storyboardData.map((s) => s.id as number);

    // 修复：o_assets.id 关联 o_assets2Storyboard.assetId，按 storyboardId 过滤
    const storyboardConfigs = await u
      .db("o_assets2Storyboard")
      .leftJoin("o_assets", "o_assets2Storyboard.assetId", "o_assets.id")
      .leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .whereIn("o_assets2Storyboard.storyboardId", storyboardIds)
      .select("o_assets2Storyboard.storyboardId", "o_assets.id as assetId", "o_assets.name", "o_assets.type", "o_image.filePath as avatar");

    // 按 storyboardId 分组，生成 characters 列表
    const storyboardCharactersMap = storyboardConfigs.reduce<Record<number, { name: string; type: string; avatar?: string }[]>>((acc, cur) => {
      const storyboardId = cur.storyboardId as number;
      if (!acc[storyboardId]) {
        acc[storyboardId] = [];
      }
      const character: { name: string; type: string; avatar?: string } = {
        name: cur.name ?? "",
        type: cur.type ?? "",
      };
      if (cur.avatar) {
        character.avatar = cur.avatar;
      }
      acc[storyboardId].push(character);
      return acc;
    }, {});

    // 组装最终数据，符合 Shot 接口格式
    const result = await Promise.all(
      data.map(async (item) => {
        const characters = storyboardCharactersMap[item.id as number] ?? [];
        const fact = buildStoryboardVideoFact(item, []);
        // 处理 characters 中的 avatar OSS 路径
        const charactersWithUrl = await Promise.all(
          characters.map(async (c) => {
            if (c.avatar) {
              return { ...c, avatar: await u.oss.getSmallImageUrl(c.avatar) };
            }
            return c;
          }),
        );
        return {
          id: String(item.id),
          createTime: item.createTime ?? undefined,
          filePath: item.filePath || undefined,
          prompt: item.prompt ?? undefined,
          scriptId: item.scriptId ?? undefined,
          groupKey: item.groupKey ?? undefined,
          groupName: item.groupName ?? undefined,
          groupIntent: item.groupIntent ?? undefined,
          beatId: item.beatId ?? undefined,
          scene: fact.scene || undefined,
          picture: fact.picture || undefined,
          action: fact.action || undefined,
          shotSize: fact.shotSize || undefined,
          cameraMove: fact.cameraMove || undefined,
          cameraAngle: fact.cameraAngle || undefined,
          transitionFromPrevious: fact.transitionFromPrevious || undefined,
          dialogue: fact.dialogue || undefined,
          sound: fact.sound || undefined,
          visibleEmotion: fact.visibleEmotion || undefined,
          location: fact.location || undefined,
          timeOfDay: fact.timeOfDay || undefined,
          sceneContinuityId: fact.sceneContinuityId || undefined,
          tableRowJson: item.tableRowJson || undefined,
          factSource: fact.factSource,
          factStatus: fact.factStatus,
          duration: fact.duration == null ? undefined : Number(fact.duration),
          characters: fact.characters.length ? fact.characters : charactersWithUrl,
          requiredAssets: fact.requiredAssets,
        };
      }),
    );
    res.status(200).send(success(result));
  },
);
