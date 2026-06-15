# Toonflow Media And Task API Contract

This document is the canonical backend contract for structured media and task results.

## Response Envelope

All API responses use:

```ts
type ApiResponse<T> = {
  code: number;
  data: T;
  message: string;
};
```

## MediaRef

All structured media values must use `MediaRef`.

```ts
type MediaRef = {
  id?: number | string;
  type: "image" | "video" | "audio" | "file";
  path: string;
  url: string;
  previewUrl?: string;
  mime?: string;
  name?: string;
  width?: number;
  height?: number;
  duration?: number;
  source?: "storyboard" | "assets" | "merged" | "local" | "generated";
  sourceId?: number | string;
};
```

Rules:

- `path` is the OSS relative original file path. It has no domain, no `/oss` prefix and no query string.
- `url` is the original file URL for the current API port.
- `previewUrl` is only for UI preview. It must not be used for AI generation.
- Structured API responses must not expose `src`, `filePath`, `displayUrl`, `imageUrl`, `previewImage`, `generatedImage`, `selectedImageUrl`, or `result.url`.
- Markdown or rich-text body content may still contain inline image links because those are document content, not structured API fields.

## Image Flow

`saveImageFlow` request:

```ts
{
  flowId?: number | null;
  projectId: number;
  scriptId: number;
  targetType: "deriveAsset" | "storyboard";
  targetId: number;
  selectedMediaPath?: string;
  nodes: Array<{
    id: string;
    type: string;
    data: {
      media?: MediaRef;
      resultMedia?: MediaRef;
      taskId?: number | null;
      status?: TaskStatus;
      phase?: string;
      reason?: string;
      historyId?: number;
      selectedResult?: unknown;
    };
  }>;
  edges: unknown[];
}
```

`getImageFlow` response returns `selectedMedia`, `nodes[].data.media` and `nodes[].data.resultMedia`.

`generateFlowImageTask` request:

```ts
{
  flowId: number;
  nodeId: string;
  targetType: "deriveAsset" | "storyboard";
  targetId: number;
  projectId: number;
  scriptId: number;
  referenceMediaPaths: string[];
  model: string;
  quality: string;
  ratio: string;
  prompt: string;
}
```

`pollImageTask` response:

```ts
{
  taskId: number;
  nodeId: string;
  status: TaskStatus;
  state: string;
  media?: MediaRef;
  historyId?: number;
  reason?: string;
}
```

## Asset, Storyboard, Workbench And Video

- Asset APIs return `asset.media` and `asset.historyMediaList`.
- Storyboard APIs return `storyboard.media` and `storyboard.referenceMediaList`.
- Workbench references return `reference.media`; merged references return `merged.media`.
- Video APIs return `video.media`; state checks return `media` on completed videos.
- Upload, model test and original-image lookup APIs return `{ media: MediaRef }`.

## Task Result

Task status:

```ts
type TaskStatus =
  | "pending"
  | "queued"
  | "submitting"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";
```

Task result:

```ts
type TaskResult = {
  media?: MediaRef;
  mediaList?: MediaRef[];
  text?: string;
  historyId?: number;
  businessId?: number;
};
```

`task:status`, `/task/status/snapshot` and legacy polling endpoints must use `result.media` or `result.mediaList`; never `result.url`.
