import { updateUnifiedTask } from "@/services/taskCoordinator";
import { generateMusicCueAsset } from "@/services/musicAsset";
import { compileMusicCuePrompt } from "@/services/musicCueCompiler";
import { generateMusicBible, generateMusicPlan } from "@/services/musicDirector";
import { reviewMusicBible, reviewMusicPlan, reviewMusicPrompt } from "@/services/musicReviewer";
import { generateProjectContextPack } from "@/services/projectMaterial";
import { isAiObjectContractError } from "@/services/aiJsonObject";

function suggestionIds(result: any) {
  return (result?.suggestions || [])
    .map((item: any) => Number(item?.id))
    .filter((value: number) => Number.isFinite(value) && value > 0);
}

export function musicAiContractFailureMessage(label: string) {
  return `${label}\u5931\u8d25\uff1aAI \u8fd4\u56de\u5185\u5bb9\u4e0d\u7b26\u5408\u7ed3\u6784\u8981\u6c42\uff0c\u8bf7\u91cd\u8bd5\u6216\u51cf\u5c11/\u8c03\u6574\u8f93\u5165\u8d44\u6599\u3002`;
}

async function withMusicAiFailureReason<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isAiObjectContractError(error)) throw error;
    console.warn("[music-task] AI object contract mismatch", {
      label,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw new Error(musicAiContractFailureMessage(label));
  }
}

export async function executeMusicBibleGenerateTask(payload: any, task: any) {
  await updateUnifiedTask(task.id, { status: "processing", phase: "generating-bible", progress: 20 });
  const bible = await withMusicAiFailureReason("\u97f3\u4e50\u5723\u7ecf\u751f\u6210", () => generateMusicBible(payload));
  return {
    bibleId: Number(bible.id),
    version: Number(bible.version),
  };
}

export async function executeMusicBibleReviewTask(payload: any, task: any) {
  await updateUnifiedTask(task.id, { status: "processing", phase: "reviewing-bible", progress: 20 });
  const result = await withMusicAiFailureReason("\u97f3\u4e50\u5723\u7ecf\u5ba1\u67e5", () => reviewMusicBible(payload));
  return {
    bibleId: Number(payload.bibleId),
    suggestionIds: suggestionIds(result),
    issueCount: Number(result?.issues?.length || 0),
  };
}

export async function executeMusicPlanGenerateTask(payload: any, task: any) {
  await updateUnifiedTask(task.id, { status: "processing", phase: "generating-plan", progress: 20 });
  const result = await withMusicAiFailureReason("\u914d\u4e50\u89c4\u5212\u751f\u6210", () => generateMusicPlan(payload));
  return {
    planId: Number(result.plan.id),
    version: Number(result.plan.version),
    cueCount: Number(result.cues?.length || 0),
  };
}

export async function executeMusicPlanReviewTask(payload: any, task: any) {
  await updateUnifiedTask(task.id, { status: "processing", phase: "reviewing-plan", progress: 20 });
  const result = await withMusicAiFailureReason("\u914d\u4e50\u89c4\u5212\u5ba1\u67e5", () => reviewMusicPlan(payload));
  return {
    planId: Number(payload.planId),
    suggestionIds: suggestionIds(result),
    issueCount: Number(result?.issues?.length || 0),
  };
}

export async function executeMusicCueCompilePromptTask(payload: any, task: any) {
  await updateUnifiedTask(task.id, { status: "processing", phase: "compiling-prompt", progress: 20 });
  const result = await withMusicAiFailureReason("\u914d\u4e50\u63d0\u793a\u8bcd\u7f16\u8bd1", () => compileMusicCuePrompt(payload));
  return {
    cueId: Number(payload.cueId),
    model: String(payload.model || ""),
    prompt: result.prompt,
    compiledPromptJson: result,
  };
}

export async function executeMusicCueReviewPromptTask(payload: any, task: any) {
  await updateUnifiedTask(task.id, { status: "processing", phase: "reviewing-prompt", progress: 20 });
  const result = await withMusicAiFailureReason("\u914d\u4e50\u63d0\u793a\u8bcd\u5ba1\u67e5", () => reviewMusicPrompt(payload));
  return {
    cueId: Number(payload.cueId),
    model: String(payload.model || ""),
    suggestionIds: suggestionIds(result),
    issueCount: Number(result?.issues?.length || 0),
  };
}

export async function executeMusicCueGenerateTask(payload: any, task: any) {
  await updateUnifiedTask(task.id, { status: "processing", phase: "generating-audio", progress: 20 });
  const result = await withMusicAiFailureReason("\u914d\u4e50\u97f3\u9891\u751f\u6210", () =>
    generateMusicCueAsset({ ...payload, taskCenterId: Number(task.id) }),
  );
  return {
    musicCueAssetId: Number(result.musicCueAsset?.id),
    assetsId: Number(result.musicCueAsset?.assetsId),
    childAssetId: Number(result.musicCueAsset?.childAssetId),
  };
}

export async function executeProjectContextPackGenerateTask(payload: any, task: any) {
  await updateUnifiedTask(task.id, { status: "processing", phase: "generating-context-pack", progress: 20 });
  const result = await generateProjectContextPack(payload);
  return {
    textAssetId: Number(result.contextPack?.id),
    version: Number(result.contextPack?.version),
    reviewStatus: result.review?.status || "unknown",
  };
}
