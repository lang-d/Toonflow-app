export interface ImageFlowDispatchCandidate {
  businessType?: string | null;
  taskType?: string | null;
  providerTaskId?: string | null;
  projectId?: number | string | null;
}

export interface ImageFlowDispatchContext {
  imageLimit: number;
  providerBacklogCount: number;
  providerBacklogProjectIds: Set<number>;
  runningImageFlowProjectIds: Set<number>;
  runningImageFlowSubmitCount: number;
}

export function shouldDeferImageFlowCandidate(candidate: ImageFlowDispatchCandidate, context: ImageFlowDispatchContext): boolean {
  if (candidate.businessType !== "image-flow" || candidate.taskType !== "image") return false;
  if (candidate.providerTaskId) return false;
  const projectId = Number(candidate.projectId || 0);
  if (context.providerBacklogCount + context.runningImageFlowSubmitCount >= Math.max(1, context.imageLimit)) return true;
  if (projectId && context.providerBacklogProjectIds.has(projectId)) return true;
  if (projectId && context.runningImageFlowProjectIds.has(projectId)) return true;
  return false;
}
