import type { ActivityLog } from "../activity.ts";
import type { ReminderService, ReminderNotifier, PromptRunner, ExecuteApprovalFn } from "./service.ts";
import { notifyReminder } from "./service.ts";

/** How often any long-lived Henry process polls for due reminders (§ reminders doctrine). */
export const REMINDER_POLL_MS = 60_000;

export interface ReminderTickerHandle {
  stop(): void;
}

export interface ReminderTickerOptions {
  notify?: ReminderNotifier;
  promptRunner?: PromptRunner;
  executeApproval?: ExecuteApprovalFn;
  pollMs?: number;
}

/**
 * Guards against starting more than one reminder ticker inside a single process — the daemon
 * (`henry schedule daemon`) and the repl/dashboard commands all reuse this one implementation,
 * but each `henry ...` invocation is its own process so accidental double-starts only happen
 * within one process (e.g. a caller wiring it in twice).
 */
let started = false;

/**
 * Starts the shared reminder poller: an immediate check (so reminders that came due while
 * nothing was running fire right away, "(overdue)"-prefixed) followed by a fixed-interval
 * poll. Returns `undefined` if a ticker is already running in this process. The interval is
 * `unref()`d so it never keeps a REPL or short-lived process alive on its own — callers that
 * want to stop it explicitly (e.g. on REPL exit) should still call `handle.stop()`.
 */
export function startReminderTicker(
  reminders: ReminderService,
  activity: ActivityLog,
  options: ReminderTickerOptions = {},
): ReminderTickerHandle | undefined {
  if (started) return undefined;
  started = true;

  const notify = options.notify ?? notifyReminder;
  const pollMs = options.pollMs ?? REMINDER_POLL_MS;

  const check = (): void => {
    void reminders.fireDue(notify, new Date(), options.promptRunner, options.executeApproval).catch(
      (error) => activity.record("workflow.failed", "Reminder check failed", { error: String(error) }),
    );
  };

  check();
  const timer = setInterval(check, pollMs);
  timer.unref?.();

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      started = false;
    },
  };
}

/** Test-only: resets the double-start guard so each test gets a clean slate. */
export function __resetReminderTickerForTests(): void {
  started = false;
}
