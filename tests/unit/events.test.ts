import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { orgs, events } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { systemActor, type Actor } from "@/lib/services/context";
import { recordEvent, listEvents, describeEvent, toSafeJson, cleanText } from "@/lib/services/events";

async function makeOrg(): Promise<string> {
  const db = await getDb();
  const id = newId("org");
  await db.insert(orgs).values({ id, name: "Test Co", slug: id });
  return id;
}

const user = (orgId: string): Actor => ({ type: "user", orgId, userId: "usr_x", role: "owner", label: "Sam Lee" });

describe("recordEvent", () => {
  it("stores actor, metadata and data", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    await recordEvent(db, {
      orgId,
      type: "file.created",
      actor: user(orgId),
      meta: { ip: "203.0.113.9", userAgent: "TestBrowser/1.0" },
      data: { reference: "F-2026-0001" },
    });
    const [row] = await listEvents(orgId);
    expect(row).toMatchObject({
      type: "file.created",
      actorType: "user",
      actor: "Sam Lee",
      ip: "203.0.113.9",
      userAgent: "TestBrowser/1.0",
      data: { reference: "F-2026-0001" },
      fileId: null,
      envelopeId: null,
    });
  });

  it("records signer and system actors", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    await recordEvent(db, { orgId, type: "signer.signed", actor: { type: "signer", label: "Jane Doe" } });
    await recordEvent(db, { orgId, type: "envelope.expired", actor: systemActor(orgId) });
    const rows = await listEvents(orgId);
    expect(rows.map((r) => [r.actorType, r.actor])).toEqual([
      ["signer", "Jane Doe"],
      ["system", "System"],
    ]);
  });

  it("truncates oversized IPs and user agents and survives NUL bytes", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    await recordEvent(db, {
      orgId,
      type: "envelope.viewed",
      actor: { type: "signer", label: "Jane\u0000 Doe" },
      meta: { ip: "1".repeat(5000), userAgent: `Mozilla\u0000/${"x".repeat(100_000)}` },
      data: { note: "a\u0000b", lone: "bad\uD800surrogate" },
    });
    const [row] = await listEvents(orgId);
    expect(row.ip!.length).toBeLessThanOrEqual(64);
    expect(row.userAgent!.length).toBeLessThanOrEqual(400);
    expect(row.userAgent).not.toContain("\u0000");
    expect(row.actor).toBe("Jane Doe");
    expect(row.data.note).toBe("ab");
    expect(row.data.lone).toBe("bad�surrogate");
  });

  it("never stores tokens or other credentials, at any depth", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    await recordEvent(db, {
      orgId,
      type: "link.reissued",
      actor: user(orgId),
      data: {
        token: "super-secret-link",
        signingToken: "abc",
        tokenNonce: "n",
        password: "p",
        apiKey: "sg_live_x",
        Authorization: "Bearer x",
        nested: { access_token: "t", keep: "yes", list: [{ secret: "s", ok: 1 }] },
        email: "jane@example.com",
      },
    });
    const [row] = await listEvents(orgId);
    expect(row.data).toEqual({ nested: { keep: "yes", list: [{ ok: 1 }] }, email: "jane@example.com" });
    expect(JSON.stringify(row.data)).not.toMatch(/super-secret|sg_live_x|Bearer/);
  });

  it("accepts data that is not valid JSON without throwing", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const hostile = {
      circular,
      big: BigInt(12),
      fn: () => 1,
      nan: Number.NaN,
      when: new Date("2026-01-02T03:04:05Z"),
      badDate: new Date("nope"),
      bytes: new Uint8Array([1, 2]),
      undef: undefined,
      get boom(): string {
        throw new Error("getter");
      },
      deep: { a: { b: { c: { d: { e: { f: "too deep" } } } } } },
      long: "x".repeat(50_000),
    };
    await recordEvent(db, { orgId, type: "file.updated", actor: user(orgId), data: hostile });
    const [row] = await listEvents(orgId);
    expect(row.data.big).toBe("12");
    expect(row.data.nan).toBeNull();
    expect(row.data.when).toBe("2026-01-02T03:04:05.000Z");
    expect(row.data.badDate).toBeNull();
    expect(row.data.circular).toEqual({ name: "loop", self: null });
    expect(row.data).not.toHaveProperty("fn");
    expect(row.data).not.toHaveProperty("boom");
    expect((row.data.long as string).length).toBe(2000);
  });

  it("falls back to safe values for an empty type or label", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    await recordEvent(db, { orgId, type: "   ", actor: { type: "signer", label: "" } });
    const [row] = await listEvents(orgId);
    expect(row.type).toBe("unknown");
    expect(row.actor).toBe("Unknown");
  });

  it("rolls back with the caller's transaction", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    await expect(
      db.transaction(async (tx) => {
        await recordEvent(tx, { orgId, type: "file.created", actor: user(orgId) });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await listEvents(orgId)).toHaveLength(0);
  });

  it("keeps events of one transaction in the order they were recorded", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    const types = Array.from({ length: 30 }, (_, i) => `step.${i}`);
    await db.transaction(async (tx) => {
      for (const type of types) await recordEvent(tx, { orgId, type, actor: systemActor(orgId) });
    });
    expect((await listEvents(orgId)).map((e) => e.type)).toEqual(types);
    expect((await listEvents(orgId, { newestFirst: true, limit: 2 })).map((e) => e.type)).toEqual(["step.29", "step.28"]);
  });
});

describe("listEvents", () => {
  it("never returns another org's events", async () => {
    const db = await getDb();
    const a = await makeOrg();
    const b = await makeOrg();
    await recordEvent(db, { orgId: a, type: "file.created", actor: user(a) });
    await recordEvent(db, { orgId: b, type: "file.archived", actor: user(b) });
    expect((await listEvents(a)).map((e) => e.type)).toEqual(["file.created"]);
    expect((await listEvents(b)).map((e) => e.type)).toEqual(["file.archived"]);
    expect(await listEvents("org_missing")).toEqual([]);
  });

  it("tolerates nonsense limits", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    for (let i = 0; i < 3; i++) await recordEvent(db, { orgId, type: "file.updated", actor: user(orgId) });
    expect(await listEvents(orgId, { limit: -5 })).toHaveLength(3);
    expect(await listEvents(orgId, { limit: Number.NaN })).toHaveLength(3);
    expect(await listEvents(orgId, { limit: 2.9 })).toHaveLength(2);
    expect(await listEvents(orgId, { limit: 1e12 })).toHaveLength(3);
  });

  it("stores rows that can be filtered by file and envelope id columns", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    await recordEvent(db, { orgId, type: "file.created", actor: user(orgId) });
    // No file or envelope exists with these ids, so nothing matches; the filter must not widen the result.
    expect(await listEvents(orgId, { fileId: "file_none" })).toEqual([]);
    expect(await listEvents(orgId, { envelopeId: "env_none" })).toEqual([]);
    const rows = await db.select().from(events).where(eq(events.orgId, orgId));
    expect(rows).toHaveLength(1);
  });
});

describe("describeEvent", () => {
  const ev = (type: string, actor = "Jane Doe", data: Record<string, unknown> = {}, actorType: "user" | "signer" | "system" | "api" = "signer") => ({
    type,
    actor,
    actorType,
    data,
  });

  it("writes a plain sentence for every known type", () => {
    expect(describeEvent(ev("file.created", "Sam Lee", { reference: "F-2026-0001" }, "user"))).toBe("File F-2026-0001 created by Sam Lee");
    expect(describeEvent(ev("file.created", "System", { source: "intake" }, "system"))).toBe("File created from the client intake link");
    expect(describeEvent(ev("file.updated", "Sam Lee", { changed: ["client email"] }, "user"))).toBe("File details updated by Sam Lee (client email)");
    expect(describeEvent(ev("file.archived", "Sam Lee", {}, "user"))).toBe("File archived by Sam Lee");
    expect(describeEvent(ev("envelope.created", "System", { templateName: "Client Agreement" }, "system"))).toBe(
      'Agreement "Client Agreement" prepared for signature',
    );
    expect(describeEvent(ev("envelope.sent", "System", { email: "jane@example.com" }, "system"))).toBe("Agreement emailed to jane@example.com");
    expect(describeEvent(ev("envelope.sent", "Sam Lee", { channel: "link", email: "jane@example.com" }, "user"))).toBe(
      "Signing link created for jane@example.com (not emailed)",
    );
    expect(describeEvent(ev("envelope.delivery_failed", "System", { email: "jane@example.com", error: "Mailbox full." }, "system"))).toBe(
      "Email to jane@example.com could not be delivered: Mailbox full",
    );
    expect(describeEvent(ev("envelope.viewed"))).toBe("Jane Doe opened the agreement");
    expect(describeEvent(ev("signer.consented"))).toBe("Jane Doe consented to sign electronically");
    expect(describeEvent(ev("signer.signed"))).toBe("Jane Doe signed the agreement");
    expect(describeEvent(ev("envelope.countersigned", "Sam Lee", { company: "Test Co" }, "user"))).toBe("Sam Lee countersigned on behalf of Test Co");
    expect(describeEvent(ev("envelope.countersigned", "System", { auto: true, name: "Sam Lee" }, "system"))).toBe(
      "Countersigned automatically with Sam Lee's saved signature",
    );
    expect(describeEvent(ev("envelope.completed", "System", {}, "system"))).toMatch(/^Agreement completed/);
    expect(describeEvent(ev("envelope.declined", "Jane Doe", { reason: "Wrong price" }))).toBe("Jane Doe declined to sign: Wrong price");
    expect(describeEvent(ev("envelope.voided", "Sam Lee", { reason: "Sent in error" }, "user"))).toBe("Agreement voided by Sam Lee: Sent in error");
    expect(describeEvent(ev("envelope.expired", "System", {}, "system"))).toBe("Agreement expired before it was signed");
    expect(describeEvent(ev("reminder.sent", "System", { email: "jane@example.com", count: 2 }, "system"))).toBe(
      "Reminder emailed to jane@example.com (reminder 2)",
    );
    expect(describeEvent(ev("link.reissued", "Sam Lee", {}, "user"))).toBe("New signing link issued by Sam Lee; the previous link no longer works");
    expect(describeEvent(ev("signer.updated", "Sam Lee", { name: "Jo Roe", email: "jo@example.com" }, "user"))).toBe(
      "Signer changed to Jo Roe (jo@example.com) by Sam Lee",
    );
    expect(describeEvent(ev("document.downloaded", "Sam Lee", {}, "user"))).toBe("Signed agreement downloaded by Sam Lee");
  });

  it("gives unknown types a readable sentence", () => {
    expect(describeEvent(ev("envelope.something_new", "Sam Lee", {}, "user"))).toBe("Envelope something new by Sam Lee");
    expect(describeEvent(ev("", "System", {}, "system"))).toBe("Activity recorded");
    expect(describeEvent(ev("<script>", "System", {}, "system"))).toBe("Script");
  });

  it("does not throw on malformed events", () => {
    const odd = [
      { type: "envelope.sent", actor: "", data: null },
      { type: "envelope.sent", actor: "x", data: { email: { nested: true } } },
      { type: "file.updated", actor: "x", data: { changed: [1, null, {}] } },
      { type: 42, actor: null, data: "nope" },
      { type: "reminder.sent", actor: "System" },
    ];
    for (const e of odd) {
      const sentence = describeEvent(e as never);
      expect(typeof sentence).toBe("string");
      expect(sentence.length).toBeGreaterThan(0);
    }
  });
});

describe("helpers", () => {
  it("cleanText never splits a surrogate pair", () => {
    expect(cleanText("ab😀", 3)).toBe("ab");
    expect(cleanText(null, 10)).toBe("");
    expect(cleanText(12, 10)).toBe("12");
  });

  it("toSafeJson returns an object for any input", () => {
    for (const v of [null, undefined, 1, "s", [1, 2], () => 1, Symbol("x")]) expect(toSafeJson(v)).toEqual({});
    expect(toSafeJson(JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}'))).toEqual({ ok: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
