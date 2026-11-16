import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { PDFDocument, StandardFonts, concatTransformationMatrix, degrees } from "pdf-lib";
import { extractImages, getDocumentProxy } from "unpdf";
import { LIMITS } from "@/lib/types";
import type { Field, FieldType, FieldValues } from "@/lib/types";
import { DocumentError } from "@/lib/pdf/types";
import { displaySize, pdfRectToFrac } from "@/lib/pdf/geometry";
import { embedFonts } from "@/lib/pdf/fonts";
import { MIN_FONT_SIZE, drawableText, parseImageDataUrl, stampFields, truncateToWidth, wrapText } from "@/lib/pdf/stamp";

/* ---------------------------------------------------------------- fixtures */

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** A real RGBA PNG. `noise` makes the pixel data incompressible so the file size can be controlled. */
function makePng(width: number, height: number, noise = false): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (width * 4 + 1));
  let seed = 7;
  for (let i = 0; i < raw.length; i++) {
    if (i % (width * 4 + 1) === 0) continue; // filter byte
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    raw[i] = noise ? (seed >>> 16) & 0xff : i % 4 === 0 ? 255 : 20;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

/** Rewrites the header's dimensions with a correct checksum, leaving the pixel data as it was. */
function retitled(png: Buffer, width: number, height: number): Buffer {
  const ihdr = Buffer.from(png.subarray(16, 29));
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([png.subarray(0, 8), chunk("IHDR", ihdr), png.subarray(33)]);
}

/** Inserts an extra, correctly checksummed chunk right after the header. */
function withChunk(png: Buffer, type: string, data: Uint8Array): Buffer {
  return Buffer.concat([png.subarray(0, 33), chunk(type, data), png.subarray(33)]);
}

const dataUrl = (png: Uint8Array) => `data:image/png;base64,${Buffer.from(png).toString("base64")}`;

interface PageSpec {
  rotation?: number;
  crop?: [number, number, number, number];
}

async function makePdf(pages: PageSpec[] = [{}]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const spec of pages) {
    const page = doc.addPage([612, 792]);
    if (spec.rotation) page.setRotation(degrees(spec.rotation));
    if (spec.crop) page.setCropBox(...spec.crop);
  }
  return doc.save();
}

let nextId = 0;
function field(type: FieldType, rect: { x: number; y: number; w: number; h: number }, page = 0): Field {
  return { id: `fld_${nextId++}`, page, ...rect, type, role: "client", required: true, label: type, source: "manual" };
}

interface ReadItem {
  text: string;
  /** Start of the baseline in display space: points from the displayed top-left. */
  u: number;
  v: number;
  /** Direction the text runs as displayed; (1, 0) is upright left-to-right. */
  dirX: number;
  dirY: number;
  fontSize: number;
  width: number;
}

async function readPage(pdf: Uint8Array, pageIndex = 0): Promise<{ items: ReadItem[]; width: number; height: number }> {
  // pdf.js takes ownership of the buffer it is given, so it gets a copy.
  const proxy = await getDocumentProxy(pdf.slice());
  const page = await proxy.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const vt = viewport.transform as number[];
  const items: ReadItem[] = [];
  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const [a, b, , , e, f] = item.transform as number[];
    const [u, v] = viewport.convertToViewportPoint(e, f);
    const dx = vt[0] * a + vt[2] * b;
    const dy = vt[1] * a + vt[3] * b;
    const size = Math.hypot(a, b);
    items.push({ text: item.str, u, v, dirX: dx / size, dirY: dy / size, fontSize: size, width: item.width });
  }
  return { items, width: viewport.width, height: viewport.height };
}

const pageText = async (pdf: Uint8Array, pageIndex = 0) => (await readPage(pdf, pageIndex)).items.map((i) => i.text).join(" ");

/* ------------------------------------------------------------------- tests */

describe("stampFields: placement", () => {
  const layouts: [string, PageSpec][] = [
    ["upright", {}],
    ["rotated 90", { rotation: 90 }],
    ["rotated 180", { rotation: 180 }],
    ["rotated 270", { rotation: 270 }],
    ["offset crop box", { crop: [50, 80, 400, 520] }],
    ["rotated 90 with offset crop box", { rotation: 90, crop: [50, 80, 400, 520] }],
    ["rotated 270 with offset crop box", { rotation: 270, crop: [50, 80, 400, 520] }],
  ];

  for (const [name, spec] of layouts) {
    it(`draws text upright inside its rectangle: ${name}`, async () => {
      const pdf = await makePdf([spec]);
      const f = field("full_name", { x: 0.2, y: 0.3, w: 0.5, h: 0.04 });
      const out = await stampFields(pdf, [f], { [f.id]: "Jane Example" });
      const { items, width, height } = await readPage(out);
      expect(items).toHaveLength(1);
      const [item] = items;
      expect(item.text).toBe("Jane Example");
      const left = f.x * width;
      const bottom = (f.y + f.h) * height;
      // Starts just inside the left edge, baseline in the lower third so the text sits on the line.
      expect(item.u).toBeGreaterThanOrEqual(left - 0.01);
      expect(item.u).toBeLessThanOrEqual(left + 3);
      expect(item.v).toBeLessThanOrEqual(bottom + 0.01);
      expect(item.v).toBeGreaterThanOrEqual(bottom - f.h * height * 0.3 - 0.01);
      expect(item.u + item.width).toBeLessThanOrEqual((f.x + f.w) * width + 0.01);
      expect(item.dirX).toBeCloseTo(1, 5);
      expect(item.dirY).toBeCloseTo(0, 5);
    });

    it(`anchors a signature image bottom-left, preserving aspect ratio: ${name}`, async () => {
      const pdf = await makePdf([spec]);
      const f = field("signature", { x: 0.1, y: 0.6, w: 0.5, h: 0.2 });
      const out = await stampFields(pdf, [f], { [f.id]: dataUrl(makePng(200, 50)) });
      const images = await extractImages(out.slice(), 1);
      expect(images).toHaveLength(1);
      const doc = await PDFDocument.load(out);
      const page = doc.getPage(0);
      const b = images[0].bounds;
      const rect = pdfRectToFrac(page, b.x, b.y, b.x + b.width, b.y + b.height);
      const size = displaySize(page);
      const drawnW = rect.w * size.width;
      const drawnH = rect.h * size.height;
      expect(drawnW / drawnH).toBeCloseTo(4, 2);
      // Fits inside the box and touches at least one pair of sides.
      expect(drawnW).toBeLessThanOrEqual(f.w * size.width + 0.01);
      expect(drawnH).toBeLessThanOrEqual(f.h * size.height + 0.01);
      expect(Math.max(drawnW / (f.w * size.width), drawnH / (f.h * size.height))).toBeCloseTo(1, 3);
      expect(rect.x).toBeCloseTo(f.x, 4);
      expect(rect.y + rect.h).toBeCloseTo(f.y + f.h, 4);
    });
  }

  it("lands in the right place on a page whose own content leaves a transform behind", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    // Unbalanced: scales and shifts everything drawn afterwards unless the stamper isolates it.
    page.pushOperators(concatTransformationMatrix(0.5, 0, 0, 0.5, 100, 100));
    page.drawText("Original", { x: 20, y: 20, size: 10, font: await doc.embedFont(StandardFonts.Helvetica) });
    const f = field("text", { x: 0.5, y: 0.5, w: 0.3, h: 0.03 });
    const out = await stampFields(await doc.save(), [f], { [f.id]: "Stamped" });
    const { items } = await readPage(out);
    const stamped = items.find((i) => i.text === "Stamped")!;
    expect(stamped.u).toBeGreaterThan(0.5 * 612 - 0.01);
    expect(stamped.u).toBeLessThan(0.5 * 612 + 3);
    expect(stamped.v).toBeLessThanOrEqual(0.53 * 792 + 0.01);
    expect(stamped.fontSize).toBeGreaterThan(MIN_FONT_SIZE);
  });

  it("draws each value on its own page and ignores pages that do not exist", async () => {
    const pdf = await makePdf([{}, { rotation: 90 }, {}]);
    const fields = [
      field("text", { x: 0.1, y: 0.1, w: 0.4, h: 0.03 }, 0),
      field("text", { x: 0.1, y: 0.1, w: 0.4, h: 0.03 }, 2),
      field("text", { x: 0.1, y: 0.1, w: 0.4, h: 0.03 }, 3),
      field("text", { x: 0.1, y: 0.1, w: 0.4, h: 0.03 }, -1),
      field("text", { x: 0.1, y: 0.1, w: 0.4, h: 0.03 }, 1.5),
      field("text", { x: 0.1, y: 0.1, w: 0.4, h: 0.03 }, Number.NaN),
    ];
    const values: FieldValues = Object.fromEntries(fields.map((f, i) => [f.id, `value ${i}`]));
    const out = await stampFields(pdf, fields, values);
    expect(await pageText(out, 0)).toBe("value 0");
    expect(await pageText(out, 1)).toBe("");
    expect(await pageText(out, 2)).toBe("value 1");
  });
});

describe("stampFields: text fitting", () => {
  it("shrinks a slightly long value to fit on its line", async () => {
    const pdf = await makePdf();
    const f = field("full_name", { x: 0.1, y: 0.2, w: 0.25, h: 0.025 });
    const value = "Maximilian Alexander Example";
    const out = await stampFields(pdf, [f], { [f.id]: value });
    // pdf.js may report one drawn line as several runs; together they are the whole value.
    const { items } = await readPage(out);
    expect(items.map((i) => i.text).join(" ").replace(/ +/g, " ")).toBe(value);
    for (const item of items) {
      expect(item.fontSize).toBeLessThan(12);
      expect(item.fontSize).toBeGreaterThanOrEqual(8);
      expect(item.u + item.width).toBeLessThanOrEqual(0.35 * 612 + 0.5);
      expect(item.v).toBeCloseTo(items[0].v, 3);
    }
  });

  it("truncates a 500-character value in a tiny box with an ellipsis at the minimum size", async () => {
    const pdf = await makePdf();
    const f = field("text", { x: 0.4, y: 0.4, w: 0.08, h: 0.012 });
    const out = await stampFields(pdf, [f], { [f.id]: "abcdefghij".repeat(50) });
    const { items, width } = await readPage(out);
    expect(items).toHaveLength(1);
    expect(items[0].text.endsWith("…")).toBe(true);
    expect(items[0].text.length).toBeLessThan(30);
    expect(items[0].fontSize).toBeCloseTo(MIN_FONT_SIZE, 3);
    expect(items[0].u + items[0].width).toBeLessThanOrEqual((f.x + f.w) * width + 0.5);
  });

  it("wraps a long value inside a tall box without leaving it", async () => {
    const pdf = await makePdf();
    const f = field("text", { x: 0.1, y: 0.5, w: 0.4, h: 0.1 });
    const value = "Renovation of the kitchen and both bathrooms at the test property, including electrical work, plumbing and final cleaning before handover.";
    const out = await stampFields(pdf, [f], { [f.id]: value });
    const { items, width, height } = await readPage(out);
    expect(items.length).toBeGreaterThan(1);
    expect(items.map((i) => i.text).join(" ")).toBe(value);
    for (const item of items) {
      expect(item.u).toBeGreaterThanOrEqual(f.x * width);
      expect(item.u + item.width).toBeLessThanOrEqual((f.x + f.w) * width + 0.5);
      expect(item.v).toBeGreaterThan(f.y * height);
      expect(item.v).toBeLessThanOrEqual((f.y + f.h) * height);
    }
  });

  it("turns line breaks and tabs into spaces instead of losing the word boundary", async () => {
    const pdf = await makePdf();
    const f = field("text", { x: 0.1, y: 0.5, w: 0.6, h: 0.03 });
    const out = await stampFields(pdf, [f], { [f.id]: "12 Test Street\r\nUnit 4\tSpringfield" });
    expect(await pageText(out)).toBe("12 Test Street Unit 4 Springfield");
  });

  it("does not throw on zero-size, negative or non-finite rectangles", async () => {
    const pdf = await makePdf([{ rotation: 90 }]);
    const png = dataUrl(makePng(40, 20));
    const rects = [
      { x: 0.5, y: 0.5, w: 0, h: 0 },
      { x: 0.5, y: 0.5, w: 0.2, h: 0 },
      { x: 0.5, y: 0.5, w: 0, h: 0.2 },
      { x: 2, y: -4, w: -1, h: -1 },
      { x: Number.NaN, y: Number.NaN, w: Number.NaN, h: Number.NaN },
      { x: 0, y: 0, w: Number.POSITIVE_INFINITY, h: 1e-9 },
    ];
    const fields: Field[] = [];
    const values: FieldValues = {};
    for (const rect of rects) {
      for (const type of ["text", "signature", "checkbox"] as const) {
        const f = field(type, rect);
        fields.push(f);
        values[f.id] = type === "text" ? "Some value" : type === "signature" ? png : true;
      }
    }
    const out = await stampFields(pdf, fields, values);
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1);
    // A zero-width box has nowhere to put text; a zero-height one still shows the value on its line.
    const texts = (await readPage(out)).items.map((i) => i.text);
    expect(texts.every((t) => "Some value".startsWith(t.replace("…", "")))).toBe(true);
  });
});

describe("stampFields: characters outside Latin", () => {
  it("keeps accented, Cyrillic, Greek and Vietnamese names exactly", async () => {
    const names = ["Zoë François-Müller", "Алексей Примеров", "Ελένη Δοκιμή", "Nguyễn Thị Thử Nghiệm", "Łukasz Żółć"];
    const pdf = await makePdf();
    const fields = names.map((_, i) => field("full_name", { x: 0.1, y: 0.1 + i * 0.06, w: 0.6, h: 0.03 }));
    const out = await stampFields(pdf, fields, Object.fromEntries(fields.map((f, i) => [f.id, names[i]])));
    const texts = (await readPage(out)).items.map((i) => i.text.normalize("NFC"));
    expect(texts).toEqual(names.map((n) => n.normalize("NFC")));
  });

  it("keeps plain letters extractable after a character the font draws as two glyphs", async () => {
    // Noto draws U+1ECB as "i" plus a dot below; that must not relabel every later "i" in the file.
    const pdf = await makePdf();
    const first = field("full_name", { x: 0.1, y: 0.1, w: 0.6, h: 0.03 });
    const second = field("text", { x: 0.1, y: 0.2, w: 0.6, h: 0.03 });
    const out = await stampFields(pdf, [first, second], { [first.id]: "Th\u1ecb", [second.id]: "Wii fit office" });
    const texts = (await readPage(out)).items.map((i) => i.text.normalize("NFC"));
    expect(texts).toEqual(["Th\u1ecb", "Wii fit office"]);
  });

  it("accepts decomposed input (NFD) and draws the composed characters", async () => {
    const pdf = await makePdf();
    const f = field("full_name", { x: 0.1, y: 0.1, w: 0.6, h: 0.03 });
    const out = await stampFields(pdf, [f], { [f.id]: "Nguyễn José".normalize("NFD") });
    expect((await pageText(out)).normalize("NFC")).toBe("Nguyễn José");
  });

  it("drops emoji, folds full-width letters and marks characters it cannot draw, without throwing", async () => {
    const pdf = await makePdf();
    const cases: [string, RegExp][] = [
      ["Sam \u{1F600} Tester \u{1F468}‍\u{1F469}‍\u{1F467}", /^Sam Tester$/],
      ["Ｊａｎｅ Ｄｏｅ", /^Jane Doe$/],
      ["山田 太郎 (Taro)", /^.. .. \(Taro\)$/],
      ["مثال Example", /^.{4} Example$/],
      ["❤️", /^$/],
    ];
    const fields = cases.map((_, i) => field("full_name", { x: 0.1, y: 0.1 + i * 0.06, w: 0.6, h: 0.03 }));
    const out = await stampFields(pdf, fields, Object.fromEntries(fields.map((f, i) => [f.id, cases[i][0]])));
    const texts = (await readPage(out)).items.map((i) => i.text);
    // The emoji-only value has nothing drawable and is skipped entirely.
    expect(texts).toHaveLength(4);
    texts.forEach((t, i) => expect(t).toMatch(cases[i][1]));
    expect(texts[2]).not.toContain("山");
  });

  it("produces text helpers that never return undrawable or overflowing output", async () => {
    const doc = await PDFDocument.create();
    const { regular } = await embedFonts(doc, ["regular"]);
    const nasty = "\u0000\u0007A​B﻿ \u{1F4A9}\u{10FFFF}\ud800 \t\n C";
    const clean = drawableText(regular, nasty);
    expect(() => regular.widthOfTextAtSize(clean, 10)).not.toThrow();
    expect(clean.startsWith("AB")).toBe(true);
    expect(clean.endsWith("C")).toBe(true);
    expect(drawableText(regular, null)).toBe("");
    expect(drawableText(regular, { toString: () => "x" })).toBe("");
    expect(drawableText(regular, 42)).toBe("42");
    expect(Array.from(drawableText(regular, "x".repeat(5_000_000))).length).toBe(LIMITS.maxTextFieldLength);

    expect(truncateToWidth(regular, "Hello world", 10, 0.1)).toBe("");
    expect(truncateToWidth(regular, "Hello world", 10, 1000)).toBe("Hello world");
    const cut = truncateToWidth(regular, "Hello world", 10, 30);
    expect(cut.endsWith("…")).toBe(true);
    expect(regular.widthOfTextAtSize(cut, 10)).toBeLessThanOrEqual(30);

    const lines = wrapText(regular, `see ${"a".repeat(300)}@example.com for more`, 9, 120);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(regular.widthOfTextAtSize(line, 9)).toBeLessThanOrEqual(120);
    expect(lines.join("").replace(/ /g, "")).toBe(`see${"a".repeat(300)}@example.comformore`);
    const capped = wrapText(regular, "word ".repeat(200), 9, 120, 2);
    expect(capped).toHaveLength(2);
    expect(capped[1].endsWith("…")).toBe(true);
    expect(regular.widthOfTextAtSize(capped[1], 9)).toBeLessThanOrEqual(120);
    expect(wrapText(regular, "anything", 9, 0)).toEqual([]);
  });
});

describe("stampFields: values that cannot or should not be drawn", () => {
  it("skips fields without a value and returns the document unchanged when nothing is drawn", async () => {
    const pdf = await makePdf();
    const fields = [field("text", { x: 0.1, y: 0.1, w: 0.3, h: 0.03 }), field("checkbox", { x: 0.1, y: 0.2, w: 0.03, h: 0.02 }), field("signature", { x: 0.1, y: 0.3, w: 0.3, h: 0.08 })];
    const out = await stampFields(pdf, fields, { [fields[0].id]: "   ", [fields[1].id]: false });
    expect(Buffer.from(out).equals(Buffer.from(pdf))).toBe(true);
    expect(out).not.toBe(pdf);
  });

  it("skips corrupt signatures and wrongly typed values but still draws the rest", async () => {
    const pdf = await makePdf();
    const truncated = makePng(60, 20).subarray(0, 60);
    const badValues: unknown[] = [
      "data:image/png;base64,@@@not-base64@@@",
      "data:image/png;base64,",
      "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      "data:image/svg+xml;base64,PHN2Zy8+",
      dataUrl(truncated),
      dataUrl(Buffer.concat([makePng(60, 20).subarray(0, 40), Buffer.alloc(200, 0x41)])),
      "Typed Name",
      true,
      12345,
      { nested: "object" },
      ["array"],
      null,
    ];
    const fields = badValues.map((_, i) => field("signature", { x: 0.05, y: 0.05 + i * 0.05, w: 0.3, h: 0.04 }));
    const good = field("full_name", { x: 0.5, y: 0.9, w: 0.4, h: 0.03 });
    const check = field("checkbox", { x: 0.5, y: 0.8, w: 0.03, h: 0.02 });
    const textGivenBoolean = field("text", { x: 0.5, y: 0.7, w: 0.3, h: 0.03 });
    const textGivenObject = field("text", { x: 0.5, y: 0.6, w: 0.3, h: 0.03 });
    const checkGivenText = field("checkbox", { x: 0.5, y: 0.5, w: 0.03, h: 0.02 });
    const values = Object.fromEntries(fields.map((f, i) => [f.id, badValues[i]])) as FieldValues;
    Object.assign(values, { [good.id]: "Still Drawn", [check.id]: true, [textGivenBoolean.id]: true, [textGivenObject.id]: { a: 1 }, [checkGivenText.id]: "maybe" });
    const out = await stampFields(pdf, [...fields, good, check, textGivenBoolean, textGivenObject, checkGivenText], values);
    expect(await pageText(out)).toBe("Still Drawn");
    expect(await extractImages(out.slice(), 1)).toHaveLength(0);
  });

  it("draws a check mark only for a checked box", async () => {
    const pdf = await makePdf([{ rotation: 270 }]);
    const on = field("checkbox", { x: 0.2, y: 0.2, w: 0.03, h: 0.03 });
    const off = field("checkbox", { x: 0.3, y: 0.2, w: 0.03, h: 0.03 });
    const checked = await stampFields(pdf, [on, off], { [on.id]: true, [off.id]: false });
    const ops = async (bytes: Uint8Array) => {
      const page = await (await getDocumentProxy(bytes.slice())).getPage(1);
      return (await page.getOperatorList()).fnArray.length;
    };
    // Two strokes for one checked box; the unchecked one adds nothing.
    const one = await ops(checked);
    const both = await ops(await stampFields(pdf, [on, off], { [on.id]: true, [off.id]: true }));
    expect(one).toBeGreaterThan(await ops(pdf));
    expect(both - one).toBe(one - (await ops(await stampFields(pdf, [on, off], {}))) );
  });

  it("ignores junk in the field list and values keyed by inherited property names", async () => {
    const pdf = await makePdf();
    const proto = { ...field("text", { x: 0.1, y: 0.1, w: 0.3, h: 0.03 }), id: "constructor" };
    const real = field("text", { x: 0.1, y: 0.2, w: 0.3, h: 0.03 });
    const junk = [null, undefined, 7, "field", {}, proto, real] as unknown as Field[];
    const out = await stampFields(pdf, junk, { [real.id]: "kept" });
    expect(await pageText(out)).toBe("kept");
    await expect(stampFields(pdf, null as unknown as Field[], null as unknown as FieldValues)).resolves.toBeInstanceOf(Uint8Array);
  });

  it("never mutates the input bytes", async () => {
    const pdf = await makePdf();
    const before = Buffer.from(pdf).toString("base64");
    const f = field("signature", { x: 0.1, y: 0.1, w: 0.3, h: 0.1 });
    const g = field("text", { x: 0.1, y: 0.3, w: 0.3, h: 0.03 });
    await stampFields(pdf, [f, g], { [f.id]: dataUrl(makePng(30, 10)), [g.id]: "text" });
    expect(Buffer.from(pdf).toString("base64")).toBe(before);
  });

  it("reports an unreadable PDF as a DocumentError with a next step", async () => {
    const f = field("text", { x: 0.1, y: 0.1, w: 0.3, h: 0.03 });
    for (const bytes of [new Uint8Array(), new TextEncoder().encode("this is not a pdf"), "nope" as unknown as Uint8Array]) {
      const error = await stampFields(bytes, [f], { [f.id]: "x" }).catch((e) => e);
      expect(error).toBeInstanceOf(DocumentError);
      expect(error.message).toMatch(/upload/i);
    }
  });
});

describe("stampFields: volume", () => {
  it("stamps 300 fields across pages, embedding a repeated signature once", async () => {
    const pdf = await makePdf([{}, { rotation: 90 }, { rotation: 180 }, { crop: [20, 20, 500, 700] }]);
    const signature = dataUrl(makePng(300, 100, true));
    const fields: Field[] = [];
    const values: FieldValues = {};
    for (let i = 0; i < LIMITS.maxFieldsPerTemplate; i++) {
      const type: FieldType = i % 3 === 0 ? "initials" : i % 3 === 1 ? "text" : "checkbox";
      const f = field(type, { x: 0.05 + (i % 10) * 0.09, y: 0.03 + Math.floor((i % 75) / 10) * 0.12, w: 0.08, h: 0.03 }, i % 4);
      fields.push(f);
      values[f.id] = type === "initials" ? signature : type === "text" ? `Value ${i}` : true;
    }
    const started = Date.now();
    const out = await stampFields(pdf, fields, values);
    expect(Date.now() - started).toBeLessThan(10_000);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(4);
    const texts = (await Promise.all([0, 1, 2, 3].map((p) => readPage(out, p)))).flatMap((p) => p.items);
    // Values too long for the narrowest boxes wrap onto a second line, so count values, not runs.
    expect(texts.filter((t) => t.text.startsWith("Value"))).toHaveLength(100);
    expect(texts.map((t) => t.text).join(" ")).toContain("Value 295");
    for (const item of texts) expect(item.dirX).toBeCloseTo(1, 5);
    // 100 uses of the image must not store 100 copies of it.
    expect(out.length).toBeLessThan(pdf.length + 400_000);
  });
});

describe("parseImageDataUrl", () => {
  it("accepts a real PNG and reports its dimensions", () => {
    const png = makePng(320, 96);
    const parsed = parseImageDataUrl(dataUrl(png));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.width).toBe(320);
      expect(parsed.height).toBe(96);
      expect(Buffer.from(parsed.bytes).equals(png)).toBe(true);
    }
    // Base64 with line breaks and an extra media-type parameter is still the same image.
    const wrapped = `data:image/png;charset=utf-8;base64,${png.toString("base64").replace(/(.{76})/g, "$1\n")}`;
    expect(parseImageDataUrl(wrapped).ok).toBe(true);

    // Unknown ancillary chunks are fine; bytes after the end marker are dropped rather than stored.
    expect(parseImageDataUrl(dataUrl(withChunk(png, "tEXt", Buffer.from("Comment\0test")))).ok).toBe(true);
    const trailing = parseImageDataUrl(dataUrl(Buffer.concat([png, Buffer.from("<script>alert(1)</script>")])));
    expect(trailing.ok && Buffer.from(trailing.bytes).equals(png)).toBe(true);
  });

  it("rejects everything that is not a sane PNG, with a reason that says what to do", () => {
    const png = makePng(10, 10);
    const header = (mutate: (b: Buffer) => void) => {
      const copy = Buffer.from(png);
      mutate(copy);
      return dataUrl(copy);
    };
    const bad: unknown[] = [
      undefined,
      null,
      "",
      42,
      {},
      "hello",
      "data:,",
      "data:image/png;base64",
      "data:image/png;base64,",
      "data:image/png,rawbytes",
      "data:image/jpeg;base64," + png.toString("base64"),
      "data:text/html;base64," + png.toString("base64"),
      "data:image/png;base64,****",
      dataUrl(Buffer.from("GIF89a" + "0".repeat(80), "latin1")),
      dataUrl(png.subarray(0, 30)),
      header((b) => b.writeUInt32BE(0, 16)), // zero width
      header((b) => b.writeUInt32BE(0, 20)), // zero height
      header((b) => b.writeUInt32BE(100_000, 16)), // absurd width
      header((b) => b.writeUInt32BE(0xffffffff, 20)),
      header((b) => (b[24] = 7)), // impossible bit depth
      header((b) => (b[25] = 5)), // impossible colour type
      header((b) => b.write("IDAT", 12, "latin1")), // first chunk is not IHDR
      header((b) => (b[0] = 0x88)),
      header((b) => (b[b.length - 20] ^= 0xff)), // pixel data corrupted: checksum no longer matches
      dataUrl(png.subarray(0, png.length - 12)), // end marker missing
      dataUrl(png.subarray(0, 60)), // cut off mid-data
      dataUrl(Buffer.concat([png.subarray(0, 40), Buffer.alloc(200, 0x41)])),
      // Structurally perfect, but the pixel data is for a smaller image than the header claims.
      dataUrl(retitled(makePng(10, 10), 10, 11)),
      dataUrl(withChunk(png, "acTL", Buffer.alloc(8))), // animated
    ];
    for (const value of bad) {
      const parsed = parseImageDataUrl(value);
      expect(parsed.ok, String(value).slice(0, 40)).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(/again|smaller/i);
    }
  });

  it("refuses images over the byte limit or with huge dimensions before they reach the PDF writer", () => {
    // Small file, enormous canvas: the classic decompression bomb.
    const bomb = parseImageDataUrl(dataUrl(makePng(4000, 4000)));
    expect(bomb.ok).toBe(false);
    if (!bomb.ok) expect(bomb.reason).toMatch(/too large/);

    const heavy = makePng(700, 400, true);
    expect(heavy.length).toBeGreaterThan(LIMITS.maxSignatureBytes);
    const tooHeavy = parseImageDataUrl(dataUrl(heavy));
    expect(tooHeavy.ok).toBe(false);
    if (!tooHeavy.ok) expect(tooHeavy.reason).toMatch(/KB/);

    const started = Date.now();
    expect(parseImageDataUrl("data:image/png;base64," + "A".repeat(30_000_000)).ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("stamping a huge signature skips it and leaves the rest of the document intact", async () => {
    const pdf = await makePdf();
    const big = field("signature", { x: 0.1, y: 0.1, w: 0.4, h: 0.1 });
    const bomb = field("signature", { x: 0.1, y: 0.3, w: 0.4, h: 0.1 });
    const name = field("full_name", { x: 0.1, y: 0.5, w: 0.4, h: 0.03 });
    const out = await stampFields(pdf, [big, bomb, name], {
      [big.id]: dataUrl(makePng(700, 400, true)),
      [bomb.id]: dataUrl(makePng(4000, 4000)),
      [name.id]: "Pat Sample",
    });
    expect(await extractImages(out.slice(), 1)).toHaveLength(0);
    expect(await pageText(out)).toBe("Pat Sample");
  });
});
