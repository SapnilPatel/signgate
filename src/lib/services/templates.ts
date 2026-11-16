/**
 * Agreement templates: the document a company has every client sign.
 *
 * Owners and admins create and change templates; every member can read them. An API
 * key or the system counts as a manager, because only owners and admins can issue keys.
 * Sent envelopes hold their own snapshot of the PDF and fields, so nothing here can
 * change what a client was shown.
 */
import { deflateSync } from "node:zlib";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { getDb, type DbOrTx, type Tx } from "@/lib/db";
import { envelopes, orgs, templates, users, type Org, type Template } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { newId, newSecret } from "@/lib/ids";
import { DocumentError, detectFields, ingestDocument, ingestText, stampFields, type DetectionResult, type IngestResult } from "@/lib/pdf";
import { clampRect } from "@/lib/pdf/geometry";
// Not re-exported from the engine's index yet; imported from its module directly.
import { ingestPageImages } from "@/lib/pdf/ingest";
import { LIMITS, type DetectionMeta, type Field, type FieldRole, type FieldType, type FieldValues, type MergeKey, type OrgSettings, type PageInfo } from "@/lib/types";
import { cleanText, isSecretToken } from "@/lib/validation";
import { resolveSettings } from "./accounts";
import { deleteBlob, getBlob, putBlob } from "./blobs";
import { ServiceError, type Actor, type RequestMeta } from "./context";
import { recordEvent } from "./events";
import { clearRateLimit, rateLimit } from "./rate-limit";
import { completeUpload, discardUpload } from "./uploads";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export const TEMPLATE_LIMITS = {
  nameMax: 120,
  labelMax: 80,
  fieldIdMax: 80,
  customKeyMax: 60,
  /** Smallest field, as a fraction of the page, that can still hold a mark. Matches the detector's own floor. */
  minFieldWidth: 0.004,
  minFieldHeight: 0.003,
} as const;

export const FIELD_TYPES: readonly FieldType[] = ["signature", "initials", "date_signed", "full_name", "title", "company", "email", "text", "date", "checkbox"];
export const FIELD_ROLES: readonly FieldRole[] = ["prefill", "client", "company"];
export const FIXED_MERGE_KEYS: readonly MergeKey[] = [
  "client_name",
  "client_email",
  "client_company",
  "client_title",
  "client_phone",
  "file_reference",
  "file_description",
  "company_name",
  "today",
];
const FIELD_SOURCES: readonly Field["source"][] = ["detected", "manual", "appended", "form"];
/** Types a prefill field cannot have: these only exist at the moment someone signs. */
const SIGNING_ONLY_TYPES: readonly FieldType[] = ["signature", "initials", "date_signed"];

/**
 * A document the engine could not turn into a signable PDF. It is a ServiceError
 * (status 422, safe message) that also keeps the engine's own code, so the upload
 * page can offer to send pictures of the pages instead.
 */
export class DocumentServiceError extends ServiceError {
  constructor(
    public documentCode: DocumentError["code"],
    message: string,
  ) {
    super("invalid", message);
    this.name = "DocumentServiceError";
  }

  /** True when rendering the pages in the browser and uploading the pictures can still work. */
  get pageImageFallback(): boolean {
    return this.documentCode === "password_protected" || this.documentCode === "corrupt";
  }
}

export interface ReadinessProblem {
  code:
    | "no_document"
    | "no_client_signature"
    | "field_off_document"
    | "too_many_fields"
    | "prefill_unmapped"
    | "no_countersigner"
    | "countersigner_unavailable"
    | "countersigner_no_signature";
  message: string;
}

export interface Readiness {
  ready: boolean;
  problems: ReadinessProblem[];
}

/** The little that readiness needs to know about a team member. `Member` from accounts fits. */
export interface ReadinessMember {
  id: string;
  disabled: boolean;
  hasSignature: boolean;
  /** Needed to find the owner who countersigns when nobody has been chosen. */
  role?: "owner" | "admin" | "member";
}

export interface TemplateSummary extends Template {
  /** Envelopes from this agreement that went out for signature. */
  sentCount: number;
  /** Envelopes from this agreement that every party signed. */
  signedCount: number;
  readiness: Readiness;
}

export interface TemplatePdf {
  bytes: Uint8Array;
  filename: string;
  sha256: string;
}

export interface ArchiveResult {
  template: Template;
  wasDefault: boolean;
  /** True when this was the default agreement: new files no longer get an agreement
   *  sent automatically until another default is chosen. */
  automaticSendingStopped: boolean;
  /** Plain sentence to show the person who archived it. */
  message: string;
}

export interface IntakeLink {
  template: Template;
  token: string;
  url: string;
}

/** Where the public intake page lives. */
export const intakeUrl = (token: string) => `${env.appUrl}/intake/${token}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const megabytes = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

const notFound = () => new ServiceError("not_found", "That agreement could not be found. It may have been removed; go back to the list of agreements.");

function asId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) throw notFound();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Checks the caller against the stored user row: a role or disabled flag in a session can be minutes old. */
async function assertActor(db: DbOrTx, actor: Actor, need: "read" | "manage"): Promise<void> {
  if (!actor || typeof actor !== "object" || typeof actor.orgId !== "string" || !actor.orgId) {
    throw new ServiceError("forbidden", "Sign in to work with agreements.");
  }
  if (actor.type !== "user") return;
  const [user] = await db
    .select({ role: users.role, disabledAt: users.disabledAt })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.orgId, actor.orgId)))
    .limit(1);
  if (!user || user.disabledAt) {
    throw new ServiceError("forbidden", "Your account is no longer active. Ask an owner of your company account for access.");
  }
  if (need === "manage" && user.role !== "owner" && user.role !== "admin") {
    throw new ServiceError("forbidden", "Only an owner or admin can change agreements. Ask one of them to make this change.");
  }
}

async function loadOrg(db: DbOrTx, orgId: string): Promise<Org> {
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
  if (!org) throw new ServiceError("forbidden", "Your company account could not be found. Sign in again.");
  return org;
}

/** Row lock on the company: serializes changes to which agreement is the default. */
async function lockOrg(tx: Tx, orgId: string): Promise<Org> {
  const [org] = await tx.select().from(orgs).where(eq(orgs.id, orgId)).for("update");
  if (!org) throw new ServiceError("forbidden", "Your company account could not be found. Sign in again.");
  return org;
}

async function loadTemplate(db: DbOrTx, orgId: string, id: unknown): Promise<Template> {
  const [row] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.id, asId(id)), eq(templates.orgId, orgId)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

async function loadReadinessMembers(db: DbOrTx, orgId: string): Promise<ReadinessMember[]> {
  // The signature image itself can be hundreds of kilobytes per person; only ask whether it exists.
  const rows = await db
    .select({ id: users.id, role: users.role, disabledAt: users.disabledAt, hasSignature: sql<boolean>`${users.savedSignature} is not null` })
    .from(users)
    .where(eq(users.orgId, orgId))
    // Oldest first, so "the owner" is the same person every time when there are several.
    .orderBy(asc(users.createdAt), asc(users.id));
  return rows.map((r) => ({ id: r.id, role: r.role, disabled: r.disabledAt !== null, hasSignature: Boolean(r.hasSignature) }));
}

function companyNameOf(org: Org): string {
  return org.name;
}

function templateName(value: unknown, fallback: unknown): string {
  return cleanText(value, TEMPLATE_LIMITS.nameMax) || cleanText(fallback, TEMPLATE_LIMITS.nameMax) || "Client agreement";
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

function parseVersion(value: unknown): number {
  const n = typeof value === "string" && /^\d{1,9}$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
    throw new ServiceError("invalid", "The agreement's version is missing. Reload the page and make your change again.");
  }
  return n;
}

const versionConflict = () =>
  new ServiceError("conflict", "Someone else changed this agreement while you were working on it. Reload the page to see their changes, then make yours again.");

function toDocumentError(err: unknown): never {
  if (err instanceof ServiceError) throw err;
  if (err instanceof DocumentError) throw new DocumentServiceError(err.code, err.message);
  throw new DocumentServiceError("corrupt", "This document could not be read. Save it again as a PDF, or print it to PDF, and upload that copy.");
}

// ---------------------------------------------------------------------------
// Ingest and detection
// ---------------------------------------------------------------------------

interface Prepared {
  pdf: Uint8Array;
  pages: PageInfo[];
  fields: Field[];
  detection: DetectionMeta;
  title: string;
}

/** Field output of the engine, trimmed to what the editor will accept back unchanged. */
function tidyDetected(fields: Field[]): Field[] {
  const seen = new Set<string>();
  const out: Field[] = [];
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f || typeof f !== "object") continue;
    let id = typeof f.id === "string" && FIELD_ID.test(f.id) ? f.id : newId("fld");
    if (seen.has(id)) id = newId("fld");
    seen.add(id);
    const label = cleanText(f.label, TEMPLATE_LIMITS.labelMax) || defaultLabel(f.role, f.type);
    const next: Field = { ...f, id, label };
    if (next.role !== "prefill") delete next.mergeKey;
    out.push(next);
    if (out.length >= LIMITS.maxFieldsPerTemplate) break;
  }
  return out;
}

async function prepare(org: Org, ingest: () => Promise<IngestResult>): Promise<Prepared & { ingested: IngestResult }> {
  let ingested: IngestResult;
  try {
    ingested = await ingest();
  } catch (err) {
    toDocumentError(err);
  }
  let detected: DetectionResult;
  try {
    detected = await detectFields(ingested.pdf, { formFields: ingested.formFields, companyName: companyNameOf(org) });
  } catch (err) {
    toDocumentError(err);
  }
  if (detected.pdf.byteLength > LIMITS.maxUploadBytes) {
    throw new DocumentServiceError(
      "too_large",
      `Once prepared for signing this document is ${megabytes(detected.pdf.byteLength)}, which is over the ${megabytes(LIMITS.maxUploadBytes)} limit. Save a smaller copy (for example with "Reduce file size", or scanned at a lower resolution) and upload again.`,
    );
  }
  // Ingest warnings ("converted from Word, check the layout") belong next to the
  // detector's own notes, so the editor shows them every time, not just after upload.
  const notes: string[] = [];
  for (const note of [...(ingested.warnings ?? []), ...(detected.meta?.notes ?? [])]) {
    const text = cleanText(note, 500);
    if (text && !notes.includes(text)) notes.push(text);
  }
  return {
    ingested,
    pdf: detected.pdf,
    pages: detected.pages,
    fields: tidyDetected(detected.fields),
    detection: { ...detected.meta, notes },
    title: ingested.title,
  };
}

interface SourceFile {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

/** Stores the original and the prepared PDF; one blob when they are byte-identical. */
async function storeDocument(tx: Tx, orgId: string, name: string, source: SourceFile, pdf: Uint8Array) {
  const pdfBlob = await putBlob(tx, { orgId, bytes: pdf, contentType: "application/pdf", filename: `${name}.pdf` });
  if (sameBytes(source.bytes, pdf)) return { pdfBlobId: pdfBlob.id, sourceBlobId: pdfBlob.id };
  const sourceBlob = await putBlob(tx, { orgId, bytes: source.bytes, contentType: source.contentType, filename: source.filename });
  return { pdfBlobId: pdfBlob.id, sourceBlobId: sourceBlob.id };
}

async function insertTemplate(actor: Actor, org: Org, prepared: Prepared, name: string, source: SourceFile, kind: string, meta?: RequestMeta): Promise<Template> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const blobs = await storeDocument(tx, org.id, name, source, prepared.pdf);
    const [row] = await tx
      .insert(templates)
      .values({
        id: newId("tpl"),
        orgId: org.id,
        name,
        status: "draft",
        isDefault: false,
        sourceBlobId: blobs.sourceBlobId,
        pdfBlobId: blobs.pdfBlobId,
        pages: prepared.pages,
        fields: prepared.fields,
        detection: prepared.detection,
        createdBy: actor.type === "user" ? actor.userId : null,
      })
      .returning();
    await recordEvent(tx, {
      orgId: org.id,
      type: "template.created",
      actor,
      meta,
      data: {
        templateId: row.id,
        templateName: name,
        kind,
        pages: prepared.pages.length,
        count: prepared.fields.length,
        method: prepared.detection.method,
        signaturePageAppended: prepared.detection.signaturePageAppended,
      },
    });
    return row;
  });
}

/**
 * Create a draft agreement from an uploaded file of any supported kind. Fields are
 * detected straight away; the result always has somewhere for the client to sign.
 * Throws DocumentServiceError when the file cannot be used.
 */
export async function createTemplateFromUpload(
  actor: Actor,
  input: { bytes: unknown; filename?: unknown; mimeType?: unknown; name?: unknown },
  meta?: RequestMeta,
): Promise<Template> {
  const db = await getDb();
  await assertActor(db, actor, "manage");
  const org = await loadOrg(db, actor.orgId);
  const raw = asRecord(input);
  const bytes = toBytes(raw.bytes);
  if (!bytes || bytes.byteLength === 0) {
    throw new DocumentServiceError("empty", "The file is empty. Choose a file that has content and upload it again.");
  }
  const base = typeof raw.filename === "string" ? (raw.filename.split(/[\\/]/).pop() ?? "") : "";
  const filename = cleanText(base, 150) || "agreement";
  const mimeType = typeof raw.mimeType === "string" ? cleanText(raw.mimeType, 100).toLowerCase() || "application/octet-stream" : "application/octet-stream";

  const prepared = await prepare(org, () => ingestDocument({ bytes, filename, mimeType }));
  const name = templateName(raw.name, prepared.title || filename.replace(/\.[a-z0-9]{1,6}$/i, ""));
  return insertTemplate(actor, org, prepared, name, { bytes, contentType: mimeType, filename }, prepared.ingested.sourceKind, meta);
}

/**
 * Finish a chunked upload and create the draft agreement from it, as one step that
 * is safe to repeat. The uploaded parts are only removed after the agreement is
 * stored, so if this times out or its response is lost the same call works again
 * without a new upload. A second call while the first is still working is turned
 * away, so a double click cannot create two agreements.
 */
export async function createTemplateFromCompletedUpload(actor: Actor, uploadId: unknown, input: { name?: unknown } = {}, meta?: RequestMeta): Promise<Template> {
  const upload = await completeUpload(actor, uploadId);
  const claimKey = `upload:finish:${upload.id}`;
  const claim = await rateLimit(claimKey, 1, 120);
  if (!claim.ok) {
    throw new ServiceError("conflict", "This upload is already being turned into an agreement. Wait a moment, then check your list of agreements.");
  }
  let template: Template;
  try {
    template = await createTemplateFromUpload(actor, { bytes: upload.bytes, filename: upload.filename, mimeType: upload.mimeType, name: asRecord(input).name }, meta);
  } catch (err) {
    // The parts are still there, so the person can try again straight away (for example as page images).
    await clearRateLimit(claimKey);
    throw err;
  }
  try {
    await discardUpload(actor, uploadId);
  } catch (err) {
    // The agreement exists; leftover parts are removed by the scheduler.
    console.error("[templates] could not discard a finished upload", err instanceof Error ? err.message : err);
  }
  return template;
}

/** Create a draft agreement from text someone pasted in. */
export async function createTemplateFromText(actor: Actor, input: { text: unknown; name?: unknown }, meta?: RequestMeta): Promise<Template> {
  const db = await getDb();
  await assertActor(db, actor, "manage");
  const org = await loadOrg(db, actor.orgId);
  const raw = asRecord(input);
  if (typeof raw.text !== "string" || raw.text.trim() === "") {
    throw new DocumentServiceError("empty", "There is no agreement text yet. Paste the wording of your agreement and try again.");
  }
  const text = raw.text;
  if (text.length > LIMITS.maxUploadBytes) {
    throw new DocumentServiceError("too_large", "That is more text than an agreement can hold here. Paste just the agreement, or upload it as a file instead.");
  }
  const wanted = cleanText(raw.name, TEMPLATE_LIMITS.nameMax);
  const prepared = await prepare(org, () => ingestText(text, wanted || "Client agreement"));
  const name = templateName(wanted, prepared.title);
  const source: SourceFile = { bytes: new Uint8Array(Buffer.from(text, "utf8")), contentType: "text/plain; charset=utf-8", filename: `${name}.txt` };
  return insertTemplate(actor, org, prepared, name, source, "text", meta);
}

/**
 * Create a draft agreement from pictures of each page. This is the fallback for a
 * PDF the server cannot open (locked or damaged): the browser renders the pages and
 * sends them here. There is no text to read, so fields usually need placing by hand.
 */
export async function createTemplateFromPageImages(actor: Actor, input: { images: unknown; name?: unknown }, meta?: RequestMeta): Promise<Template> {
  const db = await getDb();
  await assertActor(db, actor, "manage");
  const org = await loadOrg(db, actor.orgId);
  const raw = asRecord(input);
  const list = Array.isArray(raw.images) ? raw.images : [];
  const images = list.map((item) => {
    const r = asRecord(item);
    return { bytes: toBytes(r.bytes) ?? new Uint8Array(0), widthPt: Number(r.widthPt), heightPt: Number(r.heightPt) };
  });
  const wanted = cleanText(raw.name, TEMPLATE_LIMITS.nameMax);
  const prepared = await prepare(org, () => ingestPageImages(images, wanted || "Client agreement"));
  const name = templateName(wanted, prepared.title);
  // There is no single original file. The page PDF as built, before any signature page
  // was added, is kept as the source so detection can be run again from a clean copy.
  const source: SourceFile = { bytes: prepared.ingested.pdf, contentType: "application/pdf", filename: `${name}.pdf` };
  return insertTemplate(actor, org, prepared, name, source, "page_images", meta);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getTemplate(actor: Actor, id: unknown): Promise<Template> {
  const db = await getDb();
  await assertActor(db, actor, "read");
  return loadTemplate(db, actor.orgId, id);
}

const STATUS_ORDER: Record<Template["status"], number> = { active: 0, draft: 1, archived: 2 };

/** Every agreement of the caller's company: the default first, then active, drafts, archived. */
export async function listTemplates(actor: Actor): Promise<TemplateSummary[]> {
  const db = await getDb();
  await assertActor(db, actor, "read");
  const org = await loadOrg(db, actor.orgId);
  const rows = await db.select().from(templates).where(eq(templates.orgId, actor.orgId));
  const counts = await db
    .select({
      templateId: envelopes.templateId,
      // An envelope has a working link from the moment it exists, emailed or shared by hand.
      // One that was voided before it ever reached the client does not count as sent.
      sent: sql<number>`(count(*) filter (where ${envelopes.sentAt} is not null or ${envelopes.status} <> 'voided'))::int`,
      signed: sql<number>`(count(*) filter (where ${envelopes.status} = 'completed'))::int`,
    })
    .from(envelopes)
    .where(eq(envelopes.orgId, actor.orgId))
    .groupBy(envelopes.templateId);
  const byTemplate = new Map(counts.map((c) => [c.templateId, c]));
  const members = await loadReadinessMembers(db, actor.orgId);
  return rows
    .map((t) => ({
      ...t,
      sentCount: Number(byTemplate.get(t.id)?.sent ?? 0),
      signedCount: Number(byTemplate.get(t.id)?.signed ?? 0),
      readiness: templateReadiness(t, org, members),
    }))
    .sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) || STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.updatedAt.getTime() - a.updatedAt.getTime() || a.name.localeCompare(b.name),
    );
}

function downloadName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return `${base || "Agreement"}.pdf`;
}

/** The unsigned PDF that fields are positioned against. */
export async function getTemplatePdf(actor: Actor, id: unknown): Promise<TemplatePdf> {
  const db = await getDb();
  await assertActor(db, actor, "read");
  const template = await loadTemplate(db, actor.orgId, id);
  const blob = await getBlob(actor.orgId, template.pdfBlobId, db);
  if (!blob) throw new ServiceError("not_found", "The document for this agreement is missing. Upload the agreement again.");
  return { bytes: new Uint8Array(blob.bytes), filename: downloadName(template.name), sha256: blob.sha256 };
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

const FIELD_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const CUSTOM_KEY = /^[A-Za-z0-9_.-]+$/;

const TYPE_WORDS: Record<FieldType, string> = {
  signature: "signature",
  initials: "initials",
  date_signed: "date signed",
  full_name: "name",
  title: "title",
  company: "company",
  email: "email",
  text: "text",
  date: "date",
  checkbox: "checkbox",
};

function defaultLabel(role: unknown, type: unknown): string {
  const what = TYPE_WORDS[type as FieldType] ?? "field";
  if (role === "client") return `Client ${what}`;
  if (role === "company") return `Company ${what}`;
  return `${what.charAt(0).toUpperCase()}${what.slice(1)}`;
}

/** Whether a string can be stored as a prefill field's merge key. */
export function isValidMergeKey(value: unknown): value is MergeKey {
  if (typeof value !== "string") return false;
  if ((FIXED_MERGE_KEYS as readonly string[]).includes(value)) return true;
  if (!value.startsWith("custom:")) return false;
  const key = value.slice("custom:".length);
  return key.length >= 1 && key.length <= TEMPLATE_LIMITS.customKeyMax && CUSTOM_KEY.test(key);
}

/**
 * Turns whatever the editor posted into fields that are safe to store, or throws one
 * ServiceError listing what is wrong. Geometry that hangs slightly off the page is
 * pulled back on, as happens when a box is dragged to an edge; anything else that is
 * wrong is reported, never silently changed.
 */
function validateFields(input: unknown, pages: PageInfo[]): Field[] {
  if (!Array.isArray(input)) {
    throw new ServiceError("invalid", "The fields could not be read. Reload the page and try again.", { fields: "Expected a list of fields." });
  }
  if (input.length > LIMITS.maxFieldsPerTemplate) {
    throw new ServiceError(
      "invalid",
      `An agreement can have at most ${LIMITS.maxFieldsPerTemplate} fields; this one has ${input.length}. Remove the ones that are not needed.`,
      { fields: "Too many fields." },
    );
  }
  const pageCount = Array.isArray(pages) ? pages.length : 0;
  const problems: Record<string, string> = {};
  let first = "";
  const out: Field[] = [];
  const seen = new Set<string>();

  input.forEach((item, index) => {
    const raw = asRecord(item);
    const shownLabel = typeof raw.label === "string" ? cleanText(raw.label, 40) : "";
    const who = shownLabel ? `Field ${index + 1} ("${shownLabel}")` : `Field ${index + 1}`;
    let ok = true;
    const fail = (prop: string, message: string) => {
      ok = false;
      const key = `fields.${index}.${prop}`;
      if (!(key in problems) && Object.keys(problems).length < 50) problems[key] = message;
      if (!first) first = `${who}: ${message}`;
    };

    if (!isRecord(item)) {
      fail("field", "is not a field. Remove it and add it again.");
      return;
    }

    let id: string;
    if (raw.id === undefined || raw.id === null || raw.id === "") id = newId("fld");
    else if (typeof raw.id === "string" && FIELD_ID.test(raw.id)) id = raw.id;
    else {
      fail("id", "has an id that is not valid. Remove the field and add it again.");
      id = "";
    }
    if (id && seen.has(id)) fail("id", "has the same id as another field. Remove one of them and add it again.");
    if (id) seen.add(id);

    const type = raw.type as FieldType;
    if (typeof raw.type !== "string" || !FIELD_TYPES.includes(type)) fail("type", "has a kind of field that is not supported. Choose one from the list.");
    const role = raw.role as FieldRole;
    if (typeof raw.role !== "string" || !FIELD_ROLES.includes(role)) fail("role", "needs to say who fills it in: the client, your company, or filled automatically.");

    const page = raw.page;
    if (typeof page !== "number" || !Number.isInteger(page) || page < 0 || page >= pageCount) {
      fail("page", pageCount > 0 ? `is on a page that does not exist. This agreement has ${pageCount} ${pageCount === 1 ? "page" : "pages"}.` : "cannot be placed because the agreement has no pages.");
    }

    const nums = [raw.x, raw.y, raw.w, raw.h];
    let rect = { x: 0, y: 0, w: 0, h: 0 };
    if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) {
      fail("geometry", "has no position or size. Remove it and place it again.");
    } else {
      const [x, y, w, h] = nums as number[];
      if (w <= 0 || h <= 0) fail("geometry", "has no width or height. Resize it or remove it.");
      else if (x >= 1 || y >= 1 || x + w <= 0 || y + h <= 0) fail("geometry", "is outside the page. Move it onto the page or remove it.");
      else {
        // Keep the part that is on the page, then make sure it lies fully inside.
        const left = Math.max(0, x);
        const top = Math.max(0, y);
        rect = clampRect({ x: left, y: top, w: Math.min(x + w, 1) - left, h: Math.min(y + h, 1) - top });
        if (rect.w < TEMPLATE_LIMITS.minFieldWidth || rect.h < TEMPLATE_LIMITS.minFieldHeight) {
          fail("geometry", "is too small to hold anything. Make it bigger or remove it.");
        }
      }
    }

    let label = "";
    if (raw.label !== undefined && raw.label !== null && typeof raw.label !== "string") fail("label", "has a label that is not text.");
    else {
      label = cleanText(raw.label, 10_000);
      if (label.length > TEMPLATE_LIMITS.labelMax) fail("label", `has a label longer than ${TEMPLATE_LIMITS.labelMax} characters. Shorten it.`);
      if (!label) label = defaultLabel(role, type);
    }

    if (raw.required !== undefined && typeof raw.required !== "boolean") fail("required", "must be either required or optional.");
    const required = raw.required === true;

    let mergeKey: MergeKey | undefined;
    const hasKey = raw.mergeKey !== undefined && raw.mergeKey !== null && raw.mergeKey !== "";
    if (role === "prefill") {
      if (SIGNING_ONLY_TYPES.includes(type)) fail("role", `is a ${TYPE_WORDS[type]} field, which only a person signing can fill in. Give it to the client or your company.`);
      if (!hasKey) fail("mergeKey", "is filled automatically but does not say from what. Choose which file detail goes here.");
      else if (!isValidMergeKey(raw.mergeKey)) fail("mergeKey", "is linked to a file detail that is not recognised. Choose one from the list; a custom detail may use letters, numbers, dots, dashes and underscores.");
      else mergeKey = raw.mergeKey;
    } else if (hasKey) {
      fail("mergeKey", "is linked to a file detail, which only works for fields that are filled automatically. Remove the link or change who fills the field in.");
    }

    const source = FIELD_SOURCES.includes(raw.source as Field["source"]) ? (raw.source as Field["source"]) : "manual";

    if (!ok) return;
    const field: Field = { id, page: page as number, ...rect, type, role, required, label, source };
    if (mergeKey) field.mergeKey = mergeKey;
    if (source !== "manual" && typeof raw.confidence === "number" && Number.isFinite(raw.confidence)) {
      field.confidence = Math.min(1, Math.max(0, raw.confidence));
    }
    out.push(field);
  });

  if (first) throw new ServiceError("invalid", first, problems);
  return out;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

function listLabels(fields: Field[]): string {
  const names = fields.slice(0, 3).map((f) => `"${cleanText(f?.label, 40) || "Unnamed field"}"`);
  return fields.length > 3 ? `${names.join(", ")} and ${fields.length - 3} more` : names.join(", ");
}

/**
 * Who signs for the company, by the one rule every path uses (activation, the
 * readiness badge, sending from the app, the API, imports and the intake link):
 * the person chosen in Settings, or the company's owner when nobody is chosen.
 * A chosen person who is no longer active is a problem to fix, never a silent swap.
 */
export function resolveCountersigner<M extends ReadinessMember>(
  settings: Pick<OrgSettings, "countersignerUserId" | "countersignMode"> | null | undefined,
  members: readonly M[] | null | undefined,
): { member: M | null; problem: ReadinessProblem | null } {
  const team = (members ?? []).filter((m): m is M => Boolean(m) && typeof m === "object");
  const chosenId = typeof settings?.countersignerUserId === "string" ? settings.countersignerUserId : "";
  let member: M | null = null;
  if (chosenId) {
    member = team.find((m) => m.id === chosenId && !m.disabled) ?? null;
    if (!member) {
      return {
        member: null,
        problem: {
          code: "countersigner_unavailable",
          message: "The person chosen to countersign is no longer an active member of your team. Choose another countersigner in Settings.",
        },
      };
    }
  } else {
    member = team.find((m) => m.role === "owner" && !m.disabled) ?? null;
    if (!member) {
      return {
        member: null,
        problem: {
          code: "no_countersigner",
          message: "This agreement has fields for your company to sign, but nobody is chosen to countersign. Choose a countersigner in Settings, or remove the company fields.",
        },
      };
    }
  }
  if (settings?.countersignMode === "auto" && !member.hasSignature) {
    return {
      member,
      problem: {
        code: "countersigner_no_signature",
        message: chosenId
          ? "Countersigning is set to automatic, but the countersigner has no saved signature. Have them save a signature in their profile, or switch countersigning to manual in Settings."
          : "Countersigning is set to automatic, but the owner, who countersigns when nobody else is chosen, has no saved signature. Save a signature in the owner's profile, choose a countersigner in Settings, or switch countersigning to manual.",
      },
    };
  }
  return { member, problem: null };
}

/**
 * Whether an agreement can be sent right now, and if not, what to fix. Checked before
 * activation and again before every send, because team and settings changes after
 * activation (the countersigner leaving, a signature being cleared) can break it.
 * Pure and synchronous. Does not look at the template's status; callers decide whether
 * a draft or archived agreement may be sent.
 */
export function templateReadiness(
  template: { fields?: Field[] | null; pages?: PageInfo[] | null },
  org: { settings?: OrgSettings | null } | null | undefined,
  members: readonly ReadinessMember[] | null | undefined,
): Readiness {
  const problems: ReadinessProblem[] = [];
  const pages = Array.isArray(template?.pages) ? template.pages : [];
  const fields = (Array.isArray(template?.fields) ? template.fields : []).filter((f): f is Field => Boolean(f) && typeof f === "object");

  if (pages.length === 0) {
    problems.push({ code: "no_document", message: "This agreement has no pages. Replace the document with a new upload." });
  }
  if (fields.length > LIMITS.maxFieldsPerTemplate) {
    problems.push({
      code: "too_many_fields",
      message: `This agreement has ${fields.length} fields; the most it can have is ${LIMITS.maxFieldsPerTemplate}. Remove the ones that are not needed.`,
    });
  }

  const clientSignatures = fields.filter((f) => f.role === "client" && f.type === "signature");
  if (clientSignatures.length === 0) {
    problems.push({ code: "no_client_signature", message: "There is nowhere for the client to sign. Add a client signature field to the agreement." });
  } else if (!clientSignatures.some((f) => f.required === true)) {
    problems.push({
      code: "no_client_signature",
      message: "The client signature is optional, so a client could finish without signing. Mark at least one client signature field as required.",
    });
  }

  if (pages.length > 0) {
    const off = fields.filter((f) => !Number.isInteger(f.page) || f.page < 0 || f.page >= pages.length);
    if (off.length > 0) {
      problems.push({
        code: "field_off_document",
        message: `${off.length === 1 ? "A field is" : `${off.length} fields are`} on a page this document does not have (${listLabels(off)}). Remove ${off.length === 1 ? "it" : "them"} or detect the fields again.`,
      });
    }
  }

  const unmapped = fields.filter((f) => f.role === "prefill" && !isValidMergeKey(f.mergeKey));
  if (unmapped.length > 0) {
    problems.push({
      code: "prefill_unmapped",
      message: `${unmapped.length === 1 ? "A field that is filled automatically does" : `${unmapped.length} fields that are filled automatically do`} not say which file detail to use (${listLabels(unmapped)}). Choose a detail for ${unmapped.length === 1 ? "it" : "each"}, or have the client fill ${unmapped.length === 1 ? "it" : "them"} in.`,
    });
  }

  if (fields.some((f) => f.role === "company")) {
    const { problem } = resolveCountersigner(resolveSettings(org), members);
    if (problem) problems.push(problem);
  }

  return { ready: problems.length === 0, problems };
}

/** templateReadiness for a stored agreement, with the company and team loaded for you. */
export async function getTemplateReadiness(actor: Actor, id: unknown): Promise<Readiness> {
  const db = await getDb();
  await assertActor(db, actor, "read");
  const template = await loadTemplate(db, actor.orgId, id);
  return templateReadiness(template, await loadOrg(db, actor.orgId), await loadReadinessMembers(db, actor.orgId));
}

function notReady(readiness: Readiness, lead: string): ServiceError {
  const fields: Record<string, string> = {};
  for (const p of readiness.problems) if (!(p.code in fields)) fields[p.code] = p.message;
  return new ServiceError("not_ready", `${lead} ${readiness.problems[0]?.message ?? ""}`.trim(), fields);
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/**
 * Replace an agreement's fields. `expectedVersion` is the version the editor loaded;
 * if anyone saved in the meantime the call fails with "conflict" instead of
 * overwriting their work.
 */
export async function updateTemplateFields(actor: Actor, id: unknown, fields: unknown, expectedVersion: unknown, meta?: RequestMeta): Promise<Template> {
  const db = await getDb();
  await assertActor(db, actor, "manage");
  const expected = parseVersion(expectedVersion);

  return db.transaction(async (tx) => {
    const current = await loadTemplate(tx, actor.orgId, id);
    if (current.version !== expected) throw versionConflict();
    const next = validateFields(fields, current.pages);

    if (current.status === "active") {
      // An agreement in use must stay sendable: a save that breaks it would silently
      // stop agreements going out on new files. If it was already broken for another
      // reason, saving is still allowed so it can be fixed in steps.
      const org = await loadOrg(tx, actor.orgId);
      const members = await loadReadinessMembers(tx, actor.orgId);
      const before = templateReadiness(current, org, members);
      const after = templateReadiness({ fields: next, pages: current.pages }, org, members);
      if (before.ready && !after.ready) {
        throw notReady(after, "This agreement is in use, so it has to stay ready to send.");
      }
    }

    const [row] = await tx
      .update(templates)
      .set({ fields: next, version: sql`${templates.version} + 1`, updatedAt: new Date() })
      .where(and(eq(templates.id, current.id), eq(templates.orgId, actor.orgId), eq(templates.version, expected)))
      .returning();
    if (!row) throw versionConflict();
    await recordEvent(tx, {
      orgId: actor.orgId,
      type: "template.fields_updated",
      actor,
      meta,
      data: { templateId: row.id, templateName: row.name, version: row.version, count: next.length },
    });
    return row;
  });
}

export async function renameTemplate(actor: Actor, id: unknown, name: unknown, meta?: RequestMeta): Promise<Template> {
  const db = await getDb();
  await assertActor(db, actor, "manage");
  const cleaned = cleanText(name, 10_000);
  if (!cleaned) throw new ServiceError("invalid", "Give the agreement a name.", { name: "Give the agreement a name." });
  if (cleaned.length > TEMPLATE_LIMITS.nameMax) {
    const message = `Keep the name to ${TEMPLATE_LIMITS.nameMax} characters or fewer.`;
    throw new ServiceError("invalid", message, { name: message });
  }
  return db.transaction(async (tx) => {
    const current = await loadTemplate(tx, actor.orgId, id);
    if (current.name === cleaned) return current;
    const [row] = await tx
      .update(templates)
      .set({ name: cleaned, updatedAt: new Date() })
      .where(and(eq(templates.id, current.id), eq(templates.orgId, actor.orgId)))
      .returning();
    if (!row) throw notFound();
    await recordEvent(tx, { orgId: actor.orgId, type: "template.renamed", actor, meta, data: { templateId: row.id, templateName: cleaned, previousName: current.name } });
    return row;
  });
}

/** A new draft with the same document and fields. The copy shares the stored PDF, which is immutable. */
export async function duplicateTemplate(actor: Actor, id: unknown, name?: unknown, meta?: RequestMeta): Promise<Template> {
  const db = await getDb();
  await assertActor(db, actor, "manage");
  return db.transaction(async (tx) => {
    const current = await loadTemplate(tx, actor.orgId, id);
    const copyName = cleanText(name, TEMPLATE_LIMITS.nameMax) || cleanText(`Copy of ${current.name}`, TEMPLATE_LIMITS.nameMax);
    const [row] = await tx
      .insert(templates)
      .values({
        id: newId("tpl"),
        orgId: actor.orgId,
        name: copyName,
        status: "draft",
        isDefault: false,
        sourceBlobId: current.sourceBlobId,
        pdfBlobId: current.pdfBlobId,
        pages: current.pages,
        fields: current.fields,
        detection: current.detection,
        createdBy: actor.type === "user" ? actor.userId : null,
      })
      .returning();
    await recordEvent(tx, { orgId: actor.orgId, type: "template.duplicated", actor, meta, data: { templateId: row.id, templateName: row.name, fromTemplateId: current.id, fromName: current.name } });
    return row;
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Put an agreement into use. It must be ready to send. When the company has no other
 * active agreement, this one becomes the default, so new files start getting it.
 */
export async function activateTemplate(actor: Actor, id: unknown, meta?: RequestMeta): Promise<{ template: Template; becameDefault: boolean }> {
  const db = await getDb();
  await assertActor(db, actor, "manage");
  return db.transaction(async (tx) => {
    const org = await lockOrg(tx, actor.orgId);
    const current = await loadTemplate(tx, actor.orgId, id);
    if (current.status === "active") return { template: current, becameDefault: false };
    const readiness = templateReadiness(current, org, await loadReadinessMembers(tx, actor.orgId));
    if (!readiness.ready) throw notReady(readiness, "This agreement is not ready to use yet.");

    const others = await tx
      .select({ id: templates.id })
      .from(templates)
      .where(and(eq(templates.orgId, actor.orgId), eq(templates.status, "active"), ne(templates.id, current.id)))
      .limit(1);
    const becameDefault = others.length === 0;
    if (becameDefault) {
      await tx.update(templates).set({ isDefault: false }).where(and(eq(templates.orgId, actor.orgId), eq(templates.isDefault, true)));
    }
    const [row] = await tx
      .update(templates)
      .set({ status: "active", isDefault: becameDefault, updatedAt: new Date() })
      .where(and(eq(templates.id, current.id), eq(templates.orgId, actor.orgId)))
      .returning();
    if (!row) throw notFound();
    await recordEvent(tx, { orgId: actor.orgId, type: "template.activated", actor, meta, data: { templateId: row.id, templateName: row.name, version: row.version, becameDefault } });
    return { template: row, becameDefault };
  });
}

/** Choose the agreement that is sent automatically on new files. Exactly one per company. */
export async function setDefaultTemplate(actor: Actor, id: unknown, meta?: RequestMeta): Promise<Template> {
  const db = await getDb();
  await assertActor(db, actor, "manage");
  return db.transaction(async (tx) => {
    // The lock makes "clear the old default, set the new one" atomic against a second
    // person choosing a different default at the same moment.
    const org = await lockOrg(tx, actor.orgId);
    const current = await loadTemplate(tx, actor.orgId, id);
    if (current.status !== "active") {
      throw new ServiceError(
        "not_ready",
        current.status === "archived"
          ? "This agreement is archived. Activate it again before making it the default."
          : "This agreement is still a draft. Activate it before making it the default.",
      );
    }
    const readiness = templateReadiness(current, org, await loadReadinessMembers(tx, actor.orgId));
    if (!readiness.ready) throw notReady(readiness, "This agreement cannot be the default until it is ready to send.");
    if (current.isDefault) return current;

    const previous = await tx
      .update(templates)
      .set({ isDefault: false })
      .where(and(eq(templates.orgId, actor.orgId), eq(templates.isDefault, true), ne(templates.id, current.id)))
      .returning({ id: templates.id, name: templates.name });
    const [row] = await tx
      .update(templates)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(and(eq(templates.id, current.id), eq(templates.orgId, actor.orgId), eq(templates.status, "active")))
      .returning();
    if (!row) throw notFound();
    await recordEvent(tx, {
      orgId: actor.orgId,
      type: "template.default_changed",
      actor,
      meta,
      data: { templateId: row.id, templateName: row.name, previousTemplateId: previous[0]?.id ?? null, previousName: previous[0]?.name ?? null },
    });
    return row;
  });
}

/**
 * Take an agreement out of use. Envelopes already sent carry their own copy and are
 * not affected. If it was the default, nothing replaces it automatically: the result
 * says that automatic sending has stopped.
 */
export async function archiveTemplate(actor: Actor, id: unknown, meta?: RequestMeta): Promise<ArchiveResult> {
  const db = await getDb();
  await assertActor(db, actor, "manage");
  return db.transaction(async (tx) => {
    await lockOrg(tx, actor.orgId);
    const current = await loadTemplate(tx, actor.orgId, id);
    if (current.status === "archived") {
      return { template: current, wasDefault: false, automaticSendingStopped: false, message: `"${current.name}" is already archived.` };
    }
    const wasDefault = current.isDefault;
    const hadIntakeLink = current.intakeToken !== null;
    const [row] = await tx
      .update(templates)
      // The public intake link must stop working along with everything else.
      .set({ status: "archived", isDefault: false, intakeToken: null, updatedAt: new Date() })
      .where(and(eq(templates.id, current.id), eq(templates.orgId, actor.orgId)))
      .returning();
    if (!row) throw notFound();
    await recordEvent(tx, {
      orgId: actor.orgId,
      type: "template.archived",
      actor,
      meta,
      data: { templateId: row.id, templateName: row.name, wasDefault, intakeLinkDisabled: hadIntakeLink },
    });
    const parts = [
      wasDefault
        ? `"${row.name}" is archived. It was the agreement sent automatically on new files, so automatic sending has stopped. Choose another default agreement to start it again.`
        : `"${row.name}" is archived. Agreements already sent from it are not affected.`,
    ];
    if (hadIntakeLink) parts.push("Its client intake link no longer works.");
    return { template: row, wasDefault, automaticSendingStopped: wasDefault, message: parts.join(" ") };
  });
}

// ---------------------------------------------------------------------------
// Re-detection and document replacement
// ---------------------------------------------------------------------------

/** Removes blobs an agreement no longer points at. A blob that a sent envelope or a
 *  copied agreement still uses is protected by its foreign key and simply stays. */
async function discardBlobs(orgId: string, ids: (string | null)[], keep: (string | null)[]): Promise<void> {
  for (const id of new Set(ids)) {
    if (!id || keep.includes(id)) continue;
    try {
      await deleteBlob(orgId, id);
    } catch {
      // Still referenced, or the database is briefly unavailable. Either way the
      // change that was asked for has already been saved.
    }
  }
}

/** Swaps in a newly prepared document, guarded by the version read before the slow work began. */
async function applyPrepared(
  actor: Actor,
  current: Template,
  prepared: Prepared,
  source: SourceFile | null,
  eventType: string,
  meta: RequestMeta | undefined,
): Promise<Template> {
  const db = await getDb();
  const row = await db.transaction(async (tx) => {
    const currentPdf = await getBlob(actor.orgId, current.pdfBlobId, tx);
    let pdfBlobId = current.pdfBlobId;
    let sourceBlobId = current.sourceBlobId;
    if (source) {
      const stored = await storeDocument(tx, actor.orgId, current.name, source, prepared.pdf);
      pdfBlobId = stored.pdfBlobId;
      sourceBlobId = stored.sourceBlobId;
    } else if (!currentPdf || !sameBytes(new Uint8Array(currentPdf.bytes), prepared.pdf)) {
      pdfBlobId = (await putBlob(tx, { orgId: actor.orgId, bytes: prepared.pdf, contentType: "application/pdf", filename: `${current.name}.pdf` })).id;
    }
    const [updated] = await tx
      .update(templates)
      .set({
        pdfBlobId,
        sourceBlobId,
        pages: prepared.pages,
        fields: prepared.fields,
        detection: prepared.detection,
        version: sql`${templates.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(templates.id, current.id), eq(templates.orgId, actor.orgId), eq(templates.version, current.version)))
      .returning();
    // Throwing rolls back the blobs stored above.
    if (!updated) throw versionConflict();
    await recordEvent(tx, {
      orgId: actor.orgId,
      type: eventType,
      actor,
      meta,
      data: {
        templateId: updated.id,
        templateName: updated.name,
        version: updated.version,
        pages: prepared.pages.length,
        count: prepared.fields.length,
        method: prepared.detection.method,
        signaturePageAppended: prepared.detection.signaturePageAppended,
      },
    });
    return updated;
  });
  await discardBlobs(actor.orgId, [current.pdfBlobId, current.sourceBlobId], [row.pdfBlobId, row.sourceBlobId]);
  return row;
}

/**
 * Run field detection again and replace every field with the result, discarding
 * manual edits. Detection starts from the original upload, so a signature page added
 * last time is not mistaken for part of the document.
 */
export async function redetectFields(actor: Actor, id: unknown, expectedVersion?: unknown, meta?: RequestMeta): Promise<Template> {
  const db = await getDb();
  await assertActor(db, actor, "manage");
  const org = await loadOrg(db, actor.orgId);
  const current = await loadTemplate(db, actor.orgId, id);
  if (expectedVersion !== undefined && expectedVersion !== null && parseVersion(expectedVersion) !== current.version) throw versionConflict();

  const sourceBlob = current.sourceBlobId ? await getBlob(actor.orgId, current.sourceBlobId, db) : null;
  const pdfBlob = await getBlob(actor.orgId, current.pdfBlobId, db);
  if (!sourceBlob && !pdfBlob) throw new ServiceError("not_found", "The document for this agreement is missing. Replace the document with a new upload.");

  let prepared: Prepared | null = null;
  if (sourceBlob) {
    try {
      prepared = await prepare(org, () =>
        ingestDocument({ bytes: new Uint8Array(sourceBlob.bytes), filename: sourceBlob.filename ?? current.name, mimeType: sourceBlob.contentType }),
      );
    } catch (err) {
      // The original was readable when it was uploaded; if it is not now, fall back to
      // the prepared PDF rather than leave the person with no way to detect again.
      if (!(err instanceof DocumentServiceError) || !pdfBlob) throw err;
    }
  }
  if (!prepared && pdfBlob) {
    prepared = await prepare(org, () => ingestDocument({ bytes: new Uint8Array(pdfBlob.bytes), filename: `${current.name}.pdf`, mimeType: "application/pdf" }));
  }
  if (!prepared) throw new ServiceError("not_found", "The document for this agreement is missing. Replace the document with a new upload.");
  return applyPrepared(actor, current, prepared, null, "template.fields_redetected", meta);
}

/**
 * Swap the document behind an existing agreement for a new upload: new PDF, fresh
 * detection, version bump. Name, status, default flag and intake link are kept.
 * Envelopes already sent are unaffected; they hold the document they were sent with.
 */
export async function replaceTemplateDocument(
  actor: Actor,
  id: unknown,
  input: { bytes: unknown; filename?: unknown; mimeType?: unknown },
  expectedVersion?: unknown,
  meta?: RequestMeta,
): Promise<Template> {
  const db = await getDb();
  await assertActor(db, actor, "manage");
  const org = await loadOrg(db, actor.orgId);
  const current = await loadTemplate(db, actor.orgId, id);
  if (expectedVersion !== undefined && expectedVersion !== null && parseVersion(expectedVersion) !== current.version) throw versionConflict();

  const raw = asRecord(input);
  const bytes = toBytes(raw.bytes);
  if (!bytes || bytes.byteLength === 0) {
    throw new DocumentServiceError("empty", "The file is empty. Choose a file that has content and upload it again.");
  }
  const base = typeof raw.filename === "string" ? (raw.filename.split(/[\\/]/).pop() ?? "") : "";
  const filename = cleanText(base, 150) || "agreement";
  const mimeType = typeof raw.mimeType === "string" ? cleanText(raw.mimeType, 100).toLowerCase() || "application/octet-stream" : "application/octet-stream";
  const prepared = await prepare(org, () => ingestDocument({ bytes, filename, mimeType }));
  return applyPrepared(actor, current, prepared, { bytes, contentType: mimeType, filename }, "template.document_replaced", meta);
}

// ---------------------------------------------------------------------------
// Intake link
// ---------------------------------------------------------------------------

/**
 * Turn on the public link where a client starts their own file and signs this
 * agreement. Calling it again returns the same link; turn it off and on to get a new one.
 */
export async function enableIntakeLink(actor: Actor, id: unknown, meta?: RequestMeta): Promise<IntakeLink> {
  const db = await getDb();
  await assertActor(db, actor, "manage");
  return db.transaction(async (tx) => {
    const org = await lockOrg(tx, actor.orgId);
    const current = await loadTemplate(tx, actor.orgId, id);
    if (current.status !== "active") {
      throw new ServiceError("not_ready", "Only an agreement that is in use can have a client intake link. Activate this agreement first.");
    }
    const readiness = templateReadiness(current, org, await loadReadinessMembers(tx, actor.orgId));
    if (!readiness.ready) throw notReady(readiness, "This agreement cannot take clients until it is ready to send.");
    if (current.intakeToken) return { template: current, token: current.intakeToken, url: intakeUrl(current.intakeToken) };

    const token = newSecret();
    const [row] = await tx
      .update(templates)
      .set({ intakeToken: token, updatedAt: new Date() })
      .where(and(eq(templates.id, current.id), eq(templates.orgId, actor.orgId), isNull(templates.intakeToken)))
      .returning();
    if (!row) throw versionConflict();
    await recordEvent(tx, { orgId: actor.orgId, type: "template.intake_enabled", actor, meta, data: { templateId: row.id, templateName: row.name } });
    return { template: row, token, url: intakeUrl(token) };
  });
}

/** Turn the public intake link off. The old link stops working at once and is never reused. */
export async function disableIntakeLink(actor: Actor, id: unknown, meta?: RequestMeta): Promise<Template> {
  const db = await getDb();
  await assertActor(db, actor, "manage");
  return db.transaction(async (tx) => {
    const current = await loadTemplate(tx, actor.orgId, id);
    if (!current.intakeToken) return current;
    const [row] = await tx
      .update(templates)
      .set({ intakeToken: null, updatedAt: new Date() })
      .where(and(eq(templates.id, current.id), eq(templates.orgId, actor.orgId)))
      .returning();
    if (!row) throw notFound();
    await recordEvent(tx, { orgId: actor.orgId, type: "template.intake_disabled", actor, meta, data: { templateId: row.id, templateName: row.name } });
    return row;
  });
}

/**
 * Resolve a public intake link. There is no signed-in caller: the token is the proof
 * of access. Returns null for anything that is not a live link on an agreement in use,
 * so a wrong, old and malformed link all look the same.
 */
export async function getTemplateByIntakeToken(token: unknown): Promise<{ template: Template; org: Org } | null> {
  if (!isSecretToken(token)) return null;
  const db = await getDb();
  const [row] = await db
    .select({ template: templates, org: orgs })
    .from(templates)
    .innerJoin(orgs, eq(orgs.id, templates.orgId))
    .where(and(eq(templates.intakeToken, token), eq(templates.status, "active")))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/**
 * A handwriting-like stroke as a transparent PNG data URL. Previews need something
 * that reads as a signature without being anyone's, and the engine only accepts
 * complete, valid PNGs, so it is drawn here rather than shipped as an asset.
 */
function sampleStroke(width: number, height: number, loops: number, lean: number): string {
  const rgba = new Uint8Array(width * height * 4);
  const dab = (cx: number, cy: number, radius: number) => {
    for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(height - 1, Math.ceil(cy + radius)); y++) {
      for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(width - 1, Math.ceil(cx + radius)); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > radius) continue;
        const i = (y * width + x) * 4;
        const alpha = Math.round(255 * Math.min(1, radius - d + 0.5));
        rgba[i] = 24;
        rgba[i + 1] = 38;
        rgba[i + 2] = 110;
        rgba[i + 3] = Math.max(rgba[i + 3], alpha);
      }
    }
  };
  const steps = width * 12;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = width * 0.06 + t * width * 0.84 + Math.sin(t * Math.PI * 2 * loops) * width * lean;
    const y = height * 0.5 - Math.sin(t * Math.PI * 2 * loops + 0.6) * height * 0.3 * (1 - 0.45 * t) - Math.sin(t * Math.PI) * height * 0.06;
    dab(x, y, 1.5 + 0.5 * Math.sin(t * 9));
  }
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * stride + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

let sampleImages: { signature: string; initials: string; companySignature: string; companyInitials: string } | undefined;
function samples() {
  sampleImages ??= {
    signature: sampleStroke(360, 110, 4.5, 0.035),
    initials: sampleStroke(150, 110, 2, 0.05),
    companySignature: sampleStroke(360, 110, 3.5, 0.05),
    companyInitials: sampleStroke(150, 110, 1.5, 0.07),
  };
  return sampleImages;
}

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
}

/** Stand-in values for every field, so a preview shows the agreement as a client would receive and return it. */
function sampleValues(fields: Field[], org: Org, countersigner: { name: string; title: string | null; email: string } | null, now: Date): FieldValues {
  const longDate = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).format(now);
  const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(now);
  const year = String(now.getUTCFullYear());
  const settings = resolveSettings(org);
  const prefix = typeof settings.fileReferencePrefix === "string" && settings.fileReferencePrefix ? settings.fileReferencePrefix : "F";
  const companyName = org.legalName?.trim() || org.name;

  const merge: Record<string, string> = {
    client_name: "Jordan Sample",
    client_email: "jordan.sample@example.com",
    client_company: "Sample Client Ltd",
    client_title: "Director",
    client_phone: "555 0100",
    file_reference: `${prefix}-${year}-0001`,
    file_description: "Sample engagement",
    company_name: companyName,
    today: longDate,
    // The detector emits these for "this ___ day of ___, 20__" wording.
    "custom:today_day": ordinal(now.getUTCDate()),
    "custom:today_month": month,
    "custom:today_year": year,
    "custom:today_year_short": year.slice(-2),
  };
  const client: Partial<Record<FieldType, string | boolean>> = {
    signature: samples().signature,
    initials: samples().initials,
    date_signed: longDate,
    full_name: "Jordan Sample",
    title: "Director",
    company: "Sample Client Ltd",
    email: "jordan.sample@example.com",
    text: "Sample answer",
    date: longDate,
    checkbox: true,
  };
  const company: Partial<Record<FieldType, string | boolean>> = {
    signature: samples().companySignature,
    initials: samples().companyInitials,
    date_signed: longDate,
    full_name: countersigner?.name || "Alex Example",
    title: countersigner?.title || "Authorized signatory",
    company: companyName,
    email: countersigner?.email || "alex.example@example.com",
    text: "Sample answer",
    date: longDate,
    checkbox: true,
  };

  const values: FieldValues = {};
  for (const field of fields) {
    if (!field || typeof field.id !== "string") continue;
    let value: string | boolean | undefined;
    if (field.role === "prefill") {
      if (field.type === "checkbox") value = true;
      else value = (typeof field.mergeKey === "string" ? merge[field.mergeKey] : undefined) ?? "Sample";
    } else {
      value = (field.role === "company" ? company : client)[field.type];
    }
    if (value !== undefined) values[field.id] = value;
  }
  return values;
}

/**
 * The agreement with realistic sample values and signatures stamped into every field,
 * drawn by the same code that produces the signed copy. Nothing is stored or sent.
 */
export async function previewTemplatePdf(actor: Actor, id: unknown): Promise<Uint8Array> {
  const db = await getDb();
  await assertActor(db, actor, "read");
  const template = await loadTemplate(db, actor.orgId, id);
  const org = await loadOrg(db, actor.orgId);
  const blob = await getBlob(actor.orgId, template.pdfBlobId, db);
  if (!blob) throw new ServiceError("not_found", "The document for this agreement is missing. Upload the agreement again.");

  const countersignerId = resolveSettings(org).countersignerUserId;
  let countersigner: { name: string; title: string | null; email: string } | null = null;
  if (typeof countersignerId === "string" && countersignerId) {
    const [row] = await db
      .select({ name: users.name, title: users.title, email: users.email })
      .from(users)
      .where(and(eq(users.id, countersignerId), eq(users.orgId, actor.orgId)))
      .limit(1);
    countersigner = row ?? null;
  }

  const fields = Array.isArray(template.fields) ? template.fields : [];
  try {
    return await stampFields(new Uint8Array(blob.bytes), fields, sampleValues(fields, org, countersigner, new Date()));
  } catch (err) {
    toDocumentError(err);
  }
}
