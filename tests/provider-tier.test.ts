import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityLog } from "../src/activity.ts";
import { AdmissionController } from "../src/orchestration/admission.ts";
import {
  CODEX_T0_MODEL,
  ENVELOPE_TIMEOUT_ERROR,
  ProviderRunner,
  buildProviderArgs,
  claudeArgs,
  codexArgs,
  execute,
} from "../src/providers/runner.ts";
import type { HenryConfig } from "../src/config.ts";
import type { ActivityEvent } from "../src/types.ts";

const PROMPT = "do the thing";

test("t0 routes to the cheap models on both CLIs", () => {
  const claude = claudeArgs(PROMPT, { tier: "t0" });
  assert.deepEqual(claude, ["-p", "--model", "haiku", PROMPT, "--dangerously-skip-permissions"]);

  const codex = codexArgs(PROMPT, { readOnly: true, tier: "t0" });
  assert.equal(codex[1], "-m");
  assert.equal(codex[2], CODEX_T0_MODEL);
  assert.ok(!codex.includes('model_reasoning_effort="high"'), "t0 must not raise reasoning effort");
});

test("t0 overrides a configured heavy model rather than inheriting it", () => {
  assert.deepEqual(
    claudeArgs(PROMPT, { tier: "t0", model: "opus" }),
    ["-p", "--model", "haiku", PROMPT, "--dangerously-skip-permissions"],
  );
  const codex = codexArgs(PROMPT, { readOnly: false, tier: "t0", model: "gpt-5-codex" });
  assert.deepEqual(codex.slice(0, 3), ["exec", "-m", CODEX_T0_MODEL]);
});

test("t1 and an absent tier keep the configured default models", () => {
  assert.deepEqual(
    claudeArgs(PROMPT, { tier: "t1", model: "sonnet" }),
    ["-p", "--model", "sonnet", PROMPT, "--dangerously-skip-permissions"],
  );
  assert.deepEqual(
    claudeArgs(PROMPT, {}),
    ["-p", PROMPT, "--dangerously-skip-permissions"],
    "no tier and no configured model leaves the CLI default untouched",
  );
  const codexDefault = codexArgs(PROMPT, { readOnly: false });
  assert.equal(codexDefault[1], "--json", "no -m flag when nothing is configured");
  assert.ok(!codexDefault.some((arg) => arg.includes("model_reasoning_effort")));
  const codexConfigured = codexArgs(PROMPT, { readOnly: false, tier: "t1", model: "gpt-5-codex" });
  assert.deepEqual(codexConfigured.slice(0, 3), ["exec", "-m", "gpt-5-codex"]);
});

test("t2 routes to opus and high Codex reasoning effort", () => {
  assert.deepEqual(
    claudeArgs(PROMPT, { tier: "t2", model: "sonnet" }),
    ["-p", "--model", "opus", PROMPT, "--dangerously-skip-permissions"],
  );
  const codex = codexArgs(PROMPT, { readOnly: false, tier: "t2" });
  const effortIndex = codex.indexOf('model_reasoning_effort="high"');
  assert.ok(effortIndex > 0, "t2 must add the high reasoning effort override");
  assert.equal(codex[effortIndex - 1], "-c");
  assert.ok(codex.includes('approval_policy="never"'), "the approval override survives tiering");
});

test("tiering never introduces an API-key or API-endpoint flag", () => {
  for (const tier of ["t0", "t1", "t2"] as const) {
    for (const args of [claudeArgs(PROMPT, { tier }), codexArgs(PROMPT, { readOnly: false, tier })]) {
      const joined = args.join(" ").toLowerCase();
      assert.ok(!joined.includes("api-key") && !joined.includes("api_key"), `${tier} leaked an API key flag`);
      assert.ok(!joined.includes("--base-url") && !joined.includes("api.anthropic.com"), `${tier} leaked an API endpoint`);
    }
  }
});

test("buildProviderArgs preserves the sandbox contract per provider", () => {
  const readOnly = buildProviderArgs("codex", PROMPT, { readOnly: true, tier: "t2" });
  assert.ok(readOnly.includes("read-only"));
  assert.ok(!readOnly.includes("danger-full-access"));
  const writable = buildProviderArgs("codex", PROMPT, { readOnly: false, tier: "t0", codexModel: "x" });
  assert.ok(writable.includes("danger-full-access"));
  assert.deepEqual(
    buildProviderArgs("claude", PROMPT, { readOnly: false, tier: "t2", claudeModel: "sonnet" }),
    ["-p", "--model", "opus", PROMPT, "--dangerously-skip-permissions"],
  );
});

test("the wall-clock envelope terminates a hung child with a partial result", async () => {
  const started = Date.now();
  const result = await execute("sleep", ["30"], os.tmpdir(), "codex", { timeoutMs: 120 });
  assert.equal(result.exitCode, null);
  assert.equal(result.error, ENVELOPE_TIMEOUT_ERROR);
  assert.ok(Date.now() - started < 5_000, "SIGTERM must fire well before the grace SIGKILL");
  assert.ok(result.events.some((event) => event.stream === "system" && event.text.includes(ENVELOPE_TIMEOUT_ERROR)));
});

test("a child that finishes inside its envelope is unaffected", async () => {
  const result = await execute("echo", ["hello"], os.tmpdir(), "codex", { timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.response, "hello");
  assert.equal(result.error, undefined);
});

async function testRunner(admission: AdmissionController): Promise<{ runner: ProviderRunner; events: () => Promise<ActivityEvent[]> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-runner-"));
  const activity = new ActivityLog(path.join(root, "activity.jsonl"));
  await activity.init();
  const config = { rootDir: root, dataDir: path.join(root, "data"), provider: "codex" } as HenryConfig;
  return { runner: new ProviderRunner(config, activity, admission), events: () => activity.list(50) };
}

test("critical memory pressure blocks the spawn and is recorded, never executed", async () => {
  const admission = new AdmissionController({ pressureTtlMs: 0, samplePressure: async () => "critical" });
  const { runner, events } = await testRunner(admission);
  const result = await runner.run("never spawn me", { tier: "t0", timeoutMs: 200 });

  assert.equal(result.exitCode, null);
  assert.match(result.error ?? "", /memory pressure critical/);
  assert.equal(result.events.length, 0, "no provider subprocess may be spawned under critical pressure");
  assert.equal(admission.runningCount, 0);

  const recorded = await events();
  const refusal = recorded.find((event) => event.kind === "run.started");
  assert.ok(refusal, "a refused spawn is still recorded on the activity stream");
  assert.equal(refusal?.metadata?.queued, true);
  assert.equal(refusal?.metadata?.refused, "pressure");
  assert.equal(refusal?.metadata?.tier, "t0");
});

test("waiting for a slot longer than the envelope is refused rather than spawned", async () => {
  const admission = new AdmissionController({ maxConcurrent: 1, pressureTtlMs: 0, samplePressure: async () => "ok" });
  const held = await admission.waitForSlot({ provider: "codex", timeoutMs: 1_000 });
  assert.equal(held.admitted, true);

  const { runner, events } = await testRunner(admission);
  const result = await runner.run("queued out", { timeoutMs: 60 });
  assert.equal(result.exitCode, null);
  assert.match(result.error ?? "", /timed out waiting for a provider slot/);
  assert.equal(result.events.length, 0);

  const recorded = await events();
  const refusal = recorded.find((event) => event.kind === "run.started");
  assert.equal(refusal?.metadata?.refused, "timeout");
  assert.ok(recorded.some((event) => event.kind === "run.failed"));
  if (held.admitted) held.slot.release();
});
