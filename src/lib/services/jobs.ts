/**
 * Scheduled work, run by the cron route every few minutes.
 *
 * Every step is safe to run twice at once and safe to repeat: each change is a
 * guarded update that only one runner can win, and a step that fails is reported
 * in the summary without stopping the steps after it. Each run does a bounded
 * amount of work; whatever is left is picked up by the next run.
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getDb, type Db } from "@/lib/db";
import { authTokens, emailLog, envelopes, events, files, rateLimits, sessions, signers, users } from "@/lib/db/schema";
import { cleanText, normalizeEmail } from "@/lib/validation";
import { systemActor } from "./context";
import { resolveSettings } from "./accounts";
import { recordEvent } from "./events";
import { deliverPendingWebhooks, enqueueWebhookEvent, pruneWebhookDeliveries } from "./webhooks";
import { expiredEmail } from "./email-templates";
import { purgeStaleUploads } from "./uploads";
import { rateLimit } from "./rate-limit";
import { deliverUnsentDraft, emailSigningRequest, notifySignersLinkDead, scheduleOf } from "./envelopes";
import {
  AWAITING_CLIENT_STATUSES,
  COUNTERSIGN_MAX_REMINDERS,
  brandOf,
  countersignCadenceDays,
  emailCountersigner,
  fileUrl,
  finalizeEnvelope,
  inTransaction,
  listUnsealedEnvelopeIds,
  loadEnvelopeContext,
  lockFile,
  longDate,
  notifyCountersignOverdue,
  orgTimeZone,
  resendCompletedEmails,
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
  /** Agreements the client has signed that are waiting on the company's own countersigner. */
  countersign: { reminded: number; failed: number; escalated: number };
  /** Emails that were owed but never attempted because the request that owed them died, now sent. */
  recovered: { requests: number; completed: number; countersign: number };
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
      const won = await inTransaction(db, async (tx) => {
        await lockFile(tx, ctx.org.id, ctx.file.id);
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
      // The client is told their link ran out of time, in the company's own calendar, not that the company cancelled.
      await notifySignersLinkDead(db, ctx, {
        kind: "expired",
        expiredOn: ctx.envelope.expiresAt ? longDate(ctx.envelope.expiresAt, orgTimeZone(ctx.org) ?? "UTC") : null,
      });
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

/**
 * Chase the company's own countersigner. Once the client has signed, the envelope's
 * reminder schedule points at the countersigner: they are emailed again on the
 * company's reminder cadence, and when the reminders run out (or the person can no
 * longer sign) the file is flagged so someone else on the team picks it up. A
 * client-signed agreement is never expired: the client has done their part.
 */
async function chaseCountersigners(db: Db, now: Date, summary: JobsSummary, outOfTime: () => boolean): Promise<void> {
  const due = await db
    .select({ id: envelopes.id })
    .from(envelopes)
    .where(and(eq(envelopes.status, "client_signed"), isNull(envelopes.finalBlobId), isNotNull(envelopes.nextReminderAt), lte(envelopes.nextReminderAt, now)))
    .orderBy(asc(envelopes.nextReminderAt))
    .limit(BATCH);

  for (const { id } of due) {
    if (outOfTime()) return;
    try {
      const ctx = await loadEnvelopeContext(db, id);
      if (!ctx) continue;
      const { envelope } = ctx;
      const stillDue = and(eq(envelopes.id, id), eq(envelopes.status, "client_signed"), lte(envelopes.nextReminderAt, now), eq(envelopes.reminderCount, envelope.reminderCount));
      const signer = ctx.signers.find((s) => s.role === "company" && (s.status === "sent" || s.status === "viewed"));
      if (!signer) {
        // Everyone has signed (sealing is the finalize step's job) or it is not the company's turn.
        await db.update(envelopes).set({ nextReminderAt: null }).where(stillDue);
        continue;
      }

      const settings = resolveSettings(ctx.org);
      const every = countersignCadenceDays(settings.reminderEveryDays);
      const configuredMax = scheduleOf(settings).maxReminders;
      const max = configuredMax > 0 ? configuredMax : COUNTERSIGN_MAX_REMINDERS;
      const [assignee] = signer.userId
        ? await db.select({ id: users.id, disabledAt: users.disabledAt }).from(users).where(and(eq(users.id, signer.userId), eq(users.orgId, ctx.org.id))).limit(1)
        : [];
      const canSign = Boolean(assignee) && !assignee?.disabledAt;

      if (!canSign || envelope.reminderCount >= max) {
        const [claimed] = await db.update(envelopes).set({ nextReminderAt: null }).where(stillDue).returning({ id: envelopes.id });
        if (!claimed) continue;
        await inTransaction(db, async (tx) => {
          await lockFile(tx, ctx.org.id, ctx.file.id);
          await tx
            .update(files)
            .set({ agreementStatus: "needs_attention", updatedAt: now })
            .where(and(eq(files.id, ctx.file.id), eq(files.orgId, ctx.org.id), inArray(files.agreementStatus, ["awaiting_countersign", "out_for_signature"])));
          await recordEvent(tx, {
            orgId: ctx.org.id,
            fileId: ctx.file.id,
            envelopeId: id,
            type: "countersign.overdue",
            actor: systemActor(ctx.org.id),
            data: {
              email: signer.email,
              name: signer.name,
              reason: canSign
                ? `${signer.name} has not countersigned after ${envelope.reminderCount} reminders. An owner or admin can countersign from the file`
                : `${signer.name} can no longer sign for the company. An owner or admin can countersign from the file`,
            },
          });
        });
        summary.countersign.escalated++;
        // After commit, and only by the runner that won the claim above, so the team hears once.
        await notifyCountersignOverdue(ctx, {
          countersigner: signer,
          reason: canSign
            ? `${signer.name} was asked to countersign and has not done so after ${envelope.reminderCount} ${envelope.reminderCount === 1 ? "reminder" : "reminders"}`
            : `${signer.name} was asked to countersign but can no longer sign for the company`,
        });
        continue;
      }

      // Claimed before sending, for the same reason as client reminders. The next
      // date is always set, so the step after the last reminder is the escalation above.
      const number = envelope.reminderCount + 1;
      const [claimed] = await db
        .update(envelopes)
        .set({ reminderCount: number, lastReminderAt: now, nextReminderAt: new Date(now.getTime() + every * DAY_MS) })
        .where(stillDue)
        .returning({ id: envelopes.id });
      if (!claimed) continue;
      const outcome = await emailCountersigner(ctx, signer, { reminderNumber: number });
      if (outcome.status === "sent") summary.countersign.reminded++;
      else summary.countersign.failed++;
    } catch (err) {
      summary.errors.push(`countersign ${id}: ${describe(err)}`);
    }
  }
}

/** How long an email may be owed before the scheduler assumes the request that owed it is dead. */
const RECOVER_AFTER_MS = 5 * 60_000;
/** Nobody is helped by an email about something that happened long ago. */
const RECOVER_WINDOW_MS = 7 * DAY_MS;

/** One runner at a time per envelope and kind; a failed attempt is not repeated for 15 minutes. */
async function claimRecovery(kind: string, envelopeId: string): Promise<boolean> {
  return (await rateLimit(`recover:${kind}:${envelopeId}`, 1, 900)).ok;
}

/**
 * Emails are sent after the change that owes them commits. If the function is killed
 * in between (a timeout during the provider call, a deploy), nothing in the request
 * can make up for it, so this step looks for the three states that only arise that
 * way and sends what is owed:
 * - an envelope still "draft" with no record that its request was ever attempted
 * - a completed envelope with no completed-copy email attempted
 * - an envelope waiting on the countersigner who was never asked
 */
async function recoverLostEmails(db: Db, now: Date, summary: JobsSummary, outOfTime: () => boolean): Promise<void> {
  const before = new Date(now.getTime() - RECOVER_AFTER_MS);
  const since = new Date(now.getTime() - RECOVER_WINDOW_MS);

  const drafts = await db
    .select({ id: envelopes.id })
    .from(envelopes)
    .where(
      and(
        eq(envelopes.status, "draft"),
        lte(envelopes.createdAt, before),
        gte(envelopes.createdAt, since),
        sql`not exists (select 1 from ${events} where ${events.envelopeId} = ${envelopes.id} and ${events.type} in ('envelope.sent', 'envelope.delivery_failed'))`,
      ),
    )
    .orderBy(asc(envelopes.createdAt))
    .limit(BATCH);
  for (const { id } of drafts) {
    if (outOfTime()) return;
    try {
      if (!(await claimRecovery("request", id))) continue;
      if ((await deliverUnsentDraft(id)) !== null) summary.recovered.requests++;
    } catch (err) {
      summary.errors.push(`recover request ${id}: ${describe(err)}`);
    }
  }

  const completed = await db
    .select({ id: envelopes.id })
    .from(envelopes)
    .where(
      and(
        eq(envelopes.status, "completed"),
        lte(envelopes.completedAt, before),
        gte(envelopes.completedAt, since),
        sql`not exists (select 1 from ${emailLog} where ${emailLog.envelopeId} = ${envelopes.id} and ${emailLog.kind} = 'completed')`,
      ),
    )
    .orderBy(asc(envelopes.completedAt))
    .limit(BATCH);
  for (const { id } of completed) {
    if (outOfTime()) return;
    try {
      if (!(await claimRecovery("completed", id))) continue;
      if ((await resendCompletedEmails(id)).length > 0) summary.recovered.completed++;
    } catch (err) {
      summary.errors.push(`recover completed ${id}: ${describe(err)}`);
    }
  }

  const unasked = await db
    .select({ id: envelopes.id })
    .from(envelopes)
    .where(
      and(
        eq(envelopes.status, "client_signed"),
        isNull(envelopes.finalBlobId),
        lte(envelopes.updatedAt, before),
        gte(envelopes.updatedAt, since),
        sql`exists (select 1 from ${signers} where ${signers.envelopeId} = ${envelopes.id} and ${signers.role} = 'company' and ${signers.status} = 'sent')`,
        sql`not exists (select 1 from ${emailLog} where ${emailLog.envelopeId} = ${envelopes.id} and ${emailLog.kind} = 'countersign_request')`,
      ),
    )
    .orderBy(asc(envelopes.updatedAt))
    .limit(BATCH);
  for (const { id } of unasked) {
    if (outOfTime()) return;
    try {
      if (!(await claimRecovery("countersign", id))) continue;
      const ctx = await loadEnvelopeContext(db, id);
      const signer = ctx?.signers.find((s) => s.role === "company" && s.status === "sent");
      if (!ctx || !signer || ctx.envelope.status !== "client_signed") continue;
      await emailCountersigner(ctx, signer);
      summary.recovered.countersign++;
    } catch (err) {
      summary.errors.push(`recover countersign ${id}: ${describe(err)}`);
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
    countersign: { reminded: 0, failed: 0, escalated: 0 },
    recovered: { requests: 0, completed: 0, countersign: 0 },
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
    for (const id of await listUnsealedEnvelopeIds(FINALIZE_BATCH, at)) {
      if (outOfTime()) return;
      const result = await finalizeEnvelope(id);
      if (result.status === "completed" && !result.alreadyCompleted) summary.finalized.completed++;
      else if (result.status === "failed") summary.finalized.failed++;
    }
  });
  // Expiry before reminders, so nobody is reminded about a link that has just stopped working.
  await step(summary, "expire", () => expireOverdue(db, at, summary, outOfTime));
  await step(summary, "reminders", () => sendDueReminders(db, at, summary, outOfTime));
  await step(summary, "countersign", () => chaseCountersigners(db, at, summary, outOfTime));
  await step(summary, "recover emails", () => recoverLostEmails(db, at, summary, outOfTime));

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
