---
modelTechnique: music_suno_v55_prompt_technique.md
requiredGenerationConfig: [title, tags]
---
# Suno V5.5 Prompt Profile

Compile one music-generation request for Suno V5.5 Custom mode. Return the normal structured result with `prompt`, `negativePrompt`, and `generationConfig`.

`prompt` is a compact musical direction, not a plot summary. Describe the musical function, genre, instrumentation, tempo or pulse, emotional/structural arc, vocal delivery when relevant, and ending behavior. Keep it concise and avoid character names, camera language, production instructions, or unsupported timing guarantees.

For `generationConfig` always provide:
- `title`: a short music title, not an episode title or a sentence.
- `tags`: a concise comma-separated English style, motif gesture, main instrument-role, and vocal descriptor string. For instrumental work it is the provider-facing musical input, so it must carry the core audible identity from `prompt`: motif gesture, pulse, main instrument roles, texture, harmonic color, dynamics, and ending behavior where material. Do not place full structural sentences, plot explanation, or pseudo-precise arranging claims in tags.

For instrumental work, do not write lyrics or imply a human utterance. Translate story ideas such as suppression, an unsaid thought, or isolation into audible rhythm, register, texture, dynamics, silence, and cadence. Do not use dialogue, narration, character names, a singer, a voice, whispers, humming, chanting, or a vocal hook as a metaphor. For vocal work, confirmed lyrics are supplied separately; describe vocal delivery and arrangement in `prompt`, but do not repeat the lyrics.

Use `negativePrompt` only for unwanted musical traits. Do not put durationSec, reference audio, loop, clip IDs, continuation parameters, or provider route names in `generationConfig`.

The requested duration is a narrative target only. Make the main musical thought resolve naturally near that point, but never claim that the model can guarantee an exact runtime.
