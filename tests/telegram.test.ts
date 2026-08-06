import test from "node:test";
import assert from "node:assert/strict";
import type { HenryConfig } from "../src/config.ts";
import { sendTelegram, TELEGRAM_MAX_CHARS } from "../src/notify/telegram.ts";

function config(overrides: Partial<HenryConfig> = {}): HenryConfig {
  return { telegramBotToken: "test-token", telegramChatId: "12345", ...overrides } as HenryConfig;
}

function stubFetch(impl: typeof fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

test("sendTelegram posts to the Bot API and returns true on 2xx", async () => {
  let calledUrl = "";
  let calledBody: Record<string, unknown> = {};
  const restore = stubFetch(async (url, init) => {
    calledUrl = String(url);
    calledBody = JSON.parse(String(init?.body));
    return new Response(null, { status: 200 });
  });
  try {
    const ok = await sendTelegram(config(), "hello dad");
    assert.equal(ok, true);
    assert.equal(calledUrl, "https://api.telegram.org/bottest-token/sendMessage");
    assert.deepEqual(calledBody, { chat_id: "12345", text: "hello dad", disable_web_page_preview: true });
  } finally { restore(); }
});

test("sendTelegram returns false on a non-2xx response", async () => {
  const restore = stubFetch(async () => new Response(null, { status: 401 }));
  try {
    assert.equal(await sendTelegram(config(), "hi"), false);
  } finally { restore(); }
});

test("sendTelegram returns false (never throws) on an aborted/timed-out request", async () => {
  // Simulates what the real 10s AbortController timeout produces, without waiting 10s:
  // fetch rejecting with an AbortError is exactly what a real timeout looks like to this code.
  const restore = stubFetch(async () => { throw new DOMException("aborted", "AbortError"); });
  try {
    assert.equal(await sendTelegram(config(), "hi"), false);
  } finally { restore(); }
});

test("sendTelegram returns false (never throws) when fetch itself rejects", async () => {
  const restore = stubFetch(async () => { throw new Error("network down"); });
  try {
    assert.equal(await sendTelegram(config(), "hi"), false);
  } finally { restore(); }
});

test("sendTelegram no-ops (returns false, no fetch call) when unconfigured", async () => {
  let called = false;
  const restore = stubFetch(async () => { called = true; return new Response(null, { status: 200 }); });
  try {
    assert.equal(await sendTelegram(config({ telegramBotToken: undefined }), "hi"), false);
    assert.equal(await sendTelegram(config({ telegramChatId: undefined }), "hi"), false);
    assert.equal(called, false);
  } finally { restore(); }
});

test("sendTelegram truncates text longer than the Telegram cap", async () => {
  let sentText = "";
  const restore = stubFetch(async (_url, init) => {
    sentText = (JSON.parse(String(init?.body)) as { text: string }).text;
    return new Response(null, { status: 200 });
  });
  try {
    const long = "x".repeat(TELEGRAM_MAX_CHARS + 500);
    await sendTelegram(config(), long);
    assert.equal(sentText.length, TELEGRAM_MAX_CHARS);
    assert.ok(sentText.endsWith("…"));
  } finally { restore(); }
});
