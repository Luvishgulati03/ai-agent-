import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { LavuConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { ProviderEvent, ProviderName, RunResult } from "../types.ts";
import { safeEnvironment } from "../util/env.ts";

export interface RunOptions {
  provider?: ProviderName;
  cwd?: string;
  role?: string;
  readOnly?: boolean;
  onEvent?: (event: ProviderEvent) => void;
}

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

async function execute(
  command: string,
  args: string[],
  cwd: string,
  provider: ProviderName,
  options: RunOptions,
): Promise<RunResult> {
  const runId = randomUUID();
  const started = Date.now();
  const events: ProviderEvent[] = [];
  const stdoutText: string[] = [];
  const stderrText: string[] = [];
  const child = spawn(command, args, {
    cwd,
    env: safeEnvironment(provider, { CI: "1", LAVU_RUN_ID: runId }),
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

  return await new Promise<RunResult>((resolve) => {
    child.once("error", (error) => resolve({
      runId, provider, response: "", exitCode: null, durationMs: Date.now() - started,
      error: error.message, events,
    }));
    child.once("close", (exitCode) => {
      const extracted: string[] = [];
      for (const event of events) if (event.parsed) collectText(event.parsed, extracted);
      const raw = stdoutText.join("").trim();
      const response = [...new Set(extracted.map((text) => text.trim()).filter(Boolean))].join("\n\n") || raw;
      const error = exitCode === 0 ? undefined : stderrText.join("").trim() || `Provider exited with code ${exitCode}`;
      resolve({ runId, provider, response, exitCode, durationMs: Date.now() - started, ...(error ? { error } : {}), events });
    });
  });
}

export class ProviderRunner {
  constructor(private readonly config: LavuConfig, private readonly activity: ActivityLog) {}

  async run(prompt: string, options: RunOptions = {}): Promise<RunResult> {
    const preferred = options.provider || this.config.provider;
    // Claude's installed CLI does not expose a verified read-only mode in the
    // contract we use here. Never turn a read-only review into a write-capable
    // fallback; Codex is the safe reviewer for this path.
    const sequence: ProviderName[] = options.readOnly ? ["codex"] : preferred === "codex" ? ["codex", "claude"] : ["claude", "codex"];
    let last: RunResult | undefined;

    for (const provider of sequence) {
      const args = provider === "codex"
        ? this.codexArgs(prompt, options.readOnly === true)
        : this.claudeArgs(prompt, options.readOnly === true);
      if (provider === "codex" && this.config.codexModel) args.splice(1, 0, "-m", this.config.codexModel);
      if (provider === "claude" && this.config.claudeModel) args.splice(1, 0, "--model", this.config.claudeModel);
      await this.activity.record("run.started", `Starting ${provider} run`, { cwd: options.cwd || this.config.rootDir }, { provider, role: options.role });
      const result = await execute(provider, args, options.cwd || this.config.rootDir, provider, options);
      last = result;
      if (result.exitCode === 0 && result.response.trim()) {
        await this.activity.record("run.completed", `${provider} completed`, { durationMs: result.durationMs }, { runId: result.runId, provider, role: options.role });
        return result;
      }
      await this.activity.record("run.failed", `${provider} failed; considering fallback`, { error: result.error }, { runId: result.runId, provider, role: options.role });
    }
    return last || {
      runId: randomUUID(), provider: preferred, response: "", exitCode: null, durationMs: 0,
      error: "No provider was available", events: [],
    };
  }

  private codexArgs(prompt: string, readOnly: boolean): string[] {
    return [
      "exec", "--json", "--ephemeral", "--sandbox", readOnly ? "read-only" : "danger-full-access",
      "-c", 'approval_policy="never"', "--skip-git-repo-check", prompt,
    ];
  }

  private claudeArgs(prompt: string, _readOnly: boolean): string[] {
    return ["-p", prompt, "--dangerously-skip-permissions"];
  }
}
