/**
 * The sender's side of the signing lifecycle: sending an agreement for a file,
 * looking at it, chasing it, correcting a signer, voiding it and countersigning.
 *
 * Every function takes an Actor and scopes every query by actor.orgId. An id that
 * belongs to another company behaves exactly like an id that does not exist.
 */
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { getDb, type Db, type DbOrTx } from "@/lib/db";
import {
  blobs,
  emailLog,
  envelopes,
  files,
  orgs,
  signers,
  templates,
  users,
  type Envelope,
  type EnvelopeStatus,
  type EventRow,
  type FileRow,
  type Org,
  type Signer,
  type Template,
  type User,
} from "@/lib/db/schema";
import { newId, sha256Hex } from "@/lib/ids";
import { IMAGE_FIELD_TYPES, LIMITS, type Field, type FieldValues } from "@/lib/types";
import { parseImageDataUrl } from "@/lib/pdf/stamp";
import { cleanMultilineText, cleanText, isValidEmail, normalizeEmail } from "@/lib/validation";
import { ServiceError, type Actor, type RequestMeta } from "./context";
import { EMAIL_UNVERIFIED_REASON, assertActiveActor, resolveSettings, type ResolvedOrgSettings } from "./accounts";
import { getBlob } from "./blobs";
import { describeEvent, listEvents, recordEvent } from "./events";
import { enqueueWebhookEvent } from "./webhooks";
import { deliveryFailedEmail, reminderEmail, signingRequestEmail } from "./email-templates";
import { describeWait, rateLimit } from "./rate-limit";
import { resolveCountersigner, templateReadiness } from "./templates";
import { mintSigningToken, signingUrl, tokenIsCurrent } from "./tokens";
import {
  AWAITING_CLIENT_STATUSES,
  OPEN_STATUSES,
  Raced,
  afterSignature,
  allValues,
  awaitingSeal,
  brandOf,
  calendarParts,
  defaultValues,
  documentFilename,
  emailCountersigner,
  fieldsFor,
  fileUrl,
  finalizeEnvelope,
  inTransaction,
  linkDeadEmail,
  loadEnvelopeContext,
  lockFile,
  longDate,
  orgTimeZone,
  readOnlyValues,
  recordSignature,
  resultForRecipient,
  safeSend,
  settleFileStatus,
  signedDateLabel,
  signingState,
  stampVisible,
  teamRecipient,
  validateSignerValues,
  valuesVisibleTo,
  webhookPayload,
  type DocumentDownload,
  type EnvelopeContext,
  type FinalizeResult,
  type LinkDeadKind,
  type ReadOnlyValue,
  type SendOutcome,
  type SigningResult,
} from "./signing";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What happened to the email that carries a signing link:
 * - emailed: it went out
 * - email_failed: the provider refused it; the cause is on the file's timeline
 * - email_not_configured: no email provider is set up, so nothing is ever emailed
 * - email_unverified: email works, but the company's owner has not confirmed their
 *   address yet, so nothing is emailed to people outside the company
 * In every case but the first the link is valid and must be shared by hand.
 */
export type Delivery = "emailed" | "email_not_configured" | "email_failed" | "email_unverified";

/** A sentence for the sender when the email did not go and why is already known; undefined otherwise. */
export function deliveryReason(delivery: Delivery | "not_their_turn"): string | undefined {
  if (delivery === "email_unverified") return EMAIL_UNVERIFIED_REASON;
  if (delivery === "email_not_configured") return "Email is not set up, so nothing was emailed. Copy the signing link and send it yourself.";
  if (delivery === "email_failed") return "The email could not be delivered. The reason is on the file's timeline. Copy the signing link and send it yourself, or correct the address and send again.";
  return undefined;
}

export interface SendOptions {
  /** Send this agreement instead of the company's default one. */
  templateId?: unknown;
  /** Void whatever is still out for signature on the file (and allow sending again after a completed one). */
  replace?: unknown;
  /**
   * With `replace`: the id of the open envelope the caller was looking at. It makes
   * a repeated request (a double click, a retry after a timeout) return the
   * replacement the first request created instead of replacing it again.
   */
  replaceEnvelopeId?: unknown;
  /** With `replace`: also discard an agreement the client has already signed and that is waiting for the countersignature. */
  replaceSigned?: unknown;
}

export interface SendResult {
  envelopeId: string;
  delivery: Delivery;
  /** Present unless delivery is "emailed": why nothing reached the client's inbox and what to do. */
  deliveryReason?: string;
  /** The client's signing link. Always returned so it can be shared by hand. */
  signingUrl: string;
  /** True when this request repeated an earlier one and its envelope was returned; nothing new was sent. */
  duplicate?: boolean;
}

/** A signer as the sender sees it: no link material and no signature images. */
export type SignerView = Omit<Signer, "tokenNonce" | "tokenHash" | "values"> & {
  /**
   * Present while this signer can still sign (or will be able to once it is their turn).
   * The company signer's link signs for the company, so it is only given to people
   * who may countersign: that signer, the chosen countersigner, owners and admins.
   */
  signingUrl: string | null;
  /** True when the envelope is waiting on this signer right now. */
  isTurn: boolean;
};

export type EnvelopeSummary = Omit<Envelope, "pages" | "fields" | "prefill">;

export interface EnvelopeDetail {
  envelope: Envelope;
  file: Pick<FileRow, "id" | "reference" | "clientName" | "clientEmail" | "agreementStatus">;
  signers: SignerView[];
  events: DescribedEvent[];
  /** True when the person asking may countersign this envelope right now. */
  canCountersign: boolean;
}

export type DescribedEvent = EventRow & { description: string };

export interface EnvelopeListItem extends EnvelopeSummary {
  signers: Pick<Signer, "id" | "role" | "order" | "name" | "email" | "status" | "signedAt" | "viewedAt">[];
}

export interface DeliveryResult {
  delivery: Delivery;
  /** Present unless delivery is "emailed": why nothing reached the inbox and what to do. */
  deliveryReason?: string;
  /** Null when the link is the company signer's and the caller is not someone who may countersign. */
  signingUrl: string | null;
}

/**
 * Ceilings on signing requests, so an account cannot be used to flood inboxes
 * through the platform's sending address. A company in its first days gets a much
 * lower ceiling: that is when an account made for abuse does its damage. It is still
 * high enough for a real customer to import their whole book of clients on day one;
 * the verified-owner rule and the per-recipient limit are what stop a throwaway account.
 */
export const SEND_LIMITS = {
  newOrgDays: 7,
  newOrgPerHour: 200,
  newOrgPerDay: 1000,
  perHour: 1500,
  perDay: 5000,
  /** Requests to one address in a day, counted across every company. */
  perRecipientPerDay: 10,
  /** Sends (including replacements) for one file in an hour. */
  perFilePerHour: 6,
} as const;

/** Recorded as the void reason of an envelope that a newer one replaced. */
export const REPLACED_REASON = "Replaced by a new signing request";

const NOT_FOUND = "That agreement was not found. It may belong to a different account or the link may be wrong.";
const SIGNER_NOT_FOUND = "That signer was not found. Reload the file and try again.";
const FILE_NOT_FOUND = "That file was not found. It may belong to a different account or the link may be wrong.";
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function idOf(value: unknown, message: string): string {
  // Ids are compared as text; anything else can never match and must not reach the driver as an object.
  if (typeof value !== "string" || value.length === 0 || value.length > 64) throw new ServiceError("not_found", message);
  return value;
}

/**
 * Everything here is open to any active member of the company (members create and
 * send files). The stored row decides, so a disabled account loses access at once.
 */
function assertActor(db: DbOrTx, actor: Actor): Promise<User | null> {
  return assertActiveActor(db, actor, "read");
}

function withReason<D extends Delivery | "not_their_turn">(delivery: D): { delivery: D; deliveryReason?: string } {
  const reason = deliveryReason(delivery);
  return reason ? { delivery, deliveryReason: reason } : { delivery };
}

function deliveryOf(outcome: SendOutcome): Delivery {
  if (outcome.status === "sent") return "emailed";
  if (outcome.status === "failed") return "email_failed";
  return outcome.unverified ? "email_unverified" : "email_not_configured";
}

function wholeNumber(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(max, Math.floor(n)) : fallback;
}

/** Reminder and expiry settings, tolerant of whatever is stored in the org's JSON. */
export function scheduleOf(settings: ResolvedOrgSettings): { reminderEveryDays: number; maxReminders: number; expireAfterDays: number } {
  return {
    reminderEveryDays: wholeNumber(settings.reminderEveryDays, 2, 365),
    maxReminders: wholeNumber(settings.maxReminders, 5, 50),
    expireAfterDays: wholeNumber(settings.expireAfterDays, 30, 3650),
  };
}

async function loadScoped(db: DbOrTx, actor: Actor, envelopeId: unknown): Promise<EnvelopeContext> {
  const id = idOf(envelopeId, NOT_FOUND);
  const ctx = await loadEnvelopeContext(db, id);
  // Checked after loading, against the session's org: another company's id is "not found".
  if (!ctx || ctx.envelope.orgId !== actor.orgId) throw new ServiceError("not_found", NOT_FOUND);
  return ctx;
}

async function loadScopedBySigner(db: DbOrTx, actor: Actor, signerId: unknown): Promise<{ ctx: EnvelopeContext; signer: Signer }> {
  const id = idOf(signerId, SIGNER_NOT_FOUND);
  const [row] = await db
    .select({ envelopeId: signers.envelopeId })
    .from(signers)
    .where(and(eq(signers.id, id), eq(signers.orgId, actor.orgId)))
    .limit(1);
  if (!row) throw new ServiceError("not_found", SIGNER_NOT_FOUND);
  const ctx = await loadEnvelopeContext(db, row.envelopeId);
  const signer = ctx?.signers.find((s) => s.id === id);
  if (!ctx || !signer || ctx.envelope.orgId !== actor.orgId) throw new ServiceError("not_found", SIGNER_NOT_FOUND);
  return { ctx, signer };
}

function closedError(envelope: Pick<Envelope, "status">, verb: string): ServiceError {
  const why: Partial<Record<EnvelopeStatus, string>> = {
    completed: "This agreement is already signed and complete",
    declined: "This agreement was declined",
    voided: "This agreement was voided",
    expired: "This agreement has expired",
  };
  return new ServiceError("conflict", `${why[envelope.status] ?? "This agreement is closed"}, so ${verb}. Send the agreement again from the file if a new signature is needed.`);
}

/** True while the envelope is waiting on exactly this signer. */
function isTurn(ctx: EnvelopeContext, signer: Signer, now = new Date()): boolean {
  return signingState(ctx.envelope, signer, now) === "ready";
}

function canStillSign(ctx: EnvelopeContext, signer: Signer): boolean {
  return OPEN_STATUSES.includes(ctx.envelope.status) && signer.status !== "signed" && signer.status !== "declined";
}

// ---------------------------------------------------------------------------
// Prefill
// ---------------------------------------------------------------------------

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
}

const TRUTHY = new Set(["true", "yes", "y", "1", "x", "on", "checked"]);

/**
 * Values for the prefill fields, resolved once when the agreement is sent. A field
 * whose value is missing on the file is simply left blank on the document.
 */
export function resolvePrefill(
  fields: readonly Field[],
  file: Pick<FileRow, "clientName" | "clientEmail" | "clientCompany" | "clientTitle" | "clientPhone" | "reference" | "description" | "data">,
  org: Pick<Org, "name" | "legalName"> & { settings?: unknown },
  now: Date = new Date(),
  /** IANA zone the dates are calendar days in. Defaults to the company's own zone, then UTC. */
  timeZone: string | null = orgTimeZone(org),
): FieldValues {
  const zone = timeZone || "UTC";
  const today = calendarParts(now, zone);
  const data: Record<string, unknown> = file.data && typeof file.data === "object" && !Array.isArray(file.data) ? file.data : {};
  const lookup = (key: string): unknown => {
    switch (key) {
      case "client_name":
        return file.clientName;
      case "client_email":
        return file.clientEmail;
      case "client_company":
        return file.clientCompany;
      case "client_title":
        return file.clientTitle;
      case "client_phone":
        return file.clientPhone;
      case "file_reference":
        return file.reference;
      case "file_description":
        return file.description;
      case "company_name":
        return org.legalName || org.name;
      case "today":
        return longDate(now, zone);
    }
    if (!key.startsWith("custom:")) return undefined;
    const custom = key.slice("custom:".length);
    if (Object.prototype.hasOwnProperty.call(data, custom)) return data[custom];
    // The detector binds "this ___ day of ___, 20__" blanks to these; they come from the send date.
    switch (custom) {
      case "today_day":
        return ordinal(today.day);
      case "today_month":
        return today.month;
      case "today_year":
        return String(today.year);
      case "today_year_short":
        return String(today.year % 100).padStart(2, "0");
    }
    return undefined;
  };

  const out: FieldValues = {};
  for (const field of fields) {
    if (!field || typeof field !== "object" || field.role !== "prefill" || typeof field.id !== "string" || typeof field.mergeKey !== "string") continue;
    // A picture cannot come from file details.
    if (IMAGE_FIELD_TYPES.includes(field.type) || field.type === "date_signed") continue;
    const raw = lookup(field.mergeKey);
    if (field.type === "checkbox") {
      if (raw === true || (typeof raw === "string" && TRUTHY.has(raw.trim().toLowerCase()))) out[field.id] = true;
      continue;
    }
    const text = cleanText(typeof raw === "number" ? String(raw) : raw, LIMITS.maxTextFieldLength);
    if (text) out[field.id] = text;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Readiness and who may act for the company
// ---------------------------------------------------------------------------

function snapshotFields(template: Pick<Template, "fields">): Field[] {
  const all = Array.isArray(template.fields) ? template.fields : [];
  return all.filter((f): f is Field => Boolean(f) && typeof f === "object" && typeof f.id === "string" && f.id.length > 0);
}

/**
 * Decides whether this agreement can be sent right now and who countersigns, by
 * the same rule the agreements list and activation use (templateReadiness), so the
 * badge, the send button, the API and the intake link can never disagree.
 * Throws not_ready with the first thing to fix.
 */
function checkReady(template: Template, org: Org, team: User[]): User | null {
  const members = team.map((u) => ({ id: u.id, role: u.role, disabled: u.disabledAt !== null, hasSignature: parseImageDataUrl(u.savedSignature).ok, user: u }));
  const readiness = templateReadiness(template, org, members);
  if (!readiness.ready) {
    const fields: Record<string, string> = {};
    for (const p of readiness.problems) if (!(p.code in fields)) fields[p.code] = p.message;
    throw new ServiceError("not_ready", `"${template.name}" cannot be sent yet. ${readiness.problems[0]?.message ?? ""} Then send again.`.replace(/\s+/g, " "), fields);
  }
  if (!snapshotFields(template).some((f) => f.role === "company")) return null;
  return resolveCountersigner(resolveSettings(org), members).member?.user ?? null;
}

/**
 * The company signer's link signs on the company's behalf, so only the people who
 * may countersign are ever shown it: the signer themselves, the chosen
 * countersigner, owners and admins. API keys and the system never are.
 */
function mayActForCompany(viewer: User | null, signer: Pick<Signer, "userId">, org: Org): boolean {
  if (!viewer || viewer.disabledAt) return false;
  return signer.userId === viewer.id || resolveSettings(org).countersignerUserId === viewer.id || viewer.role === "owner" || viewer.role === "admin";
}

function maySeeLink(viewer: User | null, signer: Pick<Signer, "userId" | "role">, org: Org): boolean {
  return signer.role !== "company" || mayActForCompany(viewer, signer, org);
}

/** The stored row of a signed-in actor, or null for an API key, the system, or an account that is gone. Never throws. */
export async function viewerOf(db: DbOrTx, actor: Actor): Promise<User | null> {
  if (!actor || actor.type !== "user" || typeof actor.userId !== "string") return null;
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.orgId, actor.orgId)))
    .limit(1);
  return user && !user.disabledAt ? user : null;
}

async function pickTemplate(db: Db, orgId: string, templateId: unknown): Promise<Template> {
  if (templateId !== undefined && templateId !== null && templateId !== "") {
    if (typeof templateId !== "string" || templateId.length > 64) {
      throw new ServiceError("not_found", "That agreement was not found. Choose one from your agreements and send again.");
    }
    const [row] = await db
      .select()
      .from(templates)
      .where(and(eq(templates.id, templateId), eq(templates.orgId, orgId)))
      .limit(1);
    if (!row) throw new ServiceError("not_found", "That agreement was not found. Choose one from your agreements and send again.");
    if (row.status !== "active") {
      throw new ServiceError(
        "not_ready",
        row.status === "archived"
          ? `"${row.name}" is archived and cannot be sent. Choose an active agreement.`
          : `"${row.name}" is still a draft. Review its fields and activate it, then send again.`,
      );
    }
    return row;
  }
  const active = await db
    .select()
    .from(templates)
    .where(and(eq(templates.orgId, orgId), eq(templates.status, "active")))
    .orderBy(desc(templates.isDefault), desc(templates.updatedAt))
    .limit(2);
  const chosen = active.find((t) => t.isDefault) ?? (active.length === 1 ? active[0] : undefined);
  if (!chosen) {
    throw new ServiceError(
      "not_ready",
      active.length === 0
        ? "Your company has no active agreement yet. Upload your agreement and activate it, then send again."
        : "Your company has more than one active agreement and none is the default. Choose a default agreement, or pick the one to send.",
    );
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Emails to signers
// ---------------------------------------------------------------------------

/** The signing request (or a reminder of it) for whoever the envelope is waiting on. */
export async function emailSigningRequest(ctx: EnvelopeContext, signer: Signer, opts: { reminderNumber?: number } = {}): Promise<SendOutcome> {
  if (!isValidEmail(normalizeEmail(signer.email))) {
    return { status: "failed", error: `"${cleanText(signer.email, 80)}" is not a valid email address. Correct it on the file and send again.` };
  }
  const settings = resolveSettings(ctx.org);
  const common = {
    brand: brandOf(ctx.org),
    signerName: signer.name,
    agreementName: ctx.envelope.templateName,
    fileReference: ctx.file.reference,
    url: signingUrl(signer),
    expiresAt: ctx.envelope.expiresAt,
  };
  const content = opts.reminderNumber
    ? reminderEmail({ ...common, reminderNumber: opts.reminderNumber })
    : signingRequestEmail({ ...common, message: typeof settings.emailMessage === "string" ? settings.emailMessage : null });
  return safeSend(ctx.org, { envelopeId: ctx.envelope.id, kind: opts.reminderNumber ? "reminder" : "signing_request", to: signer.email, ...content });
}

function failureReason(outcome: SendOutcome): string {
  if (outcome.unverified) return cleanText(outcome.error, 300) || EMAIL_UNVERIFIED_REASON;
  if (outcome.status === "skipped") return "Email is not set up, so nothing was emailed. Copy the signing link from the file and send it to the client yourself";
  return cleanText(outcome.error, 300) || "The email provider did not accept the message";
}

/**
 * Writes down what happened to the client's signing request. A delivered request is
 * what moves a draft envelope to "sent"; an undelivered one leaves it a draft with a
 * working link, and flags the file so someone shares the link or fixes the address.
 */
async function recordClientDelivery(db: Db, ctx: EnvelopeContext, signer: Signer, outcome: SendOutcome, actor: Actor, meta: RequestMeta | undefined, now: Date): Promise<void> {
  const base = { orgId: ctx.org.id, fileId: ctx.file.id, envelopeId: ctx.envelope.id };
  await inTransaction(db, async (tx) => {
    await lockFile(tx, ctx.org.id, ctx.file.id);
    if (outcome.status === "sent") {
      await tx
        .update(envelopes)
        .set({ status: "sent", sentAt: sql`coalesce(${envelopes.sentAt}, ${now.toISOString()}::timestamptz)`, updatedAt: now })
        .where(and(eq(envelopes.id, ctx.envelope.id), eq(envelopes.status, "draft")));
      await tx
        .update(files)
        .set({ agreementStatus: "out_for_signature", updatedAt: now })
        .where(and(eq(files.id, ctx.file.id), eq(files.orgId, ctx.org.id), eq(files.agreementStatus, "needs_attention")));
      await recordEvent(tx, { ...base, type: "envelope.sent", actor, meta, data: { email: signer.email, name: signer.name, signerId: signer.id } });
    } else {
      await tx
        .update(files)
        .set({ agreementStatus: "needs_attention", updatedAt: now })
        .where(and(eq(files.id, ctx.file.id), eq(files.orgId, ctx.org.id), eq(files.agreementStatus, "out_for_signature")));
      await recordEvent(tx, {
        ...base,
        type: "envelope.delivery_failed",
        actor,
        meta,
        data: {
          email: signer.email,
          signerId: signer.id,
          error: failureReason(outcome),
          configured: outcome.status !== "skipped" || outcome.unverified === true,
          ...(outcome.unverified ? { unverified: true } : {}),
        },
      });
    }
  });
}

/** Tell whoever sent the agreement that the client never got it. Best effort. */
async function tellSenderDeliveryFailed(db: Db, ctx: EnvelopeContext, signer: Signer): Promise<void> {
  try {
    const team = await teamRecipient(db, ctx.envelope);
    if (!team || normalizeEmail(team.email) === normalizeEmail(signer.email)) return;
    await safeSend(ctx.org, {
      envelopeId: ctx.envelope.id,
      kind: "delivery_failed",
      to: team.email,
      ...deliveryFailedEmail({
        brand: brandOf(ctx.org),
        recipientName: team.name,
        clientName: signer.name,
        clientEmail: signer.email,
        fileReference: ctx.file.reference,
        fileUrl: fileUrl(ctx.file.id),
      }),
    });
  } catch (err) {
    console.error("[envelopes] could not tell the sender about a failed delivery", err instanceof Error ? err.message : err);
  }
}

/** Email the signer whose turn it is and record the outcome. Never throws for an email problem. */
async function deliverTo(db: Db, ctx: EnvelopeContext, signer: Signer, actor: Actor, meta: RequestMeta | undefined, opts: { tellSender: boolean }): Promise<Delivery> {
  if (signer.role === "company") {
    // emailCountersigner records countersign.requested or envelope.delivery_failed itself.
    return deliveryOf(await emailCountersigner(ctx, signer));
  }
  const outcome = await emailSigningRequest(ctx, signer);
  try {
    await recordClientDelivery(db, ctx, signer, outcome, actor, meta, new Date());
  } catch (err) {
    console.error("[envelopes] could not record delivery", err instanceof Error ? err.message : err);
  }
  if (outcome.status === "failed" && opts.tellSender) await tellSenderDeliveryFailed(db, ctx, signer);
  return deliveryOf(outcome);
}

// ---------------------------------------------------------------------------
// Voiding (shared by void, replace and archive)
// ---------------------------------------------------------------------------

/**
 * Guarded void inside the caller's transaction, which must already hold the file's
 * lock. Only an envelope whose status is one of `allowed` is voided, so a caller who
 * meant to cancel an unsigned request cannot cancel one the client has just signed.
 * Returns false when nothing was voided.
 */
async function voidInTx(
  tx: DbOrTx,
  actor: Actor,
  ctx: Pick<EnvelopeContext, "envelope" | "file"> & { signers?: Signer[] },
  reason: string,
  meta: RequestMeta | undefined,
  now: Date,
  allowed: EnvelopeStatus[],
): Promise<boolean> {
  const [voided] = await tx
    .update(envelopes)
    .set({ status: "voided", voidReason: reason || null, nextReminderAt: null, updatedAt: now })
    .where(and(eq(envelopes.id, ctx.envelope.id), eq(envelopes.orgId, actor.orgId), inArray(envelopes.status, allowed)))
    .returning({ id: envelopes.id });
  if (!voided) return false;
  await recordEvent(tx, {
    orgId: actor.orgId,
    fileId: ctx.file.id,
    envelopeId: ctx.envelope.id,
    type: "envelope.voided",
    actor,
    meta,
    data: reason ? { reason } : {},
  });
  await enqueueWebhookEvent(tx, actor.orgId, "agreement.voided", webhookPayload(ctx, "voided", { voidedAt: now.toISOString(), reason: reason || null }));
  return true;
}

/**
 * Tell signers the link they hold is dead, in words that match what happened
 * (`kind`). Only people who actually have it are told: someone the request reached
 * by email, or who opened or signed it. A signer whose email never went out would
 * only be confused by the news.
 */
export async function notifySignersLinkDead(
  db: Db,
  ctx: EnvelopeContext,
  opts: { kind?: LinkDeadKind; reason?: string; expiredOn?: string | null; actor?: Actor } = {},
): Promise<void> {
  const kind: LinkDeadKind = opts.kind ?? "voided";
  try {
    const delivered = await db
      .select({ to: emailLog.to })
      .from(emailLog)
      .where(and(eq(emailLog.envelopeId, ctx.envelope.id), eq(emailLog.status, "sent")));
    const reached = new Set(delivered.map((d) => normalizeEmail(d.to)));
    const told = new Set<string>();
    for (const signer of ctx.signers) {
      const address = normalizeEmail(signer.email);
      if (signer.status === "waiting" || told.has(address)) continue;
      // The person voiding it does not need an email saying so.
      if (opts.actor?.type === "user" && signer.userId === opts.actor.userId) continue;
      if (!reached.has(address) && !signer.viewedAt && signer.status !== "signed") continue;
      told.add(address);
      await safeSend(ctx.org, {
        envelopeId: ctx.envelope.id,
        // Logged under what it says, so the email history of a file reads truthfully too.
        kind: kind === "expired" ? "link_expired" : kind,
        to: signer.email,
        ...linkDeadEmail(kind, { brand: brandOf(ctx.org), signerName: signer.name, agreementName: ctx.envelope.templateName, reason: opts.reason, expiredOn: opts.expiredOn }),
      });
    }
  } catch (err) {
    console.error("[envelopes] could not notify signers of a dead link", err instanceof Error ? err.message : err);
  }
}

function cleanReason(reason: unknown): string {
  return cleanMultilineText(reason, 1000);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function limitSender(key: string, limit: number, windowSeconds: number, what: string, scope?: "org"): Promise<void> {
  const result = await rateLimit(key, limit, windowSeconds);
  if (!result.ok) {
    throw new ServiceError(
      "rate_limited",
      `${what} Try again ${describeWait(result.retryAfterSeconds)}, or copy the signing link and send it yourself.`,
      scope ? { scope } : undefined,
    );
  }
}

/** Counts one new signing request against the file, the recipient and the company. Throws rate_limited. */
async function limitNewRequest(org: Org, fileId: string, recipient: string, now: Date): Promise<void> {
  const hold = (what: string, retryAfterSeconds: number, scope?: "org") =>
    new ServiceError("rate_limited", `${what} The file is saved; send the agreement from it ${describeWait(retryAfterSeconds)}.`, scope ? { scope } : undefined);

  const perFile = await rateLimit(`send:file:${fileId}`, SEND_LIMITS.perFilePerHour, 3600);
  if (!perFile.ok) throw hold("The agreement for this file has been sent several times in the last hour.", perFile.retryAfterSeconds);

  // Hashed so the counter is shared by every company without an address sitting in a key.
  const perRecipient = await rateLimit(`send:to:${sha256Hex(recipient).slice(0, 32)}`, SEND_LIMITS.perRecipientPerDay, 86_400);
  if (!perRecipient.ok) throw hold(`${recipient} has been sent the most signing requests one address can receive in a day.`, perRecipient.retryAfterSeconds);

  const isNew = now.getTime() - org.createdAt.getTime() < SEND_LIMITS.newOrgDays * DAY_MS;
  const hourly = isNew ? SEND_LIMITS.newOrgPerHour : SEND_LIMITS.perHour;
  const daily = isNew ? SEND_LIMITS.newOrgPerDay : SEND_LIMITS.perDay;
  const firstWeek = isNew ? ` Accounts in their first ${SEND_LIMITS.newOrgDays} days have a lower limit.` : "";
  const perHour = await rateLimit(`send:org:${org.id}:hour`, hourly, 3600);
  if (!perHour.ok) throw hold(`Your company has reached its limit of ${hourly} signing requests an hour.${firstWeek}`, perHour.retryAfterSeconds, "org");
  const perDay = await rateLimit(`send:org:${org.id}:day`, daily, 86_400);
  if (!perDay.ok) throw hold(`Your company has reached its limit of ${daily} signing requests a day.${firstWeek}`, perDay.retryAfterSeconds, "org");
}

/** How the request for an envelope that already exists went out, read back from what was recorded. */
async function deliveryOfExisting(db: Db, envelope: Envelope): Promise<Delivery> {
  if (envelope.sentAt) return "emailed";
  const trail = await listEvents(envelope.orgId, { envelopeId: envelope.id, limit: 50 }, db);
  // The latest attempt is the one that describes where the request stands now.
  const failed = [...trail].reverse().find((e) => e.type === "envelope.delivery_failed");
  const data = (failed?.data ?? {}) as Record<string, unknown>;
  if (data.unverified === true) return "email_unverified";
  return failed && data.configured === false ? "email_not_configured" : "email_failed";
}

/**
 * Send the company's agreement for one file. The envelope snapshots the agreement
 * as it is now, so later edits to the agreement never change what this client sees.
 *
 * An email problem does not undo the send: the envelope and its link are valid, the
 * failure is on the file's timeline, and the link comes back to the caller.
 */
export async function sendAgreementForFile(actor: Actor, fileId: unknown, opts: SendOptions = {}, meta?: RequestMeta): Promise<SendResult> {
  const db = await getDb();
  const sender = await assertActor(db, actor);
  const targetId = idOf(fileId, FILE_NOT_FOUND);
  const options: SendOptions = opts && typeof opts === "object" ? opts : {};
  const replace = options.replace === true;
  const replaceSigned = replace && options.replaceSigned === true;
  const seenEnvelopeId = replace && typeof options.replaceEnvelopeId === "string" && options.replaceEnvelopeId.length <= 64 ? options.replaceEnvelopeId : null;

  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, targetId), eq(files.orgId, actor.orgId)))
    .limit(1);
  if (!file) throw new ServiceError("not_found", FILE_NOT_FOUND);
  if (file.archivedAt) throw new ServiceError("conflict", "This file is archived. Restore it before sending an agreement.");
  const clientEmail = normalizeEmail(file.clientEmail);
  if (!isValidEmail(clientEmail)) {
    throw new ServiceError("invalid", "The client's email address on this file is not valid. Correct it on the file, then send the agreement.", {
      clientEmail: "Enter an email address like name@example.com.",
    });
  }

  const [org] = await db.select().from(orgs).where(eq(orgs.id, actor.orgId)).limit(1);
  if (!org) throw new ServiceError("forbidden", "Sign in again to continue.");
  const settings = resolveSettings(org);

  const template = await pickTemplate(db, actor.orgId, options.templateId);
  const fields = snapshotFields(template);
  const team = await db.select().from(users).where(eq(users.orgId, actor.orgId)).orderBy(asc(users.createdAt), asc(users.id));
  const countersigner = checkReady(template, org, team);

  // Blobs are immutable, so the envelope can point at the very bytes the agreement uses today.
  const [pdf] = await db
    .select({ id: blobs.id, sha256: blobs.sha256 })
    .from(blobs)
    .where(and(eq(blobs.id, template.pdfBlobId), eq(blobs.orgId, actor.orgId)))
    .limit(1);
  if (!pdf) throw new ServiceError("not_ready", `The document for "${template.name}" is missing from storage. Upload the agreement again, then send.`);

  const now = new Date();
  // Counted only once everything about the request is known to be sendable.
  await limitNewRequest(org, file.id, clientEmail, now);

  const schedule = scheduleOf(settings);
  const envelopeId = newId("env");
  const clientSignerId = newId("sgn");
  const clientToken = mintSigningToken(clientSignerId);
  const companySignerId = newId("sgn");
  const companyToken = mintSigningToken(companySignerId);
  const clientName = cleanText(file.clientName, 200) || clientEmail;

  const outcome = await inTransaction(db, async (tx) => {
    const replaced: EnvelopeContext[] = [];
    // Touching the file row takes its lock, so two sends for one file run one after the other
    // and the second sees the first one's envelope.
    const [locked] = await tx
      .update(files)
      .set({ updatedAt: now })
      .where(and(eq(files.id, file.id), eq(files.orgId, actor.orgId), isNull(files.archivedAt)))
      .returning({ id: files.id });
    if (!locked) throw new ServiceError("conflict", "This file was archived or removed while the agreement was being sent. Reload the file and try again.");

    const existing = await tx
      .select()
      .from(envelopes)
      .where(and(eq(envelopes.fileId, file.id), eq(envelopes.orgId, actor.orgId)))
      .orderBy(desc(envelopes.createdAt), desc(envelopes.id));
    const open = existing.filter((e) => OPEN_STATUSES.includes(e.status));
    const hasCompleted = existing.some((e) => e.status === "completed");
    if (!replace && open.length > 0) {
      throw new ServiceError("conflict", "An agreement is already out for signature on this file. Void it first, or send again and choose to replace it.");
    }
    if (!replace && hasCompleted) {
      throw new ServiceError("conflict", "This file already has a signed agreement. To have the client sign again, send again and choose to replace it.");
    }
    if (seenEnvelopeId) {
      const seen = existing.find((e) => e.id === seenEnvelopeId);
      // The envelope the caller was looking at has already been replaced: this is the
      // same request arriving twice, and its answer is the replacement that exists.
      if (seen && seen.status === "voided" && seen.voidReason === REPLACED_REASON && open.length > 0) {
        return { duplicate: open[0], replaced };
      }
      if (open.some((e) => e.id !== seenEnvelopeId)) {
        throw new ServiceError("conflict", "The agreement on this file changed while you were looking at it. Reload the file, then send again if it is still needed.");
      }
    }
    if (!replaceSigned && open.some((e) => e.status === "client_signed")) {
      throw new ServiceError(
        "conflict",
        "The client has already signed the agreement that is out on this file, and it is waiting for your company's countersignature. Countersign it, or confirm that you want to discard the signed agreement and send a new one.",
        { confirm: "replaceSigned" },
      );
    }
    for (const old of open) {
      const oldSigners = await tx.select().from(signers).where(eq(signers.envelopeId, old.id));
      if (await voidInTx(tx, actor, { envelope: old, file, signers: oldSigners }, REPLACED_REASON, meta, now, replaceSigned ? OPEN_STATUSES : AWAITING_CLIENT_STATUSES)) {
        replaced.push({ envelope: old, org, file, signers: oldSigners });
      }
    }

    await tx.insert(envelopes).values({
      id: envelopeId,
      orgId: actor.orgId,
      fileId: file.id,
      templateId: template.id,
      templateName: template.name,
      templateVersion: template.version,
      pdfBlobId: pdf.id,
      pdfSha256: pdf.sha256,
      pages: Array.isArray(template.pages) ? template.pages : [],
      fields,
      prefill: resolvePrefill(fields, file, org, now),
      // A draft until the request is known to have gone out; the link works either way.
      status: "draft",
      expiresAt: schedule.expireAfterDays > 0 ? new Date(now.getTime() + schedule.expireAfterDays * DAY_MS) : null,
      nextReminderAt: schedule.reminderEveryDays > 0 && schedule.maxReminders > 0 ? new Date(now.getTime() + schedule.reminderEveryDays * DAY_MS) : null,
      createdBy: sender?.id ?? null,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(signers).values({
      id: clientSignerId,
      envelopeId,
      orgId: actor.orgId,
      role: "client",
      order: 1,
      name: clientName,
      email: clientEmail,
      tokenNonce: clientToken.tokenNonce,
      tokenHash: clientToken.tokenHash,
      status: "sent",
      createdAt: now,
    });
    if (countersigner) {
      await tx.insert(signers).values({
        id: companySignerId,
        envelopeId,
        orgId: actor.orgId,
        role: "company",
        order: 2,
        name: countersigner.name,
        email: countersigner.email,
        tokenNonce: companyToken.tokenNonce,
        tokenHash: companyToken.tokenHash,
        userId: countersigner.id,
        status: "waiting",
        createdAt: now,
      });
    }
    // A signed agreement already on the file keeps it "signed": work there is cleared.
    if (!hasCompleted) {
      await tx
        .update(files)
        .set({ agreementStatus: "out_for_signature", updatedAt: now })
        .where(and(eq(files.id, file.id), eq(files.orgId, actor.orgId)));
    }
    await recordEvent(tx, {
      orgId: actor.orgId,
      fileId: file.id,
      envelopeId,
      type: "envelope.created",
      actor,
      meta,
      data: { templateName: template.name, templateId: template.id, templateVersion: template.version, sha256: pdf.sha256 },
    });
    // The signing link is deliberately not in the payload: payloads are stored and sent to
    // third parties, and the link is the client's credential. Integrations fetch it with getSigningLink.
    await enqueueWebhookEvent(
      tx,
      actor.orgId,
      "agreement.sent",
      webhookPayload({ envelope: { id: envelopeId, templateName: template.name } as Envelope, file, signers: [{ role: "client", name: clientName, email: clientEmail }] }, "sent", {
        sentAt: now.toISOString(),
        clientSignerId,
      }),
    );
    return { duplicate: null, replaced };
  });

  if (outcome.duplicate) {
    const [client] = await db
      .select()
      .from(signers)
      .where(and(eq(signers.envelopeId, outcome.duplicate.id), eq(signers.orgId, actor.orgId), eq(signers.role, "client")))
      .limit(1);
    if (!client) throw new ServiceError("conflict", "The agreement on this file changed while it was being sent. Reload the file and try again.");
    const earlier = await deliveryOfExisting(db, outcome.duplicate);
    return { envelopeId: outcome.duplicate.id, ...withReason(earlier), signingUrl: signingUrl(client), duplicate: true };
  }

  // Everything below is after commit: the envelope exists whatever happens to the emails.
  // If this request dies here, the scheduler finds the unsent draft and sends it.
  const url = signingUrl({ id: clientSignerId, tokenNonce: clientToken.tokenNonce });
  let delivery: Delivery = "email_failed";
  try {
    for (const old of outcome.replaced) {
      await notifySignersLinkDead(db, old, { kind: "voided", reason: "It was replaced by a new signing request, which you will receive separately.", actor });
    }
    const ctx = await loadEnvelopeContext(db, envelopeId);
    const client = ctx?.signers.find((s) => s.id === clientSignerId);
    // Read again after commit: a request that was voided or replaced a moment later must not be emailed.
    if (ctx && client && isTurn(ctx, client)) delivery = await deliverTo(db, ctx, client, actor, meta, { tellSender: true });
  } catch (err) {
    console.error("[envelopes] post-send work failed", err instanceof Error ? err.message : err);
  }
  return { envelopeId, ...withReason(delivery), signingUrl: url };
}

/**
 * Send the signing request of an envelope whose first email never went out because
 * the request that created it died in between. Does nothing unless the envelope is
 * still an unsent draft waiting on its client. Used by the scheduler.
 */
export async function deliverUnsentDraft(envelopeId: string): Promise<Delivery | null> {
  const db = await getDb();
  const ctx = await loadEnvelopeContext(db, envelopeId);
  if (!ctx || ctx.envelope.status !== "draft") return null;
  const client = ctx.signers.find((s) => s.role === "client");
  if (!client || !isTurn(ctx, client)) return null;
  return deliverTo(db, ctx, client, { type: "system", orgId: ctx.org.id, label: "System" }, undefined, { tellSender: true });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A signer as `viewer` may see it. The file page and the envelope page both build their signers with this. */
export function signerView(ctx: EnvelopeContext, signer: Signer, now: Date, viewer: User | null): SignerView {
  const { tokenNonce, tokenHash, values, ...rest } = signer;
  void tokenHash;
  void values;
  return {
    ...rest,
    // A link derived from a different APP_SECRET would be dead; getSigningLink re-mints those.
    signingUrl: canStillSign(ctx, signer) && tokenIsCurrent(signer) && maySeeLink(viewer, signer, ctx.org) ? signingUrl({ id: signer.id, tokenNonce }) : null,
    isTurn: isTurn(ctx, signer, now),
  };
}

/** True when `viewer` may countersign this envelope and it is waiting for exactly that. */
export function canCountersignNow(ctx: EnvelopeContext, viewer: User | null, now: Date = new Date()): boolean {
  const company = ctx.signers.find((s) => s.role === "company");
  return Boolean(company) && isTurn(ctx, company as Signer, now) && mayActForCompany(viewer, company as Signer, ctx.org);
}

export function describeEvents(trail: EventRow[]): DescribedEvent[] {
  return trail.map((e) => ({ ...e, description: describeEvent(e) }));
}

/** One envelope with its signers, its audit trail and the links of signers who have not signed. */
export async function getEnvelope(actor: Actor, id: unknown): Promise<EnvelopeDetail> {
  const db = await getDb();
  const viewer = await assertActor(db, actor);
  const ctx = await loadScoped(db, actor, id);
  const now = new Date();
  const trail = await listEvents(actor.orgId, { envelopeId: ctx.envelope.id, limit: 500 }, db);
  return {
    envelope: ctx.envelope,
    file: {
      id: ctx.file.id,
      reference: ctx.file.reference,
      clientName: ctx.file.clientName,
      clientEmail: ctx.file.clientEmail,
      agreementStatus: ctx.file.agreementStatus,
    },
    signers: ctx.signers.map((s) => signerView(ctx, s, now, viewer)),
    events: describeEvents(trail),
    canCountersign: canCountersignNow(ctx, viewer, now),
  };
}

/**
 * An envelope as the REST API and integrations see it: no document snapshot, no
 * link material, no signature images, and none of the signers' IP addresses or
 * browser details that the audit trail keeps.
 */
export function toPublicEnvelope(envelope: Envelope, envelopeSigners: readonly Pick<Signer, "id" | "role" | "order" | "name" | "email" | "status" | "viewedAt" | "signedAt">[] = []) {
  const iso = (at: Date | null) => (at ? at.toISOString() : null);
  return {
    id: envelope.id,
    fileId: envelope.fileId,
    agreementId: envelope.templateId,
    agreementName: envelope.templateName,
    agreementVersion: envelope.templateVersion,
    status: envelope.status,
    sentAt: iso(envelope.sentAt),
    completedAt: iso(envelope.completedAt),
    expiresAt: iso(envelope.expiresAt),
    declineReason: envelope.declineReason,
    voidReason: envelope.voidReason,
    originalSha256: envelope.pdfSha256,
    signedSha256: envelope.finalSha256,
    reminderCount: envelope.reminderCount,
    createdAt: envelope.createdAt.toISOString(),
    updatedAt: envelope.updatedAt.toISOString(),
    signers: [...envelopeSigners]
      .sort((a, b) => a.order - b.order)
      .map((s) => ({ id: s.id, role: s.role, name: s.name, email: s.email, status: s.status, viewedAt: iso(s.viewedAt), signedAt: iso(s.signedAt) })),
  };
}

const ENVELOPE_STATUSES: readonly EnvelopeStatus[] = ["draft", "sent", "viewed", "client_signed", "completed", "declined", "voided", "expired"];

/** Envelopes of the actor's company, newest first, optionally for one file or one status. */
export async function listEnvelopes(actor: Actor, opts: { fileId?: unknown; status?: unknown; limit?: unknown; offset?: unknown } = {}): Promise<EnvelopeListItem[]> {
  const db = await getDb();
  await assertActor(db, actor);
  const options = opts && typeof opts === "object" ? opts : {};
  const where: SQL[] = [eq(envelopes.orgId, actor.orgId)];
  if (options.fileId !== undefined && options.fileId !== null) {
    if (typeof options.fileId !== "string" || options.fileId.length > 64) return [];
    where.push(eq(envelopes.fileId, options.fileId));
  }
  if (options.status !== undefined && options.status !== null) {
    const wanted = (Array.isArray(options.status) ? options.status : [options.status]).filter((s): s is EnvelopeStatus => ENVELOPE_STATUSES.includes(s as EnvelopeStatus));
    if (wanted.length === 0) return [];
    where.push(inArray(envelopes.status, wanted));
  }
  const limit = Math.max(1, wholeNumber(options.limit, 50, 200));
  const offset = wholeNumber(options.offset, 0, 1_000_000);
  const rows = await db
    .select()
    .from(envelopes)
    .where(and(...where))
    .orderBy(desc(envelopes.createdAt), desc(envelopes.id))
    .limit(limit)
    .offset(offset);
  if (rows.length === 0) return [];
  const people = await db
    .select({
      id: signers.id,
      envelopeId: signers.envelopeId,
      role: signers.role,
      order: signers.order,
      name: signers.name,
      email: signers.email,
      status: signers.status,
      signedAt: signers.signedAt,
      viewedAt: signers.viewedAt,
    })
    .from(signers)
    .where(
      and(
        eq(signers.orgId, actor.orgId),
        inArray(
          signers.envelopeId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(signers.order);
  return rows.map((row) => {
    const { pages, fields, prefill, ...summary } = row;
    void pages;
    void fields;
    void prefill;
    return {
      ...summary,
      signers: people.filter((p) => p.envelopeId === row.id).map(({ envelopeId, ...p }) => (void envelopeId, p)),
    };
  });
}

function companyLinkForbidden(signer: Pick<Signer, "name">): ServiceError {
  return new ServiceError(
    "forbidden",
    `This link signs on your company's behalf, so only ${signer.name}, your company's countersigner, an owner or an admin can use it. Ask one of them to countersign from the file.`,
  );
}

/**
 * The signing link for a signer who has not signed, so the sender can pass it on by
 * hand. If the server secret changed since the link was issued, the old link is
 * already dead, so a new one is issued instead of showing one that cannot work.
 */
export async function getSigningLink(actor: Actor, signerId: unknown, meta?: RequestMeta): Promise<{ signingUrl: string; signer: Pick<Signer, "id" | "name" | "email" | "role" | "status"> }> {
  const db = await getDb();
  const viewer = await assertActor(db, actor);
  const { ctx, signer } = await loadScopedBySigner(db, actor, signerId);
  if (!maySeeLink(viewer, signer, ctx.org)) throw companyLinkForbidden(signer);
  if (!OPEN_STATUSES.includes(ctx.envelope.status)) throw closedError(ctx.envelope, "its signing links no longer work");
  if (signer.status === "signed" || signer.status === "declined") {
    throw new ServiceError("conflict", `${signer.name} has already ${signer.status === "signed" ? "signed" : "declined"}, so there is no link to share.`);
  }
  let current: Pick<Signer, "id" | "tokenNonce"> = signer;
  if (!tokenIsCurrent(signer)) {
    const token = mintSigningToken(signer.id);
    await inTransaction(db, async (tx) => {
      await lockFile(tx, actor.orgId, ctx.file.id);
      await tx
        .update(signers)
        .set({ tokenNonce: token.tokenNonce, tokenHash: token.tokenHash })
        .where(and(eq(signers.id, signer.id), eq(signers.orgId, actor.orgId)));
      await recordEvent(tx, { orgId: actor.orgId, fileId: ctx.file.id, envelopeId: ctx.envelope.id, type: "link.reissued", actor, meta, data: { signerId: signer.id, email: signer.email } });
    });
    current = { id: signer.id, tokenNonce: token.tokenNonce };
  }
  return { signingUrl: signingUrl(current), signer: { id: signer.id, name: signer.name, email: signer.email, role: signer.role, status: signer.status } };
}

/**
 * The agreement as a PDF:
 * - "original": the unsigned agreement exactly as it was sent
 * - "in_progress": the agreement with the file's details and every signature given so far drawn in,
 *   which is what a countersigner must see before signing
 * - "signed": the sealed copy, once everyone has signed
 */
export async function getDocument(actor: Actor, envelopeId: unknown, kind: "original" | "in_progress" | "signed"): Promise<DocumentDownload> {
  const db = await getDb();
  await assertActor(db, actor);
  const ctx = await loadScoped(db, actor, envelopeId);
  if (kind !== "original" && kind !== "signed" && kind !== "in_progress") {
    throw new ServiceError("invalid", 'Ask for the "original", the "in_progress" or the "signed" document.');
  }
  if (kind === "signed") {
    if (ctx.envelope.status !== "completed" || !ctx.envelope.finalBlobId) {
      throw new ServiceError("not_ready", "The signed copy does not exist yet. It is created when everyone has signed.");
    }
    const blob = await getBlob(actor.orgId, ctx.envelope.finalBlobId, db);
    if (!blob) throw new ServiceError("not_found", "The signed copy could not be loaded from storage. Try again, and contact support if it keeps happening.");
    return { bytes: blob.bytes, filename: documentFilename(ctx.envelope, ctx.file, "signed"), contentType: "application/pdf", sha256: blob.sha256 };
  }
  const blob = await getBlob(actor.orgId, ctx.envelope.pdfBlobId, db);
  if (!blob) throw new ServiceError("not_found", "The agreement could not be loaded from storage. Try again, and contact support if it keeps happening.");
  if (kind === "in_progress") {
    const bytes = await stampVisible(blob.bytes, ctx.envelope, allValues(ctx));
    return { bytes, filename: documentFilename(ctx.envelope, ctx.file, "in progress"), contentType: "application/pdf", sha256: sha256Hex(bytes) };
  }
  return { bytes: blob.bytes, filename: documentFilename(ctx.envelope, ctx.file, "unsigned"), contentType: "application/pdf", sha256: blob.sha256 };
}

export interface CountersignSession {
  envelopeId: string;
  agreementName: string;
  fileReference: string;
  client: { name: string; email: string; signedAt: string | null };
  /** The company signer the envelope is assigned to. Whoever countersigns becomes the name on the certificate. */
  signer: { id: string; name: string; email: string };
  /** False with `reason` when the person asking cannot countersign right now. */
  canCountersign: boolean;
  reason: string | null;
  pages: Envelope["pages"];
  /** The company's own fields, to be filled in. */
  fields: Field[];
  /** Suggested values for those fields, from the profile of the person asking. */
  defaults: FieldValues;
  /** What is already on the document (file details and the client's answers), with where each value sits. */
  readOnly: ReadOnlyValue[];
  /** True when the person asking has a saved signature that countersign() will use if none is drawn. */
  hasSavedSignature: boolean;
}

/**
 * Everything the in-app countersign page needs, for a signed-in team member: the
 * company's fields, sensible defaults, and what the client put on the document.
 * Pair it with getDocument(actor, id, "in_progress") for the PDF itself. Unlike the
 * emailed link, looking at this records nothing and counts against no public limit.
 */
export async function getCountersignSession(actor: Actor, envelopeId: unknown): Promise<CountersignSession> {
  const db = await getDb();
  const viewer = await assertActor(db, actor);
  const ctx = await loadScoped(db, actor, envelopeId);
  const signer = ctx.signers.find((s) => s.role === "company");
  if (!signer) throw new ServiceError("conflict", "This agreement has no fields for your company to sign, so there is nothing to countersign.");
  const client = ctx.signers.find((s) => s.role === "client");
  const own = fieldsFor(ctx.envelope, "company");

  let reason: string | null = null;
  if (signer.status === "signed") reason = "This agreement has already been countersigned.";
  else if (!OPEN_STATUSES.includes(ctx.envelope.status)) reason = closedError(ctx.envelope, "it cannot be countersigned").message;
  else if (ctx.envelope.status !== "client_signed" || signer.status === "waiting") reason = "The client has not signed yet. You can countersign as soon as they have.";
  else if (!viewer) reason = "Countersigning needs a signed-in team member. Sign in and countersign from the file.";
  else if (!mayActForCompany(viewer, signer, ctx.org)) reason = `Only ${signer.name}, your company's countersigner, an owner or an admin can countersign this agreement.`;

  return {
    envelopeId: ctx.envelope.id,
    agreementName: ctx.envelope.templateName,
    fileReference: ctx.file.reference,
    client: { name: client?.name ?? ctx.file.clientName, email: client?.email ?? ctx.file.clientEmail, signedAt: client?.signedAt ? client.signedAt.toISOString() : null },
    signer: { id: signer.id, name: signer.name, email: signer.email },
    canCountersign: reason === null,
    reason,
    pages: Array.isArray(ctx.envelope.pages) ? ctx.envelope.pages : [],
    fields: own,
    defaults: viewer ? defaultValues(own, { name: viewer.name, email: viewer.email, title: viewer.title, company: ctx.org.legalName || ctx.org.name }) : {},
    readOnly: readOnlyValues(ctx.envelope, "company", valuesVisibleTo(ctx, signer)),
    hasSavedSignature: Boolean(viewer) && parseImageDataUrl(viewer?.savedSignature).ok,
  };
}

// ---------------------------------------------------------------------------
// Chasing
// ---------------------------------------------------------------------------

function notTurnError(ctx: EnvelopeContext, signer: Signer): ServiceError {
  if (!OPEN_STATUSES.includes(ctx.envelope.status)) return closedError(ctx.envelope, "there is nothing to send");
  if (signer.status === "signed") return new ServiceError("conflict", `${signer.name} has already signed, so there is nothing to send them.`);
  if (signer.status === "declined") return new ServiceError("conflict", `${signer.name} declined to sign, so there is nothing to send them.`);
  if (signer.status === "waiting") return new ServiceError("conflict", `${signer.name} cannot sign until the client has signed. They are emailed automatically when it is their turn.`);
  return new ServiceError("conflict", "This signing request has expired. Send the agreement again from the file.");
}

/** Email a signer their request again. Works for the client, and for the countersigner once it is their turn. */
export async function resendToSigner(actor: Actor, signerId: unknown, meta?: RequestMeta): Promise<DeliveryResult> {
  const db = await getDb();
  const viewer = await assertActor(db, actor);
  const { ctx, signer } = await loadScopedBySigner(db, actor, signerId);
  if (!isTurn(ctx, signer)) throw notTurnError(ctx, signer);
  await limitSender(`resend:signer:${signer.id}`, 5, 3600, `This request has been sent to ${signer.name} several times in the last hour.`);
  await limitSender(`resend:org:${actor.orgId}`, 300, 3600, "Your company has sent a lot of signing requests in the last hour.", "org");
  const delivery = await deliverTo(db, ctx, signer, actor, meta, { tellSender: false });
  // The email goes to the signer's own inbox either way; the link itself is only handed to people who may use it.
  return { ...withReason(delivery), signingUrl: maySeeLink(viewer, signer, ctx.org) ? signingUrl(signer) : null };
}

/**
 * Nudge whoever the envelope is waiting on, now. Does not use up one of the
 * automatic reminders, but pushes the next automatic one back so two do not
 * arrive on the same day.
 */
export async function sendReminderNow(actor: Actor, envelopeId: unknown, meta?: RequestMeta): Promise<DeliveryResult & { to: string }> {
  const db = await getDb();
  const viewer = await assertActor(db, actor);
  const ctx = await loadScoped(db, actor, envelopeId);
  if (!OPEN_STATUSES.includes(ctx.envelope.status)) throw closedError(ctx.envelope, "there is nobody to remind");
  const now = new Date();
  const signer = ctx.signers.find((s) => isTurn(ctx, s, now));
  if (!signer) {
    if (ctx.signers.every((s) => s.status === "signed")) {
      throw new ServiceError("conflict", "Everyone has signed. The final copy is being prepared, so there is nobody to remind.");
    }
    throw new ServiceError("conflict", "This signing request has expired. Send the agreement again from the file.");
  }
  await limitSender(`remind:envelope:${ctx.envelope.id}`, 3, 3600, `${signer.name} has already been reminded several times in the last hour.`);

  if (signer.role === "company") {
    const delivery = deliveryOf(await emailCountersigner(ctx, signer));
    return { ...withReason(delivery), signingUrl: maySeeLink(viewer, signer, ctx.org) ? signingUrl(signer) : null, to: signer.email };
  }

  // The first request never arrived, so this is not a reminder of anything: send the
  // request itself, which is also what moves the envelope from draft to sent.
  if (ctx.envelope.status === "draft") {
    const delivery = await deliverTo(db, ctx, signer, actor, meta, { tellSender: false });
    return { ...withReason(delivery), signingUrl: signingUrl(signer), to: signer.email };
  }

  const outcome = await emailSigningRequest(ctx, signer, { reminderNumber: ctx.envelope.reminderCount + 1 });
  const every = scheduleOf(resolveSettings(ctx.org)).reminderEveryDays;
  try {
    await inTransaction(db, async (tx) => {
      await lockFile(tx, actor.orgId, ctx.file.id);
      if (outcome.status === "sent") {
        await tx
          .update(envelopes)
          .set({
            lastReminderAt: now,
            // Only moves a reminder that was already scheduled; it never switches reminders back on.
            nextReminderAt: sql`case when ${envelopes.nextReminderAt} is null then null else ${new Date(now.getTime() + Math.max(1, every) * DAY_MS).toISOString()}::timestamptz end`,
            updatedAt: now,
          })
          .where(and(eq(envelopes.id, ctx.envelope.id), inArray(envelopes.status, AWAITING_CLIENT_STATUSES)));
      }
      await recordEvent(tx, {
        orgId: actor.orgId,
        fileId: ctx.file.id,
        envelopeId: ctx.envelope.id,
        type: outcome.status === "sent" ? "reminder.sent" : "envelope.delivery_failed",
        actor,
        meta,
        data: outcome.status === "sent" ? { email: signer.email, manual: true } : { email: signer.email, error: failureReason(outcome), kind: "reminder" },
      });
    });
  } catch (err) {
    console.error("[envelopes] could not record reminder", err instanceof Error ? err.message : err);
  }
  return { ...withReason(deliveryOf(outcome)), signingUrl: signingUrl(signer), to: signer.email };
}

// ---------------------------------------------------------------------------
// Correcting a signer
// ---------------------------------------------------------------------------

/**
 * Change who a signing request goes to (a typo in the address, the wrong person).
 * The old link stops working at once, because whoever holds it is no longer the
 * signer; the new link is emailed if it is that signer's turn.
 *
 * For the client, the file's own client name and email follow in the same step, so
 * the file, later emails, webhooks and any re-send all use the corrected details.
 * The company signer can only be changed by an owner or admin, and only to an
 * active member of the team: that link signs for the company.
 */
export async function updateSigner(
  actor: Actor,
  signerId: unknown,
  patch: { name?: unknown; email?: unknown },
  meta?: RequestMeta,
): Promise<{ signer: SignerView; delivery: Delivery | "not_their_turn"; deliveryReason?: string; signingUrl: string | null }> {
  const db = await getDb();
  const viewer = await assertActor(db, actor);
  const { ctx, signer } = await loadScopedBySigner(db, actor, signerId);
  const isCompany = signer.role === "company";
  if (isCompany && (!viewer || (viewer.role !== "owner" && viewer.role !== "admin"))) {
    throw new ServiceError("forbidden", "Only an owner or admin can change who countersigns an agreement. Ask one of them to make this change.");
  }
  if (!OPEN_STATUSES.includes(ctx.envelope.status)) throw closedError(ctx.envelope, "its signers cannot be changed");
  if (signer.status === "signed" || signer.status === "declined") {
    throw new ServiceError("conflict", `${signer.name} has already ${signer.status === "signed" ? "signed" : "declined"}, so their details cannot be changed.`);
  }

  const input = patch && typeof patch === "object" ? patch : {};
  const errors: Record<string, string> = {};
  let name = signer.name;
  let email = signer.email;
  const nameGiven = input.name !== undefined && input.name !== null;
  if (nameGiven) {
    if (typeof input.name !== "string") errors.name = "Enter the signer's name.";
    else {
      name = cleanText(input.name, 200);
      if (!name) errors.name = "Enter the signer's name.";
    }
  }
  if (input.email !== undefined && input.email !== null) {
    email = normalizeEmail(input.email);
    if (!isValidEmail(email)) errors.email = "Enter an email address like name@example.com.";
  }
  if (input.name == null && input.email == null) errors.name = "Enter a new name or email address for the signer.";
  if (Object.keys(errors).length) throw new ServiceError("invalid", Object.values(errors)[0], errors);

  const emailChanged = normalizeEmail(signer.email) !== email;
  const token = mintSigningToken(signer.id);
  const now = new Date();
  let teamUser: Pick<User, "id" | "name"> | undefined;
  if (isCompany) {
    [teamUser] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.orgId, actor.orgId), eq(users.email, email), isNull(users.disabledAt)))
      .limit(1);
    if (!teamUser) {
      const message = `${email} is not an active member of your team. The countersigner signs for your company, so invite them to the team first, or choose someone who is already on it.`;
      throw new ServiceError("invalid", message, { email: message });
    }
    // The certificate carries the team member's own name unless one was typed.
    if (!nameGiven && emailChanged) name = teamUser.name;
  }

  try {
    await inTransaction(db, async (tx) => {
      await lockFile(tx, actor.orgId, ctx.file.id);
      // The envelope row lock orders this against a signature arriving on the old link.
      const [open] = await tx
        .update(envelopes)
        .set({ updatedAt: now })
        .where(and(eq(envelopes.id, ctx.envelope.id), eq(envelopes.orgId, actor.orgId), inArray(envelopes.status, OPEN_STATUSES)))
        .returning({ prefill: envelopes.prefill });
      if (!open) throw new Raced();
      const [updated] = await tx
        .update(signers)
        .set({
          name,
          email,
          tokenNonce: token.tokenNonce,
          tokenHash: token.tokenHash,
          ...(isCompany && teamUser ? { userId: teamUser.id } : {}),
          // A different person has not seen the agreement, whatever the previous one did.
          ...(emailChanged && signer.status === "viewed" ? { status: "sent" as const, viewedAt: null } : {}),
        })
        .where(and(eq(signers.id, signer.id), eq(signers.orgId, actor.orgId), inArray(signers.status, ["waiting", "sent", "viewed"])))
        .returning({ id: signers.id });
      if (!updated) throw new Raced();

      const base = { orgId: actor.orgId, fileId: ctx.file.id, envelopeId: ctx.envelope.id };
      if (signer.role === "client") {
        // The client's name and email printed on the document follow the correction.
        const prefill: FieldValues = { ...(open.prefill ?? {}) };
        let touched = false;
        for (const field of Array.isArray(ctx.envelope.fields) ? ctx.envelope.fields : []) {
          if (!field || field.role !== "prefill") continue;
          if (field.mergeKey === "client_name") {
            prefill[field.id] = name;
            touched = true;
          } else if (field.mergeKey === "client_email") {
            prefill[field.id] = email;
            touched = true;
          }
        }
        if (touched) await tx.update(envelopes).set({ prefill }).where(eq(envelopes.id, ctx.envelope.id));

        // One correction, one place: the file is what lists, search, webhooks and a later re-send read.
        const changed: string[] = [];
        if (ctx.file.clientName !== name) changed.push("client name");
        if (normalizeEmail(ctx.file.clientEmail) !== email) changed.push("client email");
        if (changed.length > 0) {
          await tx
            .update(files)
            .set({ clientName: name, clientEmail: email, updatedAt: now })
            .where(and(eq(files.id, ctx.file.id), eq(files.orgId, actor.orgId)));
          await recordEvent(tx, { ...base, envelopeId: undefined, type: "file.updated", actor, meta, data: { changed, reference: ctx.file.reference } });
        }
      }

      await recordEvent(tx, {
        ...base,
        type: "signer.updated",
        actor,
        meta,
        data: { signerId: signer.id, role: signer.role, ...(name !== signer.name ? { name } : {}), email, previousEmail: signer.email, previousName: signer.name },
      });
      await recordEvent(tx, { ...base, type: "link.reissued", actor, meta, data: { signerId: signer.id, email } });
    });
  } catch (err) {
    if (!(err instanceof Raced)) throw err;
    const after = await loadScopedBySigner(db, actor, signer.id);
    if (!OPEN_STATUSES.includes(after.ctx.envelope.status)) throw closedError(after.ctx.envelope, "its signers cannot be changed");
    throw new ServiceError("conflict", `${after.signer.name} signed or declined while you were making this change, so their details were not changed.`);
  }

  const after = await loadScopedBySigner(db, actor, signer.id);
  // Not their turn yet: nothing is sent now, and they are emailed the new link when it is.
  let delivery: Delivery | "not_their_turn" = "not_their_turn";
  if (isTurn(after.ctx, after.signer)) {
    delivery = await deliverTo(db, after.ctx, after.signer, actor, meta, { tellSender: false });
  }
  const fresh = await loadScopedBySigner(db, actor, signer.id);
  return {
    signer: signerView(fresh.ctx, fresh.signer, new Date(), viewer),
    ...withReason(delivery),
    signingUrl: maySeeLink(viewer, fresh.signer, fresh.ctx.org) ? signingUrl(fresh.signer) : null,
  };
}

/**
 * Kill the countersign links held by a team member, for every agreement still open.
 * Call it when a member is turned off: their links already stop working while the
 * account is off, and rotating them means the copies in their inbox stay dead even
 * if the account is turned back on. Safe inside the caller's transaction.
 * Returns how many links were replaced.
 */
export async function revokeCountersignLinksForUser(db: DbOrTx, orgId: string, userId: string): Promise<number> {
  if (typeof orgId !== "string" || typeof userId !== "string" || !orgId || !userId) return 0;
  const rows = await db
    .select({ id: signers.id, envelopeId: signers.envelopeId, fileId: envelopes.fileId, email: signers.email })
    .from(signers)
    .innerJoin(envelopes, eq(envelopes.id, signers.envelopeId))
    .where(
      and(
        eq(signers.orgId, orgId),
        eq(signers.userId, userId),
        eq(signers.role, "company"),
        inArray(signers.status, ["waiting", "sent", "viewed"]),
        inArray(envelopes.status, OPEN_STATUSES),
      ),
    );
  let count = 0;
  for (const row of rows) {
    const token = mintSigningToken(row.id);
    const [rotated] = await db
      .update(signers)
      .set({ tokenNonce: token.tokenNonce, tokenHash: token.tokenHash })
      .where(and(eq(signers.id, row.id), eq(signers.orgId, orgId), inArray(signers.status, ["waiting", "sent", "viewed"])))
      .returning({ id: signers.id });
    if (!rotated) continue;
    count++;
    await recordEvent(db, {
      orgId,
      fileId: row.fileId,
      envelopeId: row.envelopeId,
      type: "link.reissued",
      actor: { type: "system", orgId, label: "System" },
      data: { signerId: row.id, email: row.email, reason: "The countersigner's account was turned off" },
    });
  }
  return count;
}

// ---------------------------------------------------------------------------
// Voiding
// ---------------------------------------------------------------------------

export interface VoidOptions {
  /**
   * Also void an agreement the client has already signed (it is waiting for the
   * countersignature or for its final copy). Without this, voiding such an
   * envelope is refused, so a cancel that was meant for an unsigned request can
   * never silently throw away a signature that arrived a moment earlier.
   */
  includeSigned?: unknown;
}

function signedVoidError(clientName: string, raced: boolean): ServiceError {
  return new ServiceError(
    "conflict",
    raced
      ? `${clientName} signed while you were cancelling, so the agreement was not voided. Countersign it, or void it again and confirm that you want to discard the signed agreement.`
      : `${clientName} has already signed this agreement. Voiding it discards their signature. Confirm that you want to void a signed agreement, then try again.`,
    { confirm: "includeSigned" },
  );
}

/**
 * Cancel an envelope that is still open. Its links stop working immediately.
 * Voiding one that is already voided is a no-op; any other closed envelope cannot be voided.
 */
export async function voidEnvelope(actor: Actor, id: unknown, reason: unknown, meta?: RequestMeta, opts: VoidOptions = {}): Promise<{ status: "voided"; alreadyVoided: boolean }> {
  const db = await getDb();
  await assertActor(db, actor);
  const ctx = await loadScoped(db, actor, id);
  const includeSigned = Boolean(opts) && typeof opts === "object" && opts.includeSigned === true;
  const clientName = ctx.signers.find((s) => s.role === "client")?.name ?? ctx.file.clientName;
  if (ctx.envelope.status === "voided") return { status: "voided", alreadyVoided: true };
  if (!OPEN_STATUSES.includes(ctx.envelope.status)) throw closedError(ctx.envelope, "it cannot be voided");
  if (ctx.envelope.status === "client_signed" && !includeSigned) throw signedVoidError(clientName, false);
  const why = cleanReason(reason);
  const now = new Date();

  const voided = await inTransaction(db, async (tx) => {
    await lockFile(tx, actor.orgId, ctx.file.id);
    if (!(await voidInTx(tx, actor, ctx, why, meta, now, includeSigned ? OPEN_STATUSES : AWAITING_CLIENT_STATUSES))) return false;
    await settleFileStatus(tx, actor.orgId, ctx.file.id, ctx.envelope.id, "no_agreement");
    return true;
  });
  if (!voided) {
    const after = await loadScoped(db, actor, ctx.envelope.id);
    if (after.envelope.status === "voided") return { status: "voided", alreadyVoided: true };
    if (after.envelope.status === "client_signed") throw signedVoidError(clientName, true);
    throw closedError(after.envelope, "it cannot be voided");
  }
  await notifySignersLinkDead(db, ctx, { kind: "voided", reason: why, actor });
  return { status: "voided", alreadyVoided: false };
}

/**
 * Void everything still out for signature on a file (used when a file is archived,
 * which is a decision about the whole file, so agreements the client has signed but
 * that are not complete are voided too). Returns how many were voided.
 */
export async function voidOpenEnvelopesForFile(actor: Actor, fileId: unknown, reason: unknown, meta?: RequestMeta): Promise<number> {
  const db = await getDb();
  await assertActor(db, actor);
  const targetId = idOf(fileId, FILE_NOT_FOUND);
  const open = await db
    .select({ id: envelopes.id })
    .from(envelopes)
    .where(and(eq(envelopes.fileId, targetId), eq(envelopes.orgId, actor.orgId), inArray(envelopes.status, OPEN_STATUSES)));
  let count = 0;
  for (const row of open) {
    try {
      const result = await voidEnvelope(actor, row.id, reason, meta, { includeSigned: true });
      if (!result.alreadyVoided) count++;
    } catch (err) {
      // One that closed by itself in the meantime (signed, declined) is not a failure of this call.
      if (!(err instanceof ServiceError)) throw err;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Sealing again
// ---------------------------------------------------------------------------

/**
 * Try again, now, to prepare the final copy of an agreement everyone has signed.
 * The scheduler retries by itself with growing waits; this is the button for the
 * sender who has been told the cause is fixed and does not want to wait.
 */
export async function retryFinalize(actor: Actor, envelopeId: unknown): Promise<FinalizeResult> {
  const db = await getDb();
  await assertActor(db, actor);
  const ctx = await loadScoped(db, actor, envelopeId);
  if (ctx.envelope.status === "completed") return { status: "completed", alreadyCompleted: true };
  if (!OPEN_STATUSES.includes(ctx.envelope.status)) throw closedError(ctx.envelope, "there is no final copy to prepare");
  if (!awaitingSeal(ctx)) {
    throw new ServiceError("conflict", "Not everyone has signed this agreement yet. The final copy is prepared automatically as soon as they have.");
  }
  await limitSender(`finalize:envelope:${ctx.envelope.id}`, 6, 3600, "The final copy has been retried several times in the last hour and is still failing.");
  const result = await finalizeEnvelope(ctx.envelope.id);
  if (result.status === "not_ready") {
    const after = await loadScoped(db, actor, ctx.envelope.id);
    if (after.envelope.status === "completed") return { status: "completed", alreadyCompleted: true };
    throw closedError(after.envelope, "there is no final copy to prepare");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Countersigning while signed in
// ---------------------------------------------------------------------------

export interface CountersignInput {
  /** PNG data URL. Left out, the member's saved signature is used. */
  signature?: unknown;
  /** Values for the other company fields, by field id. */
  values?: unknown;
  timezone?: unknown;
}

/**
 * Sign the company's side as the signed-in team member. Allowed for the person
 * the envelope is waiting on, the company's chosen countersigner, and owners and
 * admins. Whoever signs is the name recorded on the certificate.
 */
export async function countersign(actor: Actor, envelopeId: unknown, input: CountersignInput, meta?: RequestMeta): Promise<SigningResult> {
  const db = await getDb();
  const user = await assertActor(db, actor);
  if (actor.type !== "user" || !user) {
    throw new ServiceError("forbidden", "Countersigning needs a signed-in team member. Sign in and countersign from the file.");
  }
  const ctx = await loadScoped(db, actor, envelopeId);
  const signer = ctx.signers.find((s) => s.role === "company");
  if (!signer) throw new ServiceError("conflict", "This agreement has no fields for your company to sign, so there is nothing to countersign.");
  if (signer.status === "signed") return resultForRecipient(db, ctx, user.email);
  if (!OPEN_STATUSES.includes(ctx.envelope.status)) throw closedError(ctx.envelope, "it cannot be countersigned");
  if (ctx.envelope.status !== "client_signed" || signer.status === "waiting") {
    throw new ServiceError("conflict", "The client has not signed yet. You can countersign as soon as they have.");
  }

  if (!mayActForCompany(user, signer, ctx.org)) {
    throw new ServiceError("forbidden", `Only ${signer.name}, your company's countersigner, an owner or an admin can countersign this agreement.`);
  }

  const body: CountersignInput = input && typeof input === "object" ? input : {};
  if (body.values !== undefined && body.values !== null && (typeof body.values !== "object" || Array.isArray(body.values))) {
    throw new ServiceError("invalid", "The form could not be read. Reload the page and try again.");
  }
  const own = fieldsFor(ctx.envelope, "company");
  const raw: Record<string, unknown> = { ...((body.values as Record<string, unknown> | null | undefined) ?? {}) };
  const signature = body.signature !== undefined && body.signature !== null && body.signature !== "" ? body.signature : user.savedSignature;
  for (const field of own) {
    if (field.type !== "signature") continue;
    const given = Object.prototype.hasOwnProperty.call(raw, field.id) ? raw[field.id] : undefined;
    if ((given === undefined || given === null || given === "") && signature) raw[field.id] = signature;
  }

  const now = new Date();
  // The company's date is the company's calendar day; the browser's zone is the fallback until one is set.
  const dateLabel = signedDateLabel(now, orgTimeZone(ctx.org) ?? body.timezone, undefined);
  const defaults = defaultValues(own, { name: user.name, email: user.email, title: user.title, company: ctx.org.legalName || ctx.org.name });
  const checked = validateSignerValues(own, raw, defaults, dateLabel);
  if (!checked.ok) {
    const needsSignature = own.some((f) => f.type === "signature" && checked.errors[f.id]) && !signature;
    throw new ServiceError(
      "invalid",
      needsSignature ? "Draw your signature, or save one in your profile, then countersign." : "Some fields need your attention before you can countersign.",
      checked.errors,
    );
  }

  let outcome;
  try {
    outcome = await recordSignature({
      ctx,
      signer,
      values: checked.values,
      dateLabel,
      now,
      meta,
      method: "session",
      actor,
      become: { userId: user.id, name: user.name, email: user.email },
    });
  } catch (err) {
    if (!(err instanceof Raced)) throw err;
    const after = await loadScoped(db, actor, ctx.envelope.id);
    if (after.signers.find((s) => s.id === signer.id)?.status === "signed") return resultForRecipient(db, after, user.email);
    if (!OPEN_STATUSES.includes(after.envelope.status)) throw closedError(after.envelope, "it cannot be countersigned");
    throw new ServiceError("conflict", "This agreement changed while you were countersigning. Reload the file and try again.");
  }
  return afterSignature(ctx.envelope.id, outcome, user.email);
}
