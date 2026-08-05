import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { WorkflowScheduler } from "../src/scheduler/scheduler.ts";
import { writeCronFile, writeLaunchdPlist } from "../src/scheduler/install.ts";
import type { LavuMemory } from "../src/memory/engram.ts";
import type { GmailService } from "../src/integrations/gmail.ts";
import type { WorkflowDefinition } from "../src/types.ts";

test("scheduler loads workflow definitions and generates enabled schedule files", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "lavu-scheduler-"));
  const config = loadConfig(rootDir);
  const definitions: WorkflowDefinition[] = [
    { id: "test-dream", name: "Test dream", cron: "17 3 * * *", kind: "memory.dream", enabled: true },
    { id: "disabled-poll", name: "Disabled poll", cron: "*/10 * * * *", kind: "gmail.inbox", enabled: false },
  ];

  try {
    await fs.mkdir(path.dirname(config.workflowsPath), { recursive: true });
    await fs.writeFile(config.workflowsPath, `${JSON.stringify(definitions)}\n`, "utf8");

    const activity = new ActivityLog(config.activityPath);
    await activity.init();
    const scheduler = new WorkflowScheduler(
      config,
      activity,
      {} as LavuMemory,
      {} as GmailService,
    );

    assert.deepEqual(await scheduler.definitions(), definitions);

    const cronPath = await writeCronFile(config, definitions);
    const cron = await fs.readFile(cronPath, "utf8");
    assert.match(cron, /17 3 \* \* \* /);
    assert.match(cron, /test-dream/);
    assert.doesNotMatch(cron, /disabled-poll/);

    const launchdPath = await writeLaunchdPlist(config, definitions);
    const launchd = await fs.readFile(launchdPath, "utf8");
    assert.match(launchd, /com\.lavu\.test-dream/);
    assert.doesNotMatch(launchd, /com\.lavu\.disabled-poll/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
