import u from "@/utils";

export async function getAudioAssetResponse(id: number) {
  const parent = await u.db("o_assets").where({ id, type: "audio" }).first();
  if (!parent) return null;
  const children = await u
    .db("o_assets")
    .leftJoin("o_image", "o_assets.imageId", "o_image.id")
    .select(
      "o_assets.id",
      "o_assets.assetsId",
      "o_assets.name",
      "o_assets.describe",
      "o_assets.prompt",
      "o_assets.type",
      "o_assets.imageId",
      "o_assets.projectId",
      "o_image.filePath",
    )
    .where("o_assets.assetsId", id)
    .where("o_assets.type", "audio");

  const sonAssets = await Promise.all(
    children.map(async (child: any) => ({
      id: child.id,
      assetsId: child.assetsId,
      name: child.name ?? "",
      describe: child.describe ?? "",
      prompt: child.prompt ?? "",
      type: "audio",
      imageId: child.imageId,
      projectId: child.projectId,
      filePath: child.filePath ?? "",
      src: child.filePath ? await u.oss.getFileUrl(child.filePath) : "",
    })),
  );

  return {
    id: parent.id,
    name: parent.name ?? "",
    describe: parent.describe ?? "",
    type: "audio",
    projectId: parent.projectId,
    sonAssets,
  };
}
