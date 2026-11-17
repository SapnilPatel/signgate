/**
 * Keeps reminders, expiry, countersign nudges and webhook retries moving on hosts
 * where the scheduled job runs rarely (once a day on Vercel's Hobby plan).
 *
 * How to use it, from any page, layout, server action or route handler that signed-in
 * people or integrations hit often:
 *
 *   import { tickAfterResponse } from "@/lib/api/tick";
 *   ...
 *   tickAfterResponse();   // anywhere during the request; returns at once
 *
 * The work happens after the response has been sent, so it never slows a page down.
 * It runs the jobs at most once every ten minutes for the whole deployment: the turn
 * is taken with one atomic statement on the shared counters table, so many instances
 * and many requests cannot run it at the same moment. The jobs themselves are safe to
 * repeat, so the worst a lost race can do is nothing.
 *
 * Give the calling route `export const maxDuration = 60`: a run can take up to about
 * 40 seconds and the platform stops work that outlives the function's limit.
 */
import "server-only";
import { after } from "next/server";
import { runScheduledJobs, type JobsSummary } from "@/lib/services/jobs";
import { rateLimit } from "@/lib/services/rate-limit";

export const TICK_INTERVAL_SECONDS = 600;
const LEASE_KEY = "jobs:tick";
/** How often one instance may even ask the database whether it is time. */
const LOCAL_CHECK_MS = 60_000;

const local = globalThis as unknown as { __signgateTickCheckedAt?: number };

export type TickResult = { ran: true; summary: JobsSummary } | { ran: false; reason: "checked_recently" | "ran_recently" };

/**
 * Runs the scheduled jobs if nobody has in the last ten minutes. Never throws.
 * `force` skips this instance's own one-minute memory, not the shared ten-minute turn.
 */
export async function tick(opts: { force?: boolean } = {}): Promise<TickResult> {
  const now = Date.now();
  // Most requests stop here without touching the database.
  if (!opts.force && local.__signgateTickCheckedAt && now - local.__signgateTickCheckedAt < LOCAL_CHECK_MS) {
    return { ran: false, reason: "checked_recently" };
  }
  local.__signgateTickCheckedAt = now;
  const turn = await rateLimit(LEASE_KEY, 1, TICK_INTERVAL_SECONDS);
  if (!turn.ok) return { ran: false, reason: "ran_recently" };
  return { ran: true, summary: await runScheduledJobs() };
}

/** Tells the ticks that a full run has just happened (the cron route calls this), so they wait their ten minutes. */
export async function markJobsRun(): Promise<void> {
  await rateLimit(LEASE_KEY, 1, TICK_INTERVAL_SECONDS);
}

/** Schedules a tick for after the response. Safe to call anywhere; does nothing outside a request. */
export function tickAfterResponse(): void {
  try {
    after(async () => {
      try {
        const result = await tick();
        if (result.ran && result.summary.errors.length > 0) {
          console.error("[tick] scheduled jobs reported problems", result.summary.errors);
        }
      } catch (err) {
        console.error("[tick] failed", err instanceof Error ? err.message : err);
      }
    });
  } catch {
    // after() only exists inside a request (not in tests or scripts); there is nothing to schedule then.
  }
}

/** For tests: forget this instance's last check. */
export function resetTickForTests(): void {
  local.__signgateTickCheckedAt = undefined;
}
