import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { extractLayout, extractText, groupLines } from "@/lib/pdf/text";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function simple() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.drawText("Service Agreement", { x: 60, y: 720, size: 20, font });
  page.drawText("Second line of the first page", { x: 60, y: 680, size: 10, font });
  const two = doc.addPage([600, 800]);
  two.drawText("Signature: ____________", { x: 300, y: 400, size: 10, font });
  return { bytes: new Uint8Array(await doc.save()), font };
}

describe("extractText", () => {
  it("returns text with positions as fractions of the displayed page, top-left origin", async () => {
    const { bytes, font } = await simple();
    const r = await extractText(bytes);
    expect(r.scanned).toBe(false);
    expect(r.pageText).toEqual(["Service Agreement\nSecond line of the first page", "Signature: ____________"]);
    const title = r.items.find((i) => i.text === "Service Agreement")!;
    expect(title.page).toBe(0);
    expect(title.x).toBeCloseTo(60 / 600, 3);
    // Baseline is 80pt from the top; the box starts one font size above it.
    expect(title.y).toBeCloseTo((80 - 20) / 800, 2);
    expect(title.h).toBeCloseTo(20 / 800, 2);
    expect(title.w).toBeCloseTo(font.widthOfTextAtSize("Service Agreement", 20) / 600, 2);
    const sig = r.items.find((i) => i.text.startsWith("Signature"))!;
    expect(sig.page).toBe(1);
    expect(sig.x).toBeCloseTo(0.5, 3);
    expect(sig.y + sig.h).toBeCloseTo(0.5, 2);
  });

  for (const rotation of [90, 180, 270] as const) {
    it(`reports display positions on a page rotated ${rotation} degrees`, async () => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const W = 500;
      const H = 300;
      const page = doc.addPage([W, H]);
      page.setRotation(degrees(rotation));
      const shown = rotation === 180 ? { width: W, height: H } : { width: H, height: W };
      // Text that reads upright for the viewer, 40pt from the left and 100pt from the top.
      const at = rotation === 90 ? { x: 100, y: 40 } : rotation === 180 ? { x: W - 40, y: 100 } : { x: W - 100, y: H - 40 };
      page.drawText("Upright", { ...at, size: 12, font, rotate: degrees(rotation) });
      // Text that is sideways for the viewer must not be offered as a label.
      page.drawText("Sideways", { x: 250, y: 150, size: 12, font, rotate: degrees(rotation + 90) });
      const layout = await extractLayout(new Uint8Array(await doc.save()));
      expect(layout.pages[0]).toEqual(shown);
      expect(layout.runs.map((r) => r.text)).toEqual(["Upright"]);
      expect(layout.runs[0].x).toBeCloseTo(40, 0);
      expect(layout.runs[0].baseline).toBeCloseTo(100, 0);
      expect(layout.items[0].x).toBeCloseTo(40 / shown.width, 2);
    });
  }

  it("honours a crop box with an offset origin and ignores text outside it", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([700, 900]);
    page.setCropBox(50, 100, 500, 700);
    page.drawText("Inside", { x: 150, y: 600, size: 10, font });
    page.drawText("Outside", { x: 10, y: 20, size: 10, font });
    const layout = await extractLayout(new Uint8Array(await doc.save()));
    expect(layout.pages[0]).toEqual({ width: 500, height: 700 });
    expect(layout.runs.map((r) => r.text)).toEqual(["Inside"]);
    expect(layout.runs[0].x).toBeCloseTo(100, 0);
    expect(layout.runs[0].baseline).toBeCloseTo(200, 0);
  });

  it("collects thin horizontal lines however they are drawn, and skips everything else", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([600, 800]);
    page.drawText("Sign on the line", { x: 60, y: 760, size: 10, font });
    page.drawLine({ start: { x: 60, y: 700 }, end: { x: 260, y: 700 }, thickness: 1 }); // stroked
    page.drawRectangle({ x: 300, y: 600, width: 180, height: 0.8, color: rgb(0, 0, 0) }); // thin filled box
    page.drawLine({ start: { x: 60, y: 500 }, end: { x: 260, y: 500 }, thickness: 1, color: rgb(1, 1, 1) }); // invisible
    page.drawLine({ start: { x: 400, y: 100 }, end: { x: 400, y: 300 }, thickness: 1 }); // vertical
    page.drawRectangle({ x: 60, y: 300, width: 200, height: 80, borderWidth: 1, borderColor: rgb(0, 0, 0) }); // a box
    page.drawLine({ start: { x: 60, y: 200 }, end: { x: 70, y: 200 }, thickness: 1 }); // too short
    const layout = await extractLayout(new Uint8Array(await doc.save()));
    const rules = layout.rules.map((r) => [Math.round(r.x0), Math.round(r.x1), Math.round(r.y)]);
    // The box's top and bottom edges are reported too, together with its sides, so the detector
    // can tell that they are borders of a cell and not lines to write on.
    expect(rules).toEqual([
      [60, 260, 100],
      [300, 480, 200],
      [60, 260, 420],
      [60, 260, 500],
    ]);
    const vertical = (layout.vrules ?? []).map((r) => [Math.round(r.x), Math.round(r.y0), Math.round(r.y1)]);
    expect(vertical).toEqual([
      [60, 420, 500],
      [260, 420, 500],
      [400, 500, 700],
    ]);
  });

  it("reads every edge of a table drawn as a single path, on a rotated page too", async () => {
    for (const angle of [0, 90]) {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([600, 800]);
      // Drawn turned with the page, so it reads left to right as displayed.
      page.drawText("Signature", { x: 300, y: 400, size: 10, font, rotate: degrees(angle) });
      // One path, stroked once: outer box plus a middle column line and a middle row line.
      page.drawSvgPath("M 100 100 L 400 100 L 400 160 L 100 160 Z M 250 100 L 250 160 M 100 130 L 400 130", { x: 0, y: 800, borderWidth: 1, borderColor: rgb(0, 0, 0) });
      page.setRotation(degrees(angle));
      const layout = await extractLayout(new Uint8Array(await doc.save()));
      expect(layout.rules, `rotation ${angle}`).toHaveLength(3);
      expect(layout.vrules, `rotation ${angle}`).toHaveLength(3);
      if (angle === 0) {
        expect(layout.rules.map((r) => [Math.round(r.x0), Math.round(r.x1), Math.round(r.y)])).toEqual([
          [100, 400, 100],
          [100, 400, 130],
          [100, 400, 160],
        ]);
      }
    }
  });

  it("bounds the lines it returns from a page drawn full of them", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([600, 800]);
    page.drawText("Sign on a line", { x: 20, y: 5, size: 4, font });
    for (let i = 0; i < 2500; i++) page.drawLine({ start: { x: 20 + (i % 5) * 110, y: 790 - Math.floor(i / 5) * 1.55 }, end: { x: 120 + (i % 5) * 110, y: 790 - Math.floor(i / 5) * 1.55 }, thickness: 0.3 });
    const layout = await extractLayout(new Uint8Array(await doc.save()));
    expect(layout.rules.length).toBeGreaterThan(100);
    expect(layout.rules.length).toBeLessThanOrEqual(1500);
  });

  it("marks an image-only document as scanned", async () => {
    const doc = await PDFDocument.create();
    const image = await doc.embedPng(PNG);
    for (let i = 0; i < 3; i++) doc.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
    const r = await extractText(new Uint8Array(await doc.save()));
    expect(r.scanned).toBe(true);
    expect(r.items).toEqual([]);
    expect(r.pageText).toEqual(["", "", ""]);
  });

  it("treats a scan with one stamped line of text as scanned, but not a mostly-text document", async () => {
    const make = async (textPages: number) => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const image = await doc.embedPng(PNG);
      for (let i = 0; i < 6; i++) {
        const page = doc.addPage([612, 792]);
        page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
        if (i === 0) page.drawText("Received 2026-01-05", { x: 400, y: 770, size: 8, font });
        else if (i <= textPages) page.drawText("This page has a real sentence of text on it.", { x: 72, y: 700, size: 11, font });
      }
      return new Uint8Array(await doc.save());
    };
    expect((await extractText(await make(0))).scanned).toBe(true);
    expect((await extractText(await make(5))).scanned).toBe(false);
  });

  it("never throws: unreadable input comes back empty and scanned", async () => {
    const { bytes } = await simple();
    const inputs = [new Uint8Array(), new Uint8Array([37, 80, 68, 70]), new TextEncoder().encode("%PDF-1.4\ngarbage garbage garbage"), bytes.slice(0, 300), new Uint8Array(4096)];
    for (const input of inputs) {
      const r = await extractText(input);
      expect(r.scanned).toBe(true);
      expect(r.items).toEqual([]);
    }
    // @ts-expect-error wrong type on purpose
    expect((await extractText("not bytes")).scanned).toBe(true);
    // @ts-expect-error wrong type on purpose
    expect((await extractText(undefined)).scanned).toBe(true);
  });

  it("does not consume the caller's buffer", async () => {
    const { bytes } = await simple();
    const copy = bytes.slice();
    await extractText(bytes);
    expect(bytes.length).toBe(copy.length);
    expect(Buffer.from(bytes).equals(Buffer.from(copy))).toBe(true);
  });

  it("groups runs on one baseline into a line, left to right", () => {
    const run = (text: string, x: number, baseline: number) => ({ page: 0, text, x, baseline, width: 20, size: 10 });
    const lines = groupLines([run("b", 100, 50.5), run("c", 10, 80), run("a", 10, 50)]);
    expect(lines.map((l) => l.runs.map((r) => r.text).join(""))).toEqual(["ab", "c"]);
  });
});
