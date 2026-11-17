import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { deflateSync } from "node:zlib";

import { getDb } from "@/lib/db";
import { apiKeys, envelopes, files, orgs, templates, users, type Org, type Template, type User } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import type { Field } from "@/lib/types";
import { API_RATE_LIMIT, MAX_BODY_BYTES } from "@/lib/api/http";
import { EXAMPLE_RESPONSES } from "@/lib/api/examples";
import { resetTickForTests, tick } from "@/lib/api/tick";
import { createApiKey } from "@/lib/services/api-keys";
import { putBlob } from "@/lib/services/blobs";
import type { Actor } from "@/lib/services/context";
import { clearRateLimit, clearRateLimitPrefix } from "@/lib/services/rate-limit";
import { finalizeEnvelope, submitSigning } from "@/lib/services/signing";

import * as filesRoute from "@/app/api/v1/files/route";
import * as fileRoute from "@/app/api/v1/files/[id]/route";
import * as sendRoute from "@/app/api/v1/files/[id]/send/route";
import * as archiveRoute from "@/app/api/v1/files/[id]/archive/route";
import * as agreementsRoute from "@/app/api/v1/agreements/route";
import * as envelopeRoute from "@/app/api/v1/envelopes/[id]/route";
import * as voidRoute from "@/app/api/v1/envelopes/[id]/void/route";
import * as remindRoute from "@/app/api/v1/envelopes/[id]/remind/route";
import * as documentRoute from "@/app/api/v1/envelopes/[id]/document/route";
import * as meRoute from "@/app/api/v1/me/route";
import * as catchAll from "@/app/api/v1/[...path]/route";
import * as cronRoute from "@/app/api/cron/route";
import * as healthRoute from "@/app/api/health/route";

// ---------------------------------------------------------------------------
// Fixtures (test data only)
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
  doc.addPage([612, 792]).drawText("Client Services Agreement", { x: 72, y: 700, size: 16 });
  return doc.save();
}

let seq = 0;
const field = (id: string, type: Field["type"], role: Field["role"], required: boolean): Field => ({ id, page: 0, x: 0.1, y: 0.1 + ++seq * 0.01, w: 0.3, h: 0.04, type, role, required, label: id, source: "manual" });

interface World {
  org: Org;
  owner: User;
  actor: Actor;
  template: Template;
  key: string;
  keyId: string;
}

async function addTemplate(org: Org, owner: User, over: Partial<Template> = {}): Promise<Template> {
  const db = await getDb();
  const blob = await putBlob(db, { orgId: org.id, bytes: await makePdf(), contentType: "application/pdf", filename: "agreement.pdf" });
  const [template] = await db
    .insert(templates)
    .values({
      id: newId("tpl"),
      orgId: org.id,
      name: "Client Services Agreement",
      status: "active",
      isDefault: true,
      pdfBlobId: blob.id,
      pages: [{ width: 612, height: 792 }],
      fields: [field("c_sig", "signature", "client", true), field("c_name", "full_name", "client", true)],
      version: 2,
      createdBy: owner.id,
      ...over,
    })
    .returning();
  return template;
}

async function makeWorld(opts: { noTemplate?: boolean } = {}): Promise<World> {
  const db = await getDb();
  const n = ++seq;
  const [org] = await db.insert(orgs).values({ id: newId("org"), name: `Northwind Test ${n}`, legalName: `Northwind Test ${n} Ltd`, slug: `northwind-${n}`, settings: {} }).returning();
  const [owner] = await db
    .insert(users)
    .values({ id: newId("usr"), orgId: org.id, email: `owner${n}@company.test`, name: "Olive Owner", passwordHash: "not-a-real-hash", role: "owner", emailVerifiedAt: new Date() })
    .returning();
  const actor: Actor = { type: "user", orgId: org.id, userId: owner.id, role: "owner", label: "Olive Owner" };
  const template = opts.noTemplate ? (null as unknown as Template) : await addTemplate(org, owner);
  const created = await createApiKey(actor, "Case system");
  return { org, owner, actor, template, key: created.key, keyId: created.row.id };
}

const BASE = "https://app.test/api/v1";

function req(method: string, path: string, key: string | null, body?: unknown, headers: Record<string, string> = {}): Request {
  const init: RequestInit = { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] ??= "application/json";
  }
  return new Request(`${BASE}${path}`, init);
}
const ctx = <P>(params: P) => ({ params: Promise.resolve(params) });
const none = ctx({} as Record<string, never>);

interface ErrorBody {
  error: { code: string; message: string; fields?: Record<string, string> };
}
async function expectError(res: Response, status: number, code: string): Promise<ErrorBody["error"]> {
  const body = (await res.json()) as ErrorBody;
  expect(res.status, JSON.stringify(body)).toBe(status);
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body.error.code).toBe(code);
  expect(body.error.message.length).toBeGreaterThan(15);
  return body.error;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- responses are checked field by field below */
async function createFile(world: World, body: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<{ res: Response; json: any }> {
  const n = ++seq;
  const res = await filesRoute.POST(req("POST", "/files", world.key, { client_name: `Casey Example ${n}`, client_email: `client${n}@client.test`, ...body }, headers), none);
  return { res, json: await res.json() };
}

/** Every key of `actual`, recursively, against the documented example: the docs must show exactly what the API returns. */
function expectSameShape(actual: unknown, example: unknown, path = "$"): void {
  if (actual === null || example === null || typeof actual !== "object" || typeof example !== "object") return;
  if (Array.isArray(actual) || Array.isArray(example)) {
    if (Array.isArray(actual) && Array.isArray(example) && actual.length > 0 && example.length > 0) expectSameShape(actual[0], example[0], `${path}[0]`);
    return;
  }
  // `data` holds the caller's own names, so its keys are not part of the shape.
  if (path.endsWith(".data")) return;
  expect(Object.keys(actual).sort(), `keys at ${path}`).toEqual(Object.keys(example).sort());
  for (const key of Object.keys(actual)) expectSameShape((actual as any)[key], (example as any)[key], `${path}.${key}`);
}

const SECRETS = /token_?(nonce|hash)|key_?hash|password|pdf_?blob|final_?blob|org_?id|created_?by|"ip"|user_?agent/i;

beforeEach(async () => {
  await clearRateLimitPrefix("api:");
});

// ---------------------------------------------------------------------------

describe("authentication", () => {
  it("answers 401 with WWW-Authenticate for a missing, malformed, unknown or revoked key, all alike", async () => {
    const world = await makeWorld();
    const db = await getDb();
    const revoked = await createApiKey(world.actor, "Old system");
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, revoked.row.id));
    const attempts = [
      req("GET", "/me", null),
      req("GET", "/me", "not-a-key"),
      req("GET", "/me", `${world.key.slice(0, -4)}AAAA`),
      req("GET", "/me", revoked.key),
      new Request(`${BASE}/me`, { headers: { authorization: `Basic ${world.key}` } }),
    ];
    const messages = new Set<string>();
    for (const attempt of attempts) {
      const res = await meRoute.GET(attempt, none);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
      expect(res.headers.get("cache-control")).toBe("no-store");
      messages.add((await expectError(res, 401, "unauthenticated")).message);
    }
    expect(messages.size).toBe(1);
  });

  it("GET /me names the company, the key and the default agreement, and sends no CORS headers", async () => {
    const world = await makeWorld();
    const res = await meRoute.GET(req("GET", "/me", world.key, undefined, { origin: "https://elsewhere.example" }), none);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const json = await res.json();
    expect(json.company).toEqual({ id: world.org.id, name: world.org.name, legal_name: world.org.legalName });
    expect(json.api_key).toEqual({ id: world.keyId });
    expect(json.default_agreement).toMatchObject({ id: world.template.id, is_default: true, ready: true });
    expectSameShape(json, EXAMPLE_RESPONSES.me);
    expect(JSON.stringify(json)).not.toMatch(SECRETS);
  });

  it("limits each key separately and says how long to wait", async () => {
    const world = await makeWorld();
    const other = await makeWorld();
    const db = await getDb();
    // Stand in for a burst: put this key's counter at its ceiling.
    const { rateLimits } = await import("@/lib/db/schema");
    await db.insert(rateLimits).values({ key: `api:${world.keyId}`, count: API_RATE_LIMIT.requests, resetAt: new Date(Date.now() + 30_000) });
    const res = await meRoute.GET(req("GET", "/me", world.key), none);
    const error = await expectError(res, 429, "rate_limited");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(30);
    expect(error.message).toMatch(/Wait \d+ seconds/);
    expect((await meRoute.GET(req("GET", "/me", other.key), none)).status).toBe(200);
  });

  it("answers unknown paths under /api/v1 with a JSON 404", async () => {
    const res = catchAll.GET();
    await expectError(res, 404, "not_found");
  });
});

describe("POST /files", () => {
  it("creates the file, sends the agreement and returns the signing link", async () => {
    const world = await makeWorld();
    const { res, json } = await createFile(world, { client_company: "Example Holdings", description: "Lease review", external_id: "case-1", data: { matter: "Lease", fee: 2400, urgent: true } });
    expect(res.status, JSON.stringify(json)).toBe(201);
    expect(json.created).toBe(true);
    expect(json.file).toMatchObject({ external_id: "case-1", client_company: "Example Holdings", source: "api", agreement_status: "out_for_signature", cleared_to_start: false, archived_at: null });
    expect(json.file.reference).toMatch(/\d/);
    expect(json.agreement.sent).toBe(true);
    expect(json.agreement.envelope_id).toMatch(/^env_/);
    expect(json.agreement.signing_url).toMatch(/\/sign\/.{20,}/);
    expect(json.agreement).toMatchObject({ delivery: "emailed", delivery_note: null, reason: null });
    expectSameShape(json, EXAMPLE_RESPONSES.createFile);
    expect(JSON.stringify(json).replace(json.agreement.signing_url, "")).not.toMatch(SECRETS);

    const db = await getDb();
    const [row] = await db.select().from(files).where(eq(files.id, json.file.id));
    expect(row.orgId).toBe(world.org.id);
  });

  it("says so, and still returns the link, when the email was held back", async () => {
    const world = await makeWorld();
    const db = await getDb();
    // An owner who has not confirmed their address: nothing is emailed to clients yet.
    await db.update(users).set({ emailVerifiedAt: null }).where(eq(users.id, world.owner.id));
    const { res, json } = await createFile(world);
    expect(res.status).toBe(201);
    expect(json.agreement).toMatchObject({ sent: true, delivery: "email_unverified" });
    expect(json.agreement.delivery_note.length).toBeGreaterThan(20);
    expect(json.agreement.signing_url).toMatch(/\/sign\//);
    expectSameShape(json, EXAMPLE_RESPONSES.createFileNotEmailed);
  });

  it("returns the same file for a repeated external_id, with the link, and sends nothing new", async () => {
    const world = await makeWorld();
    const first = await createFile(world, { external_id: "case-77" });
    const again = await createFile(world, { external_id: "case-77" });
    expect(again.res.status).toBe(200);
    expect(again.json.created).toBe(false);
    expect(again.json.file.id).toBe(first.json.file.id);
    expect(again.json.agreement).toMatchObject({ sent: false, envelope_id: first.json.agreement.envelope_id, signing_url: first.json.agreement.signing_url });
    expect(again.json.agreement.reason.length).toBeGreaterThan(10);
    const db = await getDb();
    expect(await db.select().from(envelopes).where(eq(envelopes.fileId, first.json.file.id))).toHaveLength(1);
  });

  it("does not send when send is false, or when the company has no agreement", async () => {
    const world = await makeWorld();
    const held = await createFile(world, { send: false });
    expect(held.res.status).toBe(201);
    expect(held.json.file.agreement_status).toBe("no_agreement");
    expect(held.json.agreement).toMatchObject({ sent: false, envelope_id: null, signing_url: null });
    expect(held.json.agreement.reason).toMatch(/not sent/);

    const empty = await makeWorld({ noTemplate: true });
    const made = await createFile(empty);
    expect(made.res.status).toBe(201);
    expect(made.json.agreement.sent).toBe(false);
    expect(made.json.agreement.reason.length).toBeGreaterThan(15);
  });

  it("refuses unknown fields with a suggestion, wrong types, and missing required fields", async () => {
    const world = await makeWorld();
    const typo = await filesRoute.POST(req("POST", "/files", world.key, { clientName: "Casey", client_email: "c@client.test", colour: "red" }), none);
    const error = await expectError(typo, 422, "invalid");
    expect(error.fields?.clientName).toMatch(/Did you mean "client_name"\?/);
    expect(error.fields?.colour).toMatch(/Unknown field/);
    expect(error.fields?.client_name).toMatch(/required/);

    const wrong = await filesRoute.POST(req("POST", "/files", world.key, { client_name: 7, client_email: "c@client.test", send: "yes" }), none);
    const fields = (await expectError(wrong, 422, "invalid")).fields ?? {};
    expect(Object.keys(fields).sort()).toEqual(["client_name", "send"]);

    // Checked by the service, reported under the API's own field name.
    const email = await filesRoute.POST(req("POST", "/files", world.key, { client_name: "Casey", client_email: "not-an-email" }), none);
    expect((await expectError(email, 422, "invalid")).fields).toHaveProperty("client_email");

    const db = await getDb();
    expect(await db.select().from(files).where(eq(files.orgId, world.org.id))).toHaveLength(0);
  });

  it("refuses bodies that are not JSON objects, not declared as JSON, or too large", async () => {
    const world = await makeWorld();
    await expectError(await filesRoute.POST(req("POST", "/files", world.key, "{not json"), none), 422, "invalid");
    await expectError(await filesRoute.POST(req("POST", "/files", world.key, "[1,2]"), none), 422, "invalid");
    await expectError(await filesRoute.POST(req("POST", "/files", world.key, "client_name=Casey", { "content-type": "application/x-www-form-urlencoded" }), none), 415, "unsupported_media_type");
    const big = { client_name: "Casey", client_email: "c@client.test", description: "x".repeat(MAX_BODY_BYTES) };
    await expectError(await filesRoute.POST(req("POST", "/files", world.key, big), none), 413, "payload_too_large");
  });

  it("answers 409 for a reference that is already taken", async () => {
    const world = await makeWorld();
    expect((await createFile(world, { reference: "M-100", send: false })).res.status).toBe(201);
    const clash = await filesRoute.POST(req("POST", "/files", world.key, { client_name: "Casey", client_email: "c@client.test", reference: "m-100" }), none);
    await expectError(clash, 409, "conflict");
  });
});

describe("Idempotency-Key", () => {
  it("never creates a second file: with external_id the first is returned, without it the repeat is refused", async () => {
    const world = await makeWorld();
    const db = await getDb();
    const body = { client_name: "Casey Example", client_email: "idem@client.test", external_id: "case-idem" };
    const first = await filesRoute.POST(req("POST", "/files", world.key, body, { "idempotency-key": "k-1" }), none);
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    const repeat = await filesRoute.POST(req("POST", "/files", world.key, body, { "idempotency-key": "k-1" }), none);
    expect(repeat.status).toBe(200);
    expect(repeat.headers.get("idempotent-replayed")).toBe("true");
    expect((await repeat.json()).file.id).toBe((await first.json()).file.id);

    const plain = { client_name: "Casey Example", client_email: "idem2@client.test" };
    expect((await filesRoute.POST(req("POST", "/files", world.key, plain, { "idempotency-key": "k-2" }), none)).status).toBe(201);
    await expectError(await filesRoute.POST(req("POST", "/files", world.key, plain, { "idempotency-key": "k-2" }), none), 409, "idempotency_key_reused");
    expect(await db.select().from(files).where(eq(files.orgId, world.org.id))).toHaveLength(2);
  });

  it("refuses a key reused with a different body, frees a key whose request was refused, and keeps keys per company", async () => {
    const world = await makeWorld();
    const body = { client_name: "Casey Example", client_email: "idem3@client.test", send: false };
    expect((await filesRoute.POST(req("POST", "/files", world.key, body, { "idempotency-key": "k-3" }), none)).status).toBe(201);
    const changed = await filesRoute.POST(req("POST", "/files", world.key, { ...body, client_name: "Someone Else" }, { "idempotency-key": "k-3" }), none);
    expect((await expectError(changed, 409, "idempotency_key_reused")).message).toMatch(/different request body/);

    // A 422 changed nothing, so the same key works once the body is fixed.
    await expectError(await filesRoute.POST(req("POST", "/files", world.key, { client_name: "Casey" }, { "idempotency-key": "k-4" }), none), 422, "invalid");
    expect((await filesRoute.POST(req("POST", "/files", world.key, { client_name: "Casey" }, { "idempotency-key": "k-4" }), none)).status).toBe(422);

    const other = await makeWorld();
    expect((await filesRoute.POST(req("POST", "/files", other.key, body, { "idempotency-key": "k-3" }), none)).status).toBe(201);

    await expectError(await filesRoute.POST(req("POST", "/files", world.key, body, { "idempotency-key": "has spaces" }), none), 422, "invalid");
  });

  it("a repeated send or reminder acts once", async () => {
    const world = await makeWorld();
    const { json } = await createFile(world, { send: false });
    const id = json.file.id as string;
    const send = () => sendRoute.POST(req("POST", `/files/${id}/send`, world.key, {}, { "idempotency-key": "send-1" }), ctx({ id }));
    const first = await (await send()).json();
    const second = await send();
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    const replay = await second.json();
    expect(replay.agreement).toMatchObject({ sent: false, envelope_id: first.agreement.envelope_id, signing_url: first.agreement.signing_url });
    const db = await getDb();
    expect(await db.select().from(envelopes).where(eq(envelopes.fileId, id))).toHaveLength(1);

    const envelopeId = first.agreement.envelope_id as string;
    const remind = () => remindRoute.POST(req("POST", `/envelopes/${envelopeId}/remind`, world.key, undefined, { "idempotency-key": "remind-1" }), ctx({ id: envelopeId }));
    const reminded = await (await remind()).json();
    expect(reminded).toMatchObject({ reminded: true, to: json.file.client_email });
    expectSameShape(reminded, EXAMPLE_RESPONSES.remind);
    expect(await (await remind()).json()).toMatchObject({ reminded: false, to: null });
  });
});

describe("reading and changing files", () => {
  it("lists with filters and pages, and a page past the end is empty", async () => {
    const world = await makeWorld();
    const a = await createFile(world, { client_name: "Alex Rivers", send: false });
    await createFile(world, { client_name: "Blair Stone" });
    await createFile(world, { client_name: "Corey Lake" });

    const all = await (await filesRoute.GET(req("GET", "/files", world.key), none)).json();
    expect(all).toMatchObject({ page: 1, per_page: 25, total: 3, page_count: 1, next_page: null });
    expect(all.files.map((f: any) => f.client_name)).toEqual(["Corey Lake", "Blair Stone", "Alex Rivers"]);
    expectSameShape(all, EXAMPLE_RESPONSES.listFiles);

    const waiting = await (await filesRoute.GET(req("GET", "/files?status=out_for_signature,signed", world.key), none)).json();
    expect(waiting.total).toBe(2);
    const found = await (await filesRoute.GET(req("GET", "/files?q=rivers", world.key), none)).json();
    expect(found.files.map((f: any) => f.id)).toEqual([a.json.file.id]);

    const p1 = await (await filesRoute.GET(req("GET", "/files?per_page=2", world.key), none)).json();
    expect(p1).toMatchObject({ page: 1, per_page: 2, total: 3, page_count: 2, next_page: 2 });
    const p2 = await (await filesRoute.GET(req("GET", "/files?per_page=2&page=2", world.key), none)).json();
    expect(p2.files).toHaveLength(1);
    expect(p2.next_page).toBeNull();
    const p3 = await (await filesRoute.GET(req("GET", "/files?per_page=2&page=3", world.key), none)).json();
    expect(p3).toMatchObject({ files: [], page: 3, total: 3 });

    const bad = await filesRoute.GET(req("GET", "/files?status=pending&per_page=500&sort=name", world.key), none);
    expect(Object.keys((await expectError(bad, 422, "invalid")).fields ?? {}).sort()).toEqual(["per_page", "sort", "status"]);
  });

  it("gets a file with its envelopes; the client's link is there and a company signer's never is", async () => {
    const world = await makeWorld();
    const db = await getDb();
    await db
      .update(templates)
      .set({ fields: [...world.template.fields, field("k_sig", "signature", "company", true)] })
      .where(eq(templates.id, world.template.id));
    const { json } = await createFile(world);
    const id = json.file.id as string;
    const detail = await (await fileRoute.GET(req("GET", `/files/${id}`, world.key), ctx({ id }))).json();
    expect(detail.file.id).toBe(id);
    expect(detail.envelopes).toHaveLength(1);
    const [envelope] = detail.envelopes;
    expect(envelope).toMatchObject({ id: json.agreement.envelope_id, file_id: id, agreement_id: world.template.id, status: expect.stringMatching(/draft|sent/) });
    expect(envelope.signers.map((s: any) => s.role)).toEqual(["client", "company"]);
    expect(envelope.signers[0].signing_url).toBe(json.agreement.signing_url);
    expect(envelope.signers[1].signing_url).toBeNull();
    expectSameShape(detail, EXAMPLE_RESPONSES.getFile);
    expect(JSON.stringify(detail).replaceAll(json.agreement.signing_url, "")).not.toMatch(SECRETS);

    const one = await (await envelopeRoute.GET(req("GET", `/envelopes/${envelope.id}`, world.key), ctx({ id: envelope.id }))).json();
    expect(one.envelope).toEqual(envelope);
    expectSameShape(one, EXAMPLE_RESPONSES.getEnvelope);
  });

  it("PATCH changes only what was sent and says when the agreement should be sent again", async () => {
    const world = await makeWorld();
    const { json } = await createFile(world, { client_company: "Example Holdings", description: "Lease review" });
    const id = json.file.id as string;
    const res = await fileRoute.PATCH(req("PATCH", `/files/${id}`, world.key, { client_email: "corrected@client.test", description: null }), ctx({ id }));
    const patched = await res.json();
    expect(res.status, JSON.stringify(patched)).toBe(200);
    expect(patched.file).toMatchObject({ client_email: "corrected@client.test", description: null, client_company: "Example Holdings" });
    expect(patched.changed.sort()).toEqual(["client_email", "description"]);
    expect(patched.reissue_suggested).toBe(true);
    expect(patched.outstanding_envelope_id).toBe(json.agreement.envelope_id);
    expectSameShape(patched, EXAMPLE_RESPONSES.updateFile);

    const fields = (await expectError(await fileRoute.PATCH(req("PATCH", `/files/${id}`, world.key, { external_id: "x", agreement_status: "signed" }), ctx({ id })), 422, "invalid")).fields ?? {};
    expect(Object.keys(fields).sort()).toEqual(["agreement_status", "external_id"]);
  });

  it("send refuses a second agreement (409), replaces on request, and takes a chosen agreement", async () => {
    const world = await makeWorld();
    const second = await addTemplate(world.org, world.owner, { name: "Fee agreement", isDefault: false });
    const { json } = await createFile(world, { send: false });
    const id = json.file.id as string;

    const chosen = await (await sendRoute.POST(req("POST", `/files/${id}/send`, world.key, { agreement_id: second.id }), ctx({ id }))).json();
    expect(chosen.agreement.sent).toBe(true);
    expect(chosen.file.agreement_status).toBe("out_for_signature");
    expectSameShape(chosen, EXAMPLE_RESPONSES.send);
    const first = await (await envelopeRoute.GET(req("GET", `/envelopes/${chosen.agreement.envelope_id}`, world.key), ctx({ id: chosen.agreement.envelope_id }))).json();
    expect(first.envelope.agreement_name).toBe("Fee agreement");

    await expectError(await sendRoute.POST(req("POST", `/files/${id}/send`, world.key, {}), ctx({ id })), 409, "conflict");
    await expectError(await sendRoute.POST(req("POST", `/files/${id}/send`, world.key, { agreement_id: "tpl_doesnotexist" }), ctx({ id })), 404, "not_found");

    const replaced = await (await sendRoute.POST(req("POST", `/files/${id}/send`, world.key, { replace: true }), ctx({ id }))).json();
    expect(replaced.agreement.sent).toBe(true);
    expect(replaced.agreement.envelope_id).not.toBe(chosen.agreement.envelope_id);
    const old = await (await envelopeRoute.GET(req("GET", `/envelopes/${chosen.agreement.envelope_id}`, world.key), ctx({ id: chosen.agreement.envelope_id }))).json();
    expect(old.envelope.status).toBe("voided");
    expect(old.envelope.signers[0].signing_url).toBeNull();
  });

  it("void and archive work once and are harmless to repeat", async () => {
    const world = await makeWorld();
    const { json } = await createFile(world);
    const envelopeId = json.agreement.envelope_id as string;
    const voidIt = () => voidRoute.POST(req("POST", `/envelopes/${envelopeId}/void`, world.key, { reason: "Client asked for new terms" }), ctx({ id: envelopeId }));
    const voided = await (await voidIt()).json();
    expect(voided).toMatchObject({ already_voided: false, envelope: { status: "voided", void_reason: "Client asked for new terms" } });
    expectSameShape(voided, EXAMPLE_RESPONSES.voidEnvelope);
    expect((await (await voidIt()).json()).already_voided).toBe(true);
    await expectError(await remindRoute.POST(req("POST", `/envelopes/${envelopeId}/remind`, world.key), ctx({ id: envelopeId })), 409, "conflict");

    const id = json.file.id as string;
    const again = await (await sendRoute.POST(req("POST", `/files/${id}/send`, world.key), ctx({ id }))).json();
    expect(again.agreement.sent).toBe(true);
    const archive = () => archiveRoute.POST(req("POST", `/files/${id}/archive`, world.key), ctx({ id }));
    const archived = await (await archive()).json();
    expect(archived.voided_envelopes).toBe(1);
    expect(archived.file.archived_at).toMatch(/^\d{4}-/);
    expectSameShape(archived, EXAMPLE_RESPONSES.archive);
    expect((await (await archive()).json()).voided_envelopes).toBe(0);
    await expectError(await archiveRoute.POST(req("POST", `/files/${id}/archive`, world.key, { force: true }), ctx({ id })), 422, "invalid");

    const hidden = await (await filesRoute.GET(req("GET", "/files", world.key), none)).json();
    expect(hidden.total).toBe(0);
    const shown = await (await filesRoute.GET(req("GET", "/files?archived=true", world.key), none)).json();
    expect(shown.total).toBe(1);
  });

  it("lists agreements without archived ones unless asked", async () => {
    const world = await makeWorld();
    await addTemplate(world.org, world.owner, { name: "Old terms", isDefault: false, status: "archived" });
    const list = await (await agreementsRoute.GET(req("GET", "/agreements", world.key), none)).json();
    expect(list.agreements.map((a: any) => a.name)).toEqual(["Client Services Agreement"]);
    expect(list.agreements[0]).toMatchObject({ id: world.template.id, is_default: true, ready: true, page_count: 1, problems: [] });
    expectSameShape(list, EXAMPLE_RESPONSES.agreements);
    expect(JSON.stringify(list)).not.toMatch(SECRETS);
    const withOld = await (await agreementsRoute.GET(req("GET", "/agreements?include_archived=true", world.key), none)).json();
    expect(withOld.agreements).toHaveLength(2);
  });
});

describe("another company's ids", () => {
  it("are 404 everywhere, exactly like ids that do not exist, and nothing changes", async () => {
    const mine = await makeWorld();
    const theirs = await makeWorld();
    const { json } = await createFile(theirs);
    const fileId = json.file.id as string;
    const envelopeId = json.agreement.envelope_id as string;
    const k = mine.key;

    const calls: [string, () => Promise<Response>][] = [
      ["get file", () => fileRoute.GET(req("GET", `/files/${fileId}`, k), ctx({ id: fileId }))],
      ["patch file", () => fileRoute.PATCH(req("PATCH", `/files/${fileId}`, k, { client_name: "Mallory" }), ctx({ id: fileId }))],
      ["send", () => sendRoute.POST(req("POST", `/files/${fileId}/send`, k, { replace: true }), ctx({ id: fileId }))],
      ["archive", () => archiveRoute.POST(req("POST", `/files/${fileId}/archive`, k), ctx({ id: fileId }))],
      ["get envelope", () => envelopeRoute.GET(req("GET", `/envelopes/${envelopeId}`, k), ctx({ id: envelopeId }))],
      ["void", () => voidRoute.POST(req("POST", `/envelopes/${envelopeId}/void`, k, {}), ctx({ id: envelopeId }))],
      ["remind", () => remindRoute.POST(req("POST", `/envelopes/${envelopeId}/remind`, k), ctx({ id: envelopeId }))],
      ["document", () => documentRoute.GET(req("GET", `/envelopes/${envelopeId}/document?kind=original`, k), ctx({ id: envelopeId }))],
    ];
    for (const [name, call] of calls) {
      const res = await call();
      expect(res.status, name).toBe(404);
      expect(((await res.json()) as ErrorBody).error.code, name).toBe("not_found");
    }
    const missing = await fileRoute.GET(req("GET", "/files/file_doesnotexist0000", k), ctx({ id: "file_doesnotexist0000" }));
    const foreign = await fileRoute.GET(req("GET", `/files/${fileId}`, k), ctx({ id: fileId }));
    expect(await foreign.json()).toEqual(await missing.json());

    // Sending another company's agreement on my own file is refused the same way.
    const own = await createFile(mine, { send: false });
    const cross = await sendRoute.POST(req("POST", `/files/${own.json.file.id}/send`, k, { agreement_id: theirs.template.id }), ctx({ id: own.json.file.id }));
    expect(cross.status).toBe(404);

    const list = await (await filesRoute.GET(req("GET", "/files?archived=all", k), none)).json();
    expect(list.files.map((f: any) => f.id)).toEqual([own.json.file.id]);

    const db = await getDb();
    const [untouched] = await db.select().from(files).where(eq(files.id, fileId));
    expect(untouched).toMatchObject({ clientName: json.file.client_name, archivedAt: null, agreementStatus: "out_for_signature" });
    const [still] = await db.select().from(envelopes).where(eq(envelopes.id, envelopeId));
    expect(still.status).not.toBe("voided");
  });
});

describe("the whole path: create, sign, download", () => {
  it("clears the file to start and serves both PDFs", async () => {
    const world = await makeWorld();
    const { json } = await createFile(world, { external_id: "case-full" });
    const fileId = json.file.id as string;
    const envelopeId = json.agreement.envelope_id as string;
    const doc = (kind?: string) => documentRoute.GET(req("GET", `/envelopes/${envelopeId}/document${kind ? `?kind=${kind}` : ""}`, world.key), ctx({ id: envelopeId }));

    const original = await doc("original");
    expect(original.status).toBe(200);
    expect(original.headers.get("content-type")).toBe("application/pdf");
    expect(original.headers.get("content-disposition")).toMatch(/^attachment; filename=".+\.pdf"$/);
    expect(original.headers.get("cache-control")).toBe("no-store");
    const originalBytes = Buffer.from(await original.arrayBuffer());
    expect(originalBytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(Number(original.headers.get("content-length"))).toBe(originalBytes.length);

    // Not signed yet: the default kind is the signed copy, which does not exist.
    await expectError(await doc(), 409, "not_ready");
    await expectError(await doc("in_progress"), 422, "invalid");

    const secret = (json.agreement.signing_url as string).split("/sign/")[1];
    await submitSigning(secret, { values: { c_sig: SIGNATURE }, consent: true }, { ip: "203.0.113.9", userAgent: "TestBrowser/1.0" });
    await finalizeEnvelope(envelopeId);

    const detail = await (await fileRoute.GET(req("GET", `/files/${fileId}`, world.key), ctx({ id: fileId }))).json();
    expect(detail.file).toMatchObject({ agreement_status: "signed", cleared_to_start: true });
    const [envelope] = detail.envelopes;
    expect(envelope.status).toBe("completed");
    expect(envelope.signed_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope.signers[0]).toMatchObject({ status: "signed", signing_url: null });
    expect(envelope.signers[0].signed_at).toMatch(/^\d{4}-/);
    expectSameShape(detail, EXAMPLE_RESPONSES.getFileSigned);
    // Signature images and the signer's network address stay out of the API.
    expect(JSON.stringify(detail)).not.toMatch(/data:image|203\.0\.113\.9|TestBrowser/);

    const signed = await doc("signed");
    expect(signed.status).toBe(200);
    const signedBytes = Buffer.from(await signed.arrayBuffer());
    expect(signedBytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(signed.headers.get("x-signgate-sha256")).toBe(envelope.signed_sha256);
    expect(signedBytes.equals(originalBytes)).toBe(false);
    expect((await doc()).status).toBe(200);

    await expectError(await voidRoute.POST(req("POST", `/envelopes/${envelopeId}/void`, world.key, {}), ctx({ id: envelopeId })), 409, "conflict");
    const again = await createFile(world, { external_id: "case-full" });
    expect(again.json).toMatchObject({ created: false, agreement: { sent: false, envelope_id: envelopeId, signing_url: null } });
  });
});

describe("/api/cron", () => {
  const call = (authorization?: string) => cronRoute.GET(new Request("https://app.test/api/cron", { headers: authorization ? { authorization } : {} }));
  const env = process.env as Record<string, string | undefined>;
  const restore = { secret: env.CRON_SECRET, node: env.NODE_ENV };
  beforeEach(() => {
    env.CRON_SECRET = restore.secret;
    env.NODE_ENV = restore.node;
    if (restore.secret === undefined) delete env.CRON_SECRET;
  });

  it("accepts only the cron secret when one is set", async () => {
    env.CRON_SECRET = "test-cron-secret-0123456789";
    for (const attempt of [undefined, "Bearer wrong", "Bearer test-cron-secret-012345678", "Basic test-cron-secret-0123456789", "test-cron-secret-0123456789"]) {
      const res = await call(attempt);
      expect(res.status, String(attempt)).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
      expect((await res.json()).error.code).toBe("unauthenticated");
    }
    const ok = await call("Bearer test-cron-secret-0123456789");
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.ok).toBe(true);
    expect(body.summary).toMatchObject({ expired: 0, errors: [], outOfTime: false });
    expect(body.summary.finishedAt).toMatch(/^\d{4}-/);
  });

  it("without a secret: refuses in production, runs locally", async () => {
    delete env.CRON_SECRET;
    env.NODE_ENV = "production";
    const refused = await call("Bearer anything");
    expect(refused.status).toBe(503);
    expect((await refused.json()).error.message).toMatch(/CRON_SECRET/);
    env.NODE_ENV = "test";
    expect((await call()).status).toBe(200);
  });

  it("a cron run makes the page-driven tick wait its ten minutes; otherwise the tick runs once", async () => {
    delete env.CRON_SECRET;
    await clearRateLimit("jobs:tick");
    resetTickForTests();
    const first = await tick();
    expect(first.ran).toBe(true);
    expect(await tick()).toEqual({ ran: false, reason: "checked_recently" });
    expect(await tick({ force: true })).toEqual({ ran: false, reason: "ran_recently" });

    await clearRateLimit("jobs:tick");
    expect((await call()).status).toBe(200);
    expect(await tick({ force: true })).toEqual({ ran: false, reason: "ran_recently" });
  });
});

describe("/api/health", () => {
  it("reports the database and which integrations are set up, as booleans only", async () => {
    const env = process.env as Record<string, string | undefined>;
    const before = env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_API_KEY = "test-value-that-must-not-appear";
    try {
      const res = await healthRoute.GET();
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("test-value-that-must-not-appear");
      const body = JSON.parse(text);
      expect(body).toEqual({ ok: true, database: true, integrations: { email: expect.any(Boolean), ai_field_detection: true, cron: expect.any(Boolean) } });
    } finally {
      if (before === undefined) delete env.ANTHROPIC_API_KEY;
      else env.ANTHROPIC_API_KEY = before;
    }
  });
});
