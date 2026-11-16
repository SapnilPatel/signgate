/**
 * The public side of the signing lifecycle: everything a person holding a signing
 * link can do, and the finalization that follows the last signature.
 *
 * The only credential here is the link secret. Nothing in this file trusts an
 * envelope id, signer id or field id that arrives from a request without first
 * resolving the secret to its signer and checking the id against that signer.
 */
import { and, asc, eq, inArray, isNull, ne, or, gt, sql } from "drizzle-orm";
import { getDb, type Db, type DbOrTx, type Tx } from "@/lib/db";
import {
  emailLog,
  envelopes,
  events as eventsTable,
  files,
  orgs,
  signers,
  users,
  type Envelope,
  type EnvelopeStatus,
  type FileRow,
  type Org,
  type Signer,
  type User,
} from "@/lib/db/schema";
import { env, PRODUCT_NAME } from "@/lib/env";
import { IMAGE_FIELD_TYPES, LIMITS, type Field, type FieldValues, type PageInfo } from "@/lib/types";
import { sealDocument, stampFields, type CertificateData, type CertificateSigner } from "@/lib/pdf";
import { parseImageDataUrl } from "@/lib/pdf/stamp";
import { cleanMultilineText, cleanText, isValidEmail, normalizeEmail } from "@/lib/validation";
import { ServiceError, systemActor, type RequestMeta } from "./context";
import { resolveSettings } from "./accounts";
import { getBlob, getBlobUnscopedForSigningLink, putBlob } from "./blobs";
import { describeEvent, listEvents, recordEvent, type EventActor } from "./events";
import { enqueueWebhookEvent } from "./webhooks";
import { attachmentsFit, sendEmail } from "./email";
import { completedEmail, countersignRequestEmail, declinedEmail, escapeHtml, voidedEmail, type Brand, type EmailContent } from "./email-templates";
import { describeWait, rateLimit } from "./rate-limit";
import { resolveCountersigner } from "./templates";
import { findSignerBySecret, mintSigningToken, signingUrl } from "./tokens";

// ---------------------------------------------------------------------------
// Shared pieces (also used by envelopes.ts and jobs.ts)
// ---------------------------------------------------------------------------

/** Statuses in which an envelope can still change. Everything else is terminal. */
export const OPEN_STATUSES: EnvelopeStatus[] = ["draft", "sent", "viewed", "client_signed"];
/** Statuses in which the client has not signed yet. */
export const AWAITING_CLIENT_STATUSES: EnvelopeStatus[] = ["draft", "sent", "viewed"];

/** Recorded on the audit trail each time sealing fails; the scheduler backs off between attempts. */
export const FINALIZE_FAILED_EVENT = "envelope.finalize_failed";
/** First retry waits this long; each further failure doubles the wait, up to the cap. */
export const FINALIZE_RETRY_BASE_MS = 5 * 60_000;
export const FINALIZE_RETRY_MAX_MS = 6 * 3_600_000;
/** Chasing the countersigner: used when the company has switched client reminders off. */
export const COUNTERSIGN_REMINDER_DAYS = 2;
export const COUNTERSIGN_MAX_REMINDERS = 5;

/** Thrown inside a transaction to abandon it when a guarded update matched nothing. */
export class Raced extends Error {
  constructor() {
    super("raced");
    this.name = "Raced";
  }
}

/** True for the errors Postgres raises when it aborts one side of a lock cycle or a serialization clash. */
export function isRetryableTxError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === "object" && depth < 6; depth++) {
    const code = (e as { code?: unknown }).code;
    if (code === "40P01" || code === "40001") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * db.transaction, run once more if Postgres aborted it as a deadlock victim. The
 * aborted attempt changed nothing, and every transaction here is a set of guarded
 * updates, so the second run simply sees whatever the winner committed.
 * `work` must not leave anything behind outside the transaction.
 */
export async function inTransaction<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(work);
  } catch (err) {
    if (!isRetryableTxError(err)) throw err;
    return db.transaction(work);
  }
}

/**
 * Every transaction that changes an envelope takes its file's row lock first, then
 * the envelope, then signers. One order everywhere is what keeps a signature, a
 * void, an expiry and a re-send for the same file from deadlocking each other.
 */
export async function lockFile(tx: DbOrTx, orgId: string, fileId: string): Promise<void> {
  // NO KEY UPDATE, not UPDATE: it still excludes every other holder of this lock and every
  // update of the row, but lets rows that merely reference the file (audit events, email
  // log entries written outside this order) be inserted without waiting on it.
  await tx.select({ id: files.id }).from(files).where(and(eq(files.id, fileId), eq(files.orgId, orgId))).for("no key update");
}

export interface EnvelopeContext {
  envelope: Envelope;
  org: Org;
  file: FileRow;
  /** Ordered by signing order. */
  signers: Signer[];
}

export async function loadEnvelopeContext(db: DbOrTx, envelopeId: string): Promise<EnvelopeContext | null> {
  if (typeof envelopeId !== "string" || !envelopeId) return null;
  const [envelope] = await db.select().from(envelopes).where(eq(envelopes.id, envelopeId)).limit(1);
  if (!envelope) return null;
  const [org] = await db.select().from(orgs).where(eq(orgs.id, envelope.orgId)).limit(1);
  const [file] = await db.select().from(files).where(eq(files.id, envelope.fileId)).limit(1);
  if (!org || !file) return null;
  const rows = await db.select().from(signers).where(eq(signers.envelopeId, envelope.id)).orderBy(asc(signers.order), asc(signers.createdAt));
  return { envelope, org, file, signers: rows };
}

export function brandOf(org: Org): Brand {
  return { orgName: org.name, brandColor: resolveSettings(org).brandColor };
}

export function fileUrl(fileId: string): string {
  return `${env.appUrl}/files/${fileId}`;
}

export function verifyUrl(): string {
  return `${env.appUrl}/verify`;
}

export function signerLabel(signer: Pick<Signer, "name" | "email">): string {
  return `${signer.name} (${signer.email})`;
}

function signerActor(signer: Pick<Signer, "name" | "email">): EventActor {
  return { type: "signer", label: signerLabel(signer) };
}

export type SendOutcome = { status: "sent" | "failed" | "skipped"; error?: string };

/** sendEmail does not throw, but a notification must never be able to fail the action behind it. */
export async function safeSend(org: Org, msg: Omit<Parameters<typeof sendEmail>[0], "orgId" | "fromName" | "replyTo">): Promise<SendOutcome> {
  try {
    const result = await sendEmail({ ...msg, orgId: org.id, fromName: org.name, replyTo: resolveSettings(org).replyToEmail });
    return { status: result.status, error: result.error };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : "The email could not be sent." };
  }
}

/** Who on the team hears about what happened to an envelope: whoever sent it, else the owner. */
export async function teamRecipient(db: DbOrTx, envelope: Pick<Envelope, "orgId" | "createdBy">): Promise<Pick<User, "id" | "name" | "email"> | null> {
  const active = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role })
    .from(users)
    .where(and(eq(users.orgId, envelope.orgId), isNull(users.disabledAt)))
    .orderBy(asc(users.createdAt));
  return (
    active.find((u) => u.id === envelope.createdBy) ??
    active.find((u) => u.role === "owner") ??
    active.find((u) => u.role === "admin") ??
    null
  );
}

export function webhookPayload(
  ctx: Pick<EnvelopeContext, "envelope" | "file"> & { signers?: Pick<Signer, "role" | "name" | "email">[] },
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  // The signer row is who the agreement actually went to; the file can lag behind a correction.
  const client = ctx.signers?.find((s) => s.role === "client");
  return {
    envelopeId: ctx.envelope.id,
    fileId: ctx.file.id,
    fileReference: ctx.file.reference,
    externalId: ctx.file.externalId,
    agreementName: ctx.envelope.templateName,
    status,
    client: { name: client?.name ?? ctx.file.clientName, email: client?.email ?? ctx.file.clientEmail },
    ...extra,
  };
}

/**
 * The file's denormalized status once `closingEnvelopeId` stops being open. A
 * completed agreement on the file always wins, and another envelope still out
 * for signature keeps the status it set.
 */
export async function settleFileStatus(
  tx: DbOrTx,
  orgId: string,
  fileId: string,
  closingEnvelopeId: string,
  fallback: FileRow["agreementStatus"],
): Promise<void> {
  const others = await tx
    .select({ status: envelopes.status })
    .from(envelopes)
    .where(and(eq(envelopes.fileId, fileId), eq(envelopes.orgId, orgId), ne(envelopes.id, closingEnvelopeId)));
  let next: FileRow["agreementStatus"] | null = fallback;
  if (others.some((o) => o.status === "completed")) next = "signed";
  else if (others.some((o) => OPEN_STATUSES.includes(o.status))) next = null;
  if (next) {
    await tx.update(files).set({ agreementStatus: next, updatedAt: new Date() }).where(and(eq(files.id, fileId), eq(files.orgId, orgId)));
  }
}

/** `15 November 2026`: the month is spelled out so the date cannot be read two ways. */
export function longDate(at: Date, timeZone = "UTC"): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(at);
  }
}

export function plausibleTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 3 || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return null;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/**
 * The company's own time zone (IANA name), or null when none is stored. Dates the
 * company puts on a document (the agreement date, its countersignature date) are
 * calendar days where the company is, not in UTC.
 */
export function orgTimeZone(org: { settings?: unknown } | null | undefined): string | null {
  const stored = org?.settings && typeof org.settings === "object" ? (org.settings as Record<string, unknown>) : {};
  return plausibleTimeZone(stored.timeZone) ?? plausibleTimeZone(stored.timezone);
}

/** Day of the month, month name and year of an instant as a calendar date in `timeZone`. */
export function calendarParts(at: Date, timeZone: string | null | undefined): { day: number; month: string; year: number } {
  const read = (zone: string) => {
    const parts = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: zone }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return { day: Number(get("day")), month: get("month"), year: Number(get("year")) };
  };
  try {
    return read(timeZone || "UTC");
  } catch {
    return read("UTC");
  }
}

/**
 * The calendar date printed for "date signed". The instant is always the server's;
 * the signer's zone only decides which calendar day that instant falls on for them.
 * A label sent by the browser is accepted only if it is one of the three dates
 * (yesterday, today, tomorrow in UTC) that the current instant can be anywhere on Earth.
 */
export function signedDateLabel(now: Date, timezone: unknown, label: unknown): string {
  const zone = plausibleTimeZone(timezone);
  if (zone) return longDate(now, zone);
  if (typeof label === "string") {
    const possible = [-1, 0, 1].map((d) => longDate(new Date(now.getTime() + d * 86_400_000)));
    const cleaned = cleanText(label, 40);
    if (possible.includes(cleaned)) return cleaned;
  }
  return longDate(now);
}

// ---------------------------------------------------------------------------
// Values and validation
// ---------------------------------------------------------------------------

const isImageField = (field: Field) => IMAGE_FIELD_TYPES.includes(field.type);

export function fieldsFor(envelope: Pick<Envelope, "fields">, role: "client" | "company"): Field[] {
  const all = Array.isArray(envelope.fields) ? envelope.fields : [];
  return all.filter((f) => f && typeof f === "object" && f.role === role && typeof f.id === "string");
}

export interface SignerDefaults {
  name: string;
  email: string;
  title?: string | null;
  company?: string | null;
}

/** Values the page can offer for a signer's own fields, and that the server uses when a field is left out. */
export function defaultValues(fields: Field[], d: SignerDefaults): FieldValues {
  const out: FieldValues = {};
  for (const field of fields) {
    const value =
      field.type === "full_name" ? d.name : field.type === "email" ? d.email : field.type === "title" ? d.title : field.type === "company" ? d.company : null;
    const cleaned = cleanText(value, LIMITS.maxTextFieldLength);
    if (cleaned) out[field.id] = cleaned;
  }
  return out;
}

export function signerDefaultsFor(ctx: EnvelopeContext, signer: Signer, user?: Pick<User, "title"> | null): SignerDefaults {
  if (signer.role === "client") {
    return { name: signer.name, email: signer.email, title: ctx.file.clientTitle, company: ctx.file.clientCompany };
  }
  return { name: signer.name, email: signer.email, title: user?.title, company: ctx.org.legalName || ctx.org.name };
}

function isoDateToLong(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Rejects 2026-02-31, which Date would silently roll into March.
  if (Number.isNaN(at.getTime()) || at.getUTCDate() !== Number(m[3]) || at.getUTCMonth() !== Number(m[2]) - 1) return null;
  return longDate(at);
}

export type ValidatedValues = { ok: true; values: FieldValues } | { ok: false; errors: Record<string, string> };

/**
 * Check submitted values against ONE signer's fields. Ids that are not among
 * `ownFields` are rejected, which is what stops a client filling in the company's
 * side or overwriting a prefilled value.
 */
export function validateSignerValues(ownFields: Field[], raw: unknown, defaults: FieldValues, dateLabel: string): ValidatedValues {
  const errors: Record<string, string> = {};
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    return { ok: false, errors: { _form: "The form could not be read. Reload the page and try again." } };
  }
  const input = (raw ?? {}) as Record<string, unknown>;
  const byId = new Map(ownFields.map((f) => [f.id, f]));
  let keys: string[] = [];
  try {
    keys = Object.keys(input);
  } catch {
    return { ok: false, errors: { _form: "The form could not be read. Reload the page and try again." } };
  }
  if (keys.length > LIMITS.maxFieldsPerTemplate * 2) {
    return { ok: false, errors: { _form: "The form has more values than this agreement has fields. Reload the page and try again." } };
  }
  for (const key of keys) {
    if (!byId.has(key)) errors[cleanText(key, 60) || "_form"] = "This field is not one of yours to fill in. Reload the page and try again.";
  }

  const values: FieldValues = {};
  for (const field of ownFields) {
    const label = cleanText(field.label, 80) || "This field";
    let given: unknown;
    try {
      given = Object.prototype.hasOwnProperty.call(input, field.id) ? input[field.id] : undefined;
    } catch {
      given = undefined;
    }
    const required = field.required === true;

    if (field.type === "date_signed") {
      values[field.id] = dateLabel; // never taken from the request
      continue;
    }

    if (field.type === "checkbox") {
      if (given !== undefined && given !== null && typeof given !== "boolean") {
        errors[field.id] = `${label} must be ticked or left empty.`;
      } else if (required && given !== true) {
        errors[field.id] = `Tick "${label}" to continue.`;
      } else if (given === true) {
        values[field.id] = true;
      }
      continue;
    }

    if (isImageField(field)) {
      if (given === undefined || given === null || given === "") {
        if (required) errors[field.id] = field.type === "initials" ? `Add your initials for "${label}".` : `Add your signature for "${label}".`;
        continue;
      }
      const image = parseImageDataUrl(given);
      if (!image.ok) {
        errors[field.id] = image.reason;
        continue;
      }
      values[field.id] = `data:image/png;base64,${Buffer.from(image.bytes).toString("base64")}`;
      continue;
    }

    // Text-like fields. A value left out entirely takes the known default; an
    // explicitly blank one stays blank, because the signer cleared it on purpose.
    // The name is the exception: a signed agreement always carries a printed name.
    let source: unknown = given;
    if (given === undefined || given === null || (field.type === "full_name" && typeof given === "string" && !given.trim())) {
      source = defaults[field.id];
    }
    if (source !== undefined && source !== null && typeof source !== "string" && typeof source !== "number") {
      errors[field.id] = `${label} must be text.`;
      continue;
    }
    if (typeof source === "string" && source.length > LIMITS.maxTextFieldLength * 4) {
      errors[field.id] = `${label} is too long. Keep it under ${LIMITS.maxTextFieldLength} characters.`;
      continue;
    }
    const text = cleanText(source, LIMITS.maxTextFieldLength * 4);
    if (text.length > LIMITS.maxTextFieldLength) {
      errors[field.id] = `${label} is too long. Keep it under ${LIMITS.maxTextFieldLength} characters.`;
      continue;
    }
    if (!text) {
      if (required) errors[field.id] = `Fill in "${label}".`;
      continue;
    }
    if (field.type === "email") {
      const email = normalizeEmail(text);
      if (!isValidEmail(email)) {
        errors[field.id] = `${label} must be an email address like name@example.com.`;
        continue;
      }
      values[field.id] = email;
      continue;
    }
    values[field.id] = field.type === "date" ? (isoDateToLong(text) ?? text) : text;
  }

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
}

/** Prefill plus what every signer before `signer` has already put on the document. */
export function valuesVisibleTo(ctx: EnvelopeContext, signer: Signer): FieldValues {
  const merged: FieldValues = { ...(ctx.envelope.prefill ?? {}) };
  for (const other of ctx.signers) {
    if (other.id !== signer.id && other.order < signer.order && other.status === "signed") Object.assign(merged, other.values ?? {});
  }
  return merged;
}

export function allValues(ctx: EnvelopeContext): FieldValues {
  const merged: FieldValues = { ...(ctx.envelope.prefill ?? {}) };
  for (const s of ctx.signers) if (s.status === "signed") Object.assign(merged, s.values ?? {});
  return merged;
}

/**
 * What the countersigner's saved signature can fill in without them present.
 * Returns null when a required company field needs a person (free text, a
 * checkbox, initials), in which case the envelope falls back to manual countersigning.
 */
export function autoCountersignValues(
  companyFields: Field[],
  user: Pick<User, "name" | "email" | "title" | "savedSignature">,
  org: Pick<Org, "name" | "legalName">,
  dateLabel: string,
): FieldValues | null {
  const signature = parseImageDataUrl(user.savedSignature);
  if (!signature.ok) return null;
  const signatureUrl = `data:image/png;base64,${Buffer.from(signature.bytes).toString("base64")}`;
  const values: FieldValues = {};
  for (const field of companyFields) {
    let value: string | undefined;
    switch (field.type) {
      case "signature":
        value = signatureUrl;
        break;
      case "date_signed":
      case "date":
        value = dateLabel;
        break;
      case "full_name":
        value = cleanText(user.name, LIMITS.maxTextFieldLength);
        break;
      case "title":
        value = cleanText(user.title, LIMITS.maxTextFieldLength);
        break;
      case "company":
        value = cleanText(org.legalName || org.name, LIMITS.maxTextFieldLength);
        break;
      case "email":
        value = normalizeEmail(user.email);
        break;
      default:
        value = undefined;
    }
    if (value) values[field.id] = value;
    else if (field.required === true) return null;
  }
  return values;
}

// ---------------------------------------------------------------------------
// Link resolution, state and rate limits
// ---------------------------------------------------------------------------

export type SigningState =
  | "unknown" // the link is not valid (wrong, revoked or replaced)
  | "ready" // this signer can sign now
  | "not_your_turn" // an earlier signer has not finished
  | "signed" // this signer is done; others or the sealing are still pending
  | "completed" // sealed; the copy can be downloaded
  | "declined"
  | "voided"
  | "expired";

export function signingState(envelope: Envelope, signer: Signer, now: Date = new Date()): Exclude<SigningState, "unknown"> {
  if (envelope.status === "voided") return "voided";
  if (envelope.status === "declined") return "declined";
  if (envelope.status === "expired") return "expired";
  if (envelope.status === "completed") return "completed";
  if (signer.status === "signed") return "signed";
  if (signer.status === "declined") return "declined";
  // The scheduler flips the status later; the link stops working the moment the date passes.
  if (AWAITING_CLIENT_STATUSES.includes(envelope.status) && envelope.expiresAt && envelope.expiresAt.getTime() <= now.getTime()) return "expired";
  if (signer.status === "waiting") return "not_your_turn";
  if (signer.role === "client") return AWAITING_CLIENT_STATUSES.includes(envelope.status) ? "ready" : "not_your_turn";
  return envelope.status === "client_signed" ? "ready" : "not_your_turn";
}

function stateMessage(state: SigningState, orgName: string): string {
  switch (state) {
    case "unknown":
      return "This signing link is not valid. It may have been replaced by a newer one: use the link in the most recent email you received, or ask the sender for a new one.";
    case "voided":
      return `${orgName} cancelled this signing request, so the link no longer works. You do not need to do anything. If a signature is still needed they will send a new request.`;
    case "declined":
      return `This agreement was declined, so it can no longer be signed. Contact ${orgName} if you would like a new request.`;
    case "expired":
      return `This signing link has expired. Ask ${orgName} to send the agreement again.`;
    case "not_your_turn":
      return "This agreement is not ready for your signature yet. You will get an email as soon as it is your turn.";
    case "signed":
      return "You have signed this agreement. The completed copy can be downloaded from this link as soon as it is finalized.";
    case "completed":
      return "This agreement is signed and complete. You can download your copy at any time.";
    case "ready":
      return "";
  }
}

function stateError(state: SigningState, orgName: string): ServiceError {
  const message = stateMessage(state, orgName);
  if (state === "unknown") return new ServiceError("not_found", message);
  if (state === "not_your_turn") return new ServiceError("conflict", message);
  if (state === "signed" || state === "completed") return new ServiceError("conflict", "This agreement has already been signed with this link.");
  return new ServiceError("gone", message);
}

/**
 * Limits for the public signing endpoints. A counter is kept per real link and per
 * caller address. A value that does not resolve to a signer never gets a counter of
 * its own, so junk links cannot fill the table; they count against the caller's
 * address, or against one shared counter when the route could not tell us the address,
 * so there is never a way to probe without any limit at all.
 */
async function limitPublic(action: string, signerId: string | null, meta: RequestMeta | undefined, perLink: number, perIp: number, windowSeconds: number): Promise<void> {
  const ip = cleanText(meta?.ip, 64);
  const checks: ReturnType<typeof rateLimit>[] = [];
  if (signerId) checks.push(rateLimit(`sign:${action}:link:${signerId}`, perLink, windowSeconds));
  if (ip) checks.push(rateLimit(`sign:${action}:ip:${ip}`, perIp, windowSeconds));
  else if (!signerId) checks.push(rateLimit(`sign:${action}:ip:unknown`, perIp, windowSeconds));
  for (const result of await Promise.all(checks)) {
    if (!result.ok) {
      throw new ServiceError("rate_limited", `Too many attempts. Wait a moment and try again ${describeWait(result.retryAfterSeconds)}.`);
    }
  }
}

interface ResolvedLink {
  db: Db;
  signer: Signer;
  ctx: EnvelopeContext;
  /** The team member behind a company signer; null for a client. */
  user: Pick<User, "id" | "title"> | null;
}

async function resolveLink(secret: unknown): Promise<ResolvedLink | null> {
  const db = await getDb();
  const signer = await findSignerBySecret(secret, db);
  if (!signer) return null;
  const ctx = await loadEnvelopeContext(db, signer.envelopeId);
  if (!ctx) return null;
  // Use the row from the context so every later check reads one consistent snapshot.
  const current = ctx.signers.find((s) => s.id === signer.id);
  if (!current) return null;
  let user: Pick<User, "id" | "title"> | null = null;
  if (current.role === "company") {
    // A countersign link signs for the company, so it is only as good as the account
    // behind it: once that person is turned off or gone, the link in their inbox is dead.
    if (!current.userId) return null;
    const [row] = await db
      .select({ id: users.id, title: users.title, disabledAt: users.disabledAt })
      .from(users)
      .where(and(eq(users.id, current.userId), eq(users.orgId, ctx.org.id)))
      .limit(1);
    if (!row || row.disabledAt) return null;
    user = { id: row.id, title: row.title };
  }
  return { db, signer: current, ctx, user };
}

/** A secret resolved once, then counted against the limits for `action`. */
async function openLink(action: string, secret: unknown, meta: RequestMeta | undefined, perLink: number, perIp: number, windowSeconds: number): Promise<ResolvedLink | null> {
  const resolved = await resolveLink(secret);
  await limitPublic(action, resolved?.signer.id ?? null, meta, perLink, perIp, windowSeconds);
  return resolved;
}

// ---------------------------------------------------------------------------
// The signing page
// ---------------------------------------------------------------------------

/** A value already on the document, so the page can show it where it sits. Image
 *  values are not repeated here: they are drawn into the PDF from getSigningDocument. */
export interface ReadOnlyValue {
  fieldId: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  type: Field["type"];
  label: string;
  isImage: boolean;
  value: string | boolean | null;
}

export type SigningSession =
  | { state: "unknown"; message: string }
  | {
      state: Exclude<SigningState, "unknown">;
      message: string;
      org: { name: string; brandColor: string; logo: string | null };
      agreementName: string;
      fileReference: string;
      signer: { name: string; email: string; role: "client" | "company" };
      /** Empty unless state is "ready". */
      pages: PageInfo[];
      fields: Field[];
      defaults: FieldValues;
      readOnly: ReadOnlyValue[];
      expiresAt: string | null;
      signedAt: string | null;
      completedAt: string | null;
      /** True when getSignedCopy will return the sealed PDF for this link. */
      canDownloadSigned: boolean;
    };

/**
 * Everything the signing page needs for this link and nothing else. Opening a link
 * that is ready to sign records the first view, exactly once.
 */
export async function getSigningSession(secret: unknown, meta?: RequestMeta): Promise<SigningSession> {
  const resolved = await openLink("view", secret, meta, 120, 600, 300);
  if (!resolved) return { state: "unknown", message: stateMessage("unknown", "") };
  const { ctx, user } = resolved;
  let { signer } = resolved;
  let { envelope } = ctx;
  const now = new Date();
  const state = signingState(envelope, signer, now);

  if (state === "ready" && !signer.viewedAt) {
    try {
      const viewed = await recordFirstView(ctx, signer, meta, now);
      if (viewed) {
        signer = viewed.signer;
        envelope = viewed.envelope ?? envelope;
      }
    } catch (err) {
      // Failing to note the view must not stop someone from reading their agreement.
      console.error("[signing] could not record first view", err instanceof Error ? err.message : err);
    }
  }

  const settings = resolveSettings(ctx.org);
  const ready = state === "ready";
  const own = ready ? fieldsFor(envelope, signer.role) : [];
  const readOnly = ready ? readOnlyValues(envelope, signer.role, valuesVisibleTo(ctx, signer)) : [];

  return {
    state,
    message: stateMessage(state, ctx.org.name),
    org: { name: ctx.org.name, brandColor: settings.brandColor, logo: typeof settings.logo === "string" && settings.logo ? settings.logo : null },
    agreementName: envelope.templateName,
    fileReference: ctx.file.reference,
    signer: { name: signer.name, email: signer.email, role: signer.role },
    pages: ready ? envelope.pages : [],
    fields: own,
    defaults: ready ? defaultValues(own, signerDefaultsFor(ctx, signer, user)) : {},
    readOnly,
    expiresAt: envelope.expiresAt ? envelope.expiresAt.toISOString() : null,
    signedAt: signer.signedAt ? signer.signedAt.toISOString() : null,
    completedAt: envelope.completedAt ? envelope.completedAt.toISOString() : null,
    canDownloadSigned: state === "completed" && Boolean(envelope.finalBlobId),
  };
}

/** Values already on the document that are not this role's to fill in, with where they sit. */
export function readOnlyValues(envelope: Pick<Envelope, "fields">, role: "client" | "company", visible: FieldValues): ReadOnlyValue[] {
  const out: ReadOnlyValue[] = [];
  for (const field of Array.isArray(envelope.fields) ? envelope.fields : []) {
    if (!field || field.role === role || !(field.id in visible)) continue;
    const image = isImageField(field);
    out.push({
      fieldId: field.id,
      page: field.page,
      x: field.x,
      y: field.y,
      w: field.w,
      h: field.h,
      type: field.type,
      label: field.label,
      isImage: image,
      value: image ? null : visible[field.id],
    });
  }
  return out;
}

async function recordFirstView(ctx: EnvelopeContext, signer: Signer, meta: RequestMeta | undefined, now: Date): Promise<{ signer: Signer; envelope: Envelope | null } | null> {
  const db = await getDb();
  return inTransaction(db, async (tx) => {
    await lockFile(tx, ctx.org.id, ctx.file.id);
    await tx.select({ id: envelopes.id }).from(envelopes).where(eq(envelopes.id, ctx.envelope.id)).for("no key update");
    // The WHERE clause is what makes this happen once: a second request finds viewed_at set.
    const [updated] = await tx
      .update(signers)
      .set({ status: "viewed", viewedAt: now })
      .where(and(eq(signers.id, signer.id), eq(signers.status, "sent"), isNull(signers.viewedAt)))
      .returning();
    if (!updated) return null;
    let envelope: Envelope | null = null;
    if (signer.role === "client") {
      [envelope] = await tx
        .update(envelopes)
        .set({
          status: "viewed",
          // A client who has the page open has the agreement, however the link reached them.
          sentAt: sql`coalesce(${envelopes.sentAt}, ${now.toISOString()}::timestamptz)`,
          updatedAt: now,
        })
        .where(and(eq(envelopes.id, ctx.envelope.id), inArray(envelopes.status, ["draft", "sent"])))
        .returning();
      await tx
        .update(files)
        .set({ agreementStatus: "out_for_signature", updatedAt: now })
        .where(and(eq(files.id, ctx.file.id), eq(files.agreementStatus, "needs_attention")));
      await enqueueWebhookEvent(tx, ctx.org.id, "agreement.viewed", webhookPayload(ctx, "viewed", { viewedAt: now.toISOString() }));
    }
    await recordEvent(tx, {
      orgId: ctx.org.id,
      fileId: ctx.file.id,
      envelopeId: ctx.envelope.id,
      type: "envelope.viewed",
      actor: signerActor(signer),
      meta,
      data: { signerId: signer.id, role: signer.role },
    });
    return { signer: updated, envelope: envelope ?? null };
  });
}

export interface DocumentDownload {
  bytes: Buffer;
  filename: string;
  contentType: "application/pdf";
  sha256: string;
}

export function documentFilename(envelope: Pick<Envelope, "templateName">, file: Pick<FileRow, "reference">, suffix: string): string {
  const base = `${envelope.templateName} ${file.reference}`
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return `${base || "Agreement"}${suffix ? ` (${suffix})` : ""}.pdf`;
}

/** The PDF the signing page displays: the agreement with prefilled values and earlier signatures drawn in. */
export async function getSigningDocument(secret: unknown, meta?: RequestMeta): Promise<DocumentDownload> {
  const resolved = await openLink("doc", secret, meta, 60, 600, 300);
  if (!resolved) throw stateError("unknown", "");
  const { db, signer, ctx } = resolved;
  const state = signingState(ctx.envelope, signer);
  if (state === "voided" || state === "declined" || state === "expired") throw stateError(state, ctx.org.name);
  const original = await getBlobUnscopedForSigningLink(ctx.envelope.pdfBlobId, db);
  if (!original || original.orgId !== ctx.org.id) {
    throw new ServiceError("not_found", `The agreement could not be loaded. Ask ${ctx.org.name} to send it again.`);
  }
  const bytes = await stampVisible(original.bytes, ctx.envelope, valuesVisibleTo(ctx, signer));
  return { bytes, filename: documentFilename(ctx.envelope, ctx.file, ""), contentType: "application/pdf", sha256: original.sha256 };
}

/** The agreement with the given values drawn in. Falls back to the plain agreement if drawing fails. */
export async function stampVisible(original: Buffer, envelope: Pick<Envelope, "fields">, visible: FieldValues): Promise<Buffer> {
  const shown = (Array.isArray(envelope.fields) ? envelope.fields : []).filter((f) => f && f.id in visible);
  if (shown.length === 0) return original;
  try {
    const bytes = await stampFields(new Uint8Array(original), shown, visible);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch (err) {
    // The unstamped agreement is still the agreement; the page overlays the values itself.
    console.error("[signing] could not stamp preview", err instanceof Error ? err.message : err);
    return original;
  }
}

/** The sealed PDF, for any signer of a completed envelope, from their own link. */
export async function getSignedCopy(secret: unknown, meta?: RequestMeta): Promise<DocumentDownload> {
  const resolved = await openLink("copy", secret, meta, 30, 300, 300);
  if (!resolved) throw stateError("unknown", "");
  const { db, signer, ctx } = resolved;
  const state = signingState(ctx.envelope, signer);
  if (state !== "completed" || !ctx.envelope.finalBlobId) {
    if (state === "voided" || state === "declined" || state === "expired") throw stateError(state, ctx.org.name);
    throw new ServiceError("not_ready", "The signed copy is not ready yet. It can be downloaded from this link as soon as everyone has signed.");
  }
  const blob = await getBlobUnscopedForSigningLink(ctx.envelope.finalBlobId, db);
  if (!blob || blob.orgId !== ctx.org.id) {
    throw new ServiceError("not_found", `The signed copy could not be loaded. Ask ${ctx.org.name} for a copy.`);
  }
  return { bytes: blob.bytes, filename: documentFilename(ctx.envelope, ctx.file, "signed"), contentType: "application/pdf", sha256: blob.sha256 };
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export interface SigningResult {
  status: "signed";
  /** True once the sealed copy exists and can be downloaded from the link. */
  completed: boolean;
  next: "completed" | "awaiting_countersignature" | "finalizing";
  /** A truthful one-line confirmation for the signer. */
  message: string;
}

/**
 * What to tell someone who has just signed. Every sentence is something that is
 * true right now: an email is only mentioned when one was actually sent, and the
 * download is promised from the link, which works whether or not email does.
 */
export function resultFor(ctx: EnvelopeContext, facts: { copyEmailedTo?: string | null } = {}): SigningResult {
  if (ctx.envelope.status === "completed") {
    const emailed = cleanText(facts.copyEmailedTo, 254);
    return {
      status: "signed",
      completed: true,
      next: "completed",
      message: emailed
        ? `The agreement is signed and complete. A copy has been emailed to ${emailed}, and you can download it from this page.`
        : "The agreement is signed and complete. Download your copy now from this page.",
    };
  }
  if (ctx.signers.some((s) => s.status !== "signed")) {
    return {
      status: "signed",
      completed: false,
      next: "awaiting_countersignature",
      message: `Your signature is recorded. ${ctx.org.name} will now countersign. Keep this link: the completed copy can be downloaded from it as soon as they have.`,
    };
  }
  return {
    status: "signed",
    completed: false,
    next: "finalizing",
    message: "Your signature is recorded. The final copy is being prepared and will be ready to download here shortly.",
  };
}

/** resultFor, with the email claim checked against what was really sent to this person. */
export async function resultForRecipient(db: DbOrTx, ctx: EnvelopeContext, email: string | null | undefined): Promise<SigningResult> {
  const address = normalizeEmail(email);
  if (ctx.envelope.status !== "completed" || !address) return resultFor(ctx);
  try {
    const [row] = await db
      .select({ id: emailLog.id })
      .from(emailLog)
      .where(and(eq(emailLog.envelopeId, ctx.envelope.id), eq(emailLog.kind, "completed"), eq(emailLog.status, "sent"), sql`lower(${emailLog.to}) = ${address}`))
      .limit(1);
    return resultFor(ctx, { copyEmailedTo: row ? address : null });
  } catch {
    return resultFor(ctx);
  }
}

interface RecordSignatureInput {
  ctx: EnvelopeContext;
  signer: Signer;
  values: FieldValues;
  dateLabel: string;
  now: Date;
  meta?: RequestMeta;
  /** How the signature was given; printed on the certificate. */
  method: "link" | "session";
  actor: EventActor;
  /** When a different team member countersigns than the one assigned, the signer row becomes them. */
  become?: { userId: string; name: string; email: string };
}

export interface RecordSignatureOutcome {
  /** The company signer who now needs to be asked, when countersigning is manual. */
  notify: Signer | null;
  allSigned: boolean;
}

/**
 * The one place a signature is written. Both guarded updates must match or the
 * whole transaction is abandoned with Raced, so a double submit, a submit racing
 * a void, and two tabs submitting together all end with at most one signature.
 */
export async function recordSignature(input: RecordSignatureInput): Promise<RecordSignatureOutcome> {
  const { ctx, signer, now, meta } = input;
  const db = await getDb();
  const isClient = signer.role === "client";
  const company = ctx.org.legalName || ctx.org.name;

  return inTransaction(db, async (tx) => {
    await lockFile(tx, ctx.org.id, ctx.file.id);
    // The envelope row lock serializes this against void, expiry, decline and any concurrent submit.
    const [envelope] = isClient
      ? await tx
          .update(envelopes)
          .set({
            status: "client_signed",
            // A link shared by hand never had a delivered email to set this.
            sentAt: sql`coalesce(${envelopes.sentAt}, ${now.toISOString()}::timestamptz)`,
            nextReminderAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(envelopes.id, ctx.envelope.id),
              inArray(envelopes.status, AWAITING_CLIENT_STATUSES),
              or(isNull(envelopes.expiresAt), gt(envelopes.expiresAt, now)),
            ),
          )
          .returning({ id: envelopes.id })
      : await tx
          .update(envelopes)
          .set({ nextReminderAt: null, updatedAt: now })
          .where(and(eq(envelopes.id, ctx.envelope.id), eq(envelopes.status, "client_signed"), isNull(envelopes.finalBlobId)))
          .returning({ id: envelopes.id });
    if (!envelope) throw new Raced();

    const [signed] = await tx
      .update(signers)
      .set({
        status: "signed",
        values: input.values,
        consentAt: now,
        signedAt: now,
        viewedAt: sql`coalesce(${signers.viewedAt}, ${now.toISOString()}::timestamptz)`,
        ip: cleanText(meta?.ip, 64) || null,
        userAgent: cleanText(meta?.userAgent, 400) || null,
        ...(input.become ? { userId: input.become.userId, name: input.become.name, email: input.become.email } : {}),
      })
      .where(and(eq(signers.id, signer.id), inArray(signers.status, ["sent", "viewed"])))
      .returning();
    if (!signed) throw new Raced();

    const base = { orgId: ctx.org.id, fileId: ctx.file.id, envelopeId: ctx.envelope.id };
    await recordEvent(tx, { ...base, type: "signer.consented", actor: input.actor, meta, data: { signerId: signer.id, role: signer.role } });
    await recordEvent(tx, {
      ...base,
      type: isClient ? "signer.signed" : "envelope.countersigned",
      actor: input.actor,
      meta,
      data: { signerId: signer.id, role: signer.role, method: input.method, dateSigned: input.dateLabel, ...(isClient ? {} : { company }) },
    });

    const others = await tx.select().from(signers).where(and(eq(signers.envelopeId, ctx.envelope.id), ne(signers.id, signer.id))).orderBy(asc(signers.order));
    const pending = others.filter((s) => s.status !== "signed");
    let notify: Signer | null = null;

    if (isClient) {
      await enqueueWebhookEvent(
        tx,
        ctx.org.id,
        "agreement.signed",
        webhookPayload(ctx, "client_signed", { signedAt: now.toISOString(), signer: { role: "client", name: signed.name, email: signed.email } }),
      );
      const waiting = pending.find((s) => s.status === "waiting" && s.role === "company");
      if (waiting) {
        // A file that already holds a completed agreement stays cleared while a replacement is in progress.
        await tx
          .update(files)
          .set({ agreementStatus: "awaiting_countersign", updatedAt: now })
          .where(and(eq(files.id, ctx.file.id), eq(files.orgId, ctx.org.id), ne(files.agreementStatus, "signed")));

        const [storedOrg] = await tx.select().from(orgs).where(eq(orgs.id, ctx.org.id)).limit(1);
        const org = storedOrg ?? ctx.org;
        const settings = resolveSettings(org);
        const team = await tx.select().from(users).where(eq(users.orgId, ctx.org.id)).orderBy(asc(users.createdAt));

        // The countersigner was fixed when the agreement was sent. If that person has
        // since been turned off, the request goes to whoever countersigns for the company now.
        let next = waiting;
        let assignee = waiting.userId ? team.find((u) => u.id === waiting.userId && !u.disabledAt) : undefined;
        if (!assignee) {
          const members = team.map((u) => ({ id: u.id, disabled: u.disabledAt !== null, hasSignature: Boolean(u.savedSignature), role: u.role, user: u }));
          const pick = resolveCountersigner(settings, members).member ?? resolveCountersigner({ ...settings, countersignerUserId: undefined }, members).member;
          if (pick) {
            const token = mintSigningToken(waiting.id);
            const [moved] = await tx
              .update(signers)
              .set({ name: pick.user.name, email: pick.user.email, userId: pick.user.id, tokenNonce: token.tokenNonce, tokenHash: token.tokenHash })
              .where(and(eq(signers.id, waiting.id), eq(signers.status, "waiting")))
              .returning();
            if (!moved) throw new Raced();
            next = moved;
            assignee = pick.user;
            await recordEvent(tx, {
              ...base,
              type: "signer.updated",
              actor: systemActor(ctx.org.id),
              data: { signerId: waiting.id, role: "company", name: pick.user.name, email: pick.user.email, previousEmail: waiting.email, previousName: waiting.name, reason: "The original countersigner is no longer active" },
            });
          }
        }

        if (!assignee) {
          await tx
            .update(files)
            .set({ agreementStatus: "needs_attention", updatedAt: now })
            .where(and(eq(files.id, ctx.file.id), eq(files.orgId, ctx.org.id), ne(files.agreementStatus, "signed")));
          await recordEvent(tx, {
            ...base,
            type: "countersign.unassigned",
            actor: systemActor(ctx.org.id),
            data: { signerId: waiting.id, reason: "Nobody on the team is available to countersign. Choose a countersigner in Settings" },
          });
        } else {
          let auto: FieldValues | null = null;
          const zone = orgTimeZone(org);
          // The company's date is the company's calendar day when it has told us its zone.
          const companyDate = zone ? longDate(now, zone) : input.dateLabel;
          if (settings.countersignMode === "auto") auto = autoCountersignValues(fieldsFor(ctx.envelope, "company"), assignee, org, companyDate);

          if (auto) {
            const [applied] = await tx
              .update(signers)
              .set({ status: "signed", values: auto, signedAt: now, name: assignee.name, email: assignee.email })
              .where(and(eq(signers.id, next.id), eq(signers.status, "waiting")))
              .returning({ id: signers.id });
            if (!applied) throw new Raced();
            await recordEvent(tx, {
              ...base,
              type: "envelope.countersigned",
              actor: systemActor(ctx.org.id),
              data: { signerId: next.id, role: "company", method: "auto", auto: true, name: assignee.name, email: assignee.email, company, dateSigned: companyDate },
            });
            pending.splice(pending.indexOf(waiting), 1);
          } else {
            const [asked] = await tx
              .update(signers)
              .set({ status: "sent" })
              .where(and(eq(signers.id, next.id), eq(signers.status, "waiting")))
              .returning();
            if (!asked) throw new Raced();
            notify = asked;
            // From here the reminder schedule chases the countersigner instead of the client.
            await tx
              .update(envelopes)
              .set({ reminderCount: 0, lastReminderAt: null, nextReminderAt: new Date(now.getTime() + countersignCadenceDays(settings.reminderEveryDays) * 86_400_000) })
              .where(eq(envelopes.id, ctx.envelope.id));
          }
        }
      }
    }

    return { notify, allSigned: pending.length === 0 };
  });
}

/** Days between nudges to the countersigner: the company's reminder cadence, or a default when that is off. */
export function countersignCadenceDays(reminderEveryDays: unknown): number {
  const n = Math.floor(Number(reminderEveryDays));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 365) : COUNTERSIGN_REMINDER_DAYS;
}

/** Ask the countersigner to sign. Recorded on the trail either way, so a failed email is visible on the file. */
export async function emailCountersigner(ctx: EnvelopeContext, signer: Signer, opts: { reminderNumber?: number } = {}): Promise<SendOutcome> {
  const content = countersignRequestEmail({
    brand: brandOf(ctx.org),
    signerName: signer.name,
    clientName: ctx.file.clientName,
    agreementName: ctx.envelope.templateName,
    fileReference: ctx.file.reference,
    url: signingUrl(signer),
  });
  const result = await safeSend(ctx.org, { envelopeId: ctx.envelope.id, kind: "countersign_request", to: signer.email, ...content });
  try {
    const db = await getDb();
    await recordEvent(db, {
      orgId: ctx.org.id,
      fileId: ctx.file.id,
      envelopeId: ctx.envelope.id,
      type: result.status === "sent" ? "countersign.requested" : "envelope.delivery_failed",
      actor: systemActor(ctx.org.id),
      data:
        result.status === "sent"
          ? { email: signer.email, name: signer.name, ...(opts.reminderNumber ? { reminder: opts.reminderNumber } : {}) }
          : { email: signer.email, kind: "countersign_request", error: result.error ?? "Email is not set up, so the countersigner was not emailed. Countersign from the file page." },
    });
  } catch (err) {
    console.error("[signing] could not record countersign request", err instanceof Error ? err.message : err);
  }
  return result;
}

export interface SubmitSigningInput {
  values?: unknown;
  consent?: unknown;
  signedDateLabel?: unknown;
  timezone?: unknown;
}

/**
 * Sign with a link. Safe to call twice: a repeat after success returns the same
 * success and writes nothing.
 */
export async function submitSigning(secret: unknown, input: SubmitSigningInput, meta?: RequestMeta): Promise<SigningResult> {
  const resolved = await openLink("submit", secret, meta, 20, 200, 600);
  if (!resolved) throw stateError("unknown", "");
  const { db, signer, ctx, user } = resolved;
  const now = new Date();

  const state = signingState(ctx.envelope, signer, now);
  if (state === "signed" || state === "completed") {
    // A signer who never signed cannot reach "completed"; either way nothing is written.
    if (signer.status === "signed") return resultForRecipient(db, ctx, signer.email);
    throw stateError(state, ctx.org.name);
  }
  if (state !== "ready") throw stateError(state, ctx.org.name);

  const body: SubmitSigningInput = input && typeof input === "object" ? input : {};
  if (body.consent !== true) {
    throw new ServiceError("invalid", "Tick the box agreeing to sign electronically before you sign.", {
      consent: "Tick the box agreeing to sign electronically before you sign.",
    });
  }

  const own = fieldsFor(ctx.envelope, signer.role);
  const dateLabel = signedDateLabel(now, body.timezone, body.signedDateLabel);
  const checked = validateSignerValues(own, body.values, defaultValues(own, signerDefaultsFor(ctx, signer, user)), dateLabel);
  if (!checked.ok) {
    throw new ServiceError("invalid", "Some fields need your attention before you can sign.", checked.errors);
  }

  let outcome: RecordSignatureOutcome;
  try {
    outcome = await recordSignature({ ctx, signer, values: checked.values, dateLabel, now, meta, method: "link", actor: signerActor(signer) });
  } catch (err) {
    if (!(err instanceof Raced)) throw err;
    // Something else got there first. Report what is true now: the other request's
    // success if it was this signer signing, otherwise why the link stopped working.
    const after = await resolveLink(secret);
    if (!after) throw stateError("unknown", "");
    if (after.signer.status === "signed") return resultForRecipient(db, after.ctx, after.signer.email);
    throw stateError(signingState(after.ctx.envelope, after.signer), after.ctx.org.name);
  }

  return afterSignature(ctx.envelope.id, outcome, signer.email);
}

/** Follow-up work once a signature is committed. Nothing here can undo or fail the signature. */
export async function afterSignature(envelopeId: string, outcome: RecordSignatureOutcome, recipientEmail?: string | null): Promise<SigningResult> {
  const db = await getDb();
  if (outcome.notify) {
    const ctx = await loadEnvelopeContext(db, envelopeId);
    if (ctx) await emailCountersigner(ctx, outcome.notify);
  }
  if (outcome.allSigned) await finalizeEnvelope(envelopeId);
  const ctx = await loadEnvelopeContext(db, envelopeId);
  if (!ctx) {
    return { status: "signed", completed: false, next: "finalizing", message: "Your signature is recorded. The final copy is being prepared." };
  }
  return resultForRecipient(db, ctx, recipientEmail);
}

// ---------------------------------------------------------------------------
// Declining
// ---------------------------------------------------------------------------

export async function declineSigning(secret: unknown, reason: unknown, meta?: RequestMeta): Promise<{ status: "declined" }> {
  const resolved = await openLink("decline", secret, meta, 10, 100, 600);
  if (!resolved) throw stateError("unknown", "");
  const { db, signer, ctx } = resolved;
  const now = new Date();

  if (signer.status === "declined" && ctx.envelope.status === "declined") return { status: "declined" };
  const state = signingState(ctx.envelope, signer, now);
  if (state === "signed" || state === "completed") {
    throw new ServiceError("conflict", `You have already signed this agreement, so it can no longer be declined. Contact ${ctx.org.name} if you have changed your mind.`);
  }
  if (state !== "ready") throw stateError(state, ctx.org.name);

  const why = cleanMultilineText(reason, 1000);
  const isClient = signer.role === "client";

  try {
    await inTransaction(db, async (tx) => {
      await lockFile(tx, ctx.org.id, ctx.file.id);
      const [envelope] = await tx
        .update(envelopes)
        .set({ status: "declined", declineReason: why || null, nextReminderAt: null, updatedAt: now })
        .where(
          and(
            eq(envelopes.id, ctx.envelope.id),
            isClient ? inArray(envelopes.status, AWAITING_CLIENT_STATUSES) : eq(envelopes.status, "client_signed"),
            isNull(envelopes.finalBlobId),
          ),
        )
        .returning({ id: envelopes.id });
      if (!envelope) throw new Raced();
      const [declined] = await tx
        .update(signers)
        .set({ status: "declined", ip: cleanText(meta?.ip, 64) || null, userAgent: cleanText(meta?.userAgent, 400) || null })
        .where(and(eq(signers.id, signer.id), inArray(signers.status, ["sent", "viewed"])))
        .returning({ id: signers.id });
      if (!declined) throw new Raced();
      await settleFileStatus(tx, ctx.org.id, ctx.file.id, ctx.envelope.id, "declined");
      await recordEvent(tx, {
        orgId: ctx.org.id,
        fileId: ctx.file.id,
        envelopeId: ctx.envelope.id,
        type: "envelope.declined",
        actor: signerActor(signer),
        meta,
        data: { signerId: signer.id, role: signer.role, ...(why ? { reason: why } : {}) },
      });
      await enqueueWebhookEvent(
        tx,
        ctx.org.id,
        "agreement.declined",
        webhookPayload(ctx, "declined", { declinedAt: now.toISOString(), declinedBy: signer.role, reason: why || null }),
      );
    });
  } catch (err) {
    if (!(err instanceof Raced)) throw err;
    const after = await resolveLink(secret);
    if (!after) throw stateError("unknown", "");
    if (after.signer.status === "declined") return { status: "declined" };
    if (after.signer.status === "signed") {
      throw new ServiceError("conflict", `You have already signed this agreement, so it can no longer be declined. Contact ${after.ctx.org.name} if you have changed your mind.`);
    }
    throw stateError(signingState(after.ctx.envelope, after.signer), after.ctx.org.name);
  }

  const brand = brandOf(ctx.org);
  const team = await teamRecipient(db, ctx.envelope);
  if (team && normalizeEmail(team.email) !== normalizeEmail(signer.email)) {
    await safeSend(ctx.org, {
      envelopeId: ctx.envelope.id,
      kind: "declined",
      to: team.email,
      ...declinedEmail({
        brand,
        recipientName: team.name,
        clientName: signer.name,
        agreementName: ctx.envelope.templateName,
        fileReference: ctx.file.reference,
        reason: why,
        fileUrl: fileUrl(ctx.file.id),
      }),
    });
  }
  // A client who already signed needs to know the agreement will not be completed.
  if (!isClient) {
    const client = ctx.signers.find((s) => s.role === "client" && s.status === "signed");
    if (client) {
      await safeSend(ctx.org, {
        envelopeId: ctx.envelope.id,
        kind: "not_completed",
        to: client.email,
        ...linkDeadEmail("not_completed", { brand, signerName: client.name, agreementName: ctx.envelope.templateName }),
      });
    }
  }
  return { status: "declined" };
}

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------

export type FinalizeResult =
  | { status: "completed"; alreadyCompleted: boolean }
  | { status: "not_ready"; reason: string }
  | { status: "failed"; error: string };

const METHOD_TEXT: Record<string, string> = {
  link: "Signed through an emailed signing link",
  session: "Signed while signed in to the company account",
  auto: "Saved signature applied automatically when the client signed",
};

async function recordFinalizeFailure(ctx: EnvelopeContext, error: string): Promise<void> {
  try {
    const db = await getDb();
    await inTransaction(db, async (tx) => {
      await lockFile(tx, ctx.org.id, ctx.file.id);
      await recordEvent(tx, {
        orgId: ctx.org.id,
        fileId: ctx.file.id,
        envelopeId: ctx.envelope.id,
        type: FINALIZE_FAILED_EVENT,
        actor: systemActor(ctx.org.id),
        data: { error },
      });
      // Signed but not sealed is exactly what "needs attention" is for.
      await tx
        .update(files)
        .set({ agreementStatus: "needs_attention", updatedAt: new Date() })
        .where(and(eq(files.id, ctx.file.id), inArray(files.agreementStatus, ["out_for_signature", "awaiting_countersign"])));
    });
  } catch (err) {
    console.error("[signing] could not record finalize failure", err instanceof Error ? err.message : err);
  }
}

/**
 * Seal a fully signed envelope: stamp every value, append the certificate, store
 * the result and mark the envelope completed. Never throws. Calling it again, or
 * from two places at once, completes the envelope once and emails once: the
 * guarded update decides the single winner, and only the winner sends email.
 * If sealing fails the signatures are untouched and the envelope stays
 * client_signed with every signer signed, which is what the scheduler retries.
 */
export async function finalizeEnvelope(envelopeId: string): Promise<FinalizeResult> {
  let ctx: EnvelopeContext | null = null;
  try {
    const db = await getDb();
    ctx = await loadEnvelopeContext(db, envelopeId);
    if (!ctx) return { status: "not_ready", reason: "The envelope does not exist." };
    if (ctx.envelope.status === "completed") return { status: "completed", alreadyCompleted: true };
    if (ctx.envelope.status !== "client_signed") return { status: "not_ready", reason: `The envelope is ${ctx.envelope.status}.` };
    if (ctx.signers.length === 0 || ctx.signers.some((s) => s.status !== "signed")) {
      return { status: "not_ready", reason: "Not everyone has signed yet." };
    }

    const original = await getBlob(ctx.org.id, ctx.envelope.pdfBlobId, db);
    if (!original) throw new Error("The original agreement PDF is missing from storage.");

    const trail = await listEvents(ctx.org.id, { envelopeId: ctx.envelope.id, limit: 1000 }, db);
    const methodBySigner = new Map<string, string>();
    for (const event of trail) {
      const data = event.data ?? {};
      if ((event.type === "signer.signed" || event.type === "envelope.countersigned") && typeof data.signerId === "string" && typeof data.method === "string") {
        methodBySigner.set(data.signerId, data.method);
      }
    }
    const completedAt = new Date();
    const certificate: CertificateData = {
      envelopeId: ctx.envelope.id,
      agreementName: ctx.envelope.templateName,
      fileReference: ctx.file.reference,
      orgName: ctx.org.legalName || ctx.org.name,
      originalSha256: ctx.envelope.pdfSha256,
      signers: ctx.signers.map(
        (s): CertificateSigner => ({
          role: s.role,
          name: s.name,
          email: s.email,
          signedAt: s.signedAt ?? completedAt,
          consentAt: s.consentAt,
          ip: s.ip,
          userAgent: s.userAgent,
          method: METHOD_TEXT[methodBySigner.get(s.id) ?? "link"] ?? METHOD_TEXT.link,
        }),
      ),
      events: [
        ...trail.filter((e) => e.type !== FINALIZE_FAILED_EVENT).map((e) => ({ at: e.createdAt, description: describeEvent(e) })),
        { at: completedAt, description: describeEvent({ type: "envelope.completed", actor: "System", actorType: "system" }) },
      ],
      completedAt,
      verifyUrl: verifyUrl(),
    };

    // Sealing is CPU work on a document; it stays outside any transaction.
    const sealed = await sealDocument({
      pdf: new Uint8Array(original.bytes),
      fields: Array.isArray(ctx.envelope.fields) ? ctx.envelope.fields : [],
      values: allValues(ctx),
      certificate,
    });

    const current = ctx;
    let won = false;
    try {
      await inTransaction(db, async (tx) => {
        await lockFile(tx, current.org.id, current.file.id);
        const blob = await putBlob(tx, {
          orgId: current.org.id,
          bytes: sealed.pdf,
          contentType: "application/pdf",
          filename: documentFilename(current.envelope, current.file, "signed"),
        });
        const [done] = await tx
          .update(envelopes)
          .set({ status: "completed", completedAt, finalBlobId: blob.id, finalSha256: sealed.sha256, nextReminderAt: null, updatedAt: completedAt })
          .where(and(eq(envelopes.id, current.envelope.id), eq(envelopes.status, "client_signed"), isNull(envelopes.finalBlobId)))
          .returning({ id: envelopes.id });
        // Losing the race rolls the blob back with the transaction, so no orphan is left.
        if (!done) throw new Raced();
        await tx.update(files).set({ agreementStatus: "signed", updatedAt: completedAt }).where(and(eq(files.id, current.file.id), eq(files.orgId, current.org.id)));
        await recordEvent(tx, {
          orgId: current.org.id,
          fileId: current.file.id,
          envelopeId: current.envelope.id,
          type: "envelope.completed",
          actor: systemActor(current.org.id),
          data: { sha256: sealed.sha256 },
        });
        await enqueueWebhookEvent(
          tx,
          current.org.id,
          "agreement.completed",
          webhookPayload(current, "completed", { completedAt: completedAt.toISOString(), signedDocumentSha256: sealed.sha256 }),
        );
      });
      won = true;
    } catch (err) {
      if (!(err instanceof Raced)) throw err;
    }

    if (!won) {
      const [row] = await db.select({ status: envelopes.status }).from(envelopes).where(eq(envelopes.id, current.envelope.id)).limit(1);
      return row?.status === "completed" ? { status: "completed", alreadyCompleted: true } : { status: "not_ready", reason: `The envelope is ${row?.status ?? "gone"}.` };
    }

    await sendCompletedEmails(current, sealed.pdf);
    return { status: "completed", alreadyCompleted: false };
  } catch (err) {
    const error = cleanText(err instanceof Error ? err.message : String(err), 300) || "The final copy could not be prepared.";
    console.error(`[signing] finalize failed for ${envelopeId}: ${error}`);
    if (ctx) await recordFinalizeFailure(ctx, error);
    return { status: "failed", error };
  }
}

export interface CompletedEmailOutcome {
  to: string;
  status: SendOutcome["status"];
}

/**
 * Email the sealed copy to every signer and to the team. Returns what happened per
 * recipient; a message the provider refused is written to the file's timeline, so
 * a client who never got their copy is visible to the sender.
 */
async function sendCompletedEmails(ctx: EnvelopeContext, pdf: Uint8Array): Promise<CompletedEmailOutcome[]> {
  const outcomes: CompletedEmailOutcome[] = [];
  try {
    const db = await getDb();
    const content = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
    const attachments = [{ filename: documentFilename(ctx.envelope, ctx.file, "signed"), content }];
    const attached = attachmentsFit(attachments);
    const brand = brandOf(ctx.org);

    const recipients: { name: string; email: string; downloadUrl: string }[] = [];
    const add = (name: string, email: string, downloadUrl: string) => {
      if (!recipients.some((r) => normalizeEmail(r.email) === normalizeEmail(email))) recipients.push({ name, email, downloadUrl });
    };
    // Team members get the file page; a client's only way in is their own link.
    for (const s of ctx.signers) add(s.name, s.email, s.role === "company" && s.userId ? fileUrl(ctx.file.id) : signingUrl(s));
    const team = await teamRecipient(db, ctx.envelope);
    if (team) add(team.name, team.email, fileUrl(ctx.file.id));

    for (const r of recipients) {
      const result = await safeSend(ctx.org, {
        envelopeId: ctx.envelope.id,
        kind: "completed",
        to: r.email,
        ...completedEmail({
          brand,
          recipientName: r.name,
          agreementName: ctx.envelope.templateName,
          fileReference: ctx.file.reference,
          downloadUrl: r.downloadUrl,
          attached,
        }),
        attachments: attached ? attachments : undefined,
      });
      outcomes.push({ to: r.email, status: result.status });
      if (result.status === "failed") {
        await recordEvent(db, {
          orgId: ctx.org.id,
          fileId: ctx.file.id,
          envelopeId: ctx.envelope.id,
          type: "envelope.delivery_failed",
          actor: systemActor(ctx.org.id),
          data: { email: r.email, kind: "completed", error: cleanText(result.error, 300) || "The email provider did not accept the completed copy" },
        }).catch(() => undefined);
      }
    }
  } catch (err) {
    console.error("[signing] could not send completed emails", err instanceof Error ? err.message : err);
  }
  return outcomes;
}

/**
 * Send the completed-copy emails for an envelope that is already sealed. Used by the
 * scheduler when the request that sealed it died before its emails went out.
 */
export async function resendCompletedEmails(envelopeId: string): Promise<CompletedEmailOutcome[]> {
  const db = await getDb();
  const ctx = await loadEnvelopeContext(db, envelopeId);
  if (!ctx || ctx.envelope.status !== "completed" || !ctx.envelope.finalBlobId) return [];
  const blob = await getBlob(ctx.org.id, ctx.envelope.finalBlobId, db);
  if (!blob) return [];
  return sendCompletedEmails(ctx, new Uint8Array(blob.bytes));
}

/**
 * Envelopes that are fully signed but not sealed, oldest first. After a failure an
 * envelope waits before it is tried again: 5 minutes, then double each time, up to
 * 6 hours. It is never given up on, because the cause (a bad deploy, storage that
 * was briefly down) is usually nothing to do with the document.
 */
export async function listUnsealedEnvelopeIds(limit: number, now: Date = new Date()): Promise<string[]> {
  const db = await getDb();
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const backingOff = sql`exists (
    select 1 from ${eventsTable}
    where ${eventsTable.envelopeId} = ${envelopes.id} and ${eventsTable.type} = ${FINALIZE_FAILED_EVENT}
    having max(${eventsTable.createdAt})
      + least(power(2::float8, least(count(*) - 1, 20)) * ${FINALIZE_RETRY_BASE_MS}::float8, ${FINALIZE_RETRY_MAX_MS}::float8) * interval '1 millisecond'
      > ${at.toISOString()}::timestamptz
  )`;
  const rows = await db
    .select({ id: envelopes.id })
    .from(envelopes)
    .where(
      and(
        eq(envelopes.status, "client_signed"),
        isNull(envelopes.finalBlobId),
        sql`not exists (select 1 from ${signers} where ${signers.envelopeId} = ${envelopes.id} and ${signers.status} <> 'signed')`,
        sql`exists (select 1 from ${signers} where ${signers.envelopeId} = ${envelopes.id})`,
        sql`not ${backingOff}`,
      ),
    )
    .orderBy(asc(envelopes.updatedAt))
    .limit(Math.max(1, Math.min(100, Math.floor(limit) || 10)));
  return rows.map((r) => r.id);
}

/** True when every signer has signed but the sealed copy does not exist yet. */
export function awaitingSeal(ctx: EnvelopeContext): boolean {
  return ctx.envelope.status === "client_signed" && !ctx.envelope.finalBlobId && ctx.signers.length > 0 && ctx.signers.every((s) => s.status === "signed");
}

// ---------------------------------------------------------------------------
// Emails about a link that stopped working
// ---------------------------------------------------------------------------

export type LinkDeadKind = "voided" | "expired" | "not_completed";

/**
 * What a signer is told when their link dies. The wording follows what happened:
 * the company cancelling, the link running out of time, and the company not
 * countersigning are three different things to the person reading.
 */
export function linkDeadEmail(
  kind: LinkDeadKind,
  input: { brand: Brand; signerName: string; agreementName: string; reason?: string | null; expiredOn?: string | null },
): EmailContent {
  if (kind === "voided") return voidedEmail(input);
  const org = cleanText(input.brand.orgName, 120) || "Your service provider";
  const agreement = cleanText(input.agreementName, 200) || "the agreement";
  const name = cleanText(input.signerName, 120);
  const on = cleanText(input.expiredOn, 40);
  const subject = kind === "expired" ? `Your signing link for ${agreement} has expired` : `${agreement} with ${org} was not completed`;
  const paragraphs =
    kind === "expired"
      ? [
          name ? `Hi ${name},` : "Hello,",
          `The link ${org} sent you to sign ${agreement} expired${on ? ` on ${on}` : ""} before the agreement was signed, so it no longer works.`,
          `If you still want to sign, contact ${org} and ask them to send the agreement again. You will get a new link.`,
        ]
      : [
          name ? `Hi ${name},` : "Hello,",
          `You signed ${agreement}, but ${org} did not countersign it, so the agreement was not completed and is not in effect.`,
          `The link you were sent no longer works. Contact ${org} if you were expecting the agreement to go ahead.`,
        ];
  const footer = `Sent by ${org} through ${PRODUCT_NAME}, the service ${org} uses to get agreements signed.`;
  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;";
  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:24px;background-color:#ffffff;">` +
    `<p style="${font}font-size:18px;font-weight:bold;color:#111827;margin:0 0 16px;">${escapeHtml(org)}</p>` +
    paragraphs.map((text) => `<p style="${font}font-size:16px;line-height:24px;color:#1f2937;margin:0 0 16px;">${escapeHtml(text)}</p>`).join("") +
    `<p style="${font}font-size:12px;line-height:18px;color:#6b7280;margin:24px 0 0;">${escapeHtml(footer)}</p>` +
    `</body></html>`;
  return { subject, html, text: [...paragraphs, "--", footer].join("\n\n") + "\n" };
}

// ---------------------------------------------------------------------------
// Public verification
// ---------------------------------------------------------------------------

export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

export type VerifyResult =
  | { found: false }
  | {
      found: true;
      organization: string;
      agreementName: string;
      completedAt: string | null;
      signers: { role: "client" | "company"; name: string; email: string; signedAt: string | null }[];
    };

/**
 * For the public verify page: does a sealed document with exactly this SHA-256
 * exist? Returns only what is already printed on the certificate, with emails masked.
 */
export async function verifyDocument(input: { sha256?: unknown } | null | undefined, meta?: RequestMeta): Promise<VerifyResult> {
  const ip = cleanText(meta?.ip, 64);
  // Callers whose address the route could not determine share one counter, so a
  // missing header can never mean "no limit".
  const limit = ip ? await rateLimit(`verify:ip:${ip}`, 60, 60) : await rateLimit("verify:ip:unknown", 300, 60);
  if (!limit.ok) throw new ServiceError("rate_limited", `Too many checks. Try again ${describeWait(limit.retryAfterSeconds)}.`);
  const raw = typeof input?.sha256 === "string" ? input.sha256.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(raw)) return { found: false };
  const db = await getDb();
  const [envelope] = await db
    .select()
    .from(envelopes)
    .where(and(eq(envelopes.finalSha256, raw), eq(envelopes.status, "completed")))
    .limit(1);
  if (!envelope) return { found: false };
  const [org] = await db.select().from(orgs).where(eq(orgs.id, envelope.orgId)).limit(1);
  const rows = await db.select().from(signers).where(eq(signers.envelopeId, envelope.id)).orderBy(asc(signers.order));
  return {
    found: true,
    organization: org ? org.legalName || org.name : "",
    agreementName: envelope.templateName,
    completedAt: envelope.completedAt ? envelope.completedAt.toISOString() : null,
    signers: rows.map((s) => ({ role: s.role, name: s.name, email: maskEmail(s.email), signedAt: s.signedAt ? s.signedAt.toISOString() : null })),
  };
}

