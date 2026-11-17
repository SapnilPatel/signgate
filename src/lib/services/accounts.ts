/**
 * Accounts, team and company settings.
 *
 * Services never touch cookies: sign-up, sign-in and invite acceptance return the
 * user, and the calling page starts the session. Every function that takes an actor
 * reads and writes only rows whose org_id is actor.orgId; an id from another company
 * behaves exactly like an id that does not exist.
 */
import { and, asc, count, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, type DbOrTx, type Tx } from "@/lib/db";
import { apiKeys, authTokens, orgs, sessions, users, type Org, type User } from "@/lib/db/schema";
import { hashPassword, verifyPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth/password";
import { env } from "@/lib/env";
import { newId, newSecret, randomString, sha256Hex } from "@/lib/ids";
import { LIMITS, ORG_SETTING_DEFAULTS, type OrgSettings } from "@/lib/types";
import {
  cleanMultilineText,
  cleanText,
  isSecretToken,
  isValidEmail,
  normalizeEmail,
  normalizeHexColor,
  normalizeTimeZone,
  parseImageDataUrl,
} from "@/lib/validation";
import { parseImageDataUrl as parseSignatureImage } from "@/lib/pdf/stamp";
import { ServiceError, type Actor, type RequestMeta } from "./context";
import { emailIsConfigured, sendEmail } from "./email";
import { revokeCountersignLinksForUser } from "./envelopes";
import { recordEvent, type EventActor } from "./events";
import { inviteEmail, inviteExistingAccountEmail, passwordResetEmail, signInAlertEmail, verifyEmailEmail } from "./email-templates";
import { clearRateLimit, clearRateLimitPrefix, describeWait, rateLimit } from "./rate-limit";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type Role = "owner" | "admin" | "member";
export type InviteRole = "admin" | "member";

/** A user as other code may see it. Never carries the password hash or the signature image. */
export interface Member {
  id: string;
  orgId: string;
  email: string;
  name: string;
  title: string | null;
  role: Role;
  disabled: boolean;
  hasSignature: boolean;
  /** True once this person has proved they control their mailbox. */
  emailVerified: boolean;
  createdAt: Date;
}

/**
 * What turning an account off (or demoting it) took away besides the sign-in, so the
 * page can tell the manager which integrations now need a new key.
 */
export interface AccessChange extends Member {
  /** Addresses whose unaccepted invitations from this person were cancelled. */
  cancelledInvites: string[];
  /** API keys this person created, revoked because they still know them. */
  revokedApiKeys: { id: string; name: string }[];
}

export interface PendingInvite {
  /** Opaque id for revokeInvite. It is the hash of the link secret, not the secret. */
  id: string;
  email: string;
  role: InviteRole;
  expiresAt: Date;
  createdAt: Date;
  expired: boolean;
}

export interface InviteResult {
  invite: PendingInvite;
  /** The join link. Returned so it can be copied by hand when email is not configured or fails. */
  url: string;
  emailStatus: "sent" | "failed" | "skipped";
  /** Why the email did not go, including "the owner has not confirmed their email address yet". */
  emailError?: string;
  /** True when the invitation was not emailed because the company's owner has not confirmed their address. */
  emailUnverified?: boolean;
}

export interface InviteDetails {
  email: string;
  role: InviteRole;
  orgId: string;
  orgName: string;
  expiresAt: Date;
}

type DefaultedKey = keyof typeof ORG_SETTING_DEFAULTS;
/** Org settings with every defaulted key present. */
export type ResolvedOrgSettings = Omit<OrgSettings, DefaultedKey> & Required<Pick<OrgSettings, DefaultedKey>>;

/** Each key may be a new value, or null / "" to go back to the default. Values may arrive as form strings. */
export type OrgSettingsPatch = { [K in keyof OrgSettings]?: unknown };

export const ACCOUNT_LIMITS = {
  nameMax: 100,
  titleMax: 100,
  orgNameMax: 100,
  legalNameMax: 200,
  emailMessageMax: 2000,
  fileReferencePrefixMax: 10,
  logoMaxBytes: 200 * 1024,
  resetTokenMinutes: 60,
  inviteDays: 7,
  verifyEmailHours: 48,
} as const;

/** Paths of the pages that consume the emailed tokens. */
export const forgotPasswordUrl = () => `${env.appUrl}/forgot-password`;
export const resetPasswordUrl = (token: string) => `${env.appUrl}/reset-password/${token}`;
export const inviteUrl = (token: string) => `${env.appUrl}/invite/${token}`;
export const verifyEmailUrl = (token: string) => `${env.appUrl}/verify-email/${token}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toMember(u: User): Member {
  return {
    id: u.id,
    orgId: u.orgId,
    email: u.email,
    name: u.name,
    title: u.title,
    role: u.role,
    disabled: u.disabledAt !== null,
    hasSignature: Boolean(u.savedSignature),
    emailVerified: u.emailVerifiedAt !== null,
    createdAt: u.createdAt,
  };
}

function invalid(fields: Record<string, string>): ServiceError {
  return new ServiceError("invalid", Object.values(fields)[0] ?? "Check the form and try again.", fields);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Callers are typed, but form posts and JSON bodies are not: anything that is not an object reads as empty. */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length === 0) return "Enter a password.";
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Use ${PASSWORD_MAX_LENGTH} characters or fewer.`;
  return null;
}

/** Cleans a required single-line value and records a problem when it is blank or too long. */
function requiredText(value: unknown, max: number, field: string, label: string, fields: Record<string, string>): string {
  const text = cleanText(value, max + 1);
  if (!text) fields[field] = `Enter ${label}.`;
  else if (text.length > max) fields[field] = `Keep ${label} to ${max} characters or fewer.`;
  return text;
}

function optionalText(value: unknown, max: number, field: string, label: string, fields: Record<string, string>): string | null {
  const text = cleanText(value, max + 1);
  if (text.length > max) fields[field] = `Keep ${label} to ${max} characters or fewer.`;
  return text || null;
}

function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  // Names written entirely in a non-Latin script slugify to nothing.
  return slug || "company";
}

async function audit(tx: DbOrTx, orgId: string, actor: { type: "user" | "system"; label: string }, type: string, data: Record<string, unknown>, meta?: RequestMeta) {
  // recordEvent sanitizes ip, user agent and data, so a hostile header cannot abort the transaction.
  await recordEvent(tx, { orgId, type, actor: actor as EventActor, meta, data });
}

const actorLabel = (u: Pick<User, "name" | "email">) => `${u.name} <${u.email}>`;

/**
 * The signed-in person behind an actor, re-read from the database. The role and
 * disabled flag in a session can be minutes old; the stored row is what counts.
 */
async function loadActorUser(db: DbOrTx, actor: Actor): Promise<User> {
  if (!actor || actor.type !== "user") {
    throw new ServiceError("forbidden", "Sign in as a team member to do that.");
  }
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.orgId, actor.orgId)))
    .limit(1);
  if (!user || user.disabledAt) {
    throw new ServiceError("forbidden", "Your account is no longer active. Ask an owner of your company account for access.");
  }
  return user;
}

/**
 * The one permission check for service entry points: is this caller still allowed to
 * read, or to manage, their company's data right now?
 *
 * A signed-in person is checked against their stored row, never against the role
 * carried in the Actor, so a demotion or a disabled account takes effect on the next
 * call instead of when the session is next rebuilt. Returns that row. API-key and
 * system actors return null: a key is checked for revocation each time it
 * authenticates, and system actors are only ever built by server code. Services that
 * must not be driven by a key at all (minting keys, changing webhooks) check
 * `actor.type` themselves.
 */
export async function assertActiveActor(db: DbOrTx, actor: Actor, need: "read" | "manage"): Promise<User | null> {
  if (!actor || typeof actor !== "object" || typeof actor.orgId !== "string" || !actor.orgId) {
    throw new ServiceError("forbidden", "Sign in to do that.");
  }
  if (actor.type !== "user") return null;
  if (typeof actor.userId !== "string" || !actor.userId) {
    throw new ServiceError("forbidden", "Sign in to do that.");
  }
  return need === "manage" ? loadManager(db, actor) : loadActorUser(db, actor);
}

async function loadManager(db: DbOrTx, actor: Actor): Promise<User> {
  const user = await loadActorUser(db, actor);
  if (user.role !== "owner" && user.role !== "admin") {
    throw new ServiceError("forbidden", "Only an owner or admin can do that. Ask one of them to make this change.");
  }
  return user;
}

/** Serializes team and settings changes within one company so invariants checked in a transaction hold. */
async function lockOrg(tx: Tx, orgId: string): Promise<Org> {
  const [org] = await tx.select().from(orgs).where(eq(orgs.id, orgId)).for("update");
  if (!org) throw new ServiceError("not_found", "This company account no longer exists.");
  return org;
}

const isManagerRow = (u: Pick<User, "role" | "disabledAt"> | undefined | null): boolean =>
  Boolean(u) && !u!.disabledAt && (u!.role === "owner" || u!.role === "admin");

/**
 * Cancels the invitations a person sent that nobody has accepted yet. An invite is the
 * inviter's authority frozen into a link; once they lose that authority the link must
 * stop working, or they could keep one addressed to themselves as a way back in.
 */
async function cancelInvitesFrom(tx: Tx, orgId: string, userId: string): Promise<string[]> {
  const removed = await tx
    .delete(authTokens)
    .where(and(eq(authTokens.kind, "invite"), eq(authTokens.orgId, orgId), eq(authTokens.userId, userId), isNull(authTokens.usedAt)))
    .returning({ email: authTokens.email });
  return removed.map((r) => r.email);
}

async function assertActiveOwnerRemains(tx: Tx, orgId: string): Promise<void> {
  const [row] = await tx
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.role, "owner"), isNull(users.disabledAt)));
  if (!row || Number(row.n) < 1) {
    throw new ServiceError("conflict", "A company account needs at least one active owner. Make someone else an owner first.");
  }
}

async function findTarget(tx: DbOrTx, orgId: string, userId: unknown): Promise<User> {
  const id = typeof userId === "string" ? userId : "";
  const [target] = id
    ? await tx.select().from(users).where(and(eq(users.id, id), eq(users.orgId, orgId))).limit(1)
    : [];
  if (!target) throw new ServiceError("not_found", "That person is not on your team. Refresh the page and try again.");
  return target;
}

async function safeSend(msg: Parameters<typeof sendEmail>[0]): Promise<{ status: "sent" | "failed" | "skipped"; error?: string }> {
  try {
    const result = await sendEmail(msg);
    return { status: result.status, error: result.error };
  } catch (err) {
    // An email problem must never undo or fail the action that triggered it.
    return { status: "failed", error: err instanceof Error ? err.message : "The email could not be sent." };
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Merges ORG_SETTING_DEFAULTS so callers never see undefined for a defaulted key. */
export function resolveSettings(org: { settings?: OrgSettings | null } | null | undefined): ResolvedOrgSettings {
  const stored = isRecord(org?.settings) ? (org.settings as OrgSettings) : {};
  const out: Record<string, unknown> = { ...ORG_SETTING_DEFAULTS };
  for (const [key, value] of Object.entries(stored)) {
    // null or undefined in stored JSON means "not set", never "override the default with nothing".
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out as unknown as ResolvedOrgSettings;
}

const SETTING_KEYS = [
  "brandColor",
  "logo",
  "replyToEmail",
  "reminderEveryDays",
  "maxReminders",
  "expireAfterDays",
  "autoSendOnFileCreate",
  "countersignMode",
  "countersignerUserId",
  "fileReferencePrefix",
  "emailMessage",
  "timeZone",
] as const satisfies readonly (keyof OrgSettings)[];

const INT_RANGES = {
  reminderEveryDays: [0, 30, "Days between reminders"],
  maxReminders: [0, 20, "Maximum reminders"],
  expireAfterDays: [0, 365, "Days until expiry"],
} as const;

function toInt(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  // Form posts deliver numbers as strings.
  if (typeof value === "string" && /^\d{1,6}$/.test(value.trim())) return Number(value.trim());
  return null;
}

function toBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "on" || value === "1") return true;
  if (value === "false" || value === "off" || value === "0") return false;
  return null;
}

/**
 * Validates the keys present in a settings patch. Returns values to set and keys to
 * clear; problems are recorded per key. Checks that need the database (countersigner)
 * happen in updateOrg against the merged result.
 */
function validateSettingsPatch(patch: unknown, fields: Record<string, string>): { set: OrgSettings; clear: (keyof OrgSettings)[] } {
  const set: Record<string, unknown> = {};
  const clear: (keyof OrgSettings)[] = [];
  if (patch === undefined || patch === null) return { set, clear };
  if (!isRecord(patch)) {
    fields.settings = "Settings were not sent in a readable form. Reload the page and try again.";
    return { set, clear };
  }

  for (const [key, raw] of Object.entries(patch)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) {
      fields[key] = `"${cleanText(key, 40)}" is not a setting.`;
      continue;
    }
    const k = key as keyof OrgSettings;
    if (raw === undefined) continue;
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
      clear.push(k);
      continue;
    }

    switch (k) {
      case "brandColor": {
        const hex = normalizeHexColor(raw);
        if (hex) set[k] = hex;
        else fields[k] = "Enter the brand colour as a hex code, like #1f3a5f.";
        break;
      }
      case "logo": {
        const img = parseImageDataUrl(raw, ["png", "jpeg"], ACCOUNT_LIMITS.logoMaxBytes);
        if (img.ok) set[k] = img.dataUrl;
        else if (img.reason === "too_large") fields[k] = "The logo is larger than 200 KB. Upload a smaller PNG or JPEG.";
        else if (img.reason === "corrupt") fields[k] = "The logo file could not be read. Upload a different PNG or JPEG.";
        // SVG is refused on purpose: it can carry scripts and email clients do not show it.
        else fields[k] = "The logo must be a PNG or JPEG image. Other formats, including SVG, are not accepted.";
        break;
      }
      case "replyToEmail": {
        const email = normalizeEmail(raw);
        if (isValidEmail(email)) set[k] = email;
        else fields[k] = "Enter a valid reply-to email address, like name@example.com.";
        break;
      }
      case "reminderEveryDays":
      case "maxReminders":
      case "expireAfterDays": {
        const [min, max, label] = INT_RANGES[k];
        const n = toInt(raw);
        if (n !== null && n >= min && n <= max) set[k] = n;
        else fields[k] = `${label} must be a whole number from ${min} to ${max}.`;
        break;
      }
      case "autoSendOnFileCreate": {
        const b = toBool(raw);
        if (b !== null) set[k] = b;
        else fields[k] = "Choose whether agreements are sent automatically when a file is created.";
        break;
      }
      case "countersignMode": {
        if (raw === "auto" || raw === "manual") set[k] = raw;
        else fields[k] = "Choose automatic or manual countersigning.";
        break;
      }
      case "countersignerUserId": {
        if (typeof raw === "string" && raw.length <= 64) set[k] = raw;
        else fields[k] = "Choose a countersigner from your team.";
        break;
      }
      case "fileReferencePrefix": {
        const prefix = cleanText(raw, ACCOUNT_LIMITS.fileReferencePrefixMax + 1);
        if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(prefix) && prefix.length <= ACCOUNT_LIMITS.fileReferencePrefixMax) set[k] = prefix;
        else fields[k] = `The file reference prefix can use letters, numbers, hyphens and underscores, up to ${ACCOUNT_LIMITS.fileReferencePrefixMax} characters, starting with a letter or number.`;
        break;
      }
      case "emailMessage": {
        if (typeof raw !== "string") {
          fields[k] = "The email message must be text.";
          break;
        }
        const message = cleanMultilineText(raw, ACCOUNT_LIMITS.emailMessageMax + 1);
        if (message.length > ACCOUNT_LIMITS.emailMessageMax) fields[k] = `Keep the email message to ${ACCOUNT_LIMITS.emailMessageMax} characters or fewer.`;
        else if (message) set[k] = message;
        else clear.push(k);
        break;
      }
      case "timeZone": {
        const zone = normalizeTimeZone(raw);
        if (zone) set[k] = zone;
        else fields[k] = "Choose a time zone from the list, for example America/Toronto or Europe/London.";
        break;
      }
    }
  }
  return { set: set as OrgSettings, clear };
}

/** Updates the company's name, legal name and settings. Only the keys supplied change. */
export async function updateOrg(
  actor: Actor,
  input: { name?: unknown; legalName?: unknown; settings?: OrgSettingsPatch | null },
  meta?: RequestMeta,
): Promise<Org> {
  const patch = asRecord(input);
  const fields: Record<string, string> = {};

  const change: { name?: string; legalName?: string | null } = {};
  if (patch.name !== undefined) change.name = requiredText(patch.name, ACCOUNT_LIMITS.orgNameMax, "name", "your company name", fields);
  if (patch.legalName !== undefined) change.legalName = optionalText(patch.legalName, ACCOUNT_LIMITS.legalNameMax, "legalName", "the legal name", fields);
  const { set, clear } = validateSettingsPatch(patch.settings, fields);

  const db = await getDb();
  return db.transaction(async (tx) => {
    const org = await lockOrg(tx, actor?.orgId ?? "");
    const manager = await loadManager(tx, actor);
    if (Object.keys(fields).length > 0) throw invalid(fields);

    const next: Record<string, unknown> = { ...(isRecord(org.settings) ? org.settings : {}), ...set };
    for (const key of clear) delete next[key];
    const merged = next as OrgSettings;

    // Checked against the merged result so the rule also holds when only one of the
    // two countersign settings is being changed.
    const touchesCountersign =
      "countersignerUserId" in set || "countersignMode" in set || clear.includes("countersignerUserId") || clear.includes("countersignMode");
    if (touchesCountersign) {
      let signer: User | undefined;
      if (merged.countersignerUserId) {
        [signer] = await tx
          .select()
          .from(users)
          .where(and(eq(users.id, merged.countersignerUserId), eq(users.orgId, org.id)))
          .limit(1);
        if (!signer || signer.disabledAt) {
          throw invalid({ countersignerUserId: "The countersigner must be an active member of your team. Choose someone from the list." });
        }
      }
      if (merged.countersignMode === "auto") {
        if (!signer) {
          throw invalid({ countersignMode: "Automatic countersigning needs a countersigner. Choose one, or switch to manual." });
        }
        if (!signer.savedSignature) {
          throw invalid({
            countersignMode: `Automatic countersigning needs a saved signature. ${signer.name} has to save a signature in their profile first, or switch to manual.`,
          });
        }
      }
    }

    const [updated] = await tx
      .update(orgs)
      .set({ ...change, settings: merged })
      .where(eq(orgs.id, org.id))
      .returning();
    await audit(
      tx,
      org.id,
      { type: "user", label: actorLabel(manager) },
      "org.updated",
      // Keys only: values can be large (logo) and are visible on the settings page anyway.
      { changed: [...Object.keys(change), ...Object.keys(set), ...clear] },
      meta,
    );
    return updated;
  });
}

/** Stops relying on a person for countersigning once they can no longer do it. */
async function releaseCountersigner(tx: Tx, org: Org, userId: string, opts: { keepAsManual: boolean }): Promise<void> {
  const settings = isRecord(org.settings) ? (org.settings as OrgSettings) : {};
  if (settings.countersignerUserId !== userId) return;
  const next: OrgSettings = { ...settings };
  if (!opts.keepAsManual) delete next.countersignerUserId;
  if (next.countersignMode === "auto") next.countersignMode = "manual";
  await tx.update(orgs).set({ settings: next }).where(eq(orgs.id, org.id));
}

// ---------------------------------------------------------------------------
// Sign-up and sign-in
// ---------------------------------------------------------------------------

const DUPLICATE_EMAIL = "An account with this email already exists. Sign in instead, or reset your password.";

/** Address used for rate limits; callers whose address the route could not determine share one counter. */
function sourceOf(meta?: RequestMeta): { ip: string; known: boolean } {
  const ip = typeof meta?.ip === "string" ? meta.ip.trim().toLowerCase().slice(0, 64) : "";
  return ip ? { ip, known: true } : { ip: "unknown", known: false };
}

/**
 * The shared "unknown" counter stands for every caller without an address at once, so
 * it gets a higher ceiling than one network would: a missing header must never mean
 * "no limit", and it must not let one such caller lock out all the others either.
 */
const UNKNOWN_SOURCE_FACTOR = 10;

async function limitBySource(action: string, meta: RequestMeta | undefined, limit: number, windowSeconds: number) {
  const source = sourceOf(meta);
  return rateLimit(`${action}:ip:${source.ip}`, source.known ? limit : limit * UNKNOWN_SOURCE_FACTOR, windowSeconds);
}

export interface SignUpResult {
  user: Member;
  org: Org;
  /** What happened to the "confirm your email address" message. "skipped" when email is not set up. */
  verificationEmail: "sent" | "failed" | "skipped";
}

/**
 * Creates a company and its owner. The caller starts the session with user.id.
 * `timeZone` is the browser's IANA zone; it is stored when valid and ignored otherwise.
 */
export async function signUp(
  input: { orgName: unknown; name: unknown; email: unknown; password: unknown; timeZone?: unknown },
  meta?: RequestMeta,
): Promise<SignUpResult> {
  const raw = asRecord(input);
  const fields: Record<string, string> = {};
  const orgName = requiredText(raw.orgName, ACCOUNT_LIMITS.orgNameMax, "orgName", "your company name", fields);
  const name = requiredText(raw.name, ACCOUNT_LIMITS.nameMax, "name", "your name", fields);
  const email = normalizeEmail(raw.email);
  if (!isValidEmail(email)) fields.email = "Enter a valid email address, like name@example.com.";
  const pw = passwordProblem(raw.password);
  if (pw) fields.password = pw;
  if (Object.keys(fields).length > 0) throw invalid(fields);

  // Each sign-up costs a password hash and creates a tenant; cap what one address can do.
  const limit = await limitBySource("signup", meta, 10, 3600);
  if (!limit.ok) {
    throw new ServiceError("rate_limited", `Too many accounts were created from this network. Try again ${describeWait(limit.retryAfterSeconds)}.`);
  }
  // A zone the runtime does not know is dropped, not refused: it is a convenience, never a reason to fail a sign-up.
  const timeZone = normalizeTimeZone(raw.timeZone);

  const db = await getDb();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) throw new ServiceError("conflict", DUPLICATE_EMAIL, { email: DUPLICATE_EMAIL });

  // Hashing is deliberately slow; keep it outside the transaction.
  const passwordHash = await hashPassword(raw.password as string);
  const base = slugify(orgName);

  const verifyToken = newSecret();
  const created = await db.transaction(async (tx) => {
    let org: Org | undefined;
    // ON CONFLICT DO NOTHING rather than catching a unique violation: an error would
    // abort the transaction, and a pre-check would race with a concurrent sign-up.
    for (let attempt = 0; attempt < 8 && !org; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomString(attempt < 5 ? 4 : 12)}`;
      [org] = await tx
        .insert(orgs)
        .values({ id: newId("org"), name: orgName, slug, settings: timeZone ? { timeZone } : {} })
        .onConflictDoNothing()
        .returning();
    }
    if (!org) throw new ServiceError("conflict", "We could not set up your company account. Try again.");

    const [user] = await tx
      .insert(users)
      .values({ id: newId("usr"), orgId: org.id, email, name, passwordHash, role: "owner" })
      .onConflictDoNothing()
      .returning();
    // Throwing rolls the org insert back, so a lost race never leaves an ownerless company.
    if (!user) throw new ServiceError("conflict", DUPLICATE_EMAIL, { email: DUPLICATE_EMAIL });

    await insertVerifyToken(tx, user, verifyToken);
    await audit(tx, org.id, { type: "user", label: actorLabel(user) }, "org.created", { userId: user.id }, meta);
    return { user, org };
  });

  // After commit: the account exists whether or not this email goes out, and it can be sent again.
  const sent = await sendVerificationEmail(created.user, created.org, verifyToken);
  return { user: toMember(created.user), org: created.org, verificationEmail: sent.status };
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

/**
 * Said wherever an email to someone outside the company was held back. The link the
 * email would have carried is always handed to the sender instead.
 */
export const EMAIL_UNVERIFIED_REASON =
  "Your company's owner has not confirmed their email address yet, so nothing was emailed. Copy the link and send it yourself, or ask the owner to use the confirmation link we emailed them.";

const VERIFY_GONE = "This confirmation link has expired or was already used. Sign in and ask for a new one from the banner at the top of the page.";

async function insertVerifyToken(tx: DbOrTx, user: Pick<User, "id" | "orgId" | "email">, token: string): Promise<void> {
  // Only the newest link works, like password resets.
  await tx.delete(authTokens).where(and(eq(authTokens.kind, "email_verify"), eq(authTokens.userId, user.id)));
  await tx.insert(authTokens).values({
    id: sha256Hex(token),
    kind: "email_verify",
    orgId: user.orgId,
    userId: user.id,
    email: user.email,
    expiresAt: new Date(Date.now() + ACCOUNT_LIMITS.verifyEmailHours * 3_600_000),
  });
}

function sendVerificationEmail(user: Pick<User, "orgId" | "email" | "name">, org: Pick<Org, "name">, token: string) {
  const url = verifyEmailUrl(token);
  // With no email provider in local development, sendEmail prints the link to the console.
  return safeSend({ orgId: user.orgId, kind: "verify_email", to: user.email, ...verifyEmailEmail({ name: user.name, orgName: org.name, url }) });
}

/**
 * Confirms an address from its emailed link. The link works once; opening it again
 * after it worked says so instead of failing, because mail scanners and double
 * clicks open links twice.
 */
export async function verifyEmail(token: unknown, meta?: RequestMeta): Promise<{ user: Member; alreadyVerified: boolean }> {
  if (!isSecretToken(token)) throw new ServiceError("gone", VERIFY_GONE);
  const db = await getDb();
  return db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .select()
      .from(authTokens)
      .where(and(eq(authTokens.id, sha256Hex(token)), eq(authTokens.kind, "email_verify")))
      .limit(1);
    if (!row?.userId) throw new ServiceError("gone", VERIFY_GONE);
    const [user] = await tx.select().from(users).where(eq(users.id, row.userId)).limit(1);
    // The link proves control of one address; it says nothing about any other.
    if (!user || user.disabledAt || user.email !== row.email) throw new ServiceError("gone", VERIFY_GONE);
    if (row.usedAt) {
      if (user.emailVerifiedAt) return { user: toMember(user), alreadyVerified: true };
      throw new ServiceError("gone", VERIFY_GONE);
    }
    // Guarded update: of two concurrent openings of the same link, exactly one gets a row back.
    const [used] = await tx
      .update(authTokens)
      .set({ usedAt: now })
      .where(and(eq(authTokens.id, row.id), eq(authTokens.kind, "email_verify"), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)))
      .returning({ id: authTokens.id });
    if (!used) throw new ServiceError("gone", VERIFY_GONE);
    if (user.emailVerifiedAt) return { user: toMember(user), alreadyVerified: true };
    const [updated] = await tx.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, user.id)).returning();
    await audit(tx, user.orgId, { type: "user", label: actorLabel(user) }, "member.email_verified", { userId: user.id, email: user.email }, meta);
    return { user: toMember(updated), alreadyVerified: false };
  });
}

export interface ResendVerificationResult {
  /** "already_verified" when there was nothing to send. */
  status: "sent" | "failed" | "skipped" | "already_verified";
  error?: string;
}

/** Emails the signed-in person a fresh confirmation link; the earlier one stops working. */
export async function resendVerification(actor: Actor): Promise<ResendVerificationResult> {
  const db = await getDb();
  const me = await loadActorUser(db, actor);
  if (me.emailVerifiedAt) return { status: "already_verified" };
  // Each one is an email to an address nobody has confirmed; a few an hour is plenty for a real person.
  const hourly = await rateLimit(`verify:user:${me.id}`, 3, 3600);
  const daily = hourly.ok ? await rateLimit(`verify:user:${me.id}:day`, 8, 86_400) : hourly;
  if (!daily.ok) {
    throw new ServiceError(
      "rate_limited",
      `We have already sent several confirmation emails to ${me.email}. Check your inbox and spam folder, or try again ${describeWait(daily.retryAfterSeconds)}.`,
    );
  }
  const [org] = await db.select().from(orgs).where(eq(orgs.id, me.orgId)).limit(1);
  const token = newSecret();
  await db.transaction((tx) => insertVerifyToken(tx, me, token));
  const sent = await sendVerificationEmail(me, org ?? { name: "your company" }, token);
  return { status: sent.status, ...(sent.error ? { error: sent.error } : {}) };
}

export interface EmailSendingStatus {
  /** False when no email provider is set up at all: links are always shared by hand and nothing needs confirming. */
  emailConfigured: boolean;
  /** True when agreements and invitations can be emailed to people outside the company right now. */
  canEmailOutside: boolean;
  /** True when the signed-in person has confirmed their own address. */
  viewerVerified: boolean;
  /** True when the signed-in person is an owner, so confirming their address is what lifts the hold. */
  viewerIsOwner: boolean;
  /** Plain sentence for a banner while emails are on hold; null otherwise. */
  reason: string | null;
}

/** Whether the company's emails to clients are on hold, for the banner that explains it. */
export async function getEmailSendingStatus(actor: Actor): Promise<EmailSendingStatus> {
  const db = await getDb();
  const me = await loadActorUser(db, actor);
  const configured = emailIsConfigured();
  const verified = !configured || (await ownerEmailVerified(db, me.orgId));
  return {
    emailConfigured: configured,
    canEmailOutside: configured && verified,
    viewerVerified: me.emailVerifiedAt !== null,
    viewerIsOwner: me.role === "owner",
    reason: verified ? null : EMAIL_UNVERIFIED_REASON,
  };
}

async function ownerEmailVerified(db: DbOrTx, orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.role, "owner"), isNull(users.disabledAt), sql`${users.emailVerifiedAt} is not null`))
    .limit(1);
  return Boolean(row);
}

/**
 * The soft gate against using a throwaway account to email strangers: until an owner
 * of the company has confirmed their own address, the product does not email anyone
 * outside the company on its behalf. Returns the reason to hold a message to `to`,
 * or null when it may go. Teammates can always be emailed, and with no email
 * provider configured there is nothing to gate.
 */
export async function externalEmailHold(db: DbOrTx, orgId: string, to: unknown): Promise<string | null> {
  if (!emailIsConfigured()) return null;
  if (typeof orgId !== "string" || !orgId) return null;
  if (await ownerEmailVerified(db, orgId)) return null;
  const address = normalizeEmail(to);
  if (address) {
    const [teammate] = await db.select({ id: users.id }).from(users).where(and(eq(users.orgId, orgId), eq(users.email, address))).limit(1);
    if (teammate) return null;
  }
  return EMAIL_UNVERIFIED_REASON;
}

const LOGIN_FAILED = "That email and password do not match an account. Check both and try again, or reset your password.";

let dummyHash: Promise<string> | undefined;
/** A real hash to verify against when the email is unknown, so both paths cost one scrypt. */
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(newSecret()).catch((err) => {
    dummyHash = undefined;
    throw err;
  });
  return dummyHash;
}

const LOGIN_ATTEMPTS_PER_SOURCE = 10;
/** Failures across every network in an hour before the account holder is told. Never a lockout. */
const LOGIN_FAILURES_BEFORE_ALERT = 100;

/**
 * Prefix of the per-network attempt counters for one email. The email is hashed so the
 * prefix has a fixed length: the full key always fits the limiter's stored form, which
 * is what lets a password reset forget every network's counter at once.
 */
const loginSourcePrefix = (email: string) => `login:src:${sha256Hex(email).slice(0, 32)}:`;

function loginSource(meta?: RequestMeta): string {
  const ip = typeof meta?.ip === "string" ? meta.ip.trim().toLowerCase().slice(0, 64) : "";
  // Without an address there is nothing to tell sources apart, so they share one counter.
  return ip || "unknown";
}

/**
 * Counts a wrong password against the email as a whole. Past the ceiling the account
 * holder gets one email an hour; the account is never locked from here, because a
 * lock keyed on something an attacker can type is a way to shut the real owner out.
 */
async function noteFailedLogin(email: string, user: User | undefined): Promise<void> {
  const overall = await rateLimit(`login:email:${email}`, LOGIN_FAILURES_BEFORE_ALERT, 3600);
  if (overall.ok || !user || user.disabledAt) return;
  if (!(await rateLimit(`login:alert:${email}`, 1, 3600)).ok) return;
  await safeSend({
    orgId: user.orgId,
    kind: "sign_in_alert",
    to: user.email,
    ...signInAlertEmail({ name: user.name, resetUrl: forgotPasswordUrl() }),
  });
}

/**
 * Checks an email and password. Unknown email and wrong password are indistinguishable
 * by message and by timing. The caller starts the session with the returned id.
 */
export async function logIn(input: { email: unknown; password: unknown }, meta?: RequestMeta): Promise<Member> {
  const raw = asRecord(input);
  const email = normalizeEmail(raw.email);
  const password = typeof raw.password === "string" ? raw.password : "";
  if (!email || !password) {
    const fields: Record<string, string> = {};
    if (!email) fields.email = "Enter your email address.";
    if (!password) fields.password = "Enter your password.";
    throw invalid(fields);
  }

  const byIp = await limitBySource("login", meta, 50, 900);
  if (!byIp.ok) throw new ServiceError("rate_limited", `Too many sign-in attempts from this network. Try again ${describeWait(byIp.retryAfterSeconds)}.`);
  // The hard stop is per email AND network. Keyed on the email alone it would let anyone
  // who knows an address keep its owner signed out with ten wrong guesses every 15 minutes.
  const sourceKey = `${loginSourcePrefix(email)}${loginSource(meta)}`;
  const bySource = await rateLimit(sourceKey, LOGIN_ATTEMPTS_PER_SOURCE, 900);
  if (!bySource.ok) {
    throw new ServiceError(
      "rate_limited",
      `Too many sign-in attempts for this email from your network. Try again ${describeWait(bySource.retryAfterSeconds)}, or reset your password.`,
    );
  }

  const db = await getDb();
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  // An over-long password cannot match anything; hash a short stand-in so the cost stays the same.
  const candidate = password.length > PASSWORD_MAX_LENGTH ? "x" : password;
  const fallback = await getDummyHash();
  const matches = await verifyPassword(candidate, user?.passwordHash ?? fallback);
  if (!user || !matches || password.length > PASSWORD_MAX_LENGTH) {
    await noteFailedLogin(email, user);
    throw new ServiceError("invalid", LOGIN_FAILED);
  }
  // Only said after the right password, so it cannot be used to probe which emails exist.
  if (user.disabledAt) {
    throw new ServiceError("forbidden", "This account has been turned off. Ask an owner of your company account to turn it back on.");
  }
  // Earlier mistakes from this network are forgiven for this email only; the
  // per-network counter keeps counting so one valid login cannot reset a guessing run.
  await clearRateLimit(sourceKey);
  return toMember(user);
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/**
 * Emails a reset link if the address belongs to an active account. Resolves the same
 * way in every case (unknown email, disabled account, rate limited, email failure),
 * so the page always says "if that account exists, we sent a link".
 */
export async function requestPasswordReset(emailInput: unknown, meta?: RequestMeta): Promise<void> {
  try {
    const email = normalizeEmail(emailInput);
    if (!isValidEmail(email)) return;
    if (!(await limitBySource("reset", meta, 20, 3600)).ok) return;
    if (!(await rateLimit(`reset:email:${email}`, 3, 3600)).ok) return;

    const db = await getDb();
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user || user.disabledAt) return;

    const token = newSecret();
    await db.transaction(async (tx) => {
      // Only the newest link works: an older email found later should not reset anything.
      await tx.delete(authTokens).where(and(eq(authTokens.kind, "password_reset"), eq(authTokens.userId, user.id)));
      await tx.insert(authTokens).values({
        id: sha256Hex(token),
        kind: "password_reset",
        orgId: user.orgId,
        userId: user.id,
        email,
        expiresAt: new Date(Date.now() + ACCOUNT_LIMITS.resetTokenMinutes * 60_000),
      });
    });

    const url = resetPasswordUrl(token);
    const result = await safeSend({ orgId: user.orgId, kind: "password_reset", to: email, ...passwordResetEmail({ name: user.name, url }) });
    if (result.status === "skipped" && !env.isProduction && !env.isTest) {
      // Local development has no email provider; without this the link is unreachable.
      console.info(`[dev] Password reset link for ${email}: ${url}`);
    }
  } catch (err) {
    // Surfacing a failure here would tell the caller the account exists.
    console.error("requestPasswordReset failed", err instanceof Error ? err.message : err);
  }
}

const RESET_GONE = "This reset link has expired or was already used. Request a new one from the sign-in page.";

/** True when the link can still be used, so the page can show the form or the "expired" message up front. */
export async function isPasswordResetTokenValid(token: unknown): Promise<boolean> {
  if (!isSecretToken(token)) return false;
  const db = await getDb();
  const [row] = await db
    .select({ id: authTokens.id })
    .from(authTokens)
    .where(and(eq(authTokens.id, sha256Hex(token)), eq(authTokens.kind, "password_reset"), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())))
    .limit(1);
  return Boolean(row);
}

/** Sets a new password from an emailed link, once, and signs the user out everywhere. */
export async function resetPassword(token: unknown, newPassword: unknown, meta?: RequestMeta): Promise<Member> {
  // Validate before consuming, so a too-short password does not burn the link.
  const pw = passwordProblem(newPassword);
  if (pw) throw invalid({ password: pw });
  if (!(await isPasswordResetTokenValid(token))) throw new ServiceError("gone", RESET_GONE);

  const passwordHash = await hashPassword(newPassword as string);
  const db = await getDb();
  const member = await db.transaction(async (tx) => {
    const now = new Date();
    // Guarded update: of two concurrent submissions of the same link, exactly one gets a row back.
    const [used] = await tx
      .update(authTokens)
      .set({ usedAt: now })
      .where(and(eq(authTokens.id, sha256Hex(token as string)), eq(authTokens.kind, "password_reset"), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)))
      .returning();
    if (!used?.userId) throw new ServiceError("gone", RESET_GONE);

    const [user] = await tx
      .update(users)
      // The reset link only ever went to this mailbox, so using it proves control of the address.
      .set({ passwordHash, emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, ${now.toISOString()}::timestamptz)` })
      .where(and(eq(users.id, used.userId), isNull(users.disabledAt)))
      .returning();
    if (!user) throw new ServiceError("gone", RESET_GONE);

    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    await audit(tx, user.orgId, { type: "user", label: actorLabel(user) }, "member.password_reset", { userId: user.id }, meta);
    return toMember(user);
  });
  // Someone locked out by failed attempts who then resets should be able to sign in straight
  // away, from whichever network they are on. After the transaction on purpose: the limiter
  // uses its own connection.
  await clearRateLimitPrefix(loginSourcePrefix(member.email));
  return member;
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

function toPendingInvite(row: typeof authTokens.$inferSelect): PendingInvite {
  return {
    id: row.id,
    email: row.email,
    role: row.role === "admin" ? "admin" : "member",
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    expired: row.expiresAt.getTime() <= Date.now(),
  };
}

/** Everyone in the actor's company, oldest first. */
export async function listMembers(actor: Actor): Promise<Member[]> {
  const db = await getDb();
  if (actor?.type === "user") await loadActorUser(db, actor);
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.orgId, actor?.orgId ?? ""))
    .orderBy(asc(users.createdAt), asc(users.id));
  return rows.map(toMember);
}

/** The signed-in person's own saved signature (PNG data URL), for their profile page. */
export async function getOwnSignature(actor: Actor): Promise<string | null> {
  const db = await getDb();
  return (await loadActorUser(db, actor)).savedSignature;
}

/** Invites that have not been accepted yet, newest first. Expired ones are included and flagged. */
export async function listPendingInvites(actor: Actor): Promise<PendingInvite[]> {
  const db = await getDb();
  await loadManager(db, actor);
  const rows = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.kind, "invite"), eq(authTokens.orgId, actor.orgId), isNull(authTokens.usedAt)));
  return rows.map(toPendingInvite).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Invites someone to the actor's company. Inviting the same address again replaces the earlier link. */
export async function inviteMember(actor: Actor, input: { email: unknown; role: unknown }, meta?: RequestMeta): Promise<InviteResult> {
  const db = await getDb();
  const manager = await loadManager(db, actor);
  const raw = asRecord(input);

  const fields: Record<string, string> = {};
  const email = normalizeEmail(raw.email);
  if (!isValidEmail(email)) fields.email = "Enter a valid email address, like name@example.com.";
  const role = raw.role === "admin" || raw.role === "member" ? raw.role : null;
  if (!role) fields.role = "Choose a role: admin or member.";
  if (!role || Object.keys(fields).length > 0) throw invalid(fields);

  // Invites send email to arbitrary addresses on our domain's reputation. Counted before
  // the address is looked up, so attempts that end in "already on your team" are capped too.
  const limit = await rateLimit(`invite:org:${manager.orgId}`, 40, 3600);
  if (!limit.ok) {
    throw new ServiceError("rate_limited", `Your team has sent a lot of invitations. Try again ${describeWait(limit.retryAfterSeconds)}.`);
  }

  const [existing] = await db.select({ orgId: users.orgId }).from(users).where(eq(users.email, email)).limit(1);
  if (existing?.orgId === manager.orgId) {
    // Not a leak: a manager can already see their own team list.
    const message = "This person is already on your team.";
    throw new ServiceError("conflict", message, { email: message });
  }
  // An address with an account at another company gets exactly the same result as a new
  // one, or any free account could use invites to find out who is a customer. The
  // invite is recorded as usual and can never be accepted; the mailbox owner is the one
  // who is told why.
  const hasAccountElsewhere = Boolean(existing);

  const token = newSecret();
  const { row, org } = await db.transaction(async (tx) => {
    const org = await lockOrg(tx, manager.orgId);
    await tx.delete(authTokens).where(and(eq(authTokens.kind, "invite"), eq(authTokens.orgId, org.id), eq(authTokens.email, email)));
    const [row] = await tx
      .insert(authTokens)
      .values({
        id: sha256Hex(token),
        kind: "invite",
        orgId: org.id,
        userId: manager.id,
        email,
        role,
        expiresAt: new Date(Date.now() + ACCOUNT_LIMITS.inviteDays * 86_400_000),
      })
      .returning();
    await audit(tx, org.id, { type: "user", label: actorLabel(manager) }, "member.invited", { email, role }, meta);
    return { row, org };
  });

  const url = inviteUrl(token);
  // An invitation is an email to an address outside the company, sent in its name.
  const hold = await externalEmailHold(db, org.id, email);
  const sent = await safeSend({
    orgId: org.id,
    kind: "invite",
    to: email,
    fromName: org.name,
    ...(hold ? { holdReason: hold } : {}),
    ...(hasAccountElsewhere
      ? inviteExistingAccountEmail({ orgName: org.name, inviterName: manager.name, resetUrl: forgotPasswordUrl() })
      : inviteEmail({ orgName: org.name, inviterName: manager.name, url })),
  });
  return {
    invite: toPendingInvite(row),
    url,
    emailStatus: hold ? "skipped" : sent.status,
    emailError: hold ?? sent.error,
    ...(hold ? { emailUnverified: true } : {}),
  };
}

/** Cancels an invite that has not been accepted. */
export async function revokeInvite(actor: Actor, inviteId: unknown, meta?: RequestMeta): Promise<void> {
  const db = await getDb();
  const manager = await loadManager(db, actor);
  const id = typeof inviteId === "string" ? inviteId : "";
  await db.transaction(async (tx) => {
    const [removed] = id
      ? await tx
          .delete(authTokens)
          .where(and(eq(authTokens.id, id), eq(authTokens.kind, "invite"), eq(authTokens.orgId, manager.orgId), isNull(authTokens.usedAt)))
          .returning()
      : [];
    if (!removed) throw new ServiceError("not_found", "That invitation no longer exists. It may have been accepted or already cancelled.");
    await audit(tx, manager.orgId, { type: "user", label: actorLabel(manager) }, "member.invite_revoked", { email: removed.email }, meta);
  });
}

const INVITE_GONE = "This invitation has expired or was already used. Ask the person who invited you to send a new one.";

/** Details of an invite link for the join page. Throws `gone` when it cannot be used. */
export async function getInvite(token: unknown): Promise<InviteDetails> {
  if (!isSecretToken(token)) throw new ServiceError("gone", INVITE_GONE);
  const db = await getDb();
  const [row] = await db
    .select({ invite: authTokens, orgName: orgs.name, inviter: { role: users.role, disabledAt: users.disabledAt } })
    .from(authTokens)
    .innerJoin(orgs, eq(orgs.id, authTokens.orgId))
    // Same company as the invite: an inviter row from anywhere else gives no authority here.
    .leftJoin(users, and(eq(users.id, authTokens.userId), eq(users.orgId, authTokens.orgId)))
    .where(and(eq(authTokens.id, sha256Hex(token)), eq(authTokens.kind, "invite"), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())))
    .limit(1);
  // An invite is only as good as the person who sent it: once they are turned off or
  // no longer a manager, the link is dead even if the row was never cleaned up.
  if (!row || !row.invite.orgId || !isManagerRow(row.inviter)) throw new ServiceError("gone", INVITE_GONE);
  return {
    email: row.invite.email,
    role: row.invite.role === "admin" ? "admin" : "member",
    orgId: row.invite.orgId,
    orgName: row.orgName,
    expiresAt: row.invite.expiresAt,
  };
}

/** Creates the invited person's account. The caller starts the session with user.id. */
export async function acceptInvite(token: unknown, input: { name: unknown; password: unknown }, meta?: RequestMeta): Promise<{ user: Member; org: Org }> {
  const raw = asRecord(input);
  const fields: Record<string, string> = {};
  const name = requiredText(raw.name, ACCOUNT_LIMITS.nameMax, "name", "your name", fields);
  const pw = passwordProblem(raw.password);
  if (pw) fields.password = pw;
  // Checked before the form errors: there is no point fixing a form for a dead link.
  await getInvite(token);
  if (Object.keys(fields).length > 0) throw invalid(fields);

  const passwordHash = await hashPassword(raw.password as string);
  const db = await getDb();
  return db.transaction(async (tx) => {
    const now = new Date();
    const [used] = await tx
      .update(authTokens)
      .set({ usedAt: now })
      .where(and(eq(authTokens.id, sha256Hex(token as string)), eq(authTokens.kind, "invite"), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)))
      .returning();
    if (!used?.orgId) throw new ServiceError("gone", INVITE_GONE);
    const [org] = await tx.select().from(orgs).where(eq(orgs.id, used.orgId)).limit(1);
    if (!org) throw new ServiceError("gone", INVITE_GONE);
    // Re-checked inside the transaction: the inviter may have been turned off or demoted
    // between the page load and this submit. Throwing rolls the token update back.
    const [inviter] = used.userId
      ? await tx
          .select({ role: users.role, disabledAt: users.disabledAt })
          .from(users)
          .where(and(eq(users.id, used.userId), eq(users.orgId, org.id)))
          .limit(1)
      : [];
    if (!isManagerRow(inviter)) throw new ServiceError("gone", INVITE_GONE);

    const [user] = await tx
      .insert(users)
      // The invitation only ever went to this mailbox, so accepting it proves control of the address.
      .values({ id: newId("usr"), orgId: org.id, email: used.email, name, passwordHash, role: used.role === "admin" ? "admin" : "member", emailVerifiedAt: now })
      .onConflictDoNothing()
      .returning();
    // Rolls back, so the invite is not consumed by an attempt that created nothing.
    if (!user) throw new ServiceError("conflict", "An account with this email already exists. Sign in instead.");

    // Invites to the same address from other companies can never be accepted now.
    await tx.delete(authTokens).where(and(eq(authTokens.kind, "invite"), eq(authTokens.email, used.email), isNull(authTokens.usedAt)));
    await audit(tx, org.id, { type: "user", label: actorLabel(user) }, "member.joined", { userId: user.id, role: user.role }, meta);
    return { user: toMember(user), org };
  });
}

/**
 * Changes a teammate's role. Admins manage admins and members; only an owner can
 * make or unmake an owner. Nobody changes their own role, which together with the
 * owner check below means a company always keeps an active owner.
 */
export async function changeMemberRole(actor: Actor, userId: unknown, role: unknown, meta?: RequestMeta): Promise<AccessChange> {
  if (role !== "owner" && role !== "admin" && role !== "member") {
    throw invalid({ role: "Choose a role: owner, admin or member." });
  }
  const db = await getDb();
  return db.transaction(async (tx) => {
    const org = await lockOrg(tx, actor?.orgId ?? "");
    const manager = await loadManager(tx, actor);
    const target = await findTarget(tx, org.id, userId);
    if (target.id === manager.id) {
      throw new ServiceError("forbidden", "You cannot change your own role. Ask another owner or admin to do it.");
    }
    if ((target.role === "owner" || role === "owner") && manager.role !== "owner") {
      throw new ServiceError("forbidden", "Only an owner can change who the owners are.");
    }
    if (role === "owner" && target.disabledAt) {
      throw new ServiceError("conflict", "Turn this account back on before making them an owner.");
    }
    if (target.role === role) return { ...toMember(target), cancelledInvites: [], revokedApiKeys: [] };

    const [updated] = await tx.update(users).set({ role }).where(and(eq(users.id, target.id), eq(users.orgId, org.id))).returning();
    await assertActiveOwnerRemains(tx, org.id);
    // A member cannot invite, so invitations they sent as a manager stop with the role.
    // Their API keys stay: they are still a trusted colleague, and a manager can revoke them.
    const cancelledInvites = role === "member" ? await cancelInvitesFrom(tx, org.id, target.id) : [];
    await audit(
      tx,
      org.id,
      { type: "user", label: actorLabel(manager) },
      "member.role_changed",
      { userId: target.id, email: target.email, from: target.role, to: role, ...(cancelledInvites.length > 0 ? { cancelledInvites } : {}) },
      meta,
    );
    return { ...toMember(updated), cancelledInvites, revokedApiKeys: [] };
  });
}

/**
 * Turns a teammate's access off or back on. Turning it off removes every way back in
 * that they hold: sessions, invitations they sent that are still open, and API keys
 * they created (the key is shown to its creator, so they may still have it). The
 * result lists what was cancelled; turning the account back on does not restore it.
 */
export async function setMemberDisabled(actor: Actor, userId: unknown, disabled: unknown, meta?: RequestMeta): Promise<AccessChange> {
  if (typeof disabled !== "boolean") throw invalid({ disabled: "Choose whether this account is on or off." });
  const db = await getDb();
  return db.transaction(async (tx) => {
    const org = await lockOrg(tx, actor?.orgId ?? "");
    const manager = await loadManager(tx, actor);
    const target = await findTarget(tx, org.id, userId);
    if (target.id === manager.id) {
      throw new ServiceError("forbidden", "You cannot turn off your own account. Ask another owner or admin to do it.");
    }
    if (target.role === "owner" && manager.role !== "owner") {
      throw new ServiceError("forbidden", "Only an owner can turn an owner's account off or on.");
    }
    if ((target.disabledAt !== null) === disabled) return { ...toMember(target), cancelledInvites: [], revokedApiKeys: [] };

    const [updated] = await tx
      .update(users)
      .set({ disabledAt: disabled ? new Date() : null })
      .where(and(eq(users.id, target.id), eq(users.orgId, org.id)))
      .returning();
    let cancelledInvites: string[] = [];
    let revokedApiKeys: { id: string; name: string }[] = [];
    if (disabled) {
      await assertActiveOwnerRemains(tx, org.id);
      await tx.delete(sessions).where(eq(sessions.userId, target.id));
      // A disabled person must not keep signing agreements on the company's behalf.
      await releaseCountersigner(tx, org, target.id, { keepAsManual: false });
      // The countersign links in their inbox stay dead even if the account is turned back on.
      await revokeCountersignLinksForUser(tx, org.id, target.id);
      cancelledInvites = await cancelInvitesFrom(tx, org.id, target.id);
      revokedApiKeys = await tx
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(apiKeys.orgId, org.id), eq(apiKeys.createdBy, target.id), isNull(apiKeys.revokedAt)))
        .returning({ id: apiKeys.id, name: apiKeys.name });
      for (const key of revokedApiKeys) {
        // Same event a manual revoke writes, so the key's own history explains why it stopped working.
        await audit(tx, org.id, { type: "user", label: actorLabel(manager) }, "api_key.revoked", { keyId: key.id, name: key.name, reason: "creator_disabled", createdBy: target.id }, meta);
      }
    }
    await audit(
      tx,
      org.id,
      { type: "user", label: actorLabel(manager) },
      disabled ? "member.disabled" : "member.enabled",
      {
        userId: target.id,
        email: target.email,
        ...(cancelledInvites.length > 0 ? { cancelledInvites } : {}),
        // Not "revokedApiKeys": the audit trail drops any key that looks like it holds a credential.
        ...(revokedApiKeys.length > 0 ? { revokedKeys: revokedApiKeys } : {}),
      },
      meta,
    );
    return { ...toMember(updated), cancelledInvites, revokedApiKeys };
  });
}

/** Makes another active teammate an owner and steps the current owner down to admin, in one step. */
export async function transferOwnership(actor: Actor, userId: unknown, meta?: RequestMeta): Promise<{ newOwner: Member; previousOwner: Member }> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const org = await lockOrg(tx, actor?.orgId ?? "");
    const owner = await loadActorUser(tx, actor);
    if (owner.role !== "owner") throw new ServiceError("forbidden", "Only an owner can transfer ownership.");
    const target = await findTarget(tx, org.id, userId);
    if (target.id === owner.id) throw new ServiceError("invalid", "You are already the owner. Choose someone else.");
    if (target.disabledAt) throw new ServiceError("conflict", "Turn this account back on before making them the owner.");

    const [newOwner] = await tx.update(users).set({ role: "owner" }).where(and(eq(users.id, target.id), eq(users.orgId, org.id))).returning();
    const [previousOwner] = await tx.update(users).set({ role: "admin" }).where(and(eq(users.id, owner.id), eq(users.orgId, org.id))).returning();
    await assertActiveOwnerRemains(tx, org.id);
    await audit(tx, org.id, { type: "user", label: actorLabel(owner) }, "member.ownership_transferred", { fromUserId: owner.id, toUserId: target.id, toEmail: target.email }, meta);
    return { newOwner: toMember(newOwner), previousOwner: toMember(previousOwner) };
  });
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function updateProfile(actor: Actor, input: { name?: unknown; title?: unknown }): Promise<Member> {
  const raw = asRecord(input);
  const fields: Record<string, string> = {};
  const change: { name?: string; title?: string | null } = {};
  if (raw.name !== undefined) change.name = requiredText(raw.name, ACCOUNT_LIMITS.nameMax, "name", "your name", fields);
  if (raw.title !== undefined) change.title = optionalText(raw.title, ACCOUNT_LIMITS.titleMax, "title", "your title", fields);

  const db = await getDb();
  const me = await loadActorUser(db, actor);
  if (Object.keys(fields).length > 0) throw invalid(fields);
  if (Object.keys(change).length === 0) return toMember(me);
  const [updated] = await db.update(users).set(change).where(and(eq(users.id, me.id), eq(users.orgId, me.orgId))).returning();
  return toMember(updated);
}

/**
 * Changes the signed-in person's password and ends EVERY session for them, including
 * the current one: a service cannot see which cookie is the caller's. The page calls
 * startSession(member.id) straight after, which leaves only the current browser signed in.
 */
export async function changePassword(actor: Actor, current: unknown, next: unknown, meta?: RequestMeta): Promise<Member> {
  const db = await getDb();
  const me = await loadActorUser(db, actor);

  const fields: Record<string, string> = {};
  if (typeof current !== "string" || !current) fields.current = "Enter your current password.";
  const pw = passwordProblem(next);
  if (pw) fields.next = pw;
  if (Object.keys(fields).length > 0) throw invalid(fields);

  // A stolen session should not allow unlimited guesses at the current password.
  const key = `password:user:${me.id}`;
  const limit = await rateLimit(key, 10, 900);
  if (!limit.ok) throw new ServiceError("rate_limited", `Too many attempts. Try again ${describeWait(limit.retryAfterSeconds)}.`);

  const currentOk = (current as string).length <= PASSWORD_MAX_LENGTH && (await verifyPassword(current as string, me.passwordHash));
  if (!currentOk) {
    const message = "That is not your current password. Try again, or sign out and reset it.";
    throw new ServiceError("invalid", message, { current: message });
  }
  if (current === next) {
    const message = "The new password is the same as the current one. Choose a different password.";
    throw new ServiceError("invalid", message, { next: message });
  }

  const passwordHash = await hashPassword(next as string);
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(users).set({ passwordHash }).where(and(eq(users.id, me.id), eq(users.orgId, me.orgId))).returning();
    await tx.delete(sessions).where(eq(sessions.userId, me.id));
    // Outstanding reset links were issued for the old password; they should die with it.
    await tx.delete(authTokens).where(and(eq(authTokens.kind, "password_reset"), eq(authTokens.userId, me.id)));
    await audit(tx, me.orgId, { type: "user", label: actorLabel(me) }, "member.password_changed", { userId: me.id }, meta);
    return row;
  });
  await clearRateLimit(key);
  return toMember(updated);
}

/** Saves the signature the person draws once and reuses for countersigning. */
export async function saveSignature(actor: Actor, dataUrl: unknown): Promise<Member> {
  const db = await getDb();
  const me = await loadActorUser(db, actor);
  const img = parseImageDataUrl(dataUrl, ["png"], LIMITS.maxSignatureBytes);
  if (!img.ok) {
    const message =
      img.reason === "too_large"
        ? `That signature image is larger than ${Math.round(LIMITS.maxSignatureBytes / 1024)} KB. Draw it again or upload a smaller PNG.`
        : img.reason === "corrupt"
          ? "That signature image could not be read. Draw it again or upload a different PNG."
          : "A signature must be a PNG image. Draw it again or upload a PNG.";
    throw new ServiceError("invalid", message, { signature: message });
  }
  // The same check the document engine runs when it draws the image: byte size alone
  // would accept a small file with enormous pixel dimensions, which every later
  // countersignature would then refuse.
  const drawable = parseSignatureImage(img.dataUrl);
  if (!drawable.ok) {
    const message = /too large/i.test(drawable.reason)
      ? "That signature image has too many pixels to be placed on a document. Draw it again, or upload a smaller PNG."
      : "That signature image could not be read as a PNG. Draw it again or upload a different PNG.";
    throw new ServiceError("invalid", message, { signature: message });
  }
  const [updated] = await db.update(users).set({ savedSignature: img.dataUrl }).where(and(eq(users.id, me.id), eq(users.orgId, me.orgId))).returning();
  return toMember(updated);
}

/** Removes the saved signature. Automatic countersigning that depended on it falls back to manual. */
export async function clearSignature(actor: Actor): Promise<Member> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const org = await lockOrg(tx, actor?.orgId ?? "");
    const me = await loadActorUser(tx, actor);
    const [updated] = await tx.update(users).set({ savedSignature: null }).where(and(eq(users.id, me.id), eq(users.orgId, org.id))).returning();
    // Still the countersigner, but they now sign by hand: auto mode has nothing to apply.
    await releaseCountersigner(tx, org, me.id, { keepAsManual: true });
    return toMember(updated);
  });
}


/**
 * A company's logo as image bytes, for the one public address that serves it to
 * email clients (which do not display inline data: images). Returns nothing else
 * about the company, and only PNG or JPEG: the types accepted when a logo is saved.
 */
export async function getOrgLogo(orgId: unknown): Promise<{ bytes: Buffer; contentType: "image/png" | "image/jpeg" } | null> {
  if (typeof orgId !== "string" || !/^org_[0-9a-z]{8,40}$/.test(orgId)) return null;
  const db = await getDb();
  const [row] = await db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
  const logo = row?.settings?.logo;
  if (typeof logo !== "string") return null;
  const match = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(logo);
  if (!match) return null;
  return { bytes: Buffer.from(match[2], "base64"), contentType: match[1] as "image/png" | "image/jpeg" };
}
