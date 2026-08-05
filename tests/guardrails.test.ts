import test from "node:test";
import assert from "node:assert/strict";
import { assertOutboundExecutionClaim } from "../src/guardrails.ts";

test("outbound guardrail rejects email sends before execution claim", () => {
  assert.throws(
    () => assertOutboundExecutionClaim({ kind: "gmail.send", status: "pending" }),
    /explicit Dad approval/,
  );
  assert.throws(
    () => assertOutboundExecutionClaim({ kind: "gmail.send", status: "approved" }),
    /explicit Dad approval/,
  );
  assert.doesNotThrow(() => assertOutboundExecutionClaim({ kind: "gmail.send", status: "executing" }));
});
