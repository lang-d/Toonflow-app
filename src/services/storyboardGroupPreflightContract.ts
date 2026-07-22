import { z } from "zod";

const positiveInteger = z.number().int().positive();

const preflightShotSchema = z.object({
  index: z.number().int().nonnegative(),
  estimatedDurationSec: positiveInteger,
  storyEventRefs: z.array(z.string().trim().min(1)).min(1),
  axisSide: z.string().trim().min(1),
  continuityHandoff: z.string().trim().min(1),
  canCutAfter: z.boolean(),
  indivisibleLongTake: z.boolean(),
});

const preflightGroupSchema = z.object({
  groupKey: z.string().trim().min(1),
  groupName: z.string().trim().min(1),
  groupIntent: z.string().trim().min(1),
  storyboardIndexes: z.array(z.number().int().nonnegative()).min(1),
  estimatedDurationSec: positiveInteger,
});

export const storyboardGroupPreflightSchema = z.object({
  status: z.enum(["ready", "needs_user"]),
  summary: z.string().trim().min(1),
  storyEventIds: z.array(z.string().trim().min(1)).min(1),
  shots: z.array(preflightShotSchema),
  groups: z.array(preflightGroupSchema),
  longTakeConflict: z
    .object({
      estimatedDurationSec: positiveInteger,
      reason: z.string().trim().min(1),
      userChoices: z.array(z.enum(["change_model", "redesign_shot"])).length(2),
    })
    .nullable(),
});

export function validateStoryboardGroupPreflightStructure(input: StoryboardGroupPreflight) {
  const issues: string[] = [];
  const shotIndexes = input.shots.map((shot) => shot.index);
  const expectedIndexes = input.shots.map((_, index) => index);
  if (JSON.stringify(shotIndexes) !== JSON.stringify(expectedIndexes)) {
    issues.push(`shots.index must be continuous from 0; received [${shotIndexes.join(", ")}]`);
  }

  const eventIds = new Set(input.storyEventIds);
  if (eventIds.size !== input.storyEventIds.length) issues.push("storyEventIds must be unique");
  const coveredEventIds = new Set(input.shots.flatMap((shot) => shot.storyEventRefs));
  for (const eventId of input.storyEventIds) {
    if (!coveredEventIds.has(eventId)) issues.push(`story event ${eventId} is not covered by any shot`);
  }
  for (const shot of input.shots) {
    for (const ref of shot.storyEventRefs) {
      if (!eventIds.has(ref)) issues.push(`shot ${shot.index} references unknown story event ${ref}`);
    }
  }

  if (input.status === "ready") {
    if (!input.shots.length) issues.push("ready preflight must contain shots");
    if (!input.groups.length) issues.push("ready preflight must contain groups");
    if (input.longTakeConflict) issues.push("ready preflight cannot contain longTakeConflict");
    const grouped = input.groups.flatMap((group) => group.storyboardIndexes);
    if (JSON.stringify(grouped) !== JSON.stringify(expectedIndexes)) {
      issues.push(`groups must cover every shot exactly once in order; received [${grouped.join(", ")}]`);
    }
    for (const group of input.groups) {
      const expectedDuration = group.storyboardIndexes.reduce(
        (sum, index) => sum + Number(input.shots[index]?.estimatedDurationSec || 0),
        0,
      );
      if (group.estimatedDurationSec !== expectedDuration) {
        issues.push(
          `group ${group.groupKey} estimatedDurationSec must equal its shot total ${expectedDuration}`,
        );
      }
    }
  } else {
    if (!input.longTakeConflict) issues.push("needs_user preflight must contain longTakeConflict");
    if (input.groups.length) issues.push("needs_user preflight must not create generation groups");
  }
  return issues;
}

export type StoryboardGroupPreflight = z.infer<typeof storyboardGroupPreflightSchema>;
