/**
 * Files: one job or case for one client. Creating a file is the trigger for the
 * whole product, so the rule here is that a file is never lost: the row commits
 * first, and sending the agreement is a second step whose failure is reported,
 * not thrown.
 */
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { getDb, type Db, type DbOrTx } from "@/lib/db";
import { envelopes, files, orgs, signers, type Envelope, type EventRow, type FileRow, type Org, type Signer } from "@/lib/db/schema";
import { newId, randomString } from "@/lib/ids";
import { LIMITS, ORG_SETTING_DEFAULTS } from "@/lib/types";
import { cleanMultilineText, cleanText, isValidEmail, normalizeEmail } from "@/lib/validation";
import { ServiceError, type Actor, type RequestMeta } from "./context";
import { normalizeDataKey, type ImportRow } from "./csv";
import { sendAgreementForFile, voidOpenEnvelopesForFile } from "./envelopes";
import { listEvents, recordEvent } from "./events";
import { enqueueWebhookEvent } from "./webhooks";

// ---------------------------------------------------------------------------
// Types and limits
// ---------------------------------------------------------------------------

export const FILE_LIMITS = {
  clientNameMax: 200,
  clientCompanyMax: 200,
  clientTitleMax: 120,
  clientPhoneMax: 40,
  descriptionMax: 2000,
  referenceMax: 64,
  externalIdMax: 200,
  dataMaxKeys: 50,
  dataValueMax: LIMITS.maxTextFieldLength,
  importMaxRows: 1000,
  pageSizeDefault: 25,
  pageSizeMax: 100,
} as const;

export type FileSource = FileRow["source"];
export type AgreementStatus = FileRow["agreementStatus"];

export const AGREEMENT_STATUSES = [
  "no_agreement",
  "out_for_signature",
  "awaiting_countersign",
  "signed",
  "declined",
  "needs_attention",
] as const satisfies readonly AgreementStatus[];

const FILE_SOURCES: readonly FileSource[] = ["manual", "csv", "api", "intake"];

/** Values arrive from forms, JSON bodies and spreadsheets, so every one is checked at runtime. */
export interface CreateFileInput {
  clientName: unknown;
  clientEmail: unknown;
  clientCompany?: unknown;
  clientTitle?: unknown;
  clientPhone?: unknown;
  description?: unknown;
  /** Human file number. Generated when absent. */
  reference?: unknown;
  /** Id in the caller's own system; creating twice with the same one returns the first file. */
  externalId?: unknown;
  /** Custom values for prefill fields. Keys are stored through normalizeDataKey. */
  data?: unknown;
  source?: unknown;
  /** Send the default agreement now. Defaults to the org's autoSendOnFileCreate setting. */
  send?: unknown;
}

export interface AgreementOutcome {
  sent: boolean;
  envelopeId?: string;
  delivery?: "emailed" | "email_not_configured" | "email_failed";
  signingUrl?: string;
  /** Present when sent is false: why, in words that can be shown as they are. */
  reason?: string;
}

export interface CreateFileResult {
  file: FileRow;
  /** False when an existing file with the same externalId was returned instead. */
  created: boolean;
  agreement: AgreementOutcome;
}

export type UpdateFilePatch = Partial<Omit<CreateFileInput, "source" | "send" | "externalId">>;

export interface UpdateFileResult {
  file: FileRow;
  /** Plain names of what changed, e.g. ["client email", "description"]. Empty when nothing did. */
  changed: string[];
  /** The agreement the client has not signed yet, if there is one. */
  outstandingEnvelope: { id: string; status: Envelope["status"] } | null;
  /** True when the client's name or email changed while an agreement is waiting for them:
   *  the link already sent still carries the old details, so offer to reissue it. */
  reissueSuggested: boolean;
}

/** An envelope without its document snapshot (pages, fields, prefill), which a file page never needs. */
export type EnvelopeSummary = Omit<Envelope, "pages" | "fields" | "prefill"> & { signers: SignerSummary[] };
/** A signer without link secrets or captured values (signature images can be hundreds of kilobytes). */
export type SignerSummary = Omit<Signer, "tokenNonce" | "tokenHash" | "values">;

export interface FileDetail {
  file: FileRow;
  /** Newest first. */
  envelopes: EnvelopeSummary[];
  /** Oldest first; the most recent 500. */
  events: EventRow[];
}

export interface ListFilesOptions {
  q?: unknown;
  status?: unknown;
  /** false (default): only current files. true: only archived. "all": both. */
  archived?: unknown;
  page?: unknown;
  pageSize?: unknown;
}

export interface ListFilesResult {
  files: FileRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export type FileCounts = Record<AgreementStatus, number> & { all: number; archived: number };

export interface DashboardStats {
  /** Current files whose agreement is with the client or waiting for the countersignature. */
  open: number;
  /** Current files with no agreement sent. */
  notSent: number;
  /** Current files whose agreement was declined, expired or could not be delivered. */
  needsAttention: number;
  /** Agreements completed since the first of this month (UTC). */
  signedThisMonth: number;
  /** Median time from sending to completion over the last 90 days, or null with no completions. */
  medianSecondsToSign: number | null;
  oldestOutstanding: {
    fileId: string;
    envelopeId: string;
    reference: string;
    clientName: string;
    status: Envelope["status"];
    sentAt: Date;
    daysOutstanding: number;
  } | null;
  /** Share (0..1) of agreements sent in the last 90 days, not counting voided ones, that are completed. */
  completionRate: number | null;
}

export interface ImportRowResult {
  /** Spreadsheet row number when the row carried one, otherwise its position in the batch plus one. */
  row: number;
  status: "created" | "skipped" | "error";
  message: string;
  fileId?: string;
  reference?: string;
  agreementSent?: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface CleanFileValues {
  clientName: string;
  clientEmail: string;
  clientCompany: string | null;
  clientTitle: string | null;
  clientPhone: string | null;
  description: string | null;
  reference: string | null;
  externalId: string | null;
  data: Record<string, string>;
}

type FieldErrors = Record<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function required(value: unknown, max: number, label: string, key: string, errors: FieldErrors): string {
  const text = cleanText(value, max + 1);
  if (!text) errors[key] = `${label} is required.`;
  else if (text.length > max) errors[key] = `${label} must be ${max} characters or fewer.`;
  return text;
}

function optional(value: unknown, max: number, label: string, key: string, errors: FieldErrors, multiline = false): string | null {
  const text = multiline ? cleanMultilineText(value, max + 1) : cleanText(value, max + 1);
  if (text.length > max) errors[key] = `${label} must be ${max} characters or fewer.`;
  return text || null;
}

function cleanEmail(value: unknown, errors: FieldErrors): string {
  const email = normalizeEmail(value);
  if (!email) errors.clientEmail = "Client email is required.";
  else if (!isValidEmail(email)) errors.clientEmail = "Enter a valid client email address, like name@example.com.";
  return email;
}

function cleanData(value: unknown, errors: FieldErrors): Record<string, string> {
  if (value === undefined || value === null || value === "") return {};
  if (!isRecord(value)) {
    errors.data = "Extra values must be a set of name and value pairs.";
    return {};
  }
  // A Map keeps "__proto__" and friends as ordinary keys until fromEntries defines them as own properties.
  const out = new Map<string, string>();
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeDataKey(rawKey);
    if (!key) continue;
    if (typeof rawValue !== "string" && typeof rawValue !== "number" && typeof rawValue !== "boolean") continue;
    const text = cleanText(String(rawValue), FILE_LIMITS.dataValueMax + 1);
    if (!text) continue;
    if (text.length > FILE_LIMITS.dataValueMax) {
      errors.data = `The value for "${cleanText(rawKey, 60)}" must be ${FILE_LIMITS.dataValueMax} characters or fewer.`;
      continue;
    }
    out.set(key, text);
  }
  if (out.size > FILE_LIMITS.dataMaxKeys) errors.data = `A file can hold at most ${FILE_LIMITS.dataMaxKeys} extra values; this one has ${out.size}.`;
  return Object.fromEntries(out);
}

function invalid(errors: FieldErrors): ServiceError {
  const messages = Object.values(errors);
  return new ServiceError("invalid", messages.length === 1 ? messages[0] : `Some details need fixing: ${messages.join(" ")}`, errors);
}

function validateCreate(input: unknown): CleanFileValues {
  if (!isRecord(input)) throw new ServiceError("invalid", "The file details are missing. Enter the client's name and email.");
  const errors: FieldErrors = {};
  const values: CleanFileValues = {
    clientName: required(input.clientName, FILE_LIMITS.clientNameMax, "Client name", "clientName", errors),
    clientEmail: cleanEmail(input.clientEmail, errors),
    clientCompany: optional(input.clientCompany, FILE_LIMITS.clientCompanyMax, "Company", "clientCompany", errors),
    clientTitle: optional(input.clientTitle, FILE_LIMITS.clientTitleMax, "Title", "clientTitle", errors),
    clientPhone: optional(input.clientPhone, FILE_LIMITS.clientPhoneMax, "Phone", "clientPhone", errors),
    description: optional(input.description, FILE_LIMITS.descriptionMax, "Description", "description", errors, true),
    reference: optional(input.reference, FILE_LIMITS.referenceMax, "File reference", "reference", errors),
    externalId: optional(input.externalId, FILE_LIMITS.externalIdMax, "External ID", "externalId", errors),
    data: cleanData(input.data, errors),
  };
  if (Object.keys(errors).length > 0) throw invalid(errors);
  return values;
}

function assertActor(actor: Actor): void {
  if (!actor || typeof actor.orgId !== "string" || !actor.orgId) {
    throw new ServiceError("forbidden", "Sign in again to continue.");
  }
}

const NOT_FOUND = "That file was not found. It may belong to a different account or the link may be wrong.";

function fileId(id: unknown): string {
  // Ids are compared as text; anything else can never match and must not reach the driver as an object.
  if (typeof id !== "string" || id.length === 0 || id.length > 64) throw new ServiceError("not_found", NOT_FOUND);
  return id;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface UniqueViolation {
  constraint: string;
}

/** Recognises Postgres error 23505 from either driver, including when Drizzle wraps it. */
function uniqueViolation(err: unknown): UniqueViolation | null {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const e = current as { code?: unknown; constraint?: unknown; constraint_name?: unknown; message?: unknown; detail?: unknown; cause?: unknown };
    if (e.code === "23505") {
      const named = typeof e.constraint === "string" ? e.constraint : typeof e.constraint_name === "string" ? e.constraint_name : "";
      return { constraint: named || `${typeof e.message === "string" ? e.message : ""} ${typeof e.detail === "string" ? e.detail : ""}` };
    }
    current = e.cause;
  }
  return null;
}

async function loadOrg(db: Db, orgId: string): Promise<Org> {
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
  if (!org) throw new ServiceError("forbidden", "This account no longer exists. Sign in again.");
  return org;
}

function referencePrefix(org: Org): string {
  const stored = isRecord(org.settings) ? org.settings.fileReferencePrefix : undefined;
  const prefix = cleanText(stored, 10);
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(prefix) ? prefix : ORG_SETTING_DEFAULTS.fileReferencePrefix;
}

function autoSend(org: Org): boolean {
  const stored = isRecord(org.settings) ? org.settings.autoSendOnFileCreate : undefined;
  return typeof stored === "boolean" ? stored : ORG_SETTING_DEFAULTS.autoSendOnFileCreate;
}

/** The highest sequence already used for this prefix and year, read under the org's reference lock. */
async function nextSequence(tx: DbOrTx, orgId: string, stem: string): Promise<number> {
  const n = sql.raw(String(stem.length));
  const next = sql.raw(String(stem.length + 1));
  // The digit-count guard keeps a hand-typed "F-2026-99999999999999999999" from overflowing the cast.
  const [row] = await tx
    .select({ max: sql<string | null>`max(substring(${files.reference} from ${next})::bigint)` })
    .from(files)
    .where(
      and(
        eq(files.orgId, orgId),
        sql`left(${files.reference}, ${n}) = ${stem}`,
        sql`substring(${files.reference} from ${next}) ~ '^[0-9]{1,12}$'`,
      ),
    );
  const max = row?.max == null ? 0 : Number(row.max);
  return Number.isFinite(max) ? max + 1 : 1;
}

function actorUserId(actor: Actor): string | null {
  return actor.type === "user" ? actor.userId : null;
}

/** The shape of a file in webhook payloads and API responses. */
export function toPublicFile(file: FileRow) {
  return {
    id: file.id,
    reference: file.reference,
    externalId: file.externalId,
    clientName: file.clientName,
    clientEmail: file.clientEmail,
    clientCompany: file.clientCompany,
    clientTitle: file.clientTitle,
    clientPhone: file.clientPhone,
    description: file.description,
    data: file.data,
    source: file.source,
    agreementStatus: file.agreementStatus,
    /** The gate the product exists for: work may start only when this is true. */
    clearedToStart: file.agreementStatus === "signed",
    archivedAt: file.archivedAt ? file.archivedAt.toISOString() : null,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  };
}

async function findFile(db: DbOrTx, orgId: string, id: string): Promise<FileRow | null> {
  const [row] = await db.select().from(files).where(and(eq(files.orgId, orgId), eq(files.id, id))).limit(1);
  return row ?? null;
}

async function findByExternalId(db: DbOrTx, orgId: string, externalId: string): Promise<FileRow | null> {
  const [row] = await db.select().from(files).where(and(eq(files.orgId, orgId), eq(files.externalId, externalId))).limit(1);
  return row ?? null;
}

async function referenceTaken(db: DbOrTx, orgId: string, reference: string, exceptId?: string): Promise<boolean> {
  // The index is case-sensitive; people are not. "f-2026-0001" next to "F-2026-0001" would only cause mix-ups.
  const conditions: SQL[] = [eq(files.orgId, orgId), sql`lower(${files.reference}) = ${reference.toLowerCase()}`];
  if (exceptId) conditions.push(ne(files.id, exceptId));
  const [row] = await db.select({ id: files.id }).from(files).where(and(...conditions)).limit(1);
  return Boolean(row);
}

function referenceConflict(reference: string): ServiceError {
  const message = `Another file already uses the reference ${reference}. Choose a different reference, or leave it blank to have one generated.`;
  return new ServiceError("conflict", message, { reference: message });
}

const EXISTING_REASON = "This file already exists, so no new agreement was sent.";
const GENERIC_SEND_FAILURE = "The agreement could not be sent. Open the file and send it again.";

/** Sends the org's agreement for a file and turns every failure into a reason. Never throws. */
async function trySend(actor: Actor, id: string, meta?: RequestMeta): Promise<AgreementOutcome & { orgWide?: boolean }> {
  try {
    const result = await sendAgreementForFile(actor, id, {}, meta);
    return { sent: true, envelopeId: result.envelopeId, delivery: result.delivery, signingUrl: result.signingUrl };
  } catch (err) {
    if (err instanceof ServiceError) {
      // not_ready describes the org's setup (no agreement, no countersigner), so it applies to every file alike.
      return { sent: false, reason: err.message || GENERIC_SEND_FAILURE, orgWide: err.code === "not_ready" };
    }
    console.error("[files] sending the agreement failed", { fileId: id, error: err instanceof Error ? err.message : String(err) });
    return { sent: false, reason: GENERIC_SEND_FAILURE };
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

const CREATE_ATTEMPTS = 8;

async function insertFile(db: Db, actor: Actor, org: Org, values: CleanFileValues, source: FileSource, meta?: RequestMeta): Promise<{ file: FileRow; created: boolean }> {
  const year = new Date().getUTCFullYear();
  const stem = `${referencePrefix(org)}-${year}-`;

  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
    try {
      const file = await db.transaction(async (tx) => {
        let reference = values.reference;
        if (!reference) {
          // Serialises numbering per org so twenty simultaneous creates get twenty consecutive
          // numbers instead of racing for the same one. Released when the transaction ends.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`file-reference:${org.id}`}, 0))`);
          const seq = await nextSequence(tx, org.id, stem);
          reference = `${stem}${String(seq).padStart(4, "0")}`;
          // Only reachable if hand-typed references keep landing on the generated number.
          if (attempt >= CREATE_ATTEMPTS - 2) reference = `${reference}-${randomString(4)}`;
        }
        const [row] = await tx
          .insert(files)
          .values({
            id: newId("file"),
            orgId: org.id,
            reference,
            externalId: values.externalId,
            clientName: values.clientName,
            clientEmail: values.clientEmail,
            clientCompany: values.clientCompany,
            clientTitle: values.clientTitle,
            clientPhone: values.clientPhone,
            description: values.description,
            data: values.data,
            source,
            createdBy: actorUserId(actor),
          })
          .returning();
        await recordEvent(tx, {
          orgId: org.id,
          fileId: row.id,
          type: "file.created",
          actor,
          meta,
          data: { reference: row.reference, source, clientName: row.clientName, email: row.clientEmail },
        });
        await enqueueWebhookEvent(tx, org.id, "file.created", { file: toPublicFile(row) });
        return row;
      });
      return { file, created: true };
    } catch (err) {
      const violation = uniqueViolation(err);
      if (!violation) throw err;
      if (values.externalId && (violation.constraint.includes("external") || !violation.constraint.includes("reference"))) {
        // Two requests with the same externalId raced; the loser returns the winner's file.
        const existing = await findByExternalId(db, org.id, values.externalId);
        if (existing) return { file: existing, created: false };
      }
      if (values.reference) throw referenceConflict(values.reference);
      // A generated reference collided (someone typed that exact number by hand): take the next one.
    }
  }
  throw new ServiceError("conflict", "A file reference could not be generated just now. Try again, or type a reference yourself.");
}

/**
 * Creates a file and, unless told otherwise, sends the org's agreement for it.
 * Throws ServiceError for invalid input or a duplicate reference. Once the file
 * exists, nothing about the agreement can make this throw: see `agreement.reason`.
 */
export async function createFile(actor: Actor, input: CreateFileInput, meta?: RequestMeta): Promise<CreateFileResult> {
  assertActor(actor);
  const values = validateCreate(input);
  const raw = input as unknown as Record<string, unknown>;
  const source: FileSource = FILE_SOURCES.includes(raw.source as FileSource) ? (raw.source as FileSource) : actor.type === "api" ? "api" : "manual";

  const db = await getDb();
  const org = await loadOrg(db, actor.orgId);

  if (values.externalId) {
    const existing = await findByExternalId(db, org.id, values.externalId);
    if (existing) return { file: existing, created: false, agreement: { sent: false, reason: EXISTING_REASON } };
  }
  if (values.reference && (await referenceTaken(db, org.id, values.reference))) throw referenceConflict(values.reference);

  const { file, created } = await insertFile(db, actor, org, values, source, meta);
  if (!created) return { file, created: false, agreement: { sent: false, reason: EXISTING_REASON } };

  const send = typeof raw.send === "boolean" ? raw.send : autoSend(org);
  if (!send) {
    const reason = typeof raw.send === "boolean" ? "The agreement was not sent because sending was turned off for this file." : "Automatic sending is turned off in settings. Send the agreement from the file when you are ready.";
    return { file, created: true, agreement: { sent: false, reason } };
  }

  const outcome = await trySend(actor, file.id, meta);
  const agreement: AgreementOutcome = { sent: outcome.sent };
  if (outcome.envelopeId) agreement.envelopeId = outcome.envelopeId;
  if (outcome.delivery) agreement.delivery = outcome.delivery;
  if (outcome.signingUrl) agreement.signingUrl = outcome.signingUrl;
  if (outcome.reason) agreement.reason = outcome.reason;
  // Sending changes the file's agreement status; hand back the row as it is now.
  const fresh = outcome.sent ? await findFile(db, org.id, file.id).catch(() => null) : null;
  return { file: fresh ?? file, created: true, agreement };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getFile(actor: Actor, id: unknown): Promise<FileDetail> {
  assertActor(actor);
  const db = await getDb();
  const file = await findFile(db, actor.orgId, fileId(id));
  if (!file) throw new ServiceError("not_found", NOT_FOUND);

  const envelopeRows = await db
    .select()
    .from(envelopes)
    .where(and(eq(envelopes.orgId, actor.orgId), eq(envelopes.fileId, file.id)))
    .orderBy(desc(envelopes.createdAt), desc(envelopes.id));
  const signerRows = envelopeRows.length
    ? await db
        .select()
        .from(signers)
        .where(and(eq(signers.orgId, actor.orgId), inArray(signers.envelopeId, envelopeRows.map((e) => e.id))))
        .orderBy(asc(signers.order), asc(signers.createdAt))
    : [];

  const summaries: EnvelopeSummary[] = envelopeRows.map((envelope) => ({
    ...omit(envelope, ["pages", "fields", "prefill"]),
    signers: signerRows.filter((s) => s.envelopeId === envelope.id).map((signer) => omit(signer, ["tokenNonce", "tokenHash", "values"])),
  }));

  // Asked for newest first so a very long history keeps its latest entries, then put back in reading order.
  const recent = await listEvents(actor.orgId, { fileId: file.id, limit: 500, newestFirst: true }, db);
  return { file, envelopes: summaries, events: recent.reverse() };
}

function omit<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Omit<T, K> {
  const copy = { ...row };
  for (const key of keys) delete copy[key];
  return copy;
}

function toInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function isStatus(value: unknown): value is AgreementStatus {
  return typeof value === "string" && (AGREEMENT_STATUSES as readonly string[]).includes(value);
}

export async function listFiles(actor: Actor, opts: ListFilesOptions = {}): Promise<ListFilesResult> {
  assertActor(actor);
  const options = isRecord(opts) ? opts : {};
  const conditions: SQL[] = [eq(files.orgId, actor.orgId)];

  if (options.archived === true || options.archived === "true" || options.archived === "only") conditions.push(isNotNull(files.archivedAt));
  else if (options.archived !== "all") conditions.push(isNull(files.archivedAt));

  const requested = Array.isArray(options.status) ? options.status : options.status === undefined || options.status === null || options.status === "" || options.status === "all" ? [] : [options.status];
  if (requested.length > 0) {
    const statuses = requested.filter(isStatus);
    // An unknown status matches nothing rather than silently showing everything.
    conditions.push(statuses.length > 0 ? inArray(files.agreementStatus, statuses) : sql`false`);
  }

  // Every word must appear somewhere, so "smith acme" finds Jane Smith at Acme.
  const terms = cleanText(options.q, 120).split(" ").filter(Boolean).slice(0, 6);
  for (const term of terms) {
    const pattern = `%${escapeLike(term)}%`;
    const match = or(ilike(files.clientName, pattern), ilike(files.clientEmail, pattern), ilike(files.clientCompany, pattern), ilike(files.reference, pattern));
    if (match) conditions.push(match);
  }

  const pageSize = toInt(options.pageSize, FILE_LIMITS.pageSizeDefault, 1, FILE_LIMITS.pageSizeMax);
  const db = await getDb();
  const where = and(...conditions);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(files).where(where);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  // A page past the end (a stale link after files were archived) shows the last page, not an empty one.
  const page = Math.min(toInt(options.page, 1, 1, 1_000_000), pageCount);
  const rows = await db
    .select()
    .from(files)
    .where(where)
    .orderBy(desc(files.createdAt), desc(files.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { files: rows, total, page, pageSize, pageCount };
}

/** Current (not archived) files by agreement status, plus the archived total. */
export async function fileCounts(actor: Actor): Promise<FileCounts> {
  assertActor(actor);
  const db = await getDb();
  const rows = await db
    .select({
      status: files.agreementStatus,
      archived: sql<boolean>`${files.archivedAt} is not null`,
      count: sql<number>`count(*)::int`,
    })
    .from(files)
    .where(eq(files.orgId, actor.orgId))
    .groupBy(files.agreementStatus, sql`${files.archivedAt} is not null`);
  const counts: FileCounts = { all: 0, archived: 0, no_agreement: 0, out_for_signature: 0, awaiting_countersign: 0, signed: 0, declined: 0, needs_attention: 0 };
  for (const row of rows) {
    if (row.archived) counts.archived += row.count;
    else {
      counts.all += row.count;
      if (isStatus(row.status)) counts[row.status] += row.count;
    }
  }
  return counts;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function dashboardStats(actor: Actor, now: Date = new Date()): Promise<DashboardStats> {
  assertActor(actor);
  const db = await getDb();
  const counts = await fileCounts(actor);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const windowStart = new Date(now.getTime() - 90 * DAY_MS);

  const [signed] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(envelopes)
    .where(and(eq(envelopes.orgId, actor.orgId), eq(envelopes.status, "completed"), gte(envelopes.completedAt, monthStart)));

  const [median] = await db
    .select({
      seconds: sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from (${envelopes.completedAt} - ${envelopes.sentAt})))`,
    })
    .from(envelopes)
    .where(
      and(
        eq(envelopes.orgId, actor.orgId),
        eq(envelopes.status, "completed"),
        isNotNull(envelopes.sentAt),
        isNotNull(envelopes.completedAt),
        gte(envelopes.completedAt, windowStart),
      ),
    );

  const [oldest] = await db
    .select({
      fileId: files.id,
      envelopeId: envelopes.id,
      reference: files.reference,
      clientName: files.clientName,
      status: envelopes.status,
      sentAt: envelopes.sentAt,
    })
    .from(envelopes)
    .innerJoin(files, and(eq(files.id, envelopes.fileId), eq(files.orgId, envelopes.orgId)))
    .where(
      and(
        eq(envelopes.orgId, actor.orgId),
        inArray(envelopes.status, ["sent", "viewed", "client_signed"]),
        isNotNull(envelopes.sentAt),
        isNull(files.archivedAt),
      ),
    )
    .orderBy(asc(envelopes.sentAt), asc(envelopes.id))
    .limit(1);

  const [rate] = await db
    .select({
      sent: sql<number>`count(*)::int`,
      completed: sql<number>`(count(*) filter (where ${envelopes.status} = 'completed'))::int`,
    })
    .from(envelopes)
    .where(and(eq(envelopes.orgId, actor.orgId), isNotNull(envelopes.sentAt), ne(envelopes.status, "voided"), gte(envelopes.sentAt, windowStart)));

  const medianSeconds = median?.seconds == null ? null : Number(median.seconds);
  return {
    open: counts.out_for_signature + counts.awaiting_countersign,
    notSent: counts.no_agreement,
    needsAttention: counts.declined + counts.needs_attention,
    signedThisMonth: signed?.count ?? 0,
    // A clock correction can put completion before sending; a negative duration means nothing to a reader.
    medianSecondsToSign: medianSeconds !== null && Number.isFinite(medianSeconds) ? Math.max(0, Math.round(medianSeconds)) : null,
    oldestOutstanding:
      oldest && oldest.sentAt
        ? {
            fileId: oldest.fileId,
            envelopeId: oldest.envelopeId,
            reference: oldest.reference,
            clientName: oldest.clientName,
            status: oldest.status,
            sentAt: oldest.sentAt,
            daysOutstanding: Math.max(0, Math.floor((now.getTime() - oldest.sentAt.getTime()) / DAY_MS)),
          }
        : null,
    completionRate: rate && rate.sent > 0 ? rate.completed / rate.sent : null,
  };
}

// ---------------------------------------------------------------------------
// Update, archive
// ---------------------------------------------------------------------------

const CHANGE_LABELS: Record<string, string> = {
  clientName: "client name",
  clientEmail: "client email",
  clientCompany: "company",
  clientTitle: "title",
  clientPhone: "phone",
  description: "description",
  reference: "reference",
  data: "extra values",
};

/** Envelope states in which the client has not signed, so their link still matters. */
const WAITING_ON_CLIENT: Envelope["status"][] = ["draft", "sent", "viewed"];

function sameData(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

/**
 * Changes the details of a file. Only keys present in the patch are touched;
 * `data`, when present, replaces the whole set of extra values.
 * It never touches an agreement already sent: when the client's name or email
 * changed and they have not signed, `reissueSuggested` tells the caller to offer that.
 */
export async function updateFile(actor: Actor, id: unknown, patch: UpdateFilePatch, meta?: RequestMeta): Promise<UpdateFileResult> {
  assertActor(actor);
  const targetId = fileId(id);
  if (!isRecord(patch)) throw new ServiceError("invalid", "No changes were received. Edit a field and save again.");
  const has = (key: string) => Object.prototype.hasOwnProperty.call(patch, key) && (patch as Record<string, unknown>)[key] !== undefined;

  const errors: FieldErrors = {};
  const set: Partial<Pick<FileRow, "clientName" | "clientEmail" | "clientCompany" | "clientTitle" | "clientPhone" | "description" | "reference" | "data">> = {};
  if (has("clientName")) set.clientName = required(patch.clientName, FILE_LIMITS.clientNameMax, "Client name", "clientName", errors);
  if (has("clientEmail")) set.clientEmail = cleanEmail(patch.clientEmail, errors);
  if (has("clientCompany")) set.clientCompany = optional(patch.clientCompany, FILE_LIMITS.clientCompanyMax, "Company", "clientCompany", errors);
  if (has("clientTitle")) set.clientTitle = optional(patch.clientTitle, FILE_LIMITS.clientTitleMax, "Title", "clientTitle", errors);
  if (has("clientPhone")) set.clientPhone = optional(patch.clientPhone, FILE_LIMITS.clientPhoneMax, "Phone", "clientPhone", errors);
  if (has("description")) set.description = optional(patch.description, FILE_LIMITS.descriptionMax, "Description", "description", errors, true);
  if (has("reference")) set.reference = required(patch.reference, FILE_LIMITS.referenceMax, "File reference", "reference", errors);
  if (has("data")) set.data = cleanData(patch.data, errors);
  if (Object.keys(errors).length > 0) throw invalid(errors);

  const db = await getDb();
  try {
    return await db.transaction(async (tx) => {
      // Locked so two people saving at once produce two accurate "changed" lists, not one lost edit.
      const [current] = await tx.select().from(files).where(and(eq(files.orgId, actor.orgId), eq(files.id, targetId))).limit(1).for("update");
      if (!current) throw new ServiceError("not_found", NOT_FOUND);

      const changes: typeof set = {};
      const changed: string[] = [];
      for (const key of Object.keys(set) as (keyof typeof set)[]) {
        const next = set[key];
        const same = key === "data" ? sameData(current.data ?? {}, next as Record<string, string>) : (current[key] ?? null) === (next ?? null);
        if (same) continue;
        (changes as Record<string, unknown>)[key] = next;
        changed.push(CHANGE_LABELS[key]);
      }

      const [outstanding] = await tx
        .select({ id: envelopes.id, status: envelopes.status })
        .from(envelopes)
        .where(and(eq(envelopes.orgId, actor.orgId), eq(envelopes.fileId, targetId), inArray(envelopes.status, WAITING_ON_CLIENT)))
        .orderBy(desc(envelopes.createdAt))
        .limit(1);
      const outstandingEnvelope = outstanding ?? null;

      if (changed.length === 0) return { file: current, changed, outstandingEnvelope, reissueSuggested: false };

      if (changes.reference && (await referenceTaken(tx, actor.orgId, changes.reference, targetId))) throw referenceConflict(changes.reference);

      const [file] = await tx
        .update(files)
        .set({ ...changes, updatedAt: new Date() })
        .where(and(eq(files.orgId, actor.orgId), eq(files.id, targetId)))
        .returning();
      await recordEvent(tx, { orgId: actor.orgId, fileId: targetId, type: "file.updated", actor, meta, data: { changed, reference: file.reference } });

      const clientChanged = "clientName" in changes || "clientEmail" in changes;
      return { file, changed, outstandingEnvelope, reissueSuggested: clientChanged && outstandingEnvelope !== null };
    });
  } catch (err) {
    if (uniqueViolation(err) && typeof set.reference === "string") throw referenceConflict(set.reference);
    throw err;
  }
}

export interface ArchiveFileResult {
  file: FileRow;
  /** Agreements that were out for signature and are now void; their links no longer work. */
  voided: number;
}

/**
 * Archives a file: it leaves the working lists and any agreement still out for
 * signature is voided, so a client cannot sign for work that is no longer happening.
 * Archiving an archived file changes nothing.
 */
export async function archiveFile(actor: Actor, id: unknown, meta?: RequestMeta): Promise<ArchiveFileResult> {
  assertActor(actor);
  const targetId = fileId(id);
  const db = await getDb();
  const existing = await findFile(db, actor.orgId, targetId);
  if (!existing) throw new ServiceError("not_found", NOT_FOUND);

  const archived = await db.transaction(async (tx) => {
    // Guarded on "not archived yet" so a double click records one event.
    const [row] = await tx
      .update(files)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(files.orgId, actor.orgId), eq(files.id, targetId), isNull(files.archivedAt)))
      .returning();
    if (row) await recordEvent(tx, { orgId: actor.orgId, fileId: targetId, type: "file.archived", actor, meta, data: { reference: row.reference } });
    return row ?? null;
  });

  // Also run for an already archived file: it repairs the case where an earlier attempt archived but could not void.
  const voided = await voidOpenEnvelopesForFile(actor, targetId, "The file was archived");
  const file = (await findFile(db, actor.orgId, targetId)) ?? archived ?? existing;
  return { file, voided: Number.isFinite(voided) ? voided : 0 };
}

/** Returns an archived file to the working lists. Voided agreements stay void; send a new one from the file. */
export async function unarchiveFile(actor: Actor, id: unknown, meta?: RequestMeta): Promise<FileRow> {
  assertActor(actor);
  const targetId = fileId(id);
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(files)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(and(eq(files.orgId, actor.orgId), eq(files.id, targetId), isNotNull(files.archivedAt)))
      .returning();
    if (row) {
      await recordEvent(tx, { orgId: actor.orgId, fileId: targetId, type: "file.unarchived", actor, meta, data: { reference: row.reference } });
      return row;
    }
    const [current] = await tx.select().from(files).where(and(eq(files.orgId, actor.orgId), eq(files.id, targetId))).limit(1);
    if (!current) throw new ServiceError("not_found", NOT_FOUND);
    return current;
  });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportOptions {
  /** Send the agreement for each created file. Defaults to the org's autoSendOnFileCreate setting. */
  send?: boolean;
  /** How long the import may spend sending agreements before it stops and leaves the rest
   *  to be sent from each file. Files are always all created first. Default 40 seconds,
   *  chosen to finish inside a serverless request. */
  sendBudgetMs?: number;
}

const DEFAULT_SEND_BUDGET_MS = 40_000;
const LOOKUP_CHUNK = 500;

function importSignature(row: Record<string, unknown>): string {
  const part = (v: unknown) => cleanText(v, 300).toLowerCase();
  const data = isRecord(row.data)
    ? Object.entries(row.data)
        .map(([k, v]) => `${normalizeDataKey(k)}=${part(v)}`)
        .sort()
        .join("&")
    : "";
  return [normalizeEmail(row.clientEmail), part(row.clientName), part(row.clientCompany), part(row.clientTitle), part(row.clientPhone), part(row.description), data].join("\u0001");
}

async function existingKeys(db: Db, orgId: string, references: string[], externalIds: string[]): Promise<{ references: Set<string>; externalIds: Set<string> }> {
  const found = { references: new Set<string>(), externalIds: new Set<string>() };
  for (let i = 0; i < references.length; i += LOOKUP_CHUNK) {
    const chunk = references.slice(i, i + LOOKUP_CHUNK);
    const rows = await db
      .select({ reference: files.reference })
      .from(files)
      .where(and(eq(files.orgId, orgId), inArray(sql`lower(${files.reference})`, chunk)));
    for (const r of rows) found.references.add(r.reference.toLowerCase());
  }
  for (let i = 0; i < externalIds.length; i += LOOKUP_CHUNK) {
    const chunk = externalIds.slice(i, i + LOOKUP_CHUNK);
    const rows = await db
      .select({ externalId: files.externalId })
      .from(files)
      .where(and(eq(files.orgId, orgId), inArray(files.externalId, chunk)));
    for (const r of rows) if (r.externalId) found.externalIds.add(r.externalId);
  }
  return found;
}

/**
 * Creates one file per row. One bad row never stops the rest: every row gets its
 * own result. A row is skipped when its reference or external ID already exists
 * (in this batch or in the account), or when it repeats an earlier row exactly.
 *
 * Throws only when the batch as a whole is unusable (not a list, over 1000 rows).
 */
export async function importFiles(actor: Actor, rows: ImportRow[], opts: ImportOptions = {}, meta?: RequestMeta): Promise<ImportRowResult[]> {
  assertActor(actor);
  if (!Array.isArray(rows)) throw new ServiceError("invalid", "No rows were received. Upload the spreadsheet again.");
  if (rows.length > FILE_LIMITS.importMaxRows) {
    throw new ServiceError(
      "invalid",
      `An import can have at most ${FILE_LIMITS.importMaxRows} rows and this one has ${rows.length}. Split the spreadsheet into smaller files and import them one at a time.`,
    );
  }
  if (rows.length === 0) return [];

  const db = await getDb();
  const org = await loadOrg(db, actor.orgId);
  const options = isRecord(opts) ? opts : {};
  const send = typeof options.send === "boolean" ? options.send : autoSend(org);

  const rowNumber = (row: unknown, index: number): number => {
    const n = isRecord(row) ? row.row : undefined;
    return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : index + 1;
  };
  const key = (value: unknown, max: number) => cleanText(value, max);

  const references = new Set<string>();
  const externalIds = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const ref = key(row.reference, FILE_LIMITS.referenceMax).toLowerCase();
    const ext = key(row.externalId, FILE_LIMITS.externalIdMax);
    if (ref) references.add(ref);
    if (ext) externalIds.add(ext);
  }
  const existing = await existingKeys(db, org.id, [...references], [...externalIds]);

  const results: ImportRowResult[] = [];
  const created: { result: ImportRowResult; fileId: string }[] = [];
  const seenReferences = new Map<string, number>();
  const seenExternalIds = new Map<string, number>();
  const seenRows = new Map<string, number>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const number = rowNumber(row, i);
    if (!isRecord(row)) {
      results.push({ row: number, status: "error", message: "This row could not be read." });
      continue;
    }
    const ref = key(row.reference, FILE_LIMITS.referenceMax);
    const ext = key(row.externalId, FILE_LIMITS.externalIdMax);

    if (ext && seenExternalIds.has(ext)) {
      results.push({ row: number, status: "skipped", message: `Skipped: row ${seenExternalIds.get(ext)} has the same external ID (${ext}).` });
      continue;
    }
    if (ref && seenReferences.has(ref.toLowerCase())) {
      results.push({ row: number, status: "skipped", message: `Skipped: row ${seenReferences.get(ref.toLowerCase())} has the same reference (${ref}).` });
      continue;
    }
    if (ext && existing.externalIds.has(ext)) {
      results.push({ row: number, status: "skipped", message: `Skipped: a file with the external ID ${ext} already exists.` });
      continue;
    }
    if (ref && existing.references.has(ref.toLowerCase())) {
      results.push({ row: number, status: "skipped", message: `Skipped: a file with the reference ${ref} already exists.` });
      continue;
    }
    if (!ref && !ext) {
      // With nothing to identify the row, only an exact repeat is safe to call a duplicate:
      // one client can legitimately have several files.
      const signature = importSignature(row);
      const first = seenRows.get(signature);
      if (first !== undefined) {
        results.push({ row: number, status: "skipped", message: `Skipped: this row is identical to row ${first}.` });
        continue;
      }
      seenRows.set(signature, number);
    }

    try {
      const outcome = await createFile(actor, { ...row, clientName: row.clientName, clientEmail: row.clientEmail, source: "csv", send: false }, meta);
      if (!outcome.created) {
        results.push({ row: number, status: "skipped", message: "Skipped: this file already exists.", fileId: outcome.file.id, reference: outcome.file.reference });
        continue;
      }
      // Recorded only for rows that became files, so a failed row does not block a corrected repeat further down.
      if (ext) seenExternalIds.set(ext, number);
      if (ref) seenReferences.set(ref.toLowerCase(), number);
      const result: ImportRowResult = {
        row: number,
        status: "created",
        message: `Created file ${outcome.file.reference}.`,
        fileId: outcome.file.id,
        reference: outcome.file.reference,
        agreementSent: false,
      };
      results.push(result);
      created.push({ result, fileId: outcome.file.id });
    } catch (err) {
      if (err instanceof ServiceError) {
        results.push({ row: number, status: err.code === "conflict" ? "skipped" : "error", message: err.code === "conflict" ? `Skipped: ${err.message}` : err.message });
      } else {
        console.error("[files] import row failed", { row: number, error: err instanceof Error ? err.message : String(err) });
        results.push({ row: number, status: "error", message: "This row could not be saved. Import it again." });
      }
    }
  }

  if (!send) {
    for (const { result } of created) result.message = `Created file ${result.reference}. The agreement was not sent; send it from the file.`;
    return results;
  }

  // Every file exists before the first agreement goes out, so running out of time
  // here costs a click per unsent file, never a lost row.
  const requestedBudget = Number(options.sendBudgetMs);
  const budget = Number.isFinite(requestedBudget) && requestedBudget >= 0 ? requestedBudget : DEFAULT_SEND_BUDGET_MS;
  const deadline = Date.now() + budget;
  let blocked: string | null = null;
  for (const { result, fileId: createdId } of created) {
    if (blocked) {
      result.message = `Created file ${result.reference}. Agreement not sent: ${blocked}`;
      continue;
    }
    if (Date.now() >= deadline) {
      result.message = `Created file ${result.reference}. The agreement was not sent because the import ran out of time; send it from the file.`;
      continue;
    }
    const outcome = await trySend(actor, createdId, meta);
    if (outcome.sent) {
      result.agreementSent = true;
      result.message =
        outcome.delivery === "emailed"
          ? `Created file ${result.reference} and emailed the agreement.`
          : outcome.delivery === "email_failed"
            ? `Created file ${result.reference}. The agreement is ready but the email could not be delivered; copy the signing link from the file.`
            : `Created file ${result.reference}. The agreement is ready; copy the signing link from the file (email is not set up).`;
    } else {
      result.message = `Created file ${result.reference}. Agreement not sent: ${outcome.reason ?? GENERIC_SEND_FAILURE}`;
      if (outcome.orgWide) blocked = outcome.reason ?? GENERIC_SEND_FAILURE;
    }
  }
  return results;
}

/** Totals for the line above an import's row-by-row results. */
export function summarizeImport(results: readonly ImportRowResult[]): { created: number; skipped: number; errors: number; agreementsSent: number } {
  const summary = { created: 0, skipped: 0, errors: 0, agreementsSent: 0 };
  for (const r of results) {
    if (r.status === "created") summary.created++;
    else if (r.status === "skipped") summary.skipped++;
    else summary.errors++;
    if (r.agreementSent) summary.agreementsSent++;
  }
  return summary;
}
