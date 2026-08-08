import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type HenryConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { StandupStore, istDateKey } from "../src/standup/store.ts";
import { StandupPoller, POLLER_LOCK_STALE_MS } from "../src/standup/poller.ts";
import { StandupService, parseScanResponse, renderFallbackSummary } from "../src/standup/service.ts";
import type { ProviderRunner } from "../src/providers/runner.ts";
import type { HenryMemory } from "../src/memory/engram.ts";

function tempConfig(): HenryConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "henry-standup-"));
  const config = loadConfig(root);
  // Test doubles only — never the real .env values, so no test can touch the live bot.
  config.telegramBotToken = "test-token";
  config.telegramStandupChatId = "-100777";
  return config;
}

async function activityFor(config: HenryConfig): Promise<ActivityLog> {
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  return activity;
}

function fakeRunner(response: string | (() => string)): ProviderRunner {
  return {
    run: async () => ({
      runId: "run-test", provider: "codex" as const, exitCode: 0, durationMs: 1,
      response: typeof response === "function" ? response() : response,
    }),
  } as unknown as ProviderRunner;
}

function fakeMemory(sink: Array<{ text: string; options: Record<string, unknown> }>): HenryMemory {
  return {
    remember: async (text: string, options: Record<string, unknown>) => { sink.push({ text, options }); return "mem-id"; },
  } as unknown as HenryMemory;
}

const TODAY = istDateKey(Math.floor(Date.now() / 1000));

test("store: duplicate messages dedupe, edits replace text and reset quality", () => {
  const config = tempConfig();
  const store = new StandupStore(config);
  const base = { chatId: "-100777", messageId: 5, userId: "u1", userName: "Rohan", date: TODAY, text: "shipped auth flow" };

  assert.equal(store.upsertUpdate(base).fresh, true);
  assert.equal(store.upsertUpdate(base).fresh, false, "re-delivered message must not duplicate");
  const [row] = store.unscanned(TODAY);
  store.markQuality(row.id, "ok", { yesterday: ["auth"], today: [], blockers: [] });
  assert.equal(store.unscanned(TODAY).length, 0);

  store.upsertUpdate({ ...base, text: "shipped auth flow + tests", edited: true });
  const rescan = store.unscanned(TODAY);
  assert.equal(rescan.length, 1, "an edited message must re-enter the scan queue");
  assert.equal(rescan[0].text, "shipped auth flow + tests");
  assert.equal(rescan[0].edited, 1);
  store.close();
});

test("store: istDateKey buckets by the IST calendar day, not UTC", () => {
  // 2026-08-07 19:30 UTC = 2026-08-08 01:00 IST → belongs to the 8th.
  assert.equal(istDateKey(Date.UTC(2026, 7, 7, 19, 30) / 1000), "2026-08-08");
  // 2026-08-07 18:29 UTC = 2026-08-07 23:59 IST → still the 7th.
  assert.equal(istDateKey(Date.UTC(2026, 7, 7, 18, 29) / 1000), "2026-08-07");
});

test("parseScanResponse never trusts the model: bad ids, bad enums, garbage all drop", () => {
  const valid = new Set([1, 2]);
  assert.deepEqual(parseScanResponse("total garbage, no json", valid), { verdicts: [], styles: [] });

  const raw = `Here you go:\n{"updates":[
    {"id":1,"quality":"ok","yesterday":["x"],"today":["y"],"blockers":[]},
    {"id":99,"quality":"ok","yesterday":[],"today":[],"blockers":[]},
    {"id":2,"quality":"amazing","yesterday":[],"today":[],"blockers":[]},
    {"id":2,"quality":"vague","clarify":"which API?","yesterday":[],"today":[],"blockers":[]}
  ],"styles":[{"userId":"u1","person":"Rohan","profile":"short, casual, hinglish"},{"userId":"u2","profile":"   "}]}\ndone.`;
  const parsed = parseScanResponse(raw, valid);
  assert.equal(parsed.verdicts.length, 2, "unknown id 99 and invalid quality must drop");
  assert.equal(parsed.verdicts[0].id, 1);
  assert.equal(parsed.verdicts[1].clarify, "which API?");
  assert.equal(parsed.styles.length, 1, "blank profile must drop");
  // ok rows never carry a clarification even if the model added one
  const okRow = parseScanResponse(`{"updates":[{"id":1,"quality":"ok","clarify":"why?","yesterday":[],"today":[],"blockers":[]}],"styles":[]}`, valid);
  assert.equal(okRow.verdicts[0].clarify, undefined);
});

test("scan: classifies, remembers content, nudges vague authors in-thread — once per person per day", async () => {
  const config = tempConfig();
  const store = new StandupStore(config);
  const activity = await activityFor(config);
  const memories: Array<{ text: string; options: Record<string, unknown> }> = [];
  const pings: Array<{ text: string; replyTo?: number }> = [];
  const sender = async (_config: HenryConfig, text: string, replyTo?: number) => { pings.push({ text, replyTo }); return true; };

  store.upsertUpdate({ chatId: "-100777", messageId: 1, userId: "u1", userName: "Rohan", date: TODAY, text: "did stuff" });
  store.upsertUpdate({ chatId: "-100777", messageId: 2, userId: "u2", userName: "Priya", date: TODAY, text: "yday: shipped payments retry; today: metrics dashboard; blocker: waiting on Luvish approval" });
  store.upsertUpdate({ chatId: "-100777", messageId: 3, userId: "u3", userName: "Amit", date: TODAY, text: "good morning ☀️" });
  const ids = store.unscanned(TODAY).map((row) => row.id);

  const runner = fakeRunner(JSON.stringify({
    updates: [
      { id: ids[0], quality: "vague", yesterday: [], today: [], blockers: [], clarify: "Rohan bhai, kya stuff? one line more detail?" },
      { id: ids[1], quality: "ok", yesterday: ["shipped payments retry"], today: ["metrics dashboard"], blockers: ["waiting on Luvish approval"] },
      { id: ids[2], quality: "offtopic", yesterday: [], today: [], blockers: [] },
    ],
    styles: [
      { userId: "u1", person: "Rohan", profile: "very short, casual hinglish" },
      { userId: "u2", person: "Priya", profile: "structured, formal, no emoji" },
    ],
  }));
  const service = new StandupService(config, activity, runner, store, undefined, fakeMemory(memories), sender);

  const first = await service.scan(TODAY);
  assert.equal(first.scanned, 3);
  assert.equal(first.clarificationsSent, 1, "only the vague update gets a ping");
  assert.equal(pings[0].replyTo, 1, "clarification must be a threaded reply to the vague message");
  assert.match(pings[0].text, /Rohan bhai/);
  assert.equal(first.stylesUpdated, 2);

  const standupMemories = memories.filter((entry) => (entry.options.metadata as Record<string, unknown>)?.domain === "standup");
  assert.equal(standupMemories.length, 2, "offtopic banter must not be remembered");
  const styleMemories = memories.filter((entry) => (entry.options.metadata as Record<string, unknown>)?.domain === "style");
  assert.equal(styleMemories.length, 2);
  assert.match(styleMemories[0].text, /Talking style — Rohan/);

  // Rohan posts vaguely AGAIN the same day — the ≤1/person/day rail must hold.
  store.upsertUpdate({ chatId: "-100777", messageId: 4, userId: "u1", userName: "Rohan", date: TODAY, text: "more stuff" });
  const secondId = store.unscanned(TODAY)[0].id;
  const runner2 = fakeRunner(JSON.stringify({
    updates: [{ id: secondId, quality: "vague", yesterday: [], today: [], blockers: [], clarify: "aur detail?" }],
    styles: [],
  }));
  const service2 = new StandupService(config, activity, runner2, store, undefined, fakeMemory(memories), sender);
  const second = await service2.scan(TODAY);
  assert.equal(second.clarificationsSent, 0, "one clarification per person per day, never more");
  assert.equal(pings.length, 1);
  store.close();
});

test("summarize: provider failure falls back, Missing is code-computed, Luvish-blocker escalates", async () => {
  const config = tempConfig();
  const store = new StandupStore(config);
  const activity = await activityFor(config);
  const memories: Array<{ text: string; options: Record<string, unknown> }> = [];
  const notifications: Array<{ message: string; title?: string }> = [];
  const sender = async () => true;
  const notify = async (message: string, title?: string) => { notifications.push({ message, title }); };

  store.upsertUpdate({ chatId: "-100777", messageId: 1, userId: "u2", userName: "Priya", date: TODAY, text: "raw text" });
  const [row] = store.unscanned(TODAY);
  store.markQuality(row.id, "ok", { yesterday: ["shipped retry"], today: ["metrics"], blockers: ["waiting on Luvish approval"] });
  // Roster knows Rohan too — he didn't post today, so he must land in Missing.
  store.upsertStyle("u1", "Rohan", "short, casual", 1);
  store.upsertStyle("u2", "Priya", "formal", 1);

  const failingRunner = { run: async () => { throw new Error("provider down"); } } as unknown as ProviderRunner;
  const service = new StandupService(config, activity, failingRunner, store, notify, fakeMemory(memories), sender);
  const result = await service.summarize(TODAY);

  assert.ok(result.markdown, "fallback render must produce a summary when the provider dies");
  assert.match(result.markdown!, /Priya/);
  assert.match(result.markdown!, /### Missing\n- Rohan/);
  assert.ok(result.filePath && fs.existsSync(result.filePath), "per-day markdown artifact must be written");
  assert.ok(store.getSummary(TODAY), "summary must persist in sqlite");

  const summaryMemory = memories.find((entry) => (entry.options.metadata as Record<string, unknown>)?.kind === "daily-summary");
  assert.equal(summaryMemory?.options.importance, 8, "a blocker naming Luvish escalates the memory");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /blocker names you/);
  store.close();
});

test("summarize with zero content: no provider spend, roster silence still notifies", async () => {
  const config = tempConfig();
  const store = new StandupStore(config);
  const activity = await activityFor(config);
  const notifications: string[] = [];
  let runnerCalls = 0;
  const runner = { run: async () => { runnerCalls += 1; return { response: "x" }; } } as unknown as ProviderRunner;
  store.upsertStyle("u1", "Rohan", "short", 1);

  const service = new StandupService(config, activity, runner, store, async (message) => { notifications.push(message); }, undefined, async () => true);
  const result = await service.summarize(TODAY);
  assert.equal(result.empty, true);
  assert.equal(runnerCalls, 0, "an empty day must not spend a provider call");
  assert.deepEqual(result.missing, ["Rohan"]);
  assert.match(notifications[0], /nobody posted/);
  store.close();
});

test("promptDay is idempotent per day and honest when unconfigured", async () => {
  const config = tempConfig();
  const store = new StandupStore(config);
  const activity = await activityFor(config);
  const pings: string[] = [];
  const sender = async (_config: HenryConfig, text: string) => { pings.push(text); return true; };
  const service = new StandupService(config, activity, fakeRunner("{}"), store, undefined, undefined, sender);

  assert.equal((await service.promptDay(TODAY)).sent, true);
  assert.equal((await service.promptDay(TODAY)).sent, false, "a re-fired cron must not double-prompt");
  assert.equal(pings.length, 1);

  config.telegramStandupChatId = undefined;
  const unconfigured = await service.promptDay(TODAY);
  assert.equal(unconfigured.sent, false);
  assert.match(unconfigured.reason!, /not configured/);
  store.close();
});

test("poller: stores only group text messages, skips bots, advances offset after storing", async () => {
  const config = tempConfig();
  const store = new StandupStore(config);
  const activity = await activityFor(config);
  const seenUrls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    seenUrls.push(String(url));
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, result: [
        { update_id: 10, message: { message_id: 1, date: 1754640000, text: "standup yaha", chat: { id: -100777, type: "supergroup" }, from: { id: 7, first_name: "Rohan" } } },
        { update_id: 11, message: { message_id: 2, date: 1754640001, text: "other chat", chat: { id: -555, type: "group" }, from: { id: 8, first_name: "X" } } },
        { update_id: 12, message: { message_id: 3, date: 1754640002, text: "bot echo", chat: { id: -100777, type: "supergroup" }, from: { id: 9, is_bot: true, first_name: "Henry" } } },
        { update_id: 13, edited_message: { message_id: 1, date: 1754640000, text: "standup yaha (edited)", chat: { id: -100777, type: "supergroup" }, from: { id: 7, first_name: "Rohan" } } },
      ] }),
    };
  }) as unknown as typeof fetch;

  const poller = new StandupPoller(config, activity, store, fetchImpl);
  const result = await poller.pollOnce();
  assert.equal(result.polled, true);
  assert.equal(result.seenUpdates, 4);
  assert.equal(result.stored, 1, "only the one real group message is new");
  const rows = store.unscanned(istDateKey(1754640000));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "standup yaha (edited)", "the edit must have replaced the text");
  assert.equal(store.getMeta("poller:lastUpdateId"), "13");

  await poller.pollOnce();
  assert.match(seenUrls[1], /offset=14/, "next poll must confirm past the last update id");
  poller.stop();
  store.close();
});

test("poller: refuses to run while another live process holds the lock; 409 backs off", async () => {
  const config = tempConfig();
  const store = new StandupStore(config);
  const activity = await activityFor(config);
  const fetchImpl = (async () => ({ ok: false, status: 409, json: async () => ({ ok: false }) })) as unknown as typeof fetch;
  const poller = new StandupPoller(config, activity, store, fetchImpl);

  // pid 1 (launchd) is always alive on macOS — a fresh lock held by it must block us.
  store.setMeta("poller:lock", `1:${Date.now()}`);
  const blocked = await poller.pollOnce();
  assert.equal(blocked.polled, false);
  assert.match(blocked.reason!, /another process/);

  // A stale lock (holder heartbeat too old) is taken over — then the 409 path reports the conflict.
  store.setMeta("poller:lock", `1:${Date.now() - POLLER_LOCK_STALE_MS - 1}`);
  const conflicted = await poller.pollOnce();
  assert.equal(conflicted.polled, false);
  assert.match(conflicted.reason!, /409/);
  store.close();
});

test("fallback summary renders parsed rows and raw fallbacks deterministically", () => {
  const rows = [
    { id: 1, chatId: "-1", messageId: 1, userId: "u1", userName: "Rohan", date: "2026-08-08", text: "raw", receivedAt: "", edited: 0, quality: "ok" as const, clarified: 0, parsed: { yesterday: ["a"], today: ["b"], blockers: ["stuck on infra"] } },
    { id: 2, chatId: "-1", messageId: 2, userId: "u2", userName: "Priya", date: "2026-08-08", text: "plain words only", receivedAt: "", edited: 0, quality: "vague" as const, clarified: 1, parsed: null },
  ];
  const markdown = renderFallbackSummary("2026-08-08", rows);
  assert.match(markdown, /## Team standup — 2026-08-08/);
  assert.match(markdown, /- Yesterday: a/);
  assert.match(markdown, /- plain words only/);
  assert.match(markdown, /- Rohan: stuck on infra/);
});
