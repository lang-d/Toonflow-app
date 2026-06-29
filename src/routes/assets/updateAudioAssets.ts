import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { getAudioAssetResponse } from "@/services/audioAssetResponse";
const router = express.Router();

const mimeToExt: Record<string, string> = {
  mpeg: "mp3",
  "x-wav": "wav",
  "x-aiff": "aiff",
  "x-m4a": "m4a",
  "x-flac": "flac",
};

async function normalizeAudioItem(item: { src?: string; id?: number; base64?: string }, projectId: number) {
  if (item.src) {
    item.src = u.replaceUrl(item.src);
  }
  if (!item.base64) return;
  const mimeMatch = item.base64.match(/^data:audio\/([^;]+);base64,/);
  const mimeExt = mimeMatch ? mimeMatch[1] : "mp3";
  const ext = mimeToExt[mimeExt] ?? mimeExt;
  const savePath = `/${projectId}/assets/audio/${u.uuid()}.${ext}`;
  const base64Data = item.base64.replace(/^data:[^;]+;base64,/, "");
  await u.oss.writeFile(savePath, base64Data);
  item.src = savePath;
}

export default router.post(
  "/",
  validateFields({
    id: z.number(),
    name: z.string(),
    describe: z.string(),
    projectId: z.number(),
    assetsItem: z.array(
      z.object({
        src: z.string().optional(),
        id: z.number().optional(),
        base64: z.string().optional(),
        prompt: z.string(),
        describe: z.string(),
        name: z.string(),
      }),
    ),
  }),
  async (req, res) => {
    const { id, name, describe, projectId, assetsItem } = req.body;
    await Promise.all(
      assetsItem.map(async (item: { src?: string; id?: number; base64?: string }) => normalizeAudioItem(item, projectId)),
    );

    await u.db("o_assets").where("id", id).update({
      name,
      describe,
    });

    const existingItems = await u.db("o_assets").where("assetsId", id).select("id");
    const existingIds = existingItems.map((item: { id?: number }) => item.id!);
    const incomingIds = assetsItem.filter((item: { id?: number }) => item.id).map((item: { id?: number }) => item.id);
    const toDeleteIds = existingIds.filter((existingId: number) => !incomingIds.includes(existingId));
    if (toDeleteIds.length > 0) {
      const deleteItems = await u.db("o_assets").whereIn("id", toDeleteIds).select("imageId");
      const deleteImageIds = deleteItems.map((item: { imageId?: number | null }) => item.imageId!).filter(Boolean);
      await u.db("o_assets").whereIn("id", toDeleteIds).update({ imageId: null });
      if (deleteImageIds.length > 0) {
        await u.db("o_image").whereIn("id", deleteImageIds).delete();
      }
      await u.db("o_assets").whereIn("id", toDeleteIds).delete();
    }

    for (const item of assetsItem) {
      if (item.id) {
        await u.db("o_assets").where("id", item.id).update({
          prompt: item.prompt,
          describe: item.describe,
          name: item.name,
        });
        const itemData = await u.db("o_assets").where("id", item.id).select("imageId").first();
        await u.db("o_image").where("id", itemData?.imageId).update({
          filePath: item.src,
        });
      } else {
        const [assetsId] = await u.db("o_assets").insert({
          prompt: item.prompt,
          assetsId: id,
          type: "audio",
          projectId,
          describe: item.describe,
          name: item.name,
          startTime: Date.now(),
        });
        const [imageId] = await u.db("o_image").insert({
          filePath: item.src,
          type: "audio",
          assetsId,
          state: "已完成",
        });
        await u.db("o_assets").where("id", assetsId).update({
          imageId,
        });
      }
    }

    const audioAsset = await getAudioAssetResponse(id);
    res.status(200).send(success({ message: "更新音频资产成功", audioAsset }));
  },
);
