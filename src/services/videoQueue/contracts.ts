import type { QueuedWorkbenchReference } from "@/services/workbenchReference";

export type VideoQueueStatus = "queued" | "submitting" | "confirming" | "processing" | "completed" | "failed" | "cancelled";
export type VideoOutputType = "file" | "url" | "base64";

export interface VideoQueueRow {
  id: number;
  videoId: number;
  projectId: number;
  scriptId: number;
  model: string;
  vendorId: string;
  taskCenterId?: number | null;
  requestJson: string;
  submitId?: string | null;
  officialTaskId?: string | null;
  historyRecordId?: string | null;
  providerAccountId?: string | null;
  providerModelKey?: string | null;
  providerCapacityKey?: string | null;
  providerSubmittedAt?: number | null;
  remoteConfirmedAt?: number | null;
  phase?: string | null;
  status: VideoQueueStatus;
  state?: string | null;
  errorReason?: string | null;
  rawOutput?: string | null;
  nextPollTime?: number | null;
  nextSubmitTime?: number | null;
  pollCount?: number | null;
  submitAttemptCount?: number | null;
  capacityWaitStartedAt?: number | null;
  confirmStartedAt?: number | null;
  lastProviderStatus?: string | null;
  lastProviderCode?: string | null;
  providerQueueStatus?: number | null;
  providerQueueIndex?: number | null;
  providerQueueLength?: number | null;
  startTime: number;
  updateTime?: number | null;
  finishTime?: number | null;
}

export interface StoredVideoRequest {
  version: 2;
  videoPath: string;
  input: {
    prompt: string;
    mode: unknown;
    duration: number;
    aspectRatio: `${number}:${number}`;
    resolution: string;
    audio?: boolean;
    promptProfile?: {
      model: string;
      modelId: string | null;
      videoPromptType: string | null;
      systemPromptSource?: string | null;
    };
  };
  references: QueuedWorkbenchReference[];
  relatedObjects: Record<string, any>;
  legacyReferences?: Array<{ type: "image" | "video" | "audio"; filePath: string }>;
}

export interface ResolvedVideoReference {
  type: "image" | "video" | "audio";
  filePath: string;
}

export interface VideoProviderContext {
  row: VideoQueueRow;
  task: any;
  request: StoredVideoRequest;
  modelName: string;
  modelConfig: any;
  references(): Promise<ResolvedVideoReference[]>;
}

export interface VideoCapacityCandidate {
  key: string;
  limit: number;
  providerAccountId?: string | null;
  metadata?: Record<string, unknown>;
}

export type VideoReservationResult =
  | { kind: "ready"; candidates: VideoCapacityCandidate[] }
  | { kind: "wait"; phase: string; reason: string; retryAt: number; diagnostic?: string }
  | { kind: "failed"; reason: string; diagnostic?: string };

export interface VideoProviderPatch {
  providerAccountId?: string | null;
  providerModelKey?: string | null;
  providerCapacityKey?: string | null;
  officialTaskId?: string | null;
  historyRecordId?: string | null;
  remoteConfirmedAt?: number | null;
  lastProviderStatus?: string | null;
  lastProviderCode?: string | null;
  providerQueueStatus?: number | null;
  providerQueueIndex?: number | null;
  providerQueueLength?: number | null;
}

export type VideoExecutionOutcome =
  | {
      kind: "wait";
      phase: string;
      reason: string;
      retryAt: number;
      diagnostic?: string;
      patch?: VideoProviderPatch;
    }
  | {
      kind: "accepted";
      providerTaskId: string;
      phase: "confirming" | "processing";
      retryAt: number;
      diagnostic?: string;
      patch?: VideoProviderPatch;
      progress?: number | null;
    }
  | {
      kind: "pending";
      phase: string;
      retryAt: number;
      reason?: string;
      diagnostic?: string;
      patch?: VideoProviderPatch;
      progress?: number | null;
    }
  | {
      kind: "completed";
      data: string;
      dataType: VideoOutputType;
      /** Additional finished candidates returned by one provider task. */
      additionalOutputs?: Array<{ data: string; dataType: VideoOutputType }>;
      diagnostic?: string;
    }
  | { kind: "failed"; reason: string; diagnostic?: string };

export interface VideoProviderExecutor {
  readonly vendorId: string;
  getProviderModelKey(modelName: string): string;
  reserveSubmission(context: VideoProviderContext): Promise<VideoReservationResult>;
  submit(context: VideoProviderContext, reservation: VideoCapacityCandidate): Promise<VideoExecutionOutcome>;
  poll(context: VideoProviderContext): Promise<VideoExecutionOutcome>;
  release?(context: VideoProviderContext): Promise<void>;
}
