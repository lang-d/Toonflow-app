import { createUnifiedTask, updateUnifiedTask } from "@/services/taskCoordinator";
/**
 * 记录任务并返回结束函数
 * @param projectId  项目 ID
 * @param taskClass  任务分类
 * @param modelName   模型名称
 * @param opts       可选项：关联对象、任务描
 */
export default async function taskRecord(
  projectId: number,
  taskClass: string,
  modelName: string,
  opts: {
    describe?: string;
    content?: any;
  } = {},
) {
  const { content, describe = "" } = opts;

  let opteorContent: string | undefined;
  if (content === undefined || content === null) {
    opteorContent = undefined;
  } else if (typeof content === "string") {
    opteorContent = content;
  } else if (typeof content === "function") {
    throw new Error("不支持的类型");
  } else {
    try {
      opteorContent = JSON.stringify(content);
    } catch (e) {
      opteorContent = content.toString();
    }
  }

  const task = await createUnifiedTask({
    projectId,
    taskClass,
    taskType: taskClass.includes("视频")
      ? "video"
      : taskClass.includes("图片") || taskClass.includes("图生成")
        ? "image"
        : taskClass.includes("音频") || taskClass.includes("音色")
          ? "audio"
          : "prompt",
    status: "processing",
    phase: "provider-call",
    relatedObjects: opteorContent,
    model: modelName,
    describe,
  });

  /** 任务成功时调用 done(1)，失败时调用 done(-1, '原因') */
  return async function done(state: 1 | -1, reason?: string) {
    await updateUnifiedTask(task.taskId, {
      status: state === 1 ? "completed" : "failed",
      phase: state === 1 ? "completed" : "failed",
      progress: state === 1 ? 100 : undefined,
      reason: state === -1 ? reason || "任务失败" : "",
      clearLease: true,
    });
  };
}
