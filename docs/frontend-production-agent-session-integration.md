# Production Agent Session Integration

## Purpose

Production Agent runs are backend-owned. A browser route, page component, or Socket.IO connection is only an observer. Leaving a menu must never stop a running Agent or an image task.

This document defines the frontend contract for the future `Toonflow-web` change. This backend change does not modify the frontend repository.

## Session Scope

Store every Agent session by a stable scope key. Do not keep one mutable Agent instance whose `projectId`, `scriptId`, or mode is overwritten when the user changes pages.

| Agent | Scope | Isolation key |
| --- | --- | --- |
| Production | project + episode | `${projectId}:productionAgent:${scriptId}` |
| Music project | project | `musicProjectIsolationKey(projectId)` |
| Music episode | project + episode | `musicEpisodeIsolationKey(projectId, scriptId)` |
| Other agents | project + optional episode + agent key | `{projectId, scriptId?, agentKey}` |

The frontend must retain a session per scope in a persistent store. Different projects, episodes, and Agent menus must never share chat history, active run state, abort controls, auth context, or Socket.IO managers.

## Socket Lifecycle

`useChat` should expose an isolated connection option. When it creates a Socket.IO client for an Agent session, use:

```ts
io(url, {
  auth,
  transports: ["websocket", "polling"],
  reconnection: true,
  forceNew: true,
  multiplex: false,
});
```

Route unmount, tab/menu switching, and changing the visible episode must not call `disconnect()`, `stop()`, or clear the scoped session. Only project switch, logout, explicit user close, or application shutdown may dispose a session.

`stop` is an explicit user command. It is the only normal UI operation that may cancel a running Agent.

## Recovery Flow

On page activation and Socket reconnect, perform the following for the visible scope:

1. Query the Agent Run status endpoint.
2. Load chat history for the same isolation key.
3. Refresh production assets, storyboard data, and task-center state from their business APIs.
4. Render the returned run status. Do not resend the prior user message or start another chat when the status is `running`.

`agent:run:update` is an optional live hint. `o_agentRun` status and business APIs are the source of truth. A completed run may have streamed messages while the page was absent; recovery must work without those Socket events.

The backend now records `client_detached` and `client_resumed` events in run detail. These events are diagnostic only and must not be displayed as a failure.

## Explicit Terminal Status

`completed` means the model explicitly declared the end of its turn. A stream that ends without a terminal declaration is returned as `failed` with `errorJson.code === "AGENT_TERMINAL_DECLARATION_MISSING"`. The frontend should show the existing failure state, refresh run detail and business facts, and let the user retry explicitly. It must not infer a completed production action or automatically resend the message.

Run detail can include `model_stream_finished` with only finish reason, step count, tool-call count, and text length. It can also include `terminal_declaration_missing`. Both are diagnostics, not chat messages or workflow instructions.

## Production Tool Results

Production Agent creates and updates derived assets in the backend. It also submits derived-asset image tasks and storyboard-image tasks directly to the unified task center.

The frontend must not ACK `addDeriveAsset`, `delDeriveAsset`, `generateDeriveAsset`, or `generateStoryboard` as a condition for Agent success. Existing handlers may keep updating the currently visible local view, but they are only optimizations.

Use tool results, refreshed business data, and task-center task IDs to show progress. A page that was not visible when a task was submitted must obtain its state through the task center after it returns.

## Acceptance Scenarios

- Start Production Agent for episode 3, switch to Music Director, then return: the original run remains `running` or reaches its real terminal status; it must not be marked interrupted because of Socket disconnect.
- Start an image generation from Production Agent, leave the page, and return: the unified task exists and continues independently of the old Socket.
- Open Production Agent for episode 3 and episode 4, then Music Director: each view retains its own scoped session and no connection lifecycle action affects the others.
- Reconnect after a temporary network interruption: reload run status, history, production data, and task data; do not replay the original chat request.
