---
name: story_revision_from_annotations
description: Revise a story artifact according to user annotations attached to exact text ranges.
---

# Revision From User Annotations

Use this when the user asks to revise based on annotations.

Rules:
- Treat annotations as precise user intent attached to selected text.
- Apply local annotations only to the relevant passage unless the comment clearly asks for a global change.
- Preserve passages the user marked as good or "keep".
- If annotations conflict, explain the conflict briefly and choose the version that best matches the latest user message.
- Return a complete revised artifact, not a patch fragment, unless the user asks for local rewrite only.
- After generating the revision, call `revise_artifact_with_annotations`.
