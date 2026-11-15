/**
 * The one place that converts between "display space" (what a person sees and what
 * Field geometry uses: fractions of the displayed page, origin top-left) and PDF
 * user space (points, origin bottom-left, before the page's /Rotate is applied).
 */
import type { PDFPage } from "pdf-lib";
import type { PageInfo } from "@/lib/types";

export interface FracRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where and how to draw so content lands upright inside a display rectangle. */
export interface PdfPlacement {
  /** PDF user-space point of the rectangle's displayed bottom-left corner. */
  x: number;
  y: number;
  /** Size of the rectangle in points, measured along the displayed axes. */
  width: number;
  height: number;
  /** Counter-clockwise rotation in degrees to pass to pdf-lib draw calls. */
  rotate: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Page rotation normalized to 0, 90, 180 or 270 (clockwise, as in the PDF spec). */
export function pageRotation(page: PDFPage): 0 | 90 | 180 | 270 {
  const raw = page.getRotation().angle;
  const snapped = Math.round((Number.isFinite(raw) ? raw : 0) / 90) * 90;
  return ((((snapped % 360) + 360) % 360) as 0 | 90 | 180 | 270);
}

/** The visible region of the page in user space. Falls back to the media box for malformed crop boxes. */
export function visibleBox(page: PDFPage): Box {
  const media = page.getMediaBox();
  let box: Box = media;
  try {
    const crop = page.getCropBox();
    if (crop.width > 1 && crop.height > 1) box = crop;
  } catch {
    // keep media box
  }
  // Boxes may be written with negative extents; normalize to a positive rectangle.
  const x = Math.min(box.x, box.x + box.width);
  const y = Math.min(box.y, box.y + box.height);
  return { x, y, width: Math.abs(box.width), height: Math.abs(box.height) };
}

/** Size of the page as displayed, in points. */
export function displaySize(page: PDFPage): PageInfo {
  const box = visibleBox(page);
  const sideways = pageRotation(page) % 180 !== 0;
  return sideways ? { width: box.height, height: box.width } : { width: box.width, height: box.height };
}

/** Display point (points from the displayed top-left) -> PDF user space. */
function displayToPdf(box: Box, rotation: number, u: number, v: number): { x: number; y: number } {
  switch (rotation) {
    case 90:
      return { x: box.x + v, y: box.y + u };
    case 180:
      return { x: box.x + box.width - u, y: box.y + v };
    case 270:
      return { x: box.x + box.width - v, y: box.y + box.height - u };
    default:
      return { x: box.x + u, y: box.y + box.height - v };
  }
}

/** PDF user space -> display point (points from the displayed top-left). */
function pdfToDisplay(box: Box, rotation: number, x: number, y: number): { u: number; v: number } {
  switch (rotation) {
    case 90:
      return { u: y - box.y, v: x - box.x };
    case 180:
      return { u: box.x + box.width - x, v: y - box.y };
    case 270:
      return { u: box.y + box.height - y, v: box.x + box.width - x };
    default:
      return { u: x - box.x, v: box.y + box.height - y };
  }
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Clamp a fractional rectangle so it lies fully on the page. */
export function clampRect(rect: FracRect): FracRect {
  const w = Math.min(1, Math.max(0, Number.isFinite(rect.w) ? rect.w : 0));
  const h = Math.min(1, Math.max(0, Number.isFinite(rect.h) ? rect.h : 0));
  const x = Math.min(clamp01(rect.x), 1 - w);
  const y = Math.min(clamp01(rect.y), 1 - h);
  return { x, y, w, h };
}

/**
 * Converts a fractional display rectangle into a pdf-lib placement. Drawing an
 * image or text at (x, y) with the returned rotation fills the rectangle upright
 * as the reader sees the page, whatever the page's rotation or crop box.
 */
export function fracRectToPdf(page: PDFPage, rect: FracRect): PdfPlacement {
  const box = visibleBox(page);
  const rotation = pageRotation(page);
  const size = displaySize(page);
  const r = clampRect(rect);
  const width = r.w * size.width;
  const height = r.h * size.height;
  // Anchor at the rectangle's displayed bottom-left corner.
  const anchor = displayToPdf(box, rotation, r.x * size.width, r.y * size.height + height);
  return { x: anchor.x, y: anchor.y, width, height, rotate: rotation };
}

/**
 * Converts a rectangle in PDF user space (for example a form widget's /Rect:
 * any two opposite corners) into a fractional display rectangle.
 */
export function pdfRectToFrac(page: PDFPage, x1: number, y1: number, x2: number, y2: number): FracRect {
  const box = visibleBox(page);
  const rotation = pageRotation(page);
  const size = displaySize(page);
  const a = pdfToDisplay(box, rotation, x1, y1);
  const b = pdfToDisplay(box, rotation, x2, y2);
  const u = Math.min(a.u, b.u);
  const v = Math.min(a.v, b.v);
  return clampRect({
    x: u / size.width,
    y: v / size.height,
    w: Math.abs(a.u - b.u) / size.width,
    h: Math.abs(a.v - b.v) / size.height,
  });
}
