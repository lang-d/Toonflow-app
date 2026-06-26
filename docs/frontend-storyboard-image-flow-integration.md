# Frontend Integration: Storyboard Image Flow

## Summary

Storyboard image generation is now unified through `image-flow`. The storyboard list, image canvas, and Agent-triggered generation should share the same backend execution path and status contract.

## Generation Entry

- Use `POST /production/storyboard/batchGenerateImage` for storyboard list single/batch generation.
- Do not load the flow on the frontend just to choose a prompt source.
- The backend will create or ensure the storyboard image flow, pick the primary generated node, and create an `image-flow` task.
- First generation must not show “multiple nodes, please choose prompt source”.

Request stays compatible:

```json
{
  "projectId": 1,
  "scriptId": 5,
  "storyboardIds": [101, 102],
  "compulsory": false
}
```

Response is still an array of storyboard rows. New fields may be present:

```json
{
  "id": 101,
  "prompt": "...",
  "associateAssetsIds": [1, 2],
  "src": null,
  "state": "生成中",
  "status": "processing",
  "taskId": "unified-task-id",
  "unifiedTaskId": "unified-task-id",
  "legacyTaskId": 88,
  "nodeId": "storyboard-generated:...",
  "flowId": 12,
  "reason": ""
}
```

## Task Registration

- New storyboard image tasks should be registered as `flowImage`.
- Use `legacyTaskId` for `/production/editImage/pollImageTask`.
- `storyboardImage` polling is legacy compatibility only.
- Prefer `status` for logic:
  - `pending`
  - `queued`
  - `submitting`
  - `processing`
  - `completed`
  - `failed`
  - `cancelled`
- `state` remains only a legacy display fallback.

## List Edit And Canvas Edit

- List prompt/reference editing is a shortcut for the storyboard’s primary generated node.
- Canvas editing remains the advanced editor.
- Both must treat the backend flow primary node as the shared source for generation.
- The final image displayed in the list is `filePath/src`; it is a result, not the prompt source.

## Agent Update/Replace

- Agent panel writes use backend tool semantics only; no new frontend operation is required.
- `mode: "update"` means normal prompt/reference update.
- `mode: "replace"` means the backend clears the storyboard image result and image-flow exploration, then rebuilds a fresh standard flow.
- Replace does not start generation; the user must confirm generation separately.

## Compatibility Notes

- Existing storyboard rows without flow are valid. The backend creates a flow on first generation.
- Existing flows with multiple generated nodes are valid. If no primary node is marked, the backend chooses the last generated node and marks it primary.
- Frontend should not implement its own primary-node conflict prompt for list generation.
