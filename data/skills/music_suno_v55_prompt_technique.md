# Suno V5.5 Prompt Technique

Compile one confirmed music cue or edition into one Suno V5.5 Custom-mode request. This Skill owns Suno field formatting and mode rules. Preserve audible identity and narrative function without retelling plot or production context.

## Inputs And Priority

Read formal data before compiling. Establish the target mode, the saved work or edition facts, the selected model Profile and capabilities, and the user's latest instruction. For vocal work, read the exact confirmed lyrics version; it is the only lyric source.

Use this priority when facts disagree:
1. selected model Profile and exposed capabilities
2. target's saved musical facts and confirmed vocal mode
3. confirmed lyrics version for vocal work
4. the user's latest instruction

Do not use chat memory, character biography, shot description, camera direction, or a guessed provider feature as a music-generation fact.

## Output Contract

Return the normal structured result with `prompt`, `negativePrompt`, and `generationConfig`.

- `prompt`: one compact, natural-language musical direction. Order the identity-defining sound first, then pulse, core instrumentation, texture, dynamic or structural movement, and ending behavior.
- `generationConfig.title`: a short distinct take title, never an episode synopsis or instruction.
- `generationConfig.tags`: compact English comma-separated descriptors for the core style, motif gesture, pulse, main instrument roles, texture, dynamics, ending behavior, and vocal character only when the target is vocal. Keep it as concise identity metadata without turning it into plot prose or a sentence; the selected adapter owns provider field routing.
- `negativePrompt`: only unwanted audible musical traits. Do not put plot, people, dialogue, lyrics, model controls, or unavailable features here.

Before returning, remove duplicated adjectives, decorative instruments, and repeated structural claims while retaining the core motif, pulse, primary instrument roles, texture, and ending behavior. Follow a selected adapter's declared request contract when one is available; do not invent numeric limits.

The execution layer enforces the chosen instrumental or vocal mode. Do not try to simulate that control with text such as "no vocals" or by writing an anti-vocal word list.

## Internal Compilation

Before producing the fields, silently do the following:
1. Decide whether the target is `instrumental` or `vocal`; never blend the two paths.
2. Form one compact music organization: a recognizable non-score motif gesture and its evolution; a role map for the main instrument and every supporting part; and a listening arc from entry through close.
3. Reduce the source facts to one audible identity: style family, pulse, core instruments, harmonic color, texture, energy movement, and ending behavior.
4. Translate any dramatic intent into an audible choice rather than a person, statement, or story event.
5. Place each fact in exactly one output field according to the Output Contract.
6. Run the mode-specific self-check before returning the result.

### Music Organization

Silently form this compact organization before routing fields:
- **Core motif:** describe one recognizable listening gesture, such as a short falling phrase, a suspended pulse, or a widening arpeggio, then state how it repeats, thins out, densifies, expands, fragments, or fades. This is an audible identity, never note names, a chord chart, bar counts, or MIDI data.
- **Role map:** retain a part only when it has one clear audible job: motif carrier, rhythmic or low-frequency foundation, harmonic support, spatial texture, or transition. Do not list instruments with no job. Do not assign overlapping jobs unless their contrast is itself audible.
- **Listening arc:** express entry, establishment, development or turn, and close through density, register, dynamics, rests, and changing relationships between parts. Do not claim timestamps, exact section lengths, tempo maps, beat counts, or a mechanically controlled duration.

## Instrumental Path

An instrumental request contains only sound that could exist without a human utterance: rhythm, register, harmony, melodic behavior, instruments, texture, mix space, dynamics, rests, and cadence.

Do not put dialogue, narration, character names, a person speaking, a voice, singing, whispers, humming, chanting, choir, lyrics, verse/chorus labels, a vocal hook, or language-like syllables in `prompt`, `tags`, or `negativePrompt`, including as a metaphor.

The core motif, main line, and every instrument role are musical functions, never a human performer or a language-like gesture. Describe their contour, repetition, density, register, and relationship without turning them into speech, singing, or lyrics.

Translate dramatic ideas into audible behavior:
- an unsaid thought or blocked speech -> broken rhythm, short motifs, rests, interrupted cadence
- suppression or restraint -> low dynamics, narrow register, dry sparse texture, delayed resolution
- isolation -> exposed single instrument, empty space, distant or close placement chosen deliberately
- escalation -> denser rhythm, widening register, added harmonic pressure, then a defined release or cutoff

Keep tags to the core listening identity. Include the material motif gesture, pulse, main instrument roles, texture, harmonic color, dynamic direction, and ending behavior. Do not turn tags into plot prose, a list of every possible instrument, or an anti-vocal instruction.

Instrumental self-check:
- Does every word describe audible music rather than a person or story?
- Are all four fields free of voice, language, and song-section implications?
- Does every named part have one distinct audible role, with no decorative instrument pile?
- Does the prompt give the core motif a non-score evolution and a listening arc from entry through a natural ending without notation or exact timing claims?

## Vocal Path

Use the confirmed lyrics version exactly as the separate lyric input. Do not paste, paraphrase, summarize, or invent lyrics in `prompt`, `tags`, `negativePrompt`, or `generationConfig`.

Use `prompt` for vocal delivery and musical support: register, phrasing energy, articulation, intimacy or projection, instrumental relationship, dynamics, and ending behavior. Use `tags` for the core style, instruments, production character, and vocal character. Keep the song's plot and wording in the lyrics version, not in the style fields.

Vocal self-check:
- Is there one confirmed lyrics version and no other lyric source?
- Does the prompt describe delivery and arrangement rather than repeat words to sing?
- Do tags name only the sound identity, not a story or full lyric line?

## Capability Boundaries

The requested duration is a narrative target, not an exact runtime guarantee. Shape a natural resolution near that target without claiming a precise file length. Do not request Persona, continuation, clip IDs, stems, MIDI, WAV, reference audio, loops, or any other mode not exposed by the selected model.

Do not imitate named artists. Avoid contradictory adjective piles: choose one primary identity and only supporting details that audibly change the result.
