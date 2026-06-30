import assert from "node:assert/strict";
import test from "node:test";
import { shouldDeferImageFlowCandidate } from "../src/services/unifiedTaskDispatchPolicy";

test("image-flow provider backlog defers new provider submissions", () => {
  const defer = shouldDeferImageFlowCandidate(
    { businessType: "image-flow", taskType: "image", projectId: 10, providerTaskId: null },
    {
      imageLimit: 5,
      providerBacklogCount: 5,
      providerBacklogProjectIds: new Set([20]),
      runningImageFlowProjectIds: new Set(),
      runningImageFlowSubmitCount: 0,
    },
  );

  assert.equal(defer, true);
});

test("image-flow backlog from same project defers new provider submission", () => {
  const defer = shouldDeferImageFlowCandidate(
    { businessType: "image-flow", taskType: "image", projectId: 10, providerTaskId: null },
    {
      imageLimit: 5,
      providerBacklogCount: 1,
      providerBacklogProjectIds: new Set([10]),
      runningImageFlowProjectIds: new Set(),
      runningImageFlowSubmitCount: 0,
    },
  );

  assert.equal(defer, true);
});

test("image-flow candidate with provider task id is not deferred by submit backlog policy", () => {
  const defer = shouldDeferImageFlowCandidate(
    { businessType: "image-flow", taskType: "image", projectId: 10, providerTaskId: "provider-1" },
    {
      imageLimit: 5,
      providerBacklogCount: 5,
      providerBacklogProjectIds: new Set([10]),
      runningImageFlowProjectIds: new Set([10]),
      runningImageFlowSubmitCount: 5,
    },
  );

  assert.equal(defer, false);
});
