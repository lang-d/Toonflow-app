# Novel Event Extraction Frontend Handoff

## Source of truth

Novel event extraction is a unified task flow. A task contains at most five chapter IDs and uses:

- `handler: "novel-event"`
- `targetType: "novelEventExtraction"`
- `taskType: "prompt"`

Read current work from `POST /task/status/snapshot` or the existing task-center subscription. Read chapter facts from `POST /novel/getNovel`; task events are only progress signals and do not replace persisted chapter data.

## Route responses

`POST /novel/addNovel` and `POST /novel/event/generateEvents` return `data.eventExtraction` or `data` with:

- `tasks[]`: `novelIds`, `taskId`, `legacyTaskId`, `status`, `targetType`, `targetId`
- `skipped[]`: chapters already covered by an active task

`POST /novel/getNovel` adds the following fields for a chapter covered by an active task:

```ts
{
  taskId: string;
  legacyTaskId: number;
  eventExtraction: {
    status: "pending" | "queued" | "submitting" | "processing";
    taskId: string;
    legacyTaskId: number;
    phase: string;
    progress: number;
    reason: string;
  };
}
```

`eventExtraction` is `null` when the chapter has no active unified task.

## UI behavior

- Bind every chapter in a group to the same task ID. Do not create one client task per chapter.
- While the group is active, display `eventExtraction.phase` and `eventExtraction.progress` as shared progress.
- When the task is terminal, reload `/novel/getNovel`. Use each row's persisted `eventState`, `event`, and `errorReason` as the final result: a failed group can still contain completed chapters.
- Keep the legacy `/novel/getNovelEventState` polling path only for historical rows where `eventState === 0` and no `taskId` exists. New requests must use unified task IDs.
- The legacy `src/views/novel/components/eventAnalysis.vue` directly calls a removed streaming endpoint. It should be removed in a later frontend-only change and must not be used as a fallback.
