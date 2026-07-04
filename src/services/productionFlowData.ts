import u from "@/utils";
import { toTaskStatus } from "@/lib/taskStatus";
import { resolveStoryboardReferences } from "@/services/storyboardEditor";
import { renderStoryboardTableFromRows } from "@/services/storyboardTableText";
import { buildStoryboardVideoFact } from "@/services/storyboardFacts";
import { getDeriveAssetPromptSnapshot } from "@/services/imageFlow";
import { getTextAssetContent } from "@/services/textAsset";
import { VISUAL_ASSET_TYPES } from "@/services/assetTypes";

const ACTIVE_IMAGE_TASK_STATUSES = new Set(["queued", "submitting", "processing"]);

function parseStoredWorkData(value: unknown) {
  if (!value) return {};
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return {};
  }
}

function resolveStoryboardImageStatus(item: any, task: any, unifiedTask: any) {
  const storyboardStatus = toTaskStatus(item.state) || "pending";
  const taskStatus = task ? toTaskStatus(task.status) || toTaskStatus(task.state) : undefined;
  const unifiedStatus = unifiedTask ? toTaskStatus(unifiedTask.status) || toTaskStatus(unifiedTask.state) : undefined;
  const activeStatus = [taskStatus, unifiedStatus].find((status) => status && ACTIVE_IMAGE_TASK_STATUSES.has(status));
  const hasSelectedFinalImage = storyboardStatus === "completed" && Boolean(item.filePath);

  if (activeStatus) {
    return {
      status: activeStatus,
      taskId: unifiedTask?.taskId || undefined,
      unifiedTaskId: unifiedTask?.taskId || undefined,
      legacyTaskId: task?.id || undefined,
      nodeId: task?.nodeId || undefined,
    };
  }

  if (hasSelectedFinalImage) {
    return {
      status: storyboardStatus,
      taskId: undefined,
      unifiedTaskId: undefined,
      legacyTaskId: undefined,
      nodeId: undefined,
    };
  }

  const status = taskStatus || unifiedStatus || storyboardStatus;
  return {
    status,
    taskId: unifiedTask?.taskId || undefined,
    unifiedTaskId: unifiedTask?.taskId || undefined,
    legacyTaskId: task?.id || undefined,
    nodeId: task?.nodeId || undefined,
  };
}

export async function readPersistedScriptPlan(projectId: number, scriptId: number) {
  const asset = await u
    .db("o_textAsset")
    .where({ projectId, scriptId, targetType: "scriptPlan", state: "complete" })
    .orderBy("version", "desc")
    .orderBy("id", "desc")
    .first();
  if (!asset) return "";
  return (await getTextAssetContent({ id: Number(asset.id), projectId, limit: Number.MAX_SAFE_INTEGER })).content;
}

export async function buildProductionFlowData(projectId: number, episodesId: number) {
  const [storedWorkData, scriptData, scriptAssets] = await Promise.all([
    u
      .db("o_agentWorkData")
      .where("projectId", String(projectId))
      .andWhere("episodesId", String(episodesId))
      .select("data")
      .first(),
    u.db("o_script").where({ projectId, id: episodesId }).first(),
    u.db("o_scriptAssets").where("scriptId", episodesId),
  ]);
  const assetIds = [...new Set(scriptAssets.map((item: any) => Number(item.assetId)).filter(Number.isFinite))];
  const boundAudioRows = assetIds.length
    ? await u.db("o_assetsRole2Audio").whereIn("assetsRoleId", assetIds).select("assetsRoleId", "assetsAudioId")
    : [];
  const visualAssetIds = assetIds;
  const boundAudioAssetIds = [
    ...new Set(boundAudioRows.map((item: any) => Number(item.assetsAudioId)).filter(Number.isFinite)),
  ];
  const assetsData = visualAssetIds.length
    ? await u
        .db("o_assets")
        .leftJoin("o_image", "o_assets.imageId", "o_image.id")
        .select("o_assets.*", "o_image.filePath", "o_image.state", "o_image.errorReason")
        .whereIn("o_assets.id", visualAssetIds)
        .whereIn("o_assets.type", VISUAL_ASSET_TYPES as unknown as string[])
        .whereNull("o_assets.assetsId")
        .where("o_assets.projectId", projectId)
    : [];
  const childAssetsData = visualAssetIds.length
    ? await u
        .db("o_assets")
        .leftJoin("o_image", "o_assets.imageId", "o_image.id")
        .select("o_assets.*", "o_image.filePath", "o_image.state", "o_image.errorReason")
        .where("o_assets.projectId", projectId)
        .whereIn("o_assets.assetsId", visualAssetIds)
        .whereIn("o_assets.type", VISUAL_ASSET_TYPES as unknown as string[])
        .whereNotNull("o_assets.assetsId")
    : [];
  const audioParentRows = boundAudioAssetIds.length
    ? await u
        .db("o_assets")
        .leftJoin("o_image", "o_assets.imageId", "o_image.id")
        .select("o_assets.*", "o_image.filePath", "o_image.state", "o_image.errorReason")
        .whereIn("o_assets.id", boundAudioAssetIds)
        .where("o_assets.projectId", projectId)
        .where("o_assets.type", "audio")
    : [];
  const audioFileRows = boundAudioAssetIds.length
    ? await u
        .db("o_assets")
        .leftJoin("o_image", "o_assets.imageId", "o_image.id")
        .select("o_assets.*", "o_image.filePath", "o_image.state", "o_image.errorReason")
        .whereIn("o_assets.assetsId", boundAudioAssetIds)
        .where("o_assets.projectId", projectId)
        .where("o_assets.type", "audio")
    : [];
  const directorAssetsRows = await u
    .db("o_directorAsset")
    .join("o_assets", "o_assets.id", "o_directorAsset.assetId")
    .join("o_image", "o_image.id", "o_directorAsset.imageId")
    .where("o_directorAsset.projectId", projectId)
    .andWhere((query: any) => {
      query.where("o_directorAsset.scriptId", episodesId).orWhereNull("o_directorAsset.scriptId");
    })
    .select(
      "o_directorAsset.id",
      "o_directorAsset.assetId",
      "o_directorAsset.imageId",
      "o_directorAsset.assetType",
      "o_directorAsset.name",
      "o_directorAsset.promptFragment",
      "o_image.filePath",
    );
  const directorAssets = directorAssetsRows.map((item: any) => ({
    id: item.id,
    assetId: item.assetId,
    imageId: item.imageId,
    name: item.name,
    type: "directorAsset",
    assetType: item.assetType,
    prompt: item.promptFragment || "",
    source: "directorAsset",
    sourceId: item.id,
    filePath: item.filePath || "",
  }));
  const assets = await Promise.all(
    assetsData.map(async (item: any) => ({
      id: item.id,
      name: item.name ?? "",
      type: item.type ?? "",
      prompt: item.prompt ?? "",
      desc: item.describe ?? "",
      src: item.filePath ? await u.oss.getSmallImageUrl(item.filePath) : "",
      flowId: item.flowId,
      derive: await Promise.all(
        childAssetsData
          .filter((child: any) => Number(child.assetsId) === Number(item.id))
          .map(async (child: any) => {
            const promptSnapshot = await getDeriveAssetPromptSnapshot(u.db, {
              projectId,
              targetId: child.id,
              flowId: child.flowId,
              fallbackPrompt: child.prompt,
            });
            return {
              id: child.id,
              assetsId: item.id,
              name: child.name ?? "",
              type: child.type,
              prompt: promptSnapshot.prompt,
              nodeId: promptSnapshot.nodeId,
              desc: child.describe ?? "",
              src: child.filePath ? await u.oss.getSmallImageUrl(child.filePath) : "",
              state: child.state ?? "未生成",
              errorReason: child.errorReason ?? "",
              flowId: child.flowId,
            };
          }),
      ),
    })),
  );
  const audioParentsById = new Map(audioParentRows.map((item: any) => [Number(item.id), item]));
  const audioFilesByParentId = new Map<number, any[]>();
  for (const item of audioFileRows) {
    const parentId = Number(item.assetsId);
    if (!audioFilesByParentId.has(parentId)) audioFilesByParentId.set(parentId, []);
    audioFilesByParentId.get(parentId)!.push(item);
  }
  const assetAudioBindings = await Promise.all(
    boundAudioRows
      .map((item: any) => ({
        assetsRoleId: Number(item.assetsRoleId),
        assetsAudioId: Number(item.assetsAudioId),
      }))
      .filter((item: any) => Number.isFinite(item.assetsRoleId) && Number.isFinite(item.assetsAudioId))
      .map(async (item: any) => {
        const audio = audioParentsById.get(item.assetsAudioId);
        return {
          assetId: item.assetsRoleId,
          audioAssetId: item.assetsAudioId,
          name: audio?.name ?? "",
          desc: audio?.describe ?? "",
          src: audio?.filePath ? await u.oss.getFileUrl(audio.filePath) : "",
          files: await Promise.all(
            (audioFilesByParentId.get(item.assetsAudioId) || []).map(async (file: any) => ({
              id: file.id,
              audioAssetId: item.assetsAudioId,
              name: file.name ?? "",
              prompt: file.prompt ?? "",
              desc: file.describe ?? "",
              src: file.filePath ? await u.oss.getFileUrl(file.filePath) : "",
              state: file.state ?? "未生成",
              errorReason: file.errorReason ?? "",
            })),
          ),
        };
      }),
  );

  const storyboardRows = await u
    .db("o_storyboard")
    .where({ projectId, scriptId: episodesId })
    .orderBy("index", "asc")
    .orderBy("id", "asc");
  const storyboardIds = storyboardRows.map((item: any) => Number(item.id));
  const assetLinks = storyboardIds.length
    ? await u
        .db("o_assets2Storyboard")
        .whereIn("storyboardId", storyboardIds)
        .orderBy("rowid")
        .select("storyboardId", "assetId")
    : [];
  const assetMap = new Map<number, number[]>();
  for (const link of assetLinks) {
    const storyboardId = Number(link.storyboardId);
    if (!assetMap.has(storyboardId)) assetMap.set(storyboardId, []);
    assetMap.get(storyboardId)!.push(Number(link.assetId));
  }
  const flowTasks = storyboardIds.length
    ? await u
        .db("o_editImageTask")
        .where("targetType", "storyboard")
        .whereIn("targetId", storyboardIds)
        .orderBy("updateTime", "desc")
        .orderBy("id", "desc")
        .select("id", "targetId", "nodeId", "status", "state", "reason")
    : [];
  const latestTaskByStoryboard = new Map<number, any>();
  for (const task of flowTasks) {
    const storyboardId = Number(task.targetId);
    if (!latestTaskByStoryboard.has(storyboardId)) latestTaskByStoryboard.set(storyboardId, task);
  }
  const taskIds = [...latestTaskByStoryboard.values()].map((task: any) => Number(task.id)).filter(Number.isFinite);
  const unifiedTasks = taskIds.length
    ? await u
        .db("o_tasks")
        .where("businessType", "image-flow")
        .whereIn("businessId", taskIds)
        .select("taskId", "businessId", "status")
    : [];
  const unifiedTaskByEditTask = new Map(unifiedTasks.map((task: any) => [Number(task.businessId), task]));
  const storyboard = await Promise.all(
    storyboardRows.map(async (item: any) => {
      const associateAssetsIds = assetMap.get(Number(item.id)) || [];
      const fact = buildStoryboardVideoFact(item, associateAssetsIds);
      const task = latestTaskByStoryboard.get(Number(item.id));
      const unifiedTask = task ? unifiedTaskByEditTask.get(Number(task.id)) : null;
      const imageStatus = resolveStoryboardImageStatus(item, task, unifiedTask);
      return {
        id: item.id,
        index: item.index,
        duration: Number(fact.duration || 0),
        prompt: item.prompt || "",
        associateAssetsIds,
        src: item.filePath ? await u.oss.getSmallImageUrl(item.filePath) : "",
        state: item.state,
        status: imageStatus.status,
        taskId: imageStatus.taskId,
        unifiedTaskId: imageStatus.unifiedTaskId,
        legacyTaskId: imageStatus.legacyTaskId,
        nodeId: imageStatus.nodeId,
        videoDesc: fact.rawVideoDesc,
        scene: fact.scene,
        picture: fact.picture,
        action: fact.action,
        shotSize: fact.shotSize,
        cameraMove: fact.cameraMove,
        dialogue: fact.dialogue,
        sound: fact.sound,
        visibleEmotion: fact.visibleEmotion,
        location: fact.location,
        timeOfDay: fact.timeOfDay,
        sceneContinuityId: fact.tableRow?.sceneContinuityId || null,
        tableRowJson: item.tableRowJson,
        factSource: fact.factSource,
        factStatus: fact.factStatus,
        factVersion: item.factVersion || 1,
        groupKey: fact.groupKey,
        groupName: fact.groupName,
        groupIntent: fact.groupIntent,
        beatId: fact.beatId,
        trackId: item.trackId,
        shouldGenerateImage: item.shouldGenerateImage,
        reason: item.reason ?? "",
        flowId: item.flowId,
        referenceImages: await resolveStoryboardReferences(item.referenceImages),
      };
    }),
  );
  const rendered = await renderStoryboardTableFromRows(projectId, episodesId);
  const latestGenerationFailure = await u
    .db("o_storyboardGeneration")
    .where({ projectId, scriptId: episodesId })
    .whereIn("state", ["invalid", "failed"])
    .orderBy("updatedAt", "desc")
    .first("generationId", "state", "expectedRowCount", "errorJson", "updatedAt");
  const stored = parseStoredWorkData(storedWorkData?.data) as any;
  const persistedScriptPlan = await readPersistedScriptPlan(projectId, episodesId);
  return {
    ...stored,
    script: scriptData?.content ?? "",
    scriptPlan: persistedScriptPlan || stored.scriptPlan || "",
    assets,
    assetAudioBindings,
    storyboard,
    storyboardTable: rendered.content,
    storyboardTableMeta: rendered.meta,
    storyboardGenerationLastFailure: latestGenerationFailure
      ? {
          generationId: latestGenerationFailure.generationId,
          state: latestGenerationFailure.state,
          expectedRowCount: latestGenerationFailure.expectedRowCount,
          errorJson: latestGenerationFailure.errorJson,
          updatedAt: latestGenerationFailure.updatedAt,
        }
      : null,
    directorAssets,
    workbench: stored.workbench || { videoList: [] },
  };
}
