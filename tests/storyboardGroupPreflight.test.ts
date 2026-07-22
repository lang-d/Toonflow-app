import assert from "node:assert/strict";
import test from "node:test";
import {
  storyboardGroupPreflightSchema,
  validateStoryboardGroupPreflightStructure,
} from "../src/services/storyboardGroupPreflightContract";

const storyEventIds = ["E1"];
const shot = (index: number, duration: number, overrides: Record<string, unknown> = {}) => ({
  index,
  estimatedDurationSec: duration,
  storyEventRefs: ["E1"],
  axisSide: "south side",
  continuityHandoff: "action match",
  canCutAfter: true,
  indivisibleLongTake: false,
  ...overrides,
});

test("storyboard group preflight accepts a natural three-group split without rewriting shots", () => {
  const result = storyboardGroupPreflightSchema.parse({
    status: "ready",
    summary: "Seven narrative shots are scheduled into three generation groups.",
    storyEventIds,
    shots: [
      shot(0, 4),
      shot(1, 5, { narrativeFunction: "dialogue", canCutAfter: false }),
      shot(2, 4),
    ],
    groups: [
      { groupKey: "G01a", groupName: "opening", groupIntent: "establish pressure", storyboardIndexes: [0], estimatedDurationSec: 4 },
      { groupKey: "G01b", groupName: "dialogue", groupIntent: "reveal", storyboardIndexes: [1], estimatedDurationSec: 5 },
      { groupKey: "G01c", groupName: "reaction", groupIntent: "consequence", storyboardIndexes: [2], estimatedDurationSec: 4 },
    ],
    longTakeConflict: null,
  });
  assert.equal(result.status, "ready");
  assert.equal(result.groups.length, 3);
  assert.equal(result.shots[1].canCutAfter, false);
  assert.deepEqual(validateStoryboardGroupPreflightStructure(result), []);
});

test("storyboard group preflight represents an indivisible long-take conflict as user choice", () => {
  const result = storyboardGroupPreflightSchema.parse({
    status: "needs_user",
    summary: "The monologue cannot be split without changing the performance.",
    storyEventIds,
    shots: [shot(0, 18, { canCutAfter: false, indivisibleLongTake: true })],
    groups: [],
    longTakeConflict: {
      estimatedDurationSec: 18,
      reason: "The performance has no natural cut point.",
      userChoices: ["change_model", "redesign_shot"],
    },
  });
  assert.equal(result.status, "needs_user");
  assert.deepEqual(result.longTakeConflict?.userChoices, ["change_model", "redesign_shot"]);
  assert.deepEqual(validateStoryboardGroupPreflightStructure(result), []);
});

test("storyboard preparation rejects index drift and invalid group coverage", () => {
  const result = storyboardGroupPreflightSchema.parse({
    status: "ready",
    summary: "invalid schedule",
    storyEventIds,
    shots: [shot(0, 3), shot(2, 4)],
    groups: [
      { groupKey: "G01", groupName: "group", groupIntent: "intent", storyboardIndexes: [0, 2], estimatedDurationSec: 7 },
    ],
    longTakeConflict: null,
  });
  const issues = validateStoryboardGroupPreflightStructure(result);
  assert.ok(issues.some((issue) => issue.includes("continuous from 0")));
  assert.ok(issues.some((issue) => issue.includes("cover every shot")));
});

test("storyboard preparation rejects unknown or uncovered story events", () => {
  const result = storyboardGroupPreflightSchema.parse({
    status: "ready",
    summary: "invalid story coverage",
    storyEventIds: ["E1", "E2"],
    shots: [shot(0, 3, { storyEventRefs: ["unknown"] })],
    groups: [
      { groupKey: "G01", groupName: "group", groupIntent: "intent", storyboardIndexes: [0], estimatedDurationSec: 3 },
    ],
    longTakeConflict: null,
  });
  const issues = validateStoryboardGroupPreflightStructure(result);
  assert.ok(issues.some((issue) => issue.includes("references unknown story event unknown")));
  assert.ok(issues.some((issue) => issue.includes("E2 is not covered")));
});
