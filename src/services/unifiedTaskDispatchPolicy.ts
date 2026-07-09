export interface ImageFlowDispatchCandidate {
  businessType?: string | null;
  taskType?: string | null;
  handler?: string | null;
  providerTaskId?: string | null;
}

export interface ImageFlowDispatchContext {
  imageLimit: number;
  occupiedImageCount: number;
}

export function isImageGenerationTask(candidate: ImageFlowDispatchCandidate): boolean {
  return ["image-flow", "asset-image", "storyboard-image"].includes(String(candidate.handler || ""));
}

export function shouldDeferImageFlowCandidate(candidate: ImageFlowDispatchCandidate, context: ImageFlowDispatchContext): boolean {
  if (!isImageGenerationTask(candidate)) return false;
  if (candidate.handler === "image-flow" && candidate.providerTaskId) return false;
  return context.occupiedImageCount >= Math.max(1, context.imageLimit);
}
