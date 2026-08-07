import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { MailWatchService, type MailWatchNotifier } from "../src/mailwatch/service.ts";
import { parseAppLine, updateTracker, trackerSummary, renderMarkdown } from "../src/mailwatch/tracker.ts";
import type { ProviderRunner } from "../src/providers/runner.ts";
import type { RunResult } from "../src/types.ts";

async function setup(): Promise<{ config: ReturnType<typeof loadConfig>; activity: ActivityLog }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-jobtracker-"));
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

test("parseAppLine parses well-formed APP lines and rejects garbage", () => {
  const good = parseAppLine("APP|Acme Corp|SWE Intern|LinkedIn|applied|Aug 1|Your application was sent to Acme Corp");
  assert.deepEqual(good, {
    company: "Acme Corp", role: "SWE Intern", source: "LinkedIn", status: "applied",
    dateText: "Aug 1", subject: "Your application was sent to Acme Corp",
  });
  assert.equal(parseAppLine("NO_ALERTS"), undefined);
  assert.equal(parseAppLine(""), undefined);
  assert.equal(parseAppLine("just some prose"), undefined);
  assert.equal(parseAppLine("APP|only|four|parts"), undefined);
  // Unknown status is rejected.
  assert.equal(parseAppLine("APP|Acme|SWE|LinkedIn|ghosted|Aug 1|subject"), undefined);
  // Missing company is rejected.
  assert.equal(parseAppLine("APP||SWE|LinkedIn|applied|Aug 1|subject"), undefined);
  // A subject containing a pipe is preserved via the greedy trailing join.
  const withPipe = parseAppLine("APP|Acme|SWE|LinkedIn|applied|Aug 1|Re: Application | Acme Corp");
  assert.equal(withPipe?.subject, "Re: Application | Acme Corp");
});

test("updateTracker: a new application creates an entry and regenerates the markdown ledger", async () => {
  const { config } = await setup();
  const result = await updateTracker(config, [
    "APP|Acme Corp|SWE Intern|LinkedIn|applied|Aug 1|Your application was sent to Acme Corp",
  ]);
  assert.equal(result.created, 1);
  assert.equal(result.changed, 0);
  assert.deepEqual(result.notifications, ["📋 Application update: Acme Corp SWE Intern → applied"]);

  const summary = await trackerSummary(config);
  assert.equal(summary.total, 1);
  assert.equal(summary.byStatus.applied, 1);

  const md = await fs.readFile(config.jobTrackerMarkdownPath, "utf8");
  assert.match(md, /\| Company \| Role \| Source \| Current status \| Applied \| Last update \|/);
  assert.match(md, /\| Acme Corp \| SWE Intern \| LinkedIn \| applied \| Aug 1 \|/);
  assert.match(md, /### Acme Corp — SWE Intern/);
});

test("updateTracker: a repeated identical status line does not duplicate history or re-notify", async () => {
  const { config } = await setup();
  const line = "APP|Acme Corp|SWE Intern|LinkedIn|applied|Aug 1|Your application was sent to Acme Corp";
  const first = await updateTracker(config, [line]);
  assert.equal(first.created, 1);
  const second = await updateTracker(config, [line]);
  assert.equal(second.created, 0);
  assert.equal(second.changed, 0);
  assert.deepEqual(second.notifications, []);

  const raw = JSON.parse(await fs.readFile(config.jobTrackerPath, "utf8")) as { entries: Array<{ history: unknown[] }> };
  assert.equal(raw.entries.length, 1);
  assert.equal(raw.entries[0].history.length, 1);
});

test("updateTracker: a status transition appends history and notifies", async () => {
  const { config } = await setup();
  await updateTracker(config, ["APP|Acme Corp|SWE Intern|LinkedIn|applied|Aug 1|Your application was sent to Acme Corp"]);
  const transition = await updateTracker(config, ["APP|Acme Corp|SWE Intern|LinkedIn|shortlisted|Aug 5|You've been shortlisted!"]);
  assert.equal(transition.created, 0);
  assert.equal(transition.changed, 1);
  assert.deepEqual(transition.notifications, ["📋 Application update: Acme Corp SWE Intern → shortlisted"]);

  const raw = JSON.parse(await fs.readFile(config.jobTrackerPath, "utf8")) as {
    entries: Array<{ status: string; appliedAt: string; history: Array<{ status: string }> }>;
  };
  assert.equal(raw.entries.length, 1);
  assert.equal(raw.entries[0].status, "shortlisted");
  assert.equal(raw.entries[0].appliedAt, "Aug 1", "appliedAt stays pinned to the first (applied) history entry");
  assert.deepEqual(raw.entries[0].history.map((h) => h.status), ["applied", "shortlisted"]);
});

test("updateTracker: malformed APP lines are skipped without throwing", async () => {
  const { config } = await setup();
  const result = await updateTracker(config, [
    "APP|Acme Corp|SWE Intern|LinkedIn|applied|Aug 1|Your application was sent to Acme Corp",
    "APP|missing|fields",
    "APP|Beta Inc|PM|Naukri|not-a-real-status|Aug 2|subject",
    "just some prose",
    "",
  ]);
  assert.equal(result.created, 1);
  assert.equal(result.changed, 0);
  const summary = await trackerSummary(config);
  assert.equal(summary.total, 1);
});

test("updateTracker: two different companies each get their own entry, sorted last-update desc in the markdown", async () => {
  const { config } = await setup();
  await updateTracker(config, ["APP|Acme Corp|SWE Intern|LinkedIn|applied|Aug 1|subject A"]);
  await updateTracker(config, ["APP|Beta Inc|PM|Naukri|applied|Aug 2|subject B"]);
  const md = await fs.readFile(config.jobTrackerMarkdownPath, "utf8");
  const acmeIndex = md.indexOf("| Acme Corp |");
  const betaIndex = md.indexOf("| Beta Inc |");
  assert.ok(betaIndex >= 0 && acmeIndex >= 0);
  assert.ok(betaIndex < acmeIndex, "the more recently updated company (Beta Inc) sorts first");
});

test("renderMarkdown produces a well-formed table and history section, and a friendly empty state", () => {
  const empty = renderMarkdown({ entries: [] });
  assert.match(empty, /No applications tracked yet/);

  const md = renderMarkdown({
    entries: [{
      key: "acme corp::swe intern", company: "Acme Corp", role: "SWE Intern", source: "LinkedIn",
      status: "interview", appliedAt: "Aug 1", lastUpdate: "Aug 10",
      history: [
        { status: "applied", dateText: "Aug 1", subject: "Applied", recordedAt: "2026-08-01T00:00:00.000Z" },
        { status: "interview", dateText: "Aug 10", subject: "Interview!", recordedAt: "2026-08-10T00:00:00.000Z" },
      ],
    }],
  });
  const tableLines = md.split("\n").filter((l) => l.startsWith("|"));
  assert.equal(tableLines.length, 3, "header + separator + one data row");
  assert.match(md, /- Aug 1 — \*\*applied\*\* — "Applied"/);
  assert.match(md, /- Aug 10 — \*\*interview\*\* — "Interview!"/);
});

test("MailWatchService.check(): APP lines update the tracker and notify only on new/changed status", async () => {
  const { config, activity } = await setup();
  const response = [
    "ALERT|msg-1|recruiter@acme.com|You've been shortlisted|Shortlisting notice",
    "APP|Acme Corp|SWE Intern|LinkedIn|applied|Aug 1|Your application was sent to Acme Corp",
    "APP|Acme Corp|SWE Intern|LinkedIn|shortlisted|Aug 5|You've been shortlisted!",
  ].join("\n");
  const { notify, messages } = fakeNotifier();
  const service = new MailWatchService(config, activity, fakeRunner(response), notify);
  await service.check();

  const trackerMessages = messages.filter((m) => m.title === "Henry — job tracker");
  assert.equal(trackerMessages.length, 2, "one notify for the new application, one for the transition to shortlisted");
  assert.equal(trackerMessages[0].message, "📋 Application update: Acme Corp SWE Intern → applied");
  assert.equal(trackerMessages[1].message, "📋 Application update: Acme Corp SWE Intern → shortlisted");

  const summary = await trackerSummary(config);
  assert.equal(summary.total, 1);
  assert.equal(summary.byStatus.shortlisted, 1);

  // A later check() re-scanning a window where the same "shortlisted" email is still visible
  // (its current, unchanged status) must not re-notify the tracker.
  const repeatService = new MailWatchService(
    config, activity,
    fakeRunner("APP|Acme Corp|SWE Intern|LinkedIn|shortlisted|Aug 5|You've been shortlisted!"),
    notify,
  );
  await repeatService.check();
  const trackerMessagesAfter = messages.filter((m) => m.title === "Henry — job tracker");
  assert.equal(trackerMessagesAfter.length, 2, "the repeat check must not duplicate tracker notifications");
});

test("MailWatchService.backfill(): seeds the tracker from a single read-only provider call without touching mailwatch state", async () => {
  const { config, activity } = await setup();
  const response = [
    "APP|Gamma LLC|Backend Engineer|direct|applied|Jul 20|Thanks for applying to Gamma LLC",
    "APP|Gamma LLC|Backend Engineer|direct|rejected|Jul 28|Update on your application",
  ].join("\n");
  const { notify, messages } = fakeNotifier();
  // Establish real, persisted mailwatch state via a normal check() first, so the "unchanged by
  // backfill" comparison below is against a concrete written value rather than two independently
  // computed first-run defaults (which would differ by measurement noise alone).
  await new MailWatchService(config, activity, fakeRunner("NO_ALERTS")).check();
  const beforeStatus = await new MailWatchService(config, activity, fakeRunner("NO_ALERTS")).status();

  const service = new MailWatchService(config, activity, fakeRunner(response), notify);
  const result = await service.backfill(21);
  assert.equal(result.appLines, 2);
  assert.equal(result.created, 1);
  assert.equal(result.changed, 1);
  assert.equal(messages.length, 2);

  const afterStatus = await service.status();
  assert.equal(afterStatus.lastCheckIso, beforeStatus.lastCheckIso, "backfill must not touch check()'s lastCheckIso");
  assert.equal(afterStatus.seenCount, beforeStatus.seenCount, "backfill must not touch check()'s seenIds");

  const summary = await trackerSummary(config);
  assert.equal(summary.total, 1);
  assert.equal(summary.byStatus.rejected, 1);
});
