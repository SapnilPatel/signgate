import { PDFDocument } from "pdf-lib";
import type { PageInfo } from "@/lib/types";
import { displaySize } from "./geometry";

/** Loads a PDF the engine itself produced or normalized. */
export function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { updateMetadata: false });
}

/** Displayed size of every page, in points. */
export async function getPages(pdf: Uint8Array | PDFDocument): Promise<PageInfo[]> {
  const doc = pdf instanceof PDFDocument ? pdf : await loadPdf(pdf);
  return doc.getPages().map((page) => displaySize(page));
}
