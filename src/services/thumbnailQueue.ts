import { createHash } from "node:crypto";
import db from "@/utils/db";
import { createUnifiedTask } from "@/services/taskCoordinator";
import type { ThumbnailSize } from "@/utils/image";

const pendingEnqueues = new Map<string, Promise<string>>();

export async function enqueueThumbnail(input: {
  originalPath: string;
  thumbnailPath: string;
  size?: ThumbnailSize;
}) {
  const idempotencyKey = `thumbnail:${createHash("sha1")
    .update(`${input.originalPath}\n${input.thumbnailPath}\n${JSON.stringify(input.size || null)}`)
    .digest("hex")}`;
  const inFlight = pendingEnqueues.get(idempotencyKey);
  if (inFlight) return inFlight;
  const enqueue = (async () => {
    const existing = await (db as any)("o_tasks")
      .where({ idempotencyKey, handler: "thumbnail" })
      .whereIn("status", ["pending", "queued", "submitting", "processing"])
      .first();
    if (existing) return existing.taskId;
    const projectId = Number(input.originalPath.replace(/^[/\\]+/, "").split(/[\\/]/)[0]) || 0;
    const task = await createUnifiedTask({
      projectId,
      taskClass: "生成缩略图",
      taskType: "media",
      status: "queued",
      handler: "thumbnail",
      idempotencyKey,
      priority: -10,
      maxAttempts: 1,
      payload: input,
    });
    return task.taskId;
  })().finally(() => pendingEnqueues.delete(idempotencyKey));
  pendingEnqueues.set(idempotencyKey, enqueue);
  return enqueue;
}
