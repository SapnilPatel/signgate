import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Random lowercase base36 string with ~5.17 bits of entropy per character. */
export function randomString(length: number): string {
  const out: string[] = [];
  // Rejection sampling keeps the distribution uniform (252 = 36 * 7).
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 252 && out.length < length) out.push(ALPHABET[byte % 36]);
    }
  }
  return out.join("");
}

export type IdPrefix =
  | "org"
  | "usr"
  | "blob"
  | "tpl"
  | "file"
  | "env"
  | "sgn"
  | "evt"
  | "key"
  | "whk"
  | "whd"
  | "eml"
  | "fld"
  | "upl";

/** Prefixed, sortable-enough unique id, e.g. env_k3j9x0q2m4a7b1c5. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomString(16)}`;
}

/** High-entropy secret for links and keys (~165 bits). */
export function newSecret(): string {
  return randomString(32);
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
