import u from "@/utils";
import { createUnifiedTask, formatUnifiedTaskEnvelope, updateUnifiedTask } from "@/services/taskCoordinator";

const ACTIVE_TASK_STATUSES = ["pending", "queued", "submitting", "processing"];

export interface NovelEventExtractionPayload {
  projectId: number;
  novelIds: number[];
  novelId?: number;
  groupSize?: number;
}

export interface NovelEventExtractionResult extends Record<string, unknown> {
  novelIds: number[];
  completedNovelIds: number[];
  failedNovels: { novelId: number; errorReason: string }[];
}

function normalizeIds(ids: unknown[]) {
  return [...new Set(ids.map(Number).filter(Number.isFinite))];
}

export function chunkNovelEventExtractionIds(novelIds: number[], groupSize = 5) {
  const size = Math.max(1, Math.min(5, Math.floor(Number(groupSize) || 5)));
  const normalized = normalizeIds(novelIds);
  const chunks: number[][] = [];
  for (let index = 0; index < normalized.length; index += size) {
    chunks.push(normalized.slice(index, index + size));
  }
  return chunks;
}

export function novelEventIdsFromPayload(payloadJson: unknown) {
  try {
    const payload = JSON.parse(String(payloadJson || "{}"));
    if (Array.isArray(payload.novelIds)) return normalizeIds(payload.novelIds);
    return normalizeIds(payload.novelId == null ? [] : [payload.novelId]);
  } catch {
    return [];
  }
}

export async function listActiveNovelEventExtractionIds(projectId: number, database: any = u.db) {
  const rows = await database("o_tasks")
    .where({ projectId, handler: "novel-event" })
    .whereIn("status", ACTIVE_TASK_STATUSES)
    .select("payloadJson");
  const active = new Set<number>();
  for (const row of rows) {
    for (const novelId of novelEventIdsFromPayload(row.payloadJson)) active.add(novelId);
  }
  return active;
}

export async function enqueueNovelEventExtraction(input: NovelEventExtractionPayload, database: any = u.db) {
  const projectId = Number(input.projectId);
  const requestedIds = normalizeIds(input.novelIds || []);
  if (!projectId) throw new Error("Missing project id");
  if (!requestedIds.length) return { total: 0, tasks: [], skipped: [] as { novelId: number; reason: string }[] };

  const chapters = await database("o_novel").where("projectId", projectId).whereIn("id", requestedIds).select("id");
  const validIds = chapters.map((chapter: any) => Number(chapter.id)).filter(Number.isFinite);
  const validSet = new Set(validIds);
  const invalidIds = requestedIds.filter((novelId) => !validSet.has(novelId));
  if (invalidIds.length) throw new Error(`Novel chapters do not belong to the current project: ${invalidIds.join(",")}`);

  const activeIds = await listActiveNovelEventExtractionIds(projectId, database);
  const pendingIds = validIds.filter((novelId: number) => !activeIds.has(novelId));
  const skipped = validIds
    .filter((novelId: number) => activeIds.has(novelId))
    .map((novelId: number) => ({ novelId, reason: "active_task_exists" }));
  if (pendingIds.length) {
    await database("o_novel").where("projectId", projectId).whereIn("id", pendingIds).update({
      eventState: 0,
      event: null,
      errorReason: null,
    });
  }

  const tasks = [];
  for (const novelIds of chunkNovelEventExtractionIds(pendingIds, input.groupSize)) {
    const targetId = novelIds.join(",");
    const task = await createUnifiedTask(
      {
        projectId,
        taskClass: "Novel event extraction",
        taskType: "prompt",
        status: "queued",
        phase: "queued",
        progress: 0,
        targetType: "novelEventExtraction",
        targetId,
        businessType: "novel-event",
        businessId: novelIds[0],
        handler: "novel-event",
        describe: `Extract novel events: ${targetId}`,
        payload: { projectId, novelIds, groupSize: 5 },
      },
      database,
    );
    tasks.push({ novelIds, ...formatUnifiedTaskEnvelope(task, "novelEventExtraction", targetId) });
  }

  return { total: tasks.length, tasks, skipped };
}

export async function executeNovelEventExtractionTask(
  payload: NovelEventExtractionPayload,
  task?: any,
  database: any = u.db,
): Promise<NovelEventExtractionResult> {
  const projectId = Number(payload.projectId);
  const novelIds = normalizeIds(Array.isArray(payload.novelIds) ? payload.novelIds : payload.novelId == null ? [] : [payload.novelId]);
  if (!projectId || !novelIds.length) throw new Error("Missing novel event extraction input");

  try {
    if (task?.id) await updateUnifiedTask(task.id, { status: "processing", phase: "extracting", progress: 5 }, database);
    const novels = await database("o_novel").where("projectId", projectId).whereIn("id", novelIds).orderBy("chapterIndex", "asc");
    const foundIds = new Set(novels.map((novel: any) => Number(novel.id)));
    const missingIds = novelIds.filter((novelId) => !foundIds.has(novelId));
    if (missingIds.length) throw new Error(`Novel chapters are unavailable: ${missingIds.join(",")}`);

    const cleaner = new u.cleanNovel(1);
    const failures = new Map<number, string>();
    cleaner.emitter.on("item", (item: any) => {
      if (!item?.event) failures.set(Number(item.id), item.errorReason || "Event extraction failed");
    });
    const completedNovelIds: number[] = [];
    const failedNovels: { novelId: number; errorReason: string }[] = [];

    for (let index = 0; index < novels.length; index += 1) {
      const novel = novels[index];
      if (task?.id) {
        await updateUnifiedTask(task.id, {
          phase: "extracting",
          progress: Math.min(90, 10 + Math.floor((index / novels.length) * 80)),
        }, database);
      }
      const result = await cleaner.start([novel], projectId);
      const event = result[0]?.event;
      if (event) {
        await database("o_novel").where({ id: novel.id, projectId }).update({ event, eventState: 1, errorReason: null });
        completedNovelIds.push(Number(novel.id));
      } else {
        const errorReason = failures.get(Number(novel.id)) || "Event extraction failed";
        await database("o_novel").where({ id: novel.id, projectId }).update({ event: null, eventState: -1, errorReason });
        failedNovels.push({ novelId: Number(novel.id), errorReason });
      }
    }

    const summary: NovelEventExtractionResult = { novelIds, completedNovelIds, failedNovels };
    if (failedNovels.length) {
      const reason = `${failedNovels.length}/${novelIds.length} chapters failed event extraction`;
      if (task?.id) await updateUnifiedTask(task.id, { phase: "partial-failed", progress: 100, result: summary, reason }, database);
      throw new Error(reason);
    }
    if (task?.id) await updateUnifiedTask(task.id, { phase: "saving", progress: 95, result: summary }, database);
    return summary;
  } catch (error) {
    await failPendingNovelEventExtraction(payload, u.error(error).message, database);
    throw error;
  }
}

export async function failPendingNovelEventExtraction(
  payload: Pick<NovelEventExtractionPayload, "projectId" | "novelIds" | "novelId">,
  reason: string,
  database: any = u.db,
) {
  const projectId = Number(payload.projectId);
  const novelIds = normalizeIds(Array.isArray(payload.novelIds) ? payload.novelIds : payload.novelId == null ? [] : [payload.novelId]);
  if (!projectId || !novelIds.length) return;
  await database("o_novel")
    .where("projectId", projectId)
    .whereIn("id", novelIds)
    .where("eventState", 0)
    .update({ eventState: -1, errorReason: reason });
}
