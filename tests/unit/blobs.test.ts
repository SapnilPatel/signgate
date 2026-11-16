import { describe, it, expect } from "vitest";
import { getDb } from "@/lib/db";
import { orgs, templates } from "@/lib/db/schema";
import { newId, sha256Hex } from "@/lib/ids";
import { LIMITS } from "@/lib/types";
import { ServiceError } from "@/lib/services/context";
import { putBlob, getBlob, getBlobUnscopedForSigningLink, deleteBlob } from "@/lib/services/blobs";

async function makeOrg(): Promise<string> {
  const db = await getDb();
  const id = newId("org");
  await db.insert(orgs).values({ id, name: "Test Co", slug: id });
  return id;
}

const pdfBytes = () => Buffer.from("%PDF-1.7 test bytes \u0000\u00ff", "latin1");

describe("blobs", () => {
  it("stores bytes and returns id, hash and size", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    const bytes = pdfBytes();
    const put = await putBlob(db, { orgId, bytes, contentType: "application/pdf", filename: "agreement.pdf" });
    expect(put).toEqual({ id: expect.stringMatching(/^blob_/), sha256: sha256Hex(bytes), size: bytes.length });
    const row = await getBlob(orgId, put.id);
    expect(row).not.toBeNull();
    expect(Buffer.compare(row!.bytes, bytes)).toBe(0);
    expect(row).toMatchObject({ contentType: "application/pdf", filename: "agreement.pdf", size: bytes.length });
  });

  it("copies only the visible window of a Uint8Array view", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const view = backing.subarray(2, 5);
    const put = await putBlob(db, { orgId, bytes: view, contentType: "application/octet-stream" });
    expect(put.size).toBe(3);
    expect([...(await getBlob(orgId, put.id))!.bytes]).toEqual([1, 2, 3]);
  });

  it("is org-scoped: another org's id reads as missing and cannot be deleted", async () => {
    const db = await getDb();
    const a = await makeOrg();
    const b = await makeOrg();
    const put = await putBlob(db, { orgId: a, bytes: pdfBytes(), contentType: "application/pdf" });
    expect(await getBlob(b, put.id)).toBeNull();
    expect(await deleteBlob(b, put.id)).toBe(false);
    expect(await getBlob(a, put.id)).not.toBeNull();
    // The deliberately unscoped read finds it regardless of org.
    expect((await getBlobUnscopedForSigningLink(put.id))!.orgId).toBe(a);
  });

  it("returns null for missing and malformed ids", async () => {
    const orgId = await makeOrg();
    expect(await getBlob(orgId, "blob_does_not_exist")).toBeNull();
    expect(await getBlob(orgId, "")).toBeNull();
    expect(await getBlob(orgId, undefined as never)).toBeNull();
    expect(await getBlob(orgId, "' OR 1=1 --")).toBeNull();
    expect(await getBlobUnscopedForSigningLink("")).toBeNull();
    expect(await getBlobUnscopedForSigningLink(null as never)).toBeNull();
    expect(await deleteBlob(orgId, "blob_does_not_exist")).toBe(false);
  });

  it("rejects empty, oversized and non-binary input with a message that says what to do", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    await expect(putBlob(db, { orgId, bytes: new Uint8Array(0), contentType: "application/pdf" })).rejects.toMatchObject({
      name: "ServiceError",
      code: "invalid",
      message: expect.stringContaining("empty"),
    });
    const tooBig = new Uint8Array(LIMITS.maxUploadBytes + 1);
    await expect(putBlob(db, { orgId, bytes: tooBig, contentType: "application/pdf" })).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining("25 MB limit"),
    });
    for (const bad of ["a string", null, undefined, [1, 2, 3], { length: 3 }, new ArrayBuffer(4)]) {
      await expect(putBlob(db, { orgId, bytes: bad as never, contentType: "application/pdf" })).rejects.toBeInstanceOf(ServiceError);
    }
  });

  it("accepts a file exactly at the size limit", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    const bytes = new Uint8Array(LIMITS.maxUploadBytes);
    bytes[0] = 37;
    bytes[bytes.length - 1] = 70;
    const put = await putBlob(db, { orgId, bytes, contentType: "application/pdf" });
    expect(put.size).toBe(LIMITS.maxUploadBytes);
    const row = await getBlob(orgId, put.id);
    expect(row!.bytes.length).toBe(LIMITS.maxUploadBytes);
    expect(row!.bytes[row!.bytes.length - 1]).toBe(70);
    expect(await deleteBlob(orgId, put.id)).toBe(true);
  });

  it("neutralizes hostile content types and filenames", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    const cases: Array<[string, string | null | undefined, string, string | null]> = [
      ["text/html\r\nSet-Cookie: x=1", "../../etc/passwd", "application/octet-stream", "passwd"],
      ["", "C:\\Users\\sam\\My Agreement.docx", "application/octet-stream", "My Agreement.docx"],
      ["APPLICATION/PDF", 'a"b\r\nc.pdf', "application/pdf", "a b c.pdf"],
      ["text/plain; charset=utf-8", "   ", "text/plain; charset=utf-8", null],
      ["image/png", `${"n".repeat(400)}.png`, "image/png", "n".repeat(200)],
      ["not a type", "..hidden\u0000.pdf", "application/octet-stream", "hidden .pdf"],
      [42 as never, 7 as never, "application/octet-stream", null],
    ];
    for (const [contentType, filename, wantType, wantName] of cases) {
      const put = await putBlob(db, { orgId, bytes: pdfBytes(), contentType, filename });
      const row = await getBlob(orgId, put.id);
      expect(row!.contentType).toBe(wantType);
      expect(row!.filename).toBe(wantName);
    }
  });

  it("deletes an unreferenced blob and reports a referenced one as a conflict", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    const free = await putBlob(db, { orgId, bytes: pdfBytes(), contentType: "application/pdf" });
    expect(await deleteBlob(orgId, free.id)).toBe(true);
    expect(await getBlob(orgId, free.id)).toBeNull();
    expect(await deleteBlob(orgId, free.id)).toBe(false);

    const used = await putBlob(db, { orgId, bytes: pdfBytes(), contentType: "application/pdf" });
    await db.insert(templates).values({ id: newId("tpl"), orgId, name: "Client Agreement", pdfBlobId: used.id, pages: [{ width: 612, height: 792 }] });
    await expect(deleteBlob(orgId, used.id)).rejects.toMatchObject({ name: "ServiceError", code: "conflict" });
    expect(await getBlob(orgId, used.id)).not.toBeNull();
  });

  it("rolls back with the caller's transaction", async () => {
    const db = await getDb();
    const orgId = await makeOrg();
    let id = "";
    await expect(
      db.transaction(async (tx) => {
        id = (await putBlob(tx, { orgId, bytes: pdfBytes(), contentType: "application/pdf" })).id;
        expect(await getBlob(orgId, id, tx)).not.toBeNull();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await getBlob(orgId, id)).toBeNull();
  });
});
