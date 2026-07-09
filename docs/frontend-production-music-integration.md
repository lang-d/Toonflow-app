# Frontend Production Music Integration

This document describes the frontend contract for the independent music scoring stage.

The backend route prefix is `/api`. All endpoints below are `POST`.

## Product Boundary

The music stage is independent from director planning.

Director planning may be shown as reference for:
- visual pacing
- scene boundary
- emotional movement

It should not be treated as the authority for music style, motifs, instrumentation, or cue design.

The first frontend version should support:
- music bible generation and review
- music plan / cue sheet generation and review
- cue list
- cue prompt compilation
- cue prompt review
- AI music generation
- audio asset version selection

The backend does not evaluate generated audio quality. Review only covers planning and prompts. After generation, frontend only needs to show engineering state: file/asset exists, selected version, failed state, and `errorReason`.

## Async Result Model

All AI-backed music endpoints are asynchronous. The immediate response is a task envelope, not the final business object.

Task envelope:

```json
{
  "taskId": "7bf09d7d-3a8c-4d1f-a3fb-2f6a76b5c5d2",
  "legacyTaskId": 123,
  "status": "queued",
  "targetType": "musicPlan",
  "targetId": 10
}
```

Frontend flow:
- call the action endpoint and store `taskId`
- poll the existing task center until `completed` or `failed`
- read `o_tasks.resultJson` only as a lightweight index
- fetch final data from the business query endpoint

Do not use task `resultJson` as long-term state. It may contain IDs, counts, and short prompt compilation data only.

Existing task APIs:
- `POST /api/task/getTaskApi`
- `POST /api/task/taskDetails`
- `POST /api/task/status/snapshot`

Compatibility note: `taskId` is the only task-center polling key for new music endpoints. `legacyTaskId` is returned only as a backend compatibility/debug identifier for `o_tasks.id`.

Business query endpoints:
- stage state: `POST /api/production/music/stage/state`
- bible: `POST /api/production/music/bible/list`, `POST /api/production/music/bible/detail`
- plan: `POST /api/production/music/plan/list`, `POST /api/production/music/plan/detail`
- cues/assets: `POST /api/production/music/cue/list`
- context pack: `GET /api/project/contextPack/get?projectId=...`
- text content: `POST /api/textAsset/getContent`

## Music Production Agent

Socket namespace:

```text
/api/socket/musicProductionAgent
```

Agent key:

```text
musicProductionAgent
```

This socket is isolated from `/api/socket/productionAgent`. It is for scoring discussion and music task creation only. It must not be wired to productionAgent tools or production workbench writes.

Connection auth fields:

```json
{
  "token": "Bearer ...",
  "projectId": 1781970050416,
  "mode": "episode",
  "scriptId": 27,
  "isolationKey": "musicProductionAgent:1781970050416:episode:27"
}
```

`isolationKey` may be omitted; backend will derive it. If provided, it must match:

- project/concept: `musicProductionAgent:{projectId}:project`
- episode: `musicProductionAgent:{projectId}:episode:{scriptId}`

Socket events:

- `chat`: `{ "content": "..." }`
- `updateContext`: `{ "projectId": 1, "mode": "episode", "scriptId": 2, "isolationKey": "..." }`
- `updateThinkConfig`: existing shape
- `stop`: abort current agent turn

Agent-created long work returns a normal task envelope containing only `taskId` as the frontend polling key. Task socket events are notifications; after completion, refresh the business query endpoints below.

## Stage State

Frontend should call this when entering or refreshing the music page:

```http
POST /api/production/music/stage/state
```

Project/concept request:

```json
{
  "projectId": 1781970050416,
  "mode": "project"
}
```

Episode request:

```json
{
  "projectId": 1781970050416,
  "scriptId": 27,
  "mode": "episode"
}
```

Response includes:

```json
{
  "stage": "plan_generating",
  "mode": "episode",
  "projectId": 1781970050416,
  "scriptId": 27,
  "isolationKey": "musicProductionAgent:1781970050416:episode:27",
  "projectMemoryKey": "musicProductionAgent:1781970050416:project",
  "episodeMemoryKey": "musicProductionAgent:1781970050416:episode:27",
  "latestBible": {},
  "latestPlan": {},
  "cueCount": 8,
  "assetCount": 2,
  "activeTasks": []
}
```

Stage values:

```ts
type MusicStage =
  | "idle"
  | "discussing"
  | "bible_generating"
  | "bible_reviewing"
  | "plan_generating"
  | "plan_reviewing"
  | "cue_prompting"
  | "audio_generating"
  | "completed"
  | "failed";
```

## Suggested Page Structure

Recommended production tab:

```text
Music Director
+-- Music Bible
|   +-- Generate / Regenerate
|   +-- Version label
|   +-- Review issues
|   +-- Style profile preview
+-- Music Plan
|   +-- Mode: concept | project | episode
|   +-- Generate plan
|   +-- Review issues
|   +-- Cue sheet table
+-- Cue Assets
    +-- Compile prompt
    +-- Review prompt
    +-- Generate audio
    +-- Version list
    +-- Select version
```

Mode guidance:
- `concept`: early research / overall direction before normal production is complete.
- `project`: full film / non-serialized project-level plan.
- `episode`: serialized single-episode rolling production. Use `scriptId`.

## Model Selection

Use existing model list endpoint with the new `music` type:

```http
POST /api/modelSelect/getModelList
```

Request:

```json
{
  "type": "music"
}
```

Response items follow existing model list shape:

```json
{
  "id": "vendorId",
  "label": "Music Model Display Name",
  "value": "model-name",
  "type": "music",
  "name": "Vendor Display Name"
}
```

When calling music cue endpoints, send model as:

```ts
`${vendorId}:${value}`
```

Example:

```json
{
  "model": "musicVendor:music-model-v1"
}
```

## 1. Generate Music Bible

```http
POST /api/production/music/bible/generate
```

Request:

```json
{
  "projectId": 1781970050416,
  "instruction": "Optional user direction, e.g. focus on restrained suspense and recurring character motifs."
}
```

Immediate response:

```json
{
  "taskId": "uuid",
  "legacyTaskId": 123,
  "status": "queued",
  "targetType": "musicBible",
  "targetId": null
}
```

On task completion, `resultJson`:

```json
{
  "bibleId": 1,
  "version": 1
}
```

Frontend notes:
- Treat every generation as a new version.
- Do not overwrite previous bible content client-side.
- Parse `styleProfileJson` defensively; fallback to `{}`.
- After task completion, call `POST /api/production/music/bible/detail` with `bibleId`, or refresh `bible/list`.

## 2. Review Music Bible

```http
POST /api/production/music/bible/review
```

Request:

```json
{
  "projectId": 1781970050416,
  "bibleId": 1
}
```

Immediate response:

```json
{
  "taskId": "uuid",
  "legacyTaskId": 124,
  "status": "queued",
  "targetType": "musicBible",
  "targetId": 1
}
```

On task completion, `resultJson`:

```json
{
  "bibleId": 1,
  "suggestionIds": [100],
  "issueCount": 1
}
```

Review suggestions are also available through the existing production review list flow with `targetType=musicBible`.

## 3. Generate Music Plan

```http
POST /api/production/music/plan/generate
```

Request for non-serialized / full project:

```json
{
  "projectId": 1781970050416,
  "mode": "project",
  "bibleId": 1,
  "instruction": "Optional user direction."
}
```

Request for serialized episode:

```json
{
  "projectId": 1781970050416,
  "scriptId": 27,
  "mode": "episode",
  "bibleId": 1,
  "instruction": "Score this episode while preserving project motifs."
}
```

Request for concept mode:

```json
{
  "projectId": 1781970050416,
  "mode": "concept",
  "bibleId": 1
}
```

Immediate response:

```json
{
  "taskId": "uuid",
  "legacyTaskId": 125,
  "status": "queued",
  "targetType": "musicPlan",
  "targetId": null
}
```

On task completion, `resultJson`:

```json
{
  "planId": 10,
  "version": 1,
  "cueCount": 8
}
```

Frontend notes:
- Cue splitting is musical, not one cue per storyboard.
- `cueType` is free text so future skills can add types without frontend release. Known values may include `opening_theme`, `ending_theme`, `insert_song`, `bgm`, `stinger`, `ambient`, `source_music`, `silence`.
- Parse `cueSheetJson`, `startRefJson`, `endRefJson`, and `musicSpecJson` defensively.
- After task completion, call `POST /api/production/music/plan/detail` with `includeCues=true`, or refresh `cue/list`.

## 4. Review Music Plan

```http
POST /api/production/music/plan/review
```

Request:

```json
{
  "projectId": 1781970050416,
  "planId": 10
}
```

Immediate response:

```json
{
  "taskId": "uuid",
  "legacyTaskId": 126,
  "status": "queued",
  "targetType": "musicPlan",
  "targetId": 10
}
```

On task completion, `resultJson`:

```json
{
  "planId": 10,
  "suggestionIds": [101],
  "issueCount": 1
}
```

Review suggestions use `targetType=musicPlan`.

## 5. List Cues

```http
POST /api/production/music/cue/list
```

Request:

```json
{
  "projectId": 1781970050416,
  "scriptId": 27,
  "planId": 10
}
```

`scriptId` and `planId` are optional filters.

Response:

```json
{
  "cues": [
    {
      "id": 101,
      "projectId": 1781970050416,
      "scriptId": 27,
      "planId": 10,
      "cueKey": "E01-CUE-01",
      "cueType": "bgm",
      "title": "Opening unease",
      "durationSec": 45,
      "state": "ready",
      "startRef": {},
      "endRef": {},
      "musicSpec": {},
      "assets": [
        {
          "id": 5001,
          "cueId": 101,
          "version": 1,
          "assetsId": 3001,
          "childAssetId": 3002,
          "prompt": "...",
          "compiledPromptJson": "{}",
          "model": "musicVendor:music-model-v1",
          "state": "complete",
          "errorReason": null,
          "selected": 1
        }
      ]
    }
  ]
}
```

Frontend cue table columns:
- cue key
- type
- title
- duration
- state
- selected asset version
- generation state
- review status

## 6. Compile Cue Prompt

```http
POST /api/production/music/cue/compilePrompt
```

Request:

```json
{
  "projectId": 1781970050416,
  "cueId": 101,
  "model": "musicVendor:music-model-v1",
  "instruction": "Optional user adjustment for this prompt."
}
```

Immediate response:

```json
{
  "taskId": "uuid",
  "legacyTaskId": 127,
  "status": "queued",
  "targetType": "musicPrompt",
  "targetId": 101
}
```

On task completion, `resultJson`:

```json
{
  "cueId": 101,
  "model": "musicVendor:music-model-v1",
  "prompt": "Duration: 45 seconds...",
  "compiledPromptJson": {
    "prompt": "Duration: 45 seconds...",
    "negativePrompt": "Avoid...",
    "generationConfig": {
      "durationSec": 45,
      "outputFormat": "mp3"
    },
    "promptNotes": "...",
    "profileSource": "data/modelPrompt/music/default.md",
    "compilerSkillSource": "data/skills/music_prompt_compiler_technique.md"
  }
}
```

Frontend notes:
- This does not save an asset.
- Show `profileSource` in debug/dev UI if useful.
- Prompt format depends on the target model profile. Do not assume every model returns identical prompt style.
- Let users edit the prompt before generation if the UI supports manual override. Current backend generation recompiles internally from cue/model/instruction, so a future endpoint is needed if frontend must generate from a manually edited prompt exactly.

## 7. Review Cue Prompt

```http
POST /api/production/music/cue/reviewPrompt
```

Request:

```json
{
  "projectId": 1781970050416,
  "cueId": 101,
  "model": "musicVendor:music-model-v1",
  "prompt": "Duration: 45 seconds...",
  "compiledPromptJson": {
    "negativePrompt": "Avoid...",
    "generationConfig": {
      "durationSec": 45
    }
  }
}
```

Immediate response:

```json
{
  "taskId": "uuid",
  "legacyTaskId": 128,
  "status": "queued",
  "targetType": "musicPrompt",
  "targetId": 101
}
```

On task completion, `resultJson`:

```json
{
  "cueId": 101,
  "model": "musicVendor:music-model-v1",
  "suggestionIds": [102],
  "issueCount": 1
}
```

Review suggestions use `targetType=musicPrompt`.

## 8. Generate Cue Audio

```http
POST /api/production/music/cue/generate
```

Request:

```json
{
  "projectId": 1781970050416,
  "cueId": 101,
  "model": "musicVendor:music-model-v1",
  "instruction": "Optional generation adjustment.",
  "select": true
}
```

Immediate response:

```json
{
  "taskId": "uuid",
  "legacyTaskId": 129,
  "status": "queued",
  "targetType": "musicCueAsset",
  "targetId": 101
}
```

On task completion, `resultJson`:

```json
{
  "musicCueAssetId": 5001,
  "assetsId": 3001,
  "childAssetId": 3002
}
```

Failure behavior:
- Parameter validation errors return `400` before creating a task.
- Generation errors are recorded on the task as `failed`.
- Backend also writes an `o_musicCueAsset` row with:
  - `state: "failed"`
  - `errorReason`
  - `prompt`
  - `compiledPromptJson`
  - `model`
  - incremented `version`

Frontend should refresh cue list after task completion or failure to display the new version.

Important:
- Do not run audio-quality review.
- Do not call AI to listen to generated audio.
- Use existing audio asset preview/player behavior through refreshed cue/asset data.

## 9. Select Cue Asset Version

```http
POST /api/production/music/cue/selectAsset
```

Request:

```json
{
  "projectId": 1781970050416,
  "cueId": 101,
  "musicCueAssetId": 5001
}
```

Response:

```json
{
  "musicCueAsset": {
    "id": 5001,
    "cueId": 101,
    "version": 1,
    "state": "complete",
    "selected": 1
  }
}
```

Rules:
- Only `state="complete"` assets can be selected.
- Selecting one version clears `selected` on other versions for the same cue.
- Old versions remain in history.

## 10. Bible And Plan Queries

Bible list:

```http
POST /api/production/music/bible/list
```

```json
{
  "projectId": 1781970050416,
  "state": "complete"
}
```

Bible detail:

```http
POST /api/production/music/bible/detail
```

```json
{
  "projectId": 1781970050416,
  "bibleId": 1
}
```

Plan list:

```http
POST /api/production/music/plan/list
```

```json
{
  "projectId": 1781970050416,
  "scriptId": 27,
  "mode": "episode",
  "state": "complete"
}
```

Plan detail:

```http
POST /api/production/music/plan/detail
```

```json
{
  "projectId": 1781970050416,
  "planId": 10,
  "includeCues": true
}
```

## Project Context Pack Async Generation

The project context pack generation endpoint is also asynchronous:

```http
POST /api/project/contextPack/generate
```

Immediate response:

```json
{
  "taskId": "uuid",
  "legacyTaskId": 130,
  "status": "queued",
  "targetType": "projectContextPack",
  "targetId": "project"
}
```

On task completion, `resultJson`:

```json
{
  "textAssetId": 88,
  "version": 3,
  "reviewStatus": "passed"
}
```

Final content is saved as a text asset. After completion:
- call `GET /api/project/contextPack/get?projectId=...` to get the latest context pack
- or call `POST /api/textAsset/getContent` with `id=textAssetId` to read a specific version

## Review Integration

The existing production review list can include:

```ts
type MusicReviewTargetType =
  | "musicBible"
  | "musicPlan"
  | "musicCue"
  | "musicPrompt";
```

Recommended display:
- `blocking`: red badge, require regenerate/revise before generation.
- `warning`: yellow badge, allow user override.
- `info`: neutral note.

Current backend review endpoints create suggestions but do not auto-apply fixes to music records. Treat suggestions as guidance.

## State Model

Music bible:
- `complete`

Music plan:
- `complete`

Music cue:
- `ready`

Music cue asset:
- `generating`
- `complete`
- `failed`

Frontend loading pattern:
1. Disable generate button while request is in flight.
2. Poll the task center until completed or failed.
3. On completion, read `resultJson` as IDs only, then refresh the business query endpoint.
4. On failure, show toast and refresh cue list for audio generation, because a failed asset version may have been persisted.

## Recommended User Flow

Project / non-serialized:

```text
Generate Bible
-> Review Bible
-> Generate Plan with mode=project
-> Review Plan
-> List Cues
-> Compile Prompt per cue
-> Review Prompt
-> Generate Audio
-> Select Asset Version
```

Serialized episode:

```text
Generate or reuse project Bible
-> Generate Plan with mode=episode and scriptId
-> Review Plan
-> Generate selected cue audio
-> Later episodes reuse latest Bible and create new episode plans
```

Concept / early stage:

```text
Generate Bible
-> Generate Plan with mode=concept
-> Use cues as research / style exploration
```

## Things Frontend Should Not Do

- Do not send full project material to music model endpoints.
- Do not split cues mechanically by storyboard row.
- Do not infer music style from project genre with frontend keyword rules.
- Do not assume director plan music text is authoritative.
- Do not evaluate generated audio quality.
- Do not overwrite old versions client-side.

## Open Follow-ups

These are not required for the first integration, but likely useful:
- manual cue edit endpoint
- generate from manually edited compiled prompt
- batch cue generation
