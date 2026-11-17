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
import { authTokens, emailLog, envelopes, events, files, orgs, rateLimits, sessions, signers, templates, uploadChunks, users, webhookDeliveries, webhooks, type Envelope, type FileRow, type Org, type Signer, type Template, type User } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import type { Field, OrgSettings } from "@/lib/types";
import { ServiceError, type Actor } from "@/lib/services/context";
import { putBlob } from "@/lib/services/blobs";
import { clearTestOutbox, getTestOutbox, setTestEmailFailure, setTestEmailUnconfigured } from "@/lib/services/email";
import { countersign, getEnvelope, sendAgreementForFile, voidEnvelope } from "@/lib/services/envelopes";
import { declineSigning, getSignedCopy, getSigningSession, submitSigning } from "@/lib/services/signing";
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
  // Verified, as every owner is once they have used their confirmation link; without it client emails are held.
  const owner = await addUser(org.id, "owner", { emailVerifiedAt: new Date() });
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

beforeEach(async () => {
  clearTestOutbox();
  seal.fail = false;
  // The scheduler works across every company, so each test starts with no envelopes left over from the last.
  const db = await getDb();
  await db.delete(envelopes);
});

const DAY = 86_400_000;
const inDays = (days: number) => new Date(Date.now() + days * DAY + 60_000);
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000);

describe("reminders", () => {
  it("reminds a client who has not signed, on schedule, and stops at the cap", async () => {
    const world = await makeWorld({ settings: { reminderEveryDays: 2, maxReminders: 2, expireAfterDays: 0 } });
    const { envelopeId, file, signingUrl: url } = await sendOne(world);
    expect((await envelopeRow(envelopeId)).expiresAt).toBeNull();

    // Not due yet.
    expect((await runScheduledJobs(inDays(1))).reminders).toEqual({ sent: 0, failed: 0, stopped: 0 });
    expect(mailTo(file.clientEmail, "reminder")).toHaveLength(0);

    const first = await runScheduledJobs(inDays(2));
    expect(first.reminders.sent).toBe(1);
    expect(first.errors).toEqual([]);
    let envelope = await envelopeRow(envelopeId);
    expect(envelope.reminderCount).toBe(1);
    expect(envelope.nextReminderAt!.getTime()).toBeGreaterThan(inDays(3.9).getTime());
    const [mail] = mailTo(file.clientEmail, "reminder");
    expect(mail.text).toContain(url);
    // Running again at the same moment sends nothing more.
    expect((await runScheduledJobs(inDays(2))).reminders.sent).toBe(0);

    expect((await runScheduledJobs(inDays(4))).reminders.sent).toBe(1);
    envelope = await envelopeRow(envelopeId);
    expect(envelope.reminderCount).toBe(2);
    expect(envelope.nextReminderAt).toBeNull();

    for (const days of [6, 8, 30, 400]) expect((await runScheduledJobs(inDays(days))).reminders.sent).toBe(0);
    expect(mailTo(file.clientEmail, "reminder")).toHaveLength(2);
    const db = await getDb();
    const sent = await db.select().from(events).where(and(eq(events.envelopeId, envelopeId), eq(events.type, "reminder.sent"))).orderBy(asc(events.createdAt));
    expect(sent.map((e) => e.data.count)).toEqual([1, 2]);
    expect(sent[0].actorType).toBe("system");
    expect((await envelopeRow(envelopeId)).status).toBe("sent");
  });

  it("never reminds someone who has signed, declined or been voided", async () => {
    const world = await makeWorld({ company: true, settings: { expireAfterDays: 0 } });
    const signed = await sendOne(world);
    const declined = await sendOne(world);
    const voided = await sendOne(world);
    const viewed = await sendOne(world);
    await sign(signed.secret); // waiting for the countersignature: the client is done
    await declineSigning(declined.secret, "no thanks");
    await voidEnvelope(world.actor, voided.envelopeId, "cancelled");
    await getSigningSession(viewed.secret);
    clearTestOutbox();

    const summary = await runScheduledJobs(inDays(3));
    expect(summary.reminders.sent).toBe(1);
    expect(getTestOutbox().filter((m) => m.kind === "reminder").map((m) => m.to)).toEqual([viewed.file.clientEmail]);
    // The client who signed is never reminded; from then on the schedule chases the countersigner instead.
    expect(mailTo(signed.file.clientEmail, "reminder")).toHaveLength(0);

    // Signing between two runs stops the reminders that were scheduled.
    await sign(viewed.secret);
    clearTestOutbox();
    expect((await runScheduledJobs(inDays(10))).reminders.sent).toBe(0);
    expect(getTestOutbox().filter((m) => m.kind === "reminder")).toHaveLength(0);
  });

  it("clears a stale schedule instead of reminding a client who already signed", async () => {
    const world = await makeWorld({ settings: { expireAfterDays: 0 } });
    const { envelopeId, file } = await sendOne(world);
    const db = await getDb();
    // A state no code path should produce, to prove the signer check does not rely on the envelope status alone.
    await db.update(signers).set({ status: "signed", signedAt: new Date() }).where(eq(signers.envelopeId, envelopeId));
    const summary = await runScheduledJobs(inDays(3));
    expect(summary.reminders).toEqual({ sent: 0, failed: 0, stopped: 1 });
    expect(mailTo(file.clientEmail, "reminder")).toHaveLength(0);
    expect((await envelopeRow(envelopeId)).nextReminderAt).toBeNull();
  });

  it("advances the schedule even when the email fails, and records the failure", async () => {
    const world = await makeWorld({ settings: { reminderEveryDays: 1, maxReminders: 3, expireAfterDays: 0 } });
    const { envelopeId, file } = await sendOne(world);
    setTestEmailFailure("Mailbox full", file.clientEmail);
    const summary = await runScheduledJobs(inDays(1));
    expect(summary.reminders).toEqual({ sent: 0, failed: 1, stopped: 0 });
    const envelope = await envelopeRow(envelopeId);
    expect(envelope.reminderCount).toBe(1);
    expect(envelope.nextReminderAt!.getTime()).toBeGreaterThan(inDays(1.9).getTime());
    expect(count(await eventTypes(envelopeId), "envelope.delivery_failed")).toBe(1);
    // Not retried every few minutes.
    expect((await runScheduledJobs(inDays(1))).reminders.failed).toBe(0);
    setTestEmailFailure(null);
    expect((await runScheduledJobs(inDays(2))).reminders.sent).toBe(1);
  });

  it("respects reminders being switched off, at send time and afterwards", async () => {
    const off = await makeWorld({ settings: { reminderEveryDays: 0, expireAfterDays: 0 } });
    const a = await sendOne(off);
    expect((await envelopeRow(a.envelopeId)).nextReminderAt).toBeNull();

    const later = await makeWorld({ settings: { expireAfterDays: 0 } });
    const b = await sendOne(later);
    await setSettings(later.org.id, { maxReminders: 0, expireAfterDays: 0 });
    const summary = await runScheduledJobs(inDays(5));
    expect(summary.reminders.sent).toBe(0);
    expect(summary.reminders.stopped).toBeGreaterThanOrEqual(1);
    expect((await envelopeRow(b.envelopeId)).nextReminderAt).toBeNull();
    expect(getTestOutbox().filter((m) => m.kind === "reminder" && (m.to === a.file.clientEmail || m.to === b.file.clientEmail))).toHaveLength(0);
  });

  it("does not remind about a request that was never delivered", async () => {
    const world = await makeWorld({ settings: { expireAfterDays: 0 } });
    const file = await makeFile(world.org.id);
    setTestEmailUnconfigured(true);
    const sent = await sendAgreementForFile(world.actor, file.id);
    setTestEmailUnconfigured(false);
    expect((await envelopeRow(sent.envelopeId)).status).toBe("draft");
    expect((await runScheduledJobs(inDays(3))).reminders.sent).toBe(0);
    expect(mailTo(file.clientEmail)).toHaveLength(0);
  });

  it("two runs at the same time send one reminder", async () => {
    const world = await makeWorld({ settings: { expireAfterDays: 0 } });
    const { envelopeId, file } = await sendOne(world);
    const at = inDays(2);
    const runs = await Promise.all([runScheduledJobs(at), runScheduledJobs(at), runScheduledJobs(at)]);
    expect(runs.reduce((n, r) => n + r.reminders.sent, 0)).toBe(1);
    expect(mailTo(file.clientEmail, "reminder")).toHaveLength(1);
    expect((await envelopeRow(envelopeId)).reminderCount).toBe(1);
    expect(runs.flatMap((r) => r.errors)).toEqual([]);
  });
});

describe("expiry", () => {
  it("expires an overdue envelope once, tells both sides, and the link says so", async () => {
    const world = await makeWorld({ settings: { expireAfterDays: 7 } });
    const db = await getDb();
    await db.insert(webhooks).values({ id: newId("whk"), orgId: world.org.id, url: "https://hooks.example.test/in", secret: "whsec_test_only", active: false });
    const { envelopeId, file, secret } = await sendOne(world);
    expect((await runScheduledJobs(inDays(6))).expired).toBe(0);
    clearTestOutbox();

    const at = inDays(7);
    const runs = await Promise.all([runScheduledJobs(at), runScheduledJobs(at)]);
    expect(runs.reduce((n, r) => n + r.expired, 0)).toBe(1);
    expect(runs.flatMap((r) => r.errors)).toEqual([]);
    const envelope = await envelopeRow(envelopeId);
    expect(envelope).toMatchObject({ status: "expired", nextReminderAt: null });
    expect((await fileRow(file.id)).agreementStatus).toBe("needs_attention");
    expect(count(await eventTypes(envelopeId), "envelope.expired")).toBe(1);
    expect(mailTo(world.owner.email, "expired")).toHaveLength(1);
    const toClient = mailTo(file.clientEmail);
    expect(toClient).toHaveLength(1);
    expect(toClient[0].text).toMatch(/expired/);
    // No reminder went out in the same run for the link that just died.
    expect(getTestOutbox().filter((m) => m.kind === "reminder")).toHaveLength(0);

    expect((await getSigningSession(secret)).state).toBe("expired");
    await expectServiceError(sign(secret), "gone");
    expect((await runScheduledJobs(inDays(60))).expired).toBe(0);
    expect((await envelopeRow(envelopeId)).status).toBe("expired");
    // The file can have the agreement sent again.
    const again = await sendAgreementForFile(world.actor, file.id);
    expect((await envelopeRow(again.envelopeId)).status).toBe("sent");
    expect((await fileRow(file.id)).agreementStatus).toBe("out_for_signature");
  });

  it("does not expire an agreement the client has already signed, or one set never to expire", async () => {
    const world = await makeWorld({ company: true, settings: { expireAfterDays: 5 } });
    const waiting = await sendOne(world);
    await sign(waiting.secret);
    const never = await makeWorld({ settings: { expireAfterDays: 0 } });
    const open = await sendOne(never);
    const summary = await runScheduledJobs(inDays(90));
    expect(summary.expired).toBe(0);
    expect((await envelopeRow(waiting.envelopeId)).status).toBe("client_signed");
    expect((await envelopeRow(open.envelopeId)).status).toBe("sent");
    // The countersigner can still finish it long afterwards.
    expect((await countersign(world.actor, waiting.envelopeId, { signature: SIGNATURE })).completed).toBe(true);
  });

  it("expires a draft whose email never went out, without emailing the client", async () => {
    const world = await makeWorld({ settings: { expireAfterDays: 3 } });
    const file = await makeFile(world.org.id);
    setTestEmailFailure("Bounced", file.clientEmail);
    const sent = await sendAgreementForFile(world.actor, file.id);
    setTestEmailFailure(null);
    clearTestOutbox();
    expect((await runScheduledJobs(inDays(3))).expired).toBe(1);
    expect((await envelopeRow(sent.envelopeId)).status).toBe("expired");
    expect(mailTo(file.clientEmail)).toHaveLength(0);
    expect(mailTo(world.owner.email, "expired")).toHaveLength(1);
  });
});

describe("finalization retry", () => {
  it("seals a fully signed envelope whose sealing failed, on the next run", async () => {
    const world = await makeWorld({ company: true });
    await setSettings(world.org.id, { countersignerUserId: world.owner.id });
    const { envelopeId, secret, file } = await sendOne(world);
    await sign(secret);
    seal.fail = true;
    const result = await countersign(world.actor, envelopeId, { signature: SIGNATURE });
    expect(result).toMatchObject({ status: "signed", completed: false, next: "finalizing" });
    expect((await envelopeRow(envelopeId)).status).toBe("client_signed");
    expect((await signerRows(envelopeId)).map((s) => s.status)).toEqual(["signed", "signed"]);

    // Straight after a failure the scheduler waits; five minutes later it tries again.
    expect((await runScheduledJobs()).finalized).toEqual({ completed: 0, failed: 0 });
    const failed = await runScheduledJobs(inMinutes(6));
    expect(failed.finalized).toEqual({ completed: 0, failed: 1 });
    expect((await fileRow(file.id)).agreementStatus).toBe("needs_attention");

    seal.fail = false;
    const runs = await Promise.all([runScheduledJobs(inMinutes(30)), runScheduledJobs(inMinutes(30))]);
    expect(runs.reduce((n, r) => n + r.finalized.completed, 0)).toBe(1);
    const envelope = await envelopeRow(envelopeId);
    expect(envelope.status).toBe("completed");
    expect((await fileRow(file.id)).agreementStatus).toBe("signed");
    expect(count(await eventTypes(envelopeId), "envelope.completed")).toBe(1);
    expect(mailTo(file.clientEmail, "completed")).toHaveLength(1);
    expect((await getSignedCopy(secret)).sha256).toBe(envelope.finalSha256);
    expect((await runScheduledJobs()).finalized).toEqual({ completed: 0, failed: 0 });
  });

  it("leaves envelopes that are still waiting for a signature alone", async () => {
    const world = await makeWorld({ company: true });
    const { envelopeId, secret } = await sendOne(world);
    await sign(secret);
    const calls = seal.calls;
    await runScheduledJobs();
    expect(seal.calls).toBe(calls);
    expect((await envelopeRow(envelopeId)).status).toBe("client_signed");
  });
});

describe("housekeeping", () => {
  it("purges what is stale and keeps what is live", async () => {
    const world = await makeWorld();
    const db = await getDb();
    const past = new Date(Date.now() - 3 * DAY);
    const future = new Date(Date.now() + 3 * DAY);
    await db.insert(sessions).values([
      { id: "sess_expired_test", userId: world.owner.id, expiresAt: past },
      { id: "sess_live_test", userId: world.owner.id, expiresAt: future },
    ]);
    await db.insert(authTokens).values([
      { id: "tok_used_old", kind: "password_reset", email: "a@company.test", expiresAt: future, usedAt: past },
      { id: "tok_expired_old", kind: "invite", orgId: world.org.id, email: "b@company.test", role: "member", expiresAt: past },
      { id: "tok_used_just_now", kind: "password_reset", email: "c@company.test", expiresAt: future, usedAt: new Date() },
      { id: "tok_live", kind: "invite", orgId: world.org.id, email: "d@company.test", role: "member", expiresAt: future },
    ]);
    await db.insert(rateLimits).values([
      { key: "test:stale", count: 3, resetAt: past },
      { key: "test:live", count: 3, resetAt: future },
    ]);
    await db.insert(uploadChunks).values([
      { uploadId: "upl_stale_test", idx: 0, orgId: world.org.id, bytes: Buffer.from("old"), createdAt: past },
      { uploadId: "upl_fresh_test", idx: 0, orgId: world.org.id, bytes: Buffer.from("new") },
    ]);

    const summary = await runScheduledJobs();
    expect(summary.errors).toEqual([]);
    expect(summary.outOfTime).toBe(false);
    expect(summary.purged).toMatchObject({ uploadChunks: 1, sessions: 1, authTokens: 2 });
    expect(summary.purged.rateLimits).toBeGreaterThanOrEqual(1);
    expect(Date.parse(summary.finishedAt)).toBeGreaterThanOrEqual(Date.parse(summary.startedAt));

    expect((await db.select().from(sessions)).map((s) => s.id)).toEqual(["sess_live_test"]);
    expect((await db.select().from(authTokens)).map((t) => t.id).sort()).toEqual(["tok_live", "tok_used_just_now"]);
    const keys = (await db.select().from(rateLimits)).map((r) => r.key);
    expect(keys).toContain("test:live");
    expect(keys).not.toContain("test:stale");
    expect((await db.select().from(uploadChunks)).map((c) => c.uploadId)).toEqual(["upl_fresh_test"]);

    // A second run finds nothing left to do.
    const again = await runScheduledJobs();
    expect(again.purged).toMatchObject({ uploadChunks: 0, sessions: 0, authTokens: 0 });
    expect(again.errors).toEqual([]);
  });

  it("delivers queued webhooks and survives a nonsense clock", async () => {
    const world = await makeWorld();
    const db = await getDb();
    // Paused, so the queued delivery is settled without any network call.
    const hookId = newId("whk");
    await db.insert(webhooks).values({ id: hookId, orgId: world.org.id, url: "https://hooks.example.test/in", secret: "whsec_test_only" });
    await sendOne(world);
    await db.update(webhooks).set({ active: false }).where(eq(webhooks.id, hookId));
    expect((await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, hookId)))[0].status).toBe("pending");
    for (const clock of [undefined, new Date(Number.NaN), "tomorrow" as never, null as never]) {
      const summary = await runScheduledJobs(clock);
      expect(summary.errors).toEqual([]);
    }
    expect((await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, hookId)))[0].status).not.toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Regression tests for review findings
// ---------------------------------------------------------------------------

describe("chasing the countersigner", () => {
  it("reminds the countersigner on the company's cadence, then flags the file, and never expires the agreement", async () => {
    const world = await makeWorld({ company: true, settings: { reminderEveryDays: 2, maxReminders: 2, expireAfterDays: 5 } });
    const admin = await addUser(world.org.id, "admin");
    await setSettings(world.org.id, { reminderEveryDays: 2, maxReminders: 2, expireAfterDays: 5, countersignerUserId: admin.id });
    const { envelopeId, secret, file } = await sendOne(world);
    await sign(secret);
    expect(mailTo(admin.email, "countersign_request")).toHaveLength(1);
    expect(await envelopeRow(envelopeId)).toMatchObject({ status: "client_signed", reminderCount: 0 });
    expect((await envelopeRow(envelopeId)).nextReminderAt).toBeInstanceOf(Date);

    // Not yet due.
    expect((await runScheduledJobs(inDays(1))).countersign).toEqual({ reminded: 0, failed: 0, escalated: 0 });

    // Due: reminded once even with two runners.
    const runs = await Promise.all([runScheduledJobs(inDays(2)), runScheduledJobs(inDays(2))]);
    expect(runs.reduce((n, r) => n + r.countersign.reminded, 0)).toBe(1);
    expect(mailTo(admin.email, "countersign_request")).toHaveLength(2);
    expect((await envelopeRow(envelopeId)).reminderCount).toBe(1);
    expect((await runScheduledJobs(inDays(3))).countersign.reminded).toBe(0);

    expect((await runScheduledJobs(inDays(4))).countersign.reminded).toBe(1);
    expect(mailTo(admin.email, "countersign_request")).toHaveLength(3);
    // The client is never chased for the company's delay.
    expect(mailTo(file.clientEmail, "reminder")).toHaveLength(0);

    // Reminders used up: the file is flagged for the team, once.
    const escalated = await runScheduledJobs(inDays(6));
    expect(escalated.countersign).toEqual({ reminded: 0, failed: 0, escalated: 1 });
    expect(escalated.expired).toBe(0);
    expect((await fileRow(file.id)).agreementStatus).toBe("needs_attention");
    expect(count(await eventTypes(envelopeId), "countersign.overdue")).toBe(1);
    const trail = (await getEnvelope(world.actor, envelopeId)).events;
    expect(String(trail.find((e) => e.type === "countersign.overdue")?.data.reason)).toMatch(/has not countersigned after 2 reminders/);
    expect(trail.find((e) => e.type === "countersign.overdue")?.description).toMatch(/^Countersignature overdue: .* has not countersigned after 2 reminders/);
    // Whoever sent it hears once that the company's signature is what the client is waiting on; the person already asked does not get another email.
    const [overdue, ...extra] = mailTo(world.owner.email, "countersign_overdue");
    expect(extra).toHaveLength(0);
    expect(overdue.subject).toMatch(/^Countersignature overdue/);
    expect(overdue.text).toContain(admin.name);
    expect(overdue.text).toMatch(/after 2 reminders/);
    expect(overdue.text).toContain(`/files/${file.id}`);
    expect(mailTo(admin.email, "countersign_overdue")).toHaveLength(0);
    expect(mailTo(file.clientEmail, "countersign_overdue")).toHaveLength(0);
    const later = await runScheduledJobs(inDays(45));
    expect(later.countersign).toEqual({ reminded: 0, failed: 0, escalated: 0 });
    expect(later.expired).toBe(0);
    expect(mailTo(admin.email, "countersign_request")).toHaveLength(3);
    expect((await envelopeRow(envelopeId)).status).toBe("client_signed");

    // It can still be finished, which clears the flag.
    expect((await countersign(world.actor, envelopeId, { signature: SIGNATURE })).completed).toBe(true);
    expect((await fileRow(file.id)).agreementStatus).toBe("signed");
    expect((await runScheduledJobs(inDays(60))).countersign).toEqual({ reminded: 0, failed: 0, escalated: 0 });
  });

  it("still chases when client reminders are switched off, and stops as soon as it is countersigned", async () => {
    const world = await makeWorld({ company: true, settings: { reminderEveryDays: 0, expireAfterDays: 0 } });
    const { envelopeId, secret } = await sendOne(world);
    expect((await envelopeRow(envelopeId)).nextReminderAt).toBeNull();
    await sign(secret);
    clearTestOutbox();
    expect((await runScheduledJobs(inDays(2))).countersign.reminded).toBe(1);
    expect(mailTo(world.owner.email, "countersign_request")).toHaveLength(1);
    await countersign(world.actor, envelopeId, { signature: SIGNATURE });
    clearTestOutbox();
    expect((await runScheduledJobs(inDays(30))).countersign).toEqual({ reminded: 0, failed: 0, escalated: 0 });
    expect(getTestOutbox().filter((m) => m.kind === "countersign_request")).toHaveLength(0);
  });

  it("flags the file straight away when the countersigner can no longer sign", async () => {
    const world = await makeWorld({ company: true, settings: { expireAfterDays: 0 } });
    const admin = await addUser(world.org.id, "admin");
    await setSettings(world.org.id, { expireAfterDays: 0, countersignerUserId: admin.id });
    const { envelopeId, secret, file } = await sendOne(world);
    await sign(secret);
    const db = await getDb();
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, admin.id));
    clearTestOutbox();
    const summary = await runScheduledJobs(inDays(2));
    expect(summary.countersign).toEqual({ reminded: 0, failed: 0, escalated: 1 });
    expect(mailTo(admin.email)).toHaveLength(0);
    expect((await fileRow(file.id)).agreementStatus).toBe("needs_attention");
    expect(await eventTypes(envelopeId)).toContain("countersign.overdue");
  });

  it("counts a reminder that could not be delivered and records it on the file", async () => {
    const world = await makeWorld({ company: true, settings: { expireAfterDays: 0 } });
    const { envelopeId, secret } = await sendOne(world);
    await sign(secret);
    setTestEmailFailure("Mailbox full", world.owner.email);
    const summary = await runScheduledJobs(inDays(2));
    expect(summary.countersign).toEqual({ reminded: 0, failed: 1, escalated: 0 });
    expect(summary.errors).toEqual([]);
    expect(await eventTypes(envelopeId)).toContain("envelope.delivery_failed");
  });
});

describe("emails owed by a request that died", () => {
  /** Puts an envelope in the state a killed function leaves behind: committed, but no trace of the email step. */
  async function forgetEmails(envelopeId: string, kinds: string[], eventTypesToDrop: string[]): Promise<void> {
    const db = await getDb();
    for (const kind of kinds) await db.delete(emailLog).where(and(eq(emailLog.envelopeId, envelopeId), eq(emailLog.kind, kind)));
    for (const type of eventTypesToDrop) await db.delete(events).where(and(eq(events.envelopeId, envelopeId), eq(events.type, type)));
  }

  it("sends the signing request of a draft that was never attempted, once", async () => {
    const world = await makeWorld({ settings: { expireAfterDays: 0, reminderEveryDays: 0 } });
    const { envelopeId, file } = await sendOne(world);
    const db = await getDb();
    await forgetEmails(envelopeId, ["signing_request"], ["envelope.sent"]);
    await db.update(envelopes).set({ status: "draft", sentAt: null }).where(eq(envelopes.id, envelopeId));
    clearTestOutbox();

    // Too fresh: the original request may still be working on it.
    expect((await runScheduledJobs()).recovered.requests).toBe(0);
    expect(mailTo(file.clientEmail)).toHaveLength(0);

    const runs = await Promise.all([runScheduledJobs(inMinutes(10)), runScheduledJobs(inMinutes(10))]);
    expect(runs.reduce((n, r) => n + r.recovered.requests, 0)).toBe(1);
    expect(runs.flatMap((r) => r.errors)).toEqual([]);
    expect(mailTo(file.clientEmail, "signing_request")).toHaveLength(1);
    const envelope = await envelopeRow(envelopeId);
    expect(envelope.status).toBe("sent");
    expect(envelope.sentAt).toBeInstanceOf(Date);
    expect(count(await eventTypes(envelopeId), "envelope.sent")).toBe(1);
    expect((await runScheduledJobs(inMinutes(40))).recovered.requests).toBe(0);
    expect(mailTo(file.clientEmail, "signing_request")).toHaveLength(1);
  });

  it("leaves alone a draft whose delivery was attempted and failed, or whose link is shared by hand", async () => {
    const world = await makeWorld({ settings: { expireAfterDays: 0, reminderEveryDays: 0 } });
    const bounced = await makeFile(world.org.id);
    setTestEmailFailure("Bounced", bounced.clientEmail);
    await sendAgreementForFile(world.actor, bounced.id);
    setTestEmailFailure(null);
    setTestEmailUnconfigured(true);
    await sendOne(world);
    setTestEmailUnconfigured(false);
    clearTestOutbox();
    const summary = await runScheduledJobs(inMinutes(10));
    expect(summary.recovered).toEqual({ requests: 0, completed: 0, countersign: 0 });
    expect(getTestOutbox()).toHaveLength(0);
  });

  it("sends the completed copies of an agreement that was sealed but never emailed, once", async () => {
    const world = await makeWorld({ settings: { expireAfterDays: 0 } });
    const { envelopeId, secret, file } = await sendOne(world);
    await sign(secret);
    expect((await envelopeRow(envelopeId)).status).toBe("completed");
    await forgetEmails(envelopeId, ["completed"], []);
    clearTestOutbox();

    expect((await runScheduledJobs()).recovered.completed).toBe(0);
    const summary = await runScheduledJobs(inMinutes(10));
    expect(summary.recovered.completed).toBe(1);
    const copies = getTestOutbox().filter((m) => m.kind === "completed");
    expect(copies.map((m) => m.to).sort()).toEqual([file.clientEmail, world.owner.email].sort());
    expect(copies[0].attachments).toHaveLength(1);
    expect((await runScheduledJobs(inMinutes(40))).recovered.completed).toBe(0);
    expect(getTestOutbox().filter((m) => m.kind === "completed")).toHaveLength(2);
  });

  it("asks the countersigner who was never asked", async () => {
    const world = await makeWorld({ company: true, settings: { expireAfterDays: 0 } });
    const { envelopeId, secret } = await sendOne(world);
    await sign(secret);
    await forgetEmails(envelopeId, ["countersign_request"], ["countersign.requested"]);
    clearTestOutbox();
    expect((await runScheduledJobs()).recovered.countersign).toBe(0);
    expect((await runScheduledJobs(inMinutes(10))).recovered.countersign).toBe(1);
    expect(mailTo(world.owner.email, "countersign_request")).toHaveLength(1);
    expect((await runScheduledJobs(inMinutes(40))).recovered.countersign).toBe(0);
    expect(mailTo(world.owner.email, "countersign_request")).toHaveLength(1);
  });
});

describe("what the client hears about an expiry", () => {
  it("is told the link expired and how to get a new one, not that the company cancelled", async () => {
    const world = await makeWorld({ settings: { expireAfterDays: 7 } });
    const { file } = await sendOne(world);
    clearTestOutbox();
    expect((await runScheduledJobs(inDays(7))).expired).toBe(1);
    const [toClient] = mailTo(file.clientEmail);
    expect(toClient.kind).toBe("link_expired");
    expect(toClient.subject).toMatch(/Your signing link for Client Services Agreement has expired/);
    expect(`${toClient.subject} ${toClient.text}`).not.toMatch(/cancel/i);
    expect(toClient.text).toMatch(/ask them to send the agreement again/);
    expect(mailTo(file.clientEmail, "voided")).toHaveLength(0);
  });
});
