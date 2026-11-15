import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { orgs, blobs } from "@/lib/db/schema";
import { newId, sha256Hex, randomString } from "@/lib/ids";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

describe("foundation", () => {
  it("migrates an empty database and round-trips binary data", async () => {
    const db = await getDb();
    const orgId = newId("org");
    await db.insert(orgs).values({ id: orgId, name: "Test Co", slug: "test-co" });
    const bytes = Buffer.from([0, 1, 2, 250, 255, 0, 37]);
    const id = newId("blob");
    await db.insert(blobs).values({ id, orgId, bytes, sha256: sha256Hex(bytes), contentType: "application/pdf", size: bytes.length });
    const [row] = await db.select().from(blobs).where(eq(blobs.id, id));
    expect(Buffer.isBuffer(row.bytes)).toBe(true);
    expect([...row.bytes]).toEqual([...bytes]);
    const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
    expect(org.settings).toEqual({});
  });

  it("rolls back a failed transaction", async () => {
    const db = await getDb();
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(orgs).values({ id: "org_rollback", name: "X", slug: "rollback" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.select().from(orgs).where(eq(orgs.id, "org_rollback"))).toHaveLength(0);
  });

  it("hashes and verifies passwords", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });

  it("generates ids from the expected alphabet", () => {
    expect(randomString(64)).toMatch(/^[0-9a-z]{64}$/);
    expect(newId("env")).toMatch(/^env_[0-9a-z]{16}$/);
  });
});
