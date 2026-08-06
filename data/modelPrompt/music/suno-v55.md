---
modelTechnique: music_suno_v55_prompt_technique.md
requiredGenerationConfig: [title, tags]
---
# Suno V5.5 Prompt Profile

Compile one music-generation request for Suno V5.5 Custom mode. Return the normal structured result with `prompt`, `negativePrompt`, and `generationConfig`.

`prompt` is a compact musical direction, not a plot summary. Describe the musical function, genre, instrumentation, tempo or pulse, emotional/structural arc, vocal delivery when relevant, and ending behavior. Keep it concise and avoid character names, camera language, production instructions, or unsupported timing guarantees.

For `generationConfig` always provide:
- `title`: a short music title, not an episode title or a sentence.
- `tags`: a concise comma-separated English style, motif gesture, main instrument-role, and vocal descriptor string. Keep it as concise metadata for the audible identity; do not place full structural sentences, plot explanation, or pseudo-precise arranging claims in tags. Provider field routing is owned by the selected adapter.

For instrumental work, do not write lyrics or imply a human utterance. Translate story ideas such as suppression, an unsaid thought, or isolation into audible rhythm, register, texture, dynamics, silence, and cadence. Do not use dialogue, narration, character names, a singer, a voice, whispers, humming, chanting, or a vocal hook as a metaphor. For vocal work, confirmed lyrics are supplied separately; describe vocal delivery and arrangement in `prompt`, but do not repeat the lyrics.

Before returning, remove redundant wording while preserving the core audible identity: compress duplicate instruments, adjacent mood words, and repeated structural claims rather than omitting the motif, pulse, primary roles, or ending behavior. Follow the selected adapter's declared request contract when one is available; do not invent numeric limits.

Use `negativePrompt` only for unwanted musical traits. Do not put durationSec, reference audio, loop, clip IDs, continuation parameters, or provider route names in `generationConfig`.

When the music brief includes an approximate duration, it may be expressed naturally in `prompt` as part of the musical form, pacing, or ending behavior. Never promise that the model can guarantee an exact runtime.
