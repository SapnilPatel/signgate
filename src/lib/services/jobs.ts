/**
 * Scheduled work, run by the cron route every few minutes.
 *
 * Every step is safe to run twice at once and safe to repeat: each change is a
 * guarded update that only one runner can win, and a step that fails is reported
 * in the summary without stopping the steps after it. Each run does a bounded
 * amount of work; whatever is left is picked up by the next run.
 */
import { and, asc, eq, inArray, isNotNull, lt, lte, or } from "drizzle-orm";
import { getDb, type Db } from "@/lib/db";
import { authTokens, envelopes, rateLimits, sessions } from "@/lib/db/schema";
import { cleanText, normalizeEmail } from "@/lib/validation";
import { systemActor } from "./context";
import { resolveSettings } from "./accounts";
import { recordEvent } from "./events";
import { deliverPendingWebhooks, enqueueWebhookEvent, pruneWebhookDeliveries } from "./webhooks";
import { expiredEmail } from "./email-templates";
import { purgeStaleUploads } from "./uploads";
import { emailSigningRequest, notifySignersLinkDead, scheduleOf } from "./envelopes";
import {
  AWAITING_CLIENT_STATUSES,
  brandOf,
  fileUrl,
  finalizeEnvelope,
  listUnsealedEnvelopeIds,
  loadEnvelopeContext,
  longDate,
  safeSend,
  settleFileStatus,
  teamRecipient,
  webhookPayload,
} from "./signing";

export interface JobsSummary {
  startedAt: string;
  finishedAt: string;
  expired: number;
  reminders: { sent: number; failed: number; stopped: number };
  finalized: { completed: number; failed: number };
  webhooks: { delivered: number; failed: number };
  purged: { uploadChunks: number; sessions: number; authTokens: number; rateLimits: number; webhookDeliveries: number };
  /** True when the run stopped early to stay inside the function's time limit. */
  outOfTime: boolean;
  /** One line per step that failed. Empty on a clean run. */
  errors: string[];
}

const BATCH = 50;
const FINALIZE_BATCH = 10;
const DAY_MS = 86_400_000;
/** Serverless functions are cut off without warning; stop starting new work well before that. */
const TIME_BUDGET_MS = 40_000;

function describe(err: unknown): string {
  return cleanText(err instanceof Error ? err.message : String(err), 200) || "unknown error";
}

/** Mark overdue, unsigned envelopes expired and tell both sides. */
async function expireOverdue(db: Db, now: Date, summary: JobsSummary, outOfTime: () => boolean): Promise<void> {
  const due = await db
    .select({ id: envelopes.id })
    .from(envelopes)
    .where(and(inArray(envelopes.status, AWAITING_CLIENT_STATUSES), isNotNull(envelopes.expiresAt), lte(envelopes.expiresAt, now)))
    .orderBy(asc(envelopes.expiresAt))
    .limit(BATCH);

  for (const { id } of due) {
    if (outOfTime()) return;
    try {
      const ctx = await loadEnvelopeContext(db, id);
      if (!ctx) continue;
      const won = await db.transaction(async (tx) => {
        const [expired] = await tx
          .update(envelopes)
          .set({ status: "expired", nextReminderAt: null, updatedAt: now })
          .where(and(eq(envelopes.id, id), inArray(envelopes.status, AWAITING_CLIENT_STATUSES), lte(envelopes.expiresAt, now)))
          .returning({ id: envelopes.id });
        // Signed, voided or already expired by another runner in the meantime.
        if (!expired) return false;
        await settleFileStatus(tx, ctx.org.id, ctx.file.id, id, "needs_attention");
        await recordEvent(tx, { orgId: ctx.org.id, fileId: ctx.file.id, envelopeId: id, type: "envelope.expired", actor: systemActor(ctx.org.id) });
        await enqueueWebhookEvent(tx, ctx.org.id, "agreement.expired", webhookPayload(ctx, "expired", { expiredAt: now.toISOString() }));
        return true;
      });
      if (!won) continue;
      summary.expired++;

      const client = ctx.signers.find((s) => s.role === "client");
      const team = await teamRecipient(db, ctx.envelope);
      if (team && (!client || normalizeEmail(team.email) !== normalizeEmail(client.email))) {
        await safeSend(ctx.org, {
          envelopeId: id,
          kind: "expired",
          to: team.email,
          ...expiredEmail({
            brand: brandOf(ctx.org),
            recipientName: team.name,
            clientName: client?.name ?? ctx.file.clientName,
            agreementName: ctx.envelope.templateName,
            fileReference: ctx.file.reference,
            fileUrl: fileUrl(ctx.file.id),
          }),
        });
      }
      const when = ctx.envelope.expiresAt ? ` on ${longDate(ctx.envelope.expiresAt)}` : "";
      await notifySignersLinkDead(db, ctx, `The signing link expired${when} before the agreement was signed.`);
    } catch (err) {
      summary.errors.push(`expire ${id}: ${describe(err)}`);
    }
  }
}

/** Send reminders that are due to clients who have not signed. */
async function sendDueReminders(db: Db, now: Date, summary: JobsSummary, outOfTime: () => boolean): Promise<void> {
  const due = await db
    .select({ id: envelopes.id })
    .from(envelopes)
    .where(and(inArray(envelopes.status, ["sent", "viewed"]), isNotNull(envelopes.nextReminderAt), lte(envelopes.nextReminderAt, now)))
    .orderBy(asc(envelopes.nextReminderAt))
    .limit(BATCH);

  for (const { id } of due) {
    if (outOfTime()) return;
    try {
      const ctx = await loadEnvelopeContext(db, id);
      if (!ctx) continue;
      const { envelope } = ctx;
      // An envelope past its date is the expiry step's to deal with, not a reason to nudge.
      if (envelope.expiresAt && envelope.expiresAt.getTime() <= now.getTime()) continue;

      const schedule = scheduleOf(resolveSettings(ctx.org));
      const client = ctx.signers.find((s) => s.role === "client");
      const stillWaiting = client && (client.status === "sent" || client.status === "viewed");
      const stillDue = and(eq(envelopes.id, id), inArray(envelopes.status, ["sent", "viewed"]), lte(envelopes.nextReminderAt, now), eq(envelopes.reminderCount, envelope.reminderCount));

      if (!stillWaiting || schedule.reminderEveryDays <= 0 || envelope.reminderCount >= schedule.maxReminders) {
        const stopped = await db.update(envelopes).set({ nextReminderAt: null }).where(stillDue).returning({ id: envelopes.id });
        summary.reminders.stopped += stopped.length;
        continue;
      }

      // Claiming before sending is what stops two runners emailing the same reminder, and
      // it means a failing address is retried on the normal schedule, not every few minutes.
      const number = envelope.reminderCount + 1;
      const [claimed] = await db
        .update(envelopes)
        .set({
          reminderCount: number,
          lastReminderAt: now,
          nextReminderAt: number < schedule.maxReminders ? new Date(now.getTime() + schedule.reminderEveryDays * DAY_MS) : null,
        })
        .where(stillDue)
        .returning({ id: envelopes.id });
      if (!claimed) continue;

      const outcome = await emailSigningRequest(ctx, client, { reminderNumber: number });
      if (outcome.status === "sent") summary.reminders.sent++;
      else summary.reminders.failed++;
      // With no email provider there is nothing to report on every cycle; the file already says the link must be shared by hand.
      if (outcome.status !== "skipped") {
        await recordEvent(db, {
          orgId: ctx.org.id,
          fileId: ctx.file.id,
          envelopeId: id,
          type: outcome.status === "sent" ? "reminder.sent" : "envelope.delivery_failed",
          actor: systemActor(ctx.org.id),
          data:
            outcome.status === "sent"
              ? { email: client.email, count: number }
              : { email: client.email, kind: "reminder", error: cleanText(outcome.error, 300) || "The email provider did not accept the reminder" },
        });
      }
    } catch (err) {
      summary.errors.push(`reminder ${id}: ${describe(err)}`);
    }
  }
}

async function step(summary: JobsSummary, name: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    summary.errors.push(`${name}: ${describe(err)}`);
  }
}

/**
 * Run every scheduled job once. `now` is the moment "due" is measured against.
 * Never throws: problems are listed in the summary's `errors`.
 */
export async function runScheduledJobs(now: Date = new Date()): Promise<JobsSummary> {
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const started = Date.now();
  const outOfTime = () => Date.now() - started > TIME_BUDGET_MS;
  const summary: JobsSummary = {
    startedAt: new Date(started).toISOString(),
    finishedAt: "",
    expired: 0,
    reminders: { sent: 0, failed: 0, stopped: 0 },
    finalized: { completed: 0, failed: 0 },
    webhooks: { delivered: 0, failed: 0 },
    purged: { uploadChunks: 0, sessions: 0, authTokens: 0, rateLimits: 0, webhookDeliveries: 0 },
    outOfTime: false,
    errors: [],
  };

  let db: Db;
  try {
    db = await getDb();
  } catch (err) {
    summary.errors.push(`database: ${describe(err)}`);
    summary.finishedAt = new Date().toISOString();
    return summary;
  }

  // Signed agreements waiting for their final copy come first: a person is waiting on those.
  await step(summary, "finalize", async () => {
    for (const id of await listUnsealedEnvelopeIds(FINALIZE_BATCH)) {
      if (outOfTime()) return;
      const result = await finalizeEnvelope(id);
      if (result.status === "completed" && !result.alreadyCompleted) summary.finalized.completed++;
      else if (result.status === "failed") summary.finalized.failed++;
    }
  });
  // Expiry before reminders, so nobody is reminded about a link that has just stopped working.
  await step(summary, "expire", () => expireOverdue(db, at, summary, outOfTime));
  await step(summary, "reminders", () => sendDueReminders(db, at, summary, outOfTime));

  await step(summary, "webhooks", async () => {
    if (outOfTime()) return;
    summary.webhooks = await deliverPendingWebhooks({ limit: BATCH });
  });

  await step(summary, "purge uploads", async () => {
    summary.purged.uploadChunks = await purgeStaleUploads();
  });
  await step(summary, "purge sessions", async () => {
    summary.purged.sessions = (await db.delete(sessions).where(lt(sessions.expiresAt, at)).returning({ id: sessions.id })).length;
  });
  await step(summary, "purge auth tokens", async () => {
    // Kept for a day after use or expiry so a late click still gets "this link was used", not "unknown link".
    const cutoff = new Date(at.getTime() - DAY_MS);
    summary.purged.authTokens = (
      await db
        .delete(authTokens)
        .where(or(lt(authTokens.expiresAt, cutoff), and(isNotNull(authTokens.usedAt), lt(authTokens.usedAt, cutoff))))
        .returning({ id: authTokens.id })
    ).length;
  });
  await step(summary, "purge rate limits", async () => {
    summary.purged.rateLimits = (await db.delete(rateLimits).where(lt(rateLimits.resetAt, new Date(at.getTime() - 3_600_000))).returning({ key: rateLimits.key })).length;
  });
  await step(summary, "purge webhook deliveries", async () => {
    summary.purged.webhookDeliveries = await pruneWebhookDeliveries(30, at);
  });

  summary.outOfTime = outOfTime();
  summary.finishedAt = new Date().toISOString();
  return summary;
}
