export interface ProjectMusicPlan {
  musicStyle: string;
  emotionalArc: string[];
  instrumentation: string[];
  rhythmLanguage: string;
  avoid: string[];
}

export interface TrackBgmSuggestion {
  groupKey: string;
  mood: string;
  intensity: 1 | 2 | 3 | 4 | 5;
  tempoBpm?: string;
  rhythm: string;
  instrumentation: string[];
  entryPoint: string;
  exitPoint: string;
  syncPoints: string[];
  avoid: string[];
  postNote: string;
}

export const defaultProjectMusicPlan: ProjectMusicPlan = {
  musicStyle: "restrained cinematic underscore",
  emotionalArc: ["setup", "pressure", "release"],
  instrumentation: ["low piano", "soft strings", "subtle pulse"],
  rhythmLanguage: "Keep rhythm below the dialogue and match visible action beats.",
  avoid: ["overly heroic melody", "busy percussion", "lyrics over dialogue"],
};

function hasAny(text: string, words: string[]) {
  return words.some((word) => text.includes(word));
}

export function buildTrackBgmSuggestion(input: {
  groupKey: string;
  scene?: string;
  event?: string;
  groupIntent?: string;
  totalDuration?: number;
}): TrackBgmSuggestion {
  const text = `${input.scene || ""} ${input.event || ""} ${input.groupIntent || ""}`.toLowerCase();
  const isTense = hasAny(text, ["追", "逃", "威胁", "压迫", "危险", "警觉", "panic", "threat", "chase"]);
  const isTender = hasAny(text, ["温柔", "告别", "回忆", "拥抱", "安静", "tender", "memory"]);
  const isComedy = hasAny(text, ["喜剧", "尴尬", "误会", "滑稽", "comedy"]);
  const intensity = isTense ? 4 : isComedy ? 2 : isTender ? 2 : 3;
  const mood = isTense ? "low tension and restrained pressure" : isComedy ? "light ironic pulse" : isTender ? "warm restrained emotion" : "neutral dramatic support";
  return {
    groupKey: input.groupKey,
    mood,
    intensity: intensity as 1 | 2 | 3 | 4 | 5,
    tempoBpm: isTense ? "78-92" : isComedy ? "96-112" : isTender ? "60-72" : "72-88",
    rhythm: isTense ? "sparse pulse with small rises at action beats" : "steady low-density underscore",
    instrumentation: isTense ? ["low strings", "muted piano", "sub bass pulse"] : isComedy ? ["light pizzicato", "small percussion"] : ["soft piano", "warm strings"],
    entryPoint: "fade in at the first visible action beat",
    exitPoint: "fade out before the next scene boundary",
    syncPoints: ["match camera movement starts", "leave dialogue clear"],
    avoid: ["lyrics", "dominant melody", "sound effects that duplicate on-screen sound"],
    postNote: "BGM suggestion only; do not include it in video model prompts.",
  };
}

export function parseMusicPlan(value: unknown): TrackBgmSuggestion | null {
  if (!value) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : (value as TrackBgmSuggestion);
  } catch {
    return null;
  }
}

export function stringifyMusicPlan(value: TrackBgmSuggestion | null | undefined) {
  return JSON.stringify(value || null);
}
