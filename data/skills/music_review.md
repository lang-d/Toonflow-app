# Music Review Rules

Review planning, lyrics, and exact saved prompt versions. Do not judge generated audio taste.

Music Bible:
- coherent scoring thesis, reusable identities, transformation logic, silence strategy, palette, vocal policy, and avoid list
- no generic keyword pile or automatic song inventory

Project plan:
- works have distinct narrative responsibilities
- editions correspond to real narrative phases and do not multiply speculatively
- work, edition, generated take, and trimmed derivative are not confused
- no episode cue records

Episode plan:
- semantic segments rather than shot-by-shot splitting
- sensible music density and active silence
- adjacent same-function passages merge or reuse
- every segment chooses reuse, new, or silence
- semantic anchors and estimated durations do not claim final timecodes

Lyrics:
- consistent voice and point of view, singable phrase length, memorable but non-mechanical repetition, clear section function, controlled plot disclosure, and language fit
- AI text remains draft until user confirmation

Prompt:
- review the exact promptVersionId used for generation
- model-specific prompts follow their target model format and dynamic duration/vocal/lyrics capabilities; approximate duration may be part of the Prompt, while provider timing metadata is not itself a model-authored config field
- generic prompts are checked for complete portable musical intent and must not claim provider-only flags
- concise, audible, structurally coherent, and free of plot/camera prose
- check the full field contract: prompt direction, tags as a compact style index, negativePrompt as audible avoid traits, and title as a take name
- flag a decorative instrument pile when a named instrument or part has no distinct audible role; roles must resolve to motif carrier, rhythmic/low foundation, harmonic support, spatial texture, or transition
- flag conflicting role assignments when parts are asked to do the same job without an audible contrast or hierarchy
- flag an abstract emotion pile when the prompt does not turn it into a recognizable motif gesture, pulse, register, texture, dynamic movement, rest, or cadence
- flag a prompt that lacks an audible entry and close relationship; it may describe establishment and development or turn, and may use an approximate duration when supplied by the brief, but must not claim note names, chord charts, bar counts, exact timecodes, or mechanically guaranteed duration
- for instrumental work, any dialogue, narration, character reference, voice, singing, humming, chanting, choir, lyrics, or verse/chorus structure in the prompt, tags, or negative prompt is a blocking mode conflict; identify the field and require an audible musical replacement instead
- for vocal work, require one confirmed lyrics version and reject lyric copies, paraphrases, or story prose in the other generation fields
- unreviewed and blocking versions cannot generate; warning requires explicit user acknowledgement

Review output contains only actual issues, their severity, the affected field, the reason, and the required correction. Every blocking issue must include a non-empty reason and required correction. Do not reproduce the full prompt, write a replacement prompt, or judge generated audio taste. A motif need not be written as notes, tempo, or fixed sections to be specific. Engineering checks may verify file existence, ownership, duration, derivation links, and error state. The user auditions and explicitly chooses the preferred take; generation does not select it.
