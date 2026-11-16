/**
 * Signing-link secrets.
 *
 * A link secret is HMAC-SHA256(APP_SECRET, signerId + ":" + nonce). Because it is
 * derived, the sender can be shown the link again at any time without the secret
 * ever being stored; the database holds only the nonce and the secret's SHA-256.
 * Replacing the nonce changes the secret, which is how a link is revoked.
 */
import { createHmac, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/lib/db";
import { signers, type Signer } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { safeEqual, sha256Hex } from "@/lib/ids";

/** base64url of 32 bytes is always 43 characters. Anything else is not one of ours. */
const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function newTokenNonce(): string {
  return randomBytes(18).toString("base64url");
}

export function signingSecret(signerId: string, nonce: string): string {
  return createHmac("sha256", env.appSecret).update(`${signerId}:${nonce}`).digest("base64url");
}

export function hashSigningSecret(secret: string): string {
  return sha256Hex(secret);
}

/** A fresh nonce for a signer plus the hash to store. Used when a signer is created and when a link is rotated. */
export function mintSigningToken(signerId: string): { tokenNonce: string; tokenHash: string; secret: string } {
  const tokenNonce = newTokenNonce();
  const secret = signingSecret(signerId, tokenNonce);
  return { tokenNonce, tokenHash: hashSigningSecret(secret), secret };
}

export function signingUrl(signer: Pick<Signer, "id" | "tokenNonce">): string {
  return `${env.appUrl}/sign/${signingSecret(signer.id, signer.tokenNonce)}`;
}

export function isSigningSecret(value: unknown): value is string {
  return typeof value === "string" && SECRET_SHAPE.test(value);
}

/**
 * True when the stored hash still matches the secret derived from the current
 * APP_SECRET. It stops matching if APP_SECRET is changed after links were issued;
 * callers that show a link re-mint it in that case instead of showing a dead one.
 */
export function tokenIsCurrent(signer: Pick<Signer, "id" | "tokenNonce" | "tokenHash">): boolean {
  return safeEqual(hashSigningSecret(signingSecret(signer.id, signer.tokenNonce)), signer.tokenHash);
}

/** Short, non-reversible handle for a link, for rate-limit keys. The secret itself never becomes a key. */
export function linkRateKey(secret: unknown): string {
  return sha256Hex(typeof secret === "string" ? secret.slice(0, 200) : "").slice(0, 24);
}

/**
 * Resolve a link secret to its signer. Anything malformed, unknown or revoked
 * returns null: callers must not be able to tell those apart.
 */
export async function findSignerBySecret(secret: unknown, db?: DbOrTx): Promise<Signer | null> {
  if (!isSigningSecret(secret)) return null;
  const handle = db ?? (await getDb());
  const [signer] = await handle.select().from(signers).where(eq(signers.tokenHash, hashSigningSecret(secret))).limit(1);
  if (!signer) return null;
  // Belt and braces: the hash matched, and the secret must also be the one this
  // signer's current nonce derives.
  return safeEqual(signingSecret(signer.id, signer.tokenNonce), secret) ? signer : null;
}
