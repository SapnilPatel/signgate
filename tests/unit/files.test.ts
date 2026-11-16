import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";

// The envelope service is written by another engineer; only its contract is used here.
const { sendMock, voidMock } = vi.hoisted(() => ({ sendMock: vi.fn(), voidMock: vi.fn() }));
vi.mock("@/lib/services/envelopes", () => ({
  sendAgreementForFile: sendMock,
  voidOpenEnvelopesForFile: voidMock,
}));

import { getDb } from "@/lib/db";
import { blobs, envelopes, events, files, orgs, signers, users, webhookDeliveries, webhooks, type Envelope } from "@/lib/db/schema";
import { newId, sha256Hex } from "@/lib/ids";
import type { OrgSettings } from "@/lib/types";
import { ServiceError, type Actor } from "@/lib/services/context";
import { mapRows, parseCsv } from "@/lib/services/csv";
import {
  FILE_LIMITS,
  archiveFile,
  createFile,
  dashboardStats,
  fileCounts,
  getFile,
  importFiles,
  listFiles,
  summarizeImport,
  toPublicFile,
  unarchiveFile,
  updateFile,
  type CreateFileInput,
} from "@/lib/services/files";

let seq = 0;
const YEAR = new Date().getUTCFullYear();

async function newOrg(settings: OrgSettings = {}): Promise<{ orgId: string; actor: Actor }> {
  const db = await getDb();
  const orgId = newId("org");
  const userId = newId("usr");
  const n = ++seq;
  await db.insert(orgs).values({ id: orgId, name: `Test Co ${n}`, slug: `test-co-${n}`, settings });
  await db.insert(users).values({ id: userId, orgId, email: `owner${n}@example.com`, name: "Olive Owner", passwordHash: "x", role: "owner" });
  return { orgId, actor: { type: "user", orgId, userId, role: "owner", label: "Olive Owner" } };
}

const client = (over: Partial<CreateFileInput> = {}): CreateFileInput => ({
  clientName: "Jane Doe",
  clientEmail: `jane${++seq}@example.com`,
  ...over,
});

async function expectServiceError(promise: Promise<unknown>, code: ServiceError["code"], pattern?: RegExp): Promise<ServiceError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    const e = err as ServiceError;
    expect(e.code).toBe(code);
    expect(e.message.length).toBeGreaterThan(10);
    if (pattern) expect(e.message).toMatch(pattern);
    return e;
  }
  throw new Error(`expected ServiceError(${code})`);
}

/** Inserts an envelope row directly, standing in for the envelope service. */
async function addEnvelope(orgId: string, fileId: string, over: Partial<Envelope> = {}): Promise<string> {
  const db = await getDb();
  const bytes = Buffer.from("%PDF-test");
  const blobId = newId("blob");
  await db.insert(blobs).values({ id: blobId, orgId, bytes, sha256: sha256Hex(bytes), contentType: "application/pdf", size: bytes.length });
  const id = newId("env");
  await db.insert(envelopes).values({
    id,
    orgId,
    fileId,
    templateName: "Client agreement",
    templateVersion: 1,
    pdfBlobId: blobId,
    pdfSha256: sha256Hex(bytes),
    pages: [{ width: 612, height: 792 }],
    fields: [],
    status: "sent",
    sentAt: new Date(),
    ...over,
  });
  return id;
}

beforeEach(() => {
  sendMock.mockReset();
  voidMock.mockReset();
  // The real service moves the file to out_for_signature; the mock does the same so
  // createFile's "hand back the row as it is now" is exercised.
  sendMock.mockImplementation(async (actor: Actor, fileId: string) => {
    const db = await getDb();
    await db.update(files).set({ agreementStatus: "out_for_signature" }).where(and(eq(files.orgId, actor.orgId), eq(files.id, fileId)));
    return { envelopeId: `env_for_${fileId}`, delivery: "emailed", signingUrl: `https://app.test/sign/${fileId}` };
  });
  voidMock.mockResolvedValue(0);
});

describe("createFile", () => {
  it("creates the file, numbers it, records the event and sends the agreement", async () => {
    const { actor, orgId } = await newOrg();
    const res = await createFile(
      actor,
      { clientName: "  Jane   Doe ", clientEmail: "  Jane.Doe@Example.COM ", clientCompany: "Acme", description: "Kitchen\r\nremodel", data: { "Policy Number": "P-1" } },
      { ip: "203.0.113.9", userAgent: "vitest" },
    );
    expect(res.created).toBe(true);
    expect(res.file.reference).toBe(`F-${YEAR}-0001`);
    expect(res.file.clientName).toBe("Jane Doe");
    expect(res.file.clientEmail).toBe("jane.doe@example.com");
    expect(res.file.description).toBe("Kitchen\nremodel");
    expect(res.file.data).toEqual({ policy_number: "P-1" });
    expect(res.file.source).toBe("manual");
    expect(res.file.orgId).toBe(orgId);
    expect(res.file.agreementStatus).toBe("out_for_signature");
    expect(res.agreement).toEqual({ sent: true, envelopeId: `env_for_${res.file.id}`, delivery: "emailed", signingUrl: `https://app.test/sign/${res.file.id}` });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toBe(actor);
    expect(sendMock.mock.calls[0][1]).toBe(res.file.id);

    const db = await getDb();
    const rows = await db.select().from(events).where(eq(events.fileId, res.file.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("file.created");
    expect(rows[0].orgId).toBe(orgId);
    expect(rows[0].ip).toBe("203.0.113.9");
    expect(rows[0].data).toMatchObject({ reference: res.file.reference, source: "manual" });
  });

  it("numbers files in sequence and honours the org's prefix", async () => {
    const { actor } = await newOrg({ fileReferencePrefix: "JOB" });
    const a = await createFile(actor, client());
    const b = await createFile(actor, client());
    expect([a.file.reference, b.file.reference]).toEqual([`JOB-${YEAR}-0001`, `JOB-${YEAR}-0002`]);
  });

  it("falls back to the default prefix when the stored one is unusable", async () => {
    const { actor } = await newOrg({ fileReferencePrefix: "%' or 1=1 --" });
    expect((await createFile(actor, client())).file.reference).toBe(`F-${YEAR}-0001`);
  });

  it("gives 20 simultaneous creates 20 distinct consecutive references", async () => {
    const { actor } = await newOrg();
    const results = await Promise.all(Array.from({ length: 20 }, () => createFile(actor, client({ send: false }))));
    const refs = results.map((r) => r.file.reference).sort();
    expect(new Set(refs).size).toBe(20);
    expect(refs).toEqual(Array.from({ length: 20 }, (_, i) => `F-${YEAR}-${String(i + 1).padStart(4, "0")}`));
  });

  it("steps past hand-typed references that look like generated ones", async () => {
    const { actor } = await newOrg();
    await createFile(actor, client({ reference: `F-${YEAR}-0007`, send: false }));
    await createFile(actor, client({ reference: `F-${YEAR}-99999999999999999999`, send: false }));
    await createFile(actor, client({ reference: `F-${YEAR}-12x`, send: false }));
    expect((await createFile(actor, client({ send: false }))).file.reference).toBe(`F-${YEAR}-0008`);
  });

  it("keeps counting past 9999", async () => {
    const { actor } = await newOrg();
    await createFile(actor, client({ reference: `F-${YEAR}-9999`, send: false }));
    expect((await createFile(actor, client({ send: false }))).file.reference).toBe(`F-${YEAR}-10000`);
  });

  it("rejects a duplicate supplied reference, whatever its letter case", async () => {
    const { actor } = await newOrg();
    await createFile(actor, client({ reference: "Smith-22", send: false }));
    const err = await expectServiceError(createFile(actor, client({ reference: "smith-22" })), "conflict", /already uses the reference/);
    expect(err.fields?.reference).toBeTruthy();
    expect(sendMock).not.toHaveBeenCalled();
    expect((await listFiles(actor)).total).toBe(1);
  });

  it("reports a conflict when two creates race for the same reference", async () => {
    const { actor } = await newOrg();
    const settled = await Promise.allSettled([1, 2, 3].map(() => createFile(actor, client({ reference: "RACE-1", send: false }))));
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    for (const s of settled) {
      if (s.status === "rejected") {
        expect(s.reason).toBeInstanceOf(ServiceError);
        expect(s.reason.code).toBe("conflict");
      }
    }
  });

  it("is idempotent on externalId and does not send a second agreement", async () => {
    const { actor } = await newOrg();
    const first = await createFile(actor, client({ externalId: "crm-42" }));
    const again = await createFile(actor, { clientName: "Someone Else", clientEmail: "else@example.com", externalId: "crm-42" });
    expect(again.created).toBe(false);
    expect(again.file.id).toBe(first.file.id);
    expect(again.file.clientName).toBe("Jane Doe");
    expect(again.agreement.sent).toBe(false);
    expect(again.agreement.reason).toMatch(/already exists/);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const db = await getDb();
    expect(await db.select().from(events).where(and(eq(events.fileId, first.file.id), eq(events.type, "file.created")))).toHaveLength(1);
  });

  it("creates one file when the same externalId arrives five times at once", async () => {
    const { actor } = await newOrg();
    const input = client({ externalId: "burst-1" });
    const results = await Promise.all(Array.from({ length: 5 }, () => createFile(actor, input)));
    expect(new Set(results.map((r) => r.file.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect((await listFiles(actor)).total).toBe(1);
  });

  it("keeps the file when the org has no agreement ready and says why", async () => {
    const { actor } = await newOrg();
    sendMock.mockRejectedValue(new ServiceError("not_ready", "No default agreement is active yet. Upload your agreement and make it the default."));
    const res = await createFile(actor, client());
    expect(res.created).toBe(true);
    expect(res.agreement).toEqual({ sent: false, reason: "No default agreement is active yet. Upload your agreement and make it the default." });
    expect(res.file.agreementStatus).toBe("no_agreement");
    expect((await getFile(actor, res.file.id)).file.id).toBe(res.file.id);
  });

  it("keeps the file when sending fails in a way nobody planned for, without leaking the error", async () => {
    const { actor } = await newOrg();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    sendMock.mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'pdf')"));
    const res = await createFile(actor, client());
    spy.mockRestore();
    expect(res.created).toBe(true);
    expect(res.agreement.sent).toBe(false);
    expect(res.agreement.reason).toMatch(/could not be sent/);
    expect(res.agreement.reason).not.toMatch(/undefined/);
    expect((await listFiles(actor)).total).toBe(1);
  });

  it("passes through a send that produced a link but no email", async () => {
    const { actor } = await newOrg();
    sendMock.mockResolvedValue({ envelopeId: "env_x", delivery: "email_not_configured", signingUrl: "https://app.test/sign/x" });
    const res = await createFile(actor, client());
    expect(res.agreement).toEqual({ sent: true, envelopeId: "env_x", delivery: "email_not_configured", signingUrl: "https://app.test/sign/x" });
  });

  it("does not send when told not to, or when the org turned automatic sending off", async () => {
    const off = await newOrg({ autoSendOnFileCreate: false });
    const a = await createFile(off.actor, client());
    expect(a.agreement.sent).toBe(false);
    expect(a.agreement.reason).toMatch(/turned off in settings/);
    // An explicit send wins over the setting.
    const b = await createFile(off.actor, client({ send: true }));
    expect(b.agreement.sent).toBe(true);

    const on = await newOrg();
    const c = await createFile(on.actor, client({ send: false }));
    expect(c.agreement.sent).toBe(false);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("queues the file.created webhook in the creating transaction", async () => {
    const { actor, orgId } = await newOrg();
    const other = await newOrg();
    const db = await getDb();
    const hookId = newId("whk");
    await db.insert(webhooks).values({ id: hookId, orgId, url: "https://hooks.example.com/in", secret: "s" });
    await db.insert(webhooks).values({ id: newId("whk"), orgId: other.orgId, url: "https://hooks.example.com/other", secret: "s" });

    const res = await createFile(actor, client({ externalId: "ext-1", send: false }));
    const queued = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.orgId, orgId));
    expect(queued).toHaveLength(1);
    expect(queued[0].event).toBe("file.created");
    expect(queued[0].webhookId).toBe(hookId);
    expect(queued[0].payload).toMatchObject({ file: { id: res.file.id, reference: res.file.reference, externalId: "ext-1", clearedToStart: false } });
    expect(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.orgId, other.orgId))).toHaveLength(0);

    // A rejected create queues nothing.
    await expectServiceError(createFile(actor, client({ reference: res.file.reference })), "conflict");
    expect(await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.orgId, orgId))).toHaveLength(1);
  });

  it("explains every invalid field", async () => {
    const { actor } = await newOrg();
    const err = await expectServiceError(
      createFile(actor, { clientName: "   ", clientEmail: "not-an-email", clientPhone: "5".repeat(41), reference: "r".repeat(65) }),
      "invalid",
    );
    expect(Object.keys(err.fields ?? {}).sort()).toEqual(["clientEmail", "clientName", "clientPhone", "reference"]);
    expect(err.fields?.clientEmail).toMatch(/valid client email/);
    expect(err.fields?.clientPhone).toMatch(/40 characters or fewer/);
    const missing = await expectServiceError(createFile(actor, { clientName: "Jane", clientEmail: "" }), "invalid", /email is required/);
    expect(missing.fields).toEqual({ clientEmail: "Client email is required." });
    expect((await listFiles(actor)).total).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it.each([null, undefined, "text", 42, [], [{ clientName: "x" }]])("rejects input that is not an object: %j", async (input) => {
    const { actor } = await newOrg();
    await expectServiceError(createFile(actor, input as unknown as CreateFileInput), "invalid");
  });

  it("copes with values of the wrong type instead of crashing", async () => {
    const { actor } = await newOrg();
    await expectServiceError(createFile(actor, { clientName: { toString: () => "x" }, clientEmail: ["a@example.com"] }), "invalid");
    const res = await createFile(actor, {
      clientName: "Jane\u0000 Doe\uD800",
      clientEmail: "jane@example.com",
      clientCompany: 12345,
      clientTitle: null,
      clientPhone: undefined,
      description: {},
      source: "telepathy",
      send: "yes please",
      externalId: "",
      reference: "   ",
    });
    expect(res.file.clientName).not.toMatch(/\u0000/);
    expect(res.file.clientCompany).toBe("12345");
    expect(res.file.clientTitle).toBeNull();
    expect(res.file.description).toBeNull();
    expect(res.file.externalId).toBeNull();
    expect(res.file.source).toBe("manual");
    expect(res.file.reference).toBe(`F-${YEAR}-0001`);
    // A non-boolean send falls back to the org setting (on).
    expect(res.agreement.sent).toBe(true);
  });

  it("keeps non-Latin names and emoji intact", async () => {
    const { actor } = await newOrg();
    const res = await createFile(actor, client({ clientName: "山田 太郎 😀", clientCompany: "Müller & Søn ‮", send: false }));
    expect(res.file.clientName).toBe("山田 太郎 😀");
    expect((await listFiles(actor, { q: "山田" })).total).toBe(1);
  });

  it("bounds the extra values and never lets them touch the prototype", async () => {
    const { actor } = await newOrg();
    const hostile = JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":"c","Policy #":"P-9","nested":{"a":1},"n":7,"flag":true,"empty":"  ","###":"x"}');
    const res = await createFile(actor, client({ data: hostile, send: false }));
    expect(res.file.data).toEqual({ constructor: "c", policy: "P-9", n: "7", flag: "true" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const tooMany = Object.fromEntries(Array.from({ length: FILE_LIMITS.dataMaxKeys + 1 }, (_, i) => [`k${i}`, "v"]));
    const e1 = await expectServiceError(createFile(actor, client({ data: tooMany })), "invalid", /at most 50 extra values/);
    expect(e1.fields?.data).toBeTruthy();
    await expectServiceError(createFile(actor, client({ data: { note: "x".repeat(FILE_LIMITS.dataValueMax + 1) } })), "invalid", /"note" must be/);
    await expectServiceError(createFile(actor, client({ data: ["a", "b"] })), "invalid", /name and value pairs/);
  });

  it("takes the source from the caller: api for keys, anything valid when stated", async () => {
    const { orgId } = await newOrg();
    const api: Actor = { type: "api", orgId, keyId: "key_1", label: "Zapier" };
    const viaKey = await createFile(api, client({ send: false }));
    expect(viaKey.file.source).toBe("api");
    expect(viaKey.file.createdBy).toBeNull();
    expect((await createFile(api, client({ send: false, source: "intake" }))).file.source).toBe("intake");
  });

  it("refuses an actor with no org", async () => {
    await expectServiceError(createFile({ type: "user", orgId: "", userId: "u", role: "owner", label: "x" }, client()), "forbidden");
    await expectServiceError(createFile(null as unknown as Actor, client()), "forbidden");
    await expectServiceError(createFile({ type: "system", orgId: "org_does_not_exist", label: "System" }, client()), "forbidden");
  });
});

describe("tenant isolation", () => {
  it("never shows, changes or archives another org's file", async () => {
    const a = await newOrg();
    const b = await newOrg();
    const mine = (await createFile(a.actor, client({ reference: "SHARED-1", externalId: "ext-shared", clientName: "Alice Only", send: false }))).file;

    await expectServiceError(getFile(b.actor, mine.id), "not_found");
    await expectServiceError(updateFile(b.actor, mine.id, { clientName: "Hijacked" }), "not_found");
    await expectServiceError(archiveFile(b.actor, mine.id), "not_found");
    await expectServiceError(unarchiveFile(b.actor, mine.id), "not_found");
    expect(voidMock).not.toHaveBeenCalled();

    expect((await listFiles(b.actor)).total).toBe(0);
    expect((await listFiles(b.actor, { q: "Alice" })).files).toEqual([]);
    expect((await fileCounts(b.actor)).all).toBe(0);
    expect((await dashboardStats(b.actor)).notSent).toBe(0);

    const unchanged = await getFile(a.actor, mine.id);
    expect(unchanged.file.clientName).toBe("Alice Only");
    expect(unchanged.file.archivedAt).toBeNull();
  });

  it("lets two orgs use the same reference and externalId without seeing each other", async () => {
    const a = await newOrg();
    const b = await newOrg();
    const fa = await createFile(a.actor, client({ reference: "SAME-1", externalId: "same-ext", send: false }));
    const fb = await createFile(b.actor, client({ reference: "SAME-1", externalId: "same-ext", send: false }));
    expect(fb.created).toBe(true);
    expect(fb.file.id).not.toBe(fa.file.id);
    expect(fb.file.orgId).toBe(b.orgId);
    // Each org numbers from one.
    expect((await createFile(a.actor, client({ send: false }))).file.reference).toBe(`F-${YEAR}-0001`);
    expect((await createFile(b.actor, client({ send: false }))).file.reference).toBe(`F-${YEAR}-0001`);
  });

  it("imports against its own org's files only", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await createFile(a.actor, client({ reference: "IMP-1", send: false }));
    const results = await importFiles(b.actor, [{ clientName: "Bo", clientEmail: "bo@example.com", reference: "IMP-1" }], { send: false });
    expect(results[0].status).toBe("created");
  });

  it.each([null, undefined, 42, {}, "", "x".repeat(200), "file_doesnotexist0000", "'; drop table files; --"])("treats the id %j as not found", async (id) => {
    const { actor } = await newOrg();
    await expectServiceError(getFile(actor, id), "not_found");
    await expectServiceError(updateFile(actor, id, { clientName: "x" }), "not_found");
    await expectServiceError(archiveFile(actor, id), "not_found");
    await expectServiceError(unarchiveFile(actor, id), "not_found");
  });
});

describe("getFile", () => {
  it("returns envelopes newest first with signers, minus secrets and snapshots, and events in order", async () => {
    const { actor, orgId } = await newOrg();
    const { file } = await createFile(actor, client({ send: false }));
    const older = await addEnvelope(orgId, file.id, { status: "voided", createdAt: new Date(Date.now() - 60_000) });
    const newer = await addEnvelope(orgId, file.id, { status: "client_signed" });
    const db = await getDb();
    await db.insert(signers).values([
      { id: newId("sgn"), envelopeId: newer, orgId, role: "company", order: 2, name: "Olive Owner", email: "olive@example.com", tokenNonce: "n2", tokenHash: `h2-${newer}` },
      { id: newId("sgn"), envelopeId: newer, orgId, role: "client", order: 1, name: "Jane Doe", email: "jane@example.com", tokenNonce: "n1", tokenHash: `h1-${newer}`, status: "signed", values: { f1: "data:image/png;base64,AAAA" } },
    ]);
    await updateFile(actor, file.id, { description: "Roof" });

    const detail = await getFile(actor, file.id);
    expect(detail.envelopes.map((e) => e.id)).toEqual([newer, older]);
    expect(detail.envelopes[0].signers.map((s) => s.role)).toEqual(["client", "company"]);
    expect(detail.envelopes[1].signers).toEqual([]);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toMatch(/tokenNonce|tokenHash|data:image/);
    expect(detail.envelopes[0]).not.toHaveProperty("fields");
    expect(detail.envelopes[0]).not.toHaveProperty("pages");
    expect(detail.events.map((e) => e.type)).toEqual(["file.created", "file.updated"]);
  });
});

describe("listFiles, fileCounts", () => {
  async function seed() {
    const org = await newOrg();
    const mk = (over: Partial<CreateFileInput>) => createFile(org.actor, client({ send: false, ...over })).then((r) => r.file);
    const smith = await mk({ clientName: "Jane Smith", clientEmail: "jane.smith@acme.example", clientCompany: "Acme Roofing", reference: "ROOF-1" });
    const lee = await mk({ clientName: "Sam Lee", clientEmail: "sam@lee.example", clientCompany: "Lee & Sons" });
    const pct = await mk({ clientName: "100% Organic_Co", clientEmail: "hello@organic.example" });
    const old = await mk({ clientName: "Old Client", clientEmail: "old@example.com" });
    const db = await getDb();
    await db.update(files).set({ agreementStatus: "signed" }).where(eq(files.id, smith.id));
    await db.update(files).set({ agreementStatus: "out_for_signature" }).where(eq(files.id, lee.id));
    await archiveFile(org.actor, old.id);
    return { ...org, smith, lee, pct, old };
  }

  it("searches name, email, company and reference, case-insensitively, requiring every word", async () => {
    const s = await seed();
    const ids = async (q: unknown) => (await listFiles(s.actor, { q })).files.map((f) => f.id);
    expect(await ids("SMITH")).toEqual([s.smith.id]);
    expect(await ids("lee.example")).toEqual([s.lee.id]);
    expect(await ids("roofing")).toEqual([s.smith.id]);
    expect(await ids("roof-1")).toEqual([s.smith.id]);
    expect(await ids("  jane   acme ")).toEqual([s.smith.id]);
    expect(await ids("jane lee")).toEqual([]);
    expect(await ids("")).toHaveLength(3);
    expect(await ids(null)).toHaveLength(3);
    expect(await ids({ evil: true })).toHaveLength(3);
  });

  it("treats %, _ and backslash in a search as ordinary characters", async () => {
    const s = await seed();
    const ids = async (q: string) => (await listFiles(s.actor, { q })).files.map((f) => f.id);
    expect(await ids("%")).toEqual([s.pct.id]);
    expect(await ids("organic_co")).toEqual([s.pct.id]);
    expect(await ids("organic_c_")).toEqual([]);
    expect(await ids("\\")).toEqual([]);
    expect(await ids("'; drop table files; --")).toEqual([]);
  });

  it("filters by status and archive state", async () => {
    const s = await seed();
    expect((await listFiles(s.actor, { status: "signed" })).files.map((f) => f.id)).toEqual([s.smith.id]);
    expect((await listFiles(s.actor, { status: ["signed", "out_for_signature"] })).total).toBe(2);
    expect((await listFiles(s.actor, { status: "all" })).total).toBe(3);
    expect((await listFiles(s.actor, { status: "bogus" })).total).toBe(0);
    expect((await listFiles(s.actor, { archived: true })).files.map((f) => f.id)).toEqual([s.old.id]);
    expect((await listFiles(s.actor, { archived: "all" })).total).toBe(4);
    expect((await listFiles(s.actor, { archived: false })).total).toBe(3);
  });

  it("pages newest first and clamps nonsense paging", async () => {
    const s = await seed();
    const p1 = await listFiles(s.actor, { pageSize: 2 });
    expect(p1).toMatchObject({ total: 3, page: 1, pageSize: 2, pageCount: 2 });
    expect(p1.files).toHaveLength(2);
    expect(p1.files[0].createdAt.getTime()).toBeGreaterThanOrEqual(p1.files[1].createdAt.getTime());
    const p2 = await listFiles(s.actor, { pageSize: "2", page: "2" });
    expect(p2.files).toHaveLength(1);
    expect(new Set([...p1.files, ...p2.files].map((f) => f.id)).size).toBe(3);
    // Past the end shows the last page.
    expect((await listFiles(s.actor, { pageSize: 2, page: 99 })).page).toBe(2);
    expect((await listFiles(s.actor, { pageSize: -5, page: -1 })).pageSize).toBe(1);
    expect((await listFiles(s.actor, { pageSize: 1e9 })).pageSize).toBe(FILE_LIMITS.pageSizeMax);
    expect(await listFiles(s.actor, { pageSize: "abc", page: NaN })).toMatchObject({ page: 1, pageSize: FILE_LIMITS.pageSizeDefault });
    expect((await listFiles(s.actor, null as never)).total).toBe(3);
  });

  it("counts current files by status and archived ones separately", async () => {
    const s = await seed();
    expect(await fileCounts(s.actor)).toEqual({
      all: 3,
      archived: 1,
      no_agreement: 1,
      out_for_signature: 1,
      awaiting_countersign: 0,
      signed: 1,
      declined: 0,
      needs_attention: 0,
    });
    const empty = await newOrg();
    expect((await fileCounts(empty.actor)).all).toBe(0);
  });
});

describe("dashboardStats", () => {
  it("is all zeros and nulls for a new account", async () => {
    const { actor } = await newOrg();
    expect(await dashboardStats(actor)).toEqual({
      open: 0,
      notSent: 0,
      needsAttention: 0,
      signedThisMonth: 0,
      medianSecondsToSign: null,
      oldestOutstanding: null,
      completionRate: null,
    });
  });

  it("reports open files, signed this month, median time to sign, oldest outstanding and completion rate", async () => {
    const { actor, orgId } = await newOrg();
    const other = await newOrg();
    const now = new Date(Date.UTC(2026, 5, 20, 12));
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
    const mk = async (status: "no_agreement" | "out_for_signature" | "awaiting_countersign" | "signed" | "declined", who = actor) => {
      const { file } = await createFile(who, client({ send: false }));
      const db = await getDb();
      await db.update(files).set({ agreementStatus: status }).where(eq(files.id, file.id));
      return file;
    };

    const s1 = await mk("signed");
    const s2 = await mk("signed");
    const s3 = await mk("signed");
    const lastMonth = await mk("signed");
    const out1 = await mk("out_for_signature");
    const out2 = await mk("awaiting_countersign");
    const declined = await mk("declined");
    await mk("no_agreement");

    // Completed this month, taking 1 h, 3 h and 10 h: the median is 3 h.
    await addEnvelope(orgId, s1.id, { status: "completed", sentAt: hoursAgo(30), completedAt: hoursAgo(29) });
    await addEnvelope(orgId, s2.id, { status: "completed", sentAt: hoursAgo(50), completedAt: hoursAgo(47) });
    await addEnvelope(orgId, s3.id, { status: "completed", sentAt: hoursAgo(100), completedAt: hoursAgo(90) });
    // Completed before the first of the month: counts for the median (3 h again) but not "this month".
    await addEnvelope(orgId, lastMonth.id, { status: "completed", sentAt: hoursAgo(24 * 30 + 3), completedAt: hoursAgo(24 * 30) });
    const oldestEnv = await addEnvelope(orgId, out1.id, { status: "viewed", sentAt: hoursAgo(24 * 9 + 2) });
    await addEnvelope(orgId, out2.id, { status: "client_signed", sentAt: hoursAgo(24 * 2) });
    await addEnvelope(orgId, declined.id, { status: "declined", sentAt: hoursAgo(24 * 4) });
    // Ignored: voided, never sent, and far too old for the 90-day window.
    await addEnvelope(orgId, out1.id, { status: "voided", sentAt: hoursAgo(24 * 20) });
    await addEnvelope(orgId, out2.id, { status: "draft", sentAt: null });
    await addEnvelope(orgId, s1.id, { status: "completed", sentAt: hoursAgo(24 * 200), completedAt: hoursAgo(24 * 150) });

    // Another org's activity must not move these numbers.
    const foreign = await mk("out_for_signature", other.actor);
    await addEnvelope(other.orgId, foreign.id, { status: "sent", sentAt: hoursAgo(24 * 60) });

    const stats = await dashboardStats(actor, now);
    expect(stats.open).toBe(2);
    expect(stats.notSent).toBe(1);
    expect(stats.needsAttention).toBe(1);
    expect(stats.signedThisMonth).toBe(3);
    expect(stats.medianSecondsToSign).toBe(3 * 3600);
    expect(stats.oldestOutstanding).toMatchObject({ fileId: out1.id, envelopeId: oldestEnv, reference: out1.reference, status: "viewed", daysOutstanding: 9 });
    // 4 completed of 7 sent in the window, voided excluded.
    expect(stats.completionRate).toBeCloseTo(4 / 7, 5);
  });

  it("leaves archived files out of the oldest outstanding", async () => {
    const { actor, orgId } = await newOrg();
    const { file } = await createFile(actor, client({ send: false }));
    await addEnvelope(orgId, file.id, { status: "sent", sentAt: new Date(Date.now() - 5 * 86_400_000) });
    expect((await dashboardStats(actor)).oldestOutstanding?.fileId).toBe(file.id);
    await archiveFile(actor, file.id);
    expect((await dashboardStats(actor)).oldestOutstanding).toBeNull();
  });
});

describe("updateFile", () => {
  it("changes only what is in the patch and records what changed", async () => {
    const { actor } = await newOrg();
    const { file } = await createFile(actor, client({ clientCompany: "Acme", description: "Before", data: { a: "1" }, send: false }));
    const res = await updateFile(actor, file.id, { description: "After", clientCompany: "", clientPhone: "555-0100", data: { A: "1", b: "2" } });
    expect(res.changed.sort()).toEqual(["company", "description", "extra values", "phone"]);
    expect(res.file).toMatchObject({ description: "After", clientCompany: null, clientPhone: "555-0100", data: { a: "1", b: "2" }, clientName: "Jane Doe" });
    expect(res.file.updatedAt.getTime()).toBeGreaterThanOrEqual(file.updatedAt.getTime());
    expect(res.reissueSuggested).toBe(false);
    expect(res.outstandingEnvelope).toBeNull();

    const db = await getDb();
    const rows = await db.select().from(events).where(and(eq(events.fileId, file.id), eq(events.type, "file.updated")));
    expect(rows).toHaveLength(1);
    expect((rows[0].data as { changed: string[] }).changed.sort()).toEqual(res.changed.sort());
  });

  it("records nothing when the patch changes nothing", async () => {
    const { actor } = await newOrg();
    const { file } = await createFile(actor, client({ clientEmail: "same@example.com", data: { a: "1" }, send: false }));
    const res = await updateFile(actor, file.id, { clientName: " Jane  Doe ", clientEmail: "SAME@example.com", data: { a: "1" }, clientTitle: undefined });
    expect(res.changed).toEqual([]);
    expect(res.file.updatedAt.getTime()).toBe(file.updatedAt.getTime());
    const db = await getDb();
    expect(await db.select().from(events).where(and(eq(events.fileId, file.id), eq(events.type, "file.updated")))).toHaveLength(0);
    expect((await updateFile(actor, file.id, {})).changed).toEqual([]);
  });

  it("suggests reissuing the link when the client's email or name changes while they have not signed", async () => {
    const { actor, orgId } = await newOrg();
    const { file } = await createFile(actor, client({ send: false }));
    const envId = await addEnvelope(orgId, file.id, { status: "viewed" });

    const other = await updateFile(actor, file.id, { description: "x" });
    expect(other.reissueSuggested).toBe(false);
    expect(other.outstandingEnvelope).toEqual({ id: envId, status: "viewed" });

    const email = await updateFile(actor, file.id, { clientEmail: "new.address@example.com" });
    expect(email.reissueSuggested).toBe(true);
    expect(email.outstandingEnvelope).toEqual({ id: envId, status: "viewed" });
    expect((await updateFile(actor, file.id, { clientName: "Jane Q. Doe" })).reissueSuggested).toBe(true);
    // updateFile never touches the envelope itself.
    expect(sendMock).not.toHaveBeenCalled();
    expect(voidMock).not.toHaveBeenCalled();
  });

  it.each(["client_signed", "completed", "voided", "declined", "expired"] as const)("does not suggest a reissue once the envelope is %s", async (status) => {
    const { actor, orgId } = await newOrg();
    const { file } = await createFile(actor, client({ send: false }));
    await addEnvelope(orgId, file.id, { status });
    const res = await updateFile(actor, file.id, { clientEmail: "moved@example.com" });
    expect(res.changed).toEqual(["client email"]);
    expect(res.reissueSuggested).toBe(false);
    expect(res.outstandingEnvelope).toBeNull();
  });

  it("validates the patch and refuses a reference another file uses", async () => {
    const { actor } = await newOrg();
    const a = (await createFile(actor, client({ reference: "A-1", send: false }))).file;
    const b = (await createFile(actor, client({ reference: "B-1", send: false }))).file;
    await expectServiceError(updateFile(actor, b.id, { reference: "a-1" }), "conflict", /already uses/);
    await expectServiceError(updateFile(actor, b.id, { reference: "" }), "invalid", /reference is required/);
    await expectServiceError(updateFile(actor, b.id, { clientEmail: "nope" }), "invalid");
    await expectServiceError(updateFile(actor, b.id, { clientName: "" }), "invalid");
    await expectServiceError(updateFile(actor, b.id, null as never), "invalid");
    await expectServiceError(updateFile(actor, b.id, [] as never), "invalid");
    // Re-saving its own reference in another case is a change, not a conflict.
    expect((await updateFile(actor, a.id, { reference: "a-1" })).file.reference).toBe("a-1");
    expect((await getFile(actor, b.id)).file.reference).toBe("B-1");
  });

  it("ignores keys a caller must not set", async () => {
    const { actor } = await newOrg();
    const other = await newOrg();
    const { file } = await createFile(actor, client({ send: false }));
    const res = await updateFile(actor, file.id, { orgId: other.orgId, id: "file_x", agreementStatus: "signed", externalId: "sneaky", archivedAt: new Date() } as never);
    expect(res.changed).toEqual([]);
    expect(res.file).toMatchObject({ orgId: actor.orgId, id: file.id, agreementStatus: "no_agreement", externalId: null, archivedAt: null });
  });
});

describe("archiveFile, unarchiveFile", () => {
  it("archives once, voids open envelopes and can be undone", async () => {
    const { actor } = await newOrg();
    const { file } = await createFile(actor, client({ send: false }));
    voidMock.mockResolvedValue(2);

    const res = await archiveFile(actor, file.id, { ip: "203.0.113.1" });
    expect(res.voided).toBe(2);
    expect(res.file.archivedAt).toBeInstanceOf(Date);
    expect(voidMock).toHaveBeenCalledWith(actor, file.id, expect.stringMatching(/archived/i));

    // A double click archives nothing new and writes no second event.
    voidMock.mockResolvedValue(0);
    const again = await archiveFile(actor, file.id);
    expect(again.voided).toBe(0);
    expect(again.file.archivedAt?.getTime()).toBe(res.file.archivedAt?.getTime());

    const restored = await unarchiveFile(actor, file.id);
    expect(restored.archivedAt).toBeNull();
    expect((await unarchiveFile(actor, file.id)).archivedAt).toBeNull();

    const types = (await getFile(actor, file.id)).events.map((e) => e.type);
    expect(types).toEqual(["file.created", "file.archived", "file.unarchived"]);
  });

  it("writes one event when two archive requests arrive together", async () => {
    const { actor } = await newOrg();
    const { file } = await createFile(actor, client({ send: false }));
    await Promise.all([archiveFile(actor, file.id), archiveFile(actor, file.id), archiveFile(actor, file.id)]);
    const db = await getDb();
    expect(await db.select().from(events).where(and(eq(events.fileId, file.id), eq(events.type, "file.archived")))).toHaveLength(1);
  });

  it("stays archived and reports the problem when voiding fails, and a retry finishes the job", async () => {
    const { actor } = await newOrg();
    const { file } = await createFile(actor, client({ send: false }));
    voidMock.mockRejectedValueOnce(new ServiceError("conflict", "The agreement is being signed right now. Try again in a moment."));
    await expectServiceError(archiveFile(actor, file.id), "conflict");
    expect((await getFile(actor, file.id)).file.archivedAt).toBeInstanceOf(Date);
    voidMock.mockResolvedValue(1);
    expect((await archiveFile(actor, file.id)).voided).toBe(1);
  });
});

describe("importFiles", () => {
  it("creates good rows and reports bad ones without stopping", async () => {
    const { actor } = await newOrg();
    await createFile(actor, client({ reference: "EXIST-1", send: false }));
    await createFile(actor, client({ externalId: "crm-1", send: false }));
    sendMock.mockClear();

    const results = await importFiles(actor, [
      { row: 2, clientName: "Ann Able", clientEmail: "ann@example.com", reference: "NEW-1", data: { Region: "North" } },
      { row: 3, clientName: "", clientEmail: "blank@example.com" },
      { row: 4, clientName: "Bad Email", clientEmail: "not an email" },
      { row: 5, clientName: "Dup Ref", clientEmail: "dup@example.com", reference: "exist-1" },
      { row: 6, clientName: "Dup Ext", clientEmail: "dupext@example.com", externalId: "crm-1" },
      { row: 7, clientName: "Batch Dup", clientEmail: "batch@example.com", reference: "new-1" },
      null,
      "garbage",
      { row: 10, clientName: "Cy Cole", clientEmail: "cy@example.com", externalId: "crm-2" },
      { row: 11, clientName: "Cy Again", clientEmail: "cy2@example.com", externalId: "crm-2" },
      { row: 12, clientName: "Dee Day", clientEmail: "dee@example.com" },
      { row: 13, clientName: "dee day", clientEmail: "DEE@example.com" },
      { row: 14, clientName: "Dee Day", clientEmail: "dee@example.com", description: "A second job" },
    ] as never);

    expect(results.map((r) => [r.row, r.status])).toEqual([
      [2, "created"],
      [3, "error"],
      [4, "error"],
      [5, "skipped"],
      [6, "skipped"],
      [7, "skipped"],
      [7, "error"],
      [8, "error"],
      [10, "created"],
      [11, "skipped"],
      [12, "created"],
      [13, "skipped"],
      [14, "created"],
    ]);
    expect(results[1].message).toMatch(/Client name is required/);
    expect(results[2].message).toMatch(/valid client email/);
    expect(results[3].message).toMatch(/reference exist-1 already exists/);
    expect(results[4].message).toMatch(/external ID crm-1 already exists/);
    expect(results[5].message).toMatch(/row 2 has the same reference/);
    expect(results[9].message).toMatch(/row 10 has the same external ID/);
    expect(results[11].message).toMatch(/identical to row 12/);
    for (const r of results) expect(r.message.length).toBeGreaterThan(5);

    const created = results.filter((r) => r.status === "created");
    expect(created.every((r) => r.fileId && r.reference && r.agreementSent)).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(4);
    expect(summarizeImport(results)).toEqual({ created: 4, skipped: 5, errors: 4, agreementsSent: 4 });

    const first = await getFile(actor, created[0].fileId!);
    expect(first.file).toMatchObject({ source: "csv", reference: "NEW-1", data: { region: "North" } });
    expect((await listFiles(actor, { pageSize: 100 })).total).toBe(6);
  });

  it("lets a corrected row through after an earlier row with the same reference failed", async () => {
    const { actor } = await newOrg();
    const results = await importFiles(actor, [
      { clientName: "Ann", clientEmail: "broken", reference: "R-1" },
      { clientName: "Ann", clientEmail: "ann@example.com", reference: "R-1" },
    ], { send: false });
    expect(results.map((r) => r.status)).toEqual(["error", "created"]);
    expect(results.map((r) => r.row)).toEqual([1, 2]);
  });

  it("creates every file even when no agreement can be sent, and stops trying after the first refusal", async () => {
    const { actor } = await newOrg();
    sendMock.mockRejectedValue(new ServiceError("not_ready", "No default agreement is active yet."));
    const rows = Array.from({ length: 5 }, (_, i) => ({ clientName: `Client ${i}`, clientEmail: `c${i}@example.com` }));
    const results = await importFiles(actor, rows);
    expect(results.every((r) => r.status === "created" && r.agreementSent === false)).toBe(true);
    expect(results.every((r) => /No default agreement is active yet/.test(r.message))).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect((await listFiles(actor)).total).toBe(5);
  });

  it("keeps going when one agreement fails for a reason particular to that file", async () => {
    const { actor } = await newOrg();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    sendMock.mockRejectedValueOnce(new Error("socket hang up"));
    const results = await importFiles(actor, [
      { clientName: "A", clientEmail: "a@example.com" },
      { clientName: "B", clientEmail: "b@example.com" },
    ]);
    spy.mockRestore();
    expect(results.map((r) => r.agreementSent)).toEqual([false, true]);
    expect(results[0].status).toBe("created");
    expect(results[0].message).not.toMatch(/socket/);
  });

  it("respects send: false, the org setting and the time budget", async () => {
    const off = await newOrg({ autoSendOnFileCreate: false });
    const r1 = await importFiles(off.actor, [{ clientName: "A", clientEmail: "a@example.com" }]);
    expect(r1[0].agreementSent).toBe(false);
    expect(r1[0].message).toMatch(/not sent/);
    expect(sendMock).not.toHaveBeenCalled();

    const on = await newOrg();
    const r2 = await importFiles(on.actor, [{ clientName: "A", clientEmail: "a@example.com" }, { clientName: "B", clientEmail: "b@example.com" }], { sendBudgetMs: 0 });
    expect(r2.map((r) => r.status)).toEqual(["created", "created"]);
    expect(r2.every((r) => /ran out of time/.test(r.message))).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("describes a send that made a link but could not email it", async () => {
    const { actor } = await newOrg();
    sendMock.mockResolvedValueOnce({ envelopeId: "e1", delivery: "email_failed", signingUrl: "u" });
    sendMock.mockResolvedValueOnce({ envelopeId: "e2", delivery: "email_not_configured", signingUrl: "u" });
    const results = await importFiles(actor, [{ clientName: "A", clientEmail: "a@example.com" }, { clientName: "B", clientEmail: "b@example.com" }]);
    expect(results[0].message).toMatch(/email could not be delivered/);
    expect(results[1].message).toMatch(/email is not set up/);
    expect(results.every((r) => r.agreementSent)).toBe(true);
  });

  it("refuses more than 1000 rows before creating anything, and accepts exactly 1000 shapes of nothing", async () => {
    const { actor } = await newOrg();
    const rows = Array.from({ length: FILE_LIMITS.importMaxRows + 1 }, (_, i) => ({ clientName: `C${i}`, clientEmail: `c${i}@example.com` }));
    await expectServiceError(importFiles(actor, rows), "invalid", /at most 1000 rows and this one has 1001/);
    expect((await listFiles(actor)).total).toBe(0);
    await expectServiceError(importFiles(actor, "rows" as never), "invalid");
    await expectServiceError(importFiles(actor, null as never), "invalid");
    expect(await importFiles(actor, [])).toEqual([]);
  });

  it("imports a whole spreadsheet end to end, numbering generated references in order", async () => {
    const { actor } = await newOrg();
    const csv = parseCsv(
      'Full name;E-mail;Company;Matter;Policy Number\r\n"Doe; Jane";Jane Doe <JANE@example.com>;Acme;;P-1\r\n\r\nSam Lee;sam@example.com;;M-77;\r\nNo Email;;;;\r\n',
    );
    const mapped = mapRows(csv.headers, csv.rows, csv.rowNumbers);
    expect(mapped.error).toBeNull();
    const results = await importFiles(actor, mapped.rows, { send: false });
    expect(results.map((r) => [r.row, r.status])).toEqual([
      [2, "created"],
      [4, "created"],
      [5, "error"],
    ]);
    const jane = (await getFile(actor, results[0].fileId!)).file;
    expect(jane).toMatchObject({ clientName: "Doe; Jane", clientEmail: "jane@example.com", clientCompany: "Acme", reference: `F-${YEAR}-0001`, data: { policy_number: "P-1" } });
    expect(results[1].reference).toBe("M-77");
  });
});

describe("toPublicFile", () => {
  it("marks a file cleared to start only when the agreement is signed", async () => {
    const { actor } = await newOrg();
    const { file } = await createFile(actor, client({ send: false }));
    expect(toPublicFile(file).clearedToStart).toBe(false);
    expect(toPublicFile({ ...file, agreementStatus: "signed" }).clearedToStart).toBe(true);
    expect(toPublicFile(file)).not.toHaveProperty("orgId");
    expect(typeof toPublicFile(file).createdAt).toBe("string");
  });
});
