/**
 * Appends a signature page. This is the guarantee behind "any agreement can be
 * signed": when a document has no recognizable place to sign (a scan, a letter,
 * a page of terms), the parties sign on a page that names the agreement instead.
 */
import { rgb, type PDFDocument, type PDFFont, type PDFPage } from "pdf-lib";
import type { Field, FieldRole, FieldType, PageInfo } from "@/lib/types";
import { newId } from "@/lib/ids";
import { embedFonts, safeText } from "./fonts";
import { displaySize } from "./geometry";
import { getPages, loadPdf } from "./pages";

export interface AppendSignaturePageOptions {
  /** Printed above the company's block. */
  companyName?: string;
  /** Add a block for the company's countersignature. */
  includeCompany: boolean;
  /** Named in the sentence that ties this page to the agreement. */
  agreementTitle?: string;
}

const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.38, 0.4, 0.45);
const LETTER: PageInfo = { width: 612, height: 792 };

function fitText(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}...`, size) > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}...`;
}

function wrap(font: PDFFont, text: string, size: number, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth || !current) current = next;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  const kept = lines.slice(0, maxLines).map((line) => fitText(font, line, size, maxWidth));
  if (lines.length > maxLines) kept[maxLines - 1] = fitText(font, `${kept[maxLines - 1]} ...`, size, maxWidth);
  return kept;
}

interface Row {
  type: FieldType;
  caption: string;
  label: string;
  required: boolean;
}

function rowsFor(role: "client" | "company"): Row[] {
  if (role === "client") {
    return [
      { type: "signature", caption: "Signature", label: "Client signature", required: true },
      { type: "full_name", caption: "Printed name", label: "Client name", required: true },
      { type: "date_signed", caption: "Date", label: "Client signing date", required: true },
    ];
  }
  return [
    { type: "signature", caption: "Signature", label: "Company signature", required: true },
    { type: "full_name", caption: "Printed name", label: "Company signer name", required: true },
    { type: "title", caption: "Title", label: "Company signer title", required: false },
    { type: "date_signed", caption: "Date", label: "Company signing date", required: true },
  ];
}

/** Draws one page and returns its fields. Shared with callers that already hold a loaded document. */
export async function drawSignaturePage(
  doc: PDFDocument,
  opts: AppendSignaturePageOptions,
): Promise<{ page: PDFPage; pageIndex: number; fields: Field[] }> {
  const existing = doc.getPages();
  let size = existing.length ? displaySize(existing[existing.length - 1]) : LETTER;
  // A sliver of a page or a poster cannot hold a legible signature block.
  if (!(size.width >= 280 && size.height >= 360 && size.width <= 3000 && size.height <= 4000)) size = LETTER;

  const fonts = await embedFonts(doc, ["regular", "bold"]);
  const page = doc.addPage([size.width, size.height]);
  const pageIndex = doc.getPageCount() - 1;
  const blocks: ("client" | "company")[] = opts.includeCompany ? ["client", "company"] : ["client"];

  // Everything scales from a design made for Letter so small pages (A5, half letter) still fit two blocks.
  const scale = Math.max(0.5, Math.min(1.3, size.width / 612, size.height / (blocks.length > 1 ? 792 : 560)));
  const margin = Math.min(72 * scale, size.width * 0.14);
  const contentWidth = size.width - margin * 2;
  const fields: Field[] = [];
  let top = margin; // distance from the top of the page

  const text = (value: string, font: PDFFont, fontSize: number, color = INK, x = margin) => {
    page.drawText(value, { x, y: size.height - top - fontSize, size: fontSize, font, color });
  };

  text("Signature page", fonts.bold, 18 * scale);
  top += 18 * scale + 12 * scale;

  const title = safeText(fonts.regular, (opts.agreementTitle ?? "").trim()).slice(0, 160);
  const sentence = title
    ? `This page is part of the agreement titled "${title}". By signing below, each party agrees to the agreement in full.`
    : "This page is part of the agreement it is attached to. By signing below, each party agrees to the agreement in full.";
  for (const line of wrap(fonts.regular, sentence, 10.5 * scale, contentWidth, 5)) {
    text(line, fonts.regular, 10.5 * scale, MUTED);
    top += 15 * scale;
  }
  top += 14 * scale;

  const lineWidth = Math.min(contentWidth, 280 * scale);
  for (const role of blocks) {
    const fallbackName = role === "client" ? "Client" : "Company";
    const named = role === "company" ? safeText(fonts.bold, (opts.companyName ?? "").trim()) : "";
    const heading = fitText(fonts.bold, named || fallbackName, 12 * scale, contentWidth);
    text(heading, fonts.bold, 12 * scale);
    top += 12 * scale + 6 * scale;

    for (const row of rowsFor(role)) {
      const boxHeight = (row.type === "signature" ? 40 : 20) * scale;
      top += boxHeight + 6 * scale;
      const lineY = top; // from the top
      page.drawLine({
        start: { x: margin, y: size.height - lineY },
        end: { x: margin + lineWidth, y: size.height - lineY },
        thickness: 0.75,
        color: INK,
      });
      fields.push({
        id: newId("fld"),
        page: pageIndex,
        x: margin / size.width,
        y: (lineY - boxHeight - 1) / size.height,
        w: lineWidth / size.width,
        h: boxHeight / size.height,
        type: row.type,
        role: role as FieldRole,
        required: row.required,
        label: row.label,
        source: "appended",
        confidence: 1,
      });
      top += 3 * scale;
      text(row.caption, fonts.regular, 8.5 * scale, MUTED);
      top += 8.5 * scale + 4 * scale;
    }
    top += 18 * scale;
  }
  return { page, pageIndex, fields };
}

/**
 * Adds a page the size of the document's last page, titled "Signature page",
 * with a block for the client and optionally one for the company.
 * Throws only when the bytes are not a PDF pdf-lib can open.
 */
export async function appendSignaturePage(
  pdf: Uint8Array,
  opts: AppendSignaturePageOptions,
): Promise<{ pdf: Uint8Array; pages: PageInfo[]; fields: Field[] }> {
  const doc = await loadPdf(pdf);
  const { fields } = await drawSignaturePage(doc, opts);
  const pages = await getPages(doc);
  const bytes = await doc.save();
  return { pdf: bytes, pages, fields };
}
