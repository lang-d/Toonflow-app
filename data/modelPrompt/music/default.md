# Default Music Model Prompt Profile

Use this profile when no vendor-specific music prompt profile is bound.

Preferred format:
- concise natural language with short labeled sections
- English prompt by default unless the user explicitly asks for another language
- one clear musical idea per cue

Recommended sections:
- Duration
- Mood arc
- Instrumentation
- Structure
- Vocal or lyrics
- Avoid

Length:
- 80-220 words is usually enough
- avoid full plot summaries

Negative prompt:
- use a separate negativePrompt field when the API supports it
- otherwise append a short "Avoid:" sentence

Generation config:
- include durationSec when known
- include outputFormat only when requested or supported
- keep provider-specific fields in generationConfig, not in the prose prompt
