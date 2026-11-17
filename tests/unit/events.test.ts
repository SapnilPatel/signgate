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

  it("has a sentence for the countersigning, sealing and verification events", () => {
    const sys = (type: string, data: Record<string, unknown> = {}) => describeEvent(ev(type, "System", data, "system"));
    expect(sys("countersign.requested", { email: "sam@example.com", name: "Sam Lee" })).toBe("Countersignature requested from sam@example.com");
    expect(sys("countersign.requested", { email: "sam@example.com", reminder: 2 })).toBe("Countersignature requested from sam@example.com (reminder 2)");
    expect(sys("countersign.overdue", { reason: "Sam Lee has not countersigned after 5 reminders. An owner or admin can countersign from the file" })).toBe(
      "Countersignature overdue: Sam Lee has not countersigned after 5 reminders. An owner or admin can countersign from the file",
    );
    expect(sys("countersign.overdue")).toBe("Countersignature overdue");
    expect(sys("countersign.unassigned", { reason: "Choose a countersigner in Settings." })).toBe("Nobody is assigned to countersign: Choose a countersigner in Settings");
    expect(sys("envelope.finalize_failed", { reason: "The original agreement PDF is missing from storage." })).toBe(
      "The final signed copy could not be produced; it will be retried automatically: The original agreement PDF is missing from storage",
    );
    // Rows written before the key was renamed still read properly.
    expect(sys("envelope.finalize_failed", { error: "Storage timed out" })).toMatch(/retried automatically: Storage timed out$/);
    expect(sys("envelope.seal_warning", { code: "image_skipped", reason: "An image was left out." })).toBe(
      "The signed copy shows something differently from what was entered: An image was left out",
    );
    expect(describeEvent(ev("member.email_verified", "Olive Owner <olive@example.com>", {}, "user"))).toBe("Olive Owner <olive@example.com> confirmed their email address");
  });

  it("has a sentence for everything else the services record", () => {
    const by = (type: string, data: Record<string, unknown> = {}) => describeEvent(ev(type, "Sam Lee", data, "user"));
    expect(by("file.unarchived")).toBe("File restored from the archive by Sam Lee");
    expect(by("template.created", { templateName: "Client Agreement" })).toBe('Agreement "Client Agreement" uploaded by Sam Lee');
    expect(by("template.renamed", { templateName: "New", previousName: "Old" })).toBe('Agreement "Old" renamed to "New" by Sam Lee');
    expect(by("template.duplicated", { templateName: "Copy", fromName: "Original" })).toBe('Agreement "Original" copied as "Copy" by Sam Lee');
    expect(by("template.fields_updated", { templateName: "Client Agreement" })).toBe('Agreement "Client Agreement" fields changed by Sam Lee');
    expect(by("template.fields_redetected", { templateName: "Client Agreement" })).toBe('Agreement "Client Agreement" fields detected again by Sam Lee');
    expect(by("template.document_replaced", { templateName: "Client Agreement" })).toBe('Agreement "Client Agreement" document replaced by Sam Lee');
    expect(by("template.activated", { templateName: "Client Agreement", becameDefault: true })).toBe('Agreement "Client Agreement" activated by Sam Lee and made the default');
    expect(by("template.archived", { templateName: "Client Agreement" })).toBe('Agreement "Client Agreement" archived by Sam Lee');
    expect(by("template.default_changed", { templateName: "Client Agreement" })).toBe('Agreement "Client Agreement" made the default agreement by Sam Lee');
    expect(by("template.intake_enabled", { templateName: "Client Agreement" })).toBe('Client intake link turned on for "Client Agreement" by Sam Lee');
    expect(by("template.intake_disabled")).toBe("Client intake link turned off for an agreement by Sam Lee");
    expect(by("org.created")).toBe("Company account created by Sam Lee");
    expect(by("org.updated", { changed: ["name", "timeZone", "countersignerUserId"] })).toBe("Company settings changed by Sam Lee (company name, time zone, countersigner)");
    expect(by("member.invited", { email: "jo@example.com", role: "admin" })).toBe("jo@example.com invited to the team as admin by Sam Lee");
    expect(by("member.invite_revoked", { email: "jo@example.com" })).toBe("Invitation for jo@example.com cancelled by Sam Lee");
    expect(by("member.joined")).toBe("Sam Lee joined the team");
    expect(by("member.role_changed", { email: "jo@example.com", from: "member", to: "admin" })).toBe("jo@example.com made an admin by Sam Lee");
    expect(by("member.role_changed", { email: "jo@example.com", to: "member" })).toBe("jo@example.com made a member by Sam Lee");
    expect(by("member.disabled", { email: "jo@example.com" })).toBe("jo@example.com's account turned off by Sam Lee");
    expect(by("member.enabled", { email: "jo@example.com" })).toBe("jo@example.com's account turned back on by Sam Lee");
    expect(by("member.ownership_transferred", { toEmail: "jo@example.com" })).toBe("Ownership transferred to jo@example.com by Sam Lee");
    expect(by("member.password_reset")).toBe("Sam Lee set a new password from a reset link");
    expect(by("member.password_changed")).toBe("Sam Lee changed their password");
  });

  it("leaves no event type the services record to the generic fallback", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "src/lib/services");
    const types = new Set<string>();
    // events.ts itself is the reference being checked, not a place events are recorded.
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "events.ts")) {
      const source = readFileSync(join(dir, name), "utf8");
      // Audit event names are "noun.verb" string literals; webhook event names (agreement.*) are a different vocabulary.
      for (const m of source.matchAll(/"((?:file|envelope|signer|reminder|link|countersign|template|org|member|api_key|webhook|document)\.[a-z_]+)"/g)) types.add(m[1]);
    }
    expect(types.size).toBeGreaterThan(40);
    // file.created is also a webhook event name; it has a sentence either way.
    const written = new Set([...readFileSync(join(dir, "events.ts"), "utf8").matchAll(/case "([a-z_]+\.[a-z_]+)":/g)].map((m) => m[1]));
    // webhook.test is the name of the test delivery sent to an endpoint, never an audit event.
    expect([...types].filter((type) => !written.has(type) && type !== "webhook.test")).toEqual([]);
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
