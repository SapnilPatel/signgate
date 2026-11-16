import { describe, it, expect, vi, beforeEach } from "vitest";
import { deflateSync } from "node:zlib";
import { and, asc, eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";

const seal = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock("@/lib/pdf", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/pdf")>();
  return {
    ...real,
    sealDocument: async (input: Parameters<typeof real.sealDocument>[0]) => {
      seal.calls++;
      if (seal.fail) throw new Error("simulated sealing failure");
      return real.sealDocument(input);
    },
  };
});

import { getDb } from "@/lib/db";
import { envelopes, events, files, orgs, rateLimits, signers, templates, users, webhookDeliveries, webhooks, type Envelope, type FileRow, type Org, type Signer, type Template, type User } from "@/lib/db/schema";
import { newId, sha256Hex } from "@/lib/ids";
import type { Field, OrgSettings } from "@/lib/types";
import { ServiceError, type Actor } from "@/lib/services/context";
import { putBlob } from "@/lib/services/blobs";
import { clearTestOutbox, getTestOutbox } from "@/lib/services/email";
import { sendAgreementForFile, voidEnvelope } from "@/lib/services/envelopes";
import { FINALIZE_FAILED_EVENT, calendarParts, inTransaction, isRetryableTxError, linkDeadEmail, orgTimeZone, declineSigning, finalizeEnvelope, getSignedCopy, getSigningDocument, getSigningSession, listUnsealedEnvelopeIds, longDate, maskEmail, signedDateLabel, submitSigning, validateSignerValues, verifyDocument } from "@/lib/services/signing";
import { findSignerBySecret, hashSigningSecret, signingSecret, signingUrl } from "@/lib/services/tokens";
import { runScheduledJobs } from "@/lib/services/jobs";

// ---------------------------------------------------------------------------
// Fixtures (test data only; duplicated across the lifecycle test files on purpose,
// because each test file runs in its own process with its own database)
// ---------------------------------------------------------------------------

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** A real RGBA PNG, so it passes the strict signature validation. */
function makePng(width = 40, height = 12): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x++) row.set([20, 30, 90, x % 3 === 0 ? 255 : 0], 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

const SIGNATURE = `data:image/png;base64,${makePng().toString("base64")}`;

async function makePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.drawText("Client Services Agreement", { x: 72, y: 700, size: 16 });
  page.drawText("The client engages the company on the terms set out here.", { x: 72, y: 670, size: 11 });
  return doc.save();
}

let seq = 0;
const next = () => ++seq;

function field(id: string, type: Field["type"], role: Field["role"], required: boolean, extra: Partial<Field> = {}): Field {
  const n = next();
  return { id, page: 0, x: 0.1, y: 0.2 + (n % 12) * 0.05, w: 0.3, h: 0.04, type, role, required, label: id.replace(/_/g, " "), source: "manual", ...extra };
}

const clientFields = (): Field[] => [
  field("c_sig", "signature", "client", true, { label: "Client signature" }),
  field("c_name", "full_name", "client", true, { label: "Printed name" }),
  field("c_date", "date_signed", "client", true),
  field("c_note", "text", "client", false, { label: "Note" }),
  field("c_email", "email", "client", false, { label: "Billing email" }),
  field("c_agree", "checkbox", "client", false, { label: "I agree to the fee schedule" }),
];
const prefillFields = (): Field[] => [
  field("p_name", "text", "prefill", false, { mergeKey: "client_name" }),
  field("p_ref", "text", "prefill", false, { mergeKey: "file_reference" }),
  field("p_today", "date", "prefill", false, { mergeKey: "today" }),
  field("p_matter", "text", "prefill", false, { mergeKey: "custom:matter" }),
  field("p_day", "text", "prefill", false, { mergeKey: "custom:today_day" }),
];
const companyFields = (): Field[] => [
  field("k_sig", "signature", "company", true, { label: "Company signature" }),
  field("k_name", "full_name", "company", true),
  field("k_date", "date_signed", "company", true),
  field("k_title", "title", "company", false),
];

interface World {
  org: Org;
  owner: User;
  actor: Actor;
  template: Template;
}

async function addUser(orgId: string, role: User["role"], extra: Partial<User> = {}): Promise<User> {
  const db = await getDb();
  const n = next();
  const [user] = await db
    .insert(users)
    .values({ id: newId("usr"), orgId, email: `team${n}@company.test`, name: `Team Member ${n}`, title: "Director", passwordHash: "not-a-real-hash", role, ...extra })
    .returning();
  return user;
}

const actorFor = (user: User): Actor => ({ type: "user", orgId: user.orgId, userId: user.id, role: user.role, label: `${user.name} (${user.email})` });

async function makeWorld(opts: { company?: boolean; settings?: OrgSettings; fields?: Field[]; templateStatus?: Template["status"]; noTemplate?: boolean } = {}): Promise<World> {
  const db = await getDb();
  const n = next();
  const [org] = await db
    .insert(orgs)
    .values({ id: newId("org"), name: `Northwind Test ${n}`, legalName: `Northwind Test ${n} Ltd`, slug: `northwind-${n}`, settings: opts.settings ?? {} })
    .returning();
  const owner = await addUser(org.id, "owner");
  const blob = await putBlob(db, { orgId: org.id, bytes: await makePdf(), contentType: "application/pdf", filename: "agreement.pdf" });
  const fields = opts.fields ?? [...prefillFields(), ...clientFields(), ...(opts.company ? companyFields() : [])];
  const [template] = await db
    .insert(templates)
    .values({
      id: newId("tpl"),
      orgId: org.id,
      name: "Client Services Agreement",
      status: opts.noTemplate ? "archived" : (opts.templateStatus ?? "active"),
      isDefault: !opts.noTemplate,
      pdfBlobId: blob.id,
      pages: [{ width: 612, height: 792 }],
      fields,
      version: 3,
      createdBy: owner.id,
    })
    .returning();
  return { org, owner, actor: actorFor(owner), template };
}

async function setSettings(orgId: string, settings: OrgSettings): Promise<void> {
  const db = await getDb();
  await db.update(orgs).set({ settings }).where(eq(orgs.id, orgId));
}

async function makeFile(orgId: string, extra: Partial<FileRow> = {}): Promise<FileRow> {
  const db = await getDb();
  const n = next();
  const [file] = await db
    .insert(files)
    .values({
      id: newId("file"),
      orgId,
      reference: `F-2026-${String(n).padStart(4, "0")}`,
      clientName: `Casey Example ${n}`,
      clientEmail: `client${n}@client.test`,
      clientCompany: "Example Holdings",
      clientTitle: "Managing Partner",
      data: { matter: "Lease review" },
      ...extra,
    })
    .returning();
  return file;
}

const secretOf = (url: string) => url.split("/sign/")[1];

async function envelopeRow(id: string): Promise<Envelope> {
  const db = await getDb();
  const [row] = await db.select().from(envelopes).where(eq(envelopes.id, id));
  return row;
}
async function signerRows(envelopeId: string): Promise<Signer[]> {
  const db = await getDb();
  return db.select().from(signers).where(eq(signers.envelopeId, envelopeId)).orderBy(asc(signers.order));
}
async function fileRow(id: string): Promise<FileRow> {
  const db = await getDb();
  const [row] = await db.select().from(files).where(eq(files.id, id));
  return row;
}
async function eventTypes(envelopeId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select().from(events).where(eq(events.envelopeId, envelopeId)).orderBy(asc(events.createdAt), asc(events.id));
  return rows.map((r) => r.type);
}
const count = (list: string[], type: string) => list.filter((t) => t === type).length;
const mailTo = (email: string, kind?: string) => getTestOutbox().filter((m) => m.to === email && (!kind || m.kind === kind));

async function expectServiceError(promise: Promise<unknown>, code: ServiceError["code"]): Promise<ServiceError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, `expected a ServiceError(${code}) but the call succeeded`).toBeInstanceOf(ServiceError);
  expect((err as ServiceError).code).toBe(code);
  expect((err as ServiceError).message.length).toBeGreaterThan(10);
  return err as ServiceError;
}

/** Sends the agreement for a new file and returns what a test usually needs. */
async function sendOne(world: World, fileExtra: Partial<FileRow> = {}) {
  const file = await makeFile(world.org.id, fileExtra);
  const sent = await sendAgreementForFile(world.actor, file.id);
  return { file, ...sent, secret: secretOf(sent.signingUrl) };
}

const goodValues = (extra: Record<string, unknown> = {}) => ({ c_sig: SIGNATURE, ...extra });
const sign = (secret: string, extra: Record<string, unknown> = {}, input: Record<string, unknown> = {}) =>
  submitSigning(secret, { values: goodValues(extra), consent: true, ...input }, { ip: "203.0.113.9", userAgent: "TestBrowser/1.0" });

beforeEach(() => {
  clearTestOutbox();
  seal.fail = false;
});

// ---------------------------------------------------------------------------

describe("link secrets", () => {
  it("derives the link from the server secret and stores only its hash", async () => {
    const world = await makeWorld();
    const { envelopeId, signingUrl: url, secret } = await sendOne(world);
    const [client] = await signerRows(envelopeId);
    expect(url).toBe(signingUrl(client));
    expect(secret).toBe(signingSecret(client.id, client.tokenNonce));
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(client.tokenHash).toBe(hashSigningSecret(secret));
    // Nothing stored anywhere equals or contains the secret itself.
    expect(JSON.stringify(client)).not.toContain(secret);
    const db = await getDb();
    const trail = await db.select().from(events).where(eq(events.envelopeId, envelopeId));
    expect(JSON.stringify(trail)).not.toContain(secret);
    expect((await findSignerBySecret(secret))?.id).toBe(client.id);
  });

  it("treats anything that is not a live link as unknown, without throwing", async () => {
    const strange: unknown[] = [undefined, null, "", "x", 42, {}, [], "a".repeat(43), "a".repeat(5000), "../../etc/passwd", "\u0000".repeat(43), { toString: () => "boom" }];
    for (const value of strange) {
      const session = await getSigningSession(value);
      expect(session.state).toBe("unknown");
      expect(session.message).toMatch(/not valid/);
      await expectServiceError(getSigningDocument(value), "not_found");
      await expectServiceError(getSignedCopy(value), "not_found");
      await expectServiceError(submitSigning(value, { consent: true, values: {} }), "not_found");
      await expectServiceError(declineSigning(value, "no"), "not_found");
    }
  });
});

describe("signing page", () => {
  it("gives the page the signer's own fields, read-only prefill, and records the first view exactly once", async () => {
    const world = await makeWorld({ company: true });
    const { envelopeId, secret, file } = await sendOne(world);

    const [a, b] = await Promise.all([getSigningSession(secret, { ip: "198.51.100.1" }), getSigningSession(secret, { ip: "198.51.100.1" })]);
    const again = await getSigningSession(secret);
    for (const session of [a, b, again]) {
      expect(session.state).toBe("ready");
      if (session.state !== "ready") throw new Error("unreachable");
      expect(session.org.name).toBe(world.org.name);
      expect(session.agreementName).toBe("Client Services Agreement");
      expect(session.fileReference).toBe(file.reference);
      expect(session.fields.map((f) => f.id).sort()).toEqual(["c_agree", "c_date", "c_email", "c_name", "c_note", "c_sig"]);
      expect(session.fields.every((f) => f.role === "client")).toBe(true);
      expect(session.defaults.c_name).toBe(file.clientName);
      const readOnly = Object.fromEntries(session.readOnly.map((r) => [r.fieldId, r.value]));
      expect(readOnly.p_name).toBe(file.clientName);
      expect(readOnly.p_ref).toBe(file.reference);
      expect(readOnly.p_matter).toBe("Lease review");
      // Nothing about the company's side, the link or other signers leaks into the session.
      expect(JSON.stringify(session)).not.toContain("k_sig");
      expect(JSON.stringify(session)).not.toContain(world.owner.email);
      expect(JSON.stringify(session)).not.toContain("tokenNonce");
    }
    expect(count(await eventTypes(envelopeId), "envelope.viewed")).toBe(1);
    expect((await envelopeRow(envelopeId)).status).toBe("viewed");
    const [client] = await signerRows(envelopeId);
    expect(client.status).toBe("viewed");
    expect(client.viewedAt).toBeInstanceOf(Date);
  });

  it("serves the agreement with prefilled values stamped in", async () => {
    const world = await makeWorld();
    const { secret } = await sendOne(world);
    const doc = await getSigningDocument(secret);
    expect(doc.contentType).toBe("application/pdf");
    expect(doc.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const loaded = await PDFDocument.load(doc.bytes);
    expect(loaded.getPageCount()).toBe(1);
    expect(doc.filename).toMatch(/\.pdf$/);
  });

  it("tells the countersigner it is not their turn until the client has signed", async () => {
    const world = await makeWorld({ company: true });
    const { envelopeId } = await sendOne(world);
    const [, company] = await signerRows(envelopeId);
    const companySecret = secretOf(signingUrl(company));
    const session = await getSigningSession(companySecret);
    expect(session.state).toBe("not_your_turn");
    if (session.state === "unknown") throw new Error("unreachable");
    expect(session.fields).toEqual([]);
    await expectServiceError(submitSigning(companySecret, { consent: true, values: { k_sig: SIGNATURE } }), "conflict");
    await expectServiceError(declineSigning(companySecret, "not yet"), "conflict");
    expect((await signerRows(envelopeId))[1].status).toBe("waiting");
    expect(count(await eventTypes(envelopeId), "envelope.viewed")).toBe(0);
  });
});

describe("happy paths", () => {
  it("client-only agreement: sign, seal, email everyone, download and verify", async () => {
    const world = await makeWorld();
    const db = await getDb();
    await db.insert(webhooks).values({ id: newId("whk"), orgId: world.org.id, url: "https://hooks.example.test/in", secret: "whsec_test_only" });
    const { envelopeId, secret, file } = await sendOne(world);
    await getSigningSession(secret);

    const result = await sign(secret, { c_note: "  Please call before starting.  ", c_agree: true }, { timezone: "Europe/London" });
    expect(result).toMatchObject({ status: "signed", completed: true, next: "completed" });

    const envelope = await envelopeRow(envelopeId);
    expect(envelope.status).toBe("completed");
    expect(envelope.completedAt).toBeInstanceOf(Date);
    expect(envelope.finalBlobId).toBeTruthy();
    expect(envelope.finalSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope.nextReminderAt).toBeNull();
    expect((await fileRow(file.id)).agreementStatus).toBe("signed");

    const [client] = await signerRows(envelopeId);
    expect(client.status).toBe("signed");
    expect(client.values.c_note).toBe("Please call before starting.");
    expect(client.values.c_agree).toBe(true);
    expect(client.values.c_name).toBe(file.clientName);
    expect(client.values.c_date).toBe(longDate(client.signedAt!, "Europe/London"));
    expect(client.consentAt).toBeInstanceOf(Date);
    expect(client.ip).toBe("203.0.113.9");
    expect(client.userAgent).toBe("TestBrowser/1.0");

    const types = await eventTypes(envelopeId);
    expect(types).toEqual(["envelope.created", "envelope.sent", "envelope.viewed", "signer.consented", "signer.signed", "envelope.completed"]);

    // The client and the sender each get the completed copy, attached and with a link.
    for (const to of [file.clientEmail, world.owner.email]) {
      const [mail] = mailTo(to, "completed");
      expect(mail, `completed email to ${to}`).toBeTruthy();
      expect(mail.attachments).toHaveLength(1);
      expect(sha256Hex(mail.attachments[0].content)).toBe(envelope.finalSha256);
      expect(mail.text).toMatch(/https?:\/\//);
    }
    expect(mailTo(file.clientEmail, "completed")[0].text).toContain(`/sign/${secret}`);

    const copy = await getSignedCopy(secret);
    expect(copy.sha256).toBe(envelope.finalSha256);
    expect(sha256Hex(copy.bytes)).toBe(envelope.finalSha256);
    expect((await PDFDocument.load(copy.bytes)).getPageCount()).toBeGreaterThan(1);

    const session = await getSigningSession(secret);
    expect(session.state).toBe("completed");
    if (session.state === "unknown") throw new Error("unreachable");
    expect(session.canDownloadSigned).toBe(true);
    expect(session.fields).toEqual([]);

    const verified = await verifyDocument({ sha256: envelope.finalSha256!.toUpperCase() });
    expect(verified).toEqual({
      found: true,
      organization: world.org.legalName,
      agreementName: "Client Services Agreement",
      completedAt: envelope.completedAt!.toISOString(),
      signers: [{ role: "client", name: file.clientName, email: maskEmail(file.clientEmail), signedAt: client.signedAt!.toISOString() }],
    });
    expect(JSON.stringify(verified)).not.toContain(file.clientEmail);

    const queued = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.orgId, world.org.id)).orderBy(asc(webhookDeliveries.createdAt));
    expect(queued.map((q) => q.event).sort()).toEqual(["agreement.completed", "agreement.sent", "agreement.signed", "agreement.viewed"]);
  });

  it("manual countersign through the countersigner's emailed link", async () => {
    const world = await makeWorld({ company: true });
    const signatory = await addUser(world.org.id, "member", { title: "Head of Operations" });
    await setSettings(world.org.id, { countersignerUserId: signatory.id });
    const { envelopeId, secret, file } = await sendOne(world);

    const first = await sign(secret);
    expect(first).toMatchObject({ status: "signed", completed: false, next: "awaiting_countersignature" });
    expect(first.message).toContain(world.org.name);
    expect((await envelopeRow(envelopeId)).status).toBe("client_signed");
    expect((await fileRow(file.id)).agreementStatus).toBe("awaiting_countersign");
    await expectServiceError(getSignedCopy(secret), "not_ready");
    expect((await getSigningSession(secret)).state).toBe("signed");

    const [request] = mailTo(signatory.email, "countersign_request");
    expect(request).toBeTruthy();
    const [, company] = await signerRows(envelopeId);
    expect(company.status).toBe("sent");
    expect(company.userId).toBe(signatory.id);
    const companySecret = secretOf(signingUrl(company));
    expect(request.text).toContain(companySecret);

    const session = await getSigningSession(companySecret);
    expect(session.state).toBe("ready");
    if (session.state !== "ready") throw new Error("unreachable");
    expect(session.fields.every((f) => f.role === "company")).toBe(true);
    expect(session.defaults.k_title).toBe("Head of Operations");
    // The client's typed values are visible to overlay; their signature image is in the PDF, not the session.
    const clientName = session.readOnly.find((r) => r.fieldId === "c_name");
    expect(clientName?.value).toBe(file.clientName);
    expect(session.readOnly.find((r) => r.fieldId === "c_sig")).toMatchObject({ isImage: true, value: null });

    const done = await submitSigning(companySecret, { consent: true, values: { k_sig: SIGNATURE } }, { ip: "203.0.113.20" });
    expect(done).toMatchObject({ completed: true, next: "completed" });
    const envelope = await envelopeRow(envelopeId);
    expect(envelope.status).toBe("completed");
    expect((await fileRow(file.id)).agreementStatus).toBe("signed");
    const types = await eventTypes(envelopeId);
    expect(count(types, "signer.signed")).toBe(1);
    expect(count(types, "envelope.countersigned")).toBe(1);
    expect(count(types, "envelope.completed")).toBe(1);
    expect(mailTo(file.clientEmail, "completed")).toHaveLength(1);
    expect(mailTo(signatory.email, "completed")).toHaveLength(1);
    expect(mailTo(world.owner.email, "completed")).toHaveLength(1);
    // Both signers can fetch the sealed copy from their own link.
    expect((await getSignedCopy(secret)).sha256).toBe(envelope.finalSha256);
    expect((await getSignedCopy(companySecret)).sha256).toBe(envelope.finalSha256);
    const verified = await verifyDocument({ sha256: envelope.finalSha256 });
    expect(verified.found && verified.signers.map((s) => s.role)).toEqual(["client", "company"]);
  });

  it("automatic countersign applies the saved signature the moment the client signs", async () => {
    const world = await makeWorld({ company: true });
    const signatory = await addUser(world.org.id, "admin", { savedSignature: SIGNATURE, title: "Managing Director" });
    await setSettings(world.org.id, { countersignerUserId: signatory.id, countersignMode: "auto" });
    const { envelopeId, secret, file } = await sendOne(world);

    const result = await sign(secret);
    expect(result).toMatchObject({ completed: true, next: "completed" });
    const [client, company] = await signerRows(envelopeId);
    expect(client.status).toBe("signed");
    expect(company.status).toBe("signed");
    expect(company.values.k_sig).toBe(SIGNATURE);
    expect(company.values.k_name).toBe(signatory.name);
    expect(company.values.k_title).toBe("Managing Director");
    expect(company.values.k_date).toBe(client.values.c_date);
    expect((await envelopeRow(envelopeId)).status).toBe("completed");
    expect((await fileRow(file.id)).agreementStatus).toBe("signed");
    const db = await getDb();
    const [auto] = await db.select().from(events).where(and(eq(events.envelopeId, envelopeId), eq(events.type, "envelope.countersigned")));
    expect(auto.actorType).toBe("system");
    expect(auto.data).toMatchObject({ auto: true, method: "auto" });
    // Nobody is asked to countersign when it happened automatically.
    expect(mailTo(signatory.email, "countersign_request")).toHaveLength(0);
    expect(mailTo(signatory.email, "completed")).toHaveLength(1);
  });

  it("automatic mode falls back to asking a person when a company field needs one", async () => {
    const world = await makeWorld({
      fields: [...clientFields(), ...companyFields(), field("k_terms", "text", "company", true, { label: "Agreed fee" })],
    });
    await db_setSignature(world.owner.id);
    await setSettings(world.org.id, { countersignerUserId: world.owner.id, countersignMode: "auto" });
    const { envelopeId, secret } = await sendOne(world);
    const result = await sign(secret);
    expect(result.next).toBe("awaiting_countersignature");
    expect((await signerRows(envelopeId))[1].status).toBe("sent");
    expect(mailTo(world.owner.email, "countersign_request")).toHaveLength(1);
  });
});

async function db_setSignature(userId: string): Promise<void> {
  const db = await getDb();
  await db.update(users).set({ savedSignature: SIGNATURE }).where(eq(users.id, userId));
}

describe("submitting exactly once", () => {
  it("a double submit returns the same success and records one signature", async () => {
    const world = await makeWorld();
    const { envelopeId, secret } = await sendOne(world);
    const first = await sign(secret);
    const firstSigner = (await signerRows(envelopeId))[0];
    const second = await sign(secret, { c_note: "a different note the second time" });
    const third = await submitSigning(secret, { consent: false, values: "garbage" });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    const after = (await signerRows(envelopeId))[0];
    expect(after.signedAt).toEqual(firstSigner.signedAt);
    expect(after.values).toEqual(firstSigner.values);
    const types = await eventTypes(envelopeId);
    expect(count(types, "signer.signed")).toBe(1);
    expect(count(types, "signer.consented")).toBe(1);
    expect(count(types, "envelope.completed")).toBe(1);
    expect(getTestOutbox().filter((m) => m.kind === "completed" && m.envelopeId === envelopeId)).toHaveLength(2);
  });

  it("two concurrent submits of the same link produce one signature and one sealed copy", async () => {
    const world = await makeWorld({ company: true });
    await db_setSignature(world.owner.id);
    await setSettings(world.org.id, { countersignerUserId: world.owner.id, countersignMode: "auto" });
    const { envelopeId, secret } = await sendOne(world);
    const results = await Promise.all([sign(secret, { c_note: "tab one" }), sign(secret, { c_note: "tab two" }), sign(secret, { c_note: "tab three" })]);
    for (const r of results) expect(r.status).toBe("signed");
    const types = await eventTypes(envelopeId);
    expect(count(types, "signer.signed")).toBe(1);
    expect(count(types, "envelope.countersigned")).toBe(1);
    expect(count(types, "envelope.completed")).toBe(1);
    const envelope = await envelopeRow(envelopeId);
    expect(envelope.status).toBe("completed");
    expect(getTestOutbox().filter((m) => m.kind === "completed" && m.envelopeId === envelopeId)).toHaveLength(2);
    expect((await sign(secret)).completed).toBe(true);
  });

  it("finalizing twice, or from two places at once, completes once", async () => {
    const world = await makeWorld();
    const { envelopeId, secret } = await sendOne(world);
    seal.fail = true;
    await sign(secret);
    seal.fail = false;
    clearTestOutbox();
    const results = await Promise.all([finalizeEnvelope(envelopeId), finalizeEnvelope(envelopeId), finalizeEnvelope(envelopeId)]);
    expect(results.filter((r) => r.status === "completed" && !r.alreadyCompleted)).toHaveLength(1);
    expect(results.every((r) => r.status === "completed")).toBe(true);
    expect(await finalizeEnvelope(envelopeId)).toEqual({ status: "completed", alreadyCompleted: true });
    expect(count(await eventTypes(envelopeId), "envelope.completed")).toBe(1);
    expect(getTestOutbox().filter((m) => m.kind === "completed")).toHaveLength(2);
    const envelope = await envelopeRow(envelopeId);
    expect((await getSignedCopy(secret)).sha256).toBe(envelope.finalSha256);
  });

  it("refuses to finalize an envelope that is not fully signed, and survives strange ids", async () => {
    const world = await makeWorld({ company: true });
    const { envelopeId } = await sendOne(world);
    expect((await finalizeEnvelope(envelopeId)).status).toBe("not_ready");
    expect((await finalizeEnvelope("env_doesnotexist0000")).status).toBe("not_ready");
    expect((await finalizeEnvelope(undefined as unknown as string)).status).toBe("not_ready");
    expect((await envelopeRow(envelopeId)).status).toBe("sent");
  });
});

describe("links that can no longer be signed", () => {
  it("after a void", async () => {
    const world = await makeWorld();
    const { envelopeId, secret, file } = await sendOne(world);
    await voidEnvelope(world.actor, envelopeId, "Sent to the wrong client");
    const session = await getSigningSession(secret);
    expect(session.state).toBe("voided");
    expect(session.message).toContain(world.org.name);
    await expectServiceError(sign(secret), "gone");
    await expectServiceError(declineSigning(secret, "too late"), "gone");
    await expectServiceError(getSigningDocument(secret), "gone");
    expect((await envelopeRow(envelopeId)).status).toBe("voided");
    expect((await signerRows(envelopeId))[0].status).toBe("sent");
    expect((await fileRow(file.id)).agreementStatus).toBe("no_agreement");
  });

  it("after a decline, which is recorded and reported to the sender", async () => {
    const world = await makeWorld();
    const { envelopeId, secret, file } = await sendOne(world);
    const out = await declineSigning(secret, "  The fee is not what we agreed.\u0000  ", { ip: "203.0.113.40" });
    expect(out).toEqual({ status: "declined" });
    const envelope = await envelopeRow(envelopeId);
    expect(envelope.status).toBe("declined");
    expect(envelope.declineReason).toBe("The fee is not what we agreed.");
    expect(envelope.nextReminderAt).toBeNull();
    expect((await fileRow(file.id)).agreementStatus).toBe("declined");
    const [mail] = mailTo(world.owner.email, "declined");
    expect(mail.text).toContain("The fee is not what we agreed.");
    // Declining again is a no-op; signing is no longer possible.
    expect(await declineSigning(secret, "again")).toEqual({ status: "declined" });
    expect(count(await eventTypes(envelopeId), "envelope.declined")).toBe(1);
    expect(mailTo(world.owner.email, "declined")).toHaveLength(1);
    await expectServiceError(sign(secret), "gone");
    expect((await getSigningSession(secret)).state).toBe("declined");
    expect((await signerRows(envelopeId))[0].status).toBe("declined");
    // Terminal: it cannot be voided into a different state afterwards.
    await expectServiceError(voidEnvelope(world.actor, envelopeId, "tidy up"), "conflict");
    expect((await envelopeRow(envelopeId)).status).toBe("declined");
  });

  it("a countersigner declining tells the client the agreement was not completed", async () => {
    const world = await makeWorld({ company: true });
    const { envelopeId, secret, file } = await sendOne(world);
    await sign(secret);
    const [, company] = await signerRows(envelopeId);
    await declineSigning(secretOf(signingUrl(company)), "Terms changed");
    expect((await envelopeRow(envelopeId)).status).toBe("declined");
    expect((await fileRow(file.id)).agreementStatus).toBe("declined");
    // The client is told what happened in those words, not that the company "cancelled a signing request".
    expect(mailTo(file.clientEmail, "voided")).toHaveLength(0);
    const [notice] = mailTo(file.clientEmail, "not_completed");
    expect(notice.subject).toMatch(/was not completed/);
    expect(notice.subject).not.toMatch(/cancelled/);
    expect(notice.text).toMatch(/did not countersign/);
    // The client's own link now says so too.
    expect((await getSigningSession(secret)).state).toBe("declined");
    await expectServiceError(declineSigning(secret, "me too"), "gone");
  });

  it("after the expiry date, even before the scheduler has run", async () => {
    const world = await makeWorld();
    const { envelopeId, secret } = await sendOne(world);
    const db = await getDb();
    await db.update(envelopes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(envelopes.id, envelopeId));
    expect((await getSigningSession(secret)).state).toBe("expired");
    await expectServiceError(sign(secret), "gone");
    await expectServiceError(declineSigning(secret, "late"), "gone");
    expect((await signerRows(envelopeId))[0].status).toBe("sent");
    expect(count(await eventTypes(envelopeId), "envelope.viewed")).toBe(0);
    await runScheduledJobs();
    expect((await envelopeRow(envelopeId)).status).toBe("expired");
    await expectServiceError(sign(secret), "gone");
  });

  it("after completion: the signer gets the same success, never a second signature", async () => {
    const world = await makeWorld();
    const { envelopeId, secret } = await sendOne(world);
    const first = await sign(secret);
    const before = await envelopeRow(envelopeId);
    expect(await sign(secret, { c_note: "changed my mind" })).toEqual(first);
    await expectServiceError(declineSigning(secret, "changed my mind"), "conflict");
    const after = await envelopeRow(envelopeId);
    expect(after.finalSha256).toBe(before.finalSha256);
    expect(after.status).toBe("completed");
    await expectServiceError(voidEnvelope(world.actor, envelopeId, "undo"), "conflict");
    expect((await envelopeRow(envelopeId)).status).toBe("completed");
  });
});

describe("validating what a signer submits", () => {
  it("requires explicit consent", async () => {
    const world = await makeWorld();
    const { envelopeId, secret } = await sendOne(world);
    for (const consent of [undefined, false, "true", 1, "yes", null]) {
      const err = await expectServiceError(submitSigning(secret, { values: goodValues(), consent }), "invalid");
      expect(err.fields?.consent).toBeTruthy();
    }
    await expectServiceError(submitSigning(secret, null as never), "invalid");
    await expectServiceError(submitSigning(secret, "consent=true" as never), "invalid");
    expect((await signerRows(envelopeId))[0].status).toBe("sent");
  });

  it("rejects a client trying to fill the company's fields or overwrite a prefilled value", async () => {
    const world = await makeWorld({ company: true });
    const { envelopeId, secret } = await sendOne(world);
    for (const stolen of ["k_sig", "k_name", "p_name", "no_such_field", "__proto__x"]) {
      const err = await expectServiceError(sign(secret, { [stolen]: stolen === "k_sig" ? SIGNATURE : "Mallory" }), "invalid");
      expect(err.fields?.[stolen]).toMatch(/not one of yours/);
    }
    const [client, company] = await signerRows(envelopeId);
    expect(client.status).toBe("sent");
    expect(company.values).toEqual({});
    expect((await envelopeRow(envelopeId)).prefill.p_name).not.toBe("Mallory");
    // And the countersigner cannot fill the client's fields either.
    await sign(secret);
    const companySecret = secretOf(signingUrl(company));
    const err = await expectServiceError(submitSigning(companySecret, { consent: true, values: { k_sig: SIGNATURE, c_note: "edited after signing" } }), "invalid");
    expect(err.fields?.c_note).toBeTruthy();
    expect((await signerRows(envelopeId))[0].values.c_note).toBeUndefined();
  });

  it("requires every required field", async () => {
    const world = await makeWorld({ fields: [...clientFields(), field("c_must", "text", "client", true, { label: "Company number" }), field("c_tick", "checkbox", "client", true, { label: "I have read the terms" })] });
    const { envelopeId, secret } = await sendOne(world);
    const missingSignature = await expectServiceError(submitSigning(secret, { consent: true, values: { c_must: "123", c_tick: true } }), "invalid");
    expect(missingSignature.fields?.c_sig).toMatch(/signature/i);
    const missingOthers = await expectServiceError(sign(secret, { c_must: "   ", c_tick: false }), "invalid");
    expect(missingOthers.fields).toMatchObject({ c_must: expect.stringContaining("Company number"), c_tick: expect.stringContaining("I have read the terms") });
    expect(missingOthers.fields?.c_sig).toBeUndefined();
    expect((await signerRows(envelopeId))[0].status).toBe("sent");
    expect((await sign(secret, { c_must: "12345678", c_tick: true })).completed).toBe(true);
  });

  it("rejects a bad signature image", async () => {
    const world = await makeWorld();
    const { envelopeId, secret } = await sendOne(world);
    const png = makePng();
    const bad: unknown[] = [
      "Casey Example",
      "data:image/png;base64,",
      "data:image/png;base64,AAAA",
      `data:image/png;base64,${png.subarray(0, png.length - 20).toString("base64")}`,
      `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]).toString("base64")}`,
      `data:image/svg+xml;base64,${Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>").toString("base64")}`,
      `data:image/png;base64,${Buffer.alloc(400 * 1024, 7).toString("base64")}`,
      { toString: () => SIGNATURE },
      12345,
      true,
      ["x"],
    ];
    for (const value of bad) {
      const err = await expectServiceError(submitSigning(secret, { consent: true, values: { c_sig: value } }), "invalid");
      expect(err.fields?.c_sig, String(value).slice(0, 40)).toBeTruthy();
    }
    expect((await signerRows(envelopeId))[0].status).toBe("sent");
    expect((await envelopeRow(envelopeId)).status).toBe("sent");
  });

  it("checks text, email and checkbox values and cleans what it keeps", async () => {
    const world = await makeWorld();
    const { envelopeId, secret } = await sendOne(world);
    const tooLong = await expectServiceError(sign(secret, { c_note: "x".repeat(501) }), "invalid");
    expect(tooLong.fields?.c_note).toMatch(/too long/);
    expect((await expectServiceError(sign(secret, { c_email: "not-an-email" }), "invalid")).fields?.c_email).toMatch(/email/);
    expect((await expectServiceError(sign(secret, { c_agree: "yes" }), "invalid")).fields?.c_agree).toBeTruthy();
    expect((await expectServiceError(sign(secret, { c_note: { nested: true } }), "invalid")).fields?.c_note).toBeTruthy();
    await expectServiceError(submitSigning(secret, { consent: true, values: [SIGNATURE] }), "invalid");
    await expectServiceError(submitSigning(secret, { consent: true, values: "c_sig" }), "invalid");

    await sign(secret, { c_note: "  line one\u0000 and\ttwo  ", c_email: "  Billing@Client.TEST ", c_name: "   ", c_date: "1 January 1999" });
    const [client] = await signerRows(envelopeId);
    expect(client.values.c_note).not.toContain("\u0000");
    expect(String(client.values.c_note).startsWith("line one")).toBe(true);
    expect(client.values.c_email).toBe("billing@client.test");
    // A blank name falls back to the signer's name; the signing date is the server's, never the browser's.
    expect(client.values.c_name).toBe(client.name);
    expect(client.values.c_date).toBe(longDate(client.signedAt!));
    expect(client.values.c_agree).toBeUndefined();
  });

  it("sets the signing date from the signer's time zone only when it is a real one", () => {
    const at = new Date("2026-11-15T23:30:00Z");
    expect(signedDateLabel(at, undefined, undefined)).toBe("15 November 2026");
    expect(signedDateLabel(at, "Pacific/Kiritimati", undefined)).toBe("16 November 2026");
    expect(signedDateLabel(at, "America/Los_Angeles", "1 January 1999")).toBe("15 November 2026");
    for (const zone of ["Mars/Olympus", "", 5, null, {}, "x".repeat(300), "Europe/London; DROP TABLE"]) {
      expect(signedDateLabel(at, zone, undefined)).toBe("15 November 2026");
    }
    // A label from the browser is only believed if the date is possible somewhere on Earth right now.
    expect(signedDateLabel(at, undefined, "16 November 2026")).toBe("16 November 2026");
    expect(signedDateLabel(at, undefined, "25 December 2030")).toBe("15 November 2026");
  });

  it("validateSignerValues never throws on hostile input", () => {
    const own = clientFields();
    const hostile: unknown[] = [null, undefined, 0, "", [], new Map(), Object.create(null), { c_sig: Symbol("x") }, { c_sig: () => 1 }, new Proxy({}, { ownKeys: () => { throw new Error("trap"); } })];
    for (const raw of hostile) {
      const result = validateSignerValues(own, raw, {}, "15 November 2026");
      expect(result.ok).toBe(false);
    }
    const many = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`f${i}`, "x"]));
    expect(validateSignerValues(own, many, {}, "15 November 2026").ok).toBe(false);
  });
});

describe("when sealing fails", () => {
  it("keeps the signature, tells the signer the truth, and completes on retry", async () => {
    const world = await makeWorld();
    const { envelopeId, secret, file } = await sendOne(world);
    seal.fail = true;
    const result = await sign(secret);
    expect(result).toMatchObject({ status: "signed", completed: false, next: "finalizing" });
    expect(result.message).toMatch(/recorded/);
    let envelope = await envelopeRow(envelopeId);
    expect(envelope.status).toBe("client_signed");
    expect(envelope.finalBlobId).toBeNull();
    expect((await signerRows(envelopeId))[0].status).toBe("signed");
    expect((await fileRow(file.id)).agreementStatus).toBe("needs_attention");
    expect(count(await eventTypes(envelopeId), FINALIZE_FAILED_EVENT)).toBe(1);
    expect(getTestOutbox().filter((m) => m.kind === "completed")).toHaveLength(0);
    expect((await getSigningSession(secret)).state).toBe("signed");
    await expectServiceError(getSignedCopy(secret), "not_ready");
    // A retry by the signer does not sign again.
    expect((await sign(secret)).next).toBe("finalizing");
    expect(count(await eventTypes(envelopeId), "signer.signed")).toBe(1);

    seal.fail = false;
    const summary = await runScheduledJobs(new Date(Date.now() + 6 * 60_000));
    expect(summary.finalized).toEqual({ completed: 1, failed: 0 });
    expect(summary.errors).toEqual([]);
    envelope = await envelopeRow(envelopeId);
    expect(envelope.status).toBe("completed");
    expect((await fileRow(file.id)).agreementStatus).toBe("signed");
    expect(mailTo(file.clientEmail, "completed")).toHaveLength(1);
    expect((await sign(secret)).completed).toBe(true);
    // The certificate does not list the internal retries.
    expect((await runScheduledJobs()).finalized).toEqual({ completed: 0, failed: 0 });
  });

  it("backs off between attempts but never gives up: it seals once the cause is fixed, however many times it failed", async () => {
    const world = await makeWorld();
    const { envelopeId, secret, file } = await sendOne(world);
    seal.fail = true;
    await sign(secret); // the inline attempt is failure 1
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);

    // Inside the wait nothing is attempted, so a broken deploy is not hammered every few minutes.
    let calls = seal.calls;
    await runScheduledJobs(at(4));
    expect(seal.calls).toBe(calls);
    expect(await listUnsealedEnvelopeIds(10, at(4))).toEqual([]);

    // Each failure doubles the wait since the last one: 5, 10, 20 ... minutes, then 6 hours at most.
    // (Failures are stamped by the database clock, so every wait here is measured from about now.)
    for (const wait of [5, 10, 20, 40, 80, 160, 320, 360, 360]) {
      calls = seal.calls;
      await runScheduledJobs(at(wait - 1));
      expect(seal.calls, `no attempt before ${wait} minutes have passed`).toBe(calls);
      expect((await runScheduledJobs(at(wait + 1))).finalized).toEqual({ completed: 0, failed: 1 });
    }
    expect(count(await eventTypes(envelopeId), FINALIZE_FAILED_EVENT)).toBe(10);
    expect((await envelopeRow(envelopeId)).status).toBe("client_signed");
    expect((await signerRows(envelopeId))[0].status).toBe("signed");

    // Ten failures later the cause is fixed, and the next due run finishes the job.
    seal.fail = false;
    expect((await runScheduledJobs(at(361))).finalized).toEqual({ completed: 1, failed: 0 });
    expect((await envelopeRow(envelopeId)).status).toBe("completed");
    expect((await fileRow(file.id)).agreementStatus).toBe("signed");
    expect(mailTo(file.clientEmail, "completed")).toHaveLength(1);
  });
});

describe("public rate limits and verification", () => {
  it("limits repeated submits on one link", async () => {
    const world = await makeWorld();
    const { envelopeId, secret } = await sendOne(world);
    let limited: ServiceError | null = null;
    for (let i = 0; i < 30 && !limited; i++) {
      try {
        await submitSigning(secret, { consent: false, values: {} });
      } catch (err) {
        if (err instanceof ServiceError && err.code === "rate_limited") limited = err;
        else expect((err as ServiceError).code).toBe("invalid");
      }
    }
    expect(limited?.message).toMatch(/try again/i);
    expect(limited?.status).toBe(429);
    // The limit is per link: it does not lock out other signers.
    const other = await sendOne(world);
    expect((await sign(other.secret)).completed).toBe(true);
    expect((await signerRows(envelopeId))[0].status).toBe("sent");
  });

  it("limits requests from one address across links", async () => {
    const world = await makeWorld();
    const { secret } = await sendOne(world);
    let limited = false;
    for (let i = 0; i < 110 && !limited; i++) {
      try {
        await declineSigning(`${"z".repeat(42)}${i % 10}`, "x", { ip: "198.51.100.77" });
      } catch (err) {
        limited = err instanceof ServiceError && err.code === "rate_limited";
      }
    }
    expect(limited).toBe(true);
    await expectServiceError(declineSigning(secret, "x", { ip: "198.51.100.77" }), "rate_limited");
    expect((await getSigningSession(secret, { ip: "198.51.100.78" })).state).toBe("ready");
  });

  it("verifies only sealed documents and reveals nothing for anything else", async () => {
    const world = await makeWorld();
    const { envelopeId, secret } = await sendOne(world);
    const unsigned = await envelopeRow(envelopeId);
    expect(await verifyDocument({ sha256: unsigned.pdfSha256 })).toEqual({ found: false });
    for (const input of [null, undefined, {}, { sha256: 5 }, { sha256: "zz" }, { sha256: "a".repeat(64) }, { sha256: `${"a".repeat(64)}' or 1=1` }]) {
      expect(await verifyDocument(input as never)).toEqual({ found: false });
    }
    await sign(secret);
    const sealed = await envelopeRow(envelopeId);
    const ok = await verifyDocument({ sha256: ` ${sealed.finalSha256} ` });
    expect(ok.found).toBe(true);
    expect(Object.keys(ok).sort()).toEqual(["agreementName", "completedAt", "found", "organization", "signers"]);
    expect(maskEmail("casey@client.test")).toBe("c***@client.test");
    expect(maskEmail("nonsense")).toBe("***");
  });
});

// ---------------------------------------------------------------------------
// Regression tests for review findings
// ---------------------------------------------------------------------------

describe("a countersign link is only as good as the account behind it", () => {
  async function disable(userId: string): Promise<void> {
    const db = await getDb();
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId));
  }

  it("stops working the moment the countersigner is turned off, for every action", async () => {
    const world = await makeWorld({ company: true });
    const admin = await addUser(world.org.id, "admin");
    await setSettings(world.org.id, { countersignerUserId: admin.id });
    const { envelopeId, secret } = await sendOne(world);
    await sign(secret);
    const [, company] = await signerRows(envelopeId);
    const companySecret = secretOf(signingUrl(company));
    expect(mailTo(admin.email, "countersign_request")).toHaveLength(1);
    expect((await getSigningSession(companySecret)).state).toBe("ready");

    await disable(admin.id);
    expect((await getSigningSession(companySecret)).state).toBe("unknown");
    await expectServiceError(submitSigning(companySecret, { consent: true, values: { k_sig: SIGNATURE } }), "not_found");
    await expectServiceError(declineSigning(companySecret, "no"), "not_found");
    await expectServiceError(getSigningDocument(companySecret), "not_found");
    await expectServiceError(getSignedCopy(companySecret), "not_found");
    expect((await envelopeRow(envelopeId)).status).toBe("client_signed");
    expect((await signerRows(envelopeId))[1].status).not.toBe("signed");

    // Turning the account back on is the owner's decision to let them sign again.
    const db = await getDb();
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, admin.id));
    expect((await getSigningSession(companySecret)).state).toBe("ready");
  });

  it("a company signer with no account behind it cannot sign at all", async () => {
    const world = await makeWorld({ company: true });
    const { envelopeId, secret } = await sendOne(world);
    await sign(secret);
    const [, company] = await signerRows(envelopeId);
    const db = await getDb();
    await db.update(signers).set({ userId: null, email: "mallory@outside.test" }).where(eq(signers.id, company.id));
    await expectServiceError(submitSigning(secretOf(signingUrl(company)), { consent: true, values: { k_sig: SIGNATURE } }), "not_found");
    expect((await envelopeRow(envelopeId)).status).toBe("client_signed");
  });

  it("when the client signs after the countersigner left, the request goes to whoever countersigns now, with a new link", async () => {
    const world = await makeWorld({ company: true });
    const admin = await addUser(world.org.id, "admin");
    await setSettings(world.org.id, { countersignerUserId: admin.id });
    const { envelopeId, secret, file } = await sendOne(world);
    const [, assigned] = await signerRows(envelopeId);
    expect(assigned.userId).toBe(admin.id);
    const oldSecret = secretOf(signingUrl(assigned));

    // Turned off before the client signs. (The settings still name them, as after a direct edit;
    // the rule falls back to the owner either way.)
    await disable(admin.id);
    clearTestOutbox();
    const result = await sign(secret);
    expect(result.next).toBe("awaiting_countersignature");

    const [, company] = await signerRows(envelopeId);
    expect(company).toMatchObject({ userId: world.owner.id, email: world.owner.email, name: world.owner.name, status: "sent" });
    expect(mailTo(admin.email)).toHaveLength(0);
    expect(mailTo(world.owner.email, "countersign_request")).toHaveLength(1);
    expect(await findSignerBySecret(oldSecret)).toBeNull();
    expect(mailTo(world.owner.email, "countersign_request")[0].text).toContain(signingUrl(company));
    expect(await eventTypes(envelopeId)).toContain("signer.updated");
    expect((await fileRow(file.id)).agreementStatus).toBe("awaiting_countersign");
    expect((await submitSigning(secretOf(signingUrl(company)), { consent: true, values: { k_sig: SIGNATURE } })).completed).toBe(true);
  });

  it("in automatic mode a countersigner who left is never signed for: it falls to the owner", async () => {
    const world = await makeWorld({ company: true });
    const admin = await addUser(world.org.id, "admin", { savedSignature: SIGNATURE });
    await setSettings(world.org.id, { countersignerUserId: admin.id, countersignMode: "auto" });
    const { envelopeId, secret } = await sendOne(world);
    await disable(admin.id);
    // The owner has no saved signature, so nothing can be applied automatically.
    const result = await sign(secret);
    expect(result).toMatchObject({ completed: false, next: "awaiting_countersignature" });
    expect((await signerRows(envelopeId))[1]).toMatchObject({ userId: world.owner.id, status: "sent" });
  });
});

describe("public limits cannot be sidestepped or used to fill the table", () => {
  async function limitRows(prefix: string): Promise<string[]> {
    const db = await getDb();
    return (await db.select({ key: rateLimits.key }).from(rateLimits)).map((r) => r.key).filter((k) => k.startsWith(prefix));
  }

  it("junk links never get a counter of their own, whatever their shape", async () => {
    const db = await getDb();
    await db.delete(rateLimits);
    const wellFormed = (i: number) => `${"Q".repeat(40)}${String(i).padStart(3, "0")}`;
    for (let i = 0; i < 25; i++) {
      expect((await getSigningSession(i % 2 ? wellFormed(i) : `junk-${i}`, { ip: "198.51.100.200" })).state).toBe("unknown");
      expect((await getSigningSession(i % 2 ? wellFormed(i) : { not: "a string" }, undefined)).state).toBe("unknown");
    }
    expect(await limitRows("sign:view:link:")).toEqual([]);
    expect((await limitRows("sign:view:")).sort()).toEqual(["sign:view:ip:198.51.100.200", "sign:view:ip:unknown"]);
  });

  it("with no caller address, junk requests share one limit instead of having none", async () => {
    const db = await getDb();
    await db.delete(rateLimits);
    let limited: ServiceError | null = null;
    for (let i = 0; i < 130 && !limited; i++) {
      try {
        await declineSigning(`nope-${i}`, "x");
      } catch (err) {
        if (err instanceof ServiceError && err.code === "rate_limited") limited = err;
        else expect((err as ServiceError).code).toBe("not_found");
      }
    }
    expect(limited?.status).toBe(429);
    // A real link is not caught by the junk counter.
    const world = await makeWorld();
    const { secret } = await sendOne(world);
    expect(await declineSigning(secret, "changed my mind")).toEqual({ status: "declined" });
  });

  it("limits document checks that arrive without an address", async () => {
    const db = await getDb();
    await db.delete(rateLimits);
    let limited = false;
    for (let i = 0; i < 320 && !limited; i++) {
      try {
        await verifyDocument({ sha256: "a".repeat(64) });
      } catch (err) {
        limited = err instanceof ServiceError && err.code === "rate_limited";
      }
    }
    expect(limited).toBe(true);
    // A caller with an address has their own allowance.
    expect(await verifyDocument({ sha256: "a".repeat(64) }, { ip: "198.51.100.201" })).toEqual({ found: false });
  });
});

describe("transactions survive being chosen as a deadlock victim", () => {
  const deadlock = () => Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }) });

  it("recognises deadlock and serialization errors however deeply the driver wraps them", () => {
    expect(isRetryableTxError(deadlock())).toBe(true);
    expect(isRetryableTxError({ code: "40001" })).toBe(true);
    expect(isRetryableTxError({ cause: { cause: { code: "40P01" } } })).toBe(true);
    for (const other of [null, undefined, "40P01", new Error("x"), { code: "23505" }, new ServiceError("conflict", "A conflict that is not a deadlock.")]) {
      expect(isRetryableTxError(other)).toBe(false);
    }
  });

  it("runs the work once more after a deadlock, and only once", async () => {
    const db = await getDb();
    let attempts = 0;
    const result = await inTransaction(db, async () => {
      attempts++;
      if (attempts === 1) throw deadlock();
      return "done";
    });
    expect(result).toBe("done");
    expect(attempts).toBe(2);

    attempts = 0;
    await expect(
      inTransaction(db, async () => {
        attempts++;
        throw deadlock();
      }),
    ).rejects.toThrow();
    expect(attempts).toBe(2);

    // Anything else is not retried: a ServiceError must reach the caller as it is.
    attempts = 0;
    await expectServiceError(
      inTransaction(db, async () => {
        attempts++;
        throw new ServiceError("conflict", "Something else changed this agreement.");
      }),
      "conflict",
    );
    expect(attempts).toBe(1);
  });

  it("signing, viewing and declining all take the file's lock before the envelope's (same order as sending)", async () => {
    // Deadlocks cannot happen on the single-connection test database, so this pins the
    // mechanism instead: each of these must still work while holding to one lock order,
    // and concurrent pairs on one file must leave a consistent result.
    const world = await makeWorld({ company: true });
    const { envelopeId, secret, file } = await sendOne(world);
    const results = await Promise.allSettled([getSigningSession(secret), sign(secret), sendAgreementForFile(world.actor, file.id, { replace: true })]);
    expect(results.every((r) => r.status === "fulfilled" || r.reason instanceof ServiceError)).toBe(true);
    const first = await envelopeRow(envelopeId);
    expect(["client_signed", "voided"]).toContain(first.status);
    const open = (await getDb().then((db) => db.select().from(envelopes).where(eq(envelopes.fileId, file.id)))).filter((e) => ["draft", "sent", "viewed", "client_signed"].includes(e.status));
    expect(open).toHaveLength(1);
  });
});

describe("company time zone helpers", () => {
  it("reads a real IANA zone from settings and ignores anything else", () => {
    expect(orgTimeZone({ settings: { timeZone: "America/Chicago" } })).toBe("America/Chicago");
    expect(orgTimeZone({ settings: { timezone: "Europe/London" } })).toBe("Europe/London");
    for (const bad of [null, undefined, {}, { settings: null }, { settings: "x" }, { settings: { timeZone: "Mars/Olympus" } }, { settings: { timeZone: 5 } }, { settings: { timeZone: "'; drop table" } }]) {
      expect(orgTimeZone(bad as never)).toBeNull();
    }
  });

  it("splits an instant into the calendar day of a zone, and never throws on a bad zone", () => {
    const at = new Date("2027-01-01T03:00:00Z");
    expect(calendarParts(at, "America/New_York")).toEqual({ day: 31, month: "December", year: 2026 });
    expect(calendarParts(at, null)).toEqual({ day: 1, month: "January", year: 2027 });
    expect(calendarParts(at, "Not/Real")).toEqual({ day: 1, month: "January", year: 2027 });
  });
});

describe("what a signer is told when a link dies", () => {
  const brand = { orgName: "Pier <Test> Co", brandColor: "#1f3a5f" };

  it("says expired for an expiry and not completed for a missing countersignature, never cancelled", () => {
    const expired = linkDeadEmail("expired", { brand, signerName: "Fay Client", agreementName: "Engagement letter", expiredOn: "3 December 2026" });
    expect(expired.subject).toBe("Your signing link for Engagement letter has expired");
    expect(expired.text).toMatch(/expired on 3 December 2026 before the agreement was signed/);
    expect(expired.text).toMatch(/ask them to send the agreement again/);
    const notCompleted = linkDeadEmail("not_completed", { brand, signerName: "Fay Client", agreementName: "Engagement letter" });
    expect(notCompleted.text).toMatch(/did not countersign it, so the agreement was not completed/);
    for (const email of [expired, notCompleted]) {
      expect(`${email.subject} ${email.text}`).not.toMatch(/cancel/i);
      // Names are escaped on their way into HTML.
      expect(email.html).toContain("Pier &lt;Test&gt; Co");
      expect(email.html).not.toContain("<Test>");
    }
    expect(linkDeadEmail("voided", { brand, signerName: "Fay", agreementName: "Engagement letter", reason: "Wrong version" }).subject).toMatch(/cancelled/);
    // Missing details never produce "undefined" in a sentence.
    const bare = linkDeadEmail("expired", { brand: { orgName: "" }, signerName: "", agreementName: "" });
    expect(`${bare.subject} ${bare.text}`).not.toMatch(/undefined|null/);
  });
});
