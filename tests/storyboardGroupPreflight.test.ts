import assert from "node:assert/strict";
import test from "node:test";
import {
  storyboardGroupPreflightSchema,
  validateStoryboardGroupPreflightStructure,
} from "../src/services/storyboardGroupPreflightContract";

const shot = (index: number, duration: number) => ({
  index,
  estimatedDurationSec: duration,
});

test("storyboard group preflight accepts a natural split without creative self-proof fields", () => {
  const result = storyboardGroupPreflightSchema.parse({
    status: "ready",
    summary: "Three shots form three independently readable changes.",
    shots: [shot(0, 4), shot(1, 5), shot(2, 4)],
    groups: [
      { groupKey: "G01a", groupName: "opening", groupIntent: "establish pressure", storyboardIndexes: [0], estimatedDurationSec: 4 },
      { groupKey: "G01b", groupName: "dialogue", groupIntent: "reveal", storyboardIndexes: [1], estimatedDurationSec: 5 },
      { groupKey: "G01c", groupName: "reaction", groupIntent: "consequence", storyboardIndexes: [2], estimatedDurationSec: 4 },
    ],
  });
  assert.equal(result.status, "ready");
  assert.equal(result.groups.length, 3);
  assert.deepEqual(result.shots[1], { index: 1, estimatedDurationSec: 5 });
  assert.deepEqual(validateStoryboardGroupPreflightStructure(result), []);
});

test("storyboard group preflight can request user input without prescribing fixed choices", () => {
  const result = storyboardGroupPreflightSchema.parse({
    status: "needs_user",
    summary: "The confirmed delivery duration is shorter than the indivisible performance.",
    shots: [shot(0, 18)],
    groups: [],
  });
  assert.equal(result.status, "needs_user");
  assert.equal("longTakeConflict" in result, false);
  assert.deepEqual(validateStoryboardGroupPreflightStructure(result), []);
});

test("storyboard preparation rejects index drift and invalid group coverage", () => {
  const result = storyboardGroupPreflightSchema.parse({
    status: "ready",
    summary: "invalid schedule",
    shots: [shot(0, 3), shot(2, 4)],
    groups: [
      { groupKey: "G01", groupName: "group", groupIntent: "intent", storyboardIndexes: [0, 2], estimatedDurationSec: 7 },
    ],
  });
  const issues = validateStoryboardGroupPreflightStructure(result);
  assert.ok(issues.some((issue) => issue.includes("continuous from 0")));
  assert.ok(issues.some((issue) => issue.includes("cover every shot")));
});

test("storyboard preparation rejects a group duration that differs from its shot total", () => {
  const result = storyboardGroupPreflightSchema.parse({
    status: "ready",
    summary: "invalid duration sum",
    shots: [shot(0, 3), shot(1, 4)],
    groups: [
      { groupKey: "G01", groupName: "group", groupIntent: "intent", storyboardIndexes: [0, 1], estimatedDurationSec: 8 },
    ],
  });
  const issues = validateStoryboardGroupPreflightStructure(result);
  assert.ok(issues.some((issue) => issue.includes("must equal its shot total 7")));
});

test("preflight rejects removed creative-proof fields instead of silently accepting them", () => {
  const result = storyboardGroupPreflightSchema.safeParse({
    status: "ready",
    summary: "old payload",
    storyEventIds: ["E1"],
    shots: [{ ...shot(0, 3), axisSide: "south", canCutAfter: true }],
    groups: [
      { groupKey: "G01", groupName: "group", groupIntent: "intent", storyboardIndexes: [0], estimatedDurationSec: 3 },
    ],
  });
  assert.equal(result.success, false);
});
