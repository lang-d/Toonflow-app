# Dreamina SeedMusic Prompt Profile

Use this profile for Dreamina SeedMusic / SeedMusic 1.0 Preview style music generation.

Preferred format:
- concise natural-language prompt
- Chinese is acceptable when the song/lyrics direction is Chinese; otherwise English is fine
- one compact paragraph is preferred over a long structured brief
- include only musical instructions, not full plot explanation

Recommended content:
- genre and use case, such as Pop Ballad, ending theme, insert song, cue BGM
- language and vocal direction, including gender, tone, and delivery
- lyric mood or short lyric concept when vocal is needed
- core instruments and arrangement, such as piano, acoustic guitar, light drums, strings
- theme motif or emotional hook
- tempo/BPM or speed band
- emotional arc in one short phrase
- avoid list only when necessary

Length:
- 30-120 words is enough for most cues
- avoid more than 2 character/story names
- avoid dumping scene summaries, cue sheets, or long worldbuilding notes

Generation config:
- set durationSec only when the cue requires fixed timing
- use lyrics when actual lyrics are provided
- use vocalMode for vocal/instrumental preference when supported
- use outputFormat only if requested
- keep unsupported Dreamina CLI flags out of generationConfig

Example shape:
Pop Ballad, Chinese lyrics. A slightly tired female vocal with restrained crying texture, piano + acoustic guitar + light drums. Main motif feels clear and memorable, late-night bittersweet warmth, emotional farewell but still hopeful, BPM around 70.
