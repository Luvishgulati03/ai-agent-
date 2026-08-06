import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { DispatchTier, ProviderEvent, ProviderName, RunResult } from "../types.ts";
import { safeEnvironment } from "../util/env.ts";
import path from "node:path";
import { SessionManager, sessionArgs } from "./session.ts";
import { AdmissionController, sharedAdmissionController } from "../orchestration/admission.ts";
import { notifyReminder } from "../reminders/service.ts";

export interface RunOptions {
  /**
   * Names a long-lived conversation surface (e.g. "repl", "dashboard-ask").
   * When set, the run resumes that surface's provider session instead of a
   * cold ephemeral spawn (latency §11.5 #2). Callers that set this SHOULD
   * send slim prompts on resumed turns — ask `acquireSession` first.
   */
  surface?: string;
  /** Precomputed session from acquireSession() — lets the caller build a slim prompt for resumed turns. */
  session?: { id: string; fresh: boolean; provider: ProviderName };
  provider?: ProviderName;
  cwd?: string;
  role?: string;
  readOnly?: boolean;
  /** MASTER_PLAN §11.1 tier; absent keeps the configured default models. */
  tier?: DispatchTier;
  /** Wall-clock envelope per provider attempt (§7). */
  timeoutMs?: number;
  onEvent?: (event: ProviderEvent) => void;
}

/** Default wall-clock envelope: 5 minutes (MASTER_PLAN §7). */
export const DEFAULT_ENVELOPE_MS = 300_000;
/** Grace period between SIGTERM and SIGKILL. */
export const ENVELOPE_KILL_GRACE_MS = 10_000;
/** Cheap Codex model used for t0 triage work when nothing cheaper is configured. */
export const CODEX_T0_MODEL = "gpt-5-mini";
export const ENVELOPE_TIMEOUT_ERROR = "envelope timeout";
/** Waiting longer than this in the admission queue is worth recording. */
export const QUEUE_NOTICE_MS = 5_000;

function now(): string { return new Date().toISOString(); }

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function collectText(value: unknown, output: string[]): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") output.push(record.text);
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") collectText(child, output);
  }
}

/**
 * Codex argv for one dispatch. Exported as the testable seam for tier flags.
 * t0 pins a cheap model, t1 (and no tier) keeps the configured/default model,
 * t2 raises reasoning effort.
 */
export function codexArgs(
  prompt: string,
  options: { readOnly: boolean; tier?: DispatchTier; model?: string; session?: { id: string; fresh: boolean } } = { readOnly: false },
): string[] {
  const model = options.tier === "t0" ? CODEX_T0_MODEL : options.model;
  const resume = options.session ? sessionArgs("codex", options.session).codexSubcommand : [];
  // Sessions imply persistence: drop --ephemeral whenever a surface session is in play.
  return [
    "exec", ...resume,
    ...(model ? ["-m", model] : []),
    "--json", ...(options.session ? [] : ["--ephemeral"]), "--sandbox", options.readOnly ? "read-only" : "danger-full-access",
    "-c", 'approval_policy="never"',
    ...(options.tier === "t2" ? ["-c", 'model_reasoning_effort="high"'] : []),
    "--skip-git-repo-check", prompt,
  ];
}

/**
 * Claude argv for one dispatch (subscription CLI — never the API).
 * t0 → haiku, t2 → opus, t1/absent → the configured model or the CLI default.
 */
export function claudeArgs(
  prompt: string,
  options: { readOnly?: boolean; tier?: DispatchTier; model?: string; session?: { id: string; fresh: boolean } } = {},
): string[] {
  const model = options.tier === "t0" ? "haiku" : options.tier === "t2" ? "opus" : options.model;
  const session = options.session ? sessionArgs("claude", options.session).claudeArgs : [];
  return ["-p", ...(model ? ["--model", model] : []), ...session, prompt, "--dangerously-skip-permissions"];
}

export function buildProviderArgs(
  provider: ProviderName,
  prompt: string,
  options: { readOnly: boolean; tier?: DispatchTier; codexModel?: string; claudeModel?: string; session?: { id: string; fresh: boolean } },
): string[] {
  return provider === "codex"
    ? codexArgs(prompt, { readOnly: options.readOnly, tier: options.tier, model: options.codexModel, session: options.session })
    : claudeArgs(prompt, { readOnly: options.readOnly, tier: options.tier, model: options.claudeModel, session: options.session });
}

/**
 * Spawns a provider under a wall-clock envelope. On timeout the child gets
 * SIGTERM, then SIGKILL after a grace period, and the run resolves with
 * whatever partial output was captured (partial-results-on-failure, §7).
 * Exported for tests; production callers go through ProviderRunner.run.
 */
export async function execute(
  command: string,
  args: string[],
  cwd: string,
  provider: ProviderName,
  options: RunOptions = {},
): Promise<RunResult> {
  const runId = randomUUID();
  const started = Date.now();
  const events: ProviderEvent[] = [];
  const stdoutText: string[] = [];
  const stderrText: string[] = [];
  const child = spawn(command, args, {
    cwd,
    env: safeEnvironment(provider, { CI: "1", HENRY_RUN_ID: runId }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const emit = (stream: ProviderEvent["stream"], text: string): void => {
    const parsed = stream === "stdout" ? parseJsonLine(text) : undefined;
    const event: ProviderEvent = { timestamp: now(), stream, text, ...(parsed ? { parsed } : {}) };
    events.push(event);
    options.onEvent?.(event);
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutText.push(chunk);
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) emit("stdout", line);
  });
  child.stderr.on("data", (chunk: string) => {
    stderrText.push(chunk);
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) emit("stderr", line);
  });

  const envelopeMs = options.timeoutMs ?? DEFAULT_ENVELOPE_MS;
  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  const envelopeTimer = envelopeMs > 0 && Number.isFinite(envelopeMs)
    ? setTimeout(() => {
        timedOut = true;
        emit("system", `${ENVELOPE_TIMEOUT_ERROR} after ${envelopeMs}ms; sending SIGTERM`);
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), ENVELOPE_KILL_GRACE_MS);
        killTimer.unref?.();
      }, envelopeMs)
    : undefined;
  envelopeTimer?.unref?.();

  const clearTimers = (): void => {
    if (envelopeTimer) clearTimeout(envelopeTimer);
    if (killTimer) clearTimeout(killTimer);
  };

  return await new Promise<RunResult>((resolve) => {
    child.once("error", (error) => {
      clearTimers();
      resolve({
        runId, provider, response: "", exitCode: null, durationMs: Date.now() - started,
        error: error.message, events,
      });
    });
    child.once("close", (exitCode) => {
      clearTimers();
      const extracted: string[] = [];
      for (const event of events) if (event.parsed) collectText(event.parsed, extracted);
      const raw = stdoutText.join("").trim();
      const response = [...new Set(extracted.map((text) => text.trim()).filter(Boolean))].join("\n\n") || raw;
      if (timedOut) {
        resolve({
          runId, provider, response, exitCode: null, durationMs: Date.now() - started,
          error: ENVELOPE_TIMEOUT_ERROR, events,
        });
        return;
      }
      const error = exitCode === 0 ? undefined : stderrText.join("").trim() || `Provider exited with code ${exitCode}`;
      resolve({ runId, provider, response, exitCode, durationMs: Date.now() - started, ...(error ? { error } : {}), events });
    });
  });
}

/**
 * Signatures a provider CLI prints when its session has expired. These exit cleanly (code 0)
 * with a short "you're logged out" message instead of doing the actual work, so exitCode alone
 * can't catch it — observed live: codex's session expired mid-use and it printed "Not logged in
 * · Please run /login" with a clean exit, which ProviderRunner previously treated as SUCCESS.
 */
const AUTH_FAILURE_SIGNATURES = [
  "not logged in",
  "please run /login",
  "run codex login",
  "please login",
  "authentication required",
  "401 unauthorized",
  "token expired",
];

/**
 * True when `text` looks like an auth-failure message rather than real output. Matched
 * case-insensitively, and only trusted when either the WHOLE response is short (< 200 chars —
 * these messages are terse) or the response STARTS WITH the signature. That guard is what keeps
 * a long, normal reply that merely mentions e.g. "the login page" from tripping a false positive:
 * a 300-char answer discussing "login" somewhere in the middle never matches, but a bare
 * "Not logged in · Please run /login" (or any short reply carrying one of these phrases) does.
 * Exported for tests and reuse (e.g. surfacing a clear message to callers of read-only runs).
 */
export function isAuthFailureResponse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  const short = trimmed.length < 200;
  return AUTH_FAILURE_SIGNATURES.some((signature) => lower.includes(signature) && (short || lower.startsWith(signature)));
}

/** Repeated background jobs (mailwatch, etc.) hitting the same expired session shouldn't spam banners. */
const AUTH_NOTIFY_DEBOUNCE_MS = 10 * 60 * 1000;
const lastAuthNotifyAt = new Map<ProviderName, number>();

/**
 * Gates the "please re-login" notification to at most once per provider per 10 minutes.
 * Exported as the seam for tests (real notification delivery is not something a unit test
 * should trigger). Records `now` as the provider's last-notified time whenever it returns true.
 */
export function shouldNotifyAuthFailure(provider: ProviderName, now: number = Date.now()): boolean {
  const last = lastAuthNotifyAt.get(provider);
  if (last !== undefined && now - last < AUTH_NOTIFY_DEBOUNCE_MS) return false;
  lastAuthNotifyAt.set(provider, now);
  return true;
}

export class ProviderRunner {
  private sessionManager?: SessionManager;

  sessions(): SessionManager {
    this.sessionManager ||= new SessionManager(path.join(this.config.dataDir, "sessions.json"));
    return this.sessionManager;
  }

  /** Peek/create the session a surfaced run() will use — lets callers slim resumed prompts. */
  acquireSession(surface: string, provider?: ProviderName): { id: string; fresh: boolean; provider: ProviderName } {
    const p = provider || this.config.provider;
    return { ...this.sessions().acquire(surface, p), provider: p };
  }

  private readonly admission: AdmissionController;

  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    // Defaults to the process-wide controller so every runner (Luna, the agent,
    // the scheduler) shares one budget without changing its own constructor.
    admission: AdmissionController = sharedAdmissionController(),
  ) { this.admission = admission; }

  async run(prompt: string, options: RunOptions = {}): Promise<RunResult> {
    const preferred = options.provider || this.config.provider;
    // Claude's installed CLI does not expose a verified read-only mode in the
    // contract we use here. Never turn a read-only review into a write-capable
    // FALLBACK; an EXPLICIT caller choice of claude (e.g. vision classification)
    // is honored as a single-provider run with no fallback either way.
    const sequence: ProviderName[] = options.readOnly
      ? [options.provider === "claude" ? "claude" as const : "codex" as const]
      : preferred === "codex" ? ["codex", "claude"] : ["claude", "codex"];
    const envelopeMs = options.timeoutMs ?? DEFAULT_ENVELOPE_MS;
    let last: RunResult | undefined;

    for (const provider of sequence) {
      // Surface sessions: reuse the caller's precomputed session when it matches
      // this provider; a fallback provider gets its own surface session instead.
      const session = options.surface
        ? (options.session && options.session.provider === provider
            ? { id: options.session.id, fresh: options.session.fresh }
            : this.sessions().acquire(options.surface, provider))
        : undefined;
      const args = buildProviderArgs(provider, prompt, {
        readOnly: options.readOnly === true,
        tier: options.tier,
        codexModel: this.config.codexModel,
        claudeModel: this.config.claudeModel,
        session,
      });
      const cwd = options.cwd || this.config.rootDir;
      const decision = await this.admission.waitForSlot({ provider, timeoutMs: envelopeMs, label: options.role });
      const queued = decision.queuedMs >= QUEUE_NOTICE_MS;

      if (!decision.admitted) {
        const error = decision.reason === "pressure"
          ? "admission refused: memory pressure critical"
          : "admission refused: timed out waiting for a provider slot";
        await this.activity.record(
          "run.started",
          `Refused ${provider} spawn (${decision.reason})`,
          { cwd, tier: options.tier, queuedMs: decision.queuedMs, queued: true, refused: decision.reason, pressure: decision.pressure },
          { provider, role: options.role },
        );
        last = { runId: randomUUID(), provider, response: "", exitCode: null, durationMs: decision.queuedMs, error, events: [] };
        await this.activity.record("run.failed", `${provider} not admitted; considering fallback`, { error }, { runId: last.runId, provider, role: options.role });
        continue;
      }

      await this.activity.record(
        "run.started",
        `Starting ${provider} run`,
        { cwd, tier: options.tier, queuedMs: decision.queuedMs, ...(queued ? { queued: true } : {}) },
        { provider, role: options.role },
      );
      let result: RunResult;
      try {
        result = await execute(provider, args, cwd, provider, { ...options, timeoutMs: envelopeMs });
      } finally {
        decision.slot.release();
      }
      if (result.exitCode === 0 && isAuthFailureResponse(result.response)) {
        // A clean exit with a "you're logged out" body is a FAILURE, not success — the caller
        // must not mistake it for real output, and the next provider in sequence (if any) gets
        // a turn exactly like a nonzero exit would trigger.
        const authError = `${provider} session logged out — run \`codex login\` / \`claude\` to re-auth`;
        result = { ...result, error: authError };
        last = result;
        await this.activity.record(
          "run.failed",
          `${provider} session expired; considering fallback`,
          { error: authError, authFailure: true },
          { runId: result.runId, provider, role: options.role },
        );
        if (shouldNotifyAuthFailure(provider)) {
          const nextProvider = sequence[sequence.indexOf(provider) + 1];
          const fallbackNote = nextProvider ? `Falling back to ${nextProvider}.` : "No fallback available.";
          void notifyReminder(
            `⚠️ ${provider} session logged out — run \`codex login\` (or \`claude\`) to re-auth. ${fallbackNote}`,
            "Henry needs re-login",
          ).catch(() => undefined);
        }
        continue;
      }
      last = result;
      if (result.exitCode === 0 && result.response.trim()) {
        if (options.surface && session) {
          if (provider === "codex" && session.fresh) {
            // Codex mints its own id (thread.started event) — store the REAL one for resume.
            const threadEvent = result.events.find((e) => e.parsed && (e.parsed as Record<string, unknown>).type === "thread.started");
            const threadId = threadEvent && String((threadEvent.parsed as Record<string, unknown>).thread_id || "");
            if (threadId) this.sessions().updateId(options.surface, provider, threadId);
          }
          this.sessions().markUsed(options.surface, provider);
        }
        await this.activity.record("run.completed", `${provider} completed`, { durationMs: result.durationMs, tier: options.tier }, { runId: result.runId, provider, role: options.role });
        return result;
      }
      if (options.surface && session && !session.fresh) {
        // A failed resumed turn may mean the provider evicted the session — reset
        // so the caller's retry (or next turn) starts fresh instead of looping.
        this.sessions().reset(options.surface, provider);
        (result as { sessionReset?: boolean }).sessionReset = true;
      }
      await this.activity.record("run.failed", `${provider} failed; considering fallback`, { error: result.error }, { runId: result.runId, provider, role: options.role });
    }
    return last || {
      runId: randomUUID(), provider: preferred, response: "", exitCode: null, durationMs: 0,
      error: "No provider was available", events: [],
    };
  }
}
