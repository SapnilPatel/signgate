/**
 * The signing certificate: the pages appended to every sealed agreement that
 * record who signed, when, from where, and everything that happened to the
 * envelope. It is laid out as a flowing document because none of its content
 * has a known length: names, emails, titles and timelines are whatever the
 * customer's data happens to be.
 */
import { rgb } from "pdf-lib";
import type { PDFDocument, PDFFont, PDFPage } from "pdf-lib";
import type { CertificateData, CertificateEvent, CertificateSigner } from "./types";
import { embedFonts } from "./fonts";
import { displaySize } from "./geometry";
import { drawableText, truncateToWidth, undrawableCharacters, wrapText } from "./stamp";

const LETTER = { width: 612, height: 792 };
const MARGIN = 54;
const LABEL_WIDTH = 132;
const VALUE_X = MARGIN + LABEL_WIDTH;
// The page size follows the agreement (see usePageSize). These are set at the start of each
// certificate and read only by the synchronous drawing that follows, so two seals running in
// one process cannot see each other's size.
let PAGE_WIDTH = LETTER.width;
let PAGE_HEIGHT = LETTER.height;
let CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
let VALUE_WIDTH = CONTENT_WIDTH - LABEL_WIDTH;

/**
 * Matches the certificate to the agreement's last page as displayed, so an A4 agreement does
 * not end in Letter pages that print at a different scale. Sizes the layout was not designed
 * for (receipts, posters, unreadable boxes) fall back to Letter.
 */
function usePageSize(doc: PDFDocument): void {
  let size = LETTER;
  try {
    const pages = doc.getPages();
    const last = pages.length ? displaySize(pages[pages.length - 1]) : null;
    if (last && last.width >= 400 && last.width <= 900 && last.height >= 500 && last.height <= 1300) {
      size = { width: last.width, height: last.height };
    }
  } catch {
    // keep Letter
  }
  PAGE_WIDTH = size.width;
  PAGE_HEIGHT = size.height;
  CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
  VALUE_WIDTH = CONTENT_WIDTH - LABEL_WIDTH;
}
/** Content stops here so it never runs into the page footer. */
const BOTTOM = MARGIN + 22;

const INK = rgb(0.09, 0.11, 0.15);
const MUTED = rgb(0.4, 0.43, 0.48);
const RULE = rgb(0.82, 0.84, 0.87);
const PANEL = rgb(0.965, 0.97, 0.975);

const BODY = 9.5;
const SMALL = 8;
const LEADING = 13;
const NOT_RECORDED = "Not recorded";

export interface CertificateFonts {
  regular: PDFFont;
  bold: PDFFont;
}

/** `2026-03-09 14:05:07 UTC`: sortable, and unreadable as anything but one instant. */
export function formatUtc(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return NOT_RECORDED;
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/**
 * Reduces a browser user agent to "Chrome 126 on Windows". The raw string is
 * mostly historical noise; a reader of the certificate wants to know which
 * browser and what kind of device. Unrecognized agents are shown as sent, cut short.
 */
export function describeUserAgent(userAgent: unknown): string {
  if (typeof userAgent !== "string" || !userAgent.trim()) return NOT_RECORDED;
  const ua = userAgent.slice(0, 2000);
  // Order matters: Edge and Opera also claim to be Chrome, and Chrome claims to be Safari.
  const browsers: [RegExp, string][] = [
    [/Edg(?:e|A|iOS)?\/(\d+)/, "Edge"],
    [/OPR\/(\d+)/, "Opera"],
    [/SamsungBrowser\/(\d+)/, "Samsung Internet"],
    [/(?:Firefox|FxiOS)\/(\d+)/, "Firefox"],
    [/(?:Chrome|CriOS)\/(\d+)/, "Chrome"],
    [/Version\/(\d+)[\d.]*.*Safari\//, "Safari"],
  ];
  let browser = "";
  for (const [pattern, name] of browsers) {
    const match = pattern.exec(ua);
    if (match) {
      browser = `${name} ${match[1]}`;
      break;
    }
  }
  const android = /Android (\d+)/.exec(ua);
  const os = /Windows NT/.test(ua)
    ? "Windows"
    : /iPhone|iPod/.test(ua)
      ? "iPhone"
      : /iPad/.test(ua)
        ? "iPad"
        : android
          ? `Android ${android[1]}`
          : /Android/.test(ua)
            ? "Android"
            : /Mac OS X|Macintosh/.test(ua)
              ? "macOS"
              : /CrOS/.test(ua)
                ? "ChromeOS"
                : /Linux/.test(ua)
                  ? "Linux"
                  : "";
  if (browser && os) return `${browser} on ${os}`;
  if (browser || os) return browser || os;
  const flat = ua.replace(/\s+/g, " ").trim();
  return flat.length > 90 ? `${flat.slice(0, 89)}\u2026` : flat;
}

/** Lays content out top to bottom and starts a new page when the next block will not fit. */
class Flow {
  readonly pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0;

  constructor(
    private readonly doc: PDFDocument,
    readonly fonts: CertificateFonts,
    private readonly orgName: string,
  ) {
    this.addPage();
  }

  addPage(): void {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(this.page);
    const first = this.pages.length === 1;
    let y = PAGE_HEIGHT - MARGIN;
    if (first) {
      if (this.orgName) {
        this.line(truncateToWidth(this.fonts.regular, this.orgName, SMALL + 1, CONTENT_WIDTH), MARGIN, y - 8, SMALL + 1, false, MUTED);
        y -= 18;
      }
      this.line("Signing certificate", MARGIN, y - 20, 22, true);
      y -= 32;
    } else {
      this.line("Signing certificate (continued)", MARGIN, y - 9, 10, true);
      y -= 17;
    }
    this.rule(y, INK, 0.8);
    this.y = y - 16;
  }

  /** Starts a new page unless `height` more points fit on this one. */
  ensure(height: number): boolean {
    if (this.y - height >= BOTTOM) return false;
    this.addPage();
    return true;
  }

  line(text: string, x: number, baseline: number, size: number, bold = false, color = INK): void {
    if (!text) return;
    this.page.drawText(text, { x, y: baseline, size, font: bold ? this.fonts.bold : this.fonts.regular, color });
  }

  rule(y: number, color = RULE, thickness = 0.5): void {
    this.page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness, color });
  }

  heading(text: string, keepWith = 40): void {
    // A heading stranded at the bottom of a page, away from its content, reads as a mistake.
    this.ensure(22 + keepWith);
    this.y -= 6;
    this.line(text.toUpperCase(), MARGIN, this.y - 8, SMALL, true, MUTED);
    this.y -= 13;
    this.rule(this.y);
    this.y -= 10;
  }

  paragraph(text: string, size = BODY - 0.5, color = INK): void {
    const lines = wrapText(this.fonts.regular, text, size, CONTENT_WIDTH, 12);
    this.ensure(lines.length * (size + 3.5) + 4);
    for (const l of lines) {
      this.line(l, MARGIN, this.y - size, size, false, color);
      this.y -= size + 3.5;
    }
    this.y -= 6;
  }
}

interface Row {
  label: string;
  lines: string[];
  height: number;
}

/** Code points printed after a value whose characters the font cannot draw; enough for any name. */
const MAX_CODE_POINTS = 48;

/**
 * A certificate is evidence of who signed. When a name is in a script the font cannot draw, the
 * boxes alone would identify nobody, so the characters' Unicode code points are printed after
 * them: unambiguous, and enough to recover the exact text.
 */
function withCodePoints(fonts: CertificateFonts, value: unknown, max: number): { text: string; lost: boolean } {
  const text = drawableText(fonts.regular, value, max);
  const lost = undrawableCharacters(fonts.regular, value, max);
  if (!lost.length) return { text, lost: false };
  const codes = lost.slice(0, MAX_CODE_POINTS).map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
  // The code points are the part that identifies the signer, so the boxes give way to them when space is short.
  const shown = Array.from(text);
  const head = shown.length > 80 ? `${shown.slice(0, 80).join("")}...` : text;
  return { text: `${head} [${codes.join(" ")}${lost.length > MAX_CODE_POINTS ? " ..." : ""}]`, lost: true };
}

function row(fonts: CertificateFonts, label: string, value: unknown, maxLines = 4, width = VALUE_WIDTH, lostLabels?: string[]): Row {
  // Values are capped before measuring so a megabyte of pasted text cannot stall sealing.
  const rendered = lostLabels ? withCodePoints(fonts, value, 600) : { text: drawableText(fonts.regular, value, 600), lost: false };
  if (rendered.lost && lostLabels) lostLabels.push(label);
  const text = rendered.text || "\u2014";
  const lines = wrapText(fonts.regular, text, BODY, width, maxLines);
  return { label, lines, height: Math.max(1, lines.length) * LEADING + 4 };
}

function drawRow(flow: Flow, r: Row, labelX = MARGIN, valueX = VALUE_X): void {
  flow.line(r.label, labelX, flow.y - BODY, SMALL + 0.5, false, MUTED);
  r.lines.forEach((l, i) => flow.line(l, valueX, flow.y - BODY - i * LEADING, BODY));
  flow.y -= r.height;
}

function drawSigner(flow: Flow, signer: CertificateSigner, index: number, lost: string[]): void {
  const fonts = flow.fonts;
  const inset = 12;
  const valueX = VALUE_X + inset;
  const width = VALUE_WIDTH - inset * 2;
  const role = signer?.role === "company" ? "Company" : "Client";
  const signerLost: string[] = [];
  const rows = [
    // Room for the code points of a name the font cannot draw.
    row(fonts, "Name", signer?.name, 8, width, signerLost),
    row(fonts, "Email", signer?.email, 3, width),
    row(fonts, "Signed at", formatUtc(signer?.signedAt), 1, width),
    row(fonts, "Consent to sign electronically", signer?.consentAt ? `Recorded ${formatUtc(signer.consentAt)}` : NOT_RECORDED, 2, width),
    row(fonts, "IP address", signer?.ip || NOT_RECORDED, 2, width),
    row(fonts, "Device", describeUserAgent(signer?.userAgent), 3, width),
    row(fonts, "Method", signer?.method || NOT_RECORDED, 3, width),
  ];
  if (signerLost.length) lost.push(`The name of signer ${index + 1}`);
  const titleHeight = 22;
  const height = titleHeight + rows.reduce((sum, r) => sum + r.height, 0) + 10;
  // A signer's record is evidence; splitting it across pages invites misreading.
  flow.ensure(height + 10);
  flow.page.drawRectangle({
    x: MARGIN,
    y: flow.y - height,
    width: CONTENT_WIDTH,
    height,
    color: PANEL,
    borderColor: RULE,
    borderWidth: 0.5,
  });
  flow.line(`Signer ${index + 1}  \u00b7  ${role}`, MARGIN + inset, flow.y - 15, BODY + 0.5, true);
  flow.y -= titleHeight;
  for (const r of rows) drawRow(flow, r, MARGIN + inset, valueX);
  flow.y -= 10 + 10;
}

function drawTimeline(flow: Flow, events: readonly CertificateEvent[]): void {
  const header = () => {
    flow.line("Time", MARGIN, flow.y - SMALL, SMALL, true, MUTED);
    flow.line("Event", VALUE_X, flow.y - SMALL, SMALL, true, MUTED);
    flow.y -= SMALL + 5;
    flow.rule(flow.y);
    flow.y -= 5;
  };
  flow.heading("Event timeline", 60);
  if (events.length === 0) {
    flow.paragraph("No events were recorded.", BODY - 0.5, MUTED);
    return;
  }
  header();
  for (const event of events) {
    const lines = wrapText(flow.fonts.regular, drawableText(flow.fonts.regular, event?.description, 600) || "\u2014", BODY - 0.5, VALUE_WIDTH, 4);
    const height = Math.max(1, lines.length) * 12 + 5;
    if (flow.ensure(height)) header();
    flow.line(formatUtc(event?.at), MARGIN, flow.y - (BODY - 0.5), BODY - 0.5, false, MUTED);
    lines.forEach((l, i) => flow.line(l, VALUE_X, flow.y - (BODY - 0.5) - i * 12, BODY - 0.5));
    flow.y -= height;
  }
  flow.y -= 6;
}

/**
 * Appends the signing certificate to the document as one or more pages the size of
 * the agreement's last page (Letter when that size is unusual).
 * Pass `fonts` when the caller has already embedded Noto Sans in this document,
 * so the sealed file does not carry the same font twice.
 * Returns a plain description of each name that holds characters the font could not draw
 * (printed as boxes followed by their code points); empty when everything printed as given.
 */
export async function appendCertificate(doc: PDFDocument, data: CertificateData, fonts?: CertificateFonts): Promise<string[]> {
  const lost: string[] = [];
  const f = fonts ?? (await embedFonts(doc, ["regular", "bold"]));
  // After the last await: everything below is synchronous.
  usePageSize(doc);
  const text = (value: unknown, max = 600) => drawableText(f.regular, value, max);
  const signers = Array.isArray(data?.signers) ? data.signers : [];
  const events = Array.isArray(data?.events) ? data.events : [];
  const envelopeId = text(data?.envelopeId, 200);

  const flow = new Flow(doc, f, text(data?.orgName, 200));

  const summaryLost: string[] = [];
  const summary = [
    row(f, "Agreement", data?.agreementName, 6, VALUE_WIDTH, summaryLost),
    row(f, "File reference", data?.fileReference, 3),
    row(f, "Organization", data?.orgName, 6, VALUE_WIDTH, summaryLost),
    row(f, "Envelope ID", data?.envelopeId, 3),
    row(f, "Completed", formatUtc(data?.completedAt), 1),
    row(f, "Original document SHA-256", data?.originalSha256, 3),
  ];
  if (text(data?.verifyUrl)) summary.push(row(f, "Verify this document", data.verifyUrl, 5));
  for (const label of summaryLost) lost.push(`The ${label.toLowerCase()} name`);
  for (const r of summary) {
    flow.ensure(r.height);
    drawRow(flow, r);
  }
  flow.y -= 8;

  const count = signers.length;
  flow.paragraph(
    `${count === 1 ? "The signer" : "Each signer"} listed below was shown this agreement and consented to sign it electronically before signing. ` +
      "The times, network addresses and devices on this certificate were recorded automatically as each step happened. " +
      "The SHA-256 value above identifies the exact document that was presented for signature. " +
      "This certificate is part of the signed record and must be kept with the agreement.",
    BODY - 0.5,
    MUTED,
  );

  flow.heading(count === 1 ? "Signer" : "Signers", 150);
  if (count === 0) flow.paragraph("No signers were recorded.", BODY - 0.5, MUTED);
  signers.forEach((signer, i) => drawSigner(flow, signer, i, lost));

  drawTimeline(flow, events);

  // Footers are drawn last because "page 2 of 5" needs the final page count.
  flow.pages.forEach((page, i) => {
    const pageLabel = `Certificate page ${i + 1} of ${flow.pages.length}`;
    const labelWidth = f.regular.widthOfTextAtSize(pageLabel, SMALL);
    page.drawLine({ start: { x: MARGIN, y: MARGIN + 6 }, end: { x: PAGE_WIDTH - MARGIN, y: MARGIN + 6 }, thickness: 0.5, color: RULE });
    const left = truncateToWidth(f.regular, `Envelope ${envelopeId}  \u00b7  Sealed by Signgate`, SMALL, CONTENT_WIDTH - labelWidth - 16);
    if (left) page.drawText(left, { x: MARGIN, y: MARGIN - 6, size: SMALL, font: f.regular, color: MUTED });
    page.drawText(pageLabel, { x: PAGE_WIDTH - MARGIN - labelWidth, y: MARGIN - 6, size: SMALL, font: f.regular, color: MUTED });
  });
  return lost;
}
