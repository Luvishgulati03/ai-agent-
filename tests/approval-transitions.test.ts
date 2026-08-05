import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApprovalStore } from "../src/approval/store.ts";

test("approval store rejects transitions after an action has executed", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "lavu-approval-edge-"));

  try {
    const store = new ApprovalStore(path.join(rootDir, "approvals.json"));
    const item = await store.create({
      kind: "gmail.send",
      title: "Test outbound message",
      body: "Deterministic test body",
      payload: { to: "recipient@example.com" },
    });

    await store.setStatus(item.id, "approved");
    await store.setStatus(item.id, "executed", "message-123");
    await assert.rejects(
      () => store.setStatus(item.id, "rejected"),
      /Invalid approval transition: executed -> rejected/,
    );

    const persisted = await store.get(item.id);
    assert.equal(persisted?.status, "executed");
    assert.equal(persisted?.result, "message-123");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
