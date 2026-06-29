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

async function persistAudioBase64(item: { src?: string; base64: string }, projectId: number) {
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
    name: z.string(),
    describe: z.string(),
    projectId: z.number(),
    assetsItem: z.array(
      z.object({
        base64: z.string(),
        prompt: z.string(),
        describe: z.string(),
        name: z.string(),
      }),
    ),
  }),
  async (req, res) => {
    const { name, describe, projectId, assetsItem } = req.body;
    await Promise.all(assetsItem.map(async (item: { src?: string; base64: string }) => persistAudioBase64(item, projectId)));

    const [id] = await u.db("o_assets").insert({
      name,
      describe,
      type: "audio",
      projectId,
      startTime: Date.now(),
    });
    for (const item of assetsItem) {
      const [assetsId] = await u.db("o_assets").insert({
        prompt: item.prompt,
        assetsId: id,
        type: "audio",
        describe: item.describe,
        name: item.name,
        projectId,
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

    const audioAsset = await getAudioAssetResponse(id);
    res.status(200).send(success({ message: "新增资产成功", audioAsset }));
  },
);
