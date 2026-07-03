import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    type: z.array(z.string()).optional(),
  }),
  async (req, res) => {
    const { projectId, type } = req.body;
    const data = await u
      .db("o_assets")
      .leftJoin("o_image", "o_assets.imageId", "o_image.id")
      .leftJoin("o_directorAsset", "o_directorAsset.assetId", "o_assets.id")
      .select(
        "o_assets.*",
        "o_image.filePath",
        "o_image.state",
        "o_image.model",
        "o_image.resolution",
        "o_image.errorReason",
        "o_image.id as imageId",
        "o_directorAsset.id as sourceId",
        "o_directorAsset.assetType as directorAssetType",
      )
      .where("o_assets.projectId", projectId)
      .andWhere("o_assets.type", "<>", "clip")
      .andWhere("o_assets.type", "<>", "audio")
      .andWhere("o_assets.assetsId", null)
      .modify((qb) => {
        if (type && type.length > 0) qb.whereIn("o_assets.type", type);
      })
      .orderByRaw(`CASE o_assets.type WHEN 'role' THEN 1 WHEN 'scene' THEN 2 WHEN 'tool' THEN 3 ELSE 4 END`);
    const parentIds = data.map((item: any) => Number(item.id)).filter(Number.isFinite);
    const childAssets = parentIds.length
      ? await u
          .db("o_assets")
          .leftJoin("o_image", "o_assets.imageId", "o_image.id")
          .select(
            "o_assets.*",
            "o_image.filePath",
            "o_image.state",
            "o_image.model",
            "o_image.resolution",
            "o_image.errorReason",
            "o_image.id as imageId",
          )
          .where("o_assets.projectId", projectId)
          .andWhere("o_assets.type", "<>", "clip")
          .andWhere("o_assets.type", "<>", "audio")
          .whereIn("o_assets.assetsId", parentIds)
          .modify((qb) => {
            if (type && type.length > 0) qb.whereIn("o_assets.type", type);
          })
          .orderBy("o_assets.startTime", "asc")
          .orderBy("o_assets.id", "asc")
      : [];
    const childAssetsByParent: Record<number, any[]> = {};
    await Promise.all(
      childAssets.map(async (child: any) => {
        const parentId = Number(child.assetsId);
        const filePath = child.filePath ? await u.oss.getSmallImageUrl(child.filePath) : "";
        const item = {
          ...child,
          source: "assets",
          sourceId: child.id,
          assetType: child.type,
          desc: child.describe ?? "",
          src: filePath,
          filePath,
        };
        if (!childAssetsByParent[parentId]) childAssetsByParent[parentId] = [item];
        else childAssetsByParent[parentId].push(item);
      }),
    );
    const assets2AudioData = await u
      .db("o_assetsRole2Audio")
      .leftJoin("o_assets", "o_assets.id", "o_assetsRole2Audio.assetsAudioId")
      .whereIn(
        "o_assetsRole2Audio.assetsRoleId",
        data.map((i: any) => i.id!),
      )
      .select("o_assets.id", "o_assets.name", "o_assetsRole2Audio.assetsRoleId");
    const repleAssets: Record<number, { id: number; name: string }[]> = {};
    assets2AudioData.forEach((item) => {
      if (!repleAssets[item.assetsRoleId]) repleAssets[item.assetsRoleId] = [item];
      else repleAssets[item.assetsRoleId].push(item);
    });
    const result = await Promise.all(
      data.map(async (parent: any) => ({
        ...parent,
        source: parent.type === "directorAsset" ? "directorAsset" : "assets",
        sourceId: parent.type === "directorAsset" ? parent.sourceId : parent.id,
        assetType: parent.directorAssetType ?? parent.type,
        filePath: parent.filePath && (await u.oss.getSmallImageUrl(parent.filePath!)),
        sonAssets: childAssetsByParent[parent.id] ?? [],
        derive: childAssetsByParent[parent.id] ?? [],
        relepedAudio: repleAssets[parent.id] ?? [],
      })),
    );
    res.status(200).send(success(result));
  },
);
