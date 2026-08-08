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

// --- Randomized 5-checks/day plan (Luvish's request: cut codex calls ~6x vs. a check on every tick) ---

test("plan() generates 5 sorted times within the 08:00-23:00 local window", async () => {
  const { config, activity } = await setup();
  const service = new MailWatchService(config, activity, fakeRunner("NO_ALERTS"));
  const now = new Date(2026, 0, 15, 6, 0, 0);
  const plan = await service.plan(now);
  assert.equal(plan.date, "2026-01-15");
  assert.equal(plan.times.length, 5);
  assert.deepEqual(plan.fired, []);
  const sorted = [...plan.times].sort();
  assert.deepEqual(plan.times, sorted, "times must be sorted ascending");
  for (const iso of plan.times) {
    const local = new Date(iso);
    assert.equal(local.getFullYear(), 2026);
    assert.equal(local.getMonth(), 0);
    assert.equal(local.getDate(), 15);
    assert.ok(local.getHours() >= 8 && local.getHours() < 23, `${iso} must fall within 08:00-23:00 local`);
  }
  const uniqueMinutes = new Set(plan.times.map((iso) => new Date(iso).getHours() * 60 + new Date(iso).getMinutes()));
  assert.equal(uniqueMinutes.size, 5, "the 5 planned times must be distinct");
});

test("plan() is stable within a day and regenerates on date change", async () => {
  const { config, activity } = await setup();
  const service = new MailWatchService(config, activity, fakeRunner("NO_ALERTS"));
  const day1 = new Date(2026, 0, 15, 9, 0, 0);
  const first = await service.plan(day1);
  const second = await service.plan(new Date(2026, 0, 15, 20, 0, 0));
  assert.deepEqual(second, first, "same local day returns the persisted plan unchanged");

  const day2 = new Date(2026, 0, 16, 9, 0, 0);
  const third = await service.plan(day2);
  assert.equal(third.date, "2026-01-16");
  assert.notDeepEqual(third.times, first.times, "a new local day gets freshly generated times");
});

test("plan persists across service instances (re-read, not regenerated)", async () => {
  const { config, activity } = await setup();
  const now = new Date(2026, 0, 15, 9, 0, 0);
  const first = await new MailWatchService(config, activity, fakeRunner("NO_ALERTS")).plan(now);
  const second = await new MailWatchService(config, activity, fakeRunner("NO_ALERTS")).plan(now);
  assert.deepEqual(second, first);
  const raw = JSON.parse(await fs.readFile(config.mailwatchPlanPath, "utf8")) as { date: string; times: string[] };
  assert.deepEqual(raw.times, first.times);
});

test("tick() skips and reports nextPlannedAt when no planned time is due yet", async () => {
  const { config, activity } = await setup();
  const service = new MailWatchService(config, activity, fakeRunner("NO_ALERTS"));
  const now = new Date(2026, 0, 15, 8, 0, 0);
  const plan = await service.plan(now);
  const before = new Date(new Date(plan.times[0]).getTime() - 60_000); // 1 min before the first planned check
  const result = await service.tick(before);
  assert.deepEqual(result, { skipped: true, reason: "no planned mailwatch check due yet", nextPlannedAt: plan.times[0] });
});

test("tick() runs the real check exactly once when a planned time is due, then dedupes that index", async () => {
  const { config, activity } = await setup();
  let calls = 0;
  const countingRunner = {
    run: async (): Promise<RunResult> => { calls += 1; return { runId: `r${calls}`, provider: "codex", response: "NO_ALERTS", exitCode: 0, durationMs: 1, events: [] }; },
  } as unknown as ProviderRunner;
  const service = new MailWatchService(config, activity, countingRunner);
  const now = new Date(2026, 0, 15, 8, 0, 0);
  const plan = await service.plan(now);
  const due = new Date(plan.times[0]);

  const result = await service.tick(due);
  assert.equal(calls, 1, "a due planned time triggers exactly one real check");
  assert.ok("alerts" in result, "a fired tick returns the check() result shape");

  const afterFire = await service.plan(due);
  assert.deepEqual(afterFire.fired, [0]);

  // Ticking again at the same due time must not re-fire the same index.
  const secondTick = await service.tick(due);
  assert.equal(calls, 1, "the same planned index never fires twice");
  assert.deepEqual(secondTick, {
    skipped: true,
    reason: "no planned mailwatch check due yet",
    nextPlannedAt: plan.times[1],
  });
});

test("status() surfaces today's plan alongside the existing fields", async () => {
  const { config, activity } = await setup();
  const service = new MailWatchService(config, activity, fakeRunner("NO_ALERTS"));
  const now = new Date(2026, 0, 15, 8, 0, 0);
  const status = await service.status(now);
  assert.equal(status.plan.date, "2026-01-15");
  assert.equal(status.plan.times.length, 5);
  assert.deepEqual(status.plan.fired, []);
  assert.deepEqual(status.plan.pending, status.plan.times);
  assert.equal(status.plan.nextPlannedAt, status.plan.times[0]);
});
