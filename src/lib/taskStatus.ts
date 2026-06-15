export type TaskStatus = "pending" | "queued" | "submitting" | "processing" | "completed" | "failed" | "cancelled";

const STATUS_BY_STATE: Record<string, TaskStatus> = {
  未生成: "pending",
  排队中: "queued",
  提交中: "submitting",
  生成中: "processing",
  进行中: "processing",
  已完成: "completed",
  生成成功: "completed",
  生成失败: "failed",
  失败: "failed",
  已取消: "cancelled",
  取消: "cancelled",
  idle: "pending",
  queued: "queued",
  submitting: "submitting",
  generating: "processing",
  processing: "processing",
  completed: "completed",
  success: "completed",
  failed: "failed",
  error: "failed",
  cancelled: "cancelled",
};

const LEGACY_STATE_BY_STATUS: Record<TaskStatus, string> = {
  pending: "未生成",
  queued: "排队中",
  submitting: "提交中",
  processing: "生成中",
  completed: "已完成",
  failed: "生成失败",
  cancelled: "已取消",
};

export function toTaskStatus(state: unknown): TaskStatus | undefined {
  return typeof state === "string" ? STATUS_BY_STATE[state] : undefined;
}

export function toLegacyTaskState(status: TaskStatus): string {
  return LEGACY_STATE_BY_STATUS[status];
}

export function addStatusCompatibility<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => addStatusCompatibility(item)) as T;
  }
  if (!value || typeof value !== "object" || value instanceof Date || Buffer.isBuffer(value)) return value;

  const output = { ...(value as Record<string, unknown>) };
  if (output.status == null) {
    const status = toTaskStatus(output.state);
    if (status) output.status = status;
  }
  for (const [key, item] of Object.entries(output)) {
    if (key !== "status") output[key] = addStatusCompatibility(item);
  }
  return output as T;
}
