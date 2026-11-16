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
import { emailLog, envelopes, events, files, orgs, signers, templates, users, webhookDeliveries, webhooks, type Envelope, type FileRow, type Org, type Signer, type Template, type User } from "@/lib/db/schema";
import { newId, sha256Hex } from "@/lib/ids";
import type { Field, OrgSettings } from "@/lib/types";
import { ServiceError, type Actor } from "@/lib/services/context";
import { putBlob } from "@/lib/services/blobs";
import { clearTestOutbox, getTestOutbox, setTestEmailFailure, setTestEmailUnconfigured } from "@/lib/services/email";
import { countersign, getDocument, getEnvelope, getSigningLink, listEnvelopes, resendToSigner, resolvePrefill, sendAgreementForFile, sendReminderNow, updateSigner, voidEnvelope, voidOpenEnvelopesForFile } from "@/lib/services/envelopes";
import { declineSigning, getSigningDocument, getSigningSession, longDate, submitSigning, verifyDocument } from "@/lib/services/signing";
import { findSignerBySecret } from "@/lib/services/tokens";

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

const apiActor = (orgId: string): Actor => ({ type: "api", orgId, keyId: "key_test000000000000", label: "API key: test" });

describe("sendAgreementForFile", () => {
  it("snapshots the agreement, prefills from the file, creates the signers and emails the client", async () => {
    const world = await makeWorld({ company: true });
    const signatory = await addUser(world.org.id, "member");
    await setSettings(world.org.id, { countersignerUserId: signatory.id, expireAfterDays: 10, reminderEveryDays: 3, emailMessage: "Thank you for choosing us." });
    const file = await makeFile(world.org.id, { description: "Review of the shop lease" });
    const before = Date.now();
    const sent = await sendAgreementForFile(world.actor, file.id, {}, { ip: "192.0.2.4", userAgent: "Chrome" });
    expect(sent.delivery).toBe("emailed");
    expect(sent.signingUrl).toMatch(/\/sign\/[A-Za-z0-9_-]{43}$/);

    const envelope = await envelopeRow(sent.envelopeId);
    expect(envelope).toMatchObject({
      orgId: world.org.id,
      fileId: file.id,
      templateId: world.template.id,
      templateName: "Client Services Agreement",
      templateVersion: 3,
      pdfBlobId: world.template.pdfBlobId,
      status: "sent",
      createdBy: world.owner.id,
      reminderCount: 0,
    });
    expect(envelope.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope.pages).toEqual([{ width: 612, height: 792 }]);
    expect(envelope.fields).toEqual(world.template.fields);
    expect(envelope.sentAt).toBeInstanceOf(Date);
    expect(envelope.expiresAt!.getTime() - before).toBeGreaterThanOrEqual(10 * 86_400_000 - 5);
    expect(envelope.expiresAt!.getTime() - before).toBeLessThan(10 * 86_400_000 + 60_000);
    expect(envelope.nextReminderAt!.getTime() - before).toBeGreaterThanOrEqual(3 * 86_400_000 - 5);
    expect(envelope.prefill).toMatchObject({ p_name: file.clientName, p_ref: file.reference, p_matter: "Lease review", p_today: longDate(new Date()) });
    expect(String(envelope.prefill.p_day)).toMatch(/^\d{1,2}(st|nd|rd|th)$/);

    const [client, company] = await signerRows(sent.envelopeId);
    expect(client).toMatchObject({ role: "client", order: 1, name: file.clientName, email: file.clientEmail, status: "sent", orgId: world.org.id });
    expect(company).toMatchObject({ role: "company", order: 2, name: signatory.name, email: signatory.email, status: "waiting", userId: signatory.id });
    expect(client.tokenHash).not.toBe(company.tokenHash);

    expect((await fileRow(file.id)).agreementStatus).toBe("out_for_signature");
    expect(await eventTypes(sent.envelopeId)).toEqual(["envelope.created", "envelope.sent"]);
    const [mail] = mailTo(file.clientEmail, "signing_request");
    expect(mail.text).toContain(sent.signingUrl);
    expect(mail.text).toContain("Thank you for choosing us.");
    expect(mail.from).toContain(world.org.name);
    expect(mailTo(signatory.email)).toHaveLength(0);

    // Editing the live agreement afterwards changes nothing about what was sent.
    const db = await getDb();
    await db.update(templates).set({ fields: [], name: "Edited later", version: 4 }).where(eq(templates.id, world.template.id));
    const again = await envelopeRow(sent.envelopeId);
    expect(again.fields).toHaveLength(world.template.fields.length);
    expect(again.templateName).toBe("Client Services Agreement");
    const session = await getSigningSession(secretOf(sent.signingUrl));
    expect(session.state === "ready" && session.fields.length).toBe(6);
  });

  it("resolves every merge key, and leaves missing or unusable ones blank", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    const fields: Field[] = [
      field("a", "text", "prefill", false, { mergeKey: "client_name" }),
      field("b", "email", "prefill", false, { mergeKey: "client_email" }),
      field("c", "company", "prefill", false, { mergeKey: "client_company" }),
      field("d", "title", "prefill", false, { mergeKey: "client_title" }),
      field("e", "text", "prefill", false, { mergeKey: "client_phone" }),
      field("f", "text", "prefill", false, { mergeKey: "file_reference" }),
      field("g", "text", "prefill", false, { mergeKey: "file_description" }),
      field("h", "company", "prefill", false, { mergeKey: "company_name" }),
      field("i", "date", "prefill", false, { mergeKey: "today" }),
      field("j", "text", "prefill", false, { mergeKey: "custom:rate" }),
      field("k", "text", "prefill", false, { mergeKey: "custom:missing" }),
      field("l", "text", "prefill", false, { mergeKey: "custom:today_day" }),
      field("m", "text", "prefill", false, { mergeKey: "custom:today_month" }),
      field("n", "text", "prefill", false, { mergeKey: "custom:today_year" }),
      field("o", "text", "prefill", false, { mergeKey: "custom:today_year_short" }),
      field("p", "checkbox", "prefill", false, { mergeKey: "custom:vip" }),
      field("q", "signature", "prefill", false, { mergeKey: "client_name" }),
      field("r", "text", "prefill", false, { mergeKey: "custom:constructor" }),
      field("s", "text", "prefill", false, { mergeKey: "nonsense" as never }),
      field("t", "text", "prefill", false),
      field("u", "text", "client", false, { mergeKey: "client_name" }),
      field("v", "text", "prefill", false, { mergeKey: "custom:long" }),
    ];
    const values = resolvePrefill(
      [...fields, null as never, "x" as never],
      {
        clientName: "Casey Example",
        clientEmail: "casey@client.test",
        clientCompany: "Example Holdings",
        clientTitle: null,
        clientPhone: "+44 20 7946 0000",
        reference: "F-2026-0042",
        description: "Lease\u0000 review",
        data: { rate: "250", vip: "Yes", long: "y".repeat(5000) },
      },
      { name: "Northwind", legalName: "Northwind Test Ltd" },
      now,
    );
    expect(values).toEqual({
      a: "Casey Example",
      b: "casey@client.test",
      c: "Example Holdings",
      e: "+44 20 7946 0000",
      f: "F-2026-0042",
      g: "Lease review",
      h: "Northwind Test Ltd",
      i: "3 November 2026",
      j: "250",
      l: "3rd",
      m: "November",
      n: "2026",
      o: "26",
      p: true,
      v: "y".repeat(500),
    });
    const day = (d: number) => resolvePrefill([fields[11]], { clientName: "", clientEmail: "", clientCompany: null, clientTitle: null, clientPhone: null, reference: "", description: null, data: null as never }, { name: "N", legalName: null }, new Date(Date.UTC(2026, 0, d))).l;
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(day)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"]);
  });

  it("says plainly why an agreement is not ready to send", async () => {
    const none = await makeWorld({ noTemplate: true });
    const noneFile = await makeFile(none.org.id);
    expect((await expectServiceError(sendAgreementForFile(none.actor, noneFile.id), "not_ready")).message).toMatch(/no active agreement/);
    expect((await fileRow(noneFile.id)).agreementStatus).toBe("no_agreement");
    await expectServiceError(sendAgreementForFile(none.actor, noneFile.id, { templateId: none.template.id }), "not_ready");

    const draft = await makeWorld({ templateStatus: "draft" });
    const draftFile = await makeFile(draft.org.id);
    expect((await expectServiceError(sendAgreementForFile(draft.actor, draftFile.id, { templateId: draft.template.id }), "not_ready")).message).toMatch(/draft/);

    const unsigned = await makeWorld({ fields: [field("c_name", "full_name", "client", true), field("c_sig", "signature", "client", false)] });
    expect((await expectServiceError(sendAgreementForFile(unsigned.actor, (await makeFile(unsigned.org.id)).id), "not_ready")).message).toMatch(/signature/);

    // Company fields with nobody to countersign: an API call has no sending user to fall back on.
    const company = await makeWorld({ company: true });
    const companyFile = await makeFile(company.org.id);
    expect((await expectServiceError(sendAgreementForFile(apiActor(company.org.id), companyFile.id), "not_ready")).message).toMatch(/countersign/);
    // A signed-in sender becomes the countersigner.
    const sent = await sendAgreementForFile(company.actor, companyFile.id);
    expect((await signerRows(sent.envelopeId))[1]).toMatchObject({ role: "company", userId: company.owner.id });

    const auto = await makeWorld({ company: true });
    await setSettings(auto.org.id, { countersignerUserId: auto.owner.id, countersignMode: "auto" });
    expect((await expectServiceError(sendAgreementForFile(auto.actor, (await makeFile(auto.org.id)).id), "not_ready")).message).toMatch(/saved signature/);

    const gone = await makeWorld({ company: true });
    const leaver = await addUser(gone.org.id, "member", { disabledAt: new Date() });
    await setSettings(gone.org.id, { countersignerUserId: leaver.id });
    expect((await expectServiceError(sendAgreementForFile(apiActor(gone.org.id), (await makeFile(gone.org.id)).id), "not_ready")).message).toMatch(/no longer an active member/);
  });

  it("refuses bad files and bad input with typed errors", async () => {
    const world = await makeWorld();
    for (const id of [undefined, null, "", 7, {}, "file_doesnotexist000", "x".repeat(500)]) {
      await expectServiceError(sendAgreementForFile(world.actor, id), "not_found");
    }
    const archived = await makeFile(world.org.id, { archivedAt: new Date() });
    await expectServiceError(sendAgreementForFile(world.actor, archived.id), "conflict");
    const badEmail = await makeFile(world.org.id, { clientEmail: "not an email" });
    expect((await expectServiceError(sendAgreementForFile(world.actor, badEmail.id), "invalid")).fields?.clientEmail).toBeTruthy();
    const file = await makeFile(world.org.id);
    await expectServiceError(sendAgreementForFile(world.actor, file.id, { templateId: "tpl_doesnotexist0000" }), "not_found");
    await expectServiceError(sendAgreementForFile(world.actor, file.id, { templateId: { $ne: null } }), "not_found");
    await expectServiceError(sendAgreementForFile(null as never, file.id), "forbidden");
    await expectServiceError(sendAgreementForFile({ type: "user", orgId: "" } as never, file.id), "forbidden");
    expect((await sendAgreementForFile(world.actor, file.id, null as never)).delivery).toBe("emailed");
  });

  it("refuses a second open envelope or a re-send after completion unless asked to replace", async () => {
    const world = await makeWorld();
    const first = await sendOne(world);
    const conflict = await expectServiceError(sendAgreementForFile(world.actor, first.file.id), "conflict");
    expect(conflict.message).toMatch(/already out for signature/);
    expect(await listEnvelopes(world.actor, { fileId: first.file.id })).toHaveLength(1);

    clearTestOutbox();
    const second = await sendAgreementForFile(world.actor, first.file.id, { replace: true });
    expect((await envelopeRow(first.envelopeId)).status).toBe("voided");
    expect((await envelopeRow(second.envelopeId)).status).toBe("sent");
    expect((await getSigningSession(first.secret)).state).toBe("voided");
    expect(mailTo(first.file.clientEmail, "voided")).toHaveLength(1);
    expect(mailTo(first.file.clientEmail, "signing_request")).toHaveLength(1);
    expect((await fileRow(first.file.id)).agreementStatus).toBe("out_for_signature");

    await sign(secretOf(second.signingUrl));
    expect((await expectServiceError(sendAgreementForFile(world.actor, first.file.id), "conflict")).message).toMatch(/already has a signed agreement/);
    const third = await sendAgreementForFile(world.actor, first.file.id, { replace: true });
    // The signed one is untouched and the file stays cleared.
    expect((await envelopeRow(second.envelopeId)).status).toBe("completed");
    expect((await envelopeRow(third.envelopeId)).status).toBe("sent");
    expect((await fileRow(first.file.id)).agreementStatus).toBe("signed");
  });

  it("two sends for the same file at once create one envelope", async () => {
    const world = await makeWorld();
    const file = await makeFile(world.org.id);
    const results = await Promise.allSettled([sendAgreementForFile(world.actor, file.id), sendAgreementForFile(world.actor, file.id), sendAgreementForFile(world.actor, file.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as ServiceError).code).toBe("conflict");
    expect(await listEnvelopes(world.actor, { fileId: file.id })).toHaveLength(1);
    expect(mailTo(file.clientEmail, "signing_request")).toHaveLength(1);
  });

  it("a failed email leaves a working link, records the failure and tells the sender", async () => {
    const world = await makeWorld();
    const file = await makeFile(world.org.id);
    setTestEmailFailure("Mailbox does not exist", file.clientEmail);
    const sent = await sendAgreementForFile(world.actor, file.id);
    expect(sent.delivery).toBe("email_failed");
    expect(sent.signingUrl).toMatch(/\/sign\//);
    const envelope = await envelopeRow(sent.envelopeId);
    expect(envelope.status).toBe("draft");
    expect(envelope.sentAt).toBeNull();
    expect((await fileRow(file.id)).agreementStatus).toBe("needs_attention");
    expect(await eventTypes(sent.envelopeId)).toEqual(["envelope.created", "envelope.delivery_failed"]);
    const db = await getDb();
    const [failure] = await db.select().from(events).where(and(eq(events.envelopeId, sent.envelopeId), eq(events.type, "envelope.delivery_failed")));
    expect(failure.data).toMatchObject({ email: file.clientEmail, error: "Mailbox does not exist" });
    const [log] = await db.select().from(emailLog).where(and(eq(emailLog.envelopeId, sent.envelopeId), eq(emailLog.kind, "signing_request")));
    expect(log.status).toBe("failed");
    const [notice] = mailTo(world.owner.email, "delivery_failed");
    expect(notice.text).toContain(file.clientEmail);

    // The link handed back still works: the client can open and sign it.
    const secret = secretOf(sent.signingUrl);
    expect((await getSigningSession(secret)).state).toBe("ready");
    expect((await envelopeRow(sent.envelopeId)).status).toBe("viewed");
    expect((await fileRow(file.id)).agreementStatus).toBe("out_for_signature");
    setTestEmailFailure(null);
    expect((await sign(secret)).completed).toBe(true);
  });

  it("with no email provider it still creates a shareable envelope, and a later resend marks it sent", async () => {
    const world = await makeWorld();
    const file = await makeFile(world.org.id);
    setTestEmailUnconfigured(true);
    const sent = await sendAgreementForFile(world.actor, file.id);
    expect(sent.delivery).toBe("email_not_configured");
    expect((await envelopeRow(sent.envelopeId)).status).toBe("draft");
    expect((await fileRow(file.id)).agreementStatus).toBe("needs_attention");
    expect(getTestOutbox()).toHaveLength(0);
    const detail = await getEnvelope(world.actor, sent.envelopeId);
    expect(detail.signers[0].signingUrl).toBe(sent.signingUrl);
    expect(detail.events.at(-1)?.description).toMatch(/could not be delivered/);

    const [client] = await signerRows(sent.envelopeId);
    expect((await resendToSigner(world.actor, client.id)).delivery).toBe("email_not_configured");
    setTestEmailUnconfigured(false);
    const resent = await resendToSigner(world.actor, client.id);
    expect(resent).toEqual({ delivery: "emailed", signingUrl: sent.signingUrl });
    const envelope = await envelopeRow(sent.envelopeId);
    expect(envelope.status).toBe("sent");
    expect(envelope.sentAt).toBeInstanceOf(Date);
    expect((await fileRow(file.id)).agreementStatus).toBe("out_for_signature");
  });

  it("queues webhooks in the same transaction as the change", async () => {
    const world = await makeWorld();
    const db = await getDb();
    await db.insert(webhooks).values({ id: newId("whk"), orgId: world.org.id, url: "https://hooks.example.test/in", secret: "whsec_test_only" });
    const { envelopeId, file, signingUrl: url } = await sendOne(world);
    await voidEnvelope(world.actor, envelopeId, "Wrong agreement");
    const queued = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.orgId, world.org.id)).orderBy(asc(webhookDeliveries.createdAt));
    expect(queued.map((q) => q.event)).toEqual(["agreement.sent", "agreement.voided"]);
    expect(queued[0].payload).toMatchObject({ envelopeId, fileId: file.id, fileReference: file.reference, status: "sent", signingUrl: url });
    expect(queued[1].payload).toMatchObject({ status: "voided", reason: "Wrong agreement" });
  });
});

describe("tenant isolation", () => {
  it("another company cannot read, change, download or sign anything", async () => {
    const mine = await makeWorld({ company: true });
    const theirs = await makeWorld({ company: true });
    const { envelopeId, file, secret } = await sendOne(mine);
    const [client, company] = await signerRows(envelopeId);
    const intruders: Actor[] = [theirs.actor, apiActor(theirs.org.id), { type: "system", orgId: theirs.org.id, label: "System" }];

    for (const intruder of intruders) {
      await expectServiceError(getEnvelope(intruder, envelopeId), "not_found");
      await expectServiceError(getDocument(intruder, envelopeId, "original"), "not_found");
      await expectServiceError(getDocument(intruder, envelopeId, "signed"), "not_found");
      await expectServiceError(getSigningLink(intruder, client.id), "not_found");
      await expectServiceError(getSigningLink(intruder, company.id), "not_found");
      await expectServiceError(resendToSigner(intruder, client.id), "not_found");
      await expectServiceError(sendReminderNow(intruder, envelopeId), "not_found");
      await expectServiceError(updateSigner(intruder, client.id, { email: "attacker@evil.test" }), "not_found");
      await expectServiceError(voidEnvelope(intruder, envelopeId, "mine now"), "not_found");
      await expectServiceError(sendAgreementForFile(intruder, file.id), "not_found");
      expect(await voidOpenEnvelopesForFile(intruder, file.id, "x")).toBe(0);
      expect(await listEnvelopes(intruder)).toEqual([]);
      expect(await listEnvelopes(intruder, { fileId: file.id })).toEqual([]);
    }
    await expectServiceError(countersign(theirs.actor, envelopeId, { signature: SIGNATURE }), "not_found");
    // Their own file with my agreement id: the agreement is "not found" for them.
    const theirFile = await makeFile(theirs.org.id);
    await expectServiceError(sendAgreementForFile(theirs.actor, theirFile.id, { templateId: mine.template.id }), "not_found");
    // An actor claiming my org with their user id is not an active member of it.
    await expectServiceError(getEnvelope({ ...theirs.actor, orgId: mine.org.id }, envelopeId), "forbidden");

    // Nothing moved, and nothing was emailed to anyone because of the attempts.
    expect((await envelopeRow(envelopeId)).status).toBe("sent");
    expect((await signerRows(envelopeId))[0]).toMatchObject({ email: client.email, tokenHash: client.tokenHash });
    expect(getTestOutbox().filter((m) => m.to === "attacker@evil.test")).toHaveLength(0);
    expect((await getSigningSession(secret)).state).toBe("ready");
    expect(await eventTypes(envelopeId)).toEqual(["envelope.created", "envelope.sent", "envelope.viewed"]);

    // After completion the sealed copy is just as unreachable.
    await sign(secret);
    await countersign(mine.actor, envelopeId, { signature: SIGNATURE });
    expect((await getDocument(mine.actor, envelopeId, "signed")).bytes.length).toBeGreaterThan(1000);
    await expectServiceError(getDocument(theirs.actor, envelopeId, "signed"), "not_found");
  });

  it("a disabled team member can do nothing", async () => {
    const world = await makeWorld();
    const { envelopeId } = await sendOne(world);
    const former = await addUser(world.org.id, "admin", { disabledAt: new Date() });
    await expectServiceError(getEnvelope(actorFor(former), envelopeId), "forbidden");
    await expectServiceError(voidEnvelope(actorFor(former), envelopeId, "bye"), "forbidden");
    expect((await envelopeRow(envelopeId)).status).toBe("sent");
  });
});

describe("reading envelopes and documents", () => {
  it("shows signers, the trail, and links only for signers who can still sign", async () => {
    const world = await makeWorld({ company: true });
    const { envelopeId, secret, signingUrl: url, file } = await sendOne(world);
    let detail = await getEnvelope(world.actor, envelopeId);
    expect(detail.file).toMatchObject({ id: file.id, reference: file.reference });
    expect(detail.signers.map((s) => [s.role, s.status, s.isTurn])).toEqual([
      ["client", "sent", true],
      ["company", "waiting", false],
    ]);
    expect(detail.signers[0].signingUrl).toBe(url);
    expect(detail.signers[1].signingUrl).toMatch(/\/sign\//);
    expect(JSON.stringify(detail.signers)).not.toMatch(/tokenNonce|tokenHash|"values"/);
    expect(detail.events.map((e) => e.description)[1]).toBe(`Agreement emailed to ${file.clientEmail}`);

    await sign(secret);
    detail = await getEnvelope(world.actor, envelopeId);
    expect(detail.signers[0].signingUrl).toBeNull();
    expect(detail.signers[1].isTurn).toBe(true);
    await expectServiceError(getSigningLink(world.actor, detail.signers[0].id), "conflict");
    const link = await getSigningLink(world.actor, detail.signers[1].id);
    expect(link.signingUrl).toBe(detail.signers[1].signingUrl);

    await countersign(world.actor, envelopeId, { signature: SIGNATURE });
    detail = await getEnvelope(world.actor, envelopeId);
    expect(detail.envelope.status).toBe("completed");
    expect(detail.signers.every((s) => s.signingUrl === null && !s.isTurn)).toBe(true);
    await expectServiceError(getSigningLink(world.actor, detail.signers[1].id), "conflict");
    for (const id of [null, 5, "", "sgn_doesnotexist0000", {}]) await expectServiceError(getSigningLink(world.actor, id), "not_found");
  });

  it("lists by file and status and tolerates odd options", async () => {
    const world = await makeWorld();
    const a = await sendOne(world);
    const b = await sendOne(world);
    await voidEnvelope(world.actor, b.envelopeId, "test");
    const all = await listEnvelopes(world.actor);
    expect(all.map((e) => e.id).sort()).toEqual([a.envelopeId, b.envelopeId].sort());
    expect(all[0]).not.toHaveProperty("fields");
    expect(all[0].signers[0]).not.toHaveProperty("tokenHash");
    expect((await listEnvelopes(world.actor, { status: "voided" })).map((e) => e.id)).toEqual([b.envelopeId]);
    expect((await listEnvelopes(world.actor, { status: ["sent", "bogus"] })).map((e) => e.id)).toEqual([a.envelopeId]);
    expect(await listEnvelopes(world.actor, { status: "bogus" })).toEqual([]);
    expect(await listEnvelopes(world.actor, { fileId: { $gt: "" } })).toEqual([]);
    expect(await listEnvelopes(world.actor, { limit: -5, offset: "x" })).toHaveLength(2);
    expect(await listEnvelopes(world.actor, { limit: 1 })).toHaveLength(1);
    expect(await listEnvelopes(world.actor, null as never)).toHaveLength(2);
  });

  it("returns the original as sent and the signed copy only once sealed", async () => {
    const world = await makeWorld();
    const { envelopeId, secret } = await sendOne(world);
    const original = await getDocument(world.actor, envelopeId, "original");
    const envelope = await envelopeRow(envelopeId);
    expect(original.sha256).toBe(envelope.pdfSha256);
    expect(sha256Hex(original.bytes)).toBe(envelope.pdfSha256);
    await expectServiceError(getDocument(world.actor, envelopeId, "signed"), "not_ready");
    await expectServiceError(getDocument(world.actor, envelopeId, "certificate" as never), "invalid");
    await sign(secret);
    const signed = await getDocument(world.actor, envelopeId, "signed");
    expect(signed.sha256).toBe((await envelopeRow(envelopeId)).finalSha256);
    expect(signed.filename).toMatch(/\(signed\)\.pdf$/);
    expect(signed.sha256).not.toBe(original.sha256);
  });
});

describe("chasing and correcting", () => {
  it("resends to the signer whose turn it is, with a rate limit", async () => {
    const world = await makeWorld({ company: true });
    const { envelopeId, secret, file, signingUrl: url } = await sendOne(world);
    const [client, company] = await signerRows(envelopeId);
    expect((await expectServiceError(resendToSigner(world.actor, company.id), "conflict")).message).toMatch(/until the client has signed/);

    for (let i = 0; i < 5; i++) expect(await resendToSigner(world.actor, client.id)).toEqual({ delivery: "emailed", signingUrl: url });
    expect(mailTo(file.clientEmail, "signing_request")).toHaveLength(6);
    const limited = await expectServiceError(resendToSigner(world.actor, client.id), "rate_limited");
    expect(limited.message).toMatch(/copy the signing link/);
    expect(mailTo(file.clientEmail, "signing_request")).toHaveLength(6);

    await sign(secret);
    await expectServiceError(resendToSigner(world.actor, client.id), "conflict");
    clearTestOutbox();
    expect((await resendToSigner(world.actor, company.id)).delivery).toBe("emailed");
    expect(mailTo(world.owner.email, "countersign_request")).toHaveLength(1);
  });

  it("sends a manual reminder without using up the automatic ones", async () => {
    const world = await makeWorld();
    const { envelopeId, file, secret } = await sendOne(world);
    const before = await envelopeRow(envelopeId);
    const out = await sendReminderNow(world.actor, envelopeId);
    expect(out).toMatchObject({ delivery: "emailed", to: file.clientEmail });
    expect(mailTo(file.clientEmail, "reminder")).toHaveLength(1);
    const after = await envelopeRow(envelopeId);
    expect(after.reminderCount).toBe(0);
    expect(after.lastReminderAt).toBeInstanceOf(Date);
    expect(after.nextReminderAt!.getTime()).toBeGreaterThanOrEqual(before.nextReminderAt!.getTime());
    expect(count(await eventTypes(envelopeId), "reminder.sent")).toBe(1);
    await sendReminderNow(world.actor, envelopeId);
    await sendReminderNow(world.actor, envelopeId);
    await expectServiceError(sendReminderNow(world.actor, envelopeId), "rate_limited");

    await sign(secret);
    await expectServiceError(sendReminderNow(world.actor, envelopeId), "conflict");
    expect(mailTo(file.clientEmail, "reminder")).toHaveLength(3);
  });

  it("correcting a signer rotates the link, revokes the old one and emails the new address", async () => {
    const world = await makeWorld();
    const { envelopeId, secret: oldSecret, file } = await sendOne(world);
    await getSigningSession(oldSecret);
    const [client] = await signerRows(envelopeId);
    clearTestOutbox();

    const out = await updateSigner(world.actor, client.id, { name: "  Casey Q. Example ", email: " Casey.Right@Client.Test " });
    expect(out.delivery).toBe("emailed");
    const newSecret = secretOf(out.signingUrl);
    expect(newSecret).not.toBe(oldSecret);
    expect(out.signer).toMatchObject({ name: "Casey Q. Example", email: "casey.right@client.test", status: "sent", viewedAt: null, signingUrl: out.signingUrl });

    // The old link is indistinguishable from one that never existed.
    expect(await getSigningSession(oldSecret)).toEqual(await getSigningSession("A".repeat(43)));
    await expectServiceError(sign(oldSecret), "not_found");
    await expectServiceError(getSigningDocument(oldSecret), "not_found");
    await expectServiceError(declineSigning(oldSecret, "x"), "not_found");
    expect(await findSignerBySecret(oldSecret)).toBeNull();

    const [mail] = mailTo("casey.right@client.test", "signing_request");
    expect(mail.text).toContain(newSecret);
    expect(mailTo(file.clientEmail)).toHaveLength(0);
    const types = await eventTypes(envelopeId);
    expect(count(types, "signer.updated")).toBe(1);
    expect(count(types, "link.reissued")).toBe(1);
    // The name printed on the document follows the correction.
    expect((await envelopeRow(envelopeId)).prefill.p_name).toBe("Casey Q. Example");

    const session = await getSigningSession(newSecret);
    expect(session.state === "ready" && session.signer.name).toBe("Casey Q. Example");
    expect((await sign(newSecret)).completed).toBe(true);
    expect(mailTo("casey.right@client.test", "completed")).toHaveLength(1);
    await expectServiceError(updateSigner(world.actor, client.id, { email: "late@client.test" }), "conflict");
  });

  it("validates signer corrections and handles a countersigner who is not yet due", async () => {
    const world = await makeWorld({ company: true });
    const colleague = await addUser(world.org.id, "member");
    const { envelopeId } = await sendOne(world);
    const [client, company] = await signerRows(envelopeId);
    for (const patch of [{}, null, { email: "nope" }, { email: 5 }, { name: "   " }, { name: {} }, { email: "a@b.test\r\nBcc: x@y.test" }]) {
      await expectServiceError(updateSigner(world.actor, client.id, patch as never), "invalid");
    }
    expect((await signerRows(envelopeId))[0].tokenHash).toBe(client.tokenHash);

    clearTestOutbox();
    const out = await updateSigner(world.actor, company.id, { name: colleague.name, email: colleague.email });
    expect(out.delivery).toBe("not_their_turn");
    expect(getTestOutbox()).toHaveLength(0);
    const [, updated] = await signerRows(envelopeId);
    expect(updated).toMatchObject({ userId: colleague.id, email: colleague.email, status: "waiting" });
    expect(updated.tokenHash).not.toBe(company.tokenHash);
  });
});

describe("voiding", () => {
  it("voids an open envelope, tells a signer who had the email, and never changes a closed one", async () => {
    const world = await makeWorld({ company: true });
    const { envelopeId, file, secret } = await sendOne(world);
    clearTestOutbox();
    expect(await voidEnvelope(world.actor, envelopeId, "  Client asked to change the scope \u0000", { ip: "192.0.2.9" })).toEqual({ status: "voided", alreadyVoided: false });
    const envelope = await envelopeRow(envelopeId);
    expect(envelope).toMatchObject({ status: "voided", voidReason: "Client asked to change the scope", nextReminderAt: null });
    expect((await fileRow(file.id)).agreementStatus).toBe("no_agreement");
    const [mail] = mailTo(file.clientEmail, "voided");
    expect(mail.text).toContain("Client asked to change the scope");
    // The countersigner was never asked, so is not told.
    expect(getTestOutbox()).toHaveLength(1);

    expect(await voidEnvelope(world.actor, envelopeId, "again")).toEqual({ status: "voided", alreadyVoided: true });
    expect(count(await eventTypes(envelopeId), "envelope.voided")).toBe(1);
    expect(getTestOutbox()).toHaveLength(1);
    expect((await envelopeRow(envelopeId)).voidReason).toBe("Client asked to change the scope");
    await expectServiceError(sign(secret), "gone");
    await expectServiceError(resendToSigner(world.actor, (await signerRows(envelopeId))[0].id), "conflict");
    await expectServiceError(sendReminderNow(world.actor, envelopeId), "conflict");
    await expectServiceError(countersign(world.actor, envelopeId, { signature: SIGNATURE }), "conflict");
    for (const id of [null, "", 9, "env_doesnotexist0000"]) await expectServiceError(voidEnvelope(world.actor, id, "x"), "not_found");
  });

  it("does not email a client whose request never reached them", async () => {
    const world = await makeWorld();
    const file = await makeFile(world.org.id);
    setTestEmailFailure("Bounced", file.clientEmail);
    const sent = await sendAgreementForFile(world.actor, file.id);
    setTestEmailFailure(null);
    clearTestOutbox();
    await voidEnvelope(world.actor, sent.envelopeId, "Starting over");
    expect(mailTo(file.clientEmail)).toHaveLength(0);
  });

  it("voids everything open on a file and nothing else", async () => {
    const world = await makeWorld();
    const done = await sendOne(world);
    await sign(done.secret);
    const again = await sendAgreementForFile(world.actor, done.file.id, { replace: true });
    const other = await sendOne(world);
    expect(await voidOpenEnvelopesForFile(world.actor, done.file.id, "The file was archived")).toBe(1);
    expect((await envelopeRow(again.envelopeId)).status).toBe("voided");
    expect((await envelopeRow(done.envelopeId)).status).toBe("completed");
    expect((await envelopeRow(other.envelopeId)).status).toBe("sent");
    // The completed agreement still decides the file's status.
    expect((await fileRow(done.file.id)).agreementStatus).toBe("signed");
    expect(await voidOpenEnvelopesForFile(world.actor, done.file.id, "again")).toBe(0);
    await expectServiceError(voidOpenEnvelopesForFile(world.actor, null, "x"), "not_found");
  });
});

describe("countersigning while signed in", () => {
  it("lets the right people countersign once the client has signed, exactly once", async () => {
    const world = await makeWorld({ company: true });
    const signatory = await addUser(world.org.id, "member", { savedSignature: SIGNATURE, title: "Partner" });
    const bystander = await addUser(world.org.id, "member", { savedSignature: SIGNATURE });
    await setSettings(world.org.id, { countersignerUserId: signatory.id });
    const { envelopeId, secret, file } = await sendOne(world);

    expect((await expectServiceError(countersign(actorFor(signatory), envelopeId, {}), "conflict")).message).toMatch(/client has not signed/);
    await sign(secret);
    await expectServiceError(countersign(actorFor(bystander), envelopeId, {}), "forbidden");
    await expectServiceError(countersign(apiActor(world.org.id), envelopeId, { signature: SIGNATURE }), "forbidden");
    expect((await signerRows(envelopeId))[1].status).toBe("sent");

    // Saved signature, no drawing needed. Two clicks at once still sign once.
    const results = await Promise.all([
      countersign(actorFor(signatory), envelopeId, {}, { ip: "192.0.2.50" }),
      countersign(actorFor(signatory), envelopeId, {}, { ip: "192.0.2.50" }),
    ]);
    for (const r of results) expect(r.status).toBe("signed");
    expect(await countersign(actorFor(signatory), envelopeId, {})).toMatchObject({ completed: true });
    const [, company] = await signerRows(envelopeId);
    expect(company).toMatchObject({ status: "signed", userId: signatory.id, name: signatory.name, ip: "192.0.2.50" });
    expect(company.values).toMatchObject({ k_sig: SIGNATURE, k_name: signatory.name, k_title: "Partner" });
    const types = await eventTypes(envelopeId);
    expect(count(types, "envelope.countersigned")).toBe(1);
    expect(count(types, "envelope.completed")).toBe(1);
    expect((await envelopeRow(envelopeId)).status).toBe("completed");
    expect((await fileRow(file.id)).agreementStatus).toBe("signed");
    expect(mailTo(file.clientEmail, "completed")).toHaveLength(1);
  });

  it("an owner can step in, and is recorded as the one who signed", async () => {
    const world = await makeWorld({ company: true });
    const signatory = await addUser(world.org.id, "member");
    await setSettings(world.org.id, { countersignerUserId: signatory.id });
    const { envelopeId, secret } = await sendOne(world);
    await sign(secret);
    // No saved signature and none drawn: a plain reason, nothing recorded.
    const missing = await expectServiceError(countersign(world.actor, envelopeId, {}), "invalid");
    expect(missing.message).toMatch(/signature/i);
    expect(missing.fields?.k_sig).toBeTruthy();
    await expectServiceError(countersign(world.actor, envelopeId, { signature: "data:image/png;base64,AAAA" }), "invalid");
    await expectServiceError(countersign(world.actor, envelopeId, { signature: SIGNATURE, values: { c_note: "sneaky" } }), "invalid");
    await expectServiceError(countersign(world.actor, envelopeId, { signature: SIGNATURE, values: "x" }), "invalid");
    await expectServiceError(countersign(world.actor, envelopeId, null as never), "invalid");
    expect((await signerRows(envelopeId))[1].status).toBe("sent");

    const done = await countersign(world.actor, envelopeId, { signature: SIGNATURE, values: { k_title: "Owner" } });
    expect(done.completed).toBe(true);
    const [, company] = await signerRows(envelopeId);
    expect(company).toMatchObject({ userId: world.owner.id, name: world.owner.name, email: world.owner.email });
    expect(company.values.k_title).toBe("Owner");
    const verified = await verifyDocument({ sha256: (await envelopeRow(envelopeId)).finalSha256 });
    expect(verified.found && verified.signers[1].name).toBe(world.owner.name);
  });

  it("has nothing to countersign on a client-only agreement", async () => {
    const world = await makeWorld();
    const { envelopeId } = await sendOne(world);
    await expectServiceError(countersign(world.actor, envelopeId, { signature: SIGNATURE }), "conflict");
  });
});
