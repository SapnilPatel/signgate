/**
 * Regression tests for layouts that independent reviewers broke the detector with:
 * party names printed under labelled lines, bordered signature tables, blocks split
 * by a page break, header and footer rules, witness blocks, wrapped recitals,
 * agreements that call the client "Company", and documents with far too many blanks.
 * Every fixture is drawn here with pdf-lib; all names are test data.
 */
import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { detectFields, detectFieldsWith } from "@/lib/pdf/detect";
import { findDefinedTerms, isWitnessHeading } from "@/lib/pdf/detect/labels";
import type { DetectionResult } from "@/lib/pdf/types";
import type { Field, FieldRole, FieldType } from "@/lib/types";
import { LIMITS } from "@/lib/types";

const SENDER = "Astra AI, LLC";
const LINE = "______________________";

class Sheet {
  constructor(
    readonly page: PDFPage,
    readonly font: PDFFont,
    readonly width: number,
    readonly height: number,
  ) {}
  text(value: string, x: number, top: number, size = 11) {
    this.page.drawText(value, { x, y: this.height - top, size, font: this.font });
    return this;
  }
  rule(x0: number, x1: number, top: number) {
    this.page.drawLine({ start: { x: x0, y: this.height - top }, end: { x: x1, y: this.height - top }, thickness: 0.75 });
    return this;
  }
  vrule(x: number, top0: number, top1: number) {
    this.page.drawLine({ start: { x, y: this.height - top0 }, end: { x, y: this.height - top1 }, thickness: 0.75 });
    return this;
  }
  /** A bordered table drawn the way Word exports one: every cell edge as its own line. */
  table(xs: number[], tops: number[]) {
    for (const top of tops) this.rule(xs[0], xs[xs.length - 1], top);
    for (const x of xs) this.vrule(x, tops[0], tops[tops.length - 1]);
    return this;
  }
  /** The same table drawn as one stroked rectangle per cell. */
  tableOfBoxes(xs: number[], tops: number[]) {
    for (let r = 0; r + 1 < tops.length; r++) {
      for (let c = 0; c + 1 < xs.length; c++) {
        this.page.drawRectangle({ x: xs[c], y: this.height - tops[r + 1], width: xs[c + 1] - xs[c], height: tops[r + 1] - tops[r], borderWidth: 0.75 });
      }
    }
    return this;
  }
  after(prefix: string, x: number, size = 11) {
    return x + this.font.widthOfTextAtSize(prefix, size);
  }
}

async function build(draw: (add: (size?: [number, number]) => Sheet) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  draw((size = [612, 792]) => new Sheet(doc.addPage(size), font, size[0], size[1]));
  return new Uint8Array(await doc.save());
}

const of = (r: DetectionResult, type: FieldType, role?: FieldRole, page?: number) =>
  r.fields.filter((f) => f.type === type && (role === undefined || f.role === role) && (page === undefined || f.page === page));

/** The field box in points from the top-left of its page. */
function box(r: DetectionResult, f: Field) {
  const p = r.pages[f.page];
  return { x0: f.x * p.width, x1: (f.x + f.w) * p.width, y0: f.y * p.height, y1: (f.y + f.h) * p.height };
}

function expectInside(r: DetectionResult, f: Field | undefined, x0: number, x1: number, top: number, bottom: number) {
  expect(f, "field exists").toBeDefined();
  const b = box(r, f!);
  expect(b.x0, "left edge inside the cell").toBeGreaterThanOrEqual(x0 - 1);
  expect(b.x1, "right edge inside the cell").toBeLessThanOrEqual(x1 + 1);
  expect(b.y0, "top edge inside the cell").toBeGreaterThanOrEqual(top - 1);
  expect(b.y1, "bottom edge inside the cell").toBeLessThanOrEqual(bottom + 1);
}

function expectBottom(r: DetectionResult, f: Field | undefined, top: number, tolerance = 5) {
  expect(f, "field exists").toBeDefined();
  expect(Math.abs(box(r, f!).y1 - top)).toBeLessThanOrEqual(tolerance);
}

const body = (s: Sheet) =>
  s
    .text("SERVICES AGREEMENT", 72, 80, 16)
    .text("The parties agree to the terms set out in this agreement and to everything in its schedules.", 72, 120)
    .text("Each party has read this agreement in full and signs it of its own free will on the date below.", 72, 136)
    .text("This agreement is governed by the laws of the place where the services are mainly performed.", 72, 152);

describe("party name printed under a labelled signature line", () => {
  for (const label of ["By: ", "X", "Signature: "]) {
    for (const clientFirst of [true, false]) {
      it(`reads "${label.trim()}" lines captioned underneath, ${clientFirst ? "client" : "company"} first`, async () => {
        const first = clientFirst ? "Client" : SENDER;
        const second = clientFirst ? SENDER : "Client";
        const pdf = await build((add) => {
          const s = body(add());
          s.text(`${label}${LINE}`, 72, 400).text(first, 72, 415);
          s.text(`${label}${LINE}`, 72, 470).text(second, 72, 485);
        });
        const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
        const sigs = of(r, "signature");
        expect(sigs).toHaveLength(2);
        const upper = sigs.find((f) => Math.abs(box(r, f).y1 - 401) < 6)!;
        const lower = sigs.find((f) => Math.abs(box(r, f).y1 - 471) < 6)!;
        expect(upper.role).toBe(clientFirst ? "client" : "company");
        expect(lower.role).toBe(clientFirst ? "company" : "client");
        // The names said whose line is whose, so nothing was guessed.
        expect(r.meta.notes.join(" ")).not.toMatch(/does not say which block/);
        expect(r.meta.signaturePageAppended).toBe(false);
      });
    }
  }

  it("keeps evenly spaced captions with their own line, not the next one", async () => {
    const pdf = await build((add) => {
      const s = body(add());
      s.text(`By: ${LINE}`, 72, 400).text(SENDER, 72, 420).text(`By: ${LINE}`, 72, 440).text("Client", 72, 460);
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    const sigs = of(r, "signature").sort((a, b) => a.y - b.y);
    expect(sigs.map((f) => f.role)).toEqual(["company", "client"]);
  });

  it("reads two columns with the names underneath and gives each party its own date", async () => {
    const pdf = await build((add) => {
      const s = body(add());
      s.text(`By: ${LINE}`, 72, 400).text(`By: ${LINE}`, 330, 400);
      s.text("Client", 72, 418).text(SENDER, 330, 418);
      s.text(`Name: ${LINE}`, 72, 446).text(`Name: ${LINE}`, 330, 446);
      s.text(`Title: ${LINE}`, 72, 474).text(`Title: ${LINE}`, 330, 474);
      s.text(`Date: ${LINE}`, 72, 502).text(`Date: ${LINE}`, 330, 502);
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    for (const [role, left] of [
      ["client", true],
      ["company", false],
    ] as const) {
      for (const type of ["signature", "full_name", "title", "date_signed"] as const) {
        const found = of(r, type, role);
        expect(found, `${role} ${type}`).toHaveLength(1);
        expect(box(r, found[0]).x0 < 306, `${role} ${type} column`).toBe(left);
      }
    }
    expect(r.fields.filter((f) => f.role === "prefill")).toHaveLength(0);
    expect(r.fields).toHaveLength(8);
  });

  it("still treats a party name as the heading of the block below when it sits with that block", async () => {
    const pdf = await build((add) => {
      const s = body(add());
      s.text("CLIENT", 72, 380).text(`Signature: ${LINE}`, 72, 400).text(`Date: ${LINE}`, 72, 428);
      s.text("NORTHWIND STUDIO", 72, 500).text(`By: ${LINE}`, 72, 520).text(`Date: ${LINE}`, 72, 548);
    });
    const r = await detectFields(pdf, { companyName: "Northwind Studio", useAI: false });
    const sigs = of(r, "signature").sort((a, b) => a.y - b.y);
    expect(sigs.map((f) => f.role)).toEqual(["client", "company"]);
    expect(of(r, "date_signed", "client")).toHaveLength(1);
    expect(of(r, "date_signed", "company")).toHaveLength(1);
  });
});

describe("signature blocks laid out as bordered tables", () => {
  const xs2 = [72, 222, 540];
  const rows = [200, 245, 275, 305];

  for (const style of ["lines", "boxes"] as const) {
    it(`puts each field in the empty cell beside its label (drawn as ${style})`, async () => {
      const pdf = await build((add) => {
        const s = body(add());
        if (style === "lines") s.table(xs2, rows);
        else s.tableOfBoxes(xs2, rows);
        s.text("Client Signature", 78, 226).text("Printed Name", 78, 264).text("Date", 78, 294);
      });
      const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
      expect(r.fields).toHaveLength(3);
      expectInside(r, of(r, "signature", "client")[0], 222, 540, 200, 245);
      expectInside(r, of(r, "full_name", "client")[0], 222, 540, 245, 275);
      expectInside(r, of(r, "date_signed", "client")[0], 222, 540, 275, 305);
      // Nothing is stamped automatically into a signature table.
      expect(r.fields.filter((f) => f.role === "prefill")).toHaveLength(0);
      expect(r.meta.signaturePageAppended).toBe(false);
    });
  }

  it("reads two party columns under a header row", async () => {
    const xs = [72, 306, 540];
    const tops = [200, 226, 262, 290, 318];
    const pdf = await build((add) => {
      const s = body(add());
      s.table(xs, tops);
      s.text("ASTRA AI, LLC", 78, 217).text("CLIENT", 312, 217);
      s.text("By:", 78, 250).text("By:", 312, 250);
      s.text("Name:", 78, 280).text("Name:", 312, 280);
      s.text("Date:", 78, 308).text("Date:", 312, 308);
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    expect(r.fields).toHaveLength(6);
    expectInside(r, of(r, "signature", "company")[0], 72, 306, 226, 262);
    expectInside(r, of(r, "signature", "client")[0], 306, 540, 226, 262);
    expectInside(r, of(r, "full_name", "company")[0], 72, 306, 262, 290);
    expectInside(r, of(r, "full_name", "client")[0], 306, 540, 262, 290);
    expectInside(r, of(r, "date_signed", "company")[0], 72, 306, 290, 318);
    expectInside(r, of(r, "date_signed", "client")[0], 306, 540, 290, 318);
    expect(of(r, "signature", "client")).toHaveLength(1);
    // The header cells hold the party names and nothing else.
    expect(r.fields.every((f) => box(r, f).y0 >= 225)).toBe(true);
  });

  it("uses the empty part of a tall cell under a small label", async () => {
    const pdf = await build((add) => {
      const s = body(add());
      s.table([72, 306, 540], [200, 290]);
      s.text("Company signature", 78, 214, 9).text("Client signature", 312, 214, 9);
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    expect(r.fields).toHaveLength(2);
    const company = of(r, "signature", "company")[0];
    const client = of(r, "signature", "client")[0];
    expectInside(r, company, 72, 306, 214, 290);
    expectInside(r, client, 306, 540, 214, 290);
    expect(box(r, client).y1 - box(r, client).y0).toBeGreaterThanOrEqual(24);
  });

  it("reads a four-column label | blank | label | blank grid row by row", async () => {
    const xs = [72, 150, 306, 384, 540];
    const tops = [200, 240, 270];
    const pdf = await build((add) => {
      const s = body(add());
      s.table(xs, tops);
      s.text("Signature", 78, 224).text("Date", 312, 224);
      s.text("Print name", 78, 259).text("Title", 312, 259);
    });
    const r = await detectFields(pdf, { useAI: false });
    expect(r.fields).toHaveLength(4);
    expectInside(r, of(r, "signature", "client")[0], 150, 306, 200, 240);
    expectInside(r, of(r, "date_signed", "client")[0], 384, 540, 200, 240);
    expectInside(r, of(r, "full_name", "client")[0], 150, 306, 240, 270);
    expectInside(r, of(r, "title", "client")[0], 384, 540, 240, 270);
  });

  it("reads one table per party, each under a header row that spans the table", async () => {
    const pdf = await build((add) => {
      const s = body(add());
      for (const [top, name] of [
        [300, "CLIENT"],
        [420, "ASTRA AI, LLC"],
      ] as const) {
        for (const y of [top, top + 24, top + 60, top + 88]) s.rule(72, 540, y);
        s.vrule(72, top, top + 88).vrule(540, top, top + 88).vrule(200, top + 24, top + 88);
        s.text(name, 78, top + 16).text("Signature", 78, top + 48).text("Date", 78, top + 78);
      }
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    expect(r.fields).toHaveLength(4);
    expectInside(r, of(r, "signature", "client")[0], 200, 540, 324, 360);
    expectInside(r, of(r, "date_signed", "client")[0], 200, 540, 360, 388);
    expectInside(r, of(r, "signature", "company")[0], 200, 540, 444, 480);
    expectInside(r, of(r, "date_signed", "company")[0], 200, 540, 480, 508);
    expect(r.meta.notes.join(" ")).not.toMatch(/does not say which block/);
  });

  it("reads a table drawn without its outer sides", async () => {
    const pdf = await build((add) => {
      const s = body(add());
      for (const y of [300, 336, 366, 396]) s.rule(72, 540, y);
      s.vrule(222, 300, 396);
      s.text("Client Signature", 78, 322).text("Printed Name", 78, 356).text("Date", 78, 386);
    });
    const r = await detectFields(pdf, { useAI: false });
    expect(r.fields).toHaveLength(3);
    expectInside(r, of(r, "signature", "client")[0], 222, 540, 300, 336);
    expectInside(r, of(r, "full_name", "client")[0], 222, 540, 336, 366);
    expectInside(r, of(r, "date_signed", "client")[0], 222, 540, 366, 396);
  });

  it("uses the one empty row under a row of column headings, but not a sign-in sheet", async () => {
    const one = await build((add) => {
      const s = body(add());
      s.table([72, 300, 420, 540], [300, 322, 362]);
      s.text("Client Signature", 78, 315).text("Print Name", 306, 315).text("Date", 426, 315);
    });
    const r = await detectFields(one, { useAI: false });
    expect(r.fields).toHaveLength(3);
    expectInside(r, of(r, "signature", "client")[0], 72, 300, 322, 362);
    expectInside(r, of(r, "full_name", "client")[0], 300, 420, 322, 362);
    expectInside(r, of(r, "date_signed", "client")[0], 420, 540, 322, 362);

    const sheet = await build((add) => {
      const s = body(add());
      s.table([72, 300, 420, 540], [300, 322, 346, 370, 394, 418]);
      s.text("Name", 78, 315).text("Signature", 306, 315).text("Date", 426, 315);
    });
    const many = await detectFields(sheet, { useAI: false });
    // Nobody's block: the client signs on the added page instead of in row one of a list.
    expect(many.fields.every((f) => f.source === "appended")).toBe(true);
    expect(many.meta.signaturePageAppended).toBe(true);
  });

  it("signs inside an empty box drawn under its label", async () => {
    const pdf = await build((add) => {
      const s = body(add());
      s.text("Client signature:", 72, 300);
      s.page.drawRectangle({ x: 72, y: 792 - 370, width: 250, height: 60, borderWidth: 0.75 });
      s.text("Date:", 72, 400);
      s.page.drawRectangle({ x: 72, y: 792 - 434, width: 250, height: 24, borderWidth: 0.75 });
    });
    const r = await detectFields(pdf, { useAI: false });
    expect(r.fields).toHaveLength(2);
    expectInside(r, of(r, "signature", "client")[0], 72, 322, 310, 370);
    expectInside(r, of(r, "date_signed", "client")[0], 72, 322, 410, 434);
  });

  it("signs in the empty part of a box that holds only a party's name", async () => {
    const pdf = await build((add) => {
      const s = body(add());
      s.page.drawRectangle({ x: 72, y: 792 - 380, width: 220, height: 80, borderWidth: 0.75 });
      s.page.drawRectangle({ x: 320, y: 792 - 380, width: 220, height: 80, borderWidth: 0.75 });
      s.text("Client", 78, 314, 9).text(SENDER, 326, 314, 9);
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    expect(r.fields).toHaveLength(2);
    expectInside(r, of(r, "signature", "client")[0], 72, 292, 314, 380);
    expectInside(r, of(r, "signature", "company")[0], 320, 540, 314, 380);
  });

  it("does not turn the borders of a pricing table into fields", async () => {
    const pdf = await build((add) => {
      const s = body(add());
      s.table([72, 300, 420, 540], [200, 224, 248, 272]);
      s.text("Service", 78, 216).text("Hours", 306, 216).text("Fee", 426, 216);
      s.text("Discovery workshop", 78, 240).text("12", 306, 240).text("$1,800", 426, 240);
      s.text("Implementation", 78, 264).text("40", 306, 264).text("$6,000", 426, 264);
      s.text(`Client signature: ${LINE}`, 72, 500);
    });
    const r = await detectFields(pdf, { useAI: false });
    expect(r.fields).toHaveLength(1);
    expectBottom(r, of(r, "signature", "client")[0], 501);
  });

  it("still finds an underscore line typed inside a bordered cell", async () => {
    const pdf = await build((add) => {
      const s = body(add());
      s.table([72, 540], [380, 470]);
      s.text("CLIENT", 80, 400).text(`Signature: ${LINE}`, 80, 430).text(`Date: ${LINE}`, 80, 455);
    });
    const r = await detectFields(pdf, { useAI: false });
    expectBottom(r, of(r, "signature", "client")[0], 431);
    expectBottom(r, of(r, "date_signed", "client")[0], 456);
    expect(r.fields).toHaveLength(2);
  });
});

describe("signature block split across a page break", () => {
  it("keeps the company's Title and Date lines with the company block from the page before", async () => {
    const pdf = await build((add) => {
      const a = body(add());
      a.text("IN WITNESS WHEREOF the parties have signed this agreement.", 72, 600);
      a.text("ASTRA AI, LLC", 72, 640).text(`By: ${LINE}`, 72, 670).text(`Name: ${LINE}`, 72, 700);
      a.text("Page 1 of 2", 280, 760, 9);
      const b = add();
      b.text(`Title: ${LINE}`, 72, 90).text(`Date: ${LINE}`, 72, 120);
      b.text("CLIENT", 72, 200).text(`By: ${LINE}`, 72, 230).text(`Name: ${LINE}`, 72, 260).text(`Date: ${LINE}`, 72, 290);
      b.text("Page 2 of 2", 280, 760, 9);
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    expect(of(r, "signature", "company", 0)).toHaveLength(1);
    expect(of(r, "full_name", "company", 0)).toHaveLength(1);
    const title = of(r, "title", "company", 1);
    const date = of(r, "date_signed", "company", 1);
    expect(title).toHaveLength(1);
    expect(date).toHaveLength(1);
    expectBottom(r, title[0], 91);
    expectBottom(r, date[0], 121);
    // Nothing of the client's, and no send date, is stamped onto the company's lines.
    expect(r.fields.filter((f) => f.role === "prefill")).toHaveLength(0);
    expect(of(r, "signature", "client", 1)).toHaveLength(1);
    expect(of(r, "date_signed", "client", 1)).toHaveLength(1);
    expect(r.fields).toHaveLength(7);
  });

  it("continues a two-column block onto the next page, each column with its own party", async () => {
    const pdf = await build((add) => {
      const a = body(add());
      a.text("CLIENT", 72, 650).text("ASTRA AI, LLC", 330, 650);
      a.text(`By: ${LINE}`, 72, 690).text(`By: ${LINE}`, 330, 690);
      a.text("Page 1 of 2", 280, 760, 9);
      const b = add();
      b.text(`Name: ${LINE}`, 72, 90).text(`Name: ${LINE}`, 330, 90);
      b.text(`Date: ${LINE}`, 72, 120).text(`Date: ${LINE}`, 330, 120);
      b.text("Page 2 of 2", 280, 760, 9);
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    expect(r.fields).toHaveLength(6);
    for (const [role, left] of [
      ["client", true],
      ["company", false],
    ] as const) {
      for (const type of ["full_name", "date_signed"] as const) {
        const found = of(r, type, role, 1);
        expect(found, `${role} ${type}`).toHaveLength(1);
        expect(box(r, found[0]).x0 < 306).toBe(left);
      }
    }
  });

  it("is not misled by a running header that names the sender", async () => {
    const pdf = await build((add) => {
      const a = body(add());
      a.text("Astra AI, LLC - Services Agreement", 72, 40, 9).rule(72, 540, 46);
      a.text("CLIENT", 72, 560).text(`By: ${LINE}`, 72, 590).text(`Name: ${LINE}`, 72, 620);
      a.text("ASTRA AI, LLC", 72, 660).text(`By: ${LINE}`, 72, 690).text(`Name: ${LINE}`, 72, 715);
      a.text("Page 1", 290, 770, 9);
      const b = add();
      b.text("Astra AI, LLC - Services Agreement", 72, 40, 9).rule(72, 540, 46);
      b.text(`Title: ${LINE}`, 72, 90).text(`Date: ${LINE}`, 72, 120);
      b.text("Page 2", 290, 770, 9);
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    expect(of(r, "title", "company", 1)).toHaveLength(1);
    expect(of(r, "date_signed", "company", 1)).toHaveLength(1);
    expect(r.fields.filter((f) => f.page === 1)).toHaveLength(2);
    expect(of(r, "signature", "client", 0)).toHaveLength(1);
    expect(of(r, "signature", "company", 0)).toHaveLength(1);
    expect(r.fields.filter((f) => f.role === "prefill")).toHaveLength(0);
  });

  it("does not take a running footer that names the sender as the heading of the next page's block", async () => {
    const pdf = await build((add) => {
      const a = body(add());
      a.text("Astra AI, LLC", 72, 760, 9);
      const b = add();
      b.text(`Signature: ${LINE}`, 72, 90).text(`Date: ${LINE}`, 72, 120);
      b.text("Astra AI, LLC", 72, 760, 9);
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    expect(of(r, "signature", "client", 1)).toHaveLength(1);
    expect(of(r, "signature", "company")).toHaveLength(0);
    expect(r.meta.signaturePageAppended).toBe(false);
  });

  it("reads party headings left at the foot of the previous page", async () => {
    const pdf = await build((add) => {
      const a = body(add());
      a.text("ASTRA AI, LLC", 72, 715).text("CLIENT", 330, 715);
      a.text("Page 1 of 2", 280, 760, 9);
      const b = add();
      b.text(`By: ${LINE}`, 72, 90).text(`By: ${LINE}`, 330, 90);
      b.text(`Name: ${LINE}`, 72, 120).text(`Name: ${LINE}`, 330, 120);
      b.text(`Date: ${LINE}`, 72, 150).text(`Date: ${LINE}`, 330, 150);
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    const company = of(r, "signature", "company");
    const client = of(r, "signature", "client");
    expect(company).toHaveLength(1);
    expect(client).toHaveLength(1);
    expect(box(r, company[0]).x0).toBeLessThan(306);
    expect(box(r, client[0]).x0).toBeGreaterThan(306);
    expect(r.meta.notes.join(" ")).not.toMatch(/does not say which block/);
  });

  it("leaves a details panel at the top of a page alone when the page before does not end in a block", async () => {
    const pdf = await build((add) => {
      const a = body(add());
      a.text(`Client signature: ${LINE}`, 72, 300);
      a.text("The schedule on the next page lists the contact for this engagement in more detail.", 72, 400);
      a.text("It forms part of this agreement and may be updated by either party in writing.", 72, 416);
      a.text("Changes take effect when the other party confirms them by email to the address given.", 72, 432);
      const b = add();
      b.text(`Client name: ${LINE}`, 72, 90).text(`Date: ${LINE}`, 72, 120);
    });
    const r = await detectFields(pdf, { useAI: false });
    expect(r.fields.filter((f) => f.page === 1).map((f) => f.mergeKey).sort()).toEqual(["client_name", "today"]);
  });
});

describe("header and footer rules", () => {
  const furniture = (s: Sheet, n: number) => {
    s.text(SENDER, 72, 44, 9).text("Confidential", 490, 44, 9).rule(72, 540, 50);
    s.rule(72, 540, 732).text(`${SENDER} - Confidential`, 72, 744, 9).text(`Page ${n} of 3`, 490, 744, 9);
  };

  it("creates no fields from ruled-off headers and footers on every page", async () => {
    const pdf = await build((add) => {
      for (let n = 1; n <= 3; n++) {
        const s = add();
        furniture(s, n);
        for (let i = 0; i < 12; i++) s.text("The provider performs the services with reasonable skill and care, as set out in the schedule.", 72, 100 + i * 16);
        if (n === 3) s.text(`Client signature: ${LINE}`, 72, 420);
      }
    });
    for (const companyName of [SENDER, undefined]) {
      const r = await detectFields(pdf, { companyName, useAI: false });
      expect(r.fields).toHaveLength(1);
      expect(r.fields[0]).toMatchObject({ type: "signature", role: "client", page: 2 });
      expect(r.meta.signaturePageAppended).toBe(false);
    }
  });

  it("ignores a footer rule above a label-like word and a header rule under a title that mentions a date", async () => {
    const pdf = await build((add) => {
      for (let n = 1; n <= 2; n++) {
        const s = add();
        s.text("Client Services Agreement - Effective Date", 72, 44, 9).rule(72, 540, 50);
        s.rule(72, 540, 735).text("Client Name", 72, 747, 9);
        for (let i = 0; i < 12; i++) s.text("The provider performs the services with reasonable skill and care, as set out in the schedule.", 72, 100 + i * 16);
        if (n === 2) s.text(`Client signature: ${LINE}`, 72, 420);
      }
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    expect(r.fields).toHaveLength(1);
    expect(r.fields[0]).toMatchObject({ type: "signature", role: "client", page: 1 });
  });

  it("does not sign a separator across the text column that has a party heading under it", async () => {
    const pdf = await build((add) => {
      const s = add();
      for (let i = 0; i < 8; i++) s.text("The provider performs the services with reasonable skill and care, as set out in the schedule.", 72, 100 + i * 16);
      s.rule(72, 540, 300).text("CLIENT", 72, 316);
      s.text(`Signature: ${LINE}`, 72, 350).text(`Date: ${LINE}`, 72, 380);
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    expect(of(r, "signature")).toHaveLength(1);
    expectBottom(r, of(r, "signature", "client")[0], 351);
    expect(r.fields).toHaveLength(2);
  });

  it("keeps a short labelled line near the foot of the page", async () => {
    const pdf = await build((add) => {
      const s = body(add());
      s.text(`Client signature: ${LINE}`, 72, 400);
      s.text("Client initials:", 72, 750).rule(160, 240, 751);
    });
    const r = await detectFields(pdf, { useAI: false });
    expect(of(r, "initials", "client")).toHaveLength(1);
  });
});

describe("witness and notary blocks", () => {
  it("leaves a block under a WITNESS heading alone", async () => {
    const pdf = await build((add) => {
      const s = body(add());
      s.text("CLIENT", 72, 300).text(`By: ${LINE}`, 72, 330).text(`Name: ${LINE}`, 72, 360);
      s.text("WITNESS", 72, 420).text(`Signature: ${LINE}`, 72, 450).text(`Name: ${LINE}`, 72, 480);
      s.text("ASTRA AI, LLC", 72, 540).text(`By: ${LINE}`, 72, 570);
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    expect(of(r, "signature", "client")).toHaveLength(1);
    expect(of(r, "full_name", "client")).toHaveLength(1);
    expect(of(r, "signature", "company")).toHaveLength(1);
    expect(r.fields).toHaveLength(3);
    // Nothing sits on the witness lines.
    expect(r.fields.some((f) => box(r, f).y1 > 400 && box(r, f).y1 < 500)).toBe(false);
    expect(r.meta.notes.join(" ")).toMatch(/witness or notary line was found and left alone/);
    expect(r.meta.notes.join(" ")).toMatch(/Found 2 signature blocks/);
  });

  it("leaves a lone name line under a NOTARY PUBLIC heading out of the client's block", async () => {
    const pdf = await build((add) => {
      const s = body(add());
      s.text("CLIENT", 72, 300).text(`Signature: ${LINE}`, 72, 330);
      s.text("Notary Public", 72, 380).text(`Name: ${LINE}`, 72, 410).text(`Date: ${LINE}`, 72, 440);
    });
    const r = await detectFields(pdf, { useAI: false });
    expect(r.fields).toHaveLength(1);
    expect(r.fields[0]).toMatchObject({ type: "signature", role: "client" });
  });

  it("recognizes witness headings and not the usual signing clause", () => {
    for (const text of ["WITNESS", "Witness:", "Witnessed by:", "NOTARY PUBLIC", "Attest:", "Signed in the presence of:", "Witness Signature"]) expect(isWitnessHeading(text), text).toBe(true);
    for (const text of ["IN WITNESS WHEREOF, the parties have signed", "CLIENT", "Witness our commitment to quality service", "Notary fees are paid by the client"]) expect(isWitnessHeading(text), text).toBe(false);
  });

  it("leaves a witness column beside the client's block alone", async () => {
    const pdf = await build((add) => {
      const s = body(add());
      s.text("CLIENT", 72, 300).text("WITNESS", 330, 300);
      s.text(`Signature: ${LINE}`, 72, 330).text(`Signature: ${LINE}`, 330, 330);
      s.text(`Name: ${LINE}`, 72, 360).text(`Name: ${LINE}`, 330, 360);
    });
    const r = await detectFields(pdf, { useAI: false });
    expect(r.fields).toHaveLength(2);
    expect(r.fields.every((f) => f.role === "client" && box(r, f).x0 < 306)).toBe(true);
  });

  it("still signs under IN WITNESS WHEREOF", async () => {
    const pdf = await build((add) => {
      const s = body(add());
      s.text("IN WITNESS WHEREOF", 72, 300).text(`Signature: ${LINE}`, 72, 330);
    });
    const r = await detectFields(pdf, { useAI: false });
    expect(of(r, "signature", "client")).toHaveLength(1);
    expect(r.meta.signaturePageAppended).toBe(false);
  });
});

describe("the client's name in the opening sentence", () => {
  it("is the client's when the blank starts a wrapped line after the sender's definition", async () => {
    const pdf = await build((add) => {
      const s = add();
      s.text("This Agreement is made by and between Astra AI, LLC, a Delaware limited liability", 72, 100);
      s.text(`company ("Company") and ${LINE} ("Client").`, 72, 116);
      s.text(`Client signature: ${LINE}`, 72, 400);
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    const prefills = r.fields.filter((f) => f.role === "prefill");
    expect(prefills).toHaveLength(1);
    expect(prefills[0]).toMatchObject({ type: "full_name", mergeKey: "client_name" });
    expect(r.fields.some((f) => f.mergeKey === "company_name")).toBe(false);
  });

  it("is the client's when more of the sentence follows the definition", async () => {
    const pdf = await build((add) => {
      const s = add();
      s.text("This Agreement is entered into by Astra AI, LLC, a limited liability company", 72, 100);
      s.text(`("Company") and ${LINE} ("Client"), whose address is`, 72, 116);
      s.text(`${LINE}.`, 72, 132);
      s.text(`Client signature: ${LINE}`, 72, 400);
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    expect(r.fields.filter((f) => f.mergeKey === "client_name")).toHaveLength(1);
    expect(r.fields.some((f) => f.mergeKey === "company_name")).toBe(false);
  });

  it("still reads real labels that end in a colon or stand before a line", async () => {
    const pdf = await build((add) => {
      const s = add();
      s.text(`Client: ${LINE}`, 72, 100).text(`Accepted by ${LINE}`, 72, 400);
    });
    const r = await detectFields(pdf, { useAI: false });
    expect(of(r, "signature", "client")).toHaveLength(1);
    expect(r.fields.filter((f) => f.mergeKey === "client_name")).toHaveLength(1);
  });

  it("reads 'Company' beside the client's name as the client's company", async () => {
    const pdf = await build((add) => {
      const s = add();
      s.text(`Client Name: ${LINE}`, 72, 100).text(`Company: ${LINE}`, 330, 100);
      s.text(`Client signature: ${LINE}`, 72, 400);
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    expect(r.fields.filter((f) => f.role === "prefill").map((f) => f.mergeKey).sort()).toEqual(["client_company", "client_name"]);
  });
});

describe("the names an agreement gives its parties", () => {
  const recital = (s: Sheet) =>
    s
      .text('This Consulting Agreement ("Agreement") is made between Astra AI, LLC ("Consultant")', 72, 100)
      .text('and the company named below ("Company").', 72, 116);

  it("reads the sender's and the client's defined terms from the recital", () => {
    expect(findDefinedTerms('This Agreement ("Agreement") is between Astra AI, LLC, a Delaware limited liability company ("Consultant") and ____ ("Company").', SENDER)).toEqual({
      sender: ["consultant"],
      client: ["company"],
    });
    expect(findDefinedTerms('between ____ (the "Owner") and Astra AI (hereinafter "Contractor") (each a "Party")', SENDER)).toEqual({ sender: ["contractor"], client: ["owner"] });
    expect(findDefinedTerms('between ____ ("Company") and ____ ("Client")', undefined)).toBeUndefined();
    expect(findDefinedTerms("No definitions here.", SENDER)).toBeUndefined();
  });

  for (const order of [
    ["COMPANY", "CONSULTANT"],
    ["CONSULTANT", "COMPANY"],
  ]) {
    it(`gives the block headed ${order[0]} to the right party when stacked first`, async () => {
      const pdf = await build((add) => {
        const s = recital(add());
        s.text(order[0], 72, 300).text(`By: ${LINE}`, 72, 330).text(`Name: ${LINE}`, 72, 360);
        s.text(order[1], 72, 430).text(`By: ${LINE}`, 72, 460).text(`Name: ${LINE}`, 72, 490);
      });
      const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
      const sigs = of(r, "signature").sort((a, b) => a.y - b.y);
      expect(sigs.map((f) => f.role)).toEqual(order.map((h) => (h === "COMPANY" ? "client" : "company")));
      expect(r.meta.notes.join(" ")).not.toMatch(/does not say which block/);
    });
  }

  it("gives COMPANY on the left to the client in a two-column block", async () => {
    const pdf = await build((add) => {
      const s = recital(add());
      s.text("COMPANY", 72, 300).text("CONSULTANT", 330, 300);
      s.text(`By: ${LINE}`, 72, 330).text(`By: ${LINE}`, 330, 330);
      s.text(`Name: ${LINE}`, 72, 360).text(`Name: ${LINE}`, 330, 360);
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    expect(box(r, of(r, "signature", "client")[0]).x0).toBeLessThan(306);
    expect(box(r, of(r, "signature", "company")[0]).x0).toBeGreaterThan(306);
  });

  it("fills a blank defined as the client's term with the client's name, not the sender's", async () => {
    const pdf = await build((add) => {
      const s = add();
      s.text('This Consulting Agreement is made between Astra AI, LLC ("Consultant") and', 72, 100);
      s.text(`${LINE} ("Company").`, 72, 116);
      s.text("COMPANY", 72, 300).text(`By: ${LINE}`, 72, 330);
      s.text("CONSULTANT", 72, 430).text(`By: ${LINE}`, 72, 460);
    });
    const r = await detectFields(pdf, { companyName: SENDER, useAI: false });
    expect(r.fields.filter((f) => f.role === "prefill").map((f) => f.mergeKey)).toEqual(["client_name"]);
    expect(of(r, "signature").sort((a, b) => a.y - b.y).map((f) => f.role)).toEqual(["client", "company"]);
  });
});

describe("documents with far too many blanks", () => {
  it("keeps the appended client signature within the field limit", async () => {
    const pdf = await build((add) => {
      for (let p = 0; p < 10; p++) {
        const s = add();
        for (let i = 0; i < 34; i++) s.text(`Item ${p * 34 + i + 1} description: ${LINE}`, 72, 60 + i * 20);
      }
    });
    const r = await detectFields(pdf, { useAI: false });
    expect(r.meta.signaturePageAppended).toBe(true);
    expect(r.fields.length).toBeLessThanOrEqual(LIMITS.maxFieldsPerTemplate);
    // A caller that keeps only the first fields up to the limit must still keep the signature.
    const firstUpToLimit = r.fields.slice(0, LIMITS.maxFieldsPerTemplate);
    expect(firstUpToLimit.some((f) => f.type === "signature" && f.role === "client" && f.source === "appended")).toBe(true);
    expect(r.fields[0].source).toBe("appended");
  });

  it("answers a document made of tens of thousands of blanks in bounded time", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const row = Array.from({ length: 12 }, () => "____").join("   ");
    for (let p = 0; p < 60; p++) {
      const page = doc.addPage([612, 792]);
      for (let i = 0; i < 75; i++) page.drawText(row, { x: 20, y: 780 - i * 10, size: 7, font });
    }
    const pdf = new Uint8Array(await doc.save());
    const started = Date.now();
    const r = await detectFields(pdf, { useAI: false });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.fields.length).toBeLessThanOrEqual(LIMITS.maxFieldsPerTemplate);
    expect(r.fields.some((f) => f.type === "signature" && f.role === "client")).toBe(true);
    expect(r.meta.notes.join(" ")).toMatch(/very large number of blanks/);
  }, 30_000);

  it("falls back to a signable result when the rules run out of time", async () => {
    const pdf = await build((add) => {
      const s = body(add());
      for (let i = 0; i < 30; i++) s.text(`Signature: ${LINE}   Date: ${LINE}`, 72, 180 + i * 18);
    });
    const r = await detectFieldsWith(pdf, { useAI: false }, { rulesTimeoutMs: -1 });
    expect(r.fields.some((f) => f.type === "signature" && f.role === "client")).toBe(true);
    expect(r.meta.signaturePageAppended).toBe(true);
    expect(r.meta.notes.join(" ")).toMatch(/too many blanks and lines to analyse automatically/);
  });
});
