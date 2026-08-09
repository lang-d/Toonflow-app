# MiniMax H3 Video Prompt Writing Skill

Compile the supplied Toonflow storyboard facts and references into one final English prompt for MiniMax H3. This is a prompt rewrite, not a review: return the final H3 prompt only. Do not return analysis, JSON, Markdown fences, field explanations, source names, or internal Toonflow identifiers.

## Authoritative facts

- Use only the current `<trackStoryboard>` facts, the formal `videoStyle`, selected H3 mode, supplied reference list, and explicit prefix/suffix constraints. Do not infer content from asset names, reference order, `visibleEmotion`, `characters[]`, group intent, director-plan prose, or an asset catalogue.
- `factVersion=3`: `shotDescription` is the only chronological source: opening state, trigger, visible change, and ending state. `factVersion=1/2`: use native `picture` and `action` only. Never assemble a V3 record from old fields or mix versions.
- Keep supplied storyboards in their given order and duration. Preserve confirmed action results, dialogue, on-screen text, diegetic sound, and non-empty camera movement. Do not invent a shot, cut, transition, performance, environment event, causal link, or media responsibility.
- Preserve dialogue, lyrics, and visible text verbatim in their original language. `voiceTone` may guide vocal delivery only; it is not visual evidence. Do not invent a voice-over, speaker demographics, or lip instructions.
- The formal `videoStyle` is the stable style anchor. Preserve its meaning without extending it into new locations, weather, actions, quality tags, or model parameters.
- Never add BGM, score, OST, or audience-only music. Always output `non_diegetic_music: N/A`.

## H3 reference labels

The supplied `@ImageN` values are internal Toonflow mapping only. Do not write `@ImageN` in the final prompt. Translate them exactly as follows:

- image `@ImageN` -> `<Picture N>`
- supplied video N -> `<Video N>`
- supplied audio N -> `<Audio N>`

Use every supplied media label with its existing number. Never create, renumber, or cross-use labels. Define reusable visible content as `<Subject N>` and cite its source `<Picture N>` or `<Video N>` inside that definition. A picture gets its own standalone definition only when it is a concrete keyframe, a storyboard/shot-planning reference, or another confirmed composition anchor. A normal character, scene, prop, or merged asset image is not automatically a first or last frame.

Only the selected API mode determines keyframes:

- `singleImage`: `<Picture 1>` is the first frame at 0.00 seconds.
- `startEndRequired`: `<Picture 1>` is the first frame and `<Picture 2>` is the last frame.
- `endFrameOptional`: `<Picture 1>` is the first frame; `<Picture 2>`, if supplied, is the last frame.
- `startFrameOptional`: one supplied image is the last frame; with two images, `<Picture 1>` is the first frame and `<Picture 2>` is the last frame.
- A `visualStart=storyboardReference` image is the established opening composition for its matching shot. Describe the confirmed continuation, not a second static reconstruction. `visualStart=textFallback` establishes the image from version-native storyboard facts, not from an ordinary reference.

## Shared H3 timeline writing

Write natural, concrete English. At `[Shot 1]`, establish only the confirmed style and opening composition. Later shots use `[Shot N] At MM:SS.mmm, ...` with strictly increasing cumulative cut times from the supplied durations. Do not timestamp Shot 1.

For every shot, write the visible starting state, continuous action or state change, confirmed result, necessary camera movement, dialogue, and synchronized diegetic sound. Write camera motion inside the sentence. State motion type and, only when supported, meaningful amplitude and speed. A cut must introduce new information about subject, space, state, viewpoint, or time; do not create a cut merely for a small reframing.

Give each actual vocal source a stable `(S1)`, `(S2)`, and so on across the final video. Put identity and delivery outside the dialogue tag; put only original spoken words inside `<d>[Language]...</d>`. Do not translate dialogue. Use `<scenetrans>` and explicit continuity only when supplied dialogue genuinely crosses a supplied cut; use `<cutoff>` only when speech is cut off by the end of the supplied video.

`overall_soundscape` is a concise 1–4 sentence English paragraph covering ambience, physical action sounds, and non-verbal human sounds. Do not repeat dialogue or diegetic music already written in the timeline.

## Select exactly one final format

### T2VA / I2VA / FL2VA / L2VA

Use this format for text generation and API keyframe modes.

- T2VA: begin directly with the three fields.
- I2VA: first line exactly states that `<Picture 1>` from `[Shot 1]` aligns to `0.00 seconds`; begin the body from that established frame and move forward.
- FL2VA: first line states `<Picture 1>` aligns to `0.00 seconds` and `<Picture 2>` aligns to the effective final duration. Describe one continuous observable path from the first image to the final image. Reach the latter at the end of the final supplied shot; do not repeat two isolated static compositions.
- L2VA: first line states `<Picture 1>` from the actual final shot aligns to the effective final duration. Establish only a compatible earlier state supported by facts, then converge to the supplied final frame.

For I2VA use:

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: N/A
```

For FL2VA and L2VA, replace that first line with the official `How the reference pictures align with the target video — ...` sentence. Use the effective total duration formatted with exactly two decimal places. After the alignment line, emit the same three fields in the shown order.

### Full-reference Ref2VA

Use this format only for the selected multimodal reference mode. Every section is English except original dialogue, lyrics, and visible text.

```text
subject_definitions:
<Subject 1> ...

summary: [reference generation] ...

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - ...

detailed_description: The target video is in ... [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: N/A
```

- `subject_definitions`: put each tracked subject, keyframe picture, source video, and audio source on its own line. Define only a role confirmed by the supplied facts. Do not claim a file supplies identity, action, camera movement, voice, style, or source-video structure when that responsibility was not given.
- `summary`: begin with actual relationships joined by ` + `, such as `[reference generation]`, `[keyframe completion + reference generation]`, `[video continuation + keyframe completion]`, `[audio reference]`, or `[audio reuse]`. Mere presence of media does not create video editing, continuation, reuse, or a keyframe role.
- `retention_analysis`: use one line per defined label. Visible labels use only `fully_preserved`, `partially_preserved`, `attribute_transfer`, or `weak_reference`; audio labels use only `fully_copy`, `partially_copy`, `reference`, or `weak_reference`. Do not describe unsupplied story events as fidelity loss.
- `detailed_description`: give one or two style-opening sentences, then the playback-order timeline. Mention a reference label exactly where its confirmed role applies. It must be a concrete audiovisual description, never a plot summary or a list of reference relationships.

## Final self-check

- Select the format that matches the actual H3 API role of supplied images, not merely their presence.
- Every `<Picture N>`, `<Video N>`, and `<Audio N>` matches a supplied reference and no other media label appears.
- Keep V3 facts, shot order, durations, action outcomes, dialogue, visible text, and diegetic sound intact. Do not add unsupported visual performance, media duties, cuts, transitions, or music.
