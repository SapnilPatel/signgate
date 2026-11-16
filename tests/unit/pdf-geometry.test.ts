import { describe, it, expect } from "vitest";
import { PDFDocument, degrees } from "pdf-lib";
import type { PDFPage } from "pdf-lib";
import { getDocumentProxy } from "unpdf";
import { clampRect, displaySize, fracRectToPdf, pageRotation, pdfRectToFrac, visibleBox } from "@/lib/pdf/geometry";

const ROTATIONS = [0, 90, 180, 270] as const;
const RECT = { x: 0.15, y: 0.62, w: 0.4, h: 0.05 };

async function makePage(rotation: number, crop?: [number, number, number, number]): Promise<{ doc: PDFDocument; page: PDFPage }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.setRotation(degrees(rotation));
  if (crop) page.setCropBox(...crop);
  return { doc, page };
}

/** The four corners of a placement in PDF user space, in display order: bottom-left, bottom-right, top-left. */
function corners(pl: ReturnType<typeof fracRectToPdf>) {
  const t = (pl.rotate * Math.PI) / 180;
  const at = (right: number, up: number) => ({
    x: pl.x + right * Math.cos(t) - up * Math.sin(t),
    y: pl.y + right * Math.sin(t) + up * Math.cos(t),
  });
  return { bottomLeft: at(0, 0), bottomRight: at(pl.width, 0), topLeft: at(0, pl.height), topRight: at(pl.width, pl.height) };
}

describe("geometry", () => {
  for (const crop of [undefined, [40, 70, 420, 510]] as const) {
    for (const rotation of ROTATIONS) {
      const name = `rotation ${rotation}${crop ? " with an offset crop box" : ""}`;

      it(`round-trips a rectangle: ${name}`, async () => {
        const { page } = await makePage(rotation, crop as [number, number, number, number] | undefined);
        const c = corners(fracRectToPdf(page, RECT));
        const back = pdfRectToFrac(page, c.bottomLeft.x, c.bottomLeft.y, c.topRight.x, c.topRight.y);
        expect(back.x).toBeCloseTo(RECT.x, 6);
        expect(back.y).toBeCloseTo(RECT.y, 6);
        expect(back.w).toBeCloseTo(RECT.w, 6);
        expect(back.h).toBeCloseTo(RECT.h, 6);
        // Opposite corners in the other order describe the same rectangle.
        const swapped = pdfRectToFrac(page, c.topLeft.x, c.topLeft.y, c.bottomRight.x, c.bottomRight.y);
        expect(swapped.x).toBeCloseTo(RECT.x, 6);
        expect(swapped.h).toBeCloseTo(RECT.h, 6);
      });

      // pdf.js is the renderer the field editor uses, so it is the independent judge of where a point is displayed.
      it(`agrees with the pdf.js viewport: ${name}`, async () => {
        const { doc, page } = await makePage(rotation, crop as [number, number, number, number] | undefined);
        const pl = fracRectToPdf(page, RECT);
        const c = corners(pl);
        const size = displaySize(page);
        const proxy = await getDocumentProxy(await doc.save());
        const viewport = (await proxy.getPage(1)).getViewport({ scale: 1 });
        expect(viewport.width).toBeCloseTo(size.width, 3);
        expect(viewport.height).toBeCloseTo(size.height, 3);
        const [blU, blV] = viewport.convertToViewportPoint(c.bottomLeft.x, c.bottomLeft.y);
        expect(blU).toBeCloseTo(RECT.x * size.width, 3);
        expect(blV).toBeCloseTo((RECT.y + RECT.h) * size.height, 3);
        const [trU, trV] = viewport.convertToViewportPoint(c.topRight.x, c.topRight.y);
        expect(trU).toBeCloseTo((RECT.x + RECT.w) * size.width, 3);
        expect(trV).toBeCloseTo(RECT.y * size.height, 3);
      });
    }
  }

  it("reports the displayed size, swapping sides for sideways pages", async () => {
    expect(displaySize((await makePage(0)).page)).toEqual({ width: 612, height: 792 });
    expect(displaySize((await makePage(90)).page)).toEqual({ width: 792, height: 612 });
    expect(displaySize((await makePage(270, [40, 70, 420, 510])).page)).toEqual({ width: 510, height: 420 });
  });

  it("normalizes odd rotation values", async () => {
    for (const [raw, expected] of [[-90, 270], [450, 90], [360, 0], [-180, 180], [720, 0]] as const) {
      expect(pageRotation((await makePage(raw)).page)).toBe(expected);
    }
  });

  it("falls back to the media box for a degenerate crop box and normalizes negative extents", async () => {
    const { page } = await makePage(0);
    page.setCropBox(10, 10, 0, 0);
    expect(visibleBox(page)).toEqual({ x: 0, y: 0, width: 612, height: 792 });
    page.setCropBox(500, 600, -400, -500);
    expect(visibleBox(page)).toEqual({ x: 100, y: 100, width: 400, height: 500 });
  });

  it("clips a crop box that extends past the media box, as pdf.js does", async () => {
    const { doc, page } = await makePage(90);
    page.setCropBox(-50, 300, 400, 900);
    expect(visibleBox(page)).toEqual({ x: 0, y: 300, width: 350, height: 492 });
    const size = displaySize(page);
    const viewport = (await (await getDocumentProxy(await doc.save())).getPage(1)).getViewport({ scale: 1 });
    expect(viewport.width).toBeCloseTo(size.width, 3);
    expect(viewport.height).toBeCloseTo(size.height, 3);
  });

  it("clamps rectangles onto the page and survives non-finite input", async () => {
    expect(clampRect({ x: 0.9, y: 0.95, w: 0.5, h: 0.2 })).toEqual({ x: 0.5, y: 0.8, w: 0.5, h: 0.2 });
    expect(clampRect({ x: -3, y: Number.NaN, w: 7, h: Number.POSITIVE_INFINITY })).toEqual({ x: 0, y: 0, w: 1, h: 0 });
    const { page } = await makePage(90);
    const pl = fracRectToPdf(page, { x: Number.NaN, y: -1, w: Number.NaN, h: 2 });
    for (const n of [pl.x, pl.y, pl.width, pl.height]) expect(Number.isFinite(n)).toBe(true);
  });
});
