/**
 * Universal fallback for PDFs the server cannot open (most often files
 * "secured" with an owner password, which every viewer can display but which
 * cannot be modified). The browser renders each page to an image and the server
 * rebuilds a plain PDF from those images. Text is lost, so fields are then
 * placed by hand or on an appended signature page, but the agreement can
 * always be signed.
 */
import { LIMITS } from "@/lib/types";
import { openPdf } from "./pdfjs";

export interface PageImage {
  bytes: Uint8Array;
  widthPt: number;
  heightPt: number;
}

// About 150 dpi on Letter: sharp enough to read and sign, small enough to upload.
const TARGET_LONG_EDGE_PX = 1650;

export async function rasterizePdf(
  bytes: Uint8Array,
  onProgress?: (done: number, total: number) => void,
): Promise<PageImage[]> {
  const doc = await openPdf(bytes);
  try {
    if (doc.numPages > LIMITS.maxPages) {
      throw new Error(`This document has ${doc.numPages} pages. The limit is ${LIMITS.maxPages}.`);
    }
    const out: PageImage[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = TARGET_LONG_EDGE_PX / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("This browser cannot convert the document. Try a different browser.");
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
      if (!blob) throw new Error("This browser cannot convert the document. Try a different browser.");
      out.push({ bytes: new Uint8Array(await blob.arrayBuffer()), widthPt: base.width, heightPt: base.height });
      // Release the bitmap now; phones run out of canvas memory quickly.
      canvas.width = 0;
      canvas.height = 0;
      onProgress?.(i, doc.numPages);
    }
    return out;
  } finally {
    void doc.loadingTask.destroy();
  }
}
