import assert from "node:assert/strict";
import test from "node:test";
import { buildImageArgs, parseDreaminaImagePollOutput } from "../src/utils/dreaminaCli";

test("Dreamina image async output keeps querying tasks pending", () => {
  const submitId = "image-submit-a";
  const querying = parseDreaminaImagePollOutput(
    JSON.stringify({
      submit_id: submitId,
      gen_status: "querying",
      queue_info: { queue_idx: 7, queue_status: 1, queue_length: 20 },
    }),
    submitId,
  );
  assert.equal(querying.status, "generating");
  assert.deepEqual(querying.queueInfo, { index: 7, status: 1, length: 20 });
  assert.equal(querying.imageUrl, undefined);

  const success = parseDreaminaImagePollOutput(
    JSON.stringify({
      submit_id: submitId,
      gen_status: "success",
      image_url: "https://example.com/right.png",
    }),
    submitId,
  );
  assert.equal(success.status, "success");
  assert.equal(success.imageUrl, "https://example.com/right.png");

  const mixed = parseDreaminaImagePollOutput(
    [
      JSON.stringify({ submit_id: submitId, gen_status: "querying" }),
      JSON.stringify({ submit_id: "image-submit-b", gen_status: "success", image_url: "https://example.com/wrong.png" }),
    ].join("\n"),
    submitId,
  );
  assert.equal(mixed.status, "generating");
  assert.equal(mixed.imageUrl, undefined);
});

test("Dreamina image async submit args are built without synchronous polling", () => {
  const imageArgs = buildImageArgs(
    { prompt: "test", size: "2K", aspectRatio: "16:9", referenceList: [] },
    { name: "image", modelName: "text2image:5.0", type: "image" } as any,
  );
  assert.equal(imageArgs.command, "text2image");
  assert.equal(imageArgs.args.includes("--resolution_type=2k"), true);
  assert.equal(imageArgs.args.some((arg) => arg.startsWith("--poll=")), false);
});
