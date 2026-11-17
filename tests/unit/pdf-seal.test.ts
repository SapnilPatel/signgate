import { describe, it, expect } from "vitest";
import { writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { getDocumentProxy } from "unpdf";
import { sha256Hex } from "@/lib/ids";
import type { Field } from "@/lib/types";
import { DocumentError } from "@/lib/pdf/types";
import type { CertificateData, CertificateEvent, SealInput } from "@/lib/pdf/types";
import { appendCertificate, describeUserAgent, formatUtc } from "@/lib/pdf/certificate";
import { sealDocument } from "@/lib/pdf/seal";

const CHROME_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

async function agreement(pages: { rotation?: number; crop?: [number, number, number, number] }[] = [{}, {}]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  pages.forEach((spec, i) => {
    const page = doc.addPage([612, 792]);
    page.drawText(`Agreement body page ${i + 1}`, { x: 72, y: 700, size: 12, font });
    if (spec.rotation) page.setRotation(degrees(spec.rotation));
    if (spec.crop) page.setCropBox(...spec.crop);
  });
  return doc.save();
}

function events(count: number): CertificateEvent[] {
  const start = Date.UTC(2026, 0, 5, 9, 0, 0);
  return Array.from({ length: count }, (_, i) => ({
    at: new Date(start + i * 61_000),
    description: i % 7 === 3 ? `Reminder ${i} emailed to client.with.a.long.address+${"tag".repeat(20)}@subdomain.example.com after no response` : `Event number ${i} recorded`,
  }));
}

function certificate(overrides: Partial<CertificateData> = {}): CertificateData {
  return {
    envelopeId: "env_test0000000000aa",
    agreementName: "Client Services Agreement",
    fileReference: "F-2026-0042",
    orgName: "Example Advisory Ltd",
    originalSha256: sha256Hex("original"),
    completedAt: new Date(Date.UTC(2026, 0, 6, 15, 4, 5)),
    verifyUrl: "https://app.example.com/verify/env_test0000000000aa",
    signers: [
      { role: "client", name: "Jane Example", email: "jane@example.com", signedAt: new Date(Date.UTC(2026, 0, 6, 14, 0, 0)), consentAt: new Date(Date.UTC(2026, 0, 6, 13, 58, 0)), ip: "203.0.113.7", userAgent: CHROME_WINDOWS, method: "Signed via emailed link" },
      { role: "company", name: "Sam Counter", email: "sam@example.org", signedAt: new Date(Date.UTC(2026, 0, 6, 15, 4, 5)), consentAt: null, ip: null, userAgent: null, method: "Saved signature applied automatically" },
    ],
    events: events(6),
    ...overrides,
  };
}

interface Run {
  text: string;
  x: number;
  y: number;
  width: number;
  u: number;
  v: number;
  dirX: number;
}

async function readPages(pdf: Uint8Array): Promise<{ runs: Run[]; text: string; width: number; height: number }[]> {
  const proxy = await getDocumentProxy(pdf.slice());
  const out = [];
  for (let n = 1; n <= proxy.numPages; n++) {
    const page = await proxy.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const vt = viewport.transform as number[];
    const runs: Run[] = [];
    for (const item of (await page.getTextContent()).items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const [a, b, , , e, f] = item.transform as number[];
      const [u, v] = viewport.convertToViewportPoint(e, f);
      runs.push({ text: item.str, x: e, y: f, width: item.width, u, v, dirX: (vt[0] * a + vt[2] * b) / Math.hypot(a, b) });
    }
    out.push({ runs, text: runs.map((r) => r.text).join(" "), width: viewport.width, height: viewport.height });
  }
  return out;
}

async function certificateOnly(data: CertificateData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  await appendCertificate(doc, data);
  return doc.save();
}

/** Every run of text must sit inside the page margins: nothing clipped, nothing running off the sheet. */
function expectInsideMargins(pages: Awaited<ReturnType<typeof readPages>>): void {
  for (const page of pages) {
    expect(page.width).toBe(612);
    expect(page.height).toBe(792);
    for (const run of page.runs) {
      expect(run.x, run.text).toBeGreaterThanOrEqual(54 - 0.01);
      expect(run.x + run.width, run.text).toBeLessThanOrEqual(612 - 54 + 0.5);
      expect(run.y, run.text).toBeGreaterThanOrEqual(40);
      expect(run.y, run.text).toBeLessThanOrEqual(792 - 54);
    }
  }
}

describe("certificate", () => {
  it("shows the agreement, every signer and the audit details", async () => {
    const pages = await readPages(await certificateOnly(certificate()));
    expect(pages).toHaveLength(2);
    const text = pages.map((p) => p.text).join(" ");
    for (const expected of [
      "Signing certificate",
      "Client Services Agreement",
      "F-2026-0042",
      "Example Advisory Ltd",
      "env_test0000000000aa",
      "2026-01-06 15:04:05 UTC",
      sha256Hex("original"),
      "https://app.example.com/verify/env_test0000000000aa",
      "Jane Example",
      "jane@example.com",
      "2026-01-06 14:00:00 UTC",
      "Recorded 2026-01-06 13:58:00 UTC",
      "203.0.113.7",
      "Chrome 126 on Windows",
      "Signed via emailed link",
      "Sam Counter",
      "Saved signature applied automatically",
      "consented to sign it electronically",
      "part of the signed record",
      "Event number 5 recorded",
      "Certificate page 1 of 2",
      "Certificate page 2 of 2",
    ]) {
      expect(text).toContain(expected);
    }
    // The raw user agent is noise; only its summary is printed.
    expect(text).not.toContain("AppleWebKit");
    expectInsideMargins(pages);
  });

  it("aligns labels and values in two columns", async () => {
    const [page] = await readPages(await certificateOnly(certificate()));
    const at = (label: string) => page.runs.find((r) => r.text === label)!;
    const valueX = page.runs.find((r) => r.text === "F-2026-0042")!.x;
    expect(at("Agreement").x).toBe(at("File reference").x);
    expect(page.runs.find((r) => r.text === "Client Services Agreement")!.x).toBe(valueX);
    expect(page.runs.find((r) => r.text === "2026-01-06 15:04:05 UTC")!.x).toBe(valueX);
    // Label and value share a baseline.
    expect(at("File reference").y).toBeCloseTo(page.runs.find((r) => r.text === "F-2026-0042")!.y, 3);
  });

  it("flows a 200-event timeline across pages with every event present and in order", async () => {
    const pages = await readPages(await certificateOnly(certificate({ events: events(200) })));
    expect(pages.length).toBeGreaterThan(3);
    expectInsideMargins(pages);
    const all = pages.map((p) => p.text).join(" ");
    let cursor = 0;
    for (let i = 0; i < 200; i++) {
      const needle = i % 7 === 3 ? `Reminder ${i} emailed` : `Event number ${i} recorded`;
      const found = all.indexOf(needle, cursor);
      expect(found, needle).toBeGreaterThanOrEqual(cursor);
      cursor = found;
    }
    pages.forEach((page, i) => {
      expect(page.text).toContain(`Certificate page ${i + 1} of ${pages.length}`);
      expect(page.text).toContain(i === 0 ? "Signing certificate" : "Signing certificate (continued)");
    });
    // Rows on a page never overlap: baselines strictly descend in the event column.
    for (const page of pages.slice(1, -1)) {
      const times = page.runs.filter((r) => /^2026-01-05 \d\d:\d\d:\d\d UTC$/.test(r.text)).map((r) => r.y);
      expect(times.length).toBeGreaterThan(10);
      for (let i = 1; i < times.length; i++) expect(times[i - 1] - times[i]).toBeGreaterThanOrEqual(12);
    }
  });

  it("keeps very long names, emails, titles and user agents inside the page", async () => {
    const long = certificate({
      agreementName: "Master Services, Data Processing and Mutual Non-Disclosure Agreement ".repeat(12),
      fileReference: "REF-" + "9".repeat(400),
      orgName: "Example " + "Verylongcompanyname".repeat(30) + " Holdings",
      envelopeId: "env_" + "x".repeat(300),
      originalSha256: "ab".repeat(300),
      verifyUrl: "https://app.example.com/verify/" + "q".repeat(700) + "?a=1&b=2",
      signers: Array.from({ length: 9 }, (_, i) => ({
        role: i % 2 ? ("company" as const) : ("client" as const),
        name: "Wolfeschlegelsteinhausenbergerdorff ".repeat(10) + i,
        email: "a".repeat(250) + "@" + "sub.".repeat(40) + "example.com",
        signedAt: new Date(Date.UTC(2026, 1, 1, 0, 0, i)),
        consentAt: new Date(Date.UTC(2026, 1, 1)),
        ip: "2001:0db8:85a3:0000:0000:8a2e:0370:7334, 198.51.100.24, 203.0.113.199, " + "10.0.0.1, ".repeat(30),
        userAgent: "CustomAgent/" + "z".repeat(3000),
        method: "Signed via emailed link ".repeat(20),
      })),
      events: [{ at: new Date(Date.UTC(2026, 1, 1)), description: "Unbroken" + "W".repeat(2000) }, ...events(3)],
    });
    const pages = await readPages(await certificateOnly(long));
    expect(pages.length).toBeGreaterThan(2);
    expectInsideMargins(pages);
    const all = pages.map((p) => p.text).join(" ");
    for (let i = 0; i < 9; i++) expect(all).toContain(`Signer ${i + 1}`);
    // Long values are cut with an ellipsis rather than pushing everything else off the page.
    expect(all).toContain("\u2026");
    expect(all).toContain("Event number 2 recorded");
  });

  it("renders non-Latin names and survives missing, null and invalid data", async () => {
    const odd = {
      envelopeId: null,
      agreementName: "Acuerdo de servicios \u2014 \u0414\u043e\u0433\u043e\u0432\u043e\u0440 \u5951\u7d04 \u{1F4DD}",
      fileReference: undefined,
      orgName: 42,
      originalSha256: "",
      completedAt: new Date(Number.NaN),
      signers: [
        { role: "client", name: "Nguy\u1ec5n Th\u1ecb Th\u1eed", email: "thu@example.com", signedAt: new Date("not a date"), method: "" },
        { role: "nobody", name: "\u5c71\u7530\u592a\u90ce", email: null, signedAt: "2026-02-03T04:05:06Z", consentAt: "garbage", ip: 5, userAgent: {}, method: null },
        null,
      ],
      events: [null, { at: null, description: null }, { at: new Date(0), description: "Sent\r\nwith\ttabs\u0000 and \u200bcontrols" }, "junk"],
    } as unknown as CertificateData;
    const pages = await readPages(await certificateOnly(odd));
    expectInsideMargins(pages);
    const all = pages.map((p) => p.text.normalize("NFC")).join(" ");
    expect(all).toContain("Nguy\u1ec5n Th\u1ecb Th\u1eed");
    expect(all).toContain("\u0414\u043e\u0433\u043e\u0432\u043e\u0440");
    expect(all).toContain("Not recorded");
    expect(all).toContain("2026-02-03 04:05:06 UTC");
    expect(all).toContain("1970-01-01 00:00:00 UTC");
    expect(all).toContain("Sent with tabs and controls");

    for (const broken of [{}, { signers: "x", events: 7 }, null] as unknown as CertificateData[]) {
      const bytes = await certificateOnly(broken);
      expect((await readPages(bytes))[0].text).toContain("Signing certificate");
    }
  });

  it("formats times and user agents predictably", () => {
    expect(formatUtc(new Date(Date.UTC(2026, 11, 31, 23, 59, 59, 999)))).toBe("2026-12-31 23:59:59 UTC");
    expect(formatUtc("2026-03-04T05:06:07+02:00")).toBe("2026-03-04 03:06:07 UTC");
    for (const bad of [null, undefined, new Date(Number.NaN), "nope", {}, 8.7e15 * 10]) expect(formatUtc(bad)).toBe("Not recorded");

    expect(describeUserAgent(CHROME_WINDOWS)).toBe("Chrome 126 on Windows");
    expect(describeUserAgent(SAFARI_IPHONE)).toBe("Safari 17 on iPhone");
    expect(describeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0")).toBe("Firefox 127 on macOS");
    expect(describeUserAgent(CHROME_WINDOWS + " Edg/126.0.0.0")).toBe("Edge 126 on Windows");
    expect(describeUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36")).toBe("Chrome 125 on Android 14");
    expect(describeUserAgent("curl/8.6.0")).toBe("curl/8.6.0");
    expect(describeUserAgent("x".repeat(5000)).length).toBe(90);
    for (const none of [null, undefined, "", "   ", 5, {}]) expect(describeUserAgent(none)).toBe("Not recorded");
  });
});

describe("sealDocument", () => {
  function fields(): Field[] {
    const base = { role: "client" as const, required: true, source: "manual" as const };
    return [
      { ...base, id: "fld_name", page: 0, x: 0.1, y: 0.4, w: 0.4, h: 0.03, type: "full_name", label: "Name" },
      { ...base, id: "fld_date", page: 1, x: 0.1, y: 0.5, w: 0.3, h: 0.03, type: "date_signed", label: "Date" },
      { ...base, id: "fld_agree", page: 1, x: 0.1, y: 0.6, w: 0.03, h: 0.02, type: "checkbox", label: "Agree" },
    ];
  }

  it("stamps, appends the certificate, sets metadata and returns the hash of the exact bytes", async () => {
    const pdf = await agreement();
    const before = Buffer.from(pdf).toString("base64");
    const input: SealInput = { pdf, fields: fields(), values: { fld_name: "Jane Example", fld_date: "2026-01-06", fld_agree: true }, certificate: certificate() };
    const sealed = await sealDocument(input);

    expect(sealed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.sha256).toBe(sha256Hex(sealed.pdf));
    expect(Buffer.from(pdf).toString("base64")).toBe(before);

    const doc = await PDFDocument.load(sealed.pdf, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(4);
    expect(doc.getTitle()).toBe("Client Services Agreement");
    expect(doc.getProducer()).toBe("Signgate");
    expect(doc.getKeywords()).toContain("envelope:env_test0000000000aa");
    expect(doc.getSubject()).toContain("F-2026-0042");
    expect(doc.getModificationDate()?.toISOString()).toBe("2026-01-06T15:04:05.000Z");
    // Saving a reloaded copy must not be needed for the hash to hold: the bytes handed back are final.
    expect(sha256Hex(new Uint8Array(sealed.pdf))).toBe(sealed.sha256);

    const pages = await readPages(sealed.pdf);
    expect(pages[0].text).toContain("Agreement body page 1");
    expect(pages[0].text).toContain("Jane Example");
    expect(pages[1].text).toContain("2026-01-06");
    expect(pages[2].text).toContain("Signing certificate");
    expect(pages[2].text).toContain("Jane Example");
  });

  it("prints the certificate at the agreement's own page size, and at Letter when that size is unusual", async () => {
    const a4 = await PDFDocument.create();
    a4.addPage([595.28, 841.89]);
    await appendCertificate(a4, certificate({ events: events(120) }));
    const pages = await readPages(await a4.save());
    expect(pages.length).toBeGreaterThan(2);
    for (const page of pages) {
      expect(page.width).toBeCloseTo(595.28, 1);
      expect(page.height).toBeCloseTo(841.89, 1);
      for (const run of page.runs) {
        expect(run.x, run.text).toBeGreaterThanOrEqual(54 - 0.01);
        expect(run.x + run.width, run.text).toBeLessThanOrEqual(595.28 - 54 + 0.5);
      }
    }

    const receipt = await PDFDocument.create();
    receipt.addPage([220, 400]);
    await appendCertificate(receipt, certificate());
    const size = receipt.getPages()[1].getSize();
    expect([size.width, size.height]).toEqual([612, 792]);
  });

  it("puts a small envelope reference in the bottom margin of every original page, upright on rotated pages", async () => {
    const specs = [{}, { rotation: 90 }, { rotation: 180 }, { rotation: 270 }, { crop: [60, 90, 380, 500] as [number, number, number, number] }];
    const sealed = await sealDocument({ pdf: await agreement(specs), fields: [], values: {}, certificate: certificate() });
    const pages = await readPages(sealed.pdf);
    expect(pages.length).toBe(specs.length + 2);
    for (const page of pages.slice(0, specs.length)) {
      const footer = page.runs.filter((r) => r.text === "Envelope env_test0000000000aa");
      expect(footer).toHaveLength(1);
      expect(footer[0].u).toBeCloseTo(24, 1);
      expect(page.height - footer[0].v).toBeCloseTo(12, 1);
      expect(footer[0].dirX).toBeCloseTo(1, 5);
    }
    // The certificate has its own footer, not the page stamp.
    for (const page of pages.slice(specs.length)) {
      expect(page.runs.filter((r) => r.text === "Envelope env_test0000000000aa")).toHaveLength(0);
      expect(page.text).toContain("Sealed by Signgate");
    }
  });

  it("seals with nothing to stamp, unknown pages, junk values and odd certificate text", async () => {
    const junkFields = [...fields(), { ...fields()[0], id: "fld_far", page: 99 }, null] as unknown as Field[];
    const sealed = await sealDocument({
      pdf: await agreement([{}]),
      fields: junkFields,
      values: { fld_name: "\u5c71\u7530 \u{1F600}", fld_far: "nowhere", fld_date: true },
      certificate: certificate({ envelopeId: "env_\u5c71\u{1F600}\u0000id", agreementName: "", events: [], signers: [] }),
    });
    expect(sealed.sha256).toBe(sha256Hex(sealed.pdf));
    const doc = await PDFDocument.load(sealed.pdf, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getTitle()).toBe("Signed agreement");
    const pages = await readPages(sealed.pdf);
    expect(pages[1].text).toContain("No signers were recorded.");
    expect(pages[1].text).toContain("No events were recorded.");
  });

  it("re-seals an already sealed document without corrupting it", async () => {
    const first = await sealDocument({ pdf: await agreement([{}]), fields: [], values: {}, certificate: certificate() });
    const second = await sealDocument({ pdf: first.pdf, fields: [], values: {}, certificate: certificate({ envelopeId: "env_second" }) });
    expect((await PDFDocument.load(second.pdf)).getPageCount()).toBe(5);
    expect(second.sha256).not.toBe(first.sha256);
  });

  it("rejects an unreadable document with a DocumentError", async () => {
    for (const pdf of [new Uint8Array(), new TextEncoder().encode("%PDF-1.7 not really"), undefined as unknown as Uint8Array]) {
      const error = await sealDocument({ pdf, fields: [], values: {}, certificate: certificate() }).catch((e) => e);
      expect(error).toBeInstanceOf(DocumentError);
    }
    const noInput = await sealDocument(undefined as unknown as SealInput).catch((e) => e);
    expect(noInput).toBeInstanceOf(DocumentError);
  });

  // Set SIGNGATE_WRITE_SAMPLES to a directory to get sealed PDFs for a visual check.
  it.runIf(process.env.SIGNGATE_WRITE_SAMPLES)("writes samples for visual review", async () => {
    const dir = process.env.SIGNGATE_WRITE_SAMPLES!;
    const input: SealInput = { pdf: await agreement([{}, { rotation: 90 }]), fields: fields(), values: { fld_name: "Jane Example", fld_date: "2026-01-06", fld_agree: true }, certificate: certificate({ events: events(60) }) };
    await writeFile(`${dir}/sealed-sample.pdf`, (await sealDocument(input)).pdf);
  });
});

describe("sealDocument: what could not be shown as entered", () => {
  const nameField = (id: string, y: number): Field => ({ id, page: 0, x: 0.1, y, w: 0.5, h: 0.03, type: "full_name", role: "client", required: true, label: "Client name", source: "manual" });

  it("reports nothing for values the font can draw", async () => {
    const f = nameField("fld_latin", 0.3);
    const sealed = await sealDocument({ pdf: await agreement(), fields: [f], values: { [f.id]: "Zo\u00eb Nguy\u1ec5n Th\u1ecb \u0141ukasz" }, certificate: certificate() });
    expect(sealed.warnings).toEqual([]);
  });

  it("says which field lost characters when a name is in a script the font cannot draw", async () => {
    const a = nameField("fld_cjk", 0.3);
    const b = nameField("fld_ok", 0.4);
    const sealed = await sealDocument({
      pdf: await agreement(),
      fields: [a, b],
      values: { [a.id]: "\u5c71\u7530\u592a\u90ce", [b.id]: "Jane Example" },
      certificate: certificate(),
    });
    expect(sealed.warnings).toHaveLength(1);
    expect(sealed.warnings[0]).toMatchObject({ code: "characters_replaced", fieldId: "fld_cjk" });
    expect(sealed.warnings[0].message).toMatch(/"Client name" contains 4 characters that the signed PDF cannot print/);
    // Still sealed, and the readable value is untouched.
    const pages = await readPages(sealed.pdf);
    expect(pages[0].text).toContain("Jane Example");
    expect(sealed.sha256).toBe(sha256Hex(sealed.pdf));
  });

  it("prints the code points of an undrawable signer name on the certificate and reports it", async () => {
    const cert = certificate();
    cert.signers[0] = { ...cert.signers[0], name: "\u05d3\u05d5\u05d3 Example" };
    const sealed = await sealDocument({ pdf: await agreement(), fields: [], values: {}, certificate: cert });
    const text = (await readPages(sealed.pdf)).map((p) => p.text).join(" ").replace(/\s+/g, " ");
    expect(text).toContain("[U+05D3 U+05D5 U+05D3]");
    expect(text).toContain("Example");
    expect(sealed.warnings).toHaveLength(1);
    expect(sealed.warnings[0].code).toBe("characters_replaced");
    expect(sealed.warnings[0].fieldId).toBeUndefined();
    expect(sealed.warnings[0].message).toMatch(/The name of signer 1 on the signing certificate/);
    const pages = await readPages(sealed.pdf);
    expectInsideMargins(pages.slice(2));
  });

  it("keeps a very long undrawable name inside the certificate", async () => {
    const cert = certificate();
    cert.signers[0] = { ...cert.signers[0], name: "\u5c71".repeat(300) };
    const pages = await readPages(await certificateOnly(cert));
    expectInsideMargins(pages);
    expect(pages.map((p) => p.text).join(" ")).toMatch(/U\+5C71 \.\.\.\]/);
  });
});
