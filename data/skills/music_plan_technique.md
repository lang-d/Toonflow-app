# Music Plan Technique

Build a music plan around musical meaning.

Cue types may include:
- opening_theme
- ending_theme
- insert_song
- bgm
- stinger
- ambient
- source_music
- silence

Cue splitting rules:
- split on dramatic turn, emotional reset, scene transition, reveal, montage, action escalation, or tonal contrast
- merge adjacent storyboard panels when one continuous musical idea should cover them
- do not create one cue per storyboard by default
- for serialized production, preserve recurring themes and leave room for later episode revisions

Each cue should define:
- cueKey
- cueType
- title
- narrativePurpose
- startRef and endRef
- durationSec when known
- promptBrief
- musicSpec with mood arc, instrumentation, structure, vocal/lyrics policy, avoid list, and continuity notes
