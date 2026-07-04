import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { buildStoryboardVideoFact } from "@/services/storyboardFacts";
import { parseMusicPlan } from "@/services/musicSuggestion";
import { parseStoryboardReferences } from "@/services/storyboardEditor";
const router = express.Router();

function normalizeReviewState(value: unknown): "pending" | "passed" | "hasIssues" | "blocked" {
  return value === "passed" || value === "hasIssues" || value === "blocked" ? value : "pending";
}

function isPrivateMediaPath(value: string, projectId: number, scriptId: number) {
  return value.startsWith(`${projectId}/imageFlow/${scriptId}/media/`);
}

async function buildLocalAudioReference(item: any, projectId: number, scriptId: number): Promise<TrackMedia | null> {
  if (item?.source !== "local" || item?.type !== "audio") return null;
  const rawPath = item?.media?.path || item?.sourceId || item?.id || item?.url;
  const mediaPath = u.mediaRef.normalizeMediaPath(rawPath);
  if (!isPrivateMediaPath(mediaPath, projectId, scriptId)) return null;
  const media = await u.mediaRef.toMediaRef(mediaPath, {
    id: mediaPath,
    type: "audio",
    source: "local",
    sourceId: mediaPath,
    name: item?.name || item?.media?.name || item?.label || "本地音频",
    preview: false,
  });
  if (!media) return null;
  media.previewUrl = media.previewUrl || media.url;
  return {
    id: mediaPath,
    sources: "local",
    fileType: "audio",
    src: media.url,
    media,
    name: media.name,
  };
}

async function buildLocalAudioReferences(storyboard: any, projectId: number, scriptId: number): Promise<TrackMedia[]> {
  const refs = parseStoryboardReferences(storyboard.referenceImages);
  const result: TrackMedia[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const item = await buildLocalAudioReference(ref, projectId, scriptId);
    if (!item || seen.has(String(item.id))) continue;
    seen.add(String(item.id));
    result.push(item);
  }
  return result;
}

interface VideoItem {
  id: number;
  src: string;
  state: "未生成" | "生成中" | "已完成" | "生成失败";
}

interface TrackMedia {
  src: string;
  id?: number | string;
  fileType: "image" | "video" | "audio";
  inputOrder?: number;
  referenceToken?: string;
  visualToken?: string;
  visualImageIndex?: number;
  audioToken?: string;
  audioReferenceIndex?: number;
  videoToken?: string;
  videoReferenceIndex?: number;
  videoDesc?: string;
  scene?: string;
  picture?: string;
  action?: string;
  shotSize?: string;
  cameraMove?: string;
  dialogue?: string;
  sound?: string;
  visibleEmotion?: string;
  sources?: "storyboard" | "assets" | "merged" | "directorAsset" | "local";
  sourceRefs?: Array<{ id: number; sources: "storyboard" | "assets" | "directorAsset"; order: number }>;
  media?: Awaited<ReturnType<typeof u.mediaRef.toMediaRef>>;
  name?: string;
}

interface TrackItem {
  id?: number;
  prompt: string;
  state: "未生成" | "生成中" | "已完成" | "生成失败";
  reason?: string;
  duration?: number;
  selectVideoId?: number;
  medias: TrackMedia[];
  videoList: VideoItem[];
  groupKey?: string;
  groupName?: string;
  groupIntent?: string;
  musicPlan?: unknown;
  reviewState?: "pending" | "passed" | "hasIssues" | "blocked";
  reviewIssues?: unknown[];
}

function annotateReferenceTokens(medias: TrackMedia[]): TrackMedia[] {
  let visualImageIndex = 0;
  let audioReferenceIndex = 0;
  let videoReferenceIndex = 0;
  return medias.map((media, index) => {
    const next = { ...media, inputOrder: index + 1 };
    if (media.fileType === "image") {
      visualImageIndex += 1;
      next.visualImageIndex = visualImageIndex;
      next.visualToken = `@Image${visualImageIndex}`;
      next.referenceToken = next.visualToken;
    } else if (media.fileType === "audio") {
      audioReferenceIndex += 1;
      next.audioReferenceIndex = audioReferenceIndex;
      next.audioToken = `参考音频${audioReferenceIndex}`;
      next.referenceToken = next.audioToken;
    } else if (media.fileType === "video") {
      videoReferenceIndex += 1;
      next.videoReferenceIndex = videoReferenceIndex;
      next.videoToken = `参考视频${videoReferenceIndex}`;
      next.referenceToken = next.videoToken;
    }
    return next;
  });
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    scriptId: z.number(),
  }),
  async (req, res) => {
    const { projectId, scriptId } = req.body;
    const projectData = await u.db("o_project").where("id", projectId).select("id", "videoModel", "mode").first();

    if (!projectData?.videoModel) {
      return res.status(400).json(success("项目未配置视频模型"));
    }
    let videoMode = "";
    try {
      videoMode = JSON.parse(projectData?.mode ?? "");
    } catch (e) {
      videoMode = projectData?.mode ?? "";
    }
    const isRef = Array.isArray(videoMode) ? true : false;

    const storyboardList = await u.db("o_storyboard").where({ scriptId, projectId }).orderBy("index", "asc");
    await Promise.all(
      storyboardList.map(async (i) => {
        i.filePath = i.filePath ? await u.oss.getSmallImageUrl(i.filePath) : "";
      }),
    );
    const storyboardTrackRecord: Record<number, any[]> = {};
    const localAudioByStoryboard: Record<number, TrackMedia[]> = {};
    await Promise.all(
      storyboardList.map(async (storyboard) => {
        if (storyboard.id == null) return;
        localAudioByStoryboard[Number(storyboard.id)] = await buildLocalAudioReferences(storyboard, projectId, scriptId);
      }),
    );
    storyboardList.forEach((i) => {
      const fact = buildStoryboardVideoFact(i);
      const factSummary = [
        fact.location,
        fact.timeOfDay,
        fact.picture,
        fact.action,
        fact.dialogue,
        fact.sound,
      ]
        .filter(Boolean)
        .join(" · ");
      if (storyboardTrackRecord[i.trackId!]) {
        storyboardTrackRecord[i.trackId!].push({
          src: i.filePath,
          fileType: "image",
          sources: "storyboard",
          prompt: factSummary,
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
          tableRowJson: i.tableRowJson,
          factStatus: fact.factStatus,
          ...(i.id != null ? { id: i.id } : {}),
          index: i.index,
        });
      } else {
        storyboardTrackRecord[i.trackId!] = [
          {
            src: i.filePath,
            fileType: "image",
            sources: "storyboard",
            prompt: factSummary,
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
            tableRowJson: i.tableRowJson,
            factStatus: fact.factStatus,
            ...(i.id != null ? { id: i.id } : {}),
            index: i.index,
          },
        ];
      }
    });
    // 按 storyboardId 分组的资产数据，key 为 storyboardId
    const otherDataMap: Record<number, any[]> = {};
    // 解析 videoMode 中 audioReference 的数量，例如 'audioReference:3' => 3
    const audioReferenceCount = (() => {
      if (!Array.isArray(videoMode)) return 0;
      const item = (videoMode as string[]).find((v) => v.toLowerCase().startsWith("audioreference:"));
      if (!item) return 0;
      const num = parseInt(item.split(":")[1], 10);
      return isNaN(num) ? 0 : num;
    })();
    if (isRef) {
      const storyIds = storyboardList.map((s) => s.id);

      const assetDatas = await u
        .db("o_assets2Storyboard")
        .leftJoin("o_assets", "o_assets2Storyboard.assetId", "o_assets.id")
        .leftJoin("o_image", "o_image.id", "o_assets.imageId")
        .leftJoin({ parentAsset: "o_assets" }, "parentAsset.id", "o_assets.assetsId")
        .whereIn("o_assets2Storyboard.storyboardId", storyIds as number[])
        .select("o_assets.*", "o_image.filePath", "o_image.type as imageType", "parentAsset.name as parentName", "o_assets2Storyboard.storyboardId");

      const queryAudioIds = [...assetDatas.map((i) => i.id!), ...assetDatas.map((i) => i.assetsId!)].filter(Boolean);
      const assets2AudioData = await u
        .db("o_assetsRole2Audio")
        .leftJoin("o_assets", "o_assets.assetsId", "o_assetsRole2Audio.assetsAudioId")
        .leftJoin("o_image", "o_image.id", "o_assets.imageId")
        .whereIn("o_assetsRole2Audio.assetsRoleId", queryAudioIds)
        .select(
          "o_assets.id",
          "o_assets.name",
          "o_assetsRole2Audio.assetsRoleId",
          "o_assets.describe",
          "o_assets.type",
          "o_assets.prompt",
          "o_image.filePath",
        );
      const audioRecord: Record<string, any> = {};
      await Promise.all(
        assets2AudioData.map(async (i) => {
          if (!audioRecord[i.assetsRoleId]) audioRecord[i.assetsRoleId] = [];
          audioRecord[i.assetsRoleId].push({
            id: i.id,
            name: i.name,
            describe: i.describe,
            type: i.type,
            category: i.type,
            fileType: "audio" as const,
            sources: "assets",
            prompt: i.prompt,
            src: i.filePath ? await u.oss.getFileUrl(i.filePath) : "",
          });
        }),
      );

      await Promise.all(
        assetDatas.map(async (i) => {
          const item = {
            id: i.id,
            name: i.name,
            describe: i.describe,
            type: i.type,
            category: i.type,
            parentName: i.parentName || undefined,
            fileType: i.imageType === "audio" ? ("audio" as const) : i.imageType === "video" || i.type === "clip" ? ("video" as const) : ("image" as const),
            sources: "assets",
            src: i.filePath ? await u.oss.getSmallImageUrl(i.filePath) : "",
          };
          const sid = i.storyboardId as number;
          if (!otherDataMap[sid]) otherDataMap[sid] = [];
          otherDataMap[sid].push(item);
          if (audioRecord[i.id]) otherDataMap[sid].push(...audioRecord[i.id]);
          if (audioRecord[i.assetsId]) otherDataMap[sid].push(...audioRecord[i.assetsId]);
        }),
      );
    }

    const trackData = await u.db("o_videoTrack").where({ projectId, scriptId, archived: 0 }).orderBy("id", "asc");
    const mergedRows = await u
      .db("o_workbenchMergedReference")
      .where({ projectId, scriptId, state: "active" })
      .orderBy("createTime", "asc");
    const mergedByTrack: Record<number, any[]> = {};
    for (const row of mergedRows) {
      const trackId = Number(row.trackId);
      if (!mergedByTrack[trackId]) mergedByTrack[trackId] = [];
      let sourceRefs: Array<{ id: number; sources: "storyboard" | "assets" | "directorAsset"; order: number }> = [];
      try {
        sourceRefs = JSON.parse(row.sourceRefs || "[]");
      } catch {}
      mergedByTrack[trackId].push({
        id: row.id,
        sources: "merged",
        fileType: "image",
        src: row.filePath ? await u.oss.getSmallImageUrl(row.filePath) : "",
        name: row.name || "合图引用",
        prompt: row.prompt || "",
        sourceRefs,
        position: Number(row.position ?? 0),
      });
    }
    const videoList = await u.db("o_video").whereIn(
      "videoTrackId",
      trackData.map((t) => t.id),
    );
    const trackList: TrackItem[] = [];
    const trackIdMap = [...new Set<number>(trackData.map((t) => t.id!))];
    for (const trackId of trackIdMap) {
      const item = trackData.find((t) => t.id === trackId);
      trackList.push({
        id: trackId,
        duration: item?.duration ?? 0,
        prompt: item?.prompt || "",
        state: (item?.state as "未生成" | "生成中" | "已完成" | "生成失败") ?? "未生成",
        reason: item?.reason ?? "",
        groupKey: item?.groupKey ?? "",
        groupName: item?.groupName ?? "",
        groupIntent: item?.groupIntent ?? "",
        musicPlan: parseMusicPlan(item?.musicPlanJson),
        reviewState: normalizeReviewState(item?.reviewState),
        reviewIssues: (() => {
          try {
            return JSON.parse(item?.reviewIssuesJson || "[]");
          } catch {
            return [];
          }
        })(),
        selectVideoId: Number(item?.videoId)!,
        medias: (() => {
          const storyboardMedias = storyboardTrackRecord[trackId] ?? [];
          const assetMedias = storyboardMedias.flatMap((s) => otherDataMap[s.id] ?? []);
          const localAudioMedias = storyboardMedias.flatMap((s) => localAudioByStoryboard[Number(s.id)] ?? []);

          const seenAssetIds = new Set<number>();
          const uniqueAssets = assetMedias.filter((a) => {
            if (seenAssetIds.has(a.id)) return false;
            seenAssetIds.add(a.id);
            return true;
          });

          // 有 audioReference 时，按数量截取 audio 类型资产
          const audioCountMap: Record<string, number> = {};
          const filteredAssets = uniqueAssets.filter((a) => {
            if (a.fileType !== "audio" || audioReferenceCount === 0) return true;
            const key = String(a.id);
            audioCountMap[key] = (audioCountMap[key] ?? 0) + 1;
            // 统计当前 track 内 audio 总数，超过上限则过滤
            const totalAudio = Object.values(audioCountMap).reduce((s, n) => s + n, 0);
            return totalAudio <= audioReferenceCount;
          });

          const hasImageAssetData = filteredAssets.filter((i) => i.src);
          const notHasImageAssetData = filteredAssets.filter((i) => !i.src);

          let medias = [...hasImageAssetData, ...localAudioMedias, ...storyboardMedias, ...notHasImageAssetData];
          for (const merged of mergedByTrack[trackId] || []) {
            const sourceKeys = new Set(merged.sourceRefs.map((ref: any) => `${ref.sources}:${ref.id}`));
            const firstMatchedIndex = medias.findIndex((item: any) => sourceKeys.has(`${item.sources}:${item.id}`));
            medias = medias.filter((item: any) => !sourceKeys.has(`${item.sources}:${item.id}`));
            const insertIndex =
              firstMatchedIndex >= 0
                ? Math.min(firstMatchedIndex, medias.length)
                : Math.max(0, Math.min(Number(merged.position || 0), medias.length));
            const { position: _, ...media } = merged;
            medias.splice(insertIndex, 0, media);
          }
          return annotateReferenceTokens(medias);
        })(),
        videoList: await Promise.all(
          videoList
            .filter((v) => v.videoTrackId === trackId)
            .map(async (v) => ({
              id: v.id!,
              src: v.filePath ? await u.oss.getFileUrl(v.filePath) : "",
              state: v.state === "已完成" ? "已完成" : v.state === "生成中" ? "生成中" : v.state === "生成失败" ? "生成失败" : "未生成",
              errorReason: v?.errorReason ?? "",
            })),
        ),
      });
    }
    res.status(200).send(
      success({
        storyboardList: await Promise.all(
          storyboardList.map(async (s) => ({
            ...s,
            src: s.filePath,
          })),
        ),
        trackList,
      }),
    );
  },
);
