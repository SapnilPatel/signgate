/**
 * Seeds ONE demo company so a newcomer can sign in and see the product in use:
 * an active agreement, a draft one, and files in every state the product has.
 *
 *   DEMO_PASSWORD=<at least 10 characters> npm run seed:demo
 *
 * Everything in it is fictional (reserved example domains, invented people and firms).
 *
 * How it works, and why it is safe to point at a hosted database:
 * - It only ever touches the demo company. If the demo owner already exists it
 *   prints that and exits without changing anything.
 * - It never sends email. It refuses to start when an email provider is present in
 *   the environment, and it then switches the email service to its in-process test
 *   outbox, so even a later change to that guard could not put a message on the wire.
 * - The data is produced by running the real lifecycle through src/lib/services
 *   (sign-up, invitation, upload, send, view, sign, countersign, decline, void,
 *   archive), with each signer's own secret link.
 * - To make it look like a month of use, the script runs that lifecycle against a
 *   simulated clock, oldest step first. Every timestamp the services write, including
 *   the ones printed on the sealed PDFs' certificates, therefore agrees with the
 *   timeline, and nothing that feeds a sealed PDF's hash is edited afterwards.
 * - Timestamps the DATABASE fills in by default (created_at on rows the services do
 *   not stamp themselves) would still say "now", so after each step this script
 *   moves those to the step's simulated time with direct SQL. That SQL lives here
 *   and only here: this is a seed tool, not application code, and nothing in the
 *   product may edit timestamps this way.
 */
import { createHash, randomBytes } from "node:crypto";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Actor, RequestMeta } from "@/lib/services/context";
import type { Field, FieldValues } from "@/lib/types";

const DEMO = {
  orgName: "Northfield Legal (demo)",
  legalName: "Northfield Legal LLP",
  ownerName: "Dana Whitlock",
  ownerTitle: "Managing Partner",
  ownerEmail: "demo@signgate.example",
  memberName: "Marcus Ellery",
  memberTitle: "Paralegal",
  memberEmail: "marcus.ellery@signgate.example",
  timeZone: "America/New_York",
  brandColor: "#0f5c4d",
} as const;

function fail(message: string): never {
  console.error(`seed-demo: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Guards. These run before anything is loaded or connected.
// ---------------------------------------------------------------------------

const EMAIL_ENV = ["RESEND_API_KEY", "SMTP_USER"].filter((name) => process.env[name]?.trim());
if (EMAIL_ENV.length > 0) {
  fail(
    `${EMAIL_ENV.join(" and ")} ${EMAIL_ENV.length === 1 ? "is" : "are"} set, so this process could send real email. ` +
      "The demo data is fictional and must never be emailed. Unset the email settings for this command and run it again.",
  );
}
const PASSWORD = process.env.DEMO_PASSWORD ?? "";
if (PASSWORD.length < 10) {
  fail("DEMO_PASSWORD is required and must be at least 10 characters. It becomes the demo owner's password.");
}
if (process.env.DATABASE_URL?.trim() && (process.env.APP_SECRET?.trim().length ?? 0) < 32) {
  fail(
    "DATABASE_URL is set but APP_SECRET is not. Signing links are derived from APP_SECRET, so seeding a hosted database " +
      "without the deployment's own APP_SECRET would create links the deployment cannot open. Set APP_SECRET to the deployment's value and run again.",
  );
}
if (!process.env.DATABASE_URL?.trim() && (process.env.NODE_ENV === "test" || process.env.PGLITE_MEMORY === "1")) {
  fail("This would seed an in-memory database that disappears when the command ends. Unset NODE_ENV=test and PGLITE_MEMORY, or set DATABASE_URL.");
}
// Field detection must give the same result on every run, so it never calls out to a model here.
delete process.env.ANTHROPIC_API_KEY;

// The email service imports "server-only", which throws outside a Next.js server build.
// Give Node the same empty stand-in the unit tests use, before any service is loaded.
{
  const nodeRequire = createRequire(path.join(process.cwd(), "package.json"));
  const resolved = nodeRequire.resolve("server-only");
  const stub = new Module(resolved);
  stub.filename = resolved;
  stub.loaded = true;
  stub.exports = {};
  nodeRequire.cache[resolved] = stub;
}

// ---------------------------------------------------------------------------
// Simulated clock
// ---------------------------------------------------------------------------

const RealDate = Date;
/** The moment the seed started, by the real clock. Every simulated moment is earlier than this. */
const REAL_START = RealDate.now();
let clockOffset = 0;

/** A drop-in for the global Date whose "now" is the simulated moment. It keeps ticking, so events stay in order. */
function installClock(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sim: any = function SimDate(this: unknown, ...args: unknown[]) {
    if (!new.target) return new RealDate(RealDate.now() + clockOffset).toString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const made = args.length === 0 ? new RealDate(RealDate.now() + clockOffset) : new (RealDate as any)(...args);
    Object.setPrototypeOf(made, new.target.prototype);
    return made;
  };
  // Sharing the prototype keeps `instanceof Date` true for dates made before and after the swap.
  Sim.prototype = RealDate.prototype;
  Sim.now = () => RealDate.now() + clockOffset;
  Sim.parse = RealDate.parse;
  Sim.UTC = RealDate.UTC;
  globalThis.Date = Sim as DateConstructor;
}
function setClock(at: number): void {
  clockOffset = at - RealDate.now();
}
function restoreClock(): void {
  clockOffset = 0;
  globalThis.Date = RealDate;
}

const DAY = 86_400_000;
/** Offset of `timeZone` from UTC at `at`, in milliseconds. */
function zoneOffset(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new RealDate(at));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return RealDate.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(at / 1000) * 1000;
}
/** `days` days before the seed started, at `clock` ("14:05") on the firm's own wall clock. */
function daysAgo(days: number, clock: string): number {
  const [hour, minute] = clock.split(":").map(Number);
  const rough = REAL_START - days * DAY;
  const local = new RealDate(rough + zoneOffset(rough, DEMO.timeZone));
  const wall = RealDate.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute, Math.floor(Math.random() * 50));
  return wall - zoneOffset(wall, DEMO.timeZone);
}
function hoursAgo(hours: number): number {
  return REAL_START - Math.round(hours * 3_600_000);
}

// ---------------------------------------------------------------------------
// Signature images: a small PNG drawn in code, different for each person.
// ---------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}
/** Encodes 8-bit RGBA pixels as a PNG. */
function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw, { level: 9 })), pngChunk("IEND", Buffer.alloc(0))]);
}
/** A handwriting-like scrawl on a transparent background, the same every time for the same name. */
function signaturePng(name: string, opts: { width?: number; height?: number } = {}): string {
  const width = opts.width ?? 420;
  const height = opts.height ?? 130;
  let seed = createHash("sha256").update(name).digest().readUInt32BE(0);
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const alpha = new Float32Array(width * height);
  const dot = (cx: number, cy: number, radius: number) => {
    for (let y = Math.max(0, Math.floor(cy - radius - 1)); y <= Math.min(height - 1, Math.ceil(cy + radius + 1)); y++) {
      for (let x = Math.max(0, Math.floor(cx - radius - 1)); x <= Math.min(width - 1, Math.ceil(cx + radius + 1)); x++) {
        const cover = Math.min(1, Math.max(0, radius + 0.5 - Math.hypot(x - cx, y - cy)));
        if (cover > alpha[y * width + x]) alpha[y * width + x] = cover;
      }
    }
  };
  const f1 = 5 + random() * 4;
  const f2 = 11 + random() * 7;
  const p1 = random() * Math.PI * 2;
  const p2 = random() * Math.PI * 2;
  const p3 = random() * Math.PI * 2;
  const gap = 0.36 + random() * 0.2;
  const rise = (random() - 0.3) * 0.16 * height;
  const pad = width * 0.07;
  for (let i = 0; i <= 2600; i++) {
    const t = i / 2600;
    if (t > gap && t < gap + 0.035) continue; // the pen lifts between the two names
    const capital = t < 0.12 || (t > gap + 0.035 && t < gap + 0.13);
    const swing = height * (capital ? 0.3 : 0.11) * (1 - 0.35 * t);
    const x = pad + t * (width - pad * 2.4) + width * 0.022 * Math.sin(t * 61 + p3);
    const y = height * 0.52 - rise * t + swing * (Math.sin(Math.PI * 2 * f1 * t + p1) * 0.75 + Math.sin(Math.PI * 2 * f2 * t + p2) * 0.45);
    dot(x, y, height * 0.0125 * (1 + 0.35 * Math.sin(t * 40 + p1)));
  }
  for (let i = 0; i <= 500; i++) {
    const t = i / 500; // the flourish underneath
    dot(width * (0.3 + 0.64 * t), height * (0.86 - 0.07 * t) - rise * 0.5 + height * 0.035 * Math.sin(t * Math.PI), height * 0.009);
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < alpha.length; i++) {
    rgba.set([22, 32, 74, Math.round(alpha[i] * 255)], i * 4);
  }
  return `data:image/png;base64,${encodePng(width, height, rgba).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// The agreements
// ---------------------------------------------------------------------------

const ENGAGEMENT_NAME = "Client engagement agreement";
const ENGAGEMENT_TEXT = `CLIENT ENGAGEMENT AGREEMENT

This Engagement Agreement (the "Agreement") is made on ____________________ between Northfield Legal LLP (the "Firm") and ______________________________ (the "Client").

1. Scope of services

The Firm will advise and represent the Client in the matter described in the Firm's opening letter and recorded on the Firm's file for the Client (the "Matter"). Work outside the Matter, including any appeal, is not covered unless the Firm agrees to it in writing. The Firm will not start work on the Matter until both parties have signed this Agreement.

2. Fees and billing

The Firm charges for time spent on the Matter at the hourly rates in its current schedule of rates, a copy of which has been given to the Client. Time is recorded in units of six minutes. The Firm will send an itemised invoice each month. Invoices are payable within thirty days of the invoice date.

3. Retainer and expenses

The Client will pay a retainer before work begins. The retainer is held in the Firm's client trust account and applied to invoices as they fall due, and any unused balance is returned when the Matter ends. Filing fees, courier charges, expert fees and other expenses paid on the Client's behalf are charged at cost. The Firm will ask for the Client's approval before incurring any single expense above five hundred dollars.

4. Communication and instructions

The Firm will keep the Client informed of progress and will answer messages within two business days. The Client agrees to give the Firm complete and accurate information, to respond promptly to requests for instructions, and to tell the Firm at once if its contact details change.

5. Confidentiality and conflicts

The Firm will keep the Client's information confidential, as required by the rules of professional conduct, both during the Matter and after it ends. The Firm has searched its records and has found no conflict of interest in acting for the Client. If a conflict arises later, the Firm will tell the Client promptly and explain the options available.

6. Ending the engagement

The Client may end this engagement at any time by writing to the Firm. The Firm may withdraw for good reason, including unpaid invoices or instructions it cannot ethically follow, on reasonable notice and subject to any permission the court requires. Fees and expenses incurred up to the end of the engagement remain payable.

7. General

This Agreement is the whole agreement between the parties about the Matter and replaces anything said or written before it. It may be changed only in writing signed by both parties. It is governed by the laws of the State of New York. Each party may sign electronically, and a signed electronic copy is as valid as a signed original.

Signed by the parties:

NORTHFIELD LEGAL LLP

By: ______________________________

Name: ____________________________

Title: ___________________________

Date: ____________________________

CLIENT

By: ______________________________

Name: ____________________________

Title: ___________________________

Date: ____________________________
`;

const CONSULTATION_NAME = "Limited scope consultation agreement";
const CONSULTATION_TEXT = `LIMITED SCOPE CONSULTATION AGREEMENT

This agreement is made on ____________________ between Northfield Legal LLP (the "Firm") and ______________________________ (the "Client").

1. What is covered

The Firm will meet the Client once, for up to ninety minutes, to review the documents the Client provides and to give its initial view of the Client's position and options. The Firm will confirm that advice in a short written summary within five business days of the meeting.

2. What is not covered

The Firm is not taking on the Client's matter. It will not write to anyone on the Client's behalf, file anything, or track any deadline. If the Client would like the Firm to act further, the parties will sign the Firm's client engagement agreement first.

3. Fee

The fee for the consultation is fixed and is payable before the meeting. It is not refundable once the meeting has taken place.

4. Confidentiality

Everything the Client tells the Firm is confidential, whether or not the Client later instructs the Firm.

CLIENT

Signature: ______________________________

Name: ____________________________

Date: ____________________________
`;

/**
 * What the engagement agreement's fields have to be, in reading order. Detection is
 * checked against this, and anything it got wrong (most often who fills a field in)
 * is corrected through updateTemplateFields before the agreement is activated.
 */
const EXPECTED_FIELDS: readonly Pick<Field, "type" | "role" | "required" | "label" | "mergeKey">[] = [
  { type: "date", role: "prefill", required: false, label: "Agreement date", mergeKey: "today" },
  { type: "full_name", role: "prefill", required: false, label: "Client name", mergeKey: "client_name" },
  { type: "signature", role: "company", required: true, label: "Firm signature" },
  { type: "full_name", role: "company", required: true, label: "Firm signer name" },
  { type: "title", role: "company", required: false, label: "Firm signer title" },
  { type: "date_signed", role: "company", required: true, label: "Date countersigned" },
  { type: "signature", role: "client", required: true, label: "Client signature" },
  { type: "full_name", role: "client", required: true, label: "Client name" },
  { type: "title", role: "client", required: false, label: "Client title" },
  { type: "date_signed", role: "client", required: true, label: "Date signed" },
];

// ---------------------------------------------------------------------------
// The files. Every person, firm and address here is invented.
// ---------------------------------------------------------------------------

type Outcome = "signed" | "waiting" | "countersign" | "declined" | "voided" | "expired" | "no_agreement" | "archived";
interface Client {
  name: string;
  email: string;
  company?: string;
  title?: string;
  phone?: string;
  description: string;
  reference?: string;
  by: "owner" | "member";
  device: "phone" | "laptop" | "tablet";
  outcome: Outcome;
  /** Moments in the file's life, as [days before the seed, firm wall clock] or hours before the seed. */
  created: number;
  viewed?: number;
  reminded?: number[];
  signed?: number;
  countersigned?: number;
  ended?: number;
  reason?: string;
}

function buildClients(): Client[] {
  return [
    { name: "Marisol Vega", email: "marisol.vega@example.com", company: "Vega Family Bakery LLC", title: "Owner", phone: "+1 212 555 0114", description: "Commercial lease review, 48 Orchard Row", by: "owner", device: "phone", outcome: "signed", created: daysAgo(29, "09:42"), viewed: daysAgo(29, "12:18"), signed: daysAgo(29, "12:26"), countersigned: daysAgo(28, "08:51") },
    { name: "Tobias Lindqvist", email: "tobias.lindqvist@example.com", phone: "+1 646 555 0172", description: "Residential closing, 14 Alder Lane", by: "member", device: "laptop", outcome: "signed", created: daysAgo(27, "14:07"), viewed: daysAgo(26, "19:33"), signed: daysAgo(26, "19:41"), countersigned: daysAgo(25, "09:15") },
    { name: "Emil Castellanos", email: "emil@castellanos-catering.example", company: "Castellanos Catering", title: "Proprietor", description: "Liquor licence application", by: "member", device: "phone", outcome: "archived", created: daysAgo(25, "11:20"), viewed: daysAgo(24, "08:02"), ended: daysAgo(21, "16:44") },
    { name: "Colm Brannigan", email: "colm.brannigan@example.org", phone: "+1 718 555 0139", description: "Small claims filing against a former landlord", by: "owner", device: "phone", outcome: "expired", created: daysAgo(24, "15:31"), reminded: [daysAgo(20, "10:05"), daysAgo(15, "10:12")] },
    { name: "Priya Raman", email: "priya.raman@brightwater-analytics.example", company: "Brightwater Analytics Inc.", title: "Chief Operating Officer", phone: "+1 917 555 0188", description: "Employment agreement templates", reference: "NL-EMP-2231", by: "owner", device: "laptop", outcome: "signed", created: daysAgo(23, "10:14"), reminded: [daysAgo(20, "09:30")], viewed: daysAgo(20, "13:47"), signed: daysAgo(20, "13:58"), countersigned: daysAgo(20, "16:20") },
    { name: "Rafael Ortiz", email: "rafael@ortiz-landscaping.example", company: "Ortiz Landscaping", title: "Owner", description: "Vendor contract review", by: "member", device: "phone", outcome: "voided", created: daysAgo(21, "13:25"), viewed: daysAgo(21, "17:50"), ended: daysAgo(19, "09:36"), reason: "The client has put this matter on hold until the new year." },
    { name: "Desmond Okafor", email: "desmond@okafor-construction.example", company: "Okafor & Sons Construction", title: "Director", phone: "+1 347 555 0121", description: "Subcontractor payment dispute", by: "owner", device: "tablet", outcome: "signed", created: daysAgo(18, "09:05"), viewed: daysAgo(18, "09:48"), signed: daysAgo(18, "10:02"), countersigned: daysAgo(18, "11:30") },
    { name: "Gwendolyn Pryce", email: "g.pryce@pryce-dental.example", company: "Pryce Dental Group", title: "Managing Partner", description: "Partnership buyout", by: "owner", device: "laptop", outcome: "declined", created: daysAgo(16, "11:42"), viewed: daysAgo(14, "08:20"), ended: daysAgo(14, "08:31"), reason: "We have decided to stay with our current counsel for the buyout. Thank you for your time." },
    { name: "Hannah Feldman", email: "hannah.feldman@example.net", phone: "+1 914 555 0166", description: "Estate plan and will", by: "member", device: "phone", outcome: "signed", created: daysAgo(13, "15:16"), viewed: daysAgo(12, "07:44"), signed: daysAgo(11, "20:09"), countersigned: daysAgo(10, "09:02") },
    { name: "Stellan Varga", email: "stellan.varga@varga-robotics.example", company: "Varga Robotics Inc.", title: "Chief Executive Officer", description: "Series A financing", reference: "NL-CORP-0457", by: "owner", device: "laptop", outcome: "waiting", created: daysAgo(9, "10:33"), reminded: [daysAgo(6, "09:10"), daysAgo(3, "09:04")] },
    { name: "Luca Moretti", email: "luca@moretti-imports.example", company: "Moretti Imports Ltd.", title: "President", phone: "+1 201 555 0143", description: "Trademark registration", by: "owner", device: "phone", outcome: "signed", created: daysAgo(7, "13:50"), viewed: daysAgo(7, "14:21"), signed: daysAgo(6, "08:37"), countersigned: daysAgo(6, "10:45") },
    { name: "Arthur Pennington", email: "arthur@pennington-estates.example", company: "Pennington Estates", title: "Trustee", description: "Property portfolio transfer", by: "member", device: "tablet", outcome: "countersign", created: daysAgo(5, "09:58"), viewed: daysAgo(4, "18:12"), signed: daysAgo(2, "11:26") },
    { name: "Imani Brooks", email: "imani@brooks-wellness.example", company: "Brooks Wellness Studio", title: "Founder", phone: "+1 929 555 0157", description: "Franchise agreement review", by: "owner", device: "phone", outcome: "waiting", created: daysAgo(3, "14:40"), viewed: daysAgo(2, "08:55") },
    { name: "Selma Aydin", email: "selma.aydin@example.com", phone: "+1 516 555 0190", description: "Purchase of a dental practice", by: "owner", device: "laptop", outcome: "signed", created: daysAgo(3, "10:08"), viewed: daysAgo(3, "10:52"), signed: daysAgo(3, "11:03"), countersigned: daysAgo(2, "15:17") },
    { name: "Yuki Tanaka", email: "yuki@tanaka-design.example", company: "Tanaka Design Studio", title: "Principal", description: "Intellectual property assignment", by: "member", device: "laptop", outcome: "countersign", created: daysAgo(2, "16:22"), viewed: hoursAgo(21), signed: hoursAgo(5.5) },
    { name: "Beatrice Lowell", email: "beatrice.lowell@example.org", description: "Initial consultation, boundary dispute", by: "member", device: "phone", outcome: "no_agreement", created: daysAgo(1, "11:35") },
    { name: "Noor Haddad", email: "noor.haddad@example.net", phone: "+1 332 555 0128", description: "Residential lease dispute", by: "owner", device: "phone", outcome: "waiting", created: hoursAgo(3.2) },
  ];
}

const DEVICES: Record<Client["device"], string> = {
  phone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  laptop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  tablet: "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
};
/** Request details for the firm's own actions. Addresses are from the ranges reserved for documentation. */
const OFFICE: RequestMeta = { ip: "203.0.113.24", userAgent: DEVICES.laptop };

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { getDb, schema } = await import("@/lib/db");
  const db = await getDb();
  const target = process.env.DATABASE_URL?.trim() ? "the database in DATABASE_URL" : "the local database in .data/pglite";

  const [existing] = await db.select({ id: schema.users.id, orgId: schema.users.orgId }).from(schema.users).where(eq(schema.users.email, DEMO.ownerEmail)).limit(1);
  if (existing) {
    console.log(`seed-demo: the demo owner ${DEMO.ownerEmail} already exists in ${target}. Nothing was changed.`);
    return;
  }
  console.log(`seed-demo: creating "${DEMO.orgName}" in ${target}`);

  // From here on the email service is in its test mode: messages are kept in an in-process
  // outbox and recorded as sent, and nothing is handed to a provider. The database handle
  // above was opened first because test mode would otherwise select an in-memory database.
  (process.env as Record<string, string | undefined>).NODE_ENV = "test";
  // The email service prints links when it has no provider; signing links must never be printed.
  console.info = () => {};

  const accounts = await import("@/lib/services/accounts");
  const templates = await import("@/lib/services/templates");
  const files = await import("@/lib/services/files");
  const envelopes = await import("@/lib/services/envelopes");
  const signing = await import("@/lib/services/signing");
  const { recordEvent } = await import("@/lib/services/events");
  const { getTestOutbox } = await import("@/lib/services/email");
  const { systemActor } = await import("@/lib/services/context");

  installClock();

  let orgId = "";
  /**
   * Seed tool only, never application code: rows the DATABASE stamped with its own
   * clock during a step are moved to that step's simulated time. Rows the services
   * stamped themselves already carry simulated times and are left alone, as is
   * everything else about them.
   */
  const realFloor = new RealDate(REAL_START - 10 * 60_000).toISOString();
  async function retime(at: number): Promise<void> {
    if (!orgId) return;
    const when = new RealDate(at).toISOString();
    for (const table of ["users", "auth_tokens", "blobs", "templates", "files", "envelopes", "signers", "events", "email_log", "api_keys", "webhooks", "webhook_deliveries"]) {
      await db.execute(sql`update ${sql.identifier(table)} set created_at = ${when}::timestamptz where org_id = ${orgId} and created_at > ${realFloor}::timestamptz`);
    }
    for (const table of ["templates", "files", "envelopes"]) {
      await db.execute(sql`update ${sql.identifier(table)} set updated_at = ${when}::timestamptz where org_id = ${orgId} and updated_at > ${realFloor}::timestamptz`);
    }
    await db.execute(sql`update orgs set created_at = ${when}::timestamptz where id = ${orgId} and created_at > ${realFloor}::timestamptz`);
  }

  interface Step {
    at: number;
    label: string;
    run: () => Promise<void>;
  }
  const steps: Step[] = [];
  const step = (at: number, label: string, run: () => Promise<void>) => {
    if (at > REAL_START - 20 * 60_000) throw new Error(`"${label}" is scheduled too close to the present.`);
    steps.push({ at, label, run });
  };

  let owner: Actor = { type: "system", orgId: "", label: "System" };
  let member: Actor = owner;
  const actorOf = (who: Client["by"]) => (who === "owner" ? owner : member);

  // --- Day one: the company signs up and sets itself up -------------------------------

  step(daysAgo(31, "09:12"), "sign up", async () => {
    const created = await accounts.signUp({ orgName: DEMO.orgName, name: DEMO.ownerName, email: DEMO.ownerEmail, password: PASSWORD, timeZone: DEMO.timeZone }, OFFICE);
    orgId = created.org.id;
    owner = { type: "user", orgId, userId: created.user.id, role: "owner", label: `${DEMO.ownerName} <${DEMO.ownerEmail}>` };
  });
  step(daysAgo(31, "09:15"), "confirm the owner's email address", async () => {
    // The confirmation link only exists in the email; in test mode that email is in the outbox.
    const mail = getTestOutbox().find((m) => m.kind === "verify_email" && m.to === DEMO.ownerEmail);
    const token = mail ? /\/verify-email\/([A-Za-z0-9_-]+)/.exec(mail.text)?.[1] : undefined;
    if (!token) throw new Error("The confirmation email for the demo owner was not captured.");
    await accounts.verifyEmail(token, OFFICE);
  });
  step(daysAgo(31, "09:24"), "company settings", async () => {
    await accounts.updateProfile(owner, { title: DEMO.ownerTitle });
    await accounts.saveSignature(owner, signaturePng(DEMO.ownerName));
    await accounts.updateOrg(
      owner,
      {
        legalName: DEMO.legalName,
        settings: {
          brandColor: DEMO.brandColor,
          timeZone: DEMO.timeZone,
          countersignMode: "manual",
          countersignerUserId: owner.type === "user" ? owner.userId : undefined,
          replyToEmail: DEMO.ownerEmail,
          reminderEveryDays: 3,
          maxReminders: 3,
          expireAfterDays: 14,
          fileReferencePrefix: "NL",
          emailMessage: "Thank you for choosing Northfield Legal. Please review and sign our engagement agreement so we can open your file and start work.",
        },
      },
      OFFICE,
    );
  });
  step(daysAgo(31, "09:40"), "invite a team member", async () => {
    const invite = await accounts.inviteMember(owner, { email: DEMO.memberEmail, role: "member" }, OFFICE);
    const token = invite.url.split("/").pop() ?? "";
    // A password nobody is told: the demo is entered through the owner's account.
    const joined = await accounts.acceptInvite(token, { name: DEMO.memberName, password: randomBytes(24).toString("base64url") }, { ip: "203.0.113.31", userAgent: DEVICES.laptop });
    member = { type: "user", orgId, userId: joined.user.id, role: "member", label: `${DEMO.memberName} <${DEMO.memberEmail}>` };
    await accounts.updateProfile(member, { title: DEMO.memberTitle });
  });

  let fieldSummary = "";
  step(daysAgo(31, "10:05"), "upload and activate the engagement agreement", async () => {
    const draft = await templates.createTemplateFromText(owner, { text: ENGAGEMENT_TEXT, name: ENGAGEMENT_NAME }, OFFICE);
    const detected = [...draft.fields].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
    if (process.env.SEED_DEBUG) console.log(detected.map((f) => `p${f.page} y${f.y.toFixed(3)} x${f.x.toFixed(3)} w${f.w.toFixed(3)} h${f.h.toFixed(3)} ${f.type}/${f.role}${f.mergeKey ? `/${f.mergeKey}` : ""} "${f.label}" ${f.required ? "required" : "optional"}`).join("\n"));
    if (detected.length !== EXPECTED_FIELDS.length) {
      throw new Error(`Field detection found ${detected.length} fields in the engagement agreement where ${EXPECTED_FIELDS.length} blanks were written. Check the agreement text against EXPECTED_FIELDS.`);
    }
    // Where each blank sits comes from detection; what it is and who fills it in comes from the list above.
    let corrected = 0;
    const fields = detected.map((found, i): Field => {
      const want = EXPECTED_FIELDS[i];
      const { mergeKey: _dropped, ...rest } = found;
      void _dropped;
      if (found.type !== want.type || found.role !== want.role || found.required !== want.required || found.mergeKey !== want.mergeKey) corrected++;
      return { ...rest, type: want.type, role: want.role, required: want.required, label: want.label, ...(want.mergeKey ? { mergeKey: want.mergeKey } : {}) };
    });
    const saved = await templates.updateTemplateFields(owner, draft.id, fields, draft.version, OFFICE);
    const { becameDefault } = await templates.activateTemplate(owner, saved.id, OFFICE);
    if (!becameDefault) throw new Error("The engagement agreement did not become the default agreement.");
    fieldSummary = `${fields.length} fields on ${draft.pages.length} pages (${corrected} corrected after detection)`;
  });
  step(daysAgo(12, "16:30"), "start a second agreement and leave it in draft", async () => {
    await templates.createTemplateFromText(owner, { text: CONSULTATION_TEXT, name: CONSULTATION_NAME }, OFFICE);
  });

  // --- The files ---------------------------------------------------------------------

  const clients = buildClients();
  for (const [index, client] of clients.entries()) {
    const state = { fileId: "", envelopeId: "", secret: "" };
    // Each client signs from their own address; the range is reserved for documentation.
    const theirs: RequestMeta = { ip: `198.51.100.${17 + index * 9}`, userAgent: DEVICES[client.device] };
    const sign = signaturePng(client.name);

    step(client.created, `create the file for ${client.name}`, async () => {
      const made = await files.createFile(
        actorOf(client.by),
        {
          clientName: client.name,
          clientEmail: client.email,
          clientCompany: client.company,
          clientTitle: client.title,
          clientPhone: client.phone,
          description: client.description,
          reference: client.reference,
          send: client.outcome !== "no_agreement",
        },
        OFFICE,
      );
      state.fileId = made.file.id;
      if (client.outcome === "no_agreement") return;
      if (!made.agreement.sent || !made.agreement.envelopeId || !made.agreement.signingUrl) {
        throw new Error(`The agreement for ${client.name} was not sent: ${made.agreement.reason ?? made.agreement.deliveryReason ?? "no reason given"}`);
      }
      state.envelopeId = made.agreement.envelopeId;
      state.secret = made.agreement.signingUrl.split("/").pop() ?? "";
    });

    for (const at of client.reminded ?? []) {
      step(at, `remind ${client.name}`, async () => {
        await envelopes.sendReminderNow(actorOf(client.by), state.envelopeId, OFFICE);
      });
    }
    if (client.viewed !== undefined) {
      step(client.viewed, `${client.name} opens the link`, async () => {
        const session = await signing.getSigningSession(state.secret, theirs);
        if (session.state !== "ready") throw new Error(`${client.name}'s link is "${session.state}", not ready to sign.`);
      });
    }
    if (client.signed !== undefined) {
      step(client.signed, `${client.name} signs`, async () => {
        const session = await signing.getSigningSession(state.secret, theirs);
        if (session.state !== "ready") throw new Error(`${client.name}'s link is "${session.state}", not ready to sign.`);
        const values: FieldValues = {};
        for (const field of session.fields) {
          if (field.type === "signature") values[field.id] = sign;
          else if (field.type === "initials") values[field.id] = signaturePng(`${client.name} initials`, { width: 160, height: 110 });
          else if (field.type === "checkbox") values[field.id] = true;
          else if (field.type === "title" && client.title) values[field.id] = client.title;
          else if (field.type === "company" && client.company) values[field.id] = client.company;
        }
        const result = await signing.submitSigning(state.secret, { values, consent: true, timezone: DEMO.timeZone }, theirs);
        if (result.status !== "signed") throw new Error(`${client.name}'s signature was not recorded.`);
      });
    }
    if (client.countersigned !== undefined) {
      step(client.countersigned, `countersign for ${client.name}`, async () => {
        const result = await envelopes.countersign(owner, state.envelopeId, { timezone: DEMO.timeZone }, OFFICE);
        if (!result.completed) throw new Error(`The agreement for ${client.name} was countersigned but not sealed: ${result.message}`);
      });
    }
    if (client.outcome === "declined" && client.ended !== undefined) {
      step(client.ended, `${client.name} declines`, async () => {
        await signing.declineSigning(state.secret, client.reason, theirs);
      });
    }
    if (client.outcome === "voided" && client.ended !== undefined) {
      step(client.ended, `void the agreement for ${client.name}`, async () => {
        await envelopes.voidEnvelope(actorOf(client.by), state.envelopeId, client.reason, OFFICE);
      });
    }
    if (client.outcome === "archived" && client.ended !== undefined) {
      step(client.ended, `archive the file for ${client.name}`, async () => {
        await files.archiveFile(owner, state.fileId, OFFICE);
      });
    }
    if (client.outcome === "expired") {
      // Expiry is only ever applied by the scheduled job, which sweeps every company in the
      // database at once and emails as it goes. A seed must not do another tenant's work, so
      // this applies the job's own guarded transition (see expireOverdue in services/jobs.ts)
      // to this one envelope, with the same service helpers, the moment its time runs out.
      step(client.created + 14 * DAY + 4 * 60_000, `the agreement for ${client.name} expires`, async () => {
        const now = new Date();
        await signing.inTransaction(db, async (tx) => {
          await signing.lockFile(tx, orgId, state.fileId);
          const [expired] = await tx
            .update(schema.envelopes)
            .set({ status: "expired", nextReminderAt: null, updatedAt: now })
            .where(and(eq(schema.envelopes.id, state.envelopeId), eq(schema.envelopes.orgId, orgId), inArray(schema.envelopes.status, signing.AWAITING_CLIENT_STATUSES), lte(schema.envelopes.expiresAt, now)))
            .returning({ id: schema.envelopes.id });
          if (!expired) throw new Error(`The agreement for ${client.name} was not due to expire.`);
          await signing.settleFileStatus(tx, orgId, state.fileId, state.envelopeId, "needs_attention");
          await recordEvent(tx, { orgId, fileId: state.fileId, envelopeId: state.envelopeId, type: "envelope.expired", actor: systemActor(orgId) });
        });
      });
    }
  }

  // --- Run everything, oldest first ----------------------------------------------------

  steps.sort((a, b) => a.at - b.at);
  try {
    for (const next of steps) {
      setClock(next.at);
      try {
        await next.run();
      } catch (err) {
        throw new Error(`Step "${next.label}" failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      await retime(next.at);
    }
  } finally {
    restoreClock();
  }

  // Seed tool only: a reminder that fell due in the simulated past would otherwise go out
  // on the scheduler's very next run. Put it a day ahead, as it would be in a live account.
  const tomorrow = new RealDate(RealDate.now() + DAY).toISOString();
  await db.execute(sql`update envelopes set next_reminder_at = ${tomorrow}::timestamptz where org_id = ${orgId} and status in ('sent', 'viewed', 'client_signed') and next_reminder_at is not null and next_reminder_at < now()`);

  // --- Check and report -----------------------------------------------------------------

  const counts = await files.fileCounts(owner);
  const sealed = await db
    .select({ id: schema.envelopes.id, sha: schema.envelopes.finalSha256 })
    .from(schema.envelopes)
    .where(and(eq(schema.envelopes.orgId, orgId), eq(schema.envelopes.status, "completed")));
  for (const row of sealed) {
    const check = await signing.verifyDocument({ sha256: row.sha });
    if (!check.found) throw new Error(`The sealed agreement ${row.id} does not verify against its own fingerprint.`);
  }
  const byOutcome = (outcome: Outcome) => clients.filter((c) => c.outcome === outcome).length;
  console.log(
    [
      "",
      `Demo company "${DEMO.orgName}" is ready in ${target}.`,
      `  Team: ${DEMO.ownerName} (owner, saved signature, countersigns by hand) and ${DEMO.memberName} (member)`,
      `  Agreements: "${ENGAGEMENT_NAME}" active and default, ${fieldSummary}; "${CONSULTATION_NAME}" in draft`,
      `  Files: ${clients.length}`,
      `    signed and sealed          ${byOutcome("signed")}  (${sealed.length} sealed PDFs, each checked against its fingerprint)`,
      `    waiting on the client      ${byOutcome("waiting")}  (one opened, one reminded twice, one sent today)`,
      `    waiting on countersignature ${byOutcome("countersign")}`,
      `    declined by the client     ${byOutcome("declined")}`,
      `    voided by the firm         ${byOutcome("voided")}`,
      `    expired unsigned           ${byOutcome("expired")}`,
      `    no agreement sent          ${byOutcome("no_agreement")}`,
      `    archived                   ${byOutcome("archived")}`,
      `  As the product counts them: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}`,
      `  Emails sent: none. ${getTestOutbox().length} messages were captured in memory and discarded.`,
      "",
      `Sign in as ${DEMO.ownerEmail} with the password you set in DEMO_PASSWORD.`,
    ].join("\n"),
  );
}

main()
  .then(async () => {
    // Close the database so a local PGlite directory is flushed and unlocked before the app opens it.
    try {
      const { getDb } = await import("@/lib/db");
      const client = ((await getDb()) as unknown as { $client?: { close?: () => Promise<void>; end?: () => Promise<void> } }).$client;
      await (client?.close?.() ?? client?.end?.());
    } catch {
      // Nothing useful to do: the data is already committed.
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error(`seed-demo: failed. ${err instanceof Error ? err.message : String(err)}`);
    if (process.env.SEED_DEBUG && err instanceof Error) console.error(err.cause ?? err.stack);
    console.error("seed-demo: the demo company may be partly created. Delete it (delete from orgs where name = 'Northfield Legal (demo)') before running again.");
    process.exit(1);
  });
