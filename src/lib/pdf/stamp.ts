/**
 * Writes field values onto the pages of an agreement.
 *
 * Everything here is defensive on purpose: the document, the field list and the
 * values all originate outside the engine, and a signed agreement that fails to
 * render because of one odd value is worse than one where that value is skipped.
 * Only an unreadable PDF is an error; every other problem degrades per field.
 */
import { inflateSync } from "node:zlib";
import { PDFDocument, degrees, rgb, LineCapStyle } from "pdf-lib";
import type { PDFFont, PDFImage, PDFPage } from "pdf-lib";
import { IMAGE_FIELD_TYPES, LIMITS } from "@/lib/types";
import type { Field, FieldValues } from "@/lib/types";
import { DocumentError } from "./types";
import { displaySize, fracRectToPdf } from "./geometry";
import type { PdfPlacement } from "./geometry";
import { embedFonts, safeText } from "./fonts";

/** Below this, stamped text stops shrinking and is truncated instead: 6pt is the smallest size that survives a printer. */
export const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 12;
const LINE_HEIGHT = 1.2;
const ELLIPSIS = "\u2026";
const INK = rgb(0.06, 0.07, 0.12);

/** A signature pad on a 3x display produces about 1800x600; anything far beyond that is not a signature. */
const MAX_IMAGE_SIDE = 4096;
/** pdf-lib inflates PNGs to raw pixels in memory, so a small file with huge dimensions must be refused up front. */
const MAX_IMAGE_PIXELS = 4_194_304;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type ParsedImage =
  | { ok: true; bytes: Uint8Array; width: number; height: number }
  | { ok: false; reason: string };

/**
 * Validates a signature or initials value. Accepts only a base64 PNG data URL
 * holding a complete, internally consistent PNG, so nothing else (SVG with
 * scripts, a renamed JPEG, a truncated upload, a decompression bomb) can reach
 * the PDF writer or the database.
 */
export function parseImageDataUrl(value: unknown): ParsedImage {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, reason: "The signature is missing. Draw or type your signature and try again." };
  }
  const comma = value.indexOf(",");
  const header = comma > 0 && comma < 100 ? value.slice(0, comma) : "";
  if (!/^data:image\/png(;[a-z0-9=._-]+)*;base64$/i.test(header.trim())) {
    return { ok: false, reason: "The signature must be a PNG image. Draw or type your signature again." };
  }
  const maxBase64 = Math.ceil(LIMITS.maxSignatureBytes / 3) * 4 + 16;
  // Checked before decoding so an oversized payload costs nothing.
  if (value.length - comma - 1 > maxBase64 * 1.05) {
    return { ok: false, reason: tooLargeReason() };
  }
  const base64 = value.slice(comma + 1).replace(/\s+/g, "");
  if (base64.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return { ok: false, reason: "The signature image is damaged. Draw or type your signature again." };
  }
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (bytes.length > LIMITS.maxSignatureBytes) return { ok: false, reason: tooLargeReason() };
  // 8 magic + 25 IHDR chunk + at least an empty IDAT and IEND.
  if (bytes.length < 57 || !PNG_MAGIC.every((b, i) => bytes[i] === b)) {
    return { ok: false, reason: "The signature image is not a valid PNG. Draw or type your signature again." };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdr = view.getUint32(8) === 13 && String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) === "IHDR";
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  if (!ihdr || ![1, 2, 4, 8, 16].includes(bitDepth) || ![0, 2, 3, 4, 6].includes(colorType) || bytes[28] > 1) {
    return { ok: false, reason: "The signature image is not a valid PNG. Draw or type your signature again." };
  }
  if (width < 1 || height < 1) {
    return { ok: false, reason: "The signature image is empty. Draw or type your signature again." };
  }
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) {
    return {
      ok: false,
      reason: `The signature image is too large (${width} x ${height} pixels). Draw your signature again, or use a smaller image.`,
    };
  }
  const end = pngEnd(bytes, view, { width, height, bitDepth, colorType, interlaced: bytes[28] === 1 });
  if (typeof end === "string") return { ok: false, reason: end };
  // Anything after the end marker is not part of the image and is not stored or embedded.
  return { ok: true, bytes: end === bytes.length ? bytes : bytes.slice(0, end), width, height };
}

const DAMAGED = "The signature image is damaged. Draw or type your signature again.";

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlaced: boolean;
}

/** Bytes of filtered pixel data a well-formed image of this shape inflates to. */
function expectedPixelBytes(h: PngHeader): number {
  const channels = [1, 0, 3, 1, 2, 0, 4][h.colorType];
  const rows = (w: number, rowsCount: number) => (w > 0 && rowsCount > 0 ? rowsCount * (1 + Math.ceil((w * channels * h.bitDepth) / 8)) : 0);
  if (!h.interlaced) return rows(h.width, h.height);
  // Adam7: seven reduced images, each with its own scanlines.
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  return passes.reduce(
    (sum, [x0, y0, dx, dy]) => sum + rows(Math.ceil((h.width - x0) / dx), Math.ceil((h.height - y0) / dy)),
    0,
  );
}

/**
 * Walks the whole file and returns the offset just past its end marker, or a
 * reason it is unusable. The PNG decoder inside pdf-lib does no validation of
 * its own and can spin forever on a truncated or doctored file, so nothing is
 * handed to it that has not been checked chunk by chunk, checksum by checksum,
 * down to the pixel data inflating to exactly the size the header promises.
 */
function pngEnd(bytes: Uint8Array, view: DataView, header: PngHeader): number | string {
  const depthsByType: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depthsByType[header.colorType]?.includes(header.bitDepth)) return DAMAGED;
  const data: Uint8Array[] = [];
  let hasPalette = false;
  let offset = 8;
  for (;;) {
    if (offset + 12 > bytes.length) return DAMAGED;
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) return DAMAGED;
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataStart = offset + 8;
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes, offset + 4, dataStart + length) !== view.getUint32(dataStart + length)) return DAMAGED;
    offset = dataStart + length + 4;
    if (type === "IHDR" && dataStart !== 16) return DAMAGED;
    if (type === "acTL") return "Animated images cannot be used as a signature. Draw or type your signature again.";
    if (type === "PLTE") hasPalette = length > 0 && length % 3 === 0;
    if (type === "IDAT") data.push(bytes.subarray(dataStart, dataStart + length));
    if (type === "IEND") break;
  }
  if (data.length === 0 || (header.colorType === 3 && !hasPalette)) return DAMAGED;
  const expected = expectedPixelBytes(header);
  try {
    // The output cap makes a deflate bomb fail fast instead of filling memory.
    const pixels = inflateSync(Buffer.concat(data), { maxOutputLength: expected + 1 });
    if (pixels.length !== expected) return DAMAGED;
  } catch {
    return DAMAGED;
  }
  return offset;
}

function tooLargeReason(): string {
  return `The signature image is larger than ${Math.round(LIMITS.maxSignatureBytes / 1024)} KB. Draw your signature again, or use a smaller image.`;
}

/* ------------------------------------------------------------------ text */

/** Pictographs, variation selectors, keycaps, flags and tag characters: decoration that can be dropped without losing meaning. */
function isDecoration(code: number): boolean {
  return (
    (code >= 0x1f000 && code <= 0x1faff) ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0x2b00 && code <= 0x2bff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0000 && code <= 0xe007f) ||
    (code >= 0x0300 && code <= 0x036f) ||
    code === 0x20e3 ||
    code === 0x200d
  );
}

const charSets = new WeakMap<PDFFont, Set<number>>();

function has(font: PDFFont, code: number): boolean {
  let set = charSets.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    charSets.set(font, set);
  }
  return set.has(code);
}

/**
 * Turns arbitrary input into a single line the font can draw. Characters the
 * font lacks are first folded to a compatible form (full-width Latin, ligatures,
 * circled digits), emoji and stray combining marks are dropped, and anything
 * still missing (CJK, Arabic, ...) becomes a hollow box so the reader can see a
 * character was there rather than silently losing it.
 */
export function drawableText(font: PDFFont, input: unknown, maxChars: number = LIMITS.maxTextFieldLength): string {
  if (typeof input !== "string" && typeof input !== "number") return "";
  // Cut in UTF-16 units first so a multi-megabyte string is never expanded into an array.
  const clipped = Array.from(String(input).slice(0, maxChars * 2)).slice(0, maxChars).join("");
  const missing = has(font, 0x25a1) ? "\u25a1" : "?";
  let out = "";
  for (const ch of clipped.replace(/[\r\n\u2028\u2029\t\u00a0]+/g, " ").normalize("NFC")) {
    const code = ch.codePointAt(0)!;
    if (code === 0x20 || has(font, code)) out += ch;
    else if (code < 0x20 || code === 0x7f || isDecoration(code)) continue;
    else {
      const folded = Array.from(ch.normalize("NFKC"));
      if (folded.length > 0 && folded.every((f) => f === " " || has(font, f.codePointAt(0)!))) out += folded.join("");
      else out += missing;
    }
  }
  return safeText(font, out, "?").replace(/ {2,}/g, " ").trim();
}

function widthOf(font: PDFFont, text: string, size: number): number {
  try {
    return font.widthOfTextAtSize(text, size);
  } catch {
    // Only reachable if the font's own tables are inconsistent; an over-wide answer makes callers truncate.
    return Number.POSITIVE_INFINITY;
  }
}

/** Longest prefix of the text that fits the width with an ellipsis appended; "" when not even the ellipsis fits. */
export function truncateToWidth(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (widthOf(font, text, size) <= maxWidth) return text;
  const chars = Array.from(text);
  const ellipsis = has(font, 0x2026) ? ELLIPSIS : "...";
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = chars.slice(0, mid).join("").trimEnd() + ellipsis;
    if (widthOf(font, candidate, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) return widthOf(font, ellipsis, size) <= maxWidth ? ellipsis : "";
  return chars.slice(0, lo).join("").trimEnd() + ellipsis;
}

/**
 * Greedy word wrap. Words wider than the line (emails, URLs, hashes) are broken
 * by character so nothing can overflow. When `maxLines` cuts the text short the
 * last line ends in an ellipsis.
 */
export function wrapText(font: PDFFont, text: string, size: number, maxWidth: number, maxLines = Number.POSITIVE_INFINITY): string[] {
  if (!(maxWidth > 0) || !(maxLines >= 1)) return [];
  const lines: string[] = [];
  let line = "";
  let cut = false;

  const push = (value: string): boolean => {
    if (lines.length >= maxLines) {
      cut = true;
      return false;
    }
    lines.push(value);
    return true;
  };

  outer: for (const word of text.split(" ")) {
    if (word === "") continue;
    const joined = line ? `${line} ${word}` : word;
    if (widthOf(font, joined, size) <= maxWidth) {
      line = joined;
      continue;
    }
    if (line) {
      if (!push(line)) break outer;
      line = "";
    }
    if (widthOf(font, word, size) <= maxWidth) {
      line = word;
      continue;
    }
    let piece = "";
    for (const ch of Array.from(word)) {
      if (piece && widthOf(font, piece + ch, size) > maxWidth) {
        if (!push(piece)) break outer;
        piece = ch;
      } else piece += ch;
    }
    line = piece;
  }
  if (!cut && line && !push(line)) cut = true;
  if (cut && lines.length > 0) {
    const last = lines.length - 1;
    const ellipsis = has(font, 0x2026) ? ELLIPSIS : "...";
    const chars = Array.from(lines[last]);
    while (chars.length > 0 && widthOf(font, chars.join("").trimEnd() + ellipsis, size) > maxWidth) chars.pop();
    lines[last] = chars.join("").trimEnd() + ellipsis;
  }
  return lines;
}

interface TextLayout {
  lines: string[];
  size: number;
  /** Baseline of the first line, measured up from the bottom of the box. */
  firstBaseline: number;
  padX: number;
}

function layoutText(font: PDFFont, text: string, width: number, height: number, maxSize: number): TextLayout | null {
  // Keep text off the box edge when there is room; in a narrow box every point counts.
  const padX = width >= 16 ? 2 : 0;
  const avail = width - padX * 2;
  if (!(avail >= 1) || !text) return null;

  const preferred = Math.min(maxSize, Math.max(MIN_FONT_SIZE, height * 0.72));
  const descent = (size: number) => font.heightAtSize(size) - font.heightAtSize(size, { descender: false });
  // The box usually sits on a printed line, so the baseline goes just above its bottom edge.
  const single = (line: string, size: number): TextLayout => ({
    lines: [line],
    size,
    firstBaseline: Math.min(descent(size), Math.max(0, height) * 0.3),
    padX,
  });

  const natural = widthOf(font, text, preferred);
  if (natural <= avail) return single(text, preferred);

  // A modest shrink keeps a slightly long name on its line, which is where the reader expects it.
  const shrunk = Math.floor(((preferred * avail) / natural) * 10) / 10;
  if (shrunk >= Math.max(MIN_FONT_SIZE, 8)) return single(text, shrunk);

  const linesThatFit = (size: number) => Math.floor(height / (size * LINE_HEIGHT));
  if (linesThatFit(MIN_FONT_SIZE) >= 2) {
    // A tall box (an address, a description): wrap, shrinking only as far as needed.
    for (let size = preferred; ; size = Math.max(MIN_FONT_SIZE, size - 0.5)) {
      const room = Math.max(1, linesThatFit(size));
      const atMinimum = size <= MIN_FONT_SIZE;
      const lines = wrapText(font, text, size, avail, atMinimum ? room : room + 1);
      if (lines.length > 0 && lines.length <= room) {
        if (lines.length === 1) return single(lines[0], size);
        return { lines, size, firstBaseline: height - font.heightAtSize(size, { descender: false }) - 1, padX };
      }
      if (atMinimum) break;
    }
  }

  const size = Math.max(MIN_FONT_SIZE, shrunk);
  const line = truncateToWidth(font, text, size, avail);
  return line ? single(line, size) : null;
}

/* --------------------------------------------------------------- drawing */

/** Point at (right, up) from the placement's corner, in the directions the reader sees. */
function localPoint(pl: PdfPlacement, right: number, up: number): { x: number; y: number } {
  const t = (pl.rotate * Math.PI) / 180;
  const cos = Math.round(Math.cos(t));
  const sin = Math.round(Math.sin(t));
  return { x: pl.x + right * cos - up * sin, y: pl.y + right * sin + up * cos };
}

function drawText(page: PDFPage, pl: PdfPlacement, font: PDFFont, value: string): void {
  // Font size is capped for ordinary pages but scales up on poster-sized ones, where 12pt would be unreadably small.
  const maxSize = MAX_FONT_SIZE * Math.max(1, displaySize(page).height / 1000);
  const layout = layoutText(font, value, pl.width, pl.height, maxSize);
  if (!layout) return;
  layout.lines.forEach((line, i) => {
    const at = localPoint(pl, layout.padX, layout.firstBaseline - i * layout.size * LINE_HEIGHT);
    page.drawText(line, { x: at.x, y: at.y, size: layout.size, font, color: INK, rotate: degrees(pl.rotate) });
  });
}

function drawImage(page: PDFPage, pl: PdfPlacement, image: PDFImage): void {
  if (!(pl.width >= 1) || !(pl.height >= 1) || !(image.width > 0) || !(image.height > 0)) return;
  const scale = Math.min(pl.width / image.width, pl.height / image.height);
  page.drawImage(image, {
    x: pl.x,
    y: pl.y,
    width: image.width * scale,
    height: image.height * scale,
    rotate: degrees(pl.rotate),
  });
}

function drawCheck(page: PDFPage, pl: PdfPlacement): void {
  const side = Math.min(pl.width, pl.height);
  if (!(side >= 1)) return;
  const left = (pl.width - side) / 2;
  const bottom = (pl.height - side) / 2;
  const point = (fx: number, fy: number) => localPoint(pl, left + fx * side, bottom + fy * side);
  const thickness = Math.max(0.6, side * 0.12);
  const [a, b, c] = [point(0.2, 0.5), point(0.42, 0.24), point(0.82, 0.8)];
  page.drawLine({ start: a, end: b, thickness, color: INK, lineCap: LineCapStyle.Round });
  page.drawLine({ start: b, end: c, thickness, color: INK, lineCap: LineCapStyle.Round });
}

function ownValue(values: FieldValues, id: unknown): unknown {
  if (typeof id !== "string" || !values || typeof values !== "object") return undefined;
  return Object.prototype.hasOwnProperty.call(values, id) ? (values as Record<string, unknown>)[id] : undefined;
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === false || (typeof value === "string" && value.trim() === "");
}

/**
 * Draws values onto an already loaded document. Shared by previews and sealing
 * so the sealed PDF is drawn by exactly the code the signer previewed.
 * Returns how many fields were drawn.
 */
export async function stampInto(
  doc: PDFDocument,
  fields: readonly Field[],
  values: FieldValues,
  font?: PDFFont,
): Promise<number> {
  const pages = doc.getPages();
  const images = new Map<string, PDFImage | null>();
  let textFont = font;
  let drawn = 0;

  for (const field of Array.isArray(fields) ? fields : []) {
    try {
      if (!field || typeof field !== "object") continue;
      const value = ownValue(values, field.id);
      if (isBlank(value)) continue;
      if (!Number.isInteger(field.page) || field.page < 0 || field.page >= pages.length) continue;
      const page = pages[field.page];
      const pl = fracRectToPdf(page, { x: field.x, y: field.y, w: field.w, h: field.h });
      if (![pl.x, pl.y, pl.width, pl.height].every(Number.isFinite)) continue;

      if (field.type === "checkbox") {
        if (value === true || value === "true") {
          drawCheck(page, pl);
          drawn++;
        }
        continue;
      }

      if (IMAGE_FIELD_TYPES.includes(field.type)) {
        if (typeof value !== "string") continue;
        // The same signature is usually applied to several fields; embed it once.
        let image = images.get(value);
        if (image === undefined) {
          const parsed = parseImageDataUrl(value);
          image = parsed.ok ? await doc.embedPng(parsed.bytes).catch(() => null) : null;
          images.set(value, image);
        }
        if (image) {
          drawImage(page, pl, image);
          drawn++;
        }
        continue;
      }

      if (typeof value !== "string" && typeof value !== "number") continue;
      if (!textFont) textFont = (await embedFonts(doc, ["regular"])).regular;
      const text = drawableText(textFont, value);
      if (!text) continue;
      drawText(page, pl, textFont, text);
      drawn++;
    } catch {
      // One undrawable field must not cost the signer the whole document.
      continue;
    }
  }
  return drawn;
}

/** Loads a PDF for modification, turning parser failures into an error the uploader can act on. */
export async function loadForStamping(pdf: Uint8Array): Promise<PDFDocument> {
  if (!(pdf instanceof Uint8Array) || pdf.length === 0) {
    throw new DocumentError("empty", "The agreement file is empty. Upload the agreement again.");
  }
  try {
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    // The parser is lenient enough to "load" a file with no page tree; touching the pages is what proves it usable.
    if (doc.getPages().length === 0) throw new Error("no pages");
    return doc;
  } catch (error) {
    if (/encrypt/i.test(error instanceof Error ? error.message : "")) {
      throw new DocumentError(
        "password_protected",
        "The agreement PDF is password protected. Remove the password and upload it again.",
      );
    }
    throw new DocumentError("corrupt", "The agreement PDF could not be read. Upload the agreement again.");
  }
}

export async function savePdf(doc: PDFDocument): Promise<Uint8Array> {
  try {
    return await doc.save();
  } catch (error) {
    throw unusable(error);
  }
}

/**
 * Wraps a failure from deep inside the PDF library. Callers only ever have to
 * handle DocumentError; the original error rides along as `cause` for the logs.
 */
export function unusable(error: unknown): DocumentError {
  if (error instanceof DocumentError) return error;
  const wrapped = new DocumentError(
    "corrupt",
    "The agreement PDF has a structure that could not be written to. Re-save or re-export it as a PDF and upload it again.",
  );
  (wrapped as Error & { cause?: unknown }).cause = error;
  return wrapped;
}

/**
 * Returns a copy of the PDF with every supplied value drawn inside its field.
 * Fields without a value, with an undrawable value, or on a page that does not
 * exist are skipped. The input bytes are never modified.
 */
export async function stampFields(pdf: Uint8Array, fields: Field[], values: FieldValues): Promise<Uint8Array> {
  const doc = await loadForStamping(pdf);
  let drawn: number;
  try {
    drawn = await stampInto(doc, fields, values);
  } catch (error) {
    throw unusable(error);
  }
  // Nothing drawn: hand back the document byte for byte rather than a re-serialized variant.
  if (drawn === 0) return pdf.slice();
  return savePdf(doc);
}
