import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts, degrees, type PDFFont, type PDFPage } from "pdf-lib";
import { detectFields } from "@/lib/pdf/detect";
import type { DetectionResult } from "@/lib/pdf/types";
import type { Field, FieldRole, FieldType } from "@/lib/types";

/** A small drawing helper that works in "points from the top-left", like the detector's output. */
class Sheet {
  constructor(
    readonly page: PDFPage,
    readonly font: PDFFont,
    readonly width: number,
    readonly height: number,
  ) {}
  /** Draws text with its baseline `top` points below the top edge. */
  text(value: string, x: number, top: number, size = 11) {
    this.page.drawText(value, { x, y: this.height - top, size, font: this.font });
    return this;
  }
  /** Draws a horizontal line. */
  rule(x0: number, x1: number, top: number) {
    this.page.drawLine({ start: { x: x0, y: this.height - top }, end: { x: x1, y: this.height - top }, thickness: 0.75 });
    return this;
  }
  /** x where the text after `prefix` starts, e.g. where the underscores begin in "By: ____". */
  after(prefix: string, x: number, size = 11) {
    return x + this.font.widthOfTextAtSize(prefix, size);
  }
}

async function build(draw: (add: (size?: [number, number]) => Sheet, doc: PDFDocument) => void | Promise<void>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  await draw((size = [612, 792]) => new Sheet(doc.addPage(size), font, size[0], size[1]), doc);
  return new Uint8Array(await doc.save());
}

const find = (r: DetectionResult, type: FieldType, role: FieldRole, page?: number) => r.fields.filter((f) => f.type === type && f.role === role && (page === undefined || f.page === page));

/** Asserts a field rests on a writing line: left edge at x0, bottom edge on the line, within a few points. */
function expectOnLine(r: DetectionResult, field: Field | undefined, x0: number, top: number, tolerance = 5) {
  expect(field, "field exists").toBeDefined();
  const page = r.pages[field!.page];
  expect(Math.abs(field!.x * page.width - x0), `left edge ${field!.x * page.width} vs ${x0}`).toBeLessThanOrEqual(tolerance);
  expect(Math.abs((field!.y + field!.h) * page.height - top), `bottom edge ${(field!.y + field!.h) * page.height} vs ${top}`).toBeLessThanOrEqual(tolerance);
}

function expectSane(r: DetectionResult) {
  const ids = new Set<string>();
  for (const f of r.fields) {
    expect(ids.has(f.id)).toBe(false);
    ids.add(f.id);
    expect(f.page).toBeGreaterThanOrEqual(0);
    expect(f.page).toBeLessThan(r.pages.length);
    for (const n of [f.x, f.y, f.w, f.h]) expect(Number.isFinite(n)).toBe(true);
    expect(f.x).toBeGreaterThanOrEqual(0);
    expect(f.y).toBeGreaterThanOrEqual(0);
    expect(f.x + f.w).toBeLessThanOrEqual(1.0001);
    expect(f.y + f.h).toBeLessThanOrEqual(1.0001);
    expect(f.w).toBeGreaterThan(0);
    expect(f.h).toBeGreaterThan(0);
    expect(f.label.length).toBeGreaterThan(0);
    if (f.role === "prefill") expect(f.mergeKey).toBeTruthy();
  }
  // No two fields cover the same spot.
  for (const a of r.fields) {
    for (const b of r.fields) {
      if (a === b || a.page !== b.page) continue;
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (w > 0 && h > 0) expect(w * h).toBeLessThan(0.5 * Math.min(a.w * a.h, b.w * b.h));
    }
  }
  expect(r.fields.some((f) => f.type === "signature" && f.role === "client"), "client can sign").toBe(true);
  expect(Array.isArray(r.meta.notes)).toBe(true);
}

const UNDERSCORES = "______________________";

describe("detectFields: signature block layouts", () => {
  it("finds stacked blocks with labels to the left of underscore lines", async () => {
    let s!: Sheet;
    const pdf = await build((add) => {
      s = add();
      s.text("SERVICE AGREEMENT", 72, 80, 16).text("The parties agree to the terms above.", 72, 120);
      s.text("CLIENT", 72, 300);
      s.text(`Signature: ${UNDERSCORES}`, 72, 340).text(`Printed Name: ${UNDERSCORES}`, 72, 370).text(`Date: ${UNDERSCORES}`, 72, 400);
      s.text("NORTHWIND STUDIO", 72, 470);
      s.text(`By: ${UNDERSCORES}`, 72, 510).text(`Name: ${UNDERSCORES}`, 72, 540).text(`Title: ${UNDERSCORES}`, 72, 570).text(`Date: ${UNDERSCORES}`, 72, 600);
    });
    const r = await detectFields(pdf, { companyName: "Northwind Studio" });
    expectSane(r);
    expect(r.meta.method).toBe("heuristic");
    expect(r.meta.signaturePageAppended).toBe(false);
    expect(r.meta.scanned).toBe(false);
    expect(r.pdf).toBe(pdf);
    expect(r.fields).toHaveLength(7);
    expect(r.fields.every((f) => f.source === "detected" && typeof f.confidence === "number")).toBe(true);

    const clientSig = find(r, "signature", "client")[0];
    expectOnLine(r, clientSig, s.after("Signature: ", 72), 341);
    expect(clientSig.label).toBe("Client signature");
    expect(clientSig.required).toBe(true);
    // A signature needs real height, but must not run into the heading above it.
    expect(clientSig.h * 792).toBeGreaterThanOrEqual(24);
    expect(clientSig.y * 792).toBeGreaterThan(300);
    expectOnLine(r, find(r, "full_name", "client")[0], s.after("Printed Name: ", 72), 371);
    expectOnLine(r, find(r, "date_signed", "client")[0], s.after("Date: ", 72), 401);

    expectOnLine(r, find(r, "signature", "company")[0], s.after("By: ", 72), 511);
    expectOnLine(r, find(r, "full_name", "company")[0], s.after("Name: ", 72), 541);
    const title = find(r, "title", "company")[0];
    expectOnLine(r, title, s.after("Title: ", 72), 571);
    expect(title.label).toBe("Company signer title");
    expect(title.required).toBe(false);
    expectOnLine(r, find(r, "date_signed", "company")[0], s.after("Date: ", 72), 601);
    expect(r.meta.notes.join(" ")).toMatch(/Found 2 signature blocks\. Check that the company block is assigned to your side\./);
  });

  it("reads labels in any letter case, with or without a colon", async () => {
    let s!: Sheet;
    const pdf = await build((add) => {
      s = add();
      s.text(`CUSTOMER SIGNATURE ${UNDERSCORES}`, 72, 300).text(`print name ${UNDERSCORES}`, 72, 330).text(`E-mail: ${UNDERSCORES}`, 72, 360);
      s.text(`Phone ${UNDERSCORES}`, 72, 390).text(`Address: ${UNDERSCORES}`, 72, 420).text(`DATED: ${UNDERSCORES}`, 72, 450);
    });
    const r = await detectFields(pdf);
    expectSane(r);
    expectOnLine(r, find(r, "signature", "client")[0], s.after("CUSTOMER SIGNATURE ", 72), 301);
    expectOnLine(r, find(r, "full_name", "client")[0], s.after("print name ", 72), 331);
    expectOnLine(r, find(r, "email", "client")[0], s.after("E-mail: ", 72), 361);
    expectOnLine(r, find(r, "date_signed", "client")[0], s.after("DATED: ", 72), 451);
    const texts = find(r, "text", "client");
    expect(texts.map((f) => f.label).sort()).toEqual(["Client address", "Client phone"]);
    expect(r.meta.signaturePageAppended).toBe(false);
  });

  it("finds drawn lines with the label printed underneath", async () => {
    const pdf = await build((add) => {
      const s = add();
      s.text("Agreed and accepted:", 72, 400);
      s.rule(72, 280, 460).rule(330, 450, 460);
      s.text("Client Signature", 72, 472, 9).text("Date", 330, 472, 9);
      s.rule(72, 280, 520);
      s.text("Print Name", 72, 532, 9);
      s.rule(72, 280, 600).rule(330, 450, 600);
      s.text("Company Representative Signature", 72, 612, 9).text("Date", 330, 612, 9);
    });
    const r = await detectFields(pdf);
    expectSane(r);
    expect(r.meta.signaturePageAppended).toBe(false);
    const sig = find(r, "signature", "client")[0];
    expectOnLine(r, sig, 72, 460, 3);
    expect(sig.w * 612).toBeGreaterThan(150);
    // The box sits above the line and leaves the caption under it readable.
    expect((sig.y + sig.h) * 792).toBeLessThan(463);
    expectOnLine(r, find(r, "date_signed", "client")[0], 330, 460, 3);
    expectOnLine(r, find(r, "full_name", "client")[0], 72, 520, 3);
    expectOnLine(r, find(r, "signature", "company")[0], 72, 600, 3);
    expectOnLine(r, find(r, "date_signed", "company")[0], 330, 600, 3);
    expect(r.fields).toHaveLength(5);
  });

  it("finds underscore lines captioned underneath, side by side for two parties", async () => {
    const pdf = await build((add) => {
      const s = add();
      s.text("____________________________", 72, 400).text("____________________________", 330, 400);
      s.text("Client Signature", 72, 414, 9).text("Bright Path Coaching", 330, 414, 9);
      s.text("____________________________", 72, 450).text("____________________________", 330, 450);
      s.text("Printed Name", 72, 464, 9).text("Printed Name", 330, 464, 9);
      s.text("______________", 72, 500).text("______________", 330, 500);
      s.text("(Date)", 72, 514, 9).text("(Date)", 330, 514, 9);
    });
    const r = await detectFields(pdf, { companyName: "Bright Path Coaching LLC" });
    expectSane(r);
    expect(r.fields).toHaveLength(6);
    expectOnLine(r, find(r, "signature", "client")[0], 72, 401);
    expectOnLine(r, find(r, "full_name", "client")[0], 72, 451);
    expectOnLine(r, find(r, "date_signed", "client")[0], 72, 501);
    expectOnLine(r, find(r, "signature", "company")[0], 330, 401);
    expectOnLine(r, find(r, "full_name", "company")[0], 330, 451);
    expectOnLine(r, find(r, "date_signed", "company")[0], 330, 501);
    // Captions stay readable: no field reaches below its line.
    for (const f of r.fields) expect(((f.y + f.h) * 792) % 50).toBeLessThan(3);
  });

  it("reads captions printed after the line and a date written in three parts", async () => {
    let s!: Sheet;
    const pdf = await build((add) => {
      s = add();
      s.text("_______________________ (Signature)", 72, 400).text("_______________________ (Print Name)", 72, 430);
      s.text("Date: ____/____/______", 72, 460);
    });
    const r = await detectFields(pdf);
    expectSane(r);
    expect(r.fields).toHaveLength(3);
    expectOnLine(r, find(r, "signature", "client")[0], 72, 401);
    expectOnLine(r, find(r, "full_name", "client")[0], 72, 431);
    const date = find(r, "date_signed", "client")[0];
    expectOnLine(r, date, s.after("Date: ", 72), 461);
    expect(date.w * 612).toBeGreaterThan(s.font.widthOfTextAtSize("____/____/_____", 11));
  });

  it("does not sign write-in areas or phrases that only mention signing", async () => {
    const pdf = await build((add) => {
      const s = add();
      s.text("Client comments:", 72, 100);
      for (let i = 0; i < 4; i++) s.text("_".repeat(60), 72, 130 + i * 22);
      s.text("SIGNED by the parties:", 72, 300);
      s.text("Signature requirements:", 72, 330);
      s.text("I, ______________________, agree to the terms above.", 72, 380);
      s.text(`Client Signature: ${UNDERSCORES}`, 72, 500);
    });
    const r = await detectFields(pdf);
    expectSane(r);
    expect(r.fields.filter((f) => f.type === "signature")).toHaveLength(1);
    expect(find(r, "signature", "client")[0].y * 792).toBeGreaterThan(450);
    expect(r.fields.filter((f) => f.mergeKey === "client_name")).toHaveLength(1);
    expect(r.fields).toHaveLength(2);
  });

  it("splits one long line captioned 'Signature' and 'Date' underneath into two fields", async () => {
    const pdf = await build((add) => {
      const s = add();
      s.text("By signing below the Client accepts these terms.", 72, 400);
      s.rule(72, 500, 460);
      s.text("Signature", 72, 472, 9).text("Date", 380, 472, 9);
    });
    const r = await detectFields(pdf);
    expectSane(r);
    expectOnLine(r, find(r, "signature", "client")[0], 72, 460, 3);
    const date = find(r, "date_signed", "client")[0];
    expectOnLine(r, date, 380, 460, 3);
    expect((find(r, "signature", "client")[0].x + find(r, "signature", "client")[0].w) * 612).toBeLessThan(380);
  });

  it("assigns a two-column block from the party headings", async () => {
    let s!: Sheet;
    const pdf = await build((add) => {
      s = add();
      s.text("IN WITNESS WHEREOF, the parties have executed this Agreement as of the date first written above.", 72, 300, 9);
      s.text("PROVIDER", 72, 340).text("CLIENT", 330, 340);
      s.text("By: ___________________", 72, 380).text("By: ___________________", 330, 380);
      s.text("Name: _________________", 72, 410).text("Name: _________________", 330, 410);
      s.text("Title: ________________", 72, 440).text("Title: ________________", 330, 440);
      s.text("Date: _________________", 72, 470).text("Date: _________________", 330, 470);
    });
    const r = await detectFields(pdf);
    expectSane(r);
    expect(r.fields).toHaveLength(8);
    for (const [type, prefix, top] of [
      ["signature", "By: ", 381],
      ["full_name", "Name: ", 411],
      ["title", "Title: ", 441],
      ["date_signed", "Date: ", 471],
    ] as const) {
      expectOnLine(r, find(r, type, "company")[0], s.after(prefix, 72), top);
      expectOnLine(r, find(r, type, "client")[0], s.after(prefix, 330), top);
      expect(find(r, type, "company")).toHaveLength(1);
      expect(find(r, type, "client")).toHaveLength(1);
    }
  });

  it("uses the sender's own name to tell the blocks apart, whichever side it is on", async () => {
    const draw = (companyRight: boolean) =>
      build((add) => {
        const s = add();
        const [left, right] = companyRight ? ["Harbor Dental Group", "ASTRA AI, INC."] : ["ASTRA AI, INC.", "Harbor Dental Group"];
        s.text(left, 72, 340).text(right, 330, 340);
        s.text("By: ___________________", 72, 380).text("By: ___________________", 330, 380);
        s.text("Its: __________________", 72, 410).text("Its: __________________", 330, 410);
      });
    const a = await detectFields(await draw(false), { companyName: "Astra AI" });
    expectSane(a);
    expect(find(a, "signature", "company")[0].x).toBeLessThan(0.4);
    expect(find(a, "signature", "client")[0].x).toBeGreaterThan(0.5);
    expect(find(a, "title", "client")).toHaveLength(1);
    const b = await detectFields(await draw(true), { companyName: "Astra AI" });
    expectSane(b);
    expect(find(b, "signature", "company")[0].x).toBeGreaterThan(0.5);
    expect(find(b, "signature", "client")[0].x).toBeLessThan(0.4);
  });

  it("treats 'By:' under an entity name as that entity's signature", async () => {
    let s!: Sheet;
    const pdf = await build((add) => {
      s = add();
      s.text("IN WITNESS WHEREOF the parties have signed this Agreement.", 72, 300);
      s.text("BLUE HERON CONSULTING LLC", 72, 340);
      s.text("By: ______________________", 72, 375);
      s.text("Its: Managing Member", 72, 395);
      s.text("CLIENT:", 72, 450);
      s.text("______________________________", 72, 490);
      s.text("Name:", 72, 510);
    });
    const r = await detectFields(pdf, { companyName: "Blue Heron Consulting" });
    expectSane(r);
    expectOnLine(r, find(r, "signature", "company")[0], s.after("By: ", 72), 376);
    // The client's line has no "Signature" label at all: it is the unlabelled line under the heading.
    expectOnLine(r, find(r, "signature", "client")[0], 72, 491);
    expect(r.meta.signaturePageAppended).toBe(false);
  });

  it("gives the first block to the client when nothing says whose is whose", async () => {
    const pdf = await build((add) => {
      const s = add();
      s.text(`Signature: ${UNDERSCORES}`, 72, 300).text(`Date: ${UNDERSCORES}`, 72, 330);
      s.text(`Signature: ${UNDERSCORES}`, 72, 420).text(`Date: ${UNDERSCORES}`, 72, 450);
    });
    const r = await detectFields(pdf);
    expectSane(r);
    expect(find(r, "signature", "client")[0].y * 792).toBeLessThan(310);
    expect(find(r, "signature", "company")[0].y * 792).toBeGreaterThan(380);
    expect(find(r, "signature", "client")[0].confidence!).toBeLessThan(0.9);
    expect(r.meta.notes.join(" ")).toMatch(/does not say which block belongs to which party/);
  });

  it("uses a Title line as a hint for the company block when there are no headings", async () => {
    const pdf = await build((add) => {
      const s = add();
      s.text(`By: ${UNDERSCORES}`, 72, 300).text(`Title: ${UNDERSCORES}`, 72, 330);
      s.text(`Signature: ${UNDERSCORES}`, 72, 420).text(`Name: ${UNDERSCORES}`, 72, 450);
    });
    const r = await detectFields(pdf);
    expectSane(r);
    expect(find(r, "signature", "company")[0].y * 792).toBeLessThan(310);
    expect(find(r, "signature", "client")[0].y * 792).toBeGreaterThan(380);
  });

  it("places a field in the empty space after 'Signature:' when no line is printed", async () => {
    let s!: Sheet;
    const pdf = await build((add) => {
      s = add();
      s.text("Client acknowledgement", 72, 300, 13);
      s.text("Signature:", 72, 350).text("Date:", 360, 350);
      s.text("Name:", 72, 385);
    });
    const r = await detectFields(pdf);
    expectSane(r);
    expect(r.meta.signaturePageAppended).toBe(false);
    const sig = find(r, "signature", "client")[0];
    expectOnLine(r, sig, s.after("Signature:", 72) + 5, 351);
    // It stops before the "Date:" label on the same row.
    expect((sig.x + sig.w) * 612).toBeLessThan(360);
    expect(find(r, "date_signed", "client")).toHaveLength(1);
    expect(find(r, "full_name", "client")).toHaveLength(1);
  });

  it("finds blocks on two different pages", async () => {
    const pdf = await build((add) => {
      add().text("Terms and conditions apply as set out in this agreement.", 72, 100);
      add().text("ACCEPTED BY CLIENT", 72, 200).text(`Signature: ${UNDERSCORES}`, 72, 240).text(`Date: ${UNDERSCORES}`, 72, 270);
      add().text("ACCEPTED BY COMPANY", 72, 200).text(`Signature: ${UNDERSCORES}`, 72, 240).text(`Date: ${UNDERSCORES}`, 72, 270);
    });
    const r = await detectFields(pdf);
    expectSane(r);
    expect(find(r, "signature", "client", 1)).toHaveLength(1);
    expect(find(r, "date_signed", "client", 1)).toHaveLength(1);
    expect(find(r, "signature", "company", 2)).toHaveLength(1);
    expect(find(r, "date_signed", "company", 2)).toHaveLength(1);
    expect(r.fields).toHaveLength(4);
  });

  it("finds an initials line on every page", async () => {
    let s!: Sheet;
    const pdf = await build((add) => {
      for (let i = 0; i < 3; i++) {
        s = add();
        s.text(`Clause ${i + 1}. The parties agree to the following terms and conditions.`, 72, 100);
        s.text("Client Initials: ______", 430, 740, 9);
      }
      s.text(`Client Signature: ${UNDERSCORES}`, 72, 400);
    });
    const r = await detectFields(pdf);
    expectSane(r);
    for (let page = 0; page < 3; page++) {
      const initials = find(r, "initials", "client", page);
      expect(initials).toHaveLength(1);
      expectOnLine(r, initials[0], s.after("Client Initials: ", 430, 9), 741);
      expect(initials[0].label).toBe(`Client initials (page ${page + 1})`);
      expect(initials[0].required).toBe(true);
    }
    expect(r.meta.notes.join(" ")).toMatch(/3 places for initials/);
  });

  it("leaves witness and notary lines alone and says so", async () => {
    const pdf = await build((add) => {
      const s = add();
      s.text(`Client Signature: ${UNDERSCORES}`, 72, 300);
      s.text(`Witness: ${UNDERSCORES}`, 72, 400).text(`Notary Public: ${UNDERSCORES}`, 72, 440);
    });
    const r = await detectFields(pdf);
    expectSane(r);
    expect(r.fields).toHaveLength(1);
    expect(r.meta.notes.join(" ")).toMatch(/witness or notary/i);
  });
});

describe("detectFields: blanks in the body", () => {
  it("prefills the date and the client's name and leaves unknown blanks optional", async () => {
    let s!: Sheet;
    const pdf = await build((add) => {
      s = add();
      s.text('This Agreement is made on ____________ between Astra AI ("Company") and', 72, 120);
      s.text('______________________ (the "Client").', 72, 136);
      s.text("The monthly retainer is $________ payable in advance.", 72, 170);
      s.text(`Client Signature: ${UNDERSCORES}`, 72, 500);
    });
    const r = await detectFields(pdf, { companyName: "Astra AI" });
    expectSane(r);
    const date = r.fields.find((f) => f.mergeKey === "today")!;
    expect(date).toMatchObject({ role: "prefill", type: "date", required: false, page: 0 });
    expectOnLine(r, date, s.after("This Agreement is made on ", 72), 121);
    const name = r.fields.find((f) => f.mergeKey === "client_name")!;
    expect(name).toMatchObject({ role: "prefill", type: "full_name" });
    expectOnLine(r, name, 72, 137);
    const open = r.fields.find((f) => f.type === "text")!;
    expect(open).toMatchObject({ role: "client", required: false });
    expectOnLine(r, open, s.after("The monthly retainer is $", 72), 171);
    expect(open.confidence!).toBeLessThanOrEqual(0.5);
    expect(r.fields).toHaveLength(4);
    expect(r.meta.notes.join(" ")).toMatch(/2 blanks in the text will be filled in automatically/);
    expect(r.meta.notes.join(" ")).toMatch(/1 other blank could not be identified/);
  });

  it("recognizes 'this ___ day of ___', effective dates and a details panel", async () => {
    const pdf = await build((add) => {
      const s = add();
      s.text("Client Name: ____________________    File No.: ____________", 72, 90);
      s.text("Client Email: ___________________", 72, 112);
      s.text("Entered into this _____ day of ______________, 2026, by the parties.", 72, 150);
      s.text('Effective Date: ______________', 72, 180);
      s.text('Services are provided by ________________ (the "Provider") to the Client.', 72, 210);
      s.text(`Client Signature: ${UNDERSCORES}`, 72, 500);
    });
    const r = await detectFields(pdf);
    expectSane(r);
    const keys = r.fields.filter((f) => f.role === "prefill").map((f) => f.mergeKey);
    expect(keys.sort()).toEqual(["client_email", "client_name", "company_name", "custom:today_day", "custom:today_month", "file_reference", "today"].sort());
    expect(r.fields.filter((f) => f.type === "signature")).toHaveLength(1);
  });

  it("does not mistake underlined headings, dot leaders or page-wide separators for fields", async () => {
    const pdf = await build((add) => {
      const s = add();
      s.text("Signature Requirements", 72, 100, 14).rule(72, 72 + s.font.widthOfTextAtSize("Signature Requirements", 14), 102);
      s.text("1. Date of Services ............................ 3", 72, 140);
      s.text("2. Client Name and Address ..................... 4", 72, 158);
      s.rule(40, 580, 200);
      s.text("The Client's name and signature appear on the order form.", 72, 240);
      s.rule(72, 540, 700);
      s.text("Page 1 of 1", 72, 715, 8);
    });
    const r = await detectFields(pdf);
    expectSane(r);
    // Nothing in the document itself is a field: the only fields are on the appended page.
    expect(r.fields.every((f) => f.source === "appended")).toBe(true);
    expect(r.meta.signaturePageAppended).toBe(true);
  });
});

describe("detectFields: the guarantee", () => {
  it("appends a client signature page when the document has nowhere to sign", async () => {
    const pdf = await build((add) => {
      add([595, 842]).text("Terms of Service", 72, 80, 16).text("These terms govern your use of the service. Payment is due in 30 days.", 72, 120);
    });
    const r = await detectFields(pdf, { companyName: "Astra AI" });
    expectSane(r);
    expect(r.meta.signaturePageAppended).toBe(true);
    expect(r.meta.method).toBe("appended");
    expect(r.meta.notes[0]).toMatch(/No place for the client to sign was found.*signature page was added/);
    expect(r.pages).toHaveLength(2);
    expect(r.pages[1]).toEqual({ width: 595, height: 842 });
    const reloaded = await PDFDocument.load(r.pdf);
    expect(reloaded.getPageCount()).toBe(2);
    expect(r.fields.map((f) => f.type).sort()).toEqual(["date_signed", "full_name", "signature"]);
    expect(r.fields.every((f) => f.role === "client" && f.source === "appended" && f.page === 1)).toBe(true);
  });

  it("appends a client page when the only block belongs to the company", async () => {
    const pdf = await build((add) => {
      add().text("For Astra AI:", 72, 300).text(`Authorized Signature: ${UNDERSCORES}`, 72, 340);
    });
    const r = await detectFields(pdf, { companyName: "Astra AI" });
    expectSane(r);
    expect(find(r, "signature", "company")).toHaveLength(1);
    expect(find(r, "signature", "company")[0].source).toBe("detected");
    expect(r.meta.signaturePageAppended).toBe(true);
    expect(r.meta.method).toBe("heuristic");
    expect(r.meta.notes[0]).toMatch(/only signature block found belongs to your side/);
    expect(find(r, "signature", "client")[0].source).toBe("appended");
  });

  it("handles an image-only (scanned) document", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const pdf = await build(async (add, doc) => {
      const image = await doc.embedPng(png);
      for (let i = 0; i < 2; i++) add().page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
    });
    const r = await detectFields(pdf);
    expectSane(r);
    expect(r.meta.scanned).toBe(true);
    expect(r.meta.signaturePageAppended).toBe(true);
    expect(r.meta.notes[0]).toMatch(/scan with no readable text/);
    expect(r.pages).toHaveLength(3);
  });

  it("never throws on input that is not a usable PDF", async () => {
    const good = await build((add) => {
      add().text(`Client Signature: ${UNDERSCORES}`, 72, 300);
    });
    const inputs: Uint8Array[] = [
      new Uint8Array(),
      new Uint8Array([1, 2, 3]),
      new TextEncoder().encode("%PDF-1.7\nthis is not really a pdf"),
      good.slice(0, Math.floor(good.length / 2)),
      new Uint8Array(5000).fill(0x41),
    ];
    for (const bytes of inputs) {
      const r = await detectFields(bytes);
      expect(r.pdf).toBeInstanceOf(Uint8Array);
      expect(Array.isArray(r.fields)).toBe(true);
      expect(r.meta.notes.length).toBeGreaterThan(0);
      if (!r.pages.length) {
        expect(r.fields).toHaveLength(0);
        expect(r.meta.notes[0]).toMatch(/could not be opened as a PDF.*Upload the agreement again/);
      }
    }
    // @ts-expect-error deliberately wrong input types
    const weird = await detectFields(null, { formFields: "nope", companyName: 42 });
    expect(weird.fields).toEqual([]);
  });

  it("survives hostile options and odd text", async () => {
    const pdf = await build((add) => {
      const s = add();
      s.text("_", 72, 100).text("____", 590, 200).text("Signature:", 580, 300).text("Date: ___ ___ ___", 72, 400);
      s.text(`${"Signature ".repeat(30)}`, 72, 450, 6);
      s.text("By:", 72, 500).text("By:", 72, 505).text("X____________", 72, 600);
    });
    const junk = [null, 5, { page: 99, x: 0, y: 0, w: 1, h: 1 }, { page: 0, x: Number.NaN, y: 0, w: 1, h: 1 }, { page: 0, x: -5, y: 3, w: 9, h: 9, type: "text" }] as unknown as Field[];
    const r = await detectFields(pdf, { formFields: junk, companyName: "(.*)+[" });
    expectSane(r);
  });
});

describe("detectFields: page geometry", () => {
  for (const rotation of [90, 270] as const) {
    it(`finds fields on a page rotated ${rotation} degrees`, async () => {
      // The page's own box is 792 x 612 and is shown rotated, so the reader sees 612 x 792.
      const W = 792;
      const H = 612;
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([W, H]);
      page.setRotation(degrees(rotation));
      // Display point (u from the left, v from the top) -> the page's own coordinates.
      const at = (u: number, v: number) => (rotation === 90 ? { x: v, y: u } : { x: W - v, y: H - u });
      const text = (value: string, u: number, v: number) => page.drawText(value, { ...at(u, v), size: 11, font, rotate: degrees(rotation) });
      text("CLIENT", 72, 300);
      text(`Signature: ${UNDERSCORES}`, 72, 340);
      text(`Date: ${UNDERSCORES}`, 72, 370);
      const a = at(330, 500);
      const b = at(520, 500);
      page.drawLine({ start: a, end: b, thickness: 0.75 });
      text("Company Signature", 330, 512);

      const r = await detectFields(new Uint8Array(await doc.save()));
      expectSane(r);
      expect(r.pages[0]).toEqual({ width: 612, height: 792 });
      expect(r.meta.signaturePageAppended).toBe(false);
      expectOnLine(r, find(r, "signature", "client")[0], 72 + font.widthOfTextAtSize("Signature: ", 11), 341);
      expectOnLine(r, find(r, "date_signed", "client")[0], 72 + font.widthOfTextAtSize("Date: ", 11), 371);
      expectOnLine(r, find(r, "signature", "company")[0], 330, 500, 3);
    });
  }

  it("measures from the crop box when its origin is offset", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([700, 900]);
    page.setCropBox(50, 100, 500, 700);
    // Visible area is 500 x 700 starting at (50, 100); a point 300 from the visible top is y = 800 - 300.
    page.drawText(`Client Signature: ${UNDERSCORES}`, { x: 50 + 60, y: 800 - 300, size: 11, font });
    page.drawLine({ start: { x: 50 + 60, y: 800 - 400 }, end: { x: 50 + 260, y: 800 - 400 }, thickness: 0.75 });
    page.drawText("Print Name", { x: 50 + 60, y: 800 - 412, size: 9, font });
    // Outside the visible area: must be ignored.
    page.drawText(`Signature: ${UNDERSCORES}`, { x: 60, y: 40, size: 11, font });
    const r = await detectFields(new Uint8Array(await doc.save()));
    expectSane(r);
    expect(r.pages[0]).toEqual({ width: 500, height: 700 });
    expect(r.fields).toHaveLength(2);
    expectOnLine(r, find(r, "signature", "client")[0], 60 + font.widthOfTextAtSize("Client Signature: ", 11), 301);
    expectOnLine(r, find(r, "full_name", "client")[0], 60, 400, 3);
  });

  it("handles a 60-page document quickly", async () => {
    const pdf = await build((add) => {
      let s!: Sheet;
      for (let i = 0; i < 60; i++) {
        s = add();
        for (let line = 0; line < 45; line++) s.text(`${i + 1}.${line + 1} The Client shall pay all fees when due and the Company shall provide the services described.`, 72, 80 + line * 14, 9);
        s.text("Client Initials: ______", 430, 760, 9);
      }
      s.text(`Client Signature: ${UNDERSCORES}`, 72, 730).text(`Date: ${UNDERSCORES}`, 330, 730);
    });
    const started = Date.now();
    const r = await detectFields(pdf, { useAI: false });
    const elapsed = Date.now() - started;
    expectSane(r);
    expect(elapsed).toBeLessThan(5000);
    expect(find(r, "initials", "client")).toHaveLength(60);
    expect(find(r, "signature", "client", 59)).toHaveLength(1);
    expect(find(r, "date_signed", "client", 59)).toHaveLength(1);
    expect(r.meta.signaturePageAppended).toBe(false);
  });
});

describe("detectFields: form fields from ingest", () => {
  const formField = (over: Partial<Field>): Field => ({ id: "fld_form", page: 0, x: 0, y: 0, w: 0.3, h: 0.03, type: "text", role: "client", required: false, label: "", source: "form", ...over });

  it("keeps form fields, refines their type and role from the page, and drops duplicates", async () => {
    const pdf = await build((add) => {
      const s = add();
      s.text("Client Signature:", 72, 300).text("Date:", 380, 300);
      s.text("NORTHWIND STUDIO", 72, 380).text("By:", 72, 420).text("Title:", 72, 450);
      // An underscore line the form widget sits on top of: must not become a second field.
      s.text("Print Name: ____________________", 72, 520);
    });
    const at = (x: number, top: number, w: number, h = 22) => ({ x: x / 612, y: (top - h) / 792, w: w / 612, h: h / 792 });
    const formFields = [
      formField({ id: "fld_a", label: "Text1", ...at(170, 302, 180) }),
      formField({ id: "fld_b", label: "Text2", ...at(412, 302, 100) }),
      formField({ id: "fld_c", label: "sig_2", type: "signature", ...at(95, 422, 180) }),
      formField({ id: "fld_d", label: "Text4", ...at(105, 452, 180) }),
      formField({ id: "fld_e", label: "Text5", ...at(140, 522, 170) }),
      formField({ id: "fld_f", label: "agree", type: "checkbox", ...at(72, 600, 12, 12) }),
    ];
    const r = await detectFields(pdf, { formFields, companyName: "Northwind Studio" });
    expectSane(r);
    expect(r.meta.method).toBe("form");
    expect(r.meta.signaturePageAppended).toBe(false);
    const byId = Object.fromEntries(r.fields.map((f) => [f.id, f]));
    expect(byId.fld_a).toMatchObject({ type: "signature", role: "client", source: "form", required: true, label: "Client signature" });
    expect(byId.fld_b).toMatchObject({ type: "date_signed", role: "client", source: "form" });
    expect(byId.fld_c).toMatchObject({ type: "signature", role: "company", source: "form" });
    expect(byId.fld_d).toMatchObject({ type: "title", role: "company", source: "form" });
    expect(byId.fld_e).toMatchObject({ type: "full_name", source: "form" });
    expect(byId.fld_f).toMatchObject({ type: "checkbox", source: "form", required: false });
    // Geometry of a form field is the widget's own.
    expect(byId.fld_a.x).toBeCloseTo(170 / 612, 5);
    expect(byId.fld_a.w).toBeCloseTo(180 / 612, 5);
    expect(r.fields).toHaveLength(6);
  });

  it("keeps an unrecognized form field as ingest described it", async () => {
    const pdf = await build((add) => {
      add().text("Favourite colour", 72, 300).text(`Client Signature: ${UNDERSCORES}`, 72, 500);
    });
    const r = await detectFields(pdf, { formFields: [formField({ id: "fld_x", label: "Favourite colour", x: 0.4, y: 0.36, w: 0.2, h: 0.03, required: true })] });
    expectSane(r);
    expect(r.fields.find((f) => f.id === "fld_x")).toMatchObject({ type: "text", role: "client", required: true, label: "Favourite colour", source: "form" });
  });
});
