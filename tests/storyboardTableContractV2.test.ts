import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStoryboardDraftRow,
  legacyStoryboardCharacters,
  legacyStoryboardVisibleEmotion,
  parseStoryboardTableRow,
  storyboardRowToDbPatch,
  storyboardTableRowV2Schema,
  storyboardTableRowV3Schema,
  STORYBOARD_FACT_WRITE_VERSION,
} from "../src/services/storyboardTableContract";

const common = {
  index: 0,
  groupKey: "G01",
  beatId: "B01",
  durationSec: 4,
  location: "院坝",
  timeOfDay: "日",
  picture: "苏晴站在工作台前，双手扶住纸箱",
  action: "门外传来引擎声，苏晴停下装箱并抬头看向院门；镜头结束时，她松开纸箱向门口迈出一步。",
  shotSize: "中景",
  dialogue: [],
  soundEffects: ["门外引擎声"],
  requiredAssets: [],
};

const v3Common = {
  index: 0,
  groupKey: "G01",
  beatId: "B01",
  durationSec: 4,
  location: "院坝",
  timeOfDay: "日",
  shotDescription:
    "苏晴双手扶着纸箱站在工作台旁。门外传来引擎声，她停下动作并抬头看向院门；镜头结束时，她松开纸箱向门口迈出一步。",
  shotSize: "中景",
  dialogue: [],
  soundEffects: ["门外引擎声"],
  requiredAssets: [],
};

test("reads historical V1 rows without promoting legacy performance fields into V2", () => {
  const v1 = parseStoryboardTableRow({
    version: 1,
    ...common,
    groupName: "发现来车",
    groupIntent: "建立行动触发",
    cameraMove: "固定",
    characters: [
      {
        name: "苏晴",
        action: "抬头",
        orientation: "面向院门",
        spatialPosition: "工作台前",
      },
    ],
    visibleEmotion: "警觉",
  });

  assert.ok(v1);
  assert.equal(v1.version, 1);
  assert.equal(legacyStoryboardVisibleEmotion(v1), "警觉");
  assert.equal(legacyStoryboardCharacters(v1).length, 1);

  const draft = buildStoryboardDraftRow({}, 0, v1);
  assert.equal(draft.version, 2);
  assert.equal(draft.picture, common.picture);
  assert.equal(draft.action, common.action);
  assert.equal("visibleEmotion" in draft, false);
  assert.equal("characters" in draft, false);
  assert.equal("groupName" in draft, false);
  assert.equal("groupIntent" in draft, false);
});

test("accepts the exact V2 contract and rejects legacy formal fields", () => {
  const v2 = storyboardTableRowV2Schema.parse({ version: 2, ...common });
  assert.equal(v2.version, 2);
  assert.equal(v2.action, common.action);

  const withLegacyField = storyboardTableRowV2Schema.safeParse({
    version: 2,
    ...common,
    visibleEmotion: "警觉",
  });
  assert.equal(withLegacyField.success, false);
});

test("projects V2 group display metadata from the formal group plan only", () => {
  const v2 = storyboardTableRowV2Schema.parse({ version: 2, ...common });
  const patch = storyboardRowToDbPatch(v2, 3, {
    groupName: "发现来车",
    groupIntent: "由声音触发人物行动",
  });

  assert.equal(patch.factVersion, 2);
  assert.equal(patch.visibleEmotion, null);
  assert.equal(patch.groupName, "发现来车");
  assert.equal(patch.groupIntent, "由声音触发人物行动");
  const stored = JSON.parse(patch.tableRowJson);
  assert.equal("visibleEmotion" in stored, false);
  assert.equal("characters" in stored, false);
  assert.equal("groupName" in stored, false);
  assert.equal("groupIntent" in stored, false);
});

test("new Agent writes use the exact V3 chronological contract", () => {
  assert.equal(STORYBOARD_FACT_WRITE_VERSION, 3);
  const v3 = storyboardTableRowV3Schema.parse({ version: 3, ...v3Common });
  assert.equal(v3.shotDescription, v3Common.shotDescription);

  for (const forbiddenField of ["picture", "action", "characters", "visibleEmotion", "groupName", "groupIntent"]) {
    const result = storyboardTableRowV3Schema.safeParse({
      version: 3,
      ...v3Common,
      [forbiddenField]: "not allowed",
    });
    assert.equal(result.success, false, `${forbiddenField} must not be accepted by V3`);
  }
});

test("all native versions reject fields borrowed from another version", () => {
  const v1WithV3Field = {
    version: 1,
    ...common,
    groupName: "group",
    groupIntent: "intent",
    cameraMove: "fixed",
    characters: [],
    visibleEmotion: "neutral",
    shotDescription: "must not be accepted",
  };
  const v2WithV3Field = { version: 2, ...common, shotDescription: "must not be accepted" };
  const v3WithV2Field = { version: 3, ...v3Common, picture: "must not be accepted" };

  assert.equal(parseStoryboardTableRow(v1WithV3Field), null);
  assert.equal(parseStoryboardTableRow(v2WithV3Field), null);
  assert.equal(parseStoryboardTableRow(v3WithV2Field), null);
});

test("V3 persistence keeps tableRowJson authoritative and clears V2 projections", () => {
  const v3 = storyboardTableRowV3Schema.parse({ version: 3, ...v3Common });
  const patch = storyboardRowToDbPatch(v3, 5, {
    groupName: "发现来车",
    groupIntent: "由声音触发人物行动",
  });

  assert.equal(patch.factVersion, 3);
  assert.equal(patch.picture, null);
  assert.equal(patch.action, null);
  assert.equal(patch.factRevision, 5);
  assert.deepEqual(JSON.parse(patch.tableRowJson), v3);
});
