import test from "node:test";
import assert from "node:assert/strict";
import { LavuRuntime } from "../src/runtime.ts";
import { startDashboard } from "../src/dashboard/server.ts";

test("dashboard exposes local health and status APIs", async () => {
  const runtime = await LavuRuntime.create();
  runtime.config.port = 0;
  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const health = await (await fetch(`${base}/api/health`)).json() as { ok: boolean };
  const status = await (await fetch(`${base}/api/status`)).json() as { name: string; user: string };
  assert.equal(health.ok, true);
  assert.equal(status.name, "Lavu");
  assert.equal(status.user, "Dad");
  const crossOrigin = await fetch(`${base}/api/ask`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ prompt: "hello" }) });
  assert.equal(crossOrigin.status, 403);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  runtime.close();
});
