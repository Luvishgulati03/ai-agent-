import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HenryRuntime } from "../src/runtime.ts";
import { startDashboard } from "../src/dashboard/server.ts";

test("dashboard exposes local health and status APIs", async () => {
  const runtime = await HenryRuntime.create();
  runtime.config.port = 0;
  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const health = await (await fetch(`${base}/api/health`)).json() as { ok: boolean };
  const status = await (await fetch(`${base}/api/status`)).json() as { name: string; user: string };
  assert.equal(health.ok, true);
  assert.equal(status.name, "Henry");
  assert.equal(status.user, "Luvish");
  const crossOrigin = await fetch(`${base}/api/ask`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ prompt: "hello" }) });
  assert.equal(crossOrigin.status, 403);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  runtime.close();
});

test("web chat: page serves, SSE send streams tokens, transcript persists, clear resets", async () => {
  // Isolated root so the test never touches the real data/chats transcript.
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "henry-chat-"));
  fs.cpSync(path.join(process.cwd(), "workflows"), path.join(tempRoot, "workflows"), { recursive: true });
  const runtime = await HenryRuntime.create(tempRoot);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";

  // The chat rides agent.run — stub it to stream two chunks then return the final text.
  (runtime.agent as unknown as { run: unknown }).run = async (_prompt: string, options?: { onEvent?: (event: { timestamp: string; stream: string; text: string; parsed?: Record<string, unknown> }) => void }) => {
    options?.onEvent?.({ timestamp: "", stream: "stdout", text: "", parsed: { text: "Hello " } });
    options?.onEvent?.({ timestamp: "", stream: "stdout", text: "", parsed: { text: "Luvish!" } });
    return { runId: "run-1", provider: "claude", response: "Hello Luvish!", exitCode: 0, durationMs: 12, events: [] };
  };

  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${base}/chat`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Message Henry/);

  const send = await fetch(`${base}/api/chat/send`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "hi" }),
  });
  assert.equal(send.status, 200);
  assert.match(send.headers.get("content-type") || "", /text\/event-stream/);
  const stream = await send.text();
  assert.match(stream, /event: token/);
  assert.match(stream, /Hello /);
  assert.match(stream, /event: done/);
  assert.match(stream, /Hello Luvish!/);

  const history = await (await fetch(`${base}/api/chat/history`)).json() as { messages: Array<{ role: string; text: string }> };
  assert.equal(history.messages.length, 2, "user + henry messages must persist");
  assert.equal(history.messages[0].role, "user");
  assert.equal(history.messages[1].text, "Hello Luvish!");

  const clear = await fetch(`${base}/api/chat/clear`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(clear.status, 200);
  const cleared = await (await fetch(`${base}/api/chat/history`)).json() as { messages: unknown[] };
  assert.equal(cleared.messages.length, 0);

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  runtime.close();
});
