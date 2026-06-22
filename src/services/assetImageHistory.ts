import u from "@/utils";
import { toTaskStatus } from "@/lib/taskStatus";

export async function getAssetImageHistory(assetsId: number) {
  const asset = await u.db("o_assets").where("id", assetsId).select("id", "imageId").first();
  if (!asset) return null;

  const images = await u.db("o_image").where("assetsId", assetsId).orderBy("id", "desc").select("*");
  const imageIds = images.map((item: any) => Number(item.id)).filter(Number.isFinite);
  const tasks = imageIds.length
    ? await u
        .db("o_tasks")
        .where("businessType", "image")
        .whereIn("businessId", imageIds)
        .orderBy("updateTime", "desc")
        .orderBy("id", "desc")
        .select("id", "taskId", "businessId", "status", "updateTime")
    : [];

  const latestTaskByImageId = new Map<number, any>();
  for (const task of tasks) {
    const imageId = Number(task.businessId);
    if (!latestTaskByImageId.has(imageId)) latestTaskByImageId.set(imageId, task);
  }

  const tempAssets = await Promise.all(
    images.map(async (item: any) => {
      const task = latestTaskByImageId.get(Number(item.id));
      const media = item.filePath
        ? await u.mediaRef.toMediaRef(item.filePath, {
            id: item.id,
            source: "assets",
            sourceId: assetsId,
          })
        : null;
      return {
        ...item,
        filePath: media?.previewUrl || "",
        media,
        status: task?.status || toTaskStatus(item.state) || "pending",
        taskId: task?.taskId || undefined,
        legacyTaskId: task?.id ?? undefined,
        selected: asset.imageId != null && Number(item.id) === Number(asset.imageId),
      };
    }),
  );

  return {
    id: Number(asset.id),
    imageId: asset.imageId == null ? null : Number(asset.imageId),
    tempAssets,
  };
}
