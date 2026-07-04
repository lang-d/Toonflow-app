import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { cleanupAssetRelations, collectAssetTreeIds } from "@/services/scriptAssetBinding";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number(),
  }),
  async (req, res) => {
    const { id } = req.body;
    const targetAssetIds = await collectAssetTreeIds(u.db, [id]);
    const assetsData = targetAssetIds.length ? await u.db("o_image").whereIn("assetsId", targetAssetIds) : [];
    await Promise.all(
      assetsData.map((i) =>
        i.filePath
          ? u.oss.deleteFile(i.filePath).catch((e) => {
              if (e?.code !== "ENOENT") throw e;
            })
          : Promise.resolve(),
      ),
    );
    const imageIds = assetsData.map((i) => i.id).filter(Boolean);
    if (imageIds.length > 0) {
      await u.db("o_assets").whereIn("imageId", imageIds).update({ imageId: null });
    }
    await cleanupAssetRelations(u.db, targetAssetIds);
    if (targetAssetIds.length) {
      await u.db("o_image").whereIn("assetsId", targetAssetIds).delete();
      await u.db("o_assets").whereIn("id", targetAssetIds).delete();
    }
    res.status(200).send(success({ message: "删除资产成功" }));
  },
);
