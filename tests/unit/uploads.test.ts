import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { orgs, uploadChunks, users } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { LIMITS } from "@/lib/types";
import { ServiceError, type Actor } from "@/lib/services/context";
import {
  PENDING_UPLOAD_QUOTA_BYTES,
  UPLOAD_TTL_MS,
  beginUpload,
  completeUpload,
  discardUpload,
  purgeStaleUploads,
  putChunk,
} from "@/lib/services/uploads";

const CHUNK = LIMITS.uploadChunkBytes;

async function makeOrg(role: "owner" | "admin" | "member" = "owner"): Promise<{ orgId: string; actor: Actor & { type: "user" } }> {
  const db = await getDb();
  const orgId = newId("org");
  await db.insert(orgs).values({ id: orgId, name: "Test Co", slug: orgId });
  const userId = newId("usr");
  await db.insert(users).values({ id: userId, orgId, email: `${userId}@example.test`, name: "Test Person", passwordHash: "x", role });
  return { orgId, actor: { type: "user", orgId, userId, role, label: "Test Person" } };
}

/** Deterministic bytes that differ at every chunk boundary, so a misordered join is caught. */
function pattern(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + (i >>> 16) * 7) & 0xff;
  return out;
}

function parts(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let o = 0; o < bytes.length; o += CHUNK) out.push(bytes.subarray(o, Math.min(bytes.length, o + CHUNK)));
  return out;
}

async function chunkRows(orgId: string) {
  const db = await getDb();
  return db.select({ uploadId: uploadChunks.uploadId, idx: uploadChunks.idx }).from(uploadChunks).where(eq(uploadChunks.orgId, orgId));
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("beginUpload", () => {
  it("returns an id and the number of parts, and stores nothing yet", async () => {
    const { orgId, actor } = await makeOrg();
    const begun = await beginUpload(actor, { filename: "agreement.pdf", size: CHUNK * 2 + 5, mimeType: "application/pdf" });
    expect(begun.chunkCount).toBe(3);
    expect(begun.chunkSize).toBe(CHUNK);
    expect(typeof begun.uploadId).toBe("string");
    expect(await chunkRows(orgId)).toHaveLength(0);
  });

  it("counts one part for a file that is exactly one chunk and for a one-byte file", async () => {
    const { actor } = await makeOrg();
    expect((await beginUpload(actor, { filename: "a.pdf", size: CHUNK })).chunkCount).toBe(1);
    expect((await beginUpload(actor, { filename: "a.pdf", size: 1 })).chunkCount).toBe(1);
    expect((await beginUpload(actor, { filename: "a.pdf", size: CHUNK + 1 })).chunkCount).toBe(2);
  });

  it("accepts the size as a string of digits, as a form post sends it", async () => {
    const { actor } = await makeOrg();
    expect((await beginUpload(actor, { filename: "a.pdf", size: "10" })).chunkCount).toBe(1);
  });

  it("rejects an empty, missing, fractional, negative or oversized size", async () => {
    const { actor } = await makeOrg();
    await expectError(beginUpload(actor, { filename: "a.pdf", size: 0 }), "invalid", /empty/i);
    for (const size of [undefined, null, "", "abc", 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, {}, "1e3"]) {
      await expectError(beginUpload(actor, { filename: "a.pdf", size }), "invalid");
    }
    const tooBig = await expectError(beginUpload(actor, { filename: "a.pdf", size: LIMITS.maxUploadBytes + 1 }), "invalid", /25 MB limit/);
    expect(tooBig.message).toMatch(/upload again/i);
    // The limit itself is allowed.
    expect((await beginUpload(actor, { filename: "a.pdf", size: LIMITS.maxUploadBytes })).chunkCount).toBe(Math.ceil(LIMITS.maxUploadBytes / CHUNK));
  });

  it("does not throw on a missing or malformed input object", async () => {
    const { actor } = await makeOrg();
    await expectError(beginUpload(actor, undefined as never), "invalid");
    await expectError(beginUpload(actor, "nope" as never), "invalid");
  });

  it("refuses members, disabled people and callers with no company", async () => {
    const member = await makeOrg("member");
    await expectError(beginUpload(member.actor, { filename: "a.pdf", size: 10 }), "forbidden", /owner or admin/);

    const owner = await makeOrg();
    const db = await getDb();
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, owner.actor.userId));
    await expectError(beginUpload(owner.actor, { filename: "a.pdf", size: 10 }), "forbidden");

    await expectError(beginUpload(null as never, { filename: "a.pdf", size: 10 }), "forbidden");
    await expectError(beginUpload({ type: "user", orgId: "", userId: "x", role: "owner", label: "x" }, { filename: "a.pdf", size: 10 }), "forbidden");
  });

  it("trusts the stored role, not the one in the session", async () => {
    const member = await makeOrg("member");
    const forged: Actor = { ...member.actor, role: "owner" };
    await expectError(beginUpload(forged, { filename: "a.pdf", size: 10 }), "forbidden");
  });

  it("lets an API key and the system upload", async () => {
    const { orgId } = await makeOrg();
    expect((await beginUpload({ type: "api", orgId, keyId: "key_1", label: "Key" }, { filename: "a.pdf", size: 10 })).chunkCount).toBe(1);
    expect((await beginUpload({ type: "system", orgId, label: "System" }, { filename: "a.pdf", size: 10 })).chunkCount).toBe(1);
  });
});

describe("putChunk and completeUpload", () => {
  it("joins a multi-part upload in order whatever order the parts arrive in, and keeps the parts until told to discard them", async () => {
    const { orgId, actor } = await makeOrg();
    const bytes = pattern(CHUNK * 2 + 1234);
    const begun = await beginUpload(actor, { filename: "Client Agreement.pdf", size: bytes.length, mimeType: "Application/PDF" });
    const pieces = parts(bytes);
    expect(pieces).toHaveLength(begun.chunkCount);

    expect(await putChunk(actor, begun.uploadId, 2, pieces[2])).toEqual({ received: 1, chunkCount: 3, complete: false });
    expect(await putChunk(actor, begun.uploadId, 0, pieces[0])).toEqual({ received: 2, chunkCount: 3, complete: false });
    expect(await putChunk(actor, begun.uploadId, 1, pieces[1])).toEqual({ received: 3, chunkCount: 3, complete: true });

    const done = await completeUpload(actor, begun.uploadId);
    expect(done.filename).toBe("Client Agreement.pdf");
    expect(done.mimeType).toBe("application/pdf");
    expect(done.bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(done.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(done.id).toMatch(/^upl_/);

    // Whatever is made from the file may fail or time out, or the response may be lost:
    // finishing again must hand over the same bytes without a new upload.
    expect(await chunkRows(orgId)).toHaveLength(3);
    const again = await completeUpload(actor, begun.uploadId);
    expect(Buffer.from(again.bytes).equals(Buffer.from(bytes))).toBe(true);

    expect(await discardUpload(actor, begun.uploadId)).toBe(3);
    expect(await chunkRows(orgId)).toHaveLength(0);
    expect(await discardUpload(actor, begun.uploadId)).toBe(0);
  });

  it("is idempotent: the same part sent twice is stored once, and a resend replaces the first copy", async () => {
    const { orgId, actor } = await makeOrg();
    const begun = await beginUpload(actor, { filename: "a.txt", size: 4 });
    await putChunk(actor, begun.uploadId, 0, new Uint8Array([1, 1, 1, 1]));
    const again = await putChunk(actor, begun.uploadId, 0, new Uint8Array([1, 2, 3, 4]));
    expect(again.received).toBe(1);
    expect(await chunkRows(orgId)).toHaveLength(1);
    expect([...(await completeUpload(actor, begun.uploadId)).bytes]).toEqual([1, 2, 3, 4]);
  });

  it("stores only the visible window of a view onto a larger buffer, and accepts an ArrayBuffer", async () => {
    const { actor } = await makeOrg();
    const a = await beginUpload(actor, { filename: "a.bin", size: 3 });
    await putChunk(actor, a.uploadId, 0, new Uint8Array([9, 9, 1, 2, 3, 9]).subarray(2, 5));
    expect([...(await completeUpload(actor, a.uploadId)).bytes]).toEqual([1, 2, 3]);

    const b = await beginUpload(actor, { filename: "b.bin", size: 2 });
    await putChunk(actor, b.uploadId, "0", new Uint8Array([7, 8]).buffer);
    expect([...(await completeUpload(actor, b.uploadId)).bytes]).toEqual([7, 8]);
  });

  it("rejects part numbers outside the upload", async () => {
    const { orgId, actor } = await makeOrg();
    const begun = await beginUpload(actor, { filename: "a.bin", size: 4 });
    for (const index of [-1, 1, 99, 0.5, Number.NaN, "x", null, undefined, {}, "-1"]) {
      await expectError(putChunk(actor, begun.uploadId, index, new Uint8Array(4)), "invalid", /part/i);
    }
    expect(await chunkRows(orgId)).toHaveLength(0);
  });

  it("rejects a part that is too big, too small, empty or not bytes", async () => {
    const { orgId, actor } = await makeOrg();
    const begun = await beginUpload(actor, { filename: "a.bin", size: CHUNK + 10 });
    await expectError(putChunk(actor, begun.uploadId, 0, new Uint8Array(CHUNK + 1)), "invalid", /larger than expected/);
    await expectError(putChunk(actor, begun.uploadId, 0, new Uint8Array(CHUNK - 1)), "invalid", /incomplete/);
    await expectError(putChunk(actor, begun.uploadId, 1, new Uint8Array(11)), "invalid", /larger than expected/);
    await expectError(putChunk(actor, begun.uploadId, 1, new Uint8Array(0)), "invalid", /empty/);
    for (const bad of ["text", null, undefined, 42, [1, 2, 3], { length: 10 }]) {
      await expectError(putChunk(actor, begun.uploadId, 1, bad), "invalid");
    }
    expect(await chunkRows(orgId)).toHaveLength(0);
  });

  it("will not finish while parts are missing, keeps what arrived, and finishes once they do", async () => {
    const { orgId, actor } = await makeOrg();
    const bytes = pattern(CHUNK * 2 + 7);
    const begun = await beginUpload(actor, { filename: "a.pdf", size: bytes.length });
    const pieces = parts(bytes);
    await putChunk(actor, begun.uploadId, 0, pieces[0]);

    const err = await expectError(completeUpload(actor, begun.uploadId), "conflict", /parts 2, 3 have not arrived/);
    expect(err.fields).toEqual({ missing: "1,2" });
    // The failed attempt must not have thrown away the part that did arrive.
    expect(await chunkRows(orgId)).toHaveLength(1);

    await putChunk(actor, begun.uploadId, 1, pieces[1]);
    await expectError(completeUpload(actor, begun.uploadId), "conflict", /part 3 has not arrived/);
    await putChunk(actor, begun.uploadId, 2, pieces[2]);
    const done = await completeUpload(actor, begun.uploadId);
    expect(Buffer.from(done.bytes).equals(Buffer.from(bytes))).toBe(true);
  });

  it("finishing with nothing sent, or after the upload was discarded, says what to check and to start again", async () => {
    const { actor } = await makeOrg();
    const begun = await beginUpload(actor, { filename: "a.bin", size: 2 });
    await expectError(completeUpload(actor, begun.uploadId), "not_found", /start the upload again/);
    await putChunk(actor, begun.uploadId, 0, new Uint8Array([1, 2]));
    await completeUpload(actor, begun.uploadId);
    await discardUpload(actor, begun.uploadId);
    await expectError(completeUpload(actor, begun.uploadId), "not_found", /check your list of agreements/);
  });

  it("only discards the caller's own company's upload, and never throws on a bad id", async () => {
    const mine = await makeOrg();
    const theirs = await makeOrg();
    const begun = await beginUpload(mine.actor, { filename: "a.bin", size: 2 });
    await putChunk(mine.actor, begun.uploadId, 0, new Uint8Array([1, 2]));
    expect(await discardUpload(theirs.actor, begun.uploadId)).toBe(0);
    for (const bad of [undefined, null, "", "nonsense", 7, {}]) expect(await discardUpload(mine.actor, bad)).toBe(0);
    expect(await chunkRows(mine.orgId)).toHaveLength(1);
    await expectError(discardUpload({ ...mine.actor, userId: "usr_nobody0000000000" }, begun.uploadId), "forbidden");
  });

  it("detects stored parts that no longer add up to the declared size", async () => {
    const { actor } = await makeOrg();
    const begun = await beginUpload(actor, { filename: "a.bin", size: 4 });
    await putChunk(actor, begun.uploadId, 0, new Uint8Array(4));
    const db = await getDb();
    await db.update(uploadChunks).set({ bytes: Buffer.from([1]) }).where(eq(uploadChunks.orgId, actor.orgId));
    await expectError(completeUpload(actor, begun.uploadId), "conflict", /does not match the size/);
  });

  it("cleans the filename and type it was given", async () => {
    const { actor } = await makeOrg();
    const begun = await beginUpload(actor, { filename: "C:\\Users\\me\\Desktop\\..\\My\u0000 Agreement\n.pdf", size: 1, mimeType: 42 });
    await putChunk(actor, begun.uploadId, 0, new Uint8Array([1]));
    const done = await completeUpload(actor, begun.uploadId);
    expect(done.filename).toBe("My Agreement .pdf");
    expect(done.mimeType).toBe("application/octet-stream");

    const unnamed = await beginUpload(actor, { filename: undefined, size: 1 });
    await putChunk(actor, unnamed.uploadId, 0, new Uint8Array([1]));
    expect((await completeUpload(actor, unnamed.uploadId)).filename).toBe("agreement");

    const long = await beginUpload(actor, { filename: `${"n".repeat(5000)}.pdf`, size: 1 });
    await putChunk(actor, long.uploadId, 0, new Uint8Array([1]));
    expect((await completeUpload(actor, long.uploadId)).filename.length).toBeLessThanOrEqual(150);
  });
});

describe("upload ids", () => {
  it("treats another company's upload id as one that never existed", async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const begun = await beginUpload(a.actor, { filename: "a.bin", size: 2 });
    await putChunk(a.actor, begun.uploadId, 0, new Uint8Array([1, 2]));

    await expectError(putChunk(b.actor, begun.uploadId, 0, new Uint8Array([9, 9])), "not_found");
    await expectError(completeUpload(b.actor, begun.uploadId), "not_found");
    expect(await chunkRows(b.orgId)).toHaveLength(0);
    // The owner's upload is untouched by the attempts.
    expect([...(await completeUpload(a.actor, begun.uploadId)).bytes]).toEqual([1, 2]);
  });

  it("rejects an id whose declared size, owner or name was edited", async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const begun = await beginUpload(a.actor, { filename: "a.bin", size: 2 });
    const [id, body, signature] = begun.uploadId.split(".");
    const descriptor = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));

    const forge = (change: Record<string, unknown>) => `${id}.${Buffer.from(JSON.stringify({ ...descriptor, ...change })).toString("base64url")}.${signature}`;
    await expectError(putChunk(a.actor, forge({ s: LIMITS.maxUploadBytes, c: 9 }), 0, new Uint8Array(2)), "not_found");
    await expectError(putChunk(b.actor, forge({ o: b.orgId }), 0, new Uint8Array(2)), "not_found");
    await expectError(completeUpload(a.actor, forge({ n: "other.exe" })), "not_found");
    await expectError(completeUpload(a.actor, `${id}.${body}.${signature.slice(0, -2)}AA`), "not_found");
    expect(await chunkRows(a.orgId)).toHaveLength(0);
  });

  it("rejects garbage ids without throwing anything unexpected", async () => {
    const { actor } = await makeOrg();
    const garbage = [undefined, null, "", "abc", "a.b", "a.b.c", "a.b.c.d", "..", 42, {}, [], "x".repeat(5000), "upl_x.%%%.###", "' OR 1=1 --"];
    for (const id of garbage) {
      await expectError(putChunk(actor, id, 0, new Uint8Array(1)), "not_found", /Start the upload again/);
      await expectError(completeUpload(actor, id), "not_found", /Start the upload again/);
    }
  });

  it("expires an upload that takes too long", async () => {
    const { actor } = await makeOrg();
    const begun = await beginUpload(actor, { filename: "a.bin", size: 2 });
    await putChunk(actor, begun.uploadId, 0, new Uint8Array([1, 2]));
    const real = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(real + UPLOAD_TTL_MS + 1000);
    await expectError(putChunk(actor, begun.uploadId, 0, new Uint8Array([1, 2])), "gone", /expired/);
    await expectError(completeUpload(actor, begun.uploadId), "gone", /Start the upload again/);
  });

  it("stops working for someone who lost the right to upload part-way through", async () => {
    const { actor } = await makeOrg("admin");
    const begun = await beginUpload(actor, { filename: "a.bin", size: 2 });
    await putChunk(actor, begun.uploadId, 0, new Uint8Array([1, 2]));
    const db = await getDb();
    await db.update(users).set({ role: "member" }).where(eq(users.id, actor.userId));
    await expectError(completeUpload(actor, begun.uploadId), "forbidden");
  });
});

describe("limits and cleanup", () => {
  it("caps how much one company can leave in unfinished uploads, without affecting other companies", async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const db = await getDb();
    // Simulate other unfinished uploads by declaring large sizes and sending only a small last part of each:
    // the quota counts stored bytes of other uploads plus the declared size of this one.
    const filler = Buffer.alloc(1024 * 1024);
    const rows = Math.ceil(PENDING_UPLOAD_QUOTA_BYTES / filler.length);
    for (let i = 0; i < rows; i++) {
      await db.insert(uploadChunks).values({ uploadId: `upl_fill${i}`, idx: 0, orgId: a.orgId, bytes: filler });
    }
    const begun = await beginUpload(a.actor, { filename: "a.bin", size: 2 });
    await expectError(putChunk(a.actor, begun.uploadId, 0, new Uint8Array([1, 2])), "rate_limited", /Too many uploads/);

    const other = await beginUpload(b.actor, { filename: "b.bin", size: 2 });
    expect((await putChunk(b.actor, other.uploadId, 0, new Uint8Array([1, 2]))).complete).toBe(true);

    // Once the leftovers are old enough to be abandoned they are cleared and the upload goes through.
    await db.update(uploadChunks).set({ createdAt: new Date(Date.now() - 31 * 60 * 1000) }).where(eq(uploadChunks.orgId, a.orgId));
    expect((await putChunk(a.actor, begun.uploadId, 0, new Uint8Array([1, 2]))).complete).toBe(true);
    expect(await chunkRows(a.orgId)).toHaveLength(1);
    expect(await chunkRows(b.orgId)).toHaveLength(1);
  });

  it("purgeStaleUploads removes only parts older than the time limit", async () => {
    const { orgId, actor } = await makeOrg();
    const db = await getDb();
    await db.delete(uploadChunks);
    const old = await beginUpload(actor, { filename: "old.bin", size: 2 });
    const fresh = await beginUpload(actor, { filename: "fresh.bin", size: 2 });
    await putChunk(actor, old.uploadId, 0, new Uint8Array([1, 2]));
    await putChunk(actor, fresh.uploadId, 0, new Uint8Array([3, 4]));
    await db
      .update(uploadChunks)
      .set({ createdAt: new Date(Date.now() - UPLOAD_TTL_MS - 60_000) })
      .where(eq(uploadChunks.uploadId, old.uploadId.split(".")[0]));

    expect(await purgeStaleUploads()).toBe(1);
    expect(await chunkRows(orgId)).toHaveLength(1);
    expect(await purgeStaleUploads()).toBe(0);
    expect([...(await completeUpload(actor, fresh.uploadId)).bytes]).toEqual([3, 4]);
    await expectError(completeUpload(actor, old.uploadId), "not_found");
  });

  it("purgeStaleUploads ignores a nonsensical age instead of deleting everything", async () => {
    const { orgId, actor } = await makeOrg();
    const begun = await beginUpload(actor, { filename: "a.bin", size: 2 });
    await putChunk(actor, begun.uploadId, 0, new Uint8Array([1, 2]));
    await purgeStaleUploads(Number.NaN);
    await purgeStaleUploads(-5);
    expect(await chunkRows(orgId)).toHaveLength(1);
    expect(await purgeStaleUploads(0)).toBeGreaterThanOrEqual(1);
  });
});
