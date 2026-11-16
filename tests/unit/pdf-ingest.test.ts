import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { extractText } from "unpdf";
import { PDFDocument, PDFDict, PDFName, PDFStream, PDFString, PDFHexString, StandardFonts, degrees } from "pdf-lib";
import { LIMITS } from "@/lib/types";
import { DocumentError, type IngestResult } from "@/lib/pdf/types";
import { ingestDocument, ingestPageImages, ingestText } from "@/lib/pdf/ingest";
import { typesetHtml, typesetText } from "@/lib/pdf/typeset";
import { listZipEntries } from "@/lib/pdf/ingest-zip";
import { jpegInfo } from "@/lib/pdf/ingest-image";

// ---------------------------------------------------------------------------
// Fixtures (all generated; test data only)
// ---------------------------------------------------------------------------

const enc = (s: string) => new TextEncoder().encode(s);

async function pageTexts(pdf: Uint8Array): Promise<string[]> {
  // unpdf transfers the buffer it is given, so hand it a copy.
  const { text } = await extractText(new Uint8Array(pdf), { mergePages: false });
  return text;
}

async function allText(pdf: Uint8Array): Promise<string> {
  return (await pageTexts(pdf)).join("\n");
}

async function simplePdf(options: { pages?: number; title?: string; text?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < (options.pages ?? 1); i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(options.text ?? `Services Agreement page ${i + 1}`, { x: 72, y: 700, size: 12, font });
  }
  if (options.title !== undefined) doc.setTitle(options.title);
  return doc.save();
}

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function makePng(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(enc(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set([40, 90, 160], y * (1 + width * 3) + 1 + x * 3);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  return Buffer.concat(parts);
}

// A real 1x1 baseline JPEG. pdf-lib stores JPEG data as-is, so the frame header can be
// patched to claim other dimensions without re-encoding.
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";

function makeJpeg(width: number, height: number, orientation?: number): Uint8Array {
  const base = new Uint8Array(Buffer.from(TINY_JPEG_B64, "base64"));
  const sof = base.findIndex((b, i) => b === 0xff && base[i + 1] === 0xc0);
  const view = new DataView(base.buffer);
  view.setUint16(sof + 5, height);
  view.setUint16(sof + 7, width);
  if (!orientation) return base;
  // APP1 "Exif" segment: big-endian TIFF header with a single Orientation entry.
  const exif = [
    0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ];
  return Buffer.concat([base.subarray(0, 2), new Uint8Array(exif), base.subarray(2)]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (text: string, rPr = "", pPr = "") =>
  `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

async function makeDocx(body: string, options: { media?: Record<string, Uint8Array>; documentRels?: string; numbering?: string } = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${options.documentRels ?? ""}</Relationships>`,
  );
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`,
  );
  zip.file(
    "word/numbering.xml",
    options.numbering ??
      `<?xml version="1.0"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document ${W} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}</w:body></w:document>`,
  );
  for (const [name, bytes] of Object.entries(options.media ?? {})) zip.file(`word/media/${name}`, bytes);
  return zip.generateAsync({ type: "uint8array" });
}

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "uint8array" });
}

async function expectError(promise: Promise<unknown>, code: DocumentError["code"]): Promise<DocumentError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected DocumentError(${code})`).toBeInstanceOf(DocumentError);
  const error = caught as DocumentError;
  expect(error.code).toBe(code);
  // Every message must be a sentence a person can act on.
  expect(error.message.length).toBeGreaterThan(30);
  return error;
}

/** Invariants every successful ingest must satisfy. */
async function expectSignable(result: IngestResult) {
  const doc = await PDFDocument.load(result.pdf);
  expect(doc.isEncrypted).toBe(false);
  expect(doc.getPageCount()).toBe(result.pages.length);
  expect(result.pages.length).toBeGreaterThan(0);
  for (const page of result.pages) {
    expect(page.width).toBeGreaterThan(1);
    expect(page.height).toBeGreaterThan(1);
  }
  expect(doc.catalog.has(PDFName.of("AcroForm"))).toBe(false);
  expect(doc.catalog.has(PDFName.of("OpenAction"))).toBe(false);
  expect(result.title.trim().length).toBeGreaterThan(0);
  // Still modifiable: draw on it and save again.
  doc.getPage(0).drawRectangle({ x: 10, y: 10, width: 5, height: 5 });
  await doc.save();
  return doc;
}

// ---------------------------------------------------------------------------

describe("ingestDocument: PDF", () => {
  it("normalizes a plain PDF and keeps its text", async () => {
    const result = await ingestDocument({ bytes: await simplePdf({ pages: 3 }), filename: "client_agreement_v2.pdf" });
    await expectSignable(result);
    expect(result.sourceKind).toBe("pdf");
    expect(result.pages).toEqual(Array(3).fill({ width: 612, height: 792 }));
    expect(result.formFields).toEqual([]);
    expect(result.title).toBe("client agreement v2");
    expect(await allText(result.pdf)).toContain("Services Agreement page 2");
  });

  it("prefers a real metadata title and ignores junk titles", async () => {
    const real = await ingestDocument({ bytes: await simplePdf({ title: "Master Services Agreement" }), filename: "scan0001.pdf" });
    expect(real.title).toBe("Master Services Agreement");
    for (const junk of ["Untitled", "Microsoft Word - Document1", "Document1", "", "   ", "12", "scan0042"]) {
      const result = await ingestDocument({ bytes: await simplePdf({ title: junk }), filename: "C:\\Users\\test\\Engagement%20Letter.final.PDF" });
      expect(result.title, `title for "${junk}"`).toBe("Engagement Letter.final");
    }
    const word = await ingestDocument({ bytes: await simplePdf({ title: "Microsoft Word - Retainer Agreement.docx" }), filename: "x.pdf" });
    expect(word.title).toBe("Retainer Agreement");
    const nameless = await ingestDocument({ bytes: await simplePdf(), filename: ".pdf" });
    expect(nameless.title).toBe("Agreement");
  });

  it("decides by content, not by filename or MIME type", async () => {
    const pdf = await ingestDocument({ bytes: await simplePdf(), filename: "agreement.docx", mimeType: "application/msword" });
    expect(pdf.sourceKind).toBe("pdf");
    const docx = await ingestDocument({ bytes: await makeDocx(para("Hello from Word")), filename: "agreement.pdf", mimeType: "application/pdf" });
    expect(docx.sourceKind).toBe("docx");
  });

  it("accepts a PDF header after leading junk bytes", async () => {
    const pdf = await simplePdf();
    const junk = enc("\r\n\r\nX-Mailer: gateway\r\n\0\0\0");
    const result = await ingestDocument({ bytes: Buffer.concat([junk, pdf]), filename: "a.pdf" });
    await expectSignable(result);
    expect(await allText(result.pdf)).toContain("Services Agreement");
  });

  it("reports encrypted PDFs as password protected", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const encrypt = doc.context.obj({ Filter: "Standard", V: 1, R: 2, P: -44, O: PDFHexString.of("00".repeat(32)), U: PDFHexString.of("00".repeat(32)) });
    doc.context.trailerInfo.Encrypt = doc.context.register(encrypt);
    const bytes = await doc.save({ useObjectStreams: false });
    const error = await expectError(ingestDocument({ bytes, filename: "locked.pdf" }), "password_protected");
    expect(error.message).toMatch(/password/i);
    expect(error.message).toMatch(/restrictions/i);
    expect(error.message).toMatch(/Save as PDF/);
  });

  it("reports corrupt and truncated PDFs without throwing anything else", async () => {
    await expectError(ingestDocument({ bytes: enc("%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n1 0 obj\n<< /Type /Catalog"), filename: "a.pdf" }), "corrupt");
    await expectError(ingestDocument({ bytes: enc("%PDF-1.4\n" + "garbage ".repeat(500)), filename: "a.pdf" }), "corrupt");
    const pdf = await simplePdf({ pages: 4 });
    for (const keep of [0.1, 0.35, 0.6, 0.9]) {
      const cut = pdf.subarray(0, Math.floor(pdf.length * keep));
      try {
        await expectSignable(await ingestDocument({ bytes: cut, filename: "cut.pdf" }));
      } catch (error) {
        expect(error).toBeInstanceOf(DocumentError);
      }
    }
  });

  it("rejects a PDF with no pages", async () => {
    const doc = await PDFDocument.create();
    const bytes = await doc.save({ addDefaultPage: false });
    await expectError(ingestDocument({ bytes, filename: "a.pdf" }), "empty");
  });

  it("rejects more pages than the limit, and files over the size limit", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i <= LIMITS.maxPages; i++) doc.addPage([200, 200]);
    const error = await expectError(ingestDocument({ bytes: await doc.save(), filename: "a.pdf" }), "too_many_pages");
    expect(error.message).toContain(String(LIMITS.maxPages));

    const big = new Uint8Array(LIMITS.maxUploadBytes + 1);
    big.set(enc("%PDF-1.7"));
    await expectError(ingestDocument({ bytes: big, filename: "a.pdf" }), "too_large");
  });

  it("reports displayed sizes for rotated and cropped pages and repairs odd boxes", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]).setRotation(degrees(90));
    const cropped = doc.addPage([612, 792]);
    cropped.setCropBox(100, 100, 400, 500);
    const outside = doc.addPage([612, 792]);
    outside.setCropBox(5000, 5000, 100, 100); // nowhere near the page
    const partly = doc.addPage([612, 792]);
    partly.setCropBox(-50, -50, 300, 300); // sticks out bottom-left
    const zero = doc.addPage([612, 792]);
    zero.node.set(PDFName.of("MediaBox"), doc.context.obj([0, 0, 0, 0]));
    const skewed = doc.addPage([300, 400]);
    skewed.node.set(PDFName.of("Rotate"), doc.context.obj(45));
    const negative = doc.addPage([612, 792]);
    negative.node.set(PDFName.of("MediaBox"), doc.context.obj([612, 792, 0, 0]));
    const wrapped = doc.addPage([300, 400]);
    wrapped.node.set(PDFName.of("Rotate"), doc.context.obj(-90));
    const broken = doc.addPage([612, 792]);
    broken.node.set(PDFName.of("MediaBox"), doc.context.obj(["a", "b"]));

    const result = await ingestDocument({ bytes: await doc.save(), filename: "a.pdf" });
    const out = await expectSignable(result);
    expect(result.pages).toEqual([
      { width: 792, height: 612 },
      { width: 400, height: 500 },
      { width: 612, height: 792 },
      { width: 250, height: 250 },
      { width: 612, height: 792 },
      { width: 300, height: 400 },
      { width: 612, height: 792 },
      { width: 400, height: 300 },
      { width: 612, height: 792 },
    ]);
    expect(out.getPage(5).getRotation().angle).toBe(0);
    expect(out.getPage(7).getRotation().angle).toBe(270);
    expect(out.getPage(3).getCropBox()).toEqual({ x: 0, y: 0, width: 250, height: 250 });
  });

  it("recovers AcroForm widgets as fields, then flattens the form", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const rotated = doc.addPage([600, 800]);
    rotated.setRotation(degrees(90));
    const form = doc.getForm();
    const add = (name: string, y: number) => form.createTextField(name).addToPage(page, { x: 60, y, width: 240, height: 20, borderWidth: 0 });
    add("ClientName", 700);
    add("client.signature_date", 660);
    add("Email Address", 620);
    add("Company", 580);
    add("JobTitle", 540);
    add("Initials", 500);
    add("EffectiveDate", 460);
    add("Notes", 420);
    const filled = form.createTextField("Provider");
    filled.setText("Acme Test Consulting");
    filled.addToPage(page, { x: 60, y: 380, width: 240, height: 20, borderWidth: 0 });
    form.createCheckBox("agree_terms").addToPage(page, { x: 60, y: 340, width: 12, height: 12 });
    const required = form.createTextField("Reference");
    required.enableRequired();
    required.addToPage(rotated, { x: 100, y: 200, width: 20, height: 150, borderWidth: 0 });
    // An unsigned signature box with no appearance stream, as authoring tools write them.
    const sig = doc.context.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig", T: PDFString.of("Signature1"), TU: PDFString.of("Client signs here"), Rect: [60, 250, 300, 300], P: page.ref });
    const sigRef = doc.context.register(sig);
    page.node.addAnnot(sigRef);
    form.acroForm.addField(sigRef);

    const result = await ingestDocument({ bytes: await doc.save(), filename: "form.pdf" });
    const out = await expectSignable(result);
    for (const p of out.getPages()) {
      const annots = p.node.Annots();
      for (let i = 0; i < (annots?.size() ?? 0); i++) {
        expect((annots!.lookup(i) as PDFDict).get(PDFName.of("Subtype"))).not.toBe(PDFName.of("Widget"));
      }
    }

    const byLabel = Object.fromEntries(result.formFields.map((f) => [f.label, f]));
    expect(byLabel["Client Name"].type).toBe("full_name");
    expect(byLabel["signature date"].type).toBe("date_signed");
    expect(byLabel["Email Address"].type).toBe("email");
    expect(byLabel["Company"].type).toBe("company");
    expect(byLabel["Job Title"].type).toBe("title");
    expect(byLabel["Initials"].type).toBe("initials");
    expect(byLabel["Effective Date"].type).toBe("date");
    expect(byLabel["Notes"].type).toBe("text");
    expect(byLabel["agree terms"].type).toBe("checkbox");
    expect(byLabel["Client signs here"].type).toBe("signature");
    expect(byLabel["Client signs here"].required).toBe(true);
    expect(byLabel["Reference"].required).toBe(true);
    expect(byLabel["Notes"].required).toBe(false);
    // The pre-filled field is content, not a blank to fill.
    expect(byLabel["Provider"]).toBeUndefined();
    expect(await allText(result.pdf)).toContain("Acme Test Consulting");

    for (const field of result.formFields) {
      expect(field.source).toBe("form");
      expect(field.role).toBe("client");
      expect(field.id).toMatch(/^fld_/);
    }
    const name = byLabel["Client Name"];
    expect(name.page).toBe(0);
    expect(name.x).toBeCloseTo(60 / 600, 5);
    expect(name.y).toBeCloseTo((800 - 720) / 800, 5);
    expect(name.w).toBeCloseTo(240 / 600, 5);
    expect(name.h).toBeCloseTo(20 / 800, 5);
    // On the page rotated 90 degrees the display is 800 wide and 600 tall: a tall
    // narrow box in PDF space reads as a wide short one.
    const ref = byLabel["Reference"];
    expect(ref.page).toBe(1);
    expect(ref.x).toBeCloseTo(200 / 800, 5);
    expect(ref.y).toBeCloseTo(100 / 600, 5);
    expect(ref.w).toBeCloseTo(150 / 800, 5);
    expect(ref.h).toBeCloseTo(20 / 600, 5);
  });

  it("still succeeds when a form cannot be flattened cleanly", async () => {
    // A value the built-in form font cannot encode, with no appearance stream to fall back on.
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    page.drawText("Body text stays", { x: 60, y: 740, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
    const form = doc.getForm();
    form.createTextField("ok").addToPage(page, { x: 60, y: 700, width: 200, height: 20 });
    const widget = doc.context.obj({ Type: "Annot", Subtype: "Widget", FT: "Tx", T: PDFString.of("odd"), V: PDFHexString.fromText("\u041f\u0440\u0438\u0432\u0435\u0442"), Rect: [60, 600, 260, 620], P: page.ref });
    const ref = doc.context.register(widget);
    page.node.addAnnot(ref);
    form.acroForm.addField(ref);
    const result = await ingestDocument({ bytes: await doc.save({ updateFieldAppearances: false }), filename: "odd.pdf" });
    await expectSignable(result);
    expect(await allText(result.pdf)).toContain("Body text stays");
    expect(result.formFields.map((f) => f.label)).toEqual(["ok"]);

    // A field list that is not a list of fields at all.
    const bad = await PDFDocument.create();
    bad.addPage();
    bad.catalog.set(PDFName.of("AcroForm"), bad.context.obj({ Fields: [42, "nope"], NeedAppearances: true }));
    const badResult = await ingestDocument({ bytes: await bad.save(), filename: "bad.pdf" });
    await expectSignable(badResult);
    expect(badResult.formFields).toEqual([]);
  });

  it("removes XFA and tells the uploader", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const form = doc.getForm();
    form.createTextField("Name").addToPage(page, { x: 60, y: 700, width: 200, height: 20 });
    // pdf-lib drops XFA as soon as its form API is touched, so add it to a reloaded copy by hand.
    const plain = await PDFDocument.load(await doc.save());
    const xfa = plain.context.register(plain.context.stream("<xdp:xdp xmlns:xdp='http://ns.adobe.com/xdp/'>SECRET-XFA-TEMPLATE</xdp:xdp>"));
    (plain.catalog.lookup(PDFName.of("AcroForm")) as PDFDict).set(PDFName.of("XFA"), plain.context.obj([PDFString.of("template"), xfa]));
    const result = await ingestDocument({ bytes: await plain.save({ useObjectStreams: false, updateFieldAppearances: false }), filename: "xfa.pdf" });
    await expectSignable(result);
    expect(result.warnings.join(" ")).toMatch(/XFA/);
    expect(result.formFields).toHaveLength(1);
    const out = await PDFDocument.load(result.pdf);
    const streams = out.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFStream);
    for (const [, stream] of streams) {
      expect(Buffer.from((stream as PDFStream).getContents()).toString("latin1")).not.toContain("SECRET-XFA-TEMPLATE");
    }
  });

  it("strips JavaScript, open actions and scripted annotations", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    doc.addJavaScript("boot", "app.alert('NAME-TREE-SCRIPT');");
    const js = doc.context.register(doc.context.obj({ Type: "Action", S: "JavaScript", JS: PDFString.of("app.alert('OPEN-ACTION-SCRIPT')") }));
    doc.catalog.set(PDFName.of("OpenAction"), js);
    doc.catalog.set(PDFName.of("AA"), doc.context.obj({ WC: js }));
    page.node.set(PDFName.of("AA"), doc.context.obj({ O: js }));
    const link = doc.context.register(
      doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [10, 10, 100, 30], A: { S: "Launch", F: PDFString.of("calc.exe") } }),
    );
    const safeLink = doc.context.register(
      doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [10, 40, 100, 60], A: { S: "URI", URI: PDFString.of("https://example.com/terms"), Next: js } }),
    );
    page.node.addAnnot(link);
    page.node.addAnnot(safeLink);

    const result = await ingestDocument({ bytes: await doc.save({ useObjectStreams: false }), filename: "js.pdf" });
    const out = await expectSignable(result);
    expect(out.catalog.has(PDFName.of("AA"))).toBe(false);
    expect(out.getPage(0).node.has(PDFName.of("AA"))).toBe(false);
    const names = out.catalog.lookup(PDFName.of("Names"));
    if (names instanceof PDFDict) expect(names.has(PDFName.of("JavaScript"))).toBe(false);
    const annots = out.getPage(0).node.Annots()!;
    expect(annots.size()).toBe(2);
    expect((annots.lookup(0) as PDFDict).has(PDFName.of("A"))).toBe(false);
    const kept = (annots.lookup(1) as PDFDict).lookup(PDFName.of("A")) as PDFDict;
    expect(kept.get(PDFName.of("S"))).toBe(PDFName.of("URI"));
    expect(kept.has(PDFName.of("Next"))).toBe(false);
    for (const [, obj] of out.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict) {
        expect(obj.get(PDFName.of("S"))).not.toBe(PDFName.of("JavaScript"));
        expect(obj.has(PDFName.of("JS"))).toBe(false);
      }
    }
    // The script text is gone from the file, not merely unlinked.
    const raw = Buffer.from(await out.save({ useObjectStreams: false })).toString("latin1");
    expect(raw).not.toContain("OPEN-ACTION-SCRIPT");
    expect(raw).not.toContain("NAME-TREE-SCRIPT");
    expect(raw).not.toContain("calc.exe");
  });
});

describe("ingestDocument: Word", () => {
  const signatureBlock =
    para("Client signature: ______________________________") +
    // Underlined tabs and underlined spaces: how Word users draw a line to sign on.
    `<w:p><w:r><w:t xml:space="preserve">Signed: </w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:tab/><w:tab/></w:r></w:p>` +
    `<w:p><w:r><w:t xml:space="preserve">Dated: </w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">                    </w:t></w:r></w:p>` +
    // A tab stop with an underscore leader.
    `<w:p><w:pPr><w:tabs><w:tab w:val="right" w:leader="underscore" w:pos="6000"/></w:tabs></w:pPr><w:r><w:t>Name:</w:t></w:r><w:r><w:tab/></w:r></w:p>` +
    `<w:p><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9000"/></w:tabs></w:pPr><w:r><w:t>Fees</w:t><w:tab/><w:t>Schedule A</w:t></w:r></w:p>`;

  it("converts structure, formatting and signature lines to a PDF with real text", async () => {
    const body =
      para("Consulting Services Agreement", "", '<w:pStyle w:val="Heading1"/>') +
      para("This agreement is made between the parties named below.") +
      `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Bold words </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">italic words </w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>underlined words</w:t></w:r><w:r><w:br/><w:t>after a line break</w:t></w:r></w:p>` +
      para("Scope", "", '<w:pStyle w:val="Heading2"/>') +
      para("First numbered item", "", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>') +
      para("Nested lettered item", "", '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>') +
      para("Second numbered item", "", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>') +
      para("A bullet point", "", '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>') +
      `<w:tbl><w:tr><w:tc>${para("Service")}</w:tc><w:tc>${para("Fee")}</w:tc></w:tr><w:tr><w:tc>${para("Monthly retainer")}</w:tc><w:tc>${para("$1,500.00")}</w:tc></w:tr></w:tbl>` +
      para("Supercalifragilistic".repeat(12)) +
      `<w:p><w:r><w:br w:type="page"/></w:r></w:p>` +
      para("Signatures", "", '<w:pStyle w:val="Heading1"/>') +
      signatureBlock;
    const result = await ingestDocument({ bytes: await makeDocx(body), filename: "Consulting Agreement (draft).docx" });
    await expectSignable(result);
    expect(result.sourceKind).toBe("docx");
    expect(result.title).toBe("Consulting Agreement (draft)");
    expect(result.pages).toEqual([{ width: 612, height: 792 }, { width: 612, height: 792 }]);
    expect(result.warnings.join(" ")).toMatch(/layout was simplified/);
    expect(result.warnings.join(" ")).toMatch(/PDF to keep its exact layout/);

    const [first, second] = await pageTexts(result.pdf);
    for (const expected of [
      "Consulting Services Agreement", "made between the parties", "Bold words", "italic words", "underlined words",
      "after a line break", "First numbered item", "Nested lettered item", "Second numbered item", "A bullet point",
      "Service", "Monthly retainer", "$1,500.00", "1.", "2.", "a.", "Page 1 of 2",
    ]) {
      expect(first, expected).toContain(expected);
    }
    // The long word is broken across lines, not dropped or run off the page.
    expect(first.replace(/\s+/g, "")).toContain("Supercalifragilistic".repeat(12));
    expect(second).toContain("Signatures");
    expect(second).toContain("Page 2 of 2");
    expect(second).toMatch(/Client signature: _{30}/);
    expect(second).toMatch(/Signed:\s*_{16}/);
    expect(second).toMatch(/Dated:\s*_{10}/);
    expect(second).toMatch(/Name:\s*_{20,}/);
    expect(second).toMatch(/Fees\s*\.{20,}\s*Schedule A/);
  });

  it("embeds pictures and reports the ones it cannot", async () => {
    const drawing = (id: string) =>
      `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><wp:docPr id="1" name="Pic"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Pic"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    const rel = (id: string, target: string) =>
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/>`;
    const bytes = await makeDocx(para("Letterhead follows") + drawing("rIdP") + drawing("rIdG"), {
      media: { "logo.png": makePng(100, 50), "anim.gif": enc("GIF89a not really a gif") },
      documentRels: rel("rIdP", "media/logo.png") + rel("rIdG", "media/anim.gif"),
    });
    const result = await ingestDocument({ bytes, filename: "letter.docx" });
    const doc = await expectSignable(result);
    const images = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
    expect(images).toHaveLength(1);
    expect(result.warnings.join(" ")).toMatch(/One picture/);
  });

  it("paginates a long document and numbers the pages", async () => {
    const body = Array.from({ length: 400 }, (_, i) => para(`Clause ${i + 1}. The parties agree to the terms set out in this clause, which continue for long enough to wrap onto a second line of the page.`)).join("");
    const result = await ingestDocument({ bytes: await makeDocx(body), filename: "long.docx" });
    await expectSignable(result);
    expect(result.pages.length).toBeGreaterThan(10);
    const texts = await pageTexts(result.pdf);
    expect(texts[0]).toContain("Clause 1.");
    expect(texts.at(-1)).toContain("Clause 400.");
    expect(texts.at(-1)).toContain(`Page ${texts.length} of ${texts.length}`);
  });

  it("rejects empty, damaged and oversized Word files with specific errors", async () => {
    await expectError(ingestDocument({ bytes: await makeDocx(""), filename: "empty.docx" }), "empty");
    await expectError(ingestDocument({ bytes: await makeDocx("<w:p><w:r><w:t>   </w:t></w:r></w:p>"), filename: "blank.docx" }), "empty");
    const broken = await zipOf({ "[Content_Types].xml": "<Types/>", "word/document.xml": "<w:document><not closed" });
    await expectError(ingestDocument({ bytes: broken, filename: "broken.docx" }), "corrupt");
    const good = await makeDocx(para("Hello"));
    const truncated = await ingestDocument({ bytes: good.subarray(0, Math.floor(good.length * 0.6)), filename: "cut.docx" }).catch((e) => e);
    expect(truncated).toBeInstanceOf(DocumentError);

    const pages = Array.from({ length: LIMITS.maxPages + 5 }, (_, i) => para(`Page ${i}`)).join(`<w:p><w:r><w:br w:type="page"/></w:r></w:p>`);
    const error = await expectError(ingestDocument({ bytes: await makeDocx(pages), filename: "huge.docx" }), "too_many_pages");
    expect(error.message).toContain(String(LIMITS.maxPages));
  });
});

describe("ingestDocument: unsupported formats", () => {
  it("names the format and the fix", async () => {
    const cases: [string, Uint8Array, RegExp][] = [
      ["book.xlsx", await zipOf({ "[Content_Types].xml": "<Types/>", "xl/workbook.xml": "<workbook/>" }), /Excel/],
      ["deck.pptx", await zipOf({ "[Content_Types].xml": "<Types/>", "ppt/presentation.xml": "<p/>" }), /PowerPoint/],
      ["letter.pages", await zipOf({ "Index/Document.iwa": "x", "Metadata/Properties.plist": "x" }), /Pages/],
      ["letter.odt", await zipOf({ mimetype: "application/vnd.oasis.opendocument.text", "content.xml": "<x/>" }), /OpenDocument/],
      ["stuff.zip", await zipOf({ "readme.txt": "hello" }), /zip archive/],
      ["old.doc", Buffer.concat([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), new Uint8Array(600)]), /\.doc/],
      ["a.rtf", enc("{\\rtf1\\ansi Agreement text}"), /Rich Text/],
      ["a.gif", enc("GIF89a" + "\0".repeat(40)), /GIF/],
      ["a.webp", Buffer.concat([enc("RIFF"), new Uint8Array(4), enc("WEBPVP8 "), new Uint8Array(20)]), /WebP/],
      ["a.tiff", new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0, 0, 0, 0, 0]), /TIFF/],
      ["a.tif", new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 0, 0, 0]), /TIFF/],
      ["IMG_0001.HEIC", Buffer.concat([new Uint8Array([0, 0, 0, 0x18]), enc("ftypheic"), new Uint8Array(20)]), /HEIC/],
      ["clip.mp4", Buffer.concat([new Uint8Array([0, 0, 0, 0x18]), enc("ftypisom"), new Uint8Array(20)]), /video/],
      ["blob.bin", new Uint8Array([1, 2, 3, 0, 0, 7, 200, 201, 0, 5, 6, 0, 0, 0, 9]), /not a document/],
    ];
    for (const [filename, bytes, pattern] of cases) {
      // The claimed type is a PDF throughout: it must not sway the decision.
      const error = await expectError(ingestDocument({ bytes, filename, mimeType: "application/pdf" }), "unsupported_type");
      expect(error.message, filename).toMatch(pattern);
      expect(error.message, filename).toContain("Save it as PDF or .docx and upload again.");
    }
  });
});

describe("ingestDocument: images", () => {
  it("places a PNG on one Letter page inside the margins", async () => {
    const result = await ingestDocument({ bytes: makePng(300, 400), filename: "signed scan.PNG" });
    const doc = await expectSignable(result);
    expect(result.sourceKind).toBe("image");
    expect(result.title).toBe("signed scan");
    expect(result.pages).toEqual([{ width: 612, height: 792 }]);
    expect(doc.getPageCount()).toBe(1);
  });

  it("uses a landscape page for wide images and respects EXIF orientation", async () => {
    const wide = await ingestDocument({ bytes: makeJpeg(400, 200), filename: "wide.jpg" });
    expect(wide.pages).toEqual([{ width: 792, height: 612 }]);
    // The same pixels flagged "rotate 90 degrees" are a portrait picture.
    const turned = await ingestDocument({ bytes: makeJpeg(400, 200, 6), filename: "phone.jpeg" });
    expect(turned.pages).toEqual([{ width: 612, height: 792 }]);
    await expectSignable(turned);
    expect(jpegInfo(makeJpeg(400, 200, 8))).toEqual({ size: { width: 400, height: 200 }, orientation: 8 });
    expect(jpegInfo(makeJpeg(400, 200))).toEqual({ size: { width: 400, height: 200 }, orientation: 1 });

    // Orientation 6 on a 400x200 image: drawn 2:1 tall, with a rotation matrix.
    const doc = await PDFDocument.load(turned.pdf);
    const contents = doc.getPage(0).node.Contents();
    const streams: PDFStream[] = [];
    if (contents instanceof PDFStream) streams.push(contents);
    else if (contents) for (let i = 0; i < contents.size(); i++) streams.push(contents.lookup(i) as PDFStream);
    const ops = streams.map((s) => Buffer.from(inflateMaybe(s)).toString("latin1")).join("\n");
    const cm = /([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm/.exec(ops)!.slice(1).map(Number);
    expect(cm[0]).toBeCloseTo(0);
    expect(cm[3]).toBeCloseTo(0);
    expect(cm[2]).toBeCloseTo(200); // displayed width
    expect(cm[1]).toBeCloseTo(-400); // displayed height, top to bottom
  });

  it("rejects damaged and absurdly large images", async () => {
    await expectError(ingestDocument({ bytes: makePng(20, 20).subarray(0, 40), filename: "cut.png" }), "corrupt");
    await expectError(ingestDocument({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2]), filename: "cut.jpg" }), "corrupt");
    const huge = makePng(1, 1);
    new DataView(huge.buffer, huge.byteOffset).setUint32(16, 60000);
    new DataView(huge.buffer, huge.byteOffset).setUint32(20, 60000);
    await expectError(ingestDocument({ bytes: huge, filename: "huge.png" }), "too_large");
  });
});

function inflateMaybe(stream: PDFStream): Uint8Array {
  const raw = stream.getContents();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("node:zlib").inflateSync(raw);
  } catch {
    return raw;
  }
}

describe("ingestDocument: text and HTML", () => {
  const agreement = "SERVICES AGREEMENT\n\nThe client agrees to the terms below.\nSecond line of the same paragraph.\n\n\n\nSignature: ____________________\tDate: __________\nPrinted name:    ____________________\n";

  it("typesets UTF-8 text, keeping underscores and paragraphs", async () => {
    const result = await ingestDocument({ bytes: enc(agreement), filename: "terms.txt", mimeType: "text/plain" });
    await expectSignable(result);
    expect(result.sourceKind).toBe("text");
    expect(result.title).toBe("terms");
    expect(result.warnings).toEqual([]);
    const text = await allText(result.pdf);
    expect(text).toContain("SERVICES AGREEMENT");
    expect(text).toContain("Second line of the same paragraph.");
    expect(text).toMatch(/Signature: _{20}\s+Date: _{10}/);
    expect(text).toMatch(/Printed name:\s+_{20}/);
  });

  it("reads UTF-16 with a BOM in either byte order, UTF-8 with a BOM, and legacy Windows text", async () => {
    const utf16 = (s: string, little: boolean) => {
      const out = new Uint8Array(2 + s.length * 2);
      const view = new DataView(out.buffer);
      view.setUint16(0, 0xfeff, little);
      for (let i = 0; i < s.length; i++) view.setUint16(2 + i * 2, s.charCodeAt(i), little);
      return out;
    };
    const sample = "Caf\u00e9 Agreement \u2013 sign here: __________";
    for (const bytes of [utf16(sample, true), utf16(sample, false), Buffer.concat([new Uint8Array([0xef, 0xbb, 0xbf]), enc(sample)])]) {
      const result = await ingestDocument({ bytes, filename: "a.txt" });
      const text = await allText(result.pdf);
      expect(text).toContain("Caf\u00e9 Agreement \u2013 sign here: __________");
      expect(result.warnings).toEqual([]);
    }
    const latin = await ingestDocument({ bytes: new Uint8Array([...enc("Caf"), 0xe9, ...enc(" terms: ____")]), filename: "a.txt" });
    expect(await allText(latin.pdf)).toContain("Caf\u00e9 terms: ____");
    const noBom = utf16("Plain agreement text ______", true).subarray(2);
    expect(await allText((await ingestDocument({ bytes: noBom, filename: "a.txt" })).pdf)).toContain("Plain agreement text ______");
  });

  it("rejects empty and whitespace-only input", async () => {
    await expectError(ingestDocument({ bytes: new Uint8Array(0), filename: "a.pdf" }), "empty");
    await expectError(ingestDocument({ bytes: enc("  \n\t\r\n  "), filename: "a.txt" }), "empty");
    await expectError(ingestDocument({ bytes: new Uint8Array([0xef, 0xbb, 0xbf, 0x20, 0x0a]), filename: "a.txt" }), "empty");
    await expectError(ingestDocument({ bytes: enc("<html><body><script>var a = 1;</script>  </body></html>"), filename: "a.html" }), "empty");
    await expectError(ingestDocument({ bytes: undefined as unknown as Uint8Array, filename: "a.pdf" }), "empty");
    await expectError(ingestText("   \n ", "x"), "empty");
    await expectError(ingestText(undefined as unknown as string, "x"), "empty");
  });

  it("typesets HTML: structure kept, scripts never shown, remote images never fetched", async () => {
    const html = `<!DOCTYPE html><html><head><title>Client Engagement Terms</title><style>p { color: red }</style>
      <script>document.write("INJECTED-BY-SCRIPT")</script></head><body onload="alert(1)">
      <h1>Engagement Terms</h1>
      <p>These terms apply to <b>every</b> <i>file</i> &amp; <u>engagement</u>.<br>Second line.</p>
      <ol><li>First<ul><li>Inner bullet</li></ul></li><li>Second</li></ol>
      <table><tr><th>Item</th><th>Price</th></tr><tr><td>Setup</td><td>$200</td></tr></table>
      <p style="display:none">HIDDEN-TEXT</p>
      <img src="https://example.com/tracker.png"><img src="data:image/png;base64,${Buffer.from(makePng(40, 20)).toString("base64")}">
      <p>Signature: <input type="text" name="sig"> ________________</p>
      <div style="page-break-before: always">Last page text</div>
      </body></html>`;
    // Named .txt on purpose: HTML is recognised from the content.
    const result = await ingestDocument({ bytes: enc(html), filename: "export.txt" });
    await expectSignable(result);
    expect(result.sourceKind).toBe("html");
    expect(result.title).toBe("Client Engagement Terms");
    expect(result.pages).toHaveLength(2);
    const [first, second] = await pageTexts(result.pdf);
    for (const expected of ["Engagement Terms", "every", "file & engagement", "Second line.", "1.", "First", "Inner bullet", "2.", "Second", "Item", "Price", "Setup", "$200"]) {
      expect(first, expected).toContain(expected);
    }
    expect(first).toMatch(/Signature: _{20} _{16}/);
    expect(first).not.toContain("INJECTED-BY-SCRIPT");
    expect(first).not.toContain("HIDDEN-TEXT");
    expect(first).not.toContain("color: red");
    expect(second).toContain("Last page text");
    expect(result.warnings.join(" ")).toMatch(/One picture/);
    expect(result.warnings.join(" ")).toMatch(/layout was simplified/);
  });

  it("warns when characters cannot be shown instead of failing", async () => {
    const result = await ingestDocument({ bytes: enc("Agreement \u5408\u540c \u0627\u062a\u0641\u0627\u0642 signature: ______"), filename: "a.txt" });
    await expectSignable(result);
    expect(result.warnings.join(" ")).toMatch(/could not be shown/);
    expect(await allText(result.pdf)).toContain("signature: ______");
  });

  it("ingestText produces a text PDF with the given title", async () => {
    const result = await ingestText(agreement, "  Standard\u0000 Terms \n");
    const doc = await expectSignable(result);
    expect(result.title).toBe("Standard Terms");
    expect(doc.getTitle()).toBe("Standard Terms");
    expect(result.sourceKind).toBe("text");
    expect((await ingestText("Some text", "")).title).toBe("Agreement");
    expect(await allText(result.pdf)).toMatch(/Signature: _{20}/);
  });
});

describe("ingestPageImages", () => {
  it("builds one page per image at the given size", async () => {
    const result = await ingestPageImages(
      [
        { bytes: makePng(60, 80), widthPt: 612, heightPt: 792 },
        { bytes: makeJpeg(200, 100), widthPt: 841.89, heightPt: 595.28 },
        { bytes: makePng(50, 100), widthPt: Number.NaN, heightPt: -5 },
      ],
      " Locked Agreement ",
    );
    await expectSignable(result);
    expect(result.sourceKind).toBe("pdf");
    expect(result.title).toBe("Locked Agreement");
    expect(result.pages[0]).toEqual({ width: 612, height: 792 });
    expect(result.pages[1].width).toBeCloseTo(841.89, 1);
    expect(result.pages[1].height).toBeCloseTo(595.28, 1);
    expect(result.pages[2]).toEqual({ width: 612, height: 1224 });
    expect(result.warnings.join(" ")).toMatch(/placed by hand/);
  });

  it("rejects no pages, too many pages and things that are not images", async () => {
    await expectError(ingestPageImages([], "x"), "empty");
    await expectError(ingestPageImages(undefined as unknown as [], "x"), "empty");
    const one = { bytes: makePng(2, 2), widthPt: 100, heightPt: 100 };
    await expectError(ingestPageImages(Array(LIMITS.maxPages + 1).fill(one), "x"), "too_many_pages");
    await expectError(ingestPageImages([{ bytes: enc("<svg/>"), widthPt: 100, heightPt: 100 }], "x"), "corrupt");
    await expectError(ingestPageImages([{ bytes: new Uint8Array(0), widthPt: 100, heightPt: 100 }], "x"), "corrupt");
    await expectError(ingestPageImages([null as unknown as { bytes: Uint8Array; widthPt: number; heightPt: number }], "x"), "corrupt");
  });
});

describe("typeset", () => {
  it("stops at the page limit", async () => {
    const pages = Array.from({ length: 12 }, (_, i) => `Page ${i}`).join("\f");
    await expectError(typesetText(pages, { maxPages: 10 }), "too_many_pages");
    const ok = await typesetText(pages, { maxPages: 12 });
    expect(ok.pageCount).toBe(12);
  });

  it("survives hostile markup", async () => {
    const deep = "<div>".repeat(20000) + "deep text" + "</div>".repeat(20000);
    const nested = await typesetHtml(deep);
    expect(await allText(nested.pdf)).toContain("deep text");

    const cases = [
      "<table><tr><td>" + "<table><tr><td>x</td></tr></table>".repeat(50) + "</td></tr></table>",
      "<table>" + "<tr>" + "<td>c</td>".repeat(80) + "</tr>".repeat(3) + "</table>",
      "<table><tr><td rowspan='999999' colspan='-4'>a</td><td colspan='99999'>b</td></tr><tr><td>c</td></tr></table>",
      "<ul><li><li><ol start='-5' type='i'><li value='abc'>x</ol></ul></li></li>",
      "<p><b><i><u>unclosed <table><tr><td>cell <p>para",
      "<img src='data:image/png;base64,AAAA'><img src='data:,'><img><img src='data:image/jpeg;base64,/9j/'>",
      "<td>orphan cell</td><li>orphan item</li><tr><th>h</th></tr>",
      "<pre>  keep   these\n\tspaces\n\n</pre><hr><hr class='page-break'><br><br><br>",
      "<h1></h1><p></p><ol></ol><table></table><table><tr></tr></table>text",
      "&nbsp;&#x1F600;&#0;&bogus;\u0000\u0001\ufffe\ud83d text",
      "<table><tr><td>" + "word ".repeat(6000) + "</td><td>" + "W".repeat(3000) + "</td></tr></table>",
    ];
    for (const html of cases) {
      const result = await typesetHtml(html, { preserveTabs: true, keepEmptyParagraphs: true });
      const doc = await PDFDocument.load(result.pdf);
      expect(doc.getPageCount(), html.slice(0, 40)).toBe(result.pageCount);
    }
  });

  it("splits a table row that is taller than a page across pages without losing text", async () => {
    const words = Array.from({ length: 1500 }, (_, i) => `w${i}`);
    const result = await typesetHtml(`<table><tr><td>${words.join(" ")}</td><td>side</td></tr></table><p>after the table</p>`);
    expect(result.pageCount).toBeGreaterThan(1);
    const text = (await allText(result.pdf)).split(/\s+/);
    for (const probe of ["w0", "w700", "w1499", "side", "after"]) expect(text).toContain(probe);
  });

  it("keeps a row of underscores longer than the line by wrapping it", async () => {
    const result = await typesetText("Sign: " + "_".repeat(300));
    const text = await allText(result.pdf);
    expect((text.match(/_/g) ?? []).length).toBe(300);
    expect(result.pageCount).toBe(1);
  });
});

describe("robustness", () => {
  it("never throws anything but DocumentError on arbitrary bytes", async () => {
    // Deterministic pseudo-random data so a failure can be reproduced.
    let seed = 20261115;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const noise = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));
    const pdf = await simplePdf({ pages: 2 });
    const docx = await makeDocx(para("Hello"));
    const png = makePng(10, 10);
    const jpg = makeJpeg(10, 10, 3);
    const heads = ["%PDF-1.7\n", "PK\u0003\u0004", "\u0089PNG\r\n\u001a\n", "\u00ff\u00d8\u00ff\u00e1", "<html>", "{\\rtf1", "\u00ff\u00fe", "\u00fe\u00ff", "II*\u0000", ""];
    const inputs: Uint8Array[] = [];
    for (const head of heads) {
      for (const size of [0, 1, 7, 64, 900, 5000]) inputs.push(Buffer.concat([Buffer.from(head, "latin1"), noise(size)]));
    }
    for (const source of [pdf, docx, png, jpg]) {
      for (let i = 0; i < 12; i++) {
        const copy = new Uint8Array(source);
        // Flip a few bytes, sometimes also cut the tail off.
        for (let k = 0; k < 6; k++) copy[Math.floor(rand() * copy.length)] = Math.floor(rand() * 256);
        inputs.push(rand() < 0.5 ? copy : copy.subarray(0, Math.floor(copy.length * rand())));
      }
    }
    let ok = 0;
    for (const bytes of inputs) {
      try {
        const result = await ingestDocument({ bytes, filename: "x" });
        expect(result.pages.length).toBeGreaterThan(0);
        await PDFDocument.load(result.pdf);
        ok += 1;
      } catch (error) {
        if (!(error instanceof DocumentError)) throw error;
        expect(error.message.length).toBeGreaterThan(20);
      }
    }
    // Lightly damaged files are mostly still usable; this guards against rejecting everything.
    expect(ok).toBeGreaterThan(5);
  }, 120_000);

  it("lists zip entries from intact and cut-off archives", async () => {
    const zip = await zipOf({ "word/document.xml": "<x/>", "other.txt": "y" });
    const files = (bytes: Uint8Array) => listZipEntries(bytes).map((e) => e.name).filter((n) => !n.endsWith("/"));
    expect(files(zip)).toEqual(["word/document.xml", "other.txt"]);
    expect(files(zip.subarray(0, 90))).toEqual(["word/document.xml"]);
    expect(listZipEntries(new Uint8Array([0x50, 0x4b, 3, 4]))).toEqual([]);
  });
});
