# Production Agent Run Status Frontend Integration

## Summary

Production Agent now has a backend-authoritative run lifecycle. The frontend should not infer a full chat/run status from message completion, commit payloads, or chunk inactivity.

One `chat` event equals one backend `runId`.

Session scope:

```text
projectId + scriptId + agentKey
```

For the first version, `agentKey` is `productionAgent`.

## Status Contract

`status` is the only lifecycle status field for Agent Run:

```text
running
awaiting_user
completed
failed
cancelled
interrupted
```

Meanings:

- `running`: backend is still executing this chat.
- `awaiting_user`: backend stopped safely and needs user confirmation, selection, or review handling.
- `completed`: backend finished this chat and no user action is required.
- `failed`: backend/model/tool failed.
- `cancelled`: user stopped the run.
- `interrupted`: socket disconnect, backend restart, or heartbeat expiry interrupted the run.

Only `running` blocks a new chat in the same session. All other statuses are terminal.

## Socket Event

The backend emits:

```text
agent:run:update
```

Payload shape:

```json
{
  "agentKey": "productionAgent",
  "projectId": 1,
  "scriptId": 21,
  "serverTime": 1730000000000,
  "status": "running",
  "run": {
    "runId": "uuid",
    "status": "running",
    "currentStage": "storyboardTable",
    "currentSubAgent": "storyboardTableAgent",
    "reason": null
  }
}
```

If a new chat is rejected because the same session already has a running run:

```json
{
  "status": "running",
  "rejected": true,
  "activeRun": {
    "runId": "uuid",
    "status": "running"
  },
  "reason": "同一剧集 Production Agent 已有运行中的 chat，请等待完成或手动停止后再提交。"
}
```

Socket events are notifications only. The backend database is the source of truth.

## Query APIs

Restore status after refresh, reconnect, tab/menu switch, or episode switch:

```http
POST /api/agent/run/status
```

Request:

```json
{
  "agentKey": "productionAgent",
  "projectId": 1,
  "scriptId": 21
}
```

Response data:

```json
{
  "serverTime": 1730000000000,
  "activeRun": null,
  "latestRun": {
    "runId": "uuid",
    "status": "awaiting_user",
    "currentStage": "supervision",
    "currentSubAgent": "supervisionAgent",
    "reason": "分镜表审阅存在待处理建议"
  }
}
```

Run detail:

```http
POST /api/agent/run/detail
```

Request:

```json
{
  "runId": "uuid"
}
```

Response data:

```json
{
  "run": {},
  "events": []
}
```

## Frontend Rules

- Do not set the whole chat/session to idle when an assistant message becomes `complete`.
- Do not set the whole chat/session to idle when `commit_storyboard_table` or director-plan commit payload arrives.
- Commit payloads should only refresh business data, such as storyboard table, director plan, review suggestions, or flow data.
- On entering a Production Agent page, call `/api/agent/run/status`.
- On socket reconnect, call `/api/agent/run/status`.
- On episode switch, call `/api/agent/run/status` for the target `scriptId`.
- If `activeRun.status === "running"`, disable or block a second chat submission for that same session.
- If `latestRun.status === "awaiting_user"`, show the user-facing reason and let the user decide the next action.

