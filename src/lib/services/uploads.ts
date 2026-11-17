/**
 * Chunked uploads. The host rejects request bodies above about 4 MB, so the browser
 * sends an agreement in parts of LIMITS.uploadChunkBytes and asks for them to be
 * joined at the end.
 *
 * Nothing about an upload lives in process memory, because each request may land on a
 * different serverless instance. The parts are rows in `upload_chunks`; what was
 * declared at the start (size, name, type, owner) travels inside the upload id itself,
 * signed with APP_SECRET, so it cannot be altered and needs no table of its own.
 */
import { createHmac } from "node:crypto";
import { and, eq, lt, ne, sql } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/lib/db";
import { uploadChunks } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { newId, safeEqual } from "@/lib/ids";
import { LIMITS } from "@/lib/types";
import { cleanText } from "@/lib/validation";
import { ServiceError, type Actor } from "./context";
import { assertActiveActor } from "./accounts";

/** How long an upload may take from start to finish. Parts older than this are purged. */
export const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;
/** Most bytes one company may have in unfinished uploads at once. */
export const PENDING_UPLOAD_QUOTA_BYTES = LIMITS.maxUploadBytes * 4;
/** When the quota is hit, the company's own parts older than this are assumed abandoned. */
const ABANDONED_AFTER_MS = 30 * 60 * 1000;
const FILENAME_MAX = 150;
const MIME_MAX = 100;
const UPLOAD_ID_MAX = 2000;
const MIME_SHAPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(\s*;\s*[a-z0-9-]+=[a-z0-9._"-]+)*$/;

export interface BeginUploadInput {
  filename: unknown;
  size: unknown;
  mimeType?: unknown;
}

export interface BeginUploadResult {
  uploadId: string;
  chunkCount: number;
  /** Size of every part except the last, so the browser does not hard-code it. */
  chunkSize: number;
}

export interface PutChunkResult {
  /** Parts stored so far, including this one. */
  received: number;
  chunkCount: number;
  complete: boolean;
}

export interface CompletedUpload {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  /** Short id of the upload, safe to use in keys and logs (the uploadId itself is long and signed). */
  id: string;
}

/** What beginUpload promised, carried inside the upload id. */
interface Descriptor {
  /** Key of the parts in upload_chunks. */
  i: string;
  o: string;
  n: string;
  m: string;
  s: number;
  c: number;
  /** Issued at, epoch milliseconds. */
  t: number;
}

const megabytes = (n: number) => `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0).replace(/\.0$/, "")} MB`;

const startAgain = () => new ServiceError("not_found", "This upload could not be found. Start the upload again.");

function sign(body: string): string {
  // The prefix keeps this signature from ever being valid as a signing-link secret,
  // which is derived from the same APP_SECRET.
  return createHmac("sha256", env.appSecret).update(`upload:v1\n${body}`).digest("base64url");
}

function encodeDescriptor(d: Descriptor): string {
  const body = Buffer.from(JSON.stringify(d), "utf8").toString("base64url");
  return `${d.i}.${body}.${sign(body)}`;
}

function decodeDescriptor(actor: Actor, uploadId: unknown, opts: { allowExpired?: boolean } = {}): Descriptor {
  if (typeof uploadId !== "string" || uploadId.length === 0 || uploadId.length > UPLOAD_ID_MAX) throw startAgain();
  const parts = uploadId.split(".");
  if (parts.length !== 3) throw startAgain();
  const [id, body, signature] = parts;
  if (!safeEqual(signature, sign(body))) throw startAgain();
  let d: Descriptor;
  try {
    d = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Descriptor;
  } catch {
    throw startAgain();
  }
  // The signature already proves we wrote this; the shape check guards against a
  // descriptor written by an older build.
  if (
    !d ||
    typeof d !== "object" ||
    d.i !== id ||
    typeof d.o !== "string" ||
    typeof d.n !== "string" ||
    typeof d.m !== "string" ||
    !Number.isInteger(d.s) ||
    !Number.isInteger(d.c) ||
    !Number.isFinite(d.t) ||
    d.s <= 0 ||
    d.c !== Math.ceil(d.s / LIMITS.uploadChunkBytes)
  ) {
    throw startAgain();
  }
  // Another company's upload id is indistinguishable from one that never existed.
  if (d.o !== actor.orgId) throw startAgain();
  if (!opts.allowExpired && Date.now() - d.t > UPLOAD_TTL_MS) {
    throw new ServiceError("gone", "This upload took too long and has expired. Start the upload again.");
  }
  return d;
}

/**
 * Only people who may create or change agreements may upload: an owner or admin, an
 * API key, or the system. The stored row decides, because the role in a session can
 * be minutes out of date.
 */
async function assertMayUpload(db: DbOrTx, actor: Actor): Promise<void> {
  await assertActiveActor(db, actor, "manage");
}

function expectedChunkSize(d: Descriptor, index: number): number {
  return index === d.c - 1 ? d.s - (d.c - 1) * LIMITS.uploadChunkBytes : LIMITS.uploadChunkBytes;
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

/** Start an upload. Nothing is stored until the first part arrives. */
export async function beginUpload(actor: Actor, input: BeginUploadInput): Promise<BeginUploadResult> {
  const db = await getDb();
  await assertMayUpload(db, actor);

  const raw = (input && typeof input === "object" ? input : {}) as BeginUploadInput;
  const size = typeof raw.size === "string" && /^\d{1,15}$/.test(raw.size.trim()) ? Number(raw.size.trim()) : raw.size;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
    throw new ServiceError("invalid", "The file size is missing. Choose the file again and upload it.", { size: "The file size is missing." });
  }
  if (size === 0) {
    throw new ServiceError("invalid", "The file is empty. Choose a file that has content and upload it again.", { size: "The file is empty." });
  }
  if (size > LIMITS.maxUploadBytes) {
    throw new ServiceError(
      "invalid",
      `The file is ${megabytes(size)}, which is over the ${megabytes(LIMITS.maxUploadBytes)} limit. Save a smaller copy (for example with "Reduce file size") and upload again.`,
      { size: "The file is too large." },
    );
  }

  // Only the last path segment: a browser on Windows may send a full path.
  const base = typeof raw.filename === "string" ? (raw.filename.split(/[\\/]/).pop() ?? "") : "";
  const filename = cleanText(base, FILENAME_MAX) || "agreement";
  // The browser's type is only a hint (the engine sniffs content), but it ends up in a
  // stored content type, so anything that is not shaped like one is dropped.
  const claimed = typeof raw.mimeType === "string" ? cleanText(raw.mimeType, MIME_MAX).toLowerCase() : "";
  const mimeType = MIME_SHAPE.test(claimed) ? claimed : "application/octet-stream";

  const descriptor: Descriptor = {
    i: newId("upl"),
    o: actor.orgId,
    n: filename,
    m: mimeType,
    s: size,
    c: Math.ceil(size / LIMITS.uploadChunkBytes),
    t: Date.now(),
  };
  return { uploadId: encodeDescriptor(descriptor), chunkCount: descriptor.c, chunkSize: LIMITS.uploadChunkBytes };
}

/**
 * Store one part. Sending the same part again replaces it, so a browser can retry
 * after a dropped connection without knowing whether the first attempt arrived.
 */
export async function putChunk(actor: Actor, uploadId: unknown, index: unknown, bytes: unknown): Promise<PutChunkResult> {
  const db = await getDb();
  await assertMayUpload(db, actor);
  const d = decodeDescriptor(actor, uploadId);

  const idx = typeof index === "string" && /^\d{1,6}$/.test(index.trim()) ? Number(index.trim()) : index;
  if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= d.c) {
    throw new ServiceError("invalid", `That part number is not part of this upload, which has ${d.c} ${d.c === 1 ? "part" : "parts"}. Start the upload again.`);
  }
  const data = toBytes(bytes);
  if (!data) throw new ServiceError("invalid", "That part of the file arrived empty or unreadable. Send it again.");
  const expected = expectedChunkSize(d, idx);
  // Exact sizes mean the total can only ever add up to what was declared, and no
  // single request can store more than one part's worth.
  if (data.byteLength !== expected) {
    const problem = data.byteLength > expected ? "is larger than expected" : data.byteLength === 0 ? "arrived empty" : "is incomplete";
    throw new ServiceError("invalid", `Part ${idx + 1} of the file ${problem}. Send it again; if this keeps happening, start the upload again.`);
  }

  const pendingElsewhere = async () => {
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(octet_length(${uploadChunks.bytes})), 0)::float8` })
      .from(uploadChunks)
      .where(and(eq(uploadChunks.orgId, d.o), ne(uploadChunks.uploadId, d.i)));
    return Number(row?.total ?? 0);
  };
  if ((await pendingElsewhere()) + d.s > PENDING_UPLOAD_QUOTA_BYTES) {
    // Closed tabs leave parts behind; clear this company's old ones before refusing.
    await db
      .delete(uploadChunks)
      .where(and(eq(uploadChunks.orgId, d.o), ne(uploadChunks.uploadId, d.i), lt(uploadChunks.createdAt, new Date(Date.now() - ABANDONED_AFTER_MS))));
    if ((await pendingElsewhere()) + d.s > PENDING_UPLOAD_QUOTA_BYTES) {
      throw new ServiceError("rate_limited", "Too many uploads are in progress for your company. Wait for them to finish, or try again in 30 minutes.");
    }
  }

  // A view may be a window onto a larger buffer; store exactly the window.
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  await db
    .insert(uploadChunks)
    .values({ uploadId: d.i, idx, orgId: d.o, bytes: buffer })
    .onConflictDoUpdate({ target: [uploadChunks.uploadId, uploadChunks.idx], set: { bytes: buffer, createdAt: new Date() } });

  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(uploadChunks)
    .where(and(eq(uploadChunks.uploadId, d.i), eq(uploadChunks.orgId, d.o)));
  const received = Number(count?.n ?? 0);
  return { received, chunkCount: d.c, complete: received >= d.c };
}

/**
 * Join the parts and hand back the file. Nothing is removed: the parts stay until
 * the caller has made something durable from them and calls discardUpload, so a
 * step that times out, throws, or whose response is lost can simply be run again
 * without the person uploading 25 MB a second time. Abandoned parts are purged by
 * the scheduler.
 *
 * Two simultaneous calls both receive the file. A caller that must create exactly
 * one thing from an upload uses createTemplateFromCompletedUpload, which claims it first.
 */
export async function completeUpload(actor: Actor, uploadId: unknown): Promise<CompletedUpload> {
  const db = await getDb();
  await assertMayUpload(db, actor);
  const d = decodeDescriptor(actor, uploadId);

  const rows = await db
    .select({ idx: uploadChunks.idx, bytes: uploadChunks.bytes })
    .from(uploadChunks)
    .where(and(eq(uploadChunks.uploadId, d.i), eq(uploadChunks.orgId, d.o)));

  if (rows.length === 0) {
    throw new ServiceError(
      "not_found",
      "No parts of this upload were found. It may already have been finished: check your list of agreements before uploading again. Otherwise it expired, so start the upload again.",
    );
  }
  const byIndex = new Map(rows.map((r) => [r.idx, r.bytes]));
  const missing: number[] = [];
  for (let i = 0; i < d.c; i++) if (!byIndex.has(i)) missing.push(i);
  if (missing.length > 0) {
    const shown = missing.slice(0, 10).map((i) => i + 1).join(", ");
    throw new ServiceError(
      "conflict",
      `The upload is not finished: ${missing.length === 1 ? `part ${shown} has` : `parts ${shown}${missing.length > 10 ? " and others have" : " have"}`} not arrived. Send the missing parts, then finish again.`,
      { missing: missing.join(",") },
    );
  }
  const ordered = Array.from({ length: d.c }, (_, i) => byIndex.get(i) as Buffer);
  const total = ordered.reduce((sum, b) => sum + b.byteLength, 0);
  if (total !== d.s) {
    throw new ServiceError("conflict", "The uploaded file does not match the size that was announced. Start the upload again.");
  }
  return { bytes: new Uint8Array(Buffer.concat(ordered, total)), filename: d.n, mimeType: d.m, id: d.i };
}

/**
 * Remove an upload's parts once what was made from them is safely stored. Returns
 * how many parts were removed; discarding twice, or discarding an upload that
 * already expired, removes nothing and is not an error.
 */
export async function discardUpload(actor: Actor, uploadId: unknown): Promise<number> {
  const db = await getDb();
  await assertMayUpload(db, actor);
  let d: Descriptor;
  try {
    d = decodeDescriptor(actor, uploadId);
  } catch (err) {
    // An expired id still names parts that should go; anything else names nothing of this company's.
    if (!(err instanceof ServiceError) || err.code !== "gone") return 0;
    d = decodeDescriptor(actor, uploadId, { allowExpired: true });
  }
  const removed = await db
    .delete(uploadChunks)
    .where(and(eq(uploadChunks.uploadId, d.i), eq(uploadChunks.orgId, d.o)))
    .returning({ idx: uploadChunks.idx });
  return removed.length;
}

/** Scheduler job: remove parts of uploads that were never finished. Returns how many parts were removed. */
export async function purgeStaleUploads(olderThanMs: number = UPLOAD_TTL_MS): Promise<number> {
  const age = Number.isFinite(olderThanMs) && olderThanMs >= 0 ? olderThanMs : UPLOAD_TTL_MS;
  const db = await getDb();
  const removed = await db
    .delete(uploadChunks)
    .where(lt(uploadChunks.createdAt, new Date(Date.now() - age)))
    .returning({ idx: uploadChunks.idx });
  return removed.length;
}
