import assert from "node:assert/strict";
import test from "node:test";
import { shouldDeferImageFlowCandidate } from "../src/services/unifiedTaskDispatchPolicy";

test("image-flow provider backlog defers new provider submissions", () => {
  const defer = shouldDeferImageFlowCandidate(
    { businessType: "image-flow", taskType: "image", handler: "image-flow", providerTaskId: null },
    {
      imageLimit: 5,
      occupiedImageCount: 5,
    },
  );

  assert.equal(defer, true);
});

test("image generation below the global limit allows another provider submission", () => {
  const defer = shouldDeferImageFlowCandidate(
    { businessType: "image-flow", taskType: "image", handler: "image-flow", providerTaskId: null },
    {
      imageLimit: 5,
      occupiedImageCount: 4,
    },
  );

  assert.equal(defer, false);
});

test("asset and storyboard image tasks share the global image limit", () => {
  const assetDeferred = shouldDeferImageFlowCandidate(
    { taskType: "asset", handler: "asset-image", providerTaskId: null },
    {
      imageLimit: 5,
      occupiedImageCount: 5,
    },
  );
  const storyboardDeferred = shouldDeferImageFlowCandidate(
    { taskType: "storyboard", handler: "storyboard-image", providerTaskId: null },
    {
      imageLimit: 5,
      occupiedImageCount: 5,
    },
  );

  assert.equal(assetDeferred, true);
  assert.equal(storyboardDeferred, true);
});

test("non-image tasks do not use the global image gate", () => {
  const defer = shouldDeferImageFlowCandidate(
    { taskType: "prompt", handler: "asset-prompt", providerTaskId: null },
    {
      imageLimit: 5,
      occupiedImageCount: 5,
    },
  );

  assert.equal(defer, false);
});

test("image-flow candidate with provider task id is not deferred by submit backlog policy", () => {
  const defer = shouldDeferImageFlowCandidate(
    { businessType: "image-flow", taskType: "image", handler: "image-flow", providerTaskId: "provider-1" },
    {
      imageLimit: 5,
      occupiedImageCount: 5,
    },
  );

  assert.equal(defer, false);
});
