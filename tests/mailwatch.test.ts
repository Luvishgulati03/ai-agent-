import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { MailWatchService, parseAlertLine, type MailWatchNotifier } from "../src/mailwatch/service.ts";
import type { ProviderRunner } from "../src/providers/runner.ts";
import type { RunResult } from "../src/types.ts";

async function setup(): Promise<{ config: ReturnType<typeof loadConfig>; activity: ActivityLog }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-mailwatch-"));
  const config = loadConfig(rootDir);
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  return { config, activity };
}

function fakeRunner(response: string): ProviderRunner {
  return {
    run: async (): Promise<RunResult> => ({
      runId: "r1", provider: "codex", response, exitCode: 0, durationMs: 1, events: [],
    }),
  } as unknown as ProviderRunner;
}

function fakeNotifier(): { notify: MailWatchNotifier; messages: Array<{ message: string; title?: string }> } {
  const messages: Array<{ message: string; title?: string }> = [];
  const notify: MailWatchNotifier = async (message, title) => { messages.push({ message, title }); };
  return { notify, messages };
}

test("parseAlertLine parses well-formed ALERT lines and rejects garbage", () => {
  const good = parseAlertLine("ALERT|msg-123|recruiter@acme.com|Interview scheduled|Interview invite for Thursday");
  assert.deepEqual(good, {
    id: "msg-123", from: "recruiter@acme.com", subject: "Interview scheduled", what: "Interview invite for Thursday",
  });
  assert.equal(parseAlertLine("NO_ALERTS"), undefined);
  assert.equal(parseAlertLine(""), undefined);
  assert.equal(parseAlertLine("just some prose the model emitted"), undefined);
  assert.equal(parseAlertLine("ALERT|only|three|parts"), undefined);
  // Missing id falls back to a deterministic hash, not undefined/blank.
  const noId = parseAlertLine("ALERT||recruiter@acme.com|Subject|what it is");
  assert.ok(noId && noId.id.startsWith("h"));
});

test("check() parses ALERT lines, notifies, records activity, and persists state", async () => {
  const { config, activity } = await setup();
  const response = [
    "ALERT|msg-1|recruiter@acme.com|You've been shortlisted|Shortlisting notice",
    "ALERT|msg-2|jobs@foo.com|Interview invitation|Interview scheduled for next week",
    "some stray line the model should not have emitted",
  ].join("\n");
  const { notify, messages } = fakeNotifier();
  const service = new MailWatchService(config, activity, fakeRunner(response), notify);

  const result = await service.check();
  assert.deepEqual(result.alerts.sort(), [
    "Interview invitation — from jobs@foo.com (Interview scheduled for next week)",
    "You've been shortlisted — from recruiter@acme.com (Shortlisting notice)",
  ].sort());
  assert.equal(messages.length, 2);
  assert.ok(messages.every((m) => m.title === "Henry — job mail"));

  const events = await activity.list(50);
  const mailwatchEvents = events.filter((e) => e.metadata?.mailwatch === true);
  assert.equal(mailwatchEvents.length, 2);

  const status = await service.status();
  assert.equal(status.seenCount, 2);
});

test("check() returns no alerts on NO_ALERTS and writes an updated lastCheckIso", async () => {
  const { config, activity } = await setup();
  const service = new MailWatchService(config, activity, fakeRunner("NO_ALERTS"));
  const before = await service.status();
  const result = await service.check();
  assert.deepEqual(result.alerts, []);
  const after = await service.status();
  assert.equal(after.seenCount, 0);
  assert.notEqual(after.lastCheckIso, before.lastCheckIso);
});

test("first run defaults lastCheckIso to now-24h", async () => {
  const { config, activity } = await setup();
  const before = Date.now();
  let capturedPrompt = "";
  const capturingRunner = {
    run: async (prompt: string): Promise<RunResult> => {
      capturedPrompt = prompt;
      return { runId: "r", provider: "codex", response: "NO_ALERTS", exitCode: 0, durationMs: 1, events: [] };
    },
  } as unknown as ProviderRunner;
  await new MailWatchService(config, activity, capturingRunner).check();
  const match = capturedPrompt.match(/after (\S+) that relate/);
  assert.ok(match, "prompt should embed lastCheckIso");
  const lookback = new Date(match![1]).getTime();
  assert.ok(Math.abs(before - 24 * 60 * 60 * 1000 - lookback) < 5000, "first-run lookback should be ~24h ago");
});

test("dedupes the same alert id across two separate check() calls", async () => {
  const { config, activity } = await setup();
  const response = "ALERT|dup-1|recruiter@acme.com|Assessment invite|Take the test by Friday";
  const first = await new MailWatchService(config, activity, fakeRunner(response)).check();
  const second = await new MailWatchService(config, activity, fakeRunner(response)).check();
  assert.equal(first.alerts.length, 1);
  assert.equal(second.alerts.length, 0);
  const status = await new MailWatchService(config, activity, fakeRunner("NO_ALERTS")).status();
  assert.equal(status.seenCount, 1);
});

test("state file persists across service instances and caps seenIds at 500", async () => {
  const { config, activity } = await setup();
  const manyLines = Array.from({ length: 520 }, (_, i) => `ALERT|id-${i}|from${i}@x.com|Subject ${i}|shortlisted`).join("\n");
  await new MailWatchService(config, activity, fakeRunner(manyLines)).check();
  const raw = JSON.parse(await fs.readFile(config.mailwatchPath, "utf8")) as { seenIds: string[] };
  assert.equal(raw.seenIds.length, 500);
});
