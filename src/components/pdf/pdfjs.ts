/**
 * Browser-side access to PDF.js. Loaded lazily so pages that never show a
 * document do not pay for it. Assets are served from /pdfjs (see
 * scripts/copy-pdf-assets.mjs).
 */
import type { PDFDocumentProxy } from "pdfjs-dist";

type PdfjsModule = typeof import("pdfjs-dist");

let modulePromise: Promise<PdfjsModule> | null = null;

export function loadPdfjs(): Promise<PdfjsModule> {
  if (!modulePromise) {
    modulePromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((mod) => {
      const pdfjs = mod as unknown as PdfjsModule;
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
      return pdfjs;
    });
    // A failed load (offline, blocked script) must be retryable.
    modulePromise.catch(() => {
      modulePromise = null;
    });
  }
  return modulePromise;
}

export type PdfSource = string | Uint8Array | ArrayBuffer;

/** Why a document could not be opened, in terms the interface can act on. */
export type PdfOpenFailure = "password" | "invalid" | "network";

export class PdfOpenError extends Error {
  constructor(
    public reason: PdfOpenFailure,
    message: string,
  ) {
    super(message);
    this.name = "PdfOpenError";
  }
}

/** Opens a PDF from a URL (same-origin, cookies sent) or from bytes. */
export async function openPdf(source: PdfSource): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfjs();
  const common = {
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/",
    iccUrl: "/pdfjs/iccs/",
    // Agreements are documents to read, never programs to run.
    isEvalSupported: false,
    enableXfa: false,
  };
  try {
    if (typeof source === "string") {
      return await pdfjs.getDocument({ ...common, url: source, withCredentials: true }).promise;
    }
    // PDF.js takes ownership of the buffer it is given; hand it a copy so the caller's bytes stay usable.
    const data = source instanceof Uint8Array ? source.slice() : new Uint8Array(source.slice(0));
    return await pdfjs.getDocument({ ...common, data }).promise;
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    if (name === "PasswordException") {
      throw new PdfOpenError("password", "This PDF needs a password to open. Remove the password and upload it again.");
    }
    if (name === "InvalidPDFException" || name === "FormatError") {
      throw new PdfOpenError("invalid", "This file could not be read as a PDF. It may be damaged; export it again and retry.");
    }
    throw new PdfOpenError("network", "The document could not be loaded. Check your connection and try again.");
  }
}
