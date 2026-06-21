import assert from "node:assert/strict";
import test from "node:test";
import { emitWithAckTimeout } from "../src/agents/shared/socketAck";

test("emitWithAckTimeout resolves when the socket callback returns", async () => {
  const socket = {
    emit(event: string, payload: unknown, callback: (value: unknown) => void) {
      assert.equal(event, "getFlowData");
      assert.deepEqual(payload, { key: "script" });
      callback({ script: "ok" });
      return true;
    },
  };

  const result = await emitWithAckTimeout(socket, "getFlowData", { key: "script" }, 100);
  assert.deepEqual(result, { script: "ok" });
});

test("emitWithAckTimeout rejects when the socket callback never returns", async () => {
  const socket = {
    emit() {
      return true;
    },
  };

  await assert.rejects(
    emitWithAckTimeout(socket, "getFlowData", { key: "script" }, 10),
    /等待前端响应 getFlowData 超时/,
  );
});
