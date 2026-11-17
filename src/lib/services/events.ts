import { and, asc, desc, eq, type SQL } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/lib/db";
import { events, type EventRow } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import type { Actor, RequestMeta } from "./context";

/** A signer acts through a signing link, not a session or key, so it has no Actor. */
export type EventActor = Actor | { type: "signer"; label: string };

export interface RecordEventInput {
  orgId: string;
  fileId?: string | null;
  envelopeId?: string | null;
  type: string;
  actor: EventActor;
  meta?: RequestMeta;
  data?: Record<string, unknown>;
}

const MAX_IP = 64;
const MAX_USER_AGENT = 400;
const MAX_ACTOR = 200;
const MAX_TYPE = 80;
const MAX_STRING = 2000;
const MAX_DEPTH = 5;
const MAX_KEYS = 60;
const MAX_ARRAY = 100;

/** Key names whose values are credentials. An audit trail outlives every secret it
 *  mentions, so these are dropped no matter which caller put them in `data`. */
const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|api[_-]?key|nonce|signature[_-]?image|key[_-]?hash/i;

/** Postgres text and jsonb both reject NUL, and one stray byte from a hostile
 *  User-Agent would otherwise abort the whole business transaction. */
export function cleanText(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  // Lone surrogates are rejected by jsonb as well; toWellFormed is not in the ES2017 lib target.
  const cleaned = text
    .replace(/\u0000/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")
    .trim();
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max);
  // Do not leave half of a surrogate pair at the cut.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * Reduce arbitrary input to something jsonb will always accept: plain JSON, bounded
 * in depth and size, with no circular references, BigInts, functions or NULs.
 * With `dropSecrets`, keys that look like credentials are removed.
 */
export function toSafeJson(value: unknown, opts: { dropSecrets?: boolean; maxString?: number } = {}): Record<string, unknown> {
  const maxString = opts.maxString ?? MAX_STRING;
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return null;
    switch (typeof v) {
      case "string":
        return cleanText(v, maxString);
      case "number":
        return Number.isFinite(v) ? v : null;
      case "boolean":
        return v;
      case "bigint":
        return v.toString();
      case "object":
        break;
      default:
        return null; // functions, symbols
    }
    const obj = v as object;
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
    if (obj instanceof Uint8Array || obj instanceof ArrayBuffer) return null; // binary never belongs in an event
    if (seen.has(obj) || depth >= MAX_DEPTH) return null;
    seen.add(obj);
    try {
      if (Array.isArray(obj)) return obj.slice(0, MAX_ARRAY).map((item) => walk(item, depth + 1));
      const out: Record<string, unknown> = {};
      let count = 0;
      for (const key of Object.keys(obj)) {
        if (count >= MAX_KEYS) break;
        if (opts.dropSecrets && SECRET_KEY.test(key)) continue;
        const safeKey = cleanText(key, 100);
        // Assigning "__proto__" on a plain object would change its prototype instead of adding a key.
        if (!safeKey || safeKey === "__proto__") continue;
        let child: unknown;
        try {
          child = (obj as Record<string, unknown>)[key];
        } catch {
          continue; // a throwing getter must not take the transaction down
        }
        if (child === undefined || typeof child === "function" || typeof child === "symbol") continue;
        out[safeKey] = walk(child, depth + 1);
        count++;
      }
      return out;
    } finally {
      seen.delete(obj);
    }
  };

  const result = walk(value, 0);
  return result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : {};
}

// Events written inside one transaction would all share Postgres's now() (the
// transaction start time), and a timeline or certificate must list them in the
// order they happened. So the timestamp is taken here and nudged forward when two
// events land in the same millisecond of one process.
let lastStamp = 0;
function nextTimestamp(): Date {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return new Date(lastStamp);
}

/**
 * Append one row to the audit trail. Call it with the transaction that makes the
 * change it describes, so the trail and the data can never disagree.
 */
export async function recordEvent(db: DbOrTx, e: RecordEventInput): Promise<void> {
  const actorType: EventRow["actorType"] =
    e.actor.type === "user" || e.actor.type === "api" || e.actor.type === "signer" ? e.actor.type : "system";
  await db.insert(events).values({
    id: newId("evt"),
    orgId: e.orgId,
    fileId: e.fileId ?? null,
    envelopeId: e.envelopeId ?? null,
    type: cleanText(e.type, MAX_TYPE) || "unknown",
    actorType,
    actor: cleanText(e.actor.label, MAX_ACTOR) || (actorType === "system" ? "System" : "Unknown"),
    ip: cleanText(e.meta?.ip, MAX_IP) || null,
    userAgent: cleanText(e.meta?.userAgent, MAX_USER_AGENT) || null,
    data: toSafeJson(e.data ?? {}, { dropSecrets: true }),
    createdAt: nextTimestamp(),
  });
}

export interface ListEventsOptions {
  envelopeId?: string;
  fileId?: string;
  /** Default 200, capped at 1000. */
  limit?: number;
  /** Default false: oldest first, the order a timeline and the certificate read in. */
  newestFirst?: boolean;
}

/** Events for one org, optionally narrowed to a file or an envelope. */
export async function listEvents(orgId: string, opts: ListEventsOptions = {}, db?: DbOrTx): Promise<EventRow[]> {
  const handle = db ?? (await getDb());
  const conditions: SQL[] = [eq(events.orgId, orgId)];
  if (opts.envelopeId) conditions.push(eq(events.envelopeId, opts.envelopeId));
  if (opts.fileId) conditions.push(eq(events.fileId, opts.fileId));
  const requested = Number(opts.limit);
  const limit = Number.isFinite(requested) && requested >= 1 ? Math.min(Math.floor(requested), 1000) : 200;
  const order = opts.newestFirst ? [desc(events.createdAt), desc(events.id)] : [asc(events.createdAt), asc(events.id)];
  return handle
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(...order)
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Plain-language descriptions
// ---------------------------------------------------------------------------

export type DescribableEvent = Pick<EventRow, "type" | "actor"> & {
  actorType?: EventRow["actorType"] | null;
  data?: Record<string, unknown> | null;
};

/** First non-empty string among the given keys. Event data is written by many
 *  callers over time, so a sentence never depends on one exact key being present. */
function str(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = data[key];
    if (typeof v === "string" && v.trim()) return cleanText(v, 200);
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function withReason(sentence: string, data: Record<string, unknown>): string {
  const reason = str(data, "reason", "error", "message");
  return reason ? `${sentence}: ${reason.replace(/[.\s]+$/, "")}` : sentence;
}

function agreementSubject(data: Record<string, unknown>): string {
  const name = str(data, "templateName", "name");
  return name ? `Agreement "${name}"` : "Agreement";
}

function agreementObject(data: Record<string, unknown>): string {
  const name = str(data, "templateName", "name");
  return name ? `"${name}"` : "an agreement";
}

const SETTING_NAMES: Record<string, string> = {
  name: "company name",
  legalName: "legal name",
  brandColor: "brand colour",
  logo: "logo",
  replyToEmail: "reply-to address",
  reminderEveryDays: "reminder frequency",
  maxReminders: "maximum reminders",
  expireAfterDays: "expiry",
  autoSendOnFileCreate: "automatic sending",
  countersignMode: "countersigning",
  countersignerUserId: "countersigner",
  fileReferencePrefix: "file reference prefix",
  emailMessage: "email message",
  timeZone: "time zone",
};

function settingName(key: string): string {
  return Object.prototype.hasOwnProperty.call(SETTING_NAMES, key) ? SETTING_NAMES[key] : cleanText(key, 40);
}

/**
 * One plain sentence for the file timeline and the signing certificate.
 * Never throws: an event with an unknown type or odd data still reads sensibly.
 */
export function describeEvent(event: DescribableEvent): string {
  const data: Record<string, unknown> =
    event.data && typeof event.data === "object" && !Array.isArray(event.data) ? event.data : {};
  const type = typeof event.type === "string" ? event.type : "";
  const bySystem = event.actorType === "system" || !event.actor || event.actor === "System";
  const who = bySystem ? "" : cleanText(event.actor, MAX_ACTOR);
  const by = who ? ` by ${who}` : "";
  const recipient = str(data, "email", "to", "recipient");

  switch (type) {
    case "file.created": {
      const ref = str(data, "reference");
      const subject = ref ? `File ${ref} created` : "File created";
      const source = str(data, "source");
      if (source === "intake") return `${subject} from the client intake link`;
      if (source === "csv") return `${subject}${by} from a spreadsheet import`;
      return `${subject}${by}`;
    }
    case "file.updated": {
      const changed = Array.isArray(data.changed)
        ? data.changed.filter((c): c is string => typeof c === "string" && c.trim() !== "").slice(0, 8)
        : [];
      return changed.length ? `File details updated${by} (${changed.map((c) => cleanText(c, 40)).join(", ")})` : `File details updated${by}`;
    }
    case "file.archived":
      return `File archived${by}`;
    case "envelope.created": {
      const name = str(data, "templateName", "template", "agreement");
      return name ? `Agreement "${name}" prepared for signature${by}` : `Agreement prepared for signature${by}`;
    }
    case "envelope.sent":
      if (str(data, "channel", "delivery") === "link") {
        return recipient ? `Signing link created for ${recipient} (not emailed)` : "Signing link created (not emailed)";
      }
      return recipient ? `Agreement emailed to ${recipient}` : `Agreement sent for signature${by}`;
    case "envelope.delivery_failed":
      return withReason(recipient ? `Email to ${recipient} could not be delivered` : "The agreement email could not be delivered", data);
    case "envelope.viewed":
      return who ? `${who} opened the agreement` : "The agreement was opened";
    case "signer.consented":
      return who ? `${who} consented to sign electronically` : "The signer consented to sign electronically";
    case "signer.signed":
      return who ? `${who} signed the agreement` : "The agreement was signed";
    case "envelope.countersigned": {
      const company = str(data, "company", "companyName", "onBehalfOf");
      const behalf = company ? ` on behalf of ${company}` : "";
      if (data.auto === true || str(data, "mode") === "auto") {
        const name = str(data, "name", "countersigner") ?? who;
        return name ? `Countersigned automatically with ${name}'s saved signature${behalf}` : `Countersigned automatically${behalf}`;
      }
      return who ? `${who} countersigned${behalf}` : `The agreement was countersigned${behalf}`;
    }
    case "envelope.completed":
      return "Agreement completed: all parties signed and the final copy was sealed";
    case "envelope.declined":
      return withReason(who ? `${who} declined to sign` : "The agreement was declined", data);
    case "envelope.voided":
      return withReason(`Agreement voided${by}`, data);
    case "envelope.expired":
      return "Agreement expired before it was signed";
    case "reminder.sent": {
      const count = str(data, "count", "reminderCount", "number");
      const base = recipient ? `Reminder emailed to ${recipient}` : "Reminder sent";
      return count ? `${base} (reminder ${count})` : base;
    }
    case "link.reissued":
      return `New signing link issued${by}; the previous link no longer works`;
    case "signer.updated": {
      const name = str(data, "name");
      if (name && recipient) return `Signer changed to ${name} (${recipient})${by}`;
      if (recipient) return `Signer email changed to ${recipient}${by}`;
      return `Signer details updated${by}`;
    }
    case "document.downloaded": {
      const kind = str(data, "kind", "document");
      const what = kind === "original" || kind === "unsigned" ? "Unsigned agreement" : kind === "certificate" ? "Signing certificate" : "Signed agreement";
      return `${what} downloaded${by}`;
    }
    case "file.unarchived":
      return `File restored from the archive${by}`;
    case "countersign.requested": {
      const reminder = str(data, "reminder");
      const base = recipient ? `Countersignature requested from ${recipient}` : "Countersignature requested";
      return reminder ? `${base} (reminder ${reminder})` : base;
    }
    case "countersign.overdue":
      return withReason("Countersignature overdue", data);
    case "countersign.unassigned":
      return withReason("Nobody is assigned to countersign", data);
    case "envelope.finalize_failed":
      // Older rows carry the cause under "error"; withReason reads either key.
      return withReason("The final signed copy could not be produced; it will be retried automatically", data);
    case "envelope.seal_warning":
      return withReason("The signed copy shows something differently from what was entered", data);
    case "template.created": {
      const name = str(data, "templateName", "name");
      return name ? `Agreement "${name}" uploaded${by}` : `Agreement uploaded${by}`;
    }
    case "template.renamed": {
      const name = str(data, "templateName", "name");
      const previous = str(data, "previousName");
      if (name && previous) return `Agreement "${previous}" renamed to "${name}"${by}`;
      return name ? `Agreement renamed to "${name}"${by}` : `Agreement renamed${by}`;
    }
    case "template.duplicated": {
      const name = str(data, "templateName", "name");
      const from = str(data, "fromName");
      if (name && from) return `Agreement "${from}" copied as "${name}"${by}`;
      return `Agreement copied${by}`;
    }
    case "template.fields_updated":
      return `${agreementSubject(data)} fields changed${by}`;
    case "template.fields_redetected":
      return `${agreementSubject(data)} fields detected again${by}`;
    case "template.document_replaced":
      return `${agreementSubject(data)} document replaced${by}`;
    case "template.activated":
      return `${agreementSubject(data)} activated${by}${data.becameDefault === true ? " and made the default" : ""}`;
    case "template.archived":
      return `${agreementSubject(data)} archived${by}`;
    case "template.default_changed":
      return `${agreementSubject(data)} made the default agreement${by}`;
    case "template.intake_enabled":
      return `Client intake link turned on for ${agreementObject(data)}${by}`;
    case "template.intake_disabled":
      return `Client intake link turned off for ${agreementObject(data)}${by}`;
    case "org.created":
      return `Company account created${by}`;
    case "org.updated": {
      const changed = Array.isArray(data.changed)
        ? data.changed.filter((c): c is string => typeof c === "string" && c.trim() !== "").slice(0, 12)
        : [];
      return changed.length ? `Company settings changed${by} (${changed.map((c) => settingName(c)).join(", ")})` : `Company settings changed${by}`;
    }
    case "member.invited": {
      const role = str(data, "role");
      return recipient ? `${recipient} invited to the team${role ? ` as ${role}` : ""}${by}` : `Team invitation sent${by}`;
    }
    case "member.invite_revoked":
      return recipient ? `Invitation for ${recipient} cancelled${by}` : `Invitation cancelled${by}`;
    case "member.joined":
      return who ? `${who} joined the team` : "A new member joined the team";
    case "member.role_changed": {
      const to = str(data, "to");
      const subject = recipient ?? "A team member";
      return to ? `${subject} made ${to === "owner" || to === "admin" ? `an ${to}` : `a ${to}`}${by}` : `${subject}'s role changed${by}`;
    }
    case "member.disabled":
      return `${recipient ? `${recipient}'s account` : "A team member's account"} turned off${by}`;
    case "member.enabled":
      return `${recipient ? `${recipient}'s account` : "A team member's account"} turned back on${by}`;
    case "member.ownership_transferred": {
      const to = str(data, "toEmail");
      return to ? `Ownership transferred to ${to}${by}` : `Ownership transferred${by}`;
    }
    case "member.password_reset":
      return who ? `${who} set a new password from a reset link` : "A password was set from a reset link";
    case "member.password_changed":
      return who ? `${who} changed their password` : "A password was changed";
    case "member.email_verified":
      return who ? `${who} confirmed their email address` : "An email address was confirmed";
    case "api_key.created": {
      const name = str(data, "name");
      return name ? `API key "${name}" created${by}` : `API key created${by}`;
    }
    case "api_key.revoked": {
      const name = str(data, "name");
      return name ? `API key "${name}" revoked${by}` : `API key revoked${by}`;
    }
    case "webhook.created":
      return `Webhook added${by}`;
    case "webhook.deleted":
      return `Webhook removed${by}`;
    default: {
      // "envelope.something_new" -> "Envelope something new by Jane Doe"
      const words = cleanText(type, MAX_TYPE)
        .replace(/[._-]+/g, " ")
        .replace(/[^\p{L}\p{N} ]/gu, "")
        .trim();
      if (!words) return `Activity recorded${by}`;
      return `${words.charAt(0).toUpperCase()}${words.slice(1)}${by}`;
    }
  }
}
