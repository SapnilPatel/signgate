import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { appendSignaturePage } from "@/lib/pdf/signature-page";
import { extractLayout } from "@/lib/pdf/text";
import type { Field } from "@/lib/types";

async function source(size: [number, number] = [612, 792], rotation = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText("Terms", { x: 72, y: 700, size: 12, font });
  const last = doc.addPage(size);
  last.drawText("Last page", { x: 20, y: 20, size: 8, font });
  if (rotation) last.setRotation(degrees(rotation));
  return new Uint8Array(await doc.save());
}

function expectInsidePage(fields: Field[], page: number) {
  for (const f of fields) {
    expect(f.page).toBe(page);
    expect(f.source).toBe("appended");
    expect(f.x).toBeGreaterThanOrEqual(0);
    expect(f.y).toBeGreaterThanOrEqual(0);
    expect(f.x + f.w).toBeLessThanOrEqual(1);
    expect(f.y + f.h).toBeLessThanOrEqual(1);
    expect(f.id).toMatch(/^fld_/);
  }
  for (const a of fields) for (const b of fields) if (a !== b) expect(a.y + a.h <= b.y + 1e-9 || b.y + b.h <= a.y + 1e-9).toBe(true);
}

describe("appendSignaturePage", () => {
  it("adds a client-only page that matches the last page and puts each field on its line", async () => {
    const input = await source([595, 842]);
    const r = await appendSignaturePage(input, { includeCompany: false, agreementTitle: "Engagement Letter" });
    expect(r.pages).toEqual([
      { width: 612, height: 792 },
      { width: 595, height: 842 },
      { width: 595, height: 842 },
    ]);
    expect(r.fields.map((f) => [f.type, f.role, f.required, f.label])).toEqual([
      ["signature", "client", true, "Client signature"],
      ["full_name", "client", true, "Client name"],
      ["date_signed", "client", true, "Client signing date"],
    ]);
    expectInsidePage(r.fields, 2);

    const layout = await extractLayout(r.pdf);
    expect(layout.pageText[2]).toContain("Signature page");
    expect(layout.pageText[2]).toContain("Engagement Letter");
    expect(layout.pageText[2]).toMatch(/Client\n/);
    expect(layout.pageText[2]).not.toMatch(/Title/);
    const rules = layout.rules.filter((l) => l.page === 2);
    expect(rules).toHaveLength(3);
    for (const field of r.fields) {
      const bottom = (field.y + field.h) * 842;
      const rule = rules.find((l) => Math.abs(l.y - bottom) < 3);
      expect(rule, `line under ${field.label}`).toBeDefined();
      expect(Math.abs(rule!.x0 - field.x * 595)).toBeLessThan(2);
      // The field stays above its line; the caption is printed below it.
      expect(bottom).toBeLessThanOrEqual(rule!.y);
    }
    // The original pages are untouched.
    expect(layout.pageText[0]).toBe("Terms");
    expect((r.fields[0].h * 842)).toBeGreaterThanOrEqual(30);
  });

  it("adds a company block with a title line and the company's name", async () => {
    const r = await appendSignaturePage(await source(), { includeCompany: true, companyName: "Astra AI" });
    expect(r.fields.filter((f) => f.role === "client").map((f) => f.type)).toEqual(["signature", "full_name", "date_signed"]);
    expect(r.fields.filter((f) => f.role === "company").map((f) => [f.type, f.required, f.label])).toEqual([
      ["signature", true, "Company signature"],
      ["full_name", true, "Company signer name"],
      ["title", false, "Company signer title"],
      ["date_signed", true, "Company signing date"],
    ]);
    expectInsidePage(r.fields, 2);
    const text = (await extractLayout(r.pdf)).pageText[2];
    expect(text).toContain("Astra AI");
    expect(text).toContain("Title");
    expect(new Set(r.fields.map((f) => f.id)).size).toBe(7);
  });

  it("uses the displayed size of a rotated last page", async () => {
    const r = await appendSignaturePage(await source([792, 612], 90), { includeCompany: true });
    expect(r.pages[2]).toEqual({ width: 612, height: 792 });
    expectInsidePage(r.fields, 2);
  });

  it("fits both blocks on small pages and falls back to Letter for unusable sizes", async () => {
    const small = await appendSignaturePage(await source([420, 595]), { includeCompany: true, companyName: "Astra AI" });
    expect(small.pages[2]).toEqual({ width: 420, height: 595 });
    expectInsidePage(small.fields, 2);
    expect(Math.max(...small.fields.map((f) => f.y + f.h))).toBeLessThan(0.97);

    const landscape = await appendSignaturePage(await source([842, 595]), { includeCompany: true });
    expectInsidePage(landscape.fields, 2);
    expect(Math.max(...landscape.fields.map((f) => f.y + f.h))).toBeLessThan(0.97);

    for (const size of [
      [80, 120],
      [9000, 9000],
    ] as [number, number][]) {
      const r = await appendSignaturePage(await source(size), { includeCompany: true });
      expect(r.pages[2]).toEqual({ width: 612, height: 792 });
      expectInsidePage(r.fields, 2);
    }
  });

  it("accepts names and titles in any script and of any length", async () => {
    const r = await appendSignaturePage(await source(), {
      includeCompany: true,
      companyName: `Société Générale Ünïcode 株式会社 \u0000\n ${"Very Long Name ".repeat(30)}`,
      agreementTitle: `Соглашение об услугах "quoted" ${"word ".repeat(200)}`,
    });
    expect(r.fields).toHaveLength(7);
    expectInsidePage(r.fields, 2);
    expect((await PDFDocument.load(r.pdf)).getPageCount()).toBe(3);
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(appendSignaturePage(new Uint8Array([1, 2, 3]), { includeCompany: false })).rejects.toThrow();
  });
});
