/**
 * Produces the final signed record: the agreement with every value drawn on it,
 * an envelope reference on each page, and the signing certificate appended.
 * The returned SHA-256 is what the verify page later compares against.
 */
import { degrees, rgb } from "pdf-lib";
import type { PDFDocument, PDFFont, PDFPage } from "pdf-lib";
import { sha256Hex } from "@/lib/ids";
import { PRODUCT_NAME } from "@/lib/env";
import type { SealInput, SealResult } from "./types";
import { displaySize, fracRectToPdf } from "./geometry";
import { embedFonts } from "./fonts";
import { drawableText, loadForStamping, savePdf, stampInto, truncateToWidth, unusable } from "./stamp";
import { appendCertificate } from "./certificate";

const FOOTER_SIZE = 6;
const FOOTER_GREY = rgb(0.55, 0.57, 0.6);
/** Distance from the displayed page edges: inside most printers' printable area, below where body text and page numbers sit. */
const FOOTER_INSET_X = 24;
const FOOTER_INSET_Y = 12;

/**
 * Ties each page to its envelope so a page separated from the certificate can
 * still be traced. Kept tiny, grey and in the bottom margin so it cannot be
 * mistaken for, or cover, the agreement's own content.
 */
function drawEnvelopeFooter(page: PDFPage, font: PDFFont, envelopeId: string): void {
  const size = displaySize(page);
  if (!(size.width > FOOTER_INSET_X * 3) || !(size.height > FOOTER_INSET_Y * 4)) return;
  const text = truncateToWidth(font, `Envelope ${envelopeId}`, FOOTER_SIZE, size.width - FOOTER_INSET_X * 2);
  if (!text) return;
  const at = fracRectToPdf(page, {
    x: FOOTER_INSET_X / size.width,
    y: 1 - (FOOTER_INSET_Y + FOOTER_SIZE) / size.height,
    w: 1 - (FOOTER_INSET_X * 2) / size.width,
    h: FOOTER_SIZE / size.height,
  });
  page.drawText(text, { x: at.x, y: at.y, size: FOOTER_SIZE, font, color: FOOTER_GREY, rotate: degrees(at.rotate) });
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
  await stampInto(doc, input.fields, input.values, fonts.regular);
  for (const page of originalPages) {
    try {
      drawEnvelopeFooter(page, fonts.regular, envelopeId);
    } catch {
      // A page with an unusable box loses its footer, not the whole seal.
    }
  }

  await appendCertificate(doc, certificate, fonts);

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
  return { pdf, sha256: sha256Hex(pdf) };
}
