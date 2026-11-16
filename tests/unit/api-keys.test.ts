import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { orgs, users, apiKeys } from "@/lib/db/schema";
import { newId, sha256Hex } from "@/lib/ids";
import { ServiceError, systemActor, type Actor } from "@/lib/services/context";
import { listEvents } from "@/lib/services/events";
import { createApiKey, listApiKeys, revokeApiKey, authenticateApiKey, MAX_ACTIVE_API_KEYS } from "@/lib/services/api-keys";

async function makeOrg(name = "Test Co"): Promise<string> {
  const db = await getDb();
  const id = newId("org");
  await db.insert(orgs).values({ id, name, slug: id });
  // Permissions are read from the stored user row, so each org gets one real user per role.
  await db.insert(users).values(
    ROLES.map((role) => ({ id: userIdFor(id, role), orgId: id, email: `${role}-${id}@example.com`, name: "Sam Lee", passwordHash: "x", role })),
  );
  return id;
}

const ROLES = ["owner", "admin", "member"] as const;
const userIdFor = (orgId: string, role: (typeof ROLES)[number] = "owner") => `usr_${role}_${orgId.slice(4)}`;

const actorFor = (orgId: string, role: "owner" | "admin" | "member" = "owner"): Actor => ({
  type: "user",
  orgId,
  userId: userIdFor(orgId, role),
  role,
  label: "Sam Lee",
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createApiKey", () => {
  it("returns the plaintext once and stores only its hash and a display prefix", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    const { key, row } = await createApiKey(actorFor(orgId), "  Case   system ");
    expect(key).toMatch(/^sg_live_[0-9a-z]{32}$/);
    expect(row).toMatchObject({ orgId, name: "Case system", prefix: key.slice(0, 12), revokedAt: null, lastUsedAt: null });
    expect(row).not.toHaveProperty("keyHash");

    const [stored] = await db.select().from(apiKeys).where(eq(apiKeys.id, row.id));
    expect(stored.keyHash).toBe(sha256Hex(key));
    expect(JSON.stringify(stored)).not.toContain(key);
    // The audit trail records the creation but never the key.
    const trail = await listEvents(orgId);
    expect(trail.map((e) => e.type)).toEqual(["api_key.created"]);
    expect(JSON.stringify(trail)).not.toContain(key.slice(12));
  });

  it("is for owners and admins only", async () => {
    const orgId = await makeOrg();
    await expect(createApiKey(actorFor(orgId, "member"), "x")).rejects.toMatchObject({ code: "forbidden" });
    await expect(createApiKey(systemActor(orgId), "x")).rejects.toMatchObject({ code: "forbidden" });
    await expect(createApiKey({ type: "api", orgId, keyId: "key_x", label: "k" }, "x")).rejects.toMatchObject({ code: "forbidden" });
    await expect(createApiKey(undefined as never, "x")).rejects.toBeInstanceOf(ServiceError);
    expect((await createApiKey(actorFor(orgId, "admin"), "ok")).key).toMatch(/^sg_live_/);
    expect(await listApiKeys(actorFor(orgId))).toHaveLength(1);
  });

  it("validates the name", async () => {
    const orgId = await makeOrg();
    for (const bad of ["", "   ", "\u0000", null, undefined, 42, {}]) {
      await expect(createApiKey(actorFor(orgId), bad as never)).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(createApiKey(actorFor(orgId), "n".repeat(81))).rejects.toMatchObject({ code: "invalid" });
    expect((await createApiKey(actorFor(orgId), "n".repeat(80))).row.name).toHaveLength(80);
  });

  it("caps the number of active keys but lets revoked ones be replaced", async () => {
    const orgId = await makeOrg();
    const actor = actorFor(orgId);
    const created = [];
    for (let i = 0; i < MAX_ACTIVE_API_KEYS; i++) created.push(await createApiKey(actor, `key ${i}`));
    await expect(createApiKey(actor, "one too many")).rejects.toMatchObject({ code: "conflict" });
    await revokeApiKey(actor, created[0].row.id);
    expect((await createApiKey(actor, "replacement")).row.name).toBe("replacement");
  });
});

describe("authenticateApiKey", () => {
  it("accepts a Bearer key and returns an API actor bound to the key's org", async () => {
    const orgId = await makeOrg("Acme Test");
    const { key, row } = await createApiKey(actorFor(orgId), "CRM");
    const result = await authenticateApiKey(`Bearer ${key}`);
    expect(result).not.toBeNull();
    expect(result!.actor).toEqual({ type: "api", orgId, keyId: row.id, label: 'API key "CRM"' });
    expect(result!.org).toMatchObject({ id: orgId, name: "Acme Test" });
    expect(await authenticateApiKey(`bearer   ${key}  `)).not.toBeNull();
  });

  it("rejects everything that is not a live key", async () => {
    const orgId = await makeOrg();
    const { key } = await createApiKey(actorFor(orgId), "CRM");
    const wrong = `${key.slice(0, -1)}${key.endsWith("a") ? "b" : "a"}`;
    const bad: Array<string | null> = [
      null,
      "",
      "Bearer",
      "Bearer ",
      key, // no scheme
      `Basic ${key}`,
      `Bearer ${wrong}`,
      `Bearer ${key.toUpperCase()}`,
      `Bearer ${key} extra`,
      `Bearer ${sha256Hex(key)}`, // the stored hash is not a credential
      `Bearer sg_live_${"%".repeat(32)}`,
      `Bearer ${"a".repeat(1_000_000)}`,
      "Bearer sg_live_' OR '1'='1",
      `Bearer ${key}\u0000`,
    ];
    for (const header of bad) expect(await authenticateApiKey(header)).toBeNull();
    for (const notString of [undefined, 42, {}, [`Bearer ${key}`]]) expect(await authenticateApiKey(notString as never)).toBeNull();
  });

  it("stops accepting a key the moment it is revoked", async () => {
    const orgId = await makeOrg();
    const actor = actorFor(orgId);
    const { key, row } = await createApiKey(actor, "CRM");
    expect(await authenticateApiKey(`Bearer ${key}`)).not.toBeNull();
    const revoked = await revokeApiKey(actor, row.id);
    expect(revoked.revokedAt).toBeInstanceOf(Date);
    expect(await authenticateApiKey(`Bearer ${key}`)).toBeNull();
  });

  it("updates lastUsedAt at most once a minute", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    const { key, row } = await createApiKey(actorFor(orgId), "CRM");
    const lastUsed = async () => (await db.select().from(apiKeys).where(eq(apiKeys.id, row.id)))[0].lastUsedAt;

    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-03-01T10:00:00Z");
    vi.setSystemTime(t0);
    await authenticateApiKey(`Bearer ${key}`);
    expect(await lastUsed()).toEqual(t0);

    vi.setSystemTime(new Date(t0.getTime() + 59_000));
    await Promise.all([authenticateApiKey(`Bearer ${key}`), authenticateApiKey(`Bearer ${key}`)]);
    expect(await lastUsed()).toEqual(t0);

    const t1 = new Date(t0.getTime() + 60_000);
    vi.setSystemTime(t1);
    expect(await authenticateApiKey(`Bearer ${key}`)).not.toBeNull();
    expect(await lastUsed()).toEqual(t1);
  });
});

describe("tenant isolation", () => {
  it("lists and revokes only the caller's own keys", async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const keyA = await createApiKey(actorFor(a), "A key");
    const keyB = await createApiKey(actorFor(b), "B key");

    expect((await listApiKeys(actorFor(a))).map((k) => k.id)).toEqual([keyA.row.id]);
    expect((await listApiKeys(actorFor(b))).map((k) => k.id)).toEqual([keyB.row.id]);

    await expect(revokeApiKey(actorFor(b), keyA.row.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await authenticateApiKey(`Bearer ${keyA.key}`)).not.toBeNull();
    expect((await authenticateApiKey(`Bearer ${keyA.key}`))!.actor.orgId).toBe(a);
    expect((await authenticateApiKey(`Bearer ${keyB.key}`))!.actor.orgId).toBe(b);
  });
});

describe("revokeApiKey", () => {
  it("is idempotent, manager-only and reports unknown ids", async () => {
    const orgId = await makeOrg();
    const actor = actorFor(orgId);
    const { row } = await createApiKey(actor, "CRM");
    await expect(revokeApiKey(actorFor(orgId, "member"), row.id)).rejects.toMatchObject({ code: "forbidden" });
    const first = await revokeApiKey(actor, row.id);
    const second = await revokeApiKey(actor, row.id);
    expect(second.revokedAt).toEqual(first.revokedAt);
    expect((await listEvents(orgId)).filter((e) => e.type === "api_key.revoked")).toHaveLength(1);
    await expect(revokeApiKey(actor, "key_missing")).rejects.toMatchObject({ code: "not_found" });
    await expect(revokeApiKey(actor, undefined as never)).rejects.toMatchObject({ code: "not_found" });
    // Revoked keys stay listed so their history is visible.
    expect(await listApiKeys(actor)).toHaveLength(1);
  });
});

describe("permissions follow the stored user, not the session's copy", () => {
  it("refuses a demoted admin whose Actor still says admin", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    const stale = actorFor(orgId, "admin");
    const { row } = await createApiKey(stale, "Before demotion");
    await db.update(users).set({ role: "member" }).where(eq(users.id, userIdFor(orgId, "admin")));

    await expect(createApiKey(stale, "After demotion")).rejects.toMatchObject({ code: "forbidden" });
    await expect(revokeApiKey(stale, row.id)).rejects.toMatchObject({ code: "forbidden" });
    // Still a member of the team, so the list stays readable.
    expect(await listApiKeys(stale)).toHaveLength(1);
  });

  it("refuses a disabled person everything, including the list", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    const stale = actorFor(orgId, "owner");
    const { row } = await createApiKey(stale, "Before");
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userIdFor(orgId, "owner")));

    await expect(createApiKey(stale, "After")).rejects.toMatchObject({ code: "forbidden" });
    await expect(revokeApiKey(stale, row.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listApiKeys(stale)).rejects.toMatchObject({ code: "forbidden" });
    expect(await listApiKeys(actorFor(orgId, "admin"))).toHaveLength(1);
  });

  it("refuses an Actor that claims a user from another company, or no company at all", async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const forged: Actor = { type: "user", orgId: b, userId: userIdFor(a, "owner"), role: "owner", label: "Sam Lee" };
    await expect(createApiKey(forged, "x")).rejects.toMatchObject({ code: "forbidden" });
    await expect(listApiKeys(forged)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listApiKeys(undefined as never)).rejects.toBeInstanceOf(ServiceError);
    await expect(listApiKeys({ type: "user" } as never)).rejects.toBeInstanceOf(ServiceError);
  });
});
