/**
 * Produces the final signed record: the agreement with every value drawn on it,
 * an envelope reference on each page, and the signing certificate appended.
 * The returned SHA-256 is what the verify page later compares against.
 */
import { degrees, rgb } from "pdf-lib";
import type { PDFDocument, PDFFont, PDFPage } from "pdf-lib";
import { sha256Hex } from "@/lib/ids";
import { PRODUCT_NAME } from "@/lib/env";
import type { SealInput, SealResult, SealWarning } from "./types";
import { displaySize, fracRectToPdf } from "./geometry";
import type { Field } from "@/lib/types";
import { embedFonts } from "./fonts";
import { extractLayout } from "./text";
import { drawableText, loadForStamping, savePdf, stampInto, truncateToWidth, unusable } from "./stamp";
import { appendCertificate } from "./certificate";

const FOOTER_GREY = rgb(0.55, 0.57, 0.6);
/** Distance from the displayed left and right page edges: inside most printers' printable area. */
const FOOTER_INSET_X = 24;
/** Clear space kept between the mark and anything the agreement prints: beside it, and above or below it. */
const FOOTER_CLEARANCE_X = 3;
const FOOTER_CLEARANCE_Y = 0.75;
/** Reading the text layer is only for choosing a free spot; a slow file gets the default spot instead. */
const OBSTACLE_TIMEOUT_MS = 5000;

/** Something already printed on a page, in display points from the top-left. */
interface Obstacle {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
}

interface Spot {
  /** Baseline distance from the nearest horizontal page edge. */
  inset: number;
  size: number;
  edge: "bottom" | "top";
  align: "left" | "right";
}

/**
 * Where the mark may go, best first. Word processors and browsers print footers with their
 * baseline 14 to 36 pt above the page edge, so the first choice sits in the strip below that.
 * When the agreement prints something there too, the mark moves to a corner that is free.
 */
const SPOTS: Spot[] = [
  { inset: 6, size: 5, edge: "bottom", align: "left" },
  { inset: 6, size: 5, edge: "bottom", align: "right" },
  { inset: 12, size: 5, edge: "top", align: "left" },
  { inset: 12, size: 5, edge: "top", align: "right" },
];

/** What each page already prints, so the envelope mark can stay clear of it. Empty when the text cannot be read. */
async function pageObstacles(pdf: Uint8Array, fields: Field[], pages: PDFPage[]): Promise<Obstacle[][]> {
  const out: Obstacle[][] = pages.map(() => []);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const layout = await Promise.race([
      extractLayout(pdf),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), OBSTACLE_TIMEOUT_MS);
      }),
    ]);
    if (layout && layout.pages.length === pages.length) {
      for (const run of layout.runs) {
        if (!out[run.page] || !run.text.trim()) continue;
        out[run.page].push({ x0: run.x, x1: run.x + run.width, top: run.baseline - run.size * 0.8, bottom: run.baseline + run.size * 0.22 });
      }
      for (const rule of layout.rules) out[rule.page]?.push({ x0: rule.x0, x1: rule.x1, top: rule.y - 1, bottom: rule.y + 1 });
    }
  } catch {
    // Without the text layer the mark goes in its default spot.
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Values stamped into fields are part of the page too.
  for (const field of Array.isArray(fields) ? fields : []) {
    if (!field || !out[field.page]) continue;
    try {
      const size = displaySize(pages[field.page]);
      const box = { x0: field.x * size.width, x1: (field.x + field.w) * size.width, top: field.y * size.height, bottom: (field.y + field.h) * size.height };
      if (Object.values(box).every(Number.isFinite)) out[field.page].push(box);
    } catch {
      // an unusable page gets no mark anyway
    }
  }
  return out;
}

/**
 * Ties each page to its envelope so a page separated from the certificate can
 * still be traced. Kept tiny, grey and in the margin, and moved to a free corner
 * when the agreement prints its own footer where the mark would go, so it cannot
 * be mistaken for, or cover, the agreement's own content.
 */
function drawEnvelopeFooter(page: PDFPage, font: PDFFont, envelopeId: string, obstacles: Obstacle[]): void {
  const size = displaySize(page);
  if (!(size.width > FOOTER_INSET_X * 3) || !(size.height > 48)) return;
  const placed = (spot: Spot) => {
    const text = truncateToWidth(font, `Envelope ${envelopeId}`, spot.size, size.width - FOOTER_INSET_X * 2);
    const width = text ? font.widthOfTextAtSize(text, spot.size) : 0;
    const x0 = spot.align === "left" ? FOOTER_INSET_X : size.width - FOOTER_INSET_X - width;
    const baseline = spot.edge === "bottom" ? size.height - spot.inset : spot.inset;
    return { text, size: spot.size, x0, x1: x0 + width, top: baseline - spot.size, bottom: baseline + spot.size * 0.25 };
  };
  const free = (m: ReturnType<typeof placed>) =>
    !obstacles.some((o) => o.x1 > m.x0 - FOOTER_CLEARANCE_X && o.x0 < m.x1 + FOOTER_CLEARANCE_X && o.bottom > m.top - FOOTER_CLEARANCE_Y && o.top < m.bottom + FOOTER_CLEARANCE_Y);
  const options = SPOTS.map(placed);
  const mark = options.find(free) ?? options[0];
  if (!mark.text) return;
  const at = fracRectToPdf(page, {
    x: mark.x0 / size.width,
    y: mark.top / size.height,
    w: (mark.x1 - mark.x0) / size.width,
    h: mark.size / size.height,
  });
  page.drawText(mark.text, { x: at.x, y: at.y, size: mark.size, font, color: FOOTER_GREY, rotate: degrees(at.rotate) });
}

export async function sealDocument(input: SealInput): Promise<SealResult> {
  const doc = await loadForStamping(input?.pdf);
  try {
    return await seal(doc, input);
  } catch (error) {
    throw unusable(error);
  }
}

async function seal(doc: PDFDocument, input: SealInput): Promise<SealResult> {
  const fonts = await embedFonts(doc, ["regular", "bold"]);
  const certificate = input.certificate;
  const envelopeId = drawableText(fonts.regular, certificate?.envelopeId, 200);

  // Captured before the certificate is appended: only the agreement's own pages get the envelope reference.
  const originalPages = doc.getPages();
  const obstacles = await pageObstacles(input.pdf, input.fields, originalPages);
  const report = await stampInto(doc, input.fields, input.values, fonts.regular);
  const warnings: SealWarning[] = [];
  const named = (label: string) => (label ? `"${label}"` : "A field");
  for (const r of report.replaced) {
    warnings.push({
      code: "characters_replaced",
      fieldId: r.fieldId,
      message: `${named(r.label)} contains ${r.characters === 1 ? "a character" : `${r.characters} characters`} that the signed PDF cannot print (for example Chinese, Japanese, Korean, Arabic or Hebrew script). ${r.characters === 1 ? "It appears as an empty box" : "They appear as empty boxes"} on the agreement; the value as entered is kept in the signing record.`,
    });
  }
  for (const r of report.skippedImages) {
    warnings.push({
      code: "image_skipped",
      fieldId: r.fieldId,
      message: `${named(r.label)} was left empty on the signed PDF because the agreement was given too many different signature images. Ask the signer to sign again using one signature and one set of initials.`,
    });
  }
  for (const [index, page] of originalPages.entries()) {
    try {
      drawEnvelopeFooter(page, fonts.regular, envelopeId, obstacles[index] ?? []);
    } catch {
      // A page with an unusable box loses its footer, not the whole seal.
    }
  }

  for (const where of await appendCertificate(doc, certificate, fonts)) {
    warnings.push({
      code: "characters_replaced",
      message: `${where} on the signing certificate contains characters that the PDF cannot print. They appear as empty boxes followed by their Unicode code points, so the original text can still be recovered.`,
    });
  }

  const completedAt =
    certificate?.completedAt instanceof Date && !Number.isNaN(certificate.completedAt.getTime()) ? certificate.completedAt : new Date();
  // Metadata strings are stored as UTF-16, so they keep the original characters even where the page font cannot draw them.
  const meta = (value: unknown) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300) : "");
  const rawEnvelopeId = meta(certificate?.envelopeId);
  doc.setTitle(meta(certificate?.agreementName) || "Signed agreement");
  doc.setSubject(`Signed agreement${meta(certificate?.fileReference) ? ` for file ${meta(certificate.fileReference)}` : ""}`);
  doc.setAuthor(meta(certificate?.orgName));
  doc.setKeywords([`envelope:${rawEnvelopeId}`, "signed", "signing-certificate"]);
  doc.setProducer(PRODUCT_NAME);
  doc.setCreator(PRODUCT_NAME);
  doc.setModificationDate(completedAt);

  const pdf = await savePdf(doc);
  return { pdf, sha256: sha256Hex(pdf), warnings };
}
