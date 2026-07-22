# Production Agent Flow State and Data Tools

## Purpose

Production Agent state is split into three independent layers:

- Run lifecycle: controlled by the backend (`running`, `awaiting_user`, `completed`, `failed`, `cancelled`, `interrupted`).
- Business progress: reported by the model through `update_agent_progress`.
- Production facts: read by the model through scoped read-only tools.

The backend must not infer user intent from keywords, old review suggestions, or the latest `awaiting_user` run. Memory is only conversational context; storyboard versions, director-plan versions, review reports, and long text must be read through tools.

## Model Tools

`update_agent_progress({ stage, subAgent, title, detail?, phase? })`

Records business progress for panel recovery. It updates the current run stage/sub-agent and emits an `agent_progress` timeline event. It never finishes a run and never writes production facts.

Read-only fact tools:

- `list_storyboard_generations`
- `read_storyboard_generation`
- `list_production_reviews`
- `read_production_review`
- `read_text_asset`
- `list_director_plan_generations`
- `read_director_plan_generation`

Termination tool:

- `await_user_decision`

This is the only model-facing tool that intentionally moves the lifecycle to `awaiting_user`. It records the model's natural-language question/context; it does not encode backend repair policy.

## Review Handling

Storyboard-table review still runs automatically after a successful storyboard-table commit. The review agent must:

1. Read the current facts.
2. Save the audit record with `record_storyboard_table_review`.
3. Produce a text report.
4. Call `await_user_decision` when the next step requires user choice.

The backend may keep historical `o_productionReviewSuggestion` rows for compatibility, but `suggestionIds` and `suggestionCount` are no longer used as Agent continuation or repair instructions. The authoritative review body for model reasoning is the archived text report.

## Frontend Recovery

Frontend recovery should combine:

- Memory for chat messages.
- `/agent/run/detail.timeline` for process facts.
- `agent_progress` events for the current business progress label.
- `agent_output_archived` events or full-text asset metadata for expandable long process output/transcripts. These assets are not formal review conclusions.

Do not mix timeline items into chat order. Do not infer repair intent from `awaiting_user`, `suggestionCount`, button labels, or keywords. The next user input remains natural language and is interpreted by the Agent after it reads the relevant facts.
