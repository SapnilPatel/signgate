/**
 * The sender's side of the signing lifecycle: sending an agreement for a file,
 * looking at it, chasing it, correcting a signer, voiding it and countersigning.
 *
 * Every function takes an Actor and scopes every query by actor.orgId. An id that
 * belongs to another company behaves exactly like an id that does not exist.
 */
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
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
import { newId } from "@/lib/ids";
import { IMAGE_FIELD_TYPES, LIMITS, type Field, type FieldValues } from "@/lib/types";
import { parseImageDataUrl } from "@/lib/pdf/stamp";
import { cleanMultilineText, cleanText, isValidEmail, normalizeEmail } from "@/lib/validation";
import { ServiceError, type Actor, type RequestMeta } from "./context";
import { resolveSettings, type ResolvedOrgSettings } from "./accounts";
import { getBlob } from "./blobs";
import { describeEvent, listEvents, recordEvent } from "./events";
import { enqueueWebhookEvent } from "./webhooks";
import { deliveryFailedEmail, reminderEmail, signingRequestEmail, voidedEmail } from "./email-templates";
import { describeWait, rateLimit } from "./rate-limit";
import { mintSigningToken, signingUrl, tokenIsCurrent } from "./tokens";
import {
  AWAITING_CLIENT_STATUSES,
  OPEN_STATUSES,
  Raced,
  afterSignature,
  brandOf,
  defaultValues,
  documentFilename,
  emailCountersigner,
  fieldsFor,
  fileUrl,
  loadEnvelopeContext,
  longDate,
  recordSignature,
  resultFor,
  safeSend,
  settleFileStatus,
  signedDateLabel,
  signingState,
  teamRecipient,
  validateSignerValues,
  webhookPayload,
  type DocumentDownload,
  type EnvelopeContext,
  type SendOutcome,
  type SigningResult,
} from "./signing";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Delivery = "emailed" | "email_not_configured" | "email_failed";

export interface SendOptions {
  /** Send this agreement instead of the company's default one. */
  templateId?: unknown;
  /** Void whatever is still out for signature on the file (and allow sending again after a completed one). */
  replace?: unknown;
}

export interface SendResult {
  envelopeId: string;
  delivery: Delivery;
  /** The client's signing link. Always returned so it can be shared by hand. */
  signingUrl: string;
}

/** A signer as the sender sees it: no link material and no signature images. */
export type SignerView = Omit<Signer, "tokenNonce" | "tokenHash" | "values"> & {
  /** Present while this signer can still sign (or will be able to once it is their turn). */
  signingUrl: string | null;
  /** True when the envelope is waiting on this signer right now. */
  isTurn: boolean;
};

export type EnvelopeSummary = Omit<Envelope, "pages" | "fields" | "prefill">;

export interface EnvelopeDetail {
  envelope: Envelope;
  file: Pick<FileRow, "id" | "reference" | "clientName" | "clientEmail" | "agreementStatus">;
  signers: SignerView[];
  events: (EventRow & { description: string })[];
}

export interface EnvelopeListItem extends EnvelopeSummary {
  signers: Pick<Signer, "id" | "role" | "order" | "name" | "email" | "status" | "signedAt" | "viewedAt">[];
}

export interface DeliveryResult {
  delivery: Delivery;
  signingUrl: string;
}

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

/** Checks the actor's shape and, for a signed-in user, that the account is still active in this org. */
async function assertActor(db: DbOrTx, actor: Actor): Promise<User | null> {
  if (!actor || typeof actor !== "object" || typeof actor.orgId !== "string" || !actor.orgId) {
    throw new ServiceError("forbidden", "Sign in again to continue.");
  }
  if (actor.type !== "user") return null;
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, String(actor.userId)), eq(users.orgId, actor.orgId)))
    .limit(1);
  if (!user || user.disabledAt) {
    throw new ServiceError("forbidden", "Your account is no longer active. Ask an owner of your company account for access.");
  }
  return user;
}

function deliveryOf(outcome: SendOutcome): Delivery {
  return outcome.status === "sent" ? "emailed" : outcome.status === "skipped" ? "email_not_configured" : "email_failed";
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
  org: Pick<Org, "name" | "legalName">,
  now: Date = new Date(),
): FieldValues {
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
        return longDate(now);
    }
    if (!key.startsWith("custom:")) return undefined;
    const custom = key.slice("custom:".length);
    if (Object.prototype.hasOwnProperty.call(data, custom)) return data[custom];
    // The detector binds "this ___ day of ___, 20__" blanks to these; they come from the send date.
    switch (custom) {
      case "today_day":
        return ordinal(now.getUTCDate());
      case "today_month":
        return new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(now);
      case "today_year":
        return String(now.getUTCFullYear());
      case "today_year_short":
        return String(now.getUTCFullYear() % 100).padStart(2, "0");
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
// Readiness (local copy of the rule; see the note on unifying it with templateReadiness)
// ---------------------------------------------------------------------------

function snapshotFields(template: Pick<Template, "fields">): Field[] {
  const all = Array.isArray(template.fields) ? template.fields : [];
  return all.filter((f): f is Field => Boolean(f) && typeof f === "object" && typeof f.id === "string" && f.id.length > 0);
}

interface Countersigner {
  user: User;
}

/**
 * Decides whether this agreement can be sent right now and who countersigns.
 * Throws not_ready with the first thing to fix.
 */
function checkReady(template: Template, fields: Field[], settings: ResolvedOrgSettings, team: User[], sender: User | null): Countersigner | null {
  const pages = Array.isArray(template.pages) ? template.pages : [];
  if (pages.length === 0) {
    throw new ServiceError("not_ready", `"${template.name}" has no pages. Replace the document with a new upload, then send again.`);
  }
  if (!fields.some((f) => f.role === "client" && f.type === "signature" && f.required === true)) {
    throw new ServiceError(
      "not_ready",
      `"${template.name}" has no required signature field for the client, so there is nothing for them to sign. Add a client signature field to the agreement, then send again.`,
    );
  }
  if (!fields.some((f) => f.role === "company")) return null;

  const active = team.filter((u) => !u.disabledAt);
  const chosenId = typeof settings.countersignerUserId === "string" ? settings.countersignerUserId : "";
  const chosen = chosenId ? active.find((u) => u.id === chosenId) : undefined;
  // With nobody chosen (or the chosen person gone), the person sending signs for the company.
  const user = chosen ?? (sender && !sender.disabledAt ? sender : undefined);
  if (!user) {
    throw new ServiceError(
      "not_ready",
      chosenId
        ? "The person chosen to countersign is no longer an active member of your team. Choose another countersigner in Settings, then send again."
        : "This agreement has fields for your company to sign, but nobody is chosen to countersign. Choose a countersigner in Settings, or remove the company fields.",
    );
  }
  if (settings.countersignMode === "auto" && !parseImageDataUrl(user.savedSignature).ok) {
    throw new ServiceError(
      "not_ready",
      `Countersigning is set to automatic, but ${user.name} has no saved signature. Have them save a signature in their profile, or switch countersigning to manual in Settings.`,
    );
  }
  return { user };
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
  await db.transaction(async (tx) => {
    if (outcome.status === "sent") {
      await tx
        .update(envelopes)
        .set({ status: "sent", sentAt: now, updatedAt: now })
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
        data: { email: signer.email, signerId: signer.id, error: failureReason(outcome), configured: outcome.status !== "skipped" },
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

/** Guarded void inside the caller's transaction. Returns false when the envelope was no longer open. */
async function voidInTx(tx: DbOrTx, actor: Actor, ctx: Pick<EnvelopeContext, "envelope" | "file">, reason: string, meta: RequestMeta | undefined, now: Date): Promise<boolean> {
  const [voided] = await tx
    .update(envelopes)
    .set({ status: "voided", voidReason: reason || null, nextReminderAt: null, updatedAt: now })
    .where(and(eq(envelopes.id, ctx.envelope.id), eq(envelopes.orgId, actor.orgId), inArray(envelopes.status, OPEN_STATUSES)))
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
 * Tell signers the link they hold is dead. Only people who actually have it are
 * told: someone the request reached by email, or who opened or signed it. A signer
 * whose email never went out would only be confused by a cancellation.
 */
export async function notifySignersLinkDead(db: Db, ctx: EnvelopeContext, reason: string, actor?: Actor): Promise<void> {
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
      if (actor?.type === "user" && signer.userId === actor.userId) continue;
      if (!reached.has(address) && !signer.viewedAt && signer.status !== "signed") continue;
      told.add(address);
      await safeSend(ctx.org, {
        envelopeId: ctx.envelope.id,
        kind: "voided",
        to: signer.email,
        ...voidedEmail({ brand: brandOf(ctx.org), signerName: signer.name, agreementName: ctx.envelope.templateName, reason }),
      });
    }
  } catch (err) {
    console.error("[envelopes] could not notify signers of a void", err instanceof Error ? err.message : err);
  }
}

function cleanReason(reason: unknown): string {
  return cleanMultilineText(reason, 1000);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

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
  const team = await db.select().from(users).where(eq(users.orgId, actor.orgId));
  const countersigner = checkReady(template, fields, settings, team, sender);

  // Blobs are immutable, so the envelope can point at the very bytes the agreement uses today.
  const [pdf] = await db
    .select({ id: blobs.id, sha256: blobs.sha256 })
    .from(blobs)
    .where(and(eq(blobs.id, template.pdfBlobId), eq(blobs.orgId, actor.orgId)))
    .limit(1);
  if (!pdf) throw new ServiceError("not_ready", `The document for "${template.name}" is missing from storage. Upload the agreement again, then send.`);

  const now = new Date();
  const schedule = scheduleOf(settings);
  const envelopeId = newId("env");
  const clientSignerId = newId("sgn");
  const clientToken = mintSigningToken(clientSignerId);
  const companySignerId = newId("sgn");
  const companyToken = mintSigningToken(companySignerId);
  const clientName = cleanText(file.clientName, 200) || clientEmail;

  const replaced: EnvelopeContext[] = [];
  await db.transaction(async (tx) => {
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
      .where(and(eq(envelopes.fileId, file.id), eq(envelopes.orgId, actor.orgId)));
    const open = existing.filter((e) => OPEN_STATUSES.includes(e.status));
    const hasCompleted = existing.some((e) => e.status === "completed");
    if (!replace && open.length > 0) {
      throw new ServiceError("conflict", "An agreement is already out for signature on this file. Void it first, or send again and choose to replace it.");
    }
    if (!replace && hasCompleted) {
      throw new ServiceError("conflict", "This file already has a signed agreement. To have the client sign again, send again and choose to replace it.");
    }
    for (const old of open) {
      const oldSigners = await tx.select().from(signers).where(eq(signers.envelopeId, old.id));
      if (await voidInTx(tx, actor, { envelope: old, file }, "Replaced by a new signing request", meta, now)) {
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
        name: countersigner.user.name,
        email: countersigner.user.email,
        tokenNonce: companyToken.tokenNonce,
        tokenHash: companyToken.tokenHash,
        userId: countersigner.user.id,
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
    const url = signingUrl({ id: clientSignerId, tokenNonce: clientToken.tokenNonce });
    await enqueueWebhookEvent(
      tx,
      actor.orgId,
      "agreement.sent",
      webhookPayload({ envelope: { id: envelopeId, templateName: template.name } as Envelope, file }, "sent", { sentAt: now.toISOString(), signingUrl: url }),
    );
  });

  // Everything below is after commit: the envelope exists whatever happens to the emails.
  const url = signingUrl({ id: clientSignerId, tokenNonce: clientToken.tokenNonce });
  let delivery: Delivery = "email_failed";
  try {
    for (const old of replaced) await notifySignersLinkDead(db, old, "It was replaced by a new signing request, which you will receive separately.", actor);
    const ctx = await loadEnvelopeContext(db, envelopeId);
    const client = ctx?.signers.find((s) => s.id === clientSignerId);
    if (ctx && client) delivery = await deliverTo(db, ctx, client, actor, meta, { tellSender: true });
  } catch (err) {
    console.error("[envelopes] post-send work failed", err instanceof Error ? err.message : err);
  }
  return { envelopeId, delivery, signingUrl: url };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function signerView(ctx: EnvelopeContext, signer: Signer, now: Date): SignerView {
  const { tokenNonce, tokenHash, values, ...rest } = signer;
  void tokenHash;
  void values;
  return {
    ...rest,
    // A link derived from a different APP_SECRET would be dead; getSigningLink re-mints those.
    signingUrl: canStillSign(ctx, signer) && tokenIsCurrent(signer) ? signingUrl({ id: signer.id, tokenNonce }) : null,
    isTurn: isTurn(ctx, signer, now),
  };
}

/** One envelope with its signers, its audit trail and the links of signers who have not signed. */
export async function getEnvelope(actor: Actor, id: unknown): Promise<EnvelopeDetail> {
  const db = await getDb();
  await assertActor(db, actor);
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
    signers: ctx.signers.map((s) => signerView(ctx, s, now)),
    events: trail.map((e) => ({ ...e, description: describeEvent(e) })),
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

/**
 * The signing link for a signer who has not signed, so the sender can pass it on by
 * hand. If the server secret changed since the link was issued, the old link is
 * already dead, so a new one is issued instead of showing one that cannot work.
 */
export async function getSigningLink(actor: Actor, signerId: unknown, meta?: RequestMeta): Promise<{ signingUrl: string; signer: Pick<Signer, "id" | "name" | "email" | "role" | "status"> }> {
  const db = await getDb();
  await assertActor(db, actor);
  const { ctx, signer } = await loadScopedBySigner(db, actor, signerId);
  if (!OPEN_STATUSES.includes(ctx.envelope.status)) throw closedError(ctx.envelope, "its signing links no longer work");
  if (signer.status === "signed" || signer.status === "declined") {
    throw new ServiceError("conflict", `${signer.name} has already ${signer.status === "signed" ? "signed" : "declined"}, so there is no link to share.`);
  }
  let current: Pick<Signer, "id" | "tokenNonce"> = signer;
  if (!tokenIsCurrent(signer)) {
    const token = mintSigningToken(signer.id);
    await db.transaction(async (tx) => {
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

/** The unsigned agreement exactly as it was sent, or the sealed copy once everyone has signed. */
export async function getDocument(actor: Actor, envelopeId: unknown, kind: "original" | "signed"): Promise<DocumentDownload> {
  const db = await getDb();
  await assertActor(db, actor);
  const ctx = await loadScoped(db, actor, envelopeId);
  if (kind !== "original" && kind !== "signed") {
    throw new ServiceError("invalid", 'Ask for either the "original" or the "signed" document.');
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
  return { bytes: blob.bytes, filename: documentFilename(ctx.envelope, ctx.file, "unsigned"), contentType: "application/pdf", sha256: blob.sha256 };
}

// ---------------------------------------------------------------------------
// Chasing
// ---------------------------------------------------------------------------

async function limitSender(key: string, limit: number, windowSeconds: number, what: string): Promise<void> {
  const result = await rateLimit(key, limit, windowSeconds);
  if (!result.ok) {
    throw new ServiceError("rate_limited", `${what} Try again ${describeWait(result.retryAfterSeconds)}, or copy the signing link and send it yourself.`);
  }
}

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
  await assertActor(db, actor);
  const { ctx, signer } = await loadScopedBySigner(db, actor, signerId);
  if (!isTurn(ctx, signer)) throw notTurnError(ctx, signer);
  await limitSender(`resend:signer:${signer.id}`, 5, 3600, `This request has been sent to ${signer.name} several times in the last hour.`);
  await limitSender(`resend:org:${actor.orgId}`, 300, 3600, "Your company has sent a lot of signing requests in the last hour.");
  const delivery = await deliverTo(db, ctx, signer, actor, meta, { tellSender: false });
  return { delivery, signingUrl: signingUrl(signer) };
}

/**
 * Nudge whoever the envelope is waiting on, now. Does not use up one of the
 * automatic reminders, but pushes the next automatic one back so two do not
 * arrive on the same day.
 */
export async function sendReminderNow(actor: Actor, envelopeId: unknown, meta?: RequestMeta): Promise<DeliveryResult & { to: string }> {
  const db = await getDb();
  await assertActor(db, actor);
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
    return { delivery, signingUrl: signingUrl(signer), to: signer.email };
  }

  const outcome = await emailSigningRequest(ctx, signer, { reminderNumber: ctx.envelope.reminderCount + 1 });
  const every = scheduleOf(resolveSettings(ctx.org)).reminderEveryDays;
  try {
    await db.transaction(async (tx) => {
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
  return { delivery: deliveryOf(outcome), signingUrl: signingUrl(signer), to: signer.email };
}

// ---------------------------------------------------------------------------
// Correcting a signer
// ---------------------------------------------------------------------------

/**
 * Change who a signing request goes to (a typo in the address, the wrong person).
 * The old link stops working at once, because whoever holds it is no longer the
 * signer; the new link is emailed if it is that signer's turn.
 */
export async function updateSigner(
  actor: Actor,
  signerId: unknown,
  patch: { name?: unknown; email?: unknown },
  meta?: RequestMeta,
): Promise<{ signer: SignerView; delivery: Delivery | "not_their_turn"; signingUrl: string }> {
  const db = await getDb();
  await assertActor(db, actor);
  const { ctx, signer } = await loadScopedBySigner(db, actor, signerId);
  if (!OPEN_STATUSES.includes(ctx.envelope.status)) throw closedError(ctx.envelope, "its signers cannot be changed");
  if (signer.status === "signed" || signer.status === "declined") {
    throw new ServiceError("conflict", `${signer.name} has already ${signer.status === "signed" ? "signed" : "declined"}, so their details cannot be changed.`);
  }

  const input = patch && typeof patch === "object" ? patch : {};
  const errors: Record<string, string> = {};
  let name = signer.name;
  let email = signer.email;
  if (input.name !== undefined && input.name !== null) {
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
  let teamUser: Pick<User, "id"> | undefined;
  if (signer.role === "company") {
    [teamUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, actor.orgId), eq(users.email, email), isNull(users.disabledAt)))
      .limit(1);
  }

  try {
    await db.transaction(async (tx) => {
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
          ...(signer.role === "company" ? { userId: teamUser?.id ?? null } : {}),
          // A different person has not seen the agreement, whatever the previous one did.
          ...(emailChanged && signer.status === "viewed" ? { status: "sent" as const, viewedAt: null } : {}),
        })
        .where(and(eq(signers.id, signer.id), eq(signers.orgId, actor.orgId), inArray(signers.status, ["waiting", "sent", "viewed"])))
        .returning({ id: signers.id });
      if (!updated) throw new Raced();

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
      }

      const base = { orgId: actor.orgId, fileId: ctx.file.id, envelopeId: ctx.envelope.id };
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
  return { signer: signerView(fresh.ctx, fresh.signer, new Date()), delivery, signingUrl: signingUrl(fresh.signer) };
}

// ---------------------------------------------------------------------------
// Voiding
// ---------------------------------------------------------------------------

/**
 * Cancel an envelope that is still open. Its links stop working immediately.
 * Voiding one that is already voided is a no-op; any other closed envelope cannot be voided.
 */
export async function voidEnvelope(actor: Actor, id: unknown, reason: unknown, meta?: RequestMeta): Promise<{ status: "voided"; alreadyVoided: boolean }> {
  const db = await getDb();
  await assertActor(db, actor);
  const ctx = await loadScoped(db, actor, id);
  if (ctx.envelope.status === "voided") return { status: "voided", alreadyVoided: true };
  if (!OPEN_STATUSES.includes(ctx.envelope.status)) throw closedError(ctx.envelope, "it cannot be voided");
  const why = cleanReason(reason);
  const now = new Date();

  const voided = await db.transaction(async (tx) => {
    if (!(await voidInTx(tx, actor, ctx, why, meta, now))) return false;
    await settleFileStatus(tx, actor.orgId, ctx.file.id, ctx.envelope.id, "no_agreement");
    return true;
  });
  if (!voided) {
    const after = await loadScoped(db, actor, ctx.envelope.id);
    if (after.envelope.status === "voided") return { status: "voided", alreadyVoided: true };
    throw closedError(after.envelope, "it cannot be voided");
  }
  await notifySignersLinkDead(db, ctx, why, actor);
  return { status: "voided", alreadyVoided: false };
}

/** Void everything still out for signature on a file (used when a file is archived). Returns how many were voided. */
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
      const result = await voidEnvelope(actor, row.id, reason, meta);
      if (!result.alreadyVoided) count++;
    } catch (err) {
      // One that closed by itself in the meantime (signed, declined) is not a failure of this call.
      if (!(err instanceof ServiceError)) throw err;
    }
  }
  return count;
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
  if (signer.status === "signed") return resultFor(ctx);
  if (!OPEN_STATUSES.includes(ctx.envelope.status)) throw closedError(ctx.envelope, "it cannot be countersigned");
  if (ctx.envelope.status !== "client_signed" || signer.status === "waiting") {
    throw new ServiceError("conflict", "The client has not signed yet. You can countersign as soon as they have.");
  }

  const settings = resolveSettings(ctx.org);
  const allowed = signer.userId === user.id || settings.countersignerUserId === user.id || user.role === "owner" || user.role === "admin";
  if (!allowed) {
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
  const dateLabel = signedDateLabel(now, body.timezone, undefined);
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
    if (after.signers.find((s) => s.id === signer.id)?.status === "signed") return resultFor(after);
    if (!OPEN_STATUSES.includes(after.envelope.status)) throw closedError(after.envelope, "it cannot be countersigned");
    throw new ServiceError("conflict", "This agreement changed while you were countersigning. Reload the file and try again.");
  }
  return afterSignature(ctx.envelope.id, outcome);
}
