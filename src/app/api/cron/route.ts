import { authorizeCron } from "@/lib/api/cron";
import { markJobsRun } from "@/lib/api/tick";
import { runScheduledJobs } from "@/lib/services/jobs";

export const dynamic = "force-dynamic";
// One run stops itself after about 40 seconds; this leaves room to answer.
export const maxDuration = 60;

/**
 * GET /api/cron: runs every scheduled job once (final copies, expiry, reminders,
 * countersign nudges, webhook retries, clean-up) and answers with the summary.
 * Vercel Cron calls it with "Authorization: Bearer <CRON_SECRET>".
 */
export async function GET(request: Request): Promise<Response> {
  const refusal = authorizeCron(request.headers.get("authorization"));
  if (refusal) {
    return Response.json({ error: { code: refusal.code, message: refusal.message } }, { status: refusal.status, headers: { "Cache-Control": "no-store", ...refusal.headers } });
  }
  // Taken first, so page-driven ticks stand down for ten minutes instead of running alongside.
  await markJobsRun();
  const summary = await runScheduledJobs();
  if (summary.errors.length > 0) console.error("[cron] scheduled jobs reported problems", summary.errors);
  return Response.json({ ok: summary.errors.length === 0, summary }, { headers: { "Cache-Control": "no-store" } });
}
