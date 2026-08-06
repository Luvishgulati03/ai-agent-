import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderName } from "../types.ts";

/**
 * Per-surface provider session reuse (latency plan §11.5 #2, Friday's model).
 *
 * Every Henry turn used to spawn a cold `codex exec --ephemeral` / `claude -p`
 * that re-sent the full prompt with zero context reuse. A surface (repl,
 * dashboard-ask, a workflow name) instead keeps one provider session alive:
 * the first turn creates it, later turns resume it — the provider already
 * holds the soul/persona/history, so turns get dramatically cheaper and
 * faster. Sessions are per (surface, provider) and reset on staleness,
 * explicit reset, or provider switch.
 *
 * Storage is data/sessions.json, RE-READ BEFORE EVERY WRITE — multiple Henry
 * processes share it, and the 2026-08-06 reminder-cache clobber taught us
 * what in-memory caching of a shared file does.
 */

export interface SessionRecord {
  id: string;
  provider: ProviderName;
  surface: string;
  createdAt: string;
  lastUsedAt: string;
  turns: number;
}

export const SESSION_STALE_MS = 2 * 60 * 60 * 1000;
/** Cap turns per session so provider-side context never grows unbounded. */
export const SESSION_MAX_TURNS = 40;

type SessionFile = Record<string, SessionRecord>;

function key(surface: string, provider: ProviderName): string {
  return `${surface}::${provider}`;
}

export class SessionManager {
  constructor(private readonly filePath: string) {}

  private read(): SessionFile {
    try { return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as SessionFile; }
    catch { return {}; }
  }

  private write(sessions: SessionFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filePath, `${JSON.stringify(sessions, null, 2)}\n`, { mode: 0o600 });
  }

  /**
   * Returns the session to use for this turn: `fresh: true` means the caller
   * must CREATE the session this turn (pass the id as the new session id);
   * `fresh: false` means resume the existing id.
   */
  acquire(surface: string, provider: ProviderName, now = new Date()): { id: string; fresh: boolean } {
    const sessions = this.read();
    const existing = sessions[key(surface, provider)];
    const stale = !existing
      || now.getTime() - new Date(existing.lastUsedAt).getTime() > SESSION_STALE_MS
      || existing.turns >= SESSION_MAX_TURNS;
    if (!stale) return { id: existing.id, fresh: false };
    const record: SessionRecord = {
      id: randomUUID(), provider, surface,
      createdAt: now.toISOString(), lastUsedAt: now.toISOString(), turns: 0,
    };
    sessions[key(surface, provider)] = record;
    this.write(sessions);
    return { id: record.id, fresh: true };
  }

  /** Call after a successful turn so staleness/turn accounting stays honest. */
  markUsed(surface: string, provider: ProviderName, now = new Date()): void {
    const sessions = this.read();
    const record = sessions[key(surface, provider)];
    if (!record) return;
    record.lastUsedAt = now.toISOString();
    record.turns += 1;
    this.write(sessions);
  }

  /** Codex mints its own session/thread id on create — swap ours for the real one. */
  updateId(surface: string, provider: ProviderName, realId: string): void {
    const sessions = this.read();
    const record = sessions[key(surface, provider)];
    if (!record) return;
    record.id = realId;
    this.write(sessions);
  }

  /** A failed resume (session evicted provider-side) must not poison later turns. */
  reset(surface: string, provider?: ProviderName): void {
    const sessions = this.read();
    for (const k of Object.keys(sessions)) {
      const [s, p] = k.split("::");
      if (s === surface && (!provider || p === provider)) delete sessions[k];
    }
    this.write(sessions);
  }

  list(): SessionRecord[] { return Object.values(this.read()); }
}

/**
 * Provider-specific CLI arg fragments for create-vs-resume. Kept here so the
 * runner's arg builders stay declarative.
 * - claude: `--session-id <id>` on create, `--resume <id>` on later turns.
 * - codex: `exec` supports `resume <id>`; on create we pass `--session-id`-less
 *   ephemeral is DROPPED (sessions imply persistence) and we read the id from
 *   the stream's session_configured event — callers pass ours as a correlation
 *   fallback only. Codex resume subcommand: `codex exec resume <id> <prompt>`.
 */
export function sessionArgs(provider: ProviderName, session: { id: string; fresh: boolean }): {
  claudeArgs: string[]; codexSubcommand: string[];
} {
  if (provider === "claude") {
    return {
      claudeArgs: session.fresh ? ["--session-id", session.id] : ["--resume", session.id],
      codexSubcommand: [],
    };
  }
  return {
    claudeArgs: [],
    codexSubcommand: session.fresh ? [] : ["resume", session.id],
  };
}
