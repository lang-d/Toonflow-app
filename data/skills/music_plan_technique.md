# Music Plan Technique

## Mode contract

Concept mode:
- output candidate directions and tradeoffs only
- libraryItems must be empty and cues must be empty

Project mode:
- output a restrained list of reusable music works and their justified narrative/arrangement editions
- cues must be empty
- create theme/opening/ending/insert songs only when explicitly requested or confirmed
- editions are planned identities, not generated takes
- use work relations evolves_from, replaces, or companion only when a genuinely different work is needed

Episode mode:
- output semantic music usage segments and no project libraryItems
- each segment chooses usageMode reuse, new, or silence
- reuse an existing edition/version whenever it carries the same musical identity and dramatic function

## Music usage segment rules
- A segment may cover several scenes and any number of shots.
- Split only for emotional reversal, relationship change, major reveal, time-space jump, source-music boundary, or intentional silence.
- Merge adjacent passages with the same function, even when camera or location changes.
- Do not add default opening or ending segments.
- Use semantic startRef/endRef anchors: scene, line, action, or event. Do not invent final timecodes.
- Duration is an integer pre-edit estimate with min/max and confidence. It is not a final editing duration.

Each segment must state narrative purpose, usage decision, suggested duration, and a concise musical brief. Silence is an active decision and must not compile or generate a prompt.
