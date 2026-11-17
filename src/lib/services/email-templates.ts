/**
 * Every message the product sends, as pure builders returning a subject, an HTML
 * body and a complete plain-text alternative.
 *
 * Each email is described once as a list of blocks and rendered twice (HTML and
 * text) from that single description, so the two versions cannot drift apart and
 * no value can reach the HTML without passing through the escaper.
 */
import { PRODUCT_NAME } from "@/lib/env";

export interface Brand {
  orgName: string;
  /** Hex colour (#rgb or #rrggbb). Anything else falls back to the default. */
  brandColor?: string;
  /** Must be an http(s) URL. Gmail strips data URLs, so they are ignored here. */
  logoUrl?: string;
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

type DateInput = Date | string | number | null | undefined;

const DEFAULT_BRAND_COLOR = "#1f3a5f";
const DARK_TEXT = "#111827";
const LIGHT_TEXT = "#ffffff";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

// ---------------------------------------------------------------------------
// Cleaning and escaping
// ---------------------------------------------------------------------------

// Control characters, Unicode line/paragraph separators, and bidirectional
// overrides (which can make "gro.live" display as "evil.org").
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
const UNSAFE_CHARS_KEEP_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  // Slice by code point so an emoji is never cut in half.
  const points = Array.from(value);
  if (points.length <= max) return value;
  return points.slice(0, max - 1).join("").trimEnd() + "…";
}

/** A value that must stay on one line (names, references, subjects). */
function line(value: unknown, max = 200): string {
  const raw = value === null || value === undefined ? "" : String(value);
  return truncate(raw.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim(), max);
}

/** Free text written by a person (a note, a decline reason); line breaks are kept. */
function multiline(value: unknown, max = 2000): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const cleaned = raw
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_CHARS_KEEP_NEWLINE, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return truncate(cleaned, max);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only http(s) links are ever placed in an href or src; anything else is dropped. */
function safeUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2000) return "";
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function formatDate(value: DateInput): string {
  if (value === null || value === undefined || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  // Month spelled out so 03/04 is never read two ways; UTC so the server's zone
  // cannot shift the day.
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

function normalizeHex(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_BRAND_COLOR;
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return DEFAULT_BRAND_COLOR;
  const hex = match[1].length === 3 ? match[1].replace(/./g, (c) => c + c) : match[1];
  return `#${hex.toLowerCase()}`;
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Background, text and border colours for the call-to-action button. The text
 * colour is whichever of white or near-black reads better on the brand colour,
 * so a pale brand colour cannot produce a white-on-yellow button.
 */
export function buttonColors(brandColor?: string): { background: string; text: string; border: string } {
  const background = normalizeHex(brandColor);
  let text = contrast(background, LIGHT_TEXT) >= contrast(background, DARK_TEXT) ? LIGHT_TEXT : DARK_TEXT;
  // Mid-tone colours (pure red, for one) sit just under 4.5:1 against both;
  // true black always clears it where white does not.
  if (contrast(background, text) < 4.5 && contrast(background, "#000000") > contrast(background, text)) text = "#000000";
  // A near-white button would vanish on the white card without an outline.
  const border = contrast(background, "#ffffff") < 1.6 ? "#6b7280" : background;
  return { background, text, border };
}

// ---------------------------------------------------------------------------
// Block model and renderers
// ---------------------------------------------------------------------------

type Inline = string | { b: string };
type Block =
  | { kind: "p"; parts: Inline[] }
  | { kind: "quote"; label: string; body: string }
  | { kind: "button"; label: string; url: string }
  | { kind: "details"; rows: [string, string][] }
  | { kind: "note"; text: string };

const b = (text: string): Inline => ({ b: text });
const p = (...parts: Inline[]): Block => ({ kind: "p", parts });
const note = (text: string): Block => ({ kind: "note", text });

function inlineHtml(parts: Inline[]): string {
  return parts
    .map((part) => (typeof part === "string" ? escapeHtml(part) : `<strong>${escapeHtml(part.b)}</strong>`))
    .join("");
}

function inlineText(parts: Inline[]): string {
  return parts.map((part) => (typeof part === "string" ? part : part.b)).join("");
}

function blockHtml(block: Block, brandColor?: string): string {
  switch (block.kind) {
    case "p":
      return `<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:24px;color:#1f2937;">${inlineHtml(block.parts)}</p>`;
    case "quote":
      return (
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">` +
        `<tr><td bgcolor="#f9fafb" style="background-color:#f9fafb;border-left:3px solid #9ca3af;padding:12px 16px;font-family:${FONT};font-size:15px;line-height:22px;color:#374151;">` +
        `<span style="display:block;font-size:12px;line-height:18px;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em;">${escapeHtml(block.label)}</span>` +
        `${escapeHtml(block.body).replace(/\n/g, "<br>")}</td></tr></table>`
      );
    case "button": {
      const colors = buttonColors(brandColor);
      const href = escapeHtml(block.url);
      // Padding lives on the cell, not the link: Outlook's Word engine ignores
      // padding on inline anchors but honours it on table cells.
      return (
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 12px;">` +
        `<tr><td align="center" bgcolor="${colors.background}" style="background-color:${colors.background};border:1px solid ${colors.border};border-radius:6px;padding:13px 28px;">` +
        `<a href="${href}" target="_blank" rel="noopener" style="display:inline-block;font-family:${FONT};font-size:16px;line-height:20px;font-weight:bold;color:${colors.text};text-decoration:none;">` +
        `<span style="color:${colors.text};">${escapeHtml(block.label)}</span></a></td></tr></table>` +
        `<p style="margin:0 0 20px;font-family:${FONT};font-size:13px;line-height:19px;color:#6b7280;">` +
        `If the button does not work, copy this link into your browser:<br>` +
        `<a href="${href}" target="_blank" rel="noopener" style="color:#1d4ed8;text-decoration:underline;word-break:break-all;">${href}</a></p>`
      );
    }
    case "details":
      return (
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">` +
        block.rows
          .map(
            ([label, value]) =>
              `<tr><td valign="top" style="padding:2px 16px 2px 0;font-family:${FONT};font-size:14px;line-height:21px;color:#6b7280;white-space:nowrap;">${escapeHtml(label)}</td>` +
              `<td valign="top" style="padding:2px 0;font-family:${FONT};font-size:14px;line-height:21px;color:#1f2937;word-break:break-word;">${escapeHtml(value)}</td></tr>`,
          )
          .join("") +
        `</table>`
      );
    case "note":
      return `<p style="margin:0 0 12px;font-family:${FONT};font-size:13px;line-height:19px;color:#6b7280;">${escapeHtml(block.text)}</p>`;
  }
}

function blockText(block: Block): string {
  switch (block.kind) {
    case "p":
      return inlineText(block.parts);
    case "quote":
      return `${block.label}:\n${block.body
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")}`;
    case "button":
      return `${block.label}:\n${block.url}`;
    case "details":
      return block.rows.map(([label, value]) => `${label}: ${value}`).join("\n");
    case "note":
      return block.text;
  }
}

interface Layout {
  subject: string;
  /** Shown by inbox lists next to the subject. */
  preheader: string;
  /** Name shown at the top of the card. */
  senderName: string;
  brandColor?: string;
  logoUrl?: string;
  blocks: Block[];
  footer: string;
}

function render(layout: Layout): EmailContent {
  const subject = line(layout.subject, 200) || `Message from ${PRODUCT_NAME}`;
  const senderName = line(layout.senderName, 120) || PRODUCT_NAME;
  const accent = normalizeHex(layout.brandColor);
  const logo = safeUrl(layout.logoUrl);
  const blocks = layout.blocks.filter((block) => {
    if (block.kind === "button") return block.url !== "";
    if (block.kind === "quote") return block.body !== "";
    if (block.kind === "details") return block.rows.length > 0;
    return true;
  });

  const header = logo
    ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(senderName)}" height="40" style="display:block;height:40px;width:auto;max-width:240px;border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:18px;font-weight:bold;color:#111827;">`
    : `<span style="font-family:${FONT};font-size:18px;line-height:24px;font-weight:bold;color:#111827;">${escapeHtml(senderName)}</span>`;

  const html =
    `<!DOCTYPE html>` +
    `<html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    // Declared light-only so clients that honour the declaration leave the
    // colours alone; clients that force-invert still get dark-on-light pairs
    // with explicit backgrounds everywhere, which invert consistently.
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">` +
    `<title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background-color:#f3f4f6;">` +
    `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(line(layout.preheader, 180))}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f4f6" style="background-color:#f3f4f6;">` +
    `<tr><td align="center" style="padding:24px 12px;">` +
    `<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:600px;background-color:#ffffff;border:1px solid #e5e7eb;">` +
    `<tr><td height="6" bgcolor="${accent}" style="background-color:${accent};font-size:0;line-height:0;height:6px;">&nbsp;</td></tr>` +
    `<tr><td style="padding:28px 32px 4px;">${header}</td></tr>` +
    `<tr><td style="padding:16px 32px 16px;">${blocks.map((block) => blockHtml(block, layout.brandColor)).join("")}</td></tr>` +
    `</table>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">` +
    `<tr><td style="padding:16px 32px;font-family:${FONT};font-size:12px;line-height:18px;color:#6b7280;">${escapeHtml(layout.footer)}</td></tr>` +
    `</table>` +
    `<!--[if mso]></td></tr></table><![endif]-->` +
    `</td></tr></table></body></html>`;

  const text = [...blocks.map(blockText), "--", layout.footer].join("\n\n") + "\n";
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Shared wording
// ---------------------------------------------------------------------------

function orgName(brand: Brand | undefined): string {
  return line(brand?.orgName, 120) || "Your service provider";
}

function greeting(name: unknown): Block {
  const clean = line(name, 120);
  return p(clean ? `Hi ${clean},` : "Hello,");
}

function withReference(agreement: string, reference: string): string {
  return reference ? `${agreement} (${reference})` : agreement;
}

function branded(brand: Brand | undefined, rest: Omit<Layout, "senderName" | "brandColor" | "logoUrl" | "footer"> & { footer?: string }): EmailContent {
  const org = orgName(brand);
  return render({
    ...rest,
    senderName: org,
    brandColor: brand?.brandColor,
    logoUrl: brand?.logoUrl,
    footer: rest.footer ?? `Sent by ${org} through ${PRODUCT_NAME}, the service ${org} uses to get agreements signed.`,
  });
}

/** Footer for emails that go to the company's own team rather than to a client. */
function teamFooter(org: string): string {
  return `You are receiving this because you are on the ${org} team on ${PRODUCT_NAME}.`;
}

// ---------------------------------------------------------------------------
// Emails to the client
// ---------------------------------------------------------------------------

export function signingRequestEmail(input: {
  brand: Brand;
  signerName: string;
  agreementName: string;
  fileReference: string;
  url: string;
  message?: string | null;
  expiresAt?: DateInput;
}): EmailContent {
  const org = orgName(input.brand);
  const agreement = line(input.agreementName) || "your agreement";
  const reference = line(input.fileReference, 80);
  const expires = formatDate(input.expiresAt);
  const blocks: Block[] = [
    greeting(input.signerName),
    p(
      `${org} has sent you `,
      b(agreement),
      ` to sign${reference ? ` for file ${reference}` : ""}. ${org} needs it signed before work on your file can start.`,
    ),
    { kind: "quote", label: `A note from ${org}`, body: multiline(input.message) },
    { kind: "button", label: "Review and sign", url: safeUrl(input.url) },
    p(
      "It takes about two minutes, on a phone or a computer. You do not need an account, and you can read the whole agreement before you sign anything.",
    ),
    p("Once it is fully signed, you will get an email with a copy of the signed agreement to keep."),
  ];
  if (expires) blocks.push(p("The link stops working on ", b(expires), "."));
  blocks.push(
    note(
      `This request comes from ${org}. The link is personal to you, so please do not forward it. If you have questions about the agreement, reply to this email or contact ${org} directly.`,
    ),
  );
  return branded(input.brand, {
    subject: `${org} needs your signature: ${withReference(agreement, reference)}`,
    preheader: `Review and sign ${agreement}. It takes about two minutes.`,
    blocks,
  });
}

export function reminderEmail(input: {
  brand: Brand;
  signerName: string;
  agreementName: string;
  fileReference: string;
  url: string;
  reminderNumber: number;
  expiresAt?: DateInput;
}): EmailContent {
  const org = orgName(input.brand);
  const agreement = line(input.agreementName) || "your agreement";
  const reference = line(input.fileReference, 80);
  const expires = formatDate(input.expiresAt);
  const count = Number.isFinite(input.reminderNumber) ? Math.max(1, Math.floor(input.reminderNumber)) : 1;
  const blocks: Block[] = [
    greeting(input.signerName),
    p(
      count === 1 ? "A quick reminder: " : "Following up again: ",
      `${org} is still waiting for your signature on `,
      b(agreement),
      `${reference ? ` for file ${reference}` : ""}. Work on your file cannot start until it is signed.`,
    ),
    { kind: "button", label: "Review and sign", url: safeUrl(input.url) },
    p("It takes about two minutes and you do not need an account."),
  ];
  if (expires) blocks.push(p("The link stops working on ", b(expires), ". After that ", `${org} would have to send you a new one.`));
  blocks.push(
    note(
      `Already signed, or think this reached you by mistake? Reply to this email or contact ${org} directly. The link is personal to you, so please do not forward it.`,
    ),
  );
  return branded(input.brand, {
    subject: `Reminder: ${org} is waiting for your signature on ${withReference(agreement, reference)}`,
    preheader: expires ? `Please sign before ${expires}.` : `It takes about two minutes to review and sign.`,
    blocks,
  });
}

export function voidedEmail(input: {
  brand: Brand;
  signerName: string;
  agreementName: string;
  reason?: string | null;
}): EmailContent {
  const org = orgName(input.brand);
  const agreement = line(input.agreementName) || "the agreement";
  return branded(input.brand, {
    subject: `${org} cancelled the signing request for ${agreement}`,
    preheader: "You do not need to do anything. The earlier link no longer works.",
    blocks: [
      greeting(input.signerName),
      p(`${org} has cancelled the request to sign `, b(agreement), ". The link you were sent earlier no longer works."),
      { kind: "quote", label: `Reason given by ${org}`, body: multiline(input.reason, 1000) },
      p(`You do not need to do anything. If a signature is still needed, ${org} will send you a new request.`),
      note(`Questions? Reply to this email or contact ${org} directly.`),
    ],
  });
}

/** Tells a signer their link ran out of time. Not the company cancelling: nobody decided anything. */
export function linkExpiredEmail(input: {
  brand: Brand;
  signerName: string;
  agreementName: string;
  /** The day the link stopped working, already written out (e.g. "15 November 2026"). */
  expiredOn?: string | null;
}): EmailContent {
  const org = orgName(input.brand);
  const agreement = line(input.agreementName) || "the agreement";
  const on = line(input.expiredOn, 40);
  return branded(input.brand, {
    subject: `Your signing link for ${agreement} has expired`,
    preheader: `Ask ${org} to send the agreement again if you still want to sign.`,
    blocks: [
      greeting(input.signerName),
      p(`The link ${org} sent you to sign `, b(agreement), ` expired${on ? ` on ${on}` : ""} before the agreement was signed, so it no longer works.`),
      p(`If you still want to sign, contact ${org} and ask them to send the agreement again. You will get a new link.`),
      note(`Questions? Reply to this email or contact ${org} directly.`),
    ],
  });
}

/** Tells a client who signed that the company declined to countersign, so nothing is in effect. */
export function agreementNotCompletedEmail(input: { brand: Brand; signerName: string; agreementName: string }): EmailContent {
  const org = orgName(input.brand);
  const agreement = line(input.agreementName) || "the agreement";
  return branded(input.brand, {
    subject: `${agreement} with ${org} was not completed`,
    preheader: `${org} did not countersign, so the agreement is not in effect.`,
    blocks: [
      greeting(input.signerName),
      p("You signed ", b(agreement), `, but ${org} did not countersign it, so the agreement was not completed and is not in effect.`),
      p(`The link you were sent no longer works. Contact ${org} if you were expecting the agreement to go ahead.`),
      note(`Questions? Reply to this email or contact ${org} directly.`),
    ],
  });
}

// ---------------------------------------------------------------------------
// Emails that can go to either side
// ---------------------------------------------------------------------------

export function completedEmail(input: {
  brand: Brand;
  recipientName: string;
  agreementName: string;
  fileReference: string;
  downloadUrl: string;
  attached: boolean;
}): EmailContent {
  const org = orgName(input.brand);
  const agreement = line(input.agreementName) || "The agreement";
  const reference = line(input.fileReference, 80);
  return branded(input.brand, {
    subject: `Signed and complete: ${withReference(agreement, reference)}`,
    preheader: input.attached ? "Your signed copy is attached." : "Your signed copy is ready to download.",
    blocks: [
      greeting(input.recipientName),
      p(b(agreement), `${reference ? ` for file ${reference}` : ""} with ${org} has been signed by everyone. Nothing more is needed from you.`),
      p(
        input.attached
          ? "The signed PDF is attached to this email. You can also download it at any time:"
          : "Download the signed PDF here:",
      ),
      { kind: "button", label: "Download signed agreement", url: safeUrl(input.downloadUrl) },
      p("The last page of the PDF is a certificate recording who signed and when. Keep a copy for your records."),
      note(`Questions about the agreement? Reply to this email or contact ${org} directly.`),
    ],
  });
}

// ---------------------------------------------------------------------------
// Emails to the company's team
// ---------------------------------------------------------------------------

export function countersignRequestEmail(input: {
  brand: Brand;
  signerName: string;
  clientName: string;
  agreementName: string;
  fileReference: string;
  url: string;
}): EmailContent {
  const org = orgName(input.brand);
  const agreement = line(input.agreementName) || "the agreement";
  const reference = line(input.fileReference, 80);
  const client = line(input.clientName, 120) || "The client";
  return branded(input.brand, {
    subject: `Your countersignature is needed: ${client} signed ${withReference(agreement, reference)}`,
    preheader: `${client} has signed. Add ${org}'s signature to finish.`,
    blocks: [
      greeting(input.signerName),
      p(b(client), " has signed ", b(agreement), `${reference ? ` for file ${reference}` : ""}. It now needs your signature on behalf of ${org}.`),
      { kind: "button", label: "Review and countersign", url: safeUrl(input.url) },
      p(
        `It takes under a minute. As soon as you sign, the agreement is sealed, ${client} and ${org} both get the signed PDF, and the file is cleared to start work.`,
      ),
      note("This link signs on your behalf, so please do not forward it."),
    ],
    footer: teamFooter(org),
  });
}

export function declinedEmail(input: {
  brand: Brand;
  recipientName: string;
  clientName: string;
  agreementName: string;
  fileReference: string;
  reason?: string | null;
  fileUrl: string;
}): EmailContent {
  const org = orgName(input.brand);
  const agreement = line(input.agreementName) || "the agreement";
  const reference = line(input.fileReference, 80);
  const client = line(input.clientName, 120) || "The client";
  const reason = multiline(input.reason, 1000);
  const blocks: Block[] = [
    greeting(input.recipientName),
    p(b(client), " declined to sign ", b(agreement), `${reference ? ` for file ${reference}` : ""}.`),
  ];
  if (reason) blocks.push({ kind: "quote", label: "Their reason", body: reason });
  else blocks.push(p("They did not give a reason."));
  blocks.push(
    p("No more reminders will be sent and their signing link no longer works. Work on this file should not start until an agreement is signed."),
    { kind: "button", label: "Open the file", url: safeUrl(input.fileUrl) },
    p("From the file you can contact the client and send the agreement again once their concern is resolved."),
  );
  return branded(input.brand, {
    subject: `${client} declined to sign ${withReference(agreement, reference)}`,
    preheader: reason ? `Reason: ${line(reason, 120)}` : "They did not give a reason.",
    blocks,
    footer: teamFooter(org),
  });
}

export function expiredEmail(input: {
  brand: Brand;
  recipientName: string;
  clientName: string;
  agreementName: string;
  fileReference: string;
  fileUrl: string;
}): EmailContent {
  const org = orgName(input.brand);
  const agreement = line(input.agreementName) || "the agreement";
  const reference = line(input.fileReference, 80);
  const client = line(input.clientName, 120) || "The client";
  return branded(input.brand, {
    subject: `Expired unsigned: ${client} did not sign ${withReference(agreement, reference)}`,
    preheader: "The signing link has expired. Send a new one from the file.",
    blocks: [
      greeting(input.recipientName),
      p(b(client), " did not sign ", b(agreement), `${reference ? ` for file ${reference}` : ""} in time, and the signing link has expired.`),
      p("No more reminders will be sent. Work on this file should not start until an agreement is signed."),
      { kind: "button", label: "Open the file", url: safeUrl(input.fileUrl) },
      p("From the file you can send the agreement again with a fresh link. It is worth checking the client's email address first."),
    ],
    footer: teamFooter(org),
  });
}

export function deliveryFailedEmail(input: {
  brand: Brand;
  recipientName: string;
  clientName: string;
  clientEmail: string;
  fileReference: string;
  fileUrl: string;
}): EmailContent {
  const org = orgName(input.brand);
  const reference = line(input.fileReference, 80);
  const client = line(input.clientName, 120) || "the client";
  const address = line(input.clientEmail, 254) || "(no address on file)";
  return branded(input.brand, {
    subject: `Agreement email could not be delivered to ${client}${reference ? ` (${reference})` : ""}`,
    preheader: `The email to ${address} failed, so the client has not received the agreement.`,
    blocks: [
      greeting(input.recipientName),
      p("The agreement email for this file could not be delivered, so the client has not received their signing link."),
      {
        kind: "details",
        rows: [
          ["Client", client],
          ["Email used", address],
          ...(reference ? ([["File", reference]] as [string, string][]) : []),
        ],
      },
      p("The most common cause is a typo in the email address."),
      { kind: "button", label: "Open the file", url: safeUrl(input.fileUrl) },
      p(
        "From the file you can correct the address and send the agreement again, or copy the signing link and pass it to the client yourself. The agreement stays unsigned until one of those happens.",
      ),
    ],
    footer: teamFooter(org),
  });
}

/**
 * Sent when the client has signed and the company's own signature is what is holding
 * the agreement up: the countersigner did not act on their reminders, can no longer
 * sign, or nobody is set up to countersign at all.
 */
export function countersignOverdueEmail(input: {
  brand: Brand;
  recipientName: string;
  clientName: string;
  agreementName: string;
  fileReference: string;
  /** The person who was asked, when there is one. */
  countersignerName?: string | null;
  /** One plain sentence saying why this needs someone else, without a trailing full stop. */
  reason?: string | null;
  fileUrl: string;
}): EmailContent {
  const org = orgName(input.brand);
  const agreement = line(input.agreementName) || "the agreement";
  const reference = line(input.fileReference, 80);
  const client = line(input.clientName, 120) || "The client";
  const countersigner = line(input.countersignerName, 120);
  const reason = line(input.reason, 300).replace(/[.\s]+$/, "");
  return branded(input.brand, {
    subject: `Countersignature overdue: ${client} is waiting on ${withReference(agreement, reference)}`,
    preheader: `${client} has signed. ${org}'s signature is still missing.`,
    blocks: [
      greeting(input.recipientName),
      p(b(client), " has signed ", b(agreement), `${reference ? ` for file ${reference}` : ""}, but it has not been countersigned for ${org}, so it is not complete.`),
      p(reason ? `${reason}.` : countersigner ? `${countersigner} was asked to countersign and has not done so.` : "Nobody is set up to countersign for your company."),
      { kind: "button", label: "Open the file", url: safeUrl(input.fileUrl) },
      p(
        "An owner or admin can countersign from the file, or choose a different countersigner in Settings. The client gets their signed copy, and the file is cleared to start work, as soon as that is done.",
      ),
    ],
    footer: teamFooter(org),
  });
}

/**
 * Sent when everyone has signed but the sealed PDF could not be produced. The
 * signatures are safe and the product keeps retrying; the team is told because the
 * client is waiting for a copy that has not arrived.
 */
export function finalCopyFailedEmail(input: {
  brand: Brand;
  recipientName: string;
  clientName: string;
  agreementName: string;
  fileReference: string;
  /** What went wrong, as recorded on the file's timeline. */
  error?: string | null;
  fileUrl: string;
}): EmailContent {
  const org = orgName(input.brand);
  const agreement = line(input.agreementName) || "the agreement";
  const reference = line(input.fileReference, 80);
  const client = line(input.clientName, 120) || "the client";
  const error = line(input.error, 300);
  return branded(input.brand, {
    subject: `Signed, but the final copy could not be produced: ${withReference(agreement, reference)}`,
    preheader: "Every signature is recorded. The signed PDF is being retried automatically.",
    blocks: [
      greeting(input.recipientName),
      p("Everyone has signed ", b(agreement), `${reference ? ` for file ${reference}` : ""}, but the final signed PDF could not be produced, so ${client} has not received their copy yet.`),
      p("Every signature is recorded and nothing needs to be signed again. We retry automatically, and you can also retry from the file."),
      { kind: "details", rows: error ? [["What went wrong", error]] : [] },
      { kind: "button", label: "Open the file", url: safeUrl(input.fileUrl) },
      p("If it has not completed within a few hours, contact support and mention the file reference."),
    ],
    footer: teamFooter(org),
  });
}

// ---------------------------------------------------------------------------
// Account emails (from the product itself, not from an organization)
// ---------------------------------------------------------------------------

/** Asks someone who has just signed up to confirm that the address is theirs. */
export function verifyEmailEmail(input: { name: string; orgName: string; url: string }): EmailContent {
  const org = line(input.orgName, 120) || "your company";
  return render({
    subject: `Confirm your email address for ${PRODUCT_NAME}`,
    preheader: `Confirm your address so ${PRODUCT_NAME} can email agreements to your clients.`,
    senderName: PRODUCT_NAME,
    blocks: [
      greeting(input.name),
      p(`Thanks for setting up ${org} on ${PRODUCT_NAME}. Confirm that this email address is yours:`),
      { kind: "button", label: "Confirm my email address", url: safeUrl(input.url) },
      p(
        `Until you confirm, ${PRODUCT_NAME} does not email agreements to your clients for you. You can still create files and copy each signing link to send yourself.`,
      ),
      note("The link works once and expires after 48 hours. If you did not create this account, you can ignore this email."),
    ],
    footer: `Sent by ${PRODUCT_NAME} because this address was used to create an account.`,
  });
}

export function passwordResetEmail(input: { name: string; url: string }): EmailContent {
  return render({
    subject: `Reset your ${PRODUCT_NAME} password`,
    preheader: "Use this link to choose a new password. It expires soon.",
    senderName: PRODUCT_NAME,
    blocks: [
      greeting(input.name),
      p(`Someone asked to reset the password for your ${PRODUCT_NAME} account. If that was you, choose a new password here:`),
      { kind: "button", label: "Choose a new password", url: safeUrl(input.url) },
      p("The link works once and expires after a short time. Your current password keeps working until you set a new one."),
      note("If you did not ask for this, you can ignore this email. Nobody can change your password without this link."),
    ],
    footer: `Sent by ${PRODUCT_NAME} because a password reset was requested for this address.`,
  });
}

export function inviteEmail(input: { orgName: string; inviterName: string; url: string }): EmailContent {
  const org = line(input.orgName, 120) || "a team";
  const inviter = line(input.inviterName, 120) || "A colleague";
  return render({
    subject: `${inviter} invited you to join ${org} on ${PRODUCT_NAME}`,
    preheader: `Set up your account to send and track ${org}'s client agreements.`,
    senderName: PRODUCT_NAME,
    blocks: [
      p("Hello,"),
      p(b(inviter), " has invited you to join ", b(org), ` on ${PRODUCT_NAME}, which ${org} uses to get its client agreement signed on every file.`),
      { kind: "button", label: "Accept the invitation", url: safeUrl(input.url) },
      p("You will be asked to choose a password. It takes about a minute, and then you can create files and see which agreements are signed."),
      note(`This invitation is for you only and expires after a few days. If you were not expecting it, you can ignore this email.`),
    ],
    footer: `Sent by ${PRODUCT_NAME} because ${inviter} entered this address to invite you to ${org}.`,
  });
}

/**
 * Sent in place of the invitation when the invited address already has an account with
 * another company. The person who sent the invite is told nothing different, so an
 * invite cannot be used to find out who has an account; the owner of the mailbox is the
 * one who learns why it cannot be accepted and what to do.
 */
export function inviteExistingAccountEmail(input: { orgName: string; inviterName: string; resetUrl: string }): EmailContent {
  const org = line(input.orgName, 120) || "a team";
  const inviter = line(input.inviterName, 120) || "A colleague";
  return render({
    subject: `${inviter} tried to invite you to ${org} on ${PRODUCT_NAME}`,
    preheader: "This address already has an account, so the invitation cannot be accepted as sent.",
    senderName: PRODUCT_NAME,
    blocks: [
      p("Hello,"),
      p(b(inviter), " tried to invite you to join ", b(org), ` on ${PRODUCT_NAME}.`),
      p(
        `This email address already has a ${PRODUCT_NAME} account with a different company, and an address can belong to one company account only, so this invitation cannot be accepted.`,
      ),
      p(`To join ${org}, ask ${inviter} to invite you at a different email address.`),
      p("If you do not recognise the existing account, set a new password for it. That signs out anyone else who is using it:"),
      { kind: "button", label: "Set a new password", url: safeUrl(input.resetUrl) },
      note(`${inviter} has not been told that this address has an account. If you were not expecting this, you can ignore this email.`),
    ],
    footer: `Sent by ${PRODUCT_NAME} because ${inviter} entered this address to invite you to ${org}.`,
  });
}

/** Tells an account holder about a run of failed sign-ins. Their account is not locked, so the email says so. */
export function signInAlertEmail(input: { name: string; resetUrl: string }): EmailContent {
  return render({
    subject: `Many failed sign-in attempts on your ${PRODUCT_NAME} account`,
    preheader: "Your account is not locked and your password still works.",
    senderName: PRODUCT_NAME,
    blocks: [
      greeting(input.name),
      p(`Someone has tried many times in the last hour to sign in to your ${PRODUCT_NAME} account with the wrong password.`),
      p("Nobody got in through these attempts. Your account is not locked and your password still works."),
      p("If this was not you, and your password is short or used on other sites, choose a new one:"),
      { kind: "button", label: "Choose a new password", url: safeUrl(input.resetUrl) },
      note("If this was you, there is nothing you need to do. We send this message at most once an hour."),
    ],
    footer: `Sent by ${PRODUCT_NAME} because of repeated failed sign-in attempts for this address.`,
  });
}
