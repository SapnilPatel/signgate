/**
 * Input cleaning and validation shared by services, server actions and API routes.
 * Everything here accepts `unknown` and never throws: form posts and JSON bodies
 * can carry anything, and a validator that crashes on a number or an array is a bug.
 */
import { z } from "zod";

export const EMAIL_MAX_LENGTH = 254;
const EMAIL_LOCAL_MAX_LENGTH = 64;

/** Trimmed and lowercased; emails are stored and compared in this form everywhere. */
export function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const EMAIL_LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;
const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * Practical check for an address a mail provider will accept: one @, a dotted
 * domain with a real-looking TLD, no spaces, quotes or control characters.
 * Deliberately stricter than RFC 5322 (no quoted local parts, no IP literals,
 * ASCII only) because those forms are almost always typos or abuse, and the
 * email provider rejects them anyway.
 */
export function isValidEmail(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const email = value.trim();
  if (email.length < 3 || email.length > EMAIL_MAX_LENGTH) return false;
  const at = email.lastIndexOf("@");
  if (at < 1 || at !== email.indexOf("@")) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > EMAIL_LOCAL_MAX_LENGTH || !EMAIL_LOCAL.test(local)) return false;
  if (domain.length > 253) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => DOMAIN_LABEL.test(label))) return false;
  const tld = labels[labels.length - 1];
  // A TLD is letters only, or punycode. Rejects "user@host.1" and "user@10.0.0.1".
  return /^[a-z]{2,}$/i.test(tld) || /^xn--[a-z0-9-]{2,}$/i.test(tld);
}

// C0/C1 controls, zero-width space, BOM, and the bidirectional overrides that can make
// stored text render as something else (e.g. a spoofed name in an email or certificate).
// Zero-width joiners are kept: emoji sequences and several scripts need them.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

function truncate(text: string, max: number): string {
  if (!Number.isFinite(max) || max < 0) return "";
  if (text.length <= max) return text;
  // Never leave half of a surrogate pair at the cut.
  return text.slice(0, Math.floor(max)).replace(/[\uD800-\uDBFF]$/, "").trim();
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function toText(value: unknown): string {
  // Half of a surrogate pair is not valid text and jsonb refuses to store it.
  if (typeof value === "string") return value.replace(LONE_SURROGATE, "");
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * Single-line text: control characters removed, every run of whitespace (including
 * newlines and tabs) collapsed to one space, trimmed, cut to `max` characters.
 * Non-strings become "" so callers can treat "missing" and "blank" the same way.
 */
export function cleanText(value: unknown, max: number): string {
  const text = toText(value).normalize("NFC").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  return truncate(text, max);
}

/** Like cleanText but keeps line breaks, for messages people write in paragraphs. */
export function cleanMultilineText(value: unknown, max: number): string {
  const text = toText(value)
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(INVISIBLE, "")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return truncate(text, max);
}

/** #rgb or #rrggbb. Alpha forms are rejected: email clients do not render them reliably. */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

/** Lowercase #rrggbb, or null when the value is not a hex colour. */
export function normalizeHexColor(value: unknown): string | null {
  if (!isHexColor(value)) return null;
  const hex = value.trim().toLowerCase();
  return hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
}

export type ImageKind = "png" | "jpeg";

export type ImageDataUrlResult =
  | { ok: true; kind: ImageKind; bytes: Buffer; /** Re-encoded canonical data URL, safe to store. */ dataUrl: string }
  | { ok: false; reason: "format" | "too_large" | "corrupt" };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniffImage(bytes: Buffer): ImageKind | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_MAGIC) && bytes.toString("latin1", 12, 16) === "IHDR") {
    // A PNG with a zero dimension cannot be drawn and breaks PDF embedding later.
    return bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 ? "png" : null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

/**
 * Decodes a base64 image data URL and checks the bytes really are one of the allowed
 * formats. The declared MIME type is not trusted: an SVG or HTML payload labelled
 * image/png is rejected because the magic bytes do not match.
 */
export function parseImageDataUrl(value: unknown, allowed: readonly ImageKind[], maxBytes: number): ImageDataUrlResult {
  if (typeof value !== "string") return { ok: false, reason: "format" };
  const text = value.trim();
  const match = /^data:image\/(png|jpeg|jpg);base64,/i.exec(text);
  if (!match) return { ok: false, reason: "format" };
  const payload = text.slice(match[0].length).replace(/\s+/g, "");
  // Checked on the encoded length first so an oversized paste is never decoded.
  if (payload.length > Math.ceil(maxBytes / 3) * 4 + 4) return { ok: false, reason: "too_large" };
  if (payload.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return { ok: false, reason: "corrupt" };
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length > maxBytes) return { ok: false, reason: "too_large" };
  const kind = sniffImage(bytes);
  if (!kind) return { ok: false, reason: "corrupt" };
  const declared = match[1].toLowerCase() === "png" ? "png" : "jpeg";
  if (declared !== kind || !allowed.includes(kind)) return { ok: false, reason: "format" };
  return { ok: true, kind, bytes, dataUrl: `data:image/${kind};base64,${bytes.toString("base64")}` };
}

// ---------------------------------------------------------------------------
// zod schemas for route handlers and server actions
// ---------------------------------------------------------------------------

/** Normalizes then validates; output is the stored (lowercase) form. */
export const emailSchema = z.preprocess(
  normalizeEmail,
  z.string().refine(isValidEmail, { message: "Enter a valid email address, like name@example.com." }),
);

/** Required single-line text of at most `max` characters, cleaned. */
export function textSchema(max: number, label = "This") {
  return z.preprocess(
    (v) => cleanText(v, max + 1),
    z
      .string()
      .min(1, `${label} is required.`)
      .max(max, `${label} must be ${max} characters or fewer.`),
  );
}

/** Optional single-line text; blank and missing both become null. */
export function optionalTextSchema(max: number, label = "This") {
  return z.preprocess(
    (v) => cleanText(v, max + 1) || null,
    z.string().max(max, `${label} must be ${max} characters or fewer.`).nullable(),
  );
}

export const hexColorSchema = z.preprocess(
  (v) => normalizeHexColor(v) ?? v,
  z.string().refine(isHexColor, { message: "Enter a colour as a hex code, like #1f3a5f." }),
);

/**
 * The canonical IANA name of a time zone ("america/toronto" becomes "America/Toronto"),
 * or null when the runtime does not know the zone. Intl is the authority: a name it
 * accepts here is one every later date calculation will accept too.
 */
export function normalizeTimeZone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const zone = value.trim();
  if (zone.length < 3 || zone.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(zone)) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: zone }).resolvedOptions().timeZone || zone;
  } catch {
    return null;
  }
}

/** Row ids as produced by newId(): prefix, underscore, 16 base36 characters. */
export const idSchema = z.string().regex(/^[a-z]{2,5}_[0-9a-z]{16}$/, "That id is not valid.");

/** Link secrets as produced by newSecret(). */
export function isSecretToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-z]{32}$/.test(value);
}
