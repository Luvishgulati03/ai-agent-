import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import {
  ReminderService,
  parseAt,
  parseIn,
  REMINDER_OVERDUE_GRACE_MS,
  type ReminderNotifier,
} from "../src/reminders/service.ts";

async function setup(): Promise<{ config: ReturnType<typeof loadConfig>; activity: ActivityLog }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-reminders-"));
  const config = loadConfig(rootDir);
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  return { config, activity };
}

function fakeNotifier(): { notify: ReminderNotifier; messages: string[] } {
  const messages: string[] = [];
  const notify: ReminderNotifier = async (message) => { messages.push(message); };
  return { notify, messages };
}

test("parseAt parses 'YYYY-MM-DD HH:mm' as local time", () => {
  const date = parseAt("2026-08-10 14:30");
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 7);
  assert.equal(date.getDate(), 10);
  assert.equal(date.getHours(), 14);
  assert.equal(date.getMinutes(), 30);
});

test("parseAt also accepts a 'T' separator", () => {
  const date = parseAt("2026-08-10T14:30");
  assert.equal(date.getHours(), 14);
});

test("parseAt rejects malformed input", () => {
  assert.throws(() => parseAt("not-a-date"), /Invalid --at value/);
  assert.throws(() => parseAt("2026/08/10 14:30"), /Invalid --at value/);
});

test("parseIn parses single-unit durations", () => {
  const from = new Date("2026-08-06T10:00:00");
  assert.equal(parseIn("30m", from).getTime(), from.getTime() + 30 * 60_000);
  assert.equal(parseIn("2h", from).getTime(), from.getTime() + 2 * 3_600_000);
  assert.equal(parseIn("1d", from).getTime(), from.getTime() + 86_400_000);
});

test("parseIn parses combined durations like '1h30m'", () => {
  const from = new Date("2026-08-06T10:00:00");
  assert.equal(parseIn("1h30m", from).getTime(), from.getTime() + 90 * 60_000);
});

test("parseIn rejects unparseable durations", () => {
  assert.throws(() => parseIn("soon"), /Invalid --in duration/);
});

test("create() persists a pending reminder to disk", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const dueAt = new Date(Date.now() + 3_600_000);

  const reminder = await service.create("Call the recruiter", dueAt);

  assert.equal(reminder.status, "pending");
  assert.equal(reminder.text, "Call the recruiter");
  const onDisk = JSON.parse(await fs.readFile(config.remindersPath, "utf8"));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].id, reminder.id);
});

test("list() supports filtering by status", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const a = await service.create("A", new Date(Date.now() + 60_000));
  await service.create("B", new Date(Date.now() + 120_000));
  await service.cancel(a.id);

  const pending = await service.list("pending");
  const cancelled = await service.list("cancelled");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].text, "B");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].text, "A");
});

test("cancel() only allows cancelling pending reminders", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const reminder = await service.create("A", new Date(Date.now() + 60_000));
  await service.cancel(reminder.id);
  await assert.rejects(() => service.cancel(reminder.id), /only pending reminders can be cancelled/);
});

test("cancel() throws for an unknown id", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  await assert.rejects(() => service.cancel("nope"), /Reminder not found/);
});

test("fireDue() fires only pending reminders that are due, notifies, and updates status", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const now = new Date("2026-08-06T12:00:00Z");
  const due = await service.create("Due now", new Date(now.getTime() - 1000));
  const notYetDue = await service.create("Not yet", new Date(now.getTime() + 3_600_000));

  const { notify, messages } = fakeNotifier();
  const fired = await service.fireDue(notify, now);

  assert.equal(fired.length, 1);
  assert.equal(fired[0].id, due.id);
  assert.equal(fired[0].status, "fired");
  assert.deepEqual(messages, ["Due now"]);

  assert.equal((await service.get(due.id))?.status, "fired");
  assert.equal((await service.get(notYetDue.id))?.status, "pending");

  const events = await activity.list(10);
  assert.ok(events.some((event) => event.kind === "workflow.completed" && event.metadata?.reminder === true && event.metadata?.id === due.id));
});

test("fireDue() is fire-once: a second call does not re-fire an already-fired reminder", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const now = new Date("2026-08-06T12:00:00Z");
  await service.create("Due now", new Date(now.getTime() - 1000));

  const { notify, messages } = fakeNotifier();
  await service.fireDue(notify, now);
  const secondFired = await service.fireDue(notify, new Date(now.getTime() + 60_000));

  assert.equal(secondFired.length, 0);
  assert.equal(messages.length, 1);
});

test("fireDue() prefixes '(overdue)' when firing well past the due time (daemon was down)", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const dueAt = new Date("2026-08-06T09:00:00Z");
  const reminder = await service.create("Ping recruiter", dueAt);

  const wellPastDue = new Date(dueAt.getTime() + REMINDER_OVERDUE_GRACE_MS + 60_000);
  const { notify, messages } = fakeNotifier();
  const fired = await service.fireDue(notify, wellPastDue);

  assert.equal(fired.length, 1);
  assert.match(messages[0], /^\(overdue\) Ping recruiter$/);
  const events = await activity.list(10);
  const event = events.find((item) => item.metadata?.id === reminder.id);
  assert.equal(event?.metadata?.overdue, true);
});

test("fireDue() does not prefix '(overdue)' when firing within the normal poll grace window", async () => {
  const { config, activity } = await setup();
  const service = new ReminderService(config, activity);
  const dueAt = new Date("2026-08-06T09:00:00Z");
  await service.create("Ping recruiter", dueAt);

  const withinGrace = new Date(dueAt.getTime() + 30_000);
  const { notify, messages } = fakeNotifier();
  await service.fireDue(notify, withinGrace);

  assert.equal(messages[0], "Ping recruiter");
});
