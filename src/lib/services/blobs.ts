import { and, eq } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/lib/db";
import { blobs } from "@/lib/db/schema";
import { newId, sha256Hex } from "@/lib/ids";
import { LIMITS } from "@/lib/types";
import { ServiceError } from "./context";
import { cleanText } from "./events";

export type Blob = typeof blobs.$inferSelect;

export interface PutBlobInput {
  orgId: string;
  bytes: Uint8Array;
  contentType: string;
  filename?: string | null;
}

export interface PutBlobResult {
  id: string;
  sha256: string;
  size: number;
}

const megabytes = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

/** type/subtype with an optional parameter list; anything else is stored as opaque
 *  bytes so a hostile value can never end up in a Content-Type response header. */
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,99}(\s*;\s*[a-z0-9-]+=[a-z0-9._"-]+)*$/i;

function safeContentType(value: unknown): string {
  const text = cleanText(value, 200).toLowerCase();
  return CONTENT_TYPE.test(text) ? text : "application/octet-stream";
}

/** Keep the name people recognise, minus anything that could act as a path or
 *  break a Content-Disposition header when the file is downloaded again. */
function safeFilename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const base = value.split(/[\\/]/).pop() ?? "";
  const cleaned = cleanText(base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, " ").replace(/\s+/g, " "), 200).replace(/^\.+/, "");
  return cleaned || null;
}

/** Store immutable bytes for an org. Pass the caller's transaction so a blob never
 *  outlives a rolled-back change that was supposed to reference it. */
export async function putBlob(db: DbOrTx, input: PutBlobInput): Promise<PutBlobResult> {
  const raw: unknown = input.bytes;
  if (!(raw instanceof Uint8Array)) {
    throw new ServiceError("invalid", "The file could not be read. Upload it again.");
  }
  if (raw.byteLength === 0) {
    throw new ServiceError("invalid", "The file is empty. Choose a file that has content and upload it again.");
  }
  if (raw.byteLength > LIMITS.maxUploadBytes) {
    throw new ServiceError(
      "invalid",
      `The file is ${megabytes(raw.byteLength)}, which is over the ${megabytes(LIMITS.maxUploadBytes)} limit. Compress it or split it and upload again.`,
    );
  }
  // A Uint8Array may be a window onto a larger buffer; copy exactly the window.
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const id = newId("blob");
  const sha256 = sha256Hex(bytes);
  await db.insert(blobs).values({
    id,
    orgId: input.orgId,
    bytes,
    sha256,
    contentType: safeContentType(input.contentType),
    size: bytes.byteLength,
    filename: safeFilename(input.filename),
  });
  return { id, sha256, size: bytes.byteLength };
}

/** Read a blob that belongs to `orgId`. Another org's id, a missing id and a
 *  malformed id all return null, so callers cannot tell them apart either. */
export async function getBlob(orgId: string, id: string, db?: DbOrTx): Promise<Blob | null> {
  if (typeof orgId !== "string" || typeof id !== "string" || !orgId || !id) return null;
  const handle = db ?? (await getDb());
  const [row] = await handle
    .select()
    .from(blobs)
    .where(and(eq(blobs.id, id), eq(blobs.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/**
 * Read a blob by id alone, WITHOUT a tenant check.
 *
 * Only for public signing-link routes, where there is no session and the caller has
 * already proved access by resolving a signing token to a signer and taking the blob
 * id from that signer's own envelope row. Never pass an id that came from a request.
 * Everywhere else use getBlob(orgId, id).
 */
export async function getBlobUnscopedForSigningLink(id: string, db?: DbOrTx): Promise<Blob | null> {
  if (typeof id !== "string" || !id) return null;
  const handle = db ?? (await getDb());
  const [row] = await handle.select().from(blobs).where(eq(blobs.id, id)).limit(1);
  return row ?? null;
}

/** Postgres reports a foreign-key violation as 23503; the driver error may be wrapped by Drizzle. */
function isForeignKeyViolation(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && typeof e === "object" && i < 5; i++) {
    if ((e as { code?: unknown }).code === "23503") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Delete an org's blob. Returns false when there was nothing to delete. A blob an
 *  agreement or envelope still points at cannot be deleted. */
export async function deleteBlob(orgId: string, id: string, db?: DbOrTx): Promise<boolean> {
  if (typeof orgId !== "string" || typeof id !== "string" || !orgId || !id) return false;
  const handle = db ?? (await getDb());
  try {
    const deleted = await handle
      .delete(blobs)
      .where(and(eq(blobs.id, id), eq(blobs.orgId, orgId)))
      .returning({ id: blobs.id });
    return deleted.length > 0;
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new ServiceError("conflict", "This document is still used by an agreement or a sent envelope, so it cannot be deleted.");
    }
    throw err;
  }
}
