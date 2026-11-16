import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { PDFDocument, PDFHexString, StandardFonts } from "pdf-lib";
import { getDb } from "@/lib/db";
import { blobs, envelopes, events, files, orgs, templates, users, type Template } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { extractText } from "@/lib/pdf";
import { LIMITS, type Field, type OrgSettings } from "@/lib/types";
import { ServiceError, type Actor } from "@/lib/services/context";
import {
  DocumentServiceError,
  TEMPLATE_LIMITS,
  activateTemplate,
  archiveTemplate,
  createTemplateFromPageImages,
  createTemplateFromText,
  createTemplateFromUpload,
  disableIntakeLink,
  duplicateTemplate,
  enableIntakeLink,
  getTemplate,
  getTemplateByIntakeToken,
  getTemplatePdf,
  getTemplateReadiness,
  isValidMergeKey,
  listTemplates,
  previewTemplatePdf,
  redetectFields,
  renameTemplate,
  replaceTemplateDocument,
  setDefaultTemplate,
  templateReadiness,
  updateTemplateFields,
  type ReadinessMember,
} from "@/lib/services/templates";

// ---------------------------------------------------------------------------
// Fixtures (test data only)
// ---------------------------------------------------------------------------

type UserActor = Actor & { type: "user" };

interface World {
  orgId: string;
  owner: UserActor;
  member: UserActor;
}

async function addUser(orgId: string, role: "owner" | "admin" | "member", extra: Partial<typeof users.$inferInsert> = {}): Promise<UserActor> {
  const db = await getDb();
  const userId = newId("usr");
  await db.insert(users).values({ id: userId, orgId, email: `${userId}@example.test`, name: `Test ${role}`, passwordHash: "x", role, ...extra });
  return { type: "user", orgId, userId, role, label: `Test ${role}` };
}

async function makeWorld(name = "Northwind Test Co"): Promise<World> {
  const db = await getDb();
  const orgId = newId("org");
  await db.insert(orgs).values({ id: orgId, name, slug: orgId });
  return { orgId, owner: await addUser(orgId, "owner"), member: await addUser(orgId, "member") };
}

async function setSettings(orgId: string, settings: OrgSettings): Promise<void> {
  const db = await getDb();
  await db.update(orgs).set({ settings }).where(eq(orgs.id, orgId));
}

async function agreementPdf(opts: { pages?: number; title?: string; company?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const count = opts.pages ?? 1;
  for (let i = 0; i < count; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(opts.title ?? "Test Services Agreement", { x: 72, y: 720, size: 18, font });
    page.drawText(`Page ${i + 1}. The client agrees to the terms set out in this test document.`, { x: 72, y: 680, size: 11, font });
    if (i === count - 1) {
      page.drawText("Client Signature: ______________________________", { x: 72, y: 200, size: 11, font });
      page.drawText("Date: ________________", { x: 72, y: 170, size: 11, font });
      if (opts.company) page.drawText("Northwind Test Co Signature: ______________________________", { x: 72, y: 120, size: 11, font });
    }
  }
  return doc.save();
}

async function encryptedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const encrypt = doc.context.obj({ Filter: "Standard", V: 1, R: 2, P: -44, O: PDFHexString.of("00".repeat(32)), U: PDFHexString.of("00".repeat(32)) });
  doc.context.trailerInfo.Encrypt = doc.context.register(encrypt);
  return doc.save({ useObjectStreams: false });
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePng(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (1 + width * 3), 200);
  for (let y = 0; y < height; y++) raw[y * (1 + width * 3)] = 0;
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]),
  );
}

const field = (over: Partial<Field> = {}): Field => ({
  id: newId("fld"),
  page: 0,
  x: 0.1,
  y: 0.7,
  w: 0.3,
  h: 0.05,
  type: "signature",
  role: "client",
  required: true,
  label: "Client signature",
  source: "manual",
  ...over,
});

async function createPdfTemplate(actor: Actor, opts: Parameters<typeof agreementPdf>[0] = {}, name?: string): Promise<Template> {
  return createTemplateFromUpload(actor, { bytes: await agreementPdf(opts), filename: "Test Agreement.pdf", mimeType: "application/pdf", name });
}

/** A draft with exactly one required client signature, so readiness never depends on what the detector found. */
async function readyTemplate(actor: Actor, name?: string): Promise<Template> {
  const created = await createPdfTemplate(actor, {}, name);
  return updateTemplateFields(actor, created.id, [field()], created.version);
}

async function addEnvelope(orgId: string, template: Template, status: "draft" | "sent" | "completed", sent: boolean): Promise<string> {
  const db = await getDb();
  const fileId = newId("file");
  await db.insert(files).values({ id: fileId, orgId, reference: fileId, clientName: "Jordan Sample", clientEmail: "jordan.sample@example.test" });
  const id = newId("env");
  await db.insert(envelopes).values({
    id,
    orgId,
    fileId,
    templateId: template.id,
    templateName: template.name,
    templateVersion: template.version,
    pdfBlobId: template.pdfBlobId,
    pdfSha256: "0".repeat(64),
    pages: template.pages,
    fields: template.fields,
    status,
    sentAt: sent ? new Date() : null,
  });
  return id;
}

async function eventsOf(orgId: string, type: string) {
  const db = await getDb();
  return db.select().from(events).where(and(eq(events.orgId, orgId), eq(events.type, type)));
}

async function expectError(promise: Promise<unknown>, code: ServiceError["code"], pattern?: RegExp): Promise<ServiceError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServiceError);
  const e = err as ServiceError;
  expect(e.code).toBe(code);
  if (pattern) expect(e.message).toMatch(pattern);
  return e;
}

async function expectDocumentError(promise: Promise<unknown>, documentCode: DocumentServiceError["documentCode"]): Promise<DocumentServiceError> {
  const err = (await expectError(promise, "invalid")) as DocumentServiceError;
  expect(err).toBeInstanceOf(DocumentServiceError);
  expect(err.documentCode).toBe(documentCode);
  expect(err.status).toBe(422);
  expect(err.message.length).toBeGreaterThan(20);
  return err;
}

const hasRequiredClientSignature = (fields: Field[]) => fields.some((f) => f.role === "client" && f.type === "signature" && f.required);

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

describe("creating templates", () => {
  it("creates a draft from a PDF with detected fields, stored blobs and an audit event", async () => {
    const w = await makeWorld();
    const bytes = await agreementPdf({ pages: 2 });
    const t = await createTemplateFromUpload(w.owner, { bytes, filename: "Test Agreement.pdf", mimeType: "application/pdf" }, { ip: "203.0.113.5" });

    expect(t).toMatchObject({ orgId: w.orgId, status: "draft", isDefault: false, version: 1, intakeToken: null, createdBy: w.owner.userId });
    expect(t.name.length).toBeGreaterThan(0);
    expect(t.pages.length).toBeGreaterThanOrEqual(2);
    expect(hasRequiredClientSignature(t.fields)).toBe(true);
    expect(t.detection).toMatchObject({ scanned: false });
    expect(new Set(t.fields.map((f) => f.id)).size).toBe(t.fields.length);
    for (const f of t.fields) {
      expect(f.page).toBeLessThan(t.pages.length);
      expect(f.x + f.w).toBeLessThanOrEqual(1.000001);
      expect(f.y + f.h).toBeLessThanOrEqual(1.000001);
    }

    const db = await getDb();
    const [source] = await db.select().from(blobs).where(eq(blobs.id, t.sourceBlobId!));
    const [pdf] = await db.select().from(blobs).where(eq(blobs.id, t.pdfBlobId));
    expect(source.orgId).toBe(w.orgId);
    expect(Buffer.from(source.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(source.filename).toBe("Test Agreement.pdf");
    expect(pdf.contentType).toBe("application/pdf");
    expect((await PDFDocument.load(pdf.bytes)).getPageCount()).toBe(t.pages.length);

    const [event] = await eventsOf(w.orgId, "template.created");
    expect(event).toMatchObject({ actorType: "user", ip: "203.0.113.5" });
    expect(event.data).toMatchObject({ templateId: t.id, templateName: t.name, kind: "pdf" });
  });

  it("uses the given name, and falls back to the document or filename when none is given", async () => {
    const w = await makeWorld();
    const named = await createPdfTemplate(w.owner, {}, "  Engagement   letter \n");
    expect(named.name).toBe("Engagement letter");
    const unnamed = await createPdfTemplate(w.owner);
    expect(unnamed.name).not.toBe("");
    const long = await createPdfTemplate(w.owner, {}, "n".repeat(500));
    expect(long.name.length).toBeLessThanOrEqual(TEMPLATE_LIMITS.nameMax);
  });

  it("passes the company name to detection so company lines go to the company", async () => {
    const w = await makeWorld("Northwind Test Co");
    const t = await createPdfTemplate(w.owner, { company: true });
    expect(hasRequiredClientSignature(t.fields)).toBe(true);
    expect(t.fields.some((f) => f.role === "company" && f.type === "signature")).toBe(true);
  });

  it("creates a draft from pasted text and keeps the text as the original", async () => {
    const w = await makeWorld();
    const text = "TEST CONSULTING AGREEMENT\n\nThe client agrees to pay for the work.\n\nClient signature: ____________________\nDate: ____________";
    const t = await createTemplateFromText(w.owner, { text, name: "Consulting agreement" });
    expect(t).toMatchObject({ name: "Consulting agreement", status: "draft" });
    expect(hasRequiredClientSignature(t.fields)).toBe(true);
    const db = await getDb();
    const [source] = await db.select().from(blobs).where(eq(blobs.id, t.sourceBlobId!));
    expect(source.bytes.toString("utf8")).toBe(text);
    expect(source.contentType).toMatch(/^text\/plain/);
    const extracted = await extractText((await getTemplatePdf(w.owner, t.id)).bytes);
    expect(extracted.pageText.join(" ")).toContain("The client agrees to pay");
  });

  it("rejects blank or non-text pasted input as an empty document", async () => {
    const w = await makeWorld();
    for (const text of ["", "   \n\t ", undefined, null, 42, {}]) {
      await expectDocumentError(createTemplateFromText(w.owner, { text, name: "x" }), "empty");
    }
    await expectDocumentError(createTemplateFromText(w.owner, undefined as never), "empty");
  });

  it("creates a draft from page images; with no text to read, a signature page is added so it can still be signed", async () => {
    const w = await makeWorld();
    const images = [
      { bytes: makePng(60, 80), widthPt: 612, heightPt: 792 },
      { bytes: makePng(80, 60), widthPt: 792, heightPt: 612 },
    ];
    const t = await createTemplateFromPageImages(w.owner, { images, name: "Scanned agreement" });
    expect(t.name).toBe("Scanned agreement");
    expect(t.pages.length).toBeGreaterThanOrEqual(2);
    expect(t.pages[0]).toMatchObject({ width: 612, height: 792 });
    expect(t.pages[1]).toMatchObject({ width: 792, height: 612 });
    expect(hasRequiredClientSignature(t.fields)).toBe(true);
    expect(t.detection?.notes.length).toBeGreaterThan(0);
    expect((await eventsOf(w.orgId, "template.created"))[0].data).toMatchObject({ kind: "page_images" });
  });

  it("rejects missing, empty and unreadable page images with a document error", async () => {
    const w = await makeWorld();
    await expectDocumentError(createTemplateFromPageImages(w.owner, { images: [], name: "x" }), "empty");
    await expectDocumentError(createTemplateFromPageImages(w.owner, { images: "nope", name: "x" }), "empty");
    await expectDocumentError(createTemplateFromPageImages(w.owner, undefined as never), "empty");
    const bad = createTemplateFromPageImages(w.owner, { images: [{ bytes: new Uint8Array([1, 2, 3, 4, 5]), widthPt: 612, heightPt: 792 }, null, 7], name: "x" });
    const err = await expectError(bad, "invalid");
    expect(err).toBeInstanceOf(DocumentServiceError);
    const db = await getDb();
    expect(await db.select().from(templates).where(eq(templates.orgId, w.orgId))).toHaveLength(0);
  });

  it("keeps the engine's code for a locked PDF so the page can offer the picture fallback", async () => {
    const w = await makeWorld();
    const err = await expectDocumentError(createTemplateFromUpload(w.owner, { bytes: await encryptedPdf(), filename: "locked.pdf", mimeType: "application/pdf" }), "password_protected");
    expect(err.pageImageFallback).toBe(true);
    const db = await getDb();
    // Nothing is left behind by a failed upload.
    expect(await db.select().from(templates).where(eq(templates.orgId, w.orgId))).toHaveLength(0);
    expect(await db.select({ id: blobs.id }).from(blobs).where(eq(blobs.orgId, w.orgId))).toHaveLength(0);
  });

  it("reports a damaged PDF as corrupt (fallback offered) and an unknown format as unsupported (no fallback)", async () => {
    const w = await makeWorld();
    const damaged = new Uint8Array(Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(600, 0x41)]));
    const corrupt = await expectDocumentError(createTemplateFromUpload(w.owner, { bytes: damaged, filename: "damaged.pdf", mimeType: "application/pdf" }), "corrupt");
    expect(corrupt.pageImageFallback).toBe(true);

    const binary = new Uint8Array(Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x00, 0x01]), Buffer.alloc(300, 0x00)]));
    const unsupported = await expectDocumentError(createTemplateFromUpload(w.owner, { bytes: binary, filename: "setup.exe", mimeType: "application/x-msdownload" }), "unsupported_type");
    expect(unsupported.pageImageFallback).toBe(false);
  });

  it("rejects empty or non-binary uploads without throwing anything unexpected", async () => {
    const w = await makeWorld();
    for (const bytes of [new Uint8Array(0), undefined, null, "a string", 42, [1, 2, 3], {}]) {
      await expectDocumentError(createTemplateFromUpload(w.owner, { bytes, filename: "x.pdf" }), "empty");
    }
    await expectDocumentError(createTemplateFromUpload(w.owner, undefined as never), "empty");
  });

  it("copes with a hostile filename and type", async () => {
    const w = await makeWorld();
    const t = await createTemplateFromUpload(w.owner, { bytes: await agreementPdf(), filename: "..\\..\\etc\\<script>\u0000.pdf", mimeType: { evil: true } });
    expect(t.status).toBe("draft");
    const db = await getDb();
    const [source] = await db.select().from(blobs).where(eq(blobs.id, t.sourceBlobId!));
    expect(source.filename).not.toMatch(/[\\/<>\u0000]/);
    expect(source.contentType).toMatch(/^application\/(pdf|octet-stream)$/);
  });

  it("lets only owners, admins, API keys and the system create", async () => {
    const w = await makeWorld();
    const bytes = await agreementPdf();
    await expectError(createTemplateFromUpload(w.member, { bytes, filename: "a.pdf" }), "forbidden", /owner or admin/);
    await expectError(createTemplateFromText(w.member, { text: "Agreement text", name: "x" }), "forbidden");
    await expectError(createTemplateFromPageImages(w.member, { images: [{ bytes: makePng(4, 4), widthPt: 612, heightPt: 792 }], name: "x" }), "forbidden");
    // A session that claims a better role than the stored one gets nowhere.
    await expectError(createTemplateFromUpload({ ...w.member, role: "owner" }, { bytes, filename: "a.pdf" }), "forbidden");

    const admin = await addUser(w.orgId, "admin");
    expect((await createTemplateFromUpload(admin, { bytes, filename: "a.pdf" })).status).toBe("draft");
    const viaKey = await createTemplateFromUpload({ type: "api", orgId: w.orgId, keyId: "key_test", label: "Test key" }, { bytes, filename: "a.pdf" });
    expect(viaKey.createdBy).toBeNull();

    const disabled = await addUser(w.orgId, "owner", { disabledAt: new Date() });
    await expectError(createTemplateFromUpload(disabled, { bytes, filename: "a.pdf" }), "forbidden", /no longer active/);
    await expectError(createTemplateFromUpload(null as never, { bytes, filename: "a.pdf" }), "forbidden");
  });
});

// ---------------------------------------------------------------------------
// Reading and tenant isolation
// ---------------------------------------------------------------------------

describe("reading templates", () => {
  it("lets any member read, list, download and preview", async () => {
    const w = await makeWorld();
    const t = await readyTemplate(w.owner);
    expect((await getTemplate(w.member, t.id)).id).toBe(t.id);
    expect((await listTemplates(w.member)).map((x) => x.id)).toEqual([t.id]);
    const pdf = await getTemplatePdf(w.member, t.id);
    expect(Buffer.from(pdf.bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(pdf.filename).toMatch(/\.pdf$/);
    expect(pdf.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await previewTemplatePdf(w.member, t.id)).byteLength).toBeGreaterThan(0);
    expect((await getTemplateReadiness(w.member, t.id)).ready).toBe(true);
  });

  it("makes a download name that is safe in a header", async () => {
    const w = await makeWorld();
    const t = await createPdfTemplate(w.owner, {}, 'Terms: "2026" <v2> a/b');
    expect((await getTemplatePdf(w.owner, t.id)).filename).toBe("Terms 2026 v2 a b.pdf");
  });

  it("counts envelopes sent and signed per template, never another company's", async () => {
    const w = await makeWorld();
    const other = await makeWorld();
    const a = await readyTemplate(w.owner, "A");
    const b = await readyTemplate(w.owner, "B");
    const theirs = await readyTemplate(other.owner, "Theirs");
    await addEnvelope(w.orgId, a, "draft", false);
    await addEnvelope(w.orgId, a, "sent", true);
    await addEnvelope(w.orgId, a, "completed", true);
    await addEnvelope(w.orgId, a, "completed", true);
    await addEnvelope(other.orgId, theirs, "completed", true);

    const list = await listTemplates(w.owner);
    expect(list).toHaveLength(2);
    expect(list.find((t) => t.id === a.id)).toMatchObject({ sentCount: 3, signedCount: 2 });
    expect(list.find((t) => t.id === b.id)).toMatchObject({ sentCount: 0, signedCount: 0 });
    expect(list.every((t) => t.orgId === w.orgId && t.readiness.ready)).toBe(true);
    expect((await listTemplates(other.owner)).map((t) => [t.id, t.sentCount, t.signedCount])).toEqual([[theirs.id, 1, 1]]);
  });

  it("lists the default first, then active, drafts, archived", async () => {
    const w = await makeWorld();
    await readyTemplate(w.owner, "Draft");
    const archived = await readyTemplate(w.owner, "Archived");
    const first = await readyTemplate(w.owner, "First active");
    const second = await readyTemplate(w.owner, "Second active");
    await archiveTemplate(w.owner, archived.id);
    await activateTemplate(w.owner, first.id);
    await activateTemplate(w.owner, second.id);
    await setDefaultTemplate(w.owner, second.id);
    expect((await listTemplates(w.owner)).map((t) => t.name)).toEqual(["Second active", "First active", "Draft", "Archived"]);
  });

  it("reports a missing or malformed id as not found", async () => {
    const w = await makeWorld();
    for (const id of ["tpl_doesnotexist0000", "", undefined, null, 42, {}, "x".repeat(500), "' OR 1=1 --"]) {
      await expectError(getTemplate(w.owner, id), "not_found", /could not be found/);
    }
  });

  it("hides one company's template from every operation by another company", async () => {
    const a = await makeWorld();
    const b = await makeWorld();
    const t = await readyTemplate(a.owner);
    const pdf = await agreementPdf();
    const attempts: Promise<unknown>[] = [
      getTemplate(b.owner, t.id),
      getTemplatePdf(b.owner, t.id),
      getTemplateReadiness(b.owner, t.id),
      previewTemplatePdf(b.owner, t.id),
      updateTemplateFields(b.owner, t.id, [field()], t.version),
      renameTemplate(b.owner, t.id, "Stolen"),
      duplicateTemplate(b.owner, t.id),
      activateTemplate(b.owner, t.id),
      setDefaultTemplate(b.owner, t.id),
      archiveTemplate(b.owner, t.id),
      redetectFields(b.owner, t.id),
      replaceTemplateDocument(b.owner, t.id, { bytes: pdf, filename: "x.pdf" }),
      enableIntakeLink(b.owner, t.id),
      disableIntakeLink(b.owner, t.id),
    ];
    for (const attempt of attempts) await expectError(attempt, "not_found");

    expect(await listTemplates(b.owner)).toHaveLength(0);
    const after = await getTemplate(a.owner, t.id);
    expect(after).toMatchObject({ name: t.name, status: "draft", version: t.version, pdfBlobId: t.pdfBlobId });
    const db = await getDb();
    expect(await db.select().from(templates).where(eq(templates.orgId, b.orgId))).toHaveLength(0);
    expect(await db.select({ id: blobs.id }).from(blobs).where(eq(blobs.orgId, b.orgId))).toHaveLength(0);
  });

  it("refuses every change by a member", async () => {
    const w = await makeWorld();
    const t = await readyTemplate(w.owner);
    const attempts: Promise<unknown>[] = [
      updateTemplateFields(w.member, t.id, [field()], t.version),
      renameTemplate(w.member, t.id, "New"),
      duplicateTemplate(w.member, t.id),
      activateTemplate(w.member, t.id),
      setDefaultTemplate(w.member, t.id),
      archiveTemplate(w.member, t.id),
      redetectFields(w.member, t.id),
      replaceTemplateDocument(w.member, t.id, { bytes: await agreementPdf(), filename: "x.pdf" }),
      enableIntakeLink(w.member, t.id),
      disableIntakeLink(w.member, t.id),
    ];
    for (const attempt of attempts) await expectError(attempt, "forbidden");
    expect(await getTemplate(w.owner, t.id)).toMatchObject({ version: t.version, status: "draft", name: t.name });
  });
});

// ---------------------------------------------------------------------------
// Field editing
// ---------------------------------------------------------------------------

describe("updateTemplateFields", () => {
  it("saves valid fields, bumps the version and records an event", async () => {
    const w = await makeWorld();
    const t = await createPdfTemplate(w.owner);
    const next = [
      field({ id: "sig1" }),
      field({ id: "name1", type: "full_name", label: "Your name", y: 0.6 }),
      field({ id: "ref", type: "text", role: "prefill", mergeKey: "file_reference", required: false, label: "File number", y: 0.1 }),
      field({ id: "custom", type: "text", role: "prefill", mergeKey: "custom:matter.type-1", required: false, label: "", y: 0.2 }),
    ];
    const saved = await updateTemplateFields(w.owner, t.id, next, t.version);
    expect(saved.version).toBe(t.version + 1);
    expect(saved.fields.map((f) => f.id)).toEqual(["sig1", "name1", "ref", "custom"]);
    expect(saved.fields[2].mergeKey).toBe("file_reference");
    expect(saved.fields[0]).not.toHaveProperty("mergeKey");
    // A blank label gets a sensible one rather than an empty string.
    expect(saved.fields[3].label).toBe("Text");
    expect(saved.updatedAt.getTime()).toBeGreaterThanOrEqual(t.updatedAt.getTime());
    const [event] = await eventsOf(w.orgId, "template.fields_updated");
    expect(event.data).toMatchObject({ templateId: t.id, version: saved.version, count: 4 });
  });

  it("accepts the version as a string and an empty list on a draft", async () => {
    const w = await makeWorld();
    const t = await createPdfTemplate(w.owner);
    const saved = await updateTemplateFields(w.owner, t.id, [], String(t.version));
    expect(saved.fields).toEqual([]);
    expect(saved.version).toBe(t.version + 1);
  });

  it("refuses a stale version so two editors cannot overwrite each other", async () => {
    const w = await makeWorld();
    const admin = await addUser(w.orgId, "admin");
    const t = await createPdfTemplate(w.owner);
    const first = await updateTemplateFields(w.owner, t.id, [field({ id: "mine" })], t.version);
    await expectError(updateTemplateFields(admin, t.id, [field({ id: "theirs" })], t.version), "conflict", /Someone else changed this agreement/);
    const stored = await getTemplate(w.owner, t.id);
    expect(stored.version).toBe(first.version);
    expect(stored.fields.map((f) => f.id)).toEqual(["mine"]);
    // After reloading, the second editor's save goes through.
    expect((await updateTemplateFields(admin, t.id, [field({ id: "theirs" })], stored.version)).version).toBe(first.version + 1);
  });

  it("lets exactly one of two simultaneous saves win", async () => {
    const w = await makeWorld();
    const t = await createPdfTemplate(w.owner);
    const results = await Promise.allSettled([
      updateTemplateFields(w.owner, t.id, [field({ id: "a" })], t.version),
      updateTemplateFields(w.owner, t.id, [field({ id: "b" })], t.version),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as ServiceError).code).toBe("conflict");
    expect((await getTemplate(w.owner, t.id)).version).toBe(t.version + 1);
  });

  it("rejects a missing or nonsensical version", async () => {
    const w = await makeWorld();
    const t = await createPdfTemplate(w.owner);
    for (const version of [undefined, null, "", "abc", 0, -1, 1.5, Number.NaN, {}]) {
      await expectError(updateTemplateFields(w.owner, t.id, [field()], version), "invalid", /Reload the page/);
    }
  });

  it("pulls a field that hangs off the edge back onto the page", async () => {
    const w = await makeWorld();
    const t = await createPdfTemplate(w.owner);
    const saved = await updateTemplateFields(w.owner, t.id, [field({ id: "edge", x: 0.9, y: -0.02, w: 0.3, h: 0.08 })], t.version);
    const [f] = saved.fields;
    expect(f.x).toBeCloseTo(0.9);
    expect(f.w).toBeCloseTo(0.1);
    expect(f.y).toBe(0);
    expect(f.h).toBeCloseTo(0.06);
    expect(f.x + f.w).toBeLessThanOrEqual(1);
  });

  it("rejects each kind of invalid field with a message naming the field and what to do", async () => {
    const w = await makeWorld();
    const t = await createPdfTemplate(w.owner);
    const pageCount = t.pages.length;
    const cases: [string, unknown, RegExp][] = [
      ["page", field({ page: pageCount }), /page that does not exist/],
      ["page", field({ page: -1 }), /page that does not exist/],
      ["page", field({ page: 0.5 }), /page that does not exist/],
      ["page", { ...field(), page: "0" }, /page that does not exist/],
      ["geometry", field({ x: 1.2 }), /outside the page/],
      ["geometry", field({ y: -0.5, h: 0.1 }), /outside the page/],
      ["geometry", field({ w: 0 }), /no width or height/],
      ["geometry", field({ h: -0.1 }), /no width or height/],
      ["geometry", field({ w: 0.001 }), /too small/],
      ["geometry", field({ x: 0.999, w: 0.2 }), /too small/],
      ["geometry", field({ x: Number.NaN }), /no position or size/],
      ["geometry", field({ w: Number.POSITIVE_INFINITY }), /no position or size/],
      ["geometry", { ...field(), x: "0.1" }, /no position or size/],
      ["type", { ...field(), type: "stamp" }, /not supported/],
      ["type", { ...field(), type: undefined }, /not supported/],
      ["role", { ...field(), role: "witness" }, /who fills it in/],
      ["label", field({ label: "L".repeat(TEMPLATE_LIMITS.labelMax + 1) }), /label longer than 80/],
      ["label", { ...field(), label: 42 }, /label that is not text/],
      ["required", { ...field(), required: "yes" }, /required or optional/],
      ["id", field({ id: "has spaces" }), /id that is not valid/],
      ["id", { ...field(), id: 7 }, /id that is not valid/],
      ["mergeKey", field({ type: "text", role: "prefill" }), /does not say from what/],
      ["mergeKey", field({ type: "text", role: "prefill", mergeKey: "client_birthday" as never }), /not recognised/],
      ["mergeKey", field({ type: "text", role: "prefill", mergeKey: "custom:" }), /not recognised/],
      ["mergeKey", field({ type: "text", role: "prefill", mergeKey: "custom:has space" }), /not recognised/],
      ["mergeKey", field({ type: "text", role: "prefill", mergeKey: `custom:${"k".repeat(TEMPLATE_LIMITS.customKeyMax + 1)}` }), /not recognised/],
      ["mergeKey", field({ type: "text", role: "client", mergeKey: "client_name" }), /only works for fields that are filled automatically/],
      ["role", field({ type: "signature", role: "prefill", mergeKey: "client_name" }), /only a person signing can fill in/],
      ["field", "not an object", /is not a field/],
      ["field", null, /is not a field/],
    ];
    for (const [prop, bad, pattern] of cases) {
      const err = await expectError(updateTemplateFields(w.owner, t.id, [field({ id: "good" }), bad], t.version), "invalid", pattern);
      expect(err.message).toMatch(/^Field 2/);
      expect(Object.keys(err.fields ?? {})).toContain(`fields.1.${prop}`);
    }
    expect((await getTemplate(w.owner, t.id)).version).toBe(t.version);
  });

  it("rejects duplicate ids, too many fields and input that is not a list", async () => {
    const w = await makeWorld();
    const t = await createPdfTemplate(w.owner);
    await expectError(updateTemplateFields(w.owner, t.id, [field({ id: "same" }), field({ id: "same", y: 0.2 })], t.version), "invalid", /same id as another field/);

    const many = Array.from({ length: LIMITS.maxFieldsPerTemplate + 1 }, (_, i) => field({ id: `f${i}`, type: "text", required: false }));
    await expectError(updateTemplateFields(w.owner, t.id, many, t.version), "invalid", /at most 300 fields; this one has 301/);
    const atLimit = await updateTemplateFields(w.owner, t.id, [field({ id: "sig" }), ...many.slice(0, LIMITS.maxFieldsPerTemplate - 1)], t.version);
    expect(atLimit.fields).toHaveLength(LIMITS.maxFieldsPerTemplate);

    for (const bad of [undefined, null, "fields", 42, { 0: field() }]) {
      await expectError(updateTemplateFields(w.owner, t.id, bad, atLimit.version), "invalid", /could not be read/);
    }
  });

  it("reports every broken field at once, capped, when many are wrong", async () => {
    const w = await makeWorld();
    const t = await createPdfTemplate(w.owner);
    const bad = Array.from({ length: 120 }, (_, i) => field({ id: `f${i}`, page: 999 }));
    const err = await expectError(updateTemplateFields(w.owner, t.id, bad, t.version), "invalid");
    expect(Object.keys(err.fields ?? {}).length).toBe(50);
  });

  it("assigns an id when the editor sends none and never stores unknown properties", async () => {
    const w = await makeWorld();
    const t = await createPdfTemplate(w.owner);
    const raw = { ...field(), id: undefined, source: "hacked", confidence: 5, extra: "<script>", orgId: "org_other" };
    const saved = await updateTemplateFields(w.owner, t.id, [raw], t.version);
    expect(saved.fields[0].id).toMatch(/^fld_/);
    expect(saved.fields[0].source).toBe("manual");
    expect(Object.keys(saved.fields[0]).sort()).toEqual(["h", "id", "label", "page", "required", "role", "source", "type", "w", "x", "y"]);
  });

  it("will not let a save make an agreement that is in use unsendable", async () => {
    const w = await makeWorld();
    const t = await readyTemplate(w.owner);
    const { template: active } = await activateTemplate(w.owner, t.id);
    await expectError(updateTemplateFields(w.owner, active.id, [], active.version), "not_ready", /in use.*nowhere for the client to sign/);
    await expectError(updateTemplateFields(w.owner, active.id, [field({ required: false })], active.version), "not_ready", /optional/);
    await expectError(updateTemplateFields(w.owner, active.id, [field(), field({ role: "company", y: 0.8 })], active.version), "not_ready", /countersign/);
    expect((await getTemplate(w.owner, active.id)).version).toBe(active.version);
    const ok = await updateTemplateFields(w.owner, active.id, [field(), field({ type: "date_signed", y: 0.8, label: "Date" })], active.version);
    expect(ok.fields).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

describe("templateReadiness", () => {
  const pages = [{ width: 612, height: 792 }];
  const people: ReadinessMember[] = [
    { id: "usr_signer", disabled: false, hasSignature: true },
    { id: "usr_nosig", disabled: false, hasSignature: false },
    { id: "usr_gone", disabled: true, hasSignature: true },
  ];
  const codes = (r: { problems: { code: string }[] }) => r.problems.map((p) => p.code);

  it("is ready with one required client signature and no company fields", () => {
    expect(templateReadiness({ fields: [field()], pages }, { settings: {} }, [])).toEqual({ ready: true, problems: [] });
  });

  it("needs a required client signature", () => {
    expect(codes(templateReadiness({ fields: [], pages }, { settings: {} }, []))).toEqual(["no_client_signature"]);
    expect(codes(templateReadiness({ fields: [field({ required: false })], pages }, { settings: {} }, []))).toEqual(["no_client_signature"]);
    expect(codes(templateReadiness({ fields: [field({ type: "initials" })], pages }, { settings: {} }, []))).toEqual(["no_client_signature"]);
    // A company signature does not count as the client's.
    expect(codes(templateReadiness({ fields: [field({ role: "company" })], pages }, { settings: { countersignerUserId: "usr_signer" } }, people))).toEqual(["no_client_signature"]);
  });

  it("needs a countersigner when the company signs, and a saved signature only in auto mode", () => {
    const fields = [field(), field({ id: "co", role: "company", y: 0.8 })];
    expect(codes(templateReadiness({ fields, pages }, { settings: {} }, people))).toEqual(["no_countersigner"]);
    expect(codes(templateReadiness({ fields, pages }, { settings: { countersignerUserId: "usr_missing" } }, people))).toEqual(["countersigner_unavailable"]);
    expect(codes(templateReadiness({ fields, pages }, { settings: { countersignerUserId: "usr_gone" } }, people))).toEqual(["countersigner_unavailable"]);
    expect(templateReadiness({ fields, pages }, { settings: { countersignerUserId: "usr_nosig" } }, people).ready).toBe(true);
    expect(templateReadiness({ fields, pages }, { settings: { countersignerUserId: "usr_nosig", countersignMode: "manual" } }, people).ready).toBe(true);
    expect(codes(templateReadiness({ fields, pages }, { settings: { countersignerUserId: "usr_nosig", countersignMode: "auto" } }, people))).toEqual(["countersigner_no_signature"]);
    expect(templateReadiness({ fields, pages }, { settings: { countersignerUserId: "usr_signer", countersignMode: "auto" } }, people).ready).toBe(true);
  });

  it("needs a valid merge key on every prefill field", () => {
    const fields = [field(), field({ id: "p1", type: "text", role: "prefill", label: "Matter" }), field({ id: "p2", type: "text", role: "prefill", mergeKey: "nonsense" as never, label: "Other" })];
    const r = templateReadiness({ fields, pages }, { settings: {} }, []);
    expect(codes(r)).toEqual(["prefill_unmapped"]);
    expect(r.problems[0].message).toMatch(/2 fields.*"Matter", "Other"/);
    expect(templateReadiness({ fields: [field(), field({ id: "p", type: "text", role: "prefill", mergeKey: "custom:today_day" })], pages }, { settings: {} }, []).ready).toBe(true);
  });

  it("catches anything else that would make a send fail: no pages, fields on missing pages, too many fields", () => {
    expect(codes(templateReadiness({ fields: [field()], pages: [] }, { settings: {} }, []))).toContain("no_document");
    expect(codes(templateReadiness({ fields: [field(), field({ id: "off", page: 3 })], pages }, { settings: {} }, []))).toEqual(["field_off_document"]);
    const many = Array.from({ length: LIMITS.maxFieldsPerTemplate + 1 }, (_, i) => field({ id: `f${i}` }));
    expect(codes(templateReadiness({ fields: many, pages }, { settings: {} }, []))).toEqual(["too_many_fields"]);
  });

  it("lists several problems together, each with a message that says what to do", () => {
    const r = templateReadiness({ fields: [field({ id: "co", role: "company" }), field({ id: "p", type: "text", role: "prefill" })], pages }, { settings: {} }, []);
    expect(codes(r).sort()).toEqual(["no_client_signature", "no_countersigner", "prefill_unmapped"]);
    for (const p of r.problems) expect(p.message).toMatch(/\. (Add|Choose|Remove|Mark|Have|Replace)/);
  });

  it("never throws on missing or malformed input", () => {
    for (const template of [{}, { fields: null, pages: null }, { fields: "x", pages: 7 }, { fields: [null, 3, "f"], pages: [{}] }] as never[]) {
      expect(templateReadiness(template, null, null).ready).toBe(false);
      expect(templateReadiness(template, undefined, undefined).ready).toBe(false);
    }
    expect(templateReadiness(null as never, { settings: null }, []).ready).toBe(false);
  });

  it("recognises valid and invalid merge keys", () => {
    for (const ok of ["client_name", "today", "company_name", "custom:po_number", "custom:a.b-c"]) expect(isValidMergeKey(ok)).toBe(true);
    for (const bad of ["", "custom:", "custom:a b", "Client_Name", "custom:é", undefined, null, 5, {}]) expect(isValidMergeKey(bad)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("activating, default and archiving", () => {
  async function defaultsOf(orgId: string): Promise<string[]> {
    const db = await getDb();
    const rows = await db.select({ id: templates.id }).from(templates).where(and(eq(templates.orgId, orgId), eq(templates.isDefault, true)));
    return rows.map((r) => r.id);
  }

  it("refuses to activate an agreement that is not ready and says why", async () => {
    const w = await makeWorld();
    const t = await createPdfTemplate(w.owner);
    const empty = await updateTemplateFields(w.owner, t.id, [], t.version);
    const err = await expectError(activateTemplate(w.owner, empty.id), "not_ready", /not ready to use yet.*nowhere for the client to sign/);
    expect(err.status).toBe(409);
    expect(err.fields).toHaveProperty("no_client_signature");
    expect((await getTemplate(w.owner, t.id)).status).toBe("draft");

    const withCompany = await updateTemplateFields(w.owner, t.id, [field(), field({ role: "company", y: 0.8 })], empty.version);
    await expectError(activateTemplate(w.owner, withCompany.id), "not_ready", /nobody is chosen to countersign/);
  });

  it("activates once a countersigner is set, and in auto mode once they have a saved signature", async () => {
    const w = await makeWorld();
    const t = await createPdfTemplate(w.owner);
    const saved = await updateTemplateFields(w.owner, t.id, [field(), field({ role: "company", y: 0.8 })], t.version);
    const signer = await addUser(w.orgId, "admin");
    await setSettings(w.orgId, { countersignerUserId: signer.userId, countersignMode: "auto" });
    await expectError(activateTemplate(w.owner, saved.id), "not_ready", /no saved signature/);
    const db = await getDb();
    await db.update(users).set({ savedSignature: "data:image/png;base64,AAAA" }).where(eq(users.id, signer.userId));
    expect((await activateTemplate(w.owner, saved.id)).template.status).toBe("active");

    // The countersigner leaving breaks it again, and readiness says so before the next send.
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, signer.userId));
    const readiness = await getTemplateReadiness(w.owner, saved.id);
    expect(readiness.problems.map((p) => p.code)).toEqual(["countersigner_unavailable"]);
    // A countersigner id that belongs to another company never counts.
    const other = await makeWorld();
    await setSettings(w.orgId, { countersignerUserId: other.owner.userId });
    expect((await getTemplateReadiness(w.owner, saved.id)).problems.map((p) => p.code)).toEqual(["countersigner_unavailable"]);
  });

  it("makes the first active agreement the default and leaves later ones alone", async () => {
    const w = await makeWorld();
    const a = await readyTemplate(w.owner, "A");
    const b = await readyTemplate(w.owner, "B");
    const first = await activateTemplate(w.owner, a.id, { ip: "203.0.113.9" });
    expect(first).toMatchObject({ becameDefault: true, template: { status: "active", isDefault: true } });
    const second = await activateTemplate(w.owner, b.id);
    expect(second).toMatchObject({ becameDefault: false, template: { status: "active", isDefault: false } });
    expect(await defaultsOf(w.orgId)).toEqual([a.id]);

    // Activating again changes nothing and writes no second event.
    expect(await activateTemplate(w.owner, a.id)).toMatchObject({ becameDefault: false, template: { isDefault: true } });
    const activated = await eventsOf(w.orgId, "template.activated");
    expect(activated).toHaveLength(2);
    expect(activated.find((e) => e.data.templateId === a.id)).toMatchObject({ ip: "203.0.113.9", data: { becameDefault: true } });
  });

  it("switches the default so exactly one agreement holds it", async () => {
    const w = await makeWorld();
    const a = await readyTemplate(w.owner, "A");
    const b = await readyTemplate(w.owner, "B");
    const c = await readyTemplate(w.owner, "C");
    for (const t of [a, b, c]) await activateTemplate(w.owner, t.id);
    expect(await defaultsOf(w.orgId)).toEqual([a.id]);

    expect((await setDefaultTemplate(w.owner, b.id)).isDefault).toBe(true);
    expect(await defaultsOf(w.orgId)).toEqual([b.id]);
    expect((await getTemplate(w.owner, a.id)).isDefault).toBe(false);

    const [event] = await eventsOf(w.orgId, "template.default_changed");
    expect(event.data).toMatchObject({ templateId: b.id, previousTemplateId: a.id, previousName: "A" });

    // Choosing the current default again is a no-op.
    await setDefaultTemplate(w.owner, b.id);
    expect(await eventsOf(w.orgId, "template.default_changed")).toHaveLength(1);

    // Racing choices still end with exactly one default.
    await Promise.allSettled([setDefaultTemplate(w.owner, a.id), setDefaultTemplate(w.owner, c.id), setDefaultTemplate(w.owner, b.id)]);
    expect(await defaultsOf(w.orgId)).toHaveLength(1);
  });

  it("never touches another company's default", async () => {
    const a = await makeWorld();
    const b = await makeWorld();
    const ta = await readyTemplate(a.owner);
    const tb1 = await readyTemplate(b.owner);
    const tb2 = await readyTemplate(b.owner);
    await activateTemplate(a.owner, ta.id);
    await activateTemplate(b.owner, tb1.id);
    await activateTemplate(b.owner, tb2.id);
    await setDefaultTemplate(b.owner, tb2.id);
    await archiveTemplate(b.owner, tb2.id);
    expect(await defaultsOf(a.orgId)).toEqual([ta.id]);
    expect(await defaultsOf(b.orgId)).toEqual([]);
  });

  it("only lets an active, ready agreement be the default", async () => {
    const w = await makeWorld();
    const active = await readyTemplate(w.owner, "Active");
    await activateTemplate(w.owner, active.id);
    const draft = await readyTemplate(w.owner, "Draft");
    await expectError(setDefaultTemplate(w.owner, draft.id), "not_ready", /still a draft. Activate it/);
    const archived = await readyTemplate(w.owner, "Archived");
    await archiveTemplate(w.owner, archived.id);
    await expectError(setDefaultTemplate(w.owner, archived.id), "not_ready", /archived. Activate it again/);
    expect(await defaultsOf(w.orgId)).toEqual([active.id]);

    // An active agreement that has since become unsendable cannot be made the default.
    const broken = await readyTemplate(w.owner, "Broken");
    await activateTemplate(w.owner, broken.id);
    const db = await getDb();
    await db.update(templates).set({ fields: [] }).where(eq(templates.id, broken.id));
    await expectError(setDefaultTemplate(w.owner, broken.id), "not_ready", /cannot be the default/);
    expect(await defaultsOf(w.orgId)).toEqual([active.id]);
  });

  it("archiving the default clears it and says plainly that automatic sending has stopped", async () => {
    const w = await makeWorld();
    const a = await readyTemplate(w.owner, "Main agreement");
    const b = await readyTemplate(w.owner, "Other agreement");
    await activateTemplate(w.owner, a.id);
    await activateTemplate(w.owner, b.id);

    const result = await archiveTemplate(w.owner, a.id);
    expect(result).toMatchObject({ wasDefault: true, automaticSendingStopped: true, template: { status: "archived", isDefault: false } });
    expect(result.message).toMatch(/automatic sending has stopped. Choose another default agreement/);
    // Nothing is promoted silently: the company must choose.
    expect(await defaultsOf(w.orgId)).toEqual([]);
    expect((await eventsOf(w.orgId, "template.archived"))[0].data).toMatchObject({ templateId: a.id, wasDefault: true });

    const other = await archiveTemplate(w.owner, b.id);
    expect(other).toMatchObject({ wasDefault: false, automaticSendingStopped: false });
    expect(other.message).toMatch(/already sent from it are not affected/);

    const again = await archiveTemplate(w.owner, b.id);
    expect(again).toMatchObject({ automaticSendingStopped: false });
    expect(again.message).toMatch(/already archived/);
    expect(await eventsOf(w.orgId, "template.archived")).toHaveLength(2);
  });

  it("an archived agreement can be activated again and becomes the default when it is the only one", async () => {
    const w = await makeWorld();
    const a = await readyTemplate(w.owner);
    await activateTemplate(w.owner, a.id);
    await archiveTemplate(w.owner, a.id);
    expect(await activateTemplate(w.owner, a.id)).toMatchObject({ becameDefault: true, template: { status: "active", isDefault: true } });
  });
});

// ---------------------------------------------------------------------------
// Rename and duplicate
// ---------------------------------------------------------------------------

describe("renaming and duplicating", () => {
  it("renames, trims, and rejects blank or overlong names", async () => {
    const w = await makeWorld();
    const t = await createPdfTemplate(w.owner, {}, "Old name");
    const renamed = await renameTemplate(w.owner, t.id, "  New\tname  ");
    expect(renamed.name).toBe("New name");
    // Renaming changes neither the fields nor the document, so the version stays.
    expect(renamed.version).toBe(t.version);
    expect((await eventsOf(w.orgId, "template.renamed"))[0].data).toMatchObject({ templateName: "New name", previousName: "Old name" });

    await renameTemplate(w.owner, t.id, "New name");
    expect(await eventsOf(w.orgId, "template.renamed")).toHaveLength(1);

    for (const bad of ["", "   ", undefined, null, {}, []]) {
      const err = await expectError(renameTemplate(w.owner, t.id, bad), "invalid", /Give the agreement a name/);
      expect(err.fields).toHaveProperty("name");
    }
    await expectError(renameTemplate(w.owner, t.id, "n".repeat(TEMPLATE_LIMITS.nameMax + 1)), "invalid", /120 characters or fewer/);
    expect((await getTemplate(w.owner, t.id)).name).toBe("New name");
  });

  it("duplicates as an independent draft", async () => {
    const w = await makeWorld();
    const t = await readyTemplate(w.owner, "Original");
    await activateTemplate(w.owner, t.id);
    await enableIntakeLink(w.owner, t.id);

    const copy = await duplicateTemplate(w.owner, t.id);
    expect(copy).toMatchObject({ name: "Copy of Original", status: "draft", isDefault: false, intakeToken: null, version: 1, pdfBlobId: t.pdfBlobId });
    expect(copy.id).not.toBe(t.id);
    expect(copy.fields).toEqual(t.fields);
    expect((await duplicateTemplate(w.owner, t.id, "Second copy")).name).toBe("Second copy");

    // Changing the copy leaves the original alone, and the other way round.
    await updateTemplateFields(w.owner, copy.id, [field({ id: "only-in-copy" })], copy.version);
    expect((await getTemplate(w.owner, t.id)).fields).toEqual(t.fields);
    await replaceTemplateDocument(w.owner, t.id, { bytes: await agreementPdf({ pages: 3 }), filename: "new.pdf" });
    const copyAfter = await getTemplate(w.owner, copy.id);
    expect(copyAfter.pdfBlobId).toBe(t.pdfBlobId);
    // The shared PDF is still there for the copy even though the original moved on.
    expect((await getTemplatePdf(w.owner, copy.id)).bytes.byteLength).toBeGreaterThan(0);
  });

  it("keeps a duplicate's name within the limit", async () => {
    const w = await makeWorld();
    const t = await createPdfTemplate(w.owner, {}, "n".repeat(TEMPLATE_LIMITS.nameMax));
    expect((await duplicateTemplate(w.owner, t.id)).name.length).toBeLessThanOrEqual(TEMPLATE_LIMITS.nameMax);
  });
});

// ---------------------------------------------------------------------------
// Re-detection and replacing the document
// ---------------------------------------------------------------------------

describe("redetectFields and replaceTemplateDocument", () => {
  it("re-runs detection, replacing manual edits and bumping the version", async () => {
    const w = await makeWorld();
    const created = await createPdfTemplate(w.owner);
    const edited = await updateTemplateFields(w.owner, created.id, [field({ id: "manual-only", x: 0.5, y: 0.05 })], created.version);

    const redone = await redetectFields(w.owner, created.id, edited.version);
    expect(redone.version).toBe(edited.version + 1);
    expect(redone.fields.some((f) => f.id === "manual-only")).toBe(false);
    expect(hasRequiredClientSignature(redone.fields)).toBe(true);
    expect(redone.fields.map((f) => [f.type, f.role, f.page])).toEqual(created.fields.map((f) => [f.type, f.role, f.page]));
    expect(redone.pages).toEqual(created.pages);
    expect((await eventsOf(w.orgId, "template.fields_redetected"))[0].data).toMatchObject({ templateId: created.id, version: redone.version });
  });

  it("does not stack a second signature page when detection appended one the first time", async () => {
    const w = await makeWorld();
    const created = await createTemplateFromPageImages(w.owner, { images: [{ bytes: makePng(60, 80), widthPt: 612, heightPt: 792 }], name: "Scan" });
    expect(created.detection?.signaturePageAppended).toBe(true);
    const once = await redetectFields(w.owner, created.id);
    const twice = await redetectFields(w.owner, created.id);
    expect(once.pages).toHaveLength(created.pages.length);
    expect(twice.pages).toHaveLength(created.pages.length);
    expect(twice.version).toBe(created.version + 2);
  });

  it("refuses to re-detect over someone else's newer edit", async () => {
    const w = await makeWorld();
    const created = await createPdfTemplate(w.owner);
    await updateTemplateFields(w.owner, created.id, [field({ id: "keep-me" })], created.version);
    await expectError(redetectFields(w.owner, created.id, created.version), "conflict", /Someone else changed/);
    expect((await getTemplate(w.owner, created.id)).fields.map((f) => f.id)).toEqual(["keep-me"]);
  });

  it("replaces the document: new PDF, fresh fields, version bump, name and status kept", async () => {
    const w = await makeWorld();
    const t = await readyTemplate(w.owner, "Engagement letter");
    const { template: active } = await activateTemplate(w.owner, t.id);
    const link = await enableIntakeLink(w.owner, t.id);

    const replaced = await replaceTemplateDocument(w.owner, t.id, { bytes: await agreementPdf({ pages: 3, title: "Revised Test Agreement" }), filename: "revised.pdf", mimeType: "application/pdf" }, active.version);
    expect(replaced).toMatchObject({ id: t.id, name: "Engagement letter", status: "active", isDefault: true, intakeToken: link.token, version: active.version + 1 });
    expect(replaced.pdfBlobId).not.toBe(t.pdfBlobId);
    expect(replaced.sourceBlobId).not.toBe(t.sourceBlobId);
    expect(replaced.pages).toHaveLength(3);
    expect(hasRequiredClientSignature(replaced.fields)).toBe(true);
    const text = await extractText((await getTemplatePdf(w.owner, t.id)).bytes);
    expect(text.pageText.join(" ")).toContain("Revised Test Agreement");
    expect((await eventsOf(w.orgId, "template.document_replaced"))[0].data).toMatchObject({ templateId: t.id, pages: 3 });

    // The old document is no longer referenced by anything, so it is not kept around.
    const db = await getDb();
    expect(await db.select({ id: blobs.id }).from(blobs).where(eq(blobs.id, t.pdfBlobId))).toHaveLength(0);
  });

  it("leaves envelopes that were already sent exactly as they were", async () => {
    const w = await makeWorld();
    const t = await readyTemplate(w.owner);
    const envelopeId = await addEnvelope(w.orgId, t, "sent", true);
    const before = (await getTemplatePdf(w.owner, t.id)).bytes;

    await replaceTemplateDocument(w.owner, t.id, { bytes: await agreementPdf({ pages: 2 }), filename: "v2.pdf" });
    await redetectFields(w.owner, t.id);

    const db = await getDb();
    const [envelope] = await db.select().from(envelopes).where(eq(envelopes.id, envelopeId));
    expect(envelope).toMatchObject({ pdfBlobId: t.pdfBlobId, templateVersion: t.version, fields: t.fields, pages: t.pages });
    const [snapshot] = await db.select().from(blobs).where(eq(blobs.id, envelope.pdfBlobId));
    expect(Buffer.from(snapshot.bytes).equals(Buffer.from(before))).toBe(true);
  });

  it("keeps the current document when the replacement cannot be used", async () => {
    const w = await makeWorld();
    const t = await readyTemplate(w.owner);
    const locked = await expectDocumentError(replaceTemplateDocument(w.owner, t.id, { bytes: await encryptedPdf(), filename: "locked.pdf" }), "password_protected");
    expect(locked.pageImageFallback).toBe(true);
    await expectDocumentError(replaceTemplateDocument(w.owner, t.id, { bytes: new Uint8Array(0), filename: "empty.pdf" }), "empty");
    await expectDocumentError(replaceTemplateDocument(w.owner, t.id, undefined as never), "empty");
    await expectError(replaceTemplateDocument(w.owner, t.id, { bytes: await agreementPdf(), filename: "x.pdf" }, t.version + 5), "conflict");
    expect(await getTemplate(w.owner, t.id)).toMatchObject({ version: t.version, pdfBlobId: t.pdfBlobId, fields: t.fields });
    const db = await getDb();
    const stored = await db.select({ id: blobs.id }).from(blobs).where(eq(blobs.orgId, w.orgId));
    expect(stored.map((b) => b.id).sort()).toEqual([...new Set([t.pdfBlobId, t.sourceBlobId!])].sort());
  });

  it("says what to do when the stored document has become unreadable", async () => {
    const w = await makeWorld();
    const t = await readyTemplate(w.owner);
    const db = await getDb();
    const stray = newId("blob");
    const damaged = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(600, 0x41)]);
    await db.insert(blobs).values({ id: stray, orgId: w.orgId, bytes: damaged, sha256: "0".repeat(64), contentType: "application/pdf", size: damaged.length });
    await db.update(templates).set({ pdfBlobId: stray, sourceBlobId: null }).where(eq(templates.id, t.id));
    const err = await expectDocumentError(redetectFields(w.owner, t.id), "corrupt");
    expect(err.message).toMatch(/upload/i);
    await expectDocumentError(previewTemplatePdf(w.owner, t.id), "corrupt");
    expect((await getTemplate(w.owner, t.id)).version).toBe(t.version);
  });
});

// ---------------------------------------------------------------------------
// Intake link
// ---------------------------------------------------------------------------

describe("intake link", () => {
  it("turns on for an active agreement, resolves publicly, and turns off", async () => {
    const w = await makeWorld("Harbour Test Ltd");
    const t = await readyTemplate(w.owner);
    await expectError(enableIntakeLink(w.owner, t.id), "not_ready", /Activate this agreement first/);
    await activateTemplate(w.owner, t.id);

    const link = await enableIntakeLink(w.owner, t.id);
    expect(link.token).toMatch(/^[0-9a-z]{32}$/);
    expect(link.url.endsWith(`/intake/${link.token}`)).toBe(true);
    expect(link.template.intakeToken).toBe(link.token);
    // Asking again gives the same link rather than breaking one already shared.
    expect((await enableIntakeLink(w.owner, t.id)).token).toBe(link.token);
    expect(await eventsOf(w.orgId, "template.intake_enabled")).toHaveLength(1);
    // The audit trail never holds the secret itself.
    expect(JSON.stringify(await eventsOf(w.orgId, "template.intake_enabled"))).not.toContain(link.token);

    const found = await getTemplateByIntakeToken(link.token);
    expect(found?.template.id).toBe(t.id);
    expect(found?.org).toMatchObject({ id: w.orgId, name: "Harbour Test Ltd" });

    const off = await disableIntakeLink(w.owner, t.id);
    expect(off.intakeToken).toBeNull();
    expect(await getTemplateByIntakeToken(link.token)).toBeNull();
    await disableIntakeLink(w.owner, t.id);
    expect(await eventsOf(w.orgId, "template.intake_disabled")).toHaveLength(1);

    // Turning it back on gives a new link; the old one stays dead.
    const fresh = await enableIntakeLink(w.owner, t.id);
    expect(fresh.token).not.toBe(link.token);
    expect(await getTemplateByIntakeToken(link.token)).toBeNull();
  });

  it("returns null for anything that is not a live link", async () => {
    for (const token of [undefined, null, "", "short", "x".repeat(32).toUpperCase(), "a".repeat(33), 42, {}, "' OR '1'='1", "a".repeat(32)]) {
      expect(await getTemplateByIntakeToken(token)).toBeNull();
    }
  });

  it("stops working when the agreement is archived, and does not come back on reactivation", async () => {
    const w = await makeWorld();
    const t = await readyTemplate(w.owner);
    await activateTemplate(w.owner, t.id);
    const link = await enableIntakeLink(w.owner, t.id);
    const archived = await archiveTemplate(w.owner, t.id);
    expect(archived.message).toMatch(/intake link no longer works/);
    expect(await getTemplateByIntakeToken(link.token)).toBeNull();
    await activateTemplate(w.owner, t.id);
    expect(await getTemplateByIntakeToken(link.token)).toBeNull();
    expect((await getTemplate(w.owner, t.id)).intakeToken).toBeNull();
  });

  it("will not open a link on an agreement that cannot be sent", async () => {
    const w = await makeWorld();
    const t = await readyTemplate(w.owner);
    await activateTemplate(w.owner, t.id);
    const db = await getDb();
    await db.update(templates).set({ fields: [] }).where(eq(templates.id, t.id));
    await expectError(enableIntakeLink(w.owner, t.id), "not_ready", /cannot take clients/);
  });
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

describe("previewTemplatePdf", () => {
  it("stamps realistic sample values where the fields are, without changing the stored agreement", async () => {
    const w = await makeWorld("Harbour Test Ltd");
    const signer = await addUser(w.orgId, "admin", { name: "Casey Countersigner", title: "Managing Partner" });
    await setSettings(w.orgId, { countersignerUserId: signer.userId, fileReferencePrefix: "HT" });
    const t = await createPdfTemplate(w.owner);
    const fields: Field[] = [
      field({ id: "sig", y: 0.3, h: 0.06 }),
      field({ id: "initials", type: "initials", y: 0.38, w: 0.08, required: false }),
      field({ id: "name", type: "full_name", y: 0.45, h: 0.03 }),
      field({ id: "email", type: "email", y: 0.5, h: 0.03, required: false }),
      field({ id: "signed", type: "date_signed", y: 0.55, h: 0.03 }),
      field({ id: "tick", type: "checkbox", y: 0.6, w: 0.03, h: 0.02, required: false }),
      field({ id: "ref", type: "text", role: "prefill", mergeKey: "file_reference", y: 0.05, h: 0.03, required: false }),
      field({ id: "co", type: "company", role: "prefill", mergeKey: "company_name", y: 0.09, h: 0.03, required: false }),
      field({ id: "custom", type: "text", role: "prefill", mergeKey: "custom:matter", x: 0.5, y: 0.05, h: 0.03, required: false }),
      field({ id: "cosig", role: "company", x: 0.55, y: 0.3, h: 0.06 }),
      field({ id: "coname", type: "full_name", role: "company", x: 0.55, y: 0.45, h: 0.03 }),
      field({ id: "cotitle", type: "title", role: "company", x: 0.55, y: 0.5, h: 0.03, required: false }),
    ];
    const saved = await updateTemplateFields(w.owner, t.id, fields, t.version);
    const original = (await getTemplatePdf(w.owner, t.id)).bytes;

    const preview = await previewTemplatePdf(w.owner, t.id);
    expect(Buffer.from(preview.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect((await PDFDocument.load(preview)).getPageCount()).toBe(saved.pages.length);
    expect(Buffer.from(preview).equals(Buffer.from(original))).toBe(false);

    const text = (await extractText(preview)).pageText.join("\n");
    const year = new Date().getUTCFullYear();
    for (const expected of ["Jordan Sample", "jordan.sample@example.com", `HT-${year}-0001`, "Harbour Test Ltd", "Casey Countersigner", "Managing Partner", String(year)]) {
      expect(text).toContain(expected);
    }
    // Text lands where the field is, not somewhere else on the page.
    const items = (await extractText(preview)).items.filter((i) => i.text.includes("Casey"));
    expect(items).toHaveLength(1);
    expect(items[0].x).toBeGreaterThan(0.5);
    expect(items[0].y).toBeGreaterThan(0.43);
    expect(items[0].y).toBeLessThan(0.5);

    // Nothing was stored or changed by previewing.
    expect(Buffer.from((await getTemplatePdf(w.owner, t.id)).bytes).equals(Buffer.from(original))).toBe(true);
    expect((await getTemplate(w.owner, t.id)).version).toBe(saved.version);
  });

  it("works for a draft with no fields and for an agreement with no countersigner", async () => {
    const w = await makeWorld();
    const t = await createPdfTemplate(w.owner, { company: true });
    expect((await PDFDocument.load(await previewTemplatePdf(w.owner, t.id))).getPageCount()).toBe(t.pages.length);
    const empty = await updateTemplateFields(w.owner, t.id, [], t.version);
    expect((await PDFDocument.load(await previewTemplatePdf(w.owner, empty.id))).getPageCount()).toBe(t.pages.length);
  });

  it("survives fields that were stored in a broken state", async () => {
    const w = await makeWorld();
    const t = await createPdfTemplate(w.owner);
    const db = await getDb();
    const junk = [null, 7, { id: "x" }, field({ page: 99 }), field({ x: Number.NaN as never }), field({ type: "unknown" as never })] as never;
    await db.update(templates).set({ fields: junk }).where(eq(templates.id, t.id));
    expect((await previewTemplatePdf(w.owner, t.id)).byteLength).toBeGreaterThan(0);
    expect((await listTemplates(w.owner))[0].readiness.ready).toBe(false);
  });
});
