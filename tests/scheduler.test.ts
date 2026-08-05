import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeCronFile, writeLaunchdPlist } from "../src/scheduler/install.ts";
import type { LavuConfig } from "../src/config.ts";
import type { WorkflowDefinition } from "../src/types.ts";

test("scheduler installation writes reviewable cron and launchd artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lavu-scheduler-"));
  const config = { rootDir: root, dataDir: path.join(root, "data") } as LavuConfig;
  const workflows: WorkflowDefinition[] = [
    { id: "dream", name: "Dream", cron: "0 2 * * *", kind: "memory.dream", enabled: true },
    { id: "disabled", name: "Disabled", cron: "*/5 * * * *", kind: "gmail.inbox", enabled: false },
  ];
  const cron = await writeCronFile(config, workflows);
  const plist = await writeLaunchdPlist(config, workflows);
  assert.match(await fs.readFile(cron, "utf8"), /dream/);
  assert.match(await fs.readFile(plist, "utf8"), /com\.lavu\.scheduler-1/);
  assert.match(await fs.readFile(plist, "utf8"), /schedule/);
});
