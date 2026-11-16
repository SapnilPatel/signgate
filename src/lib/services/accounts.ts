/**
 * Accounts, team and company settings.
 *
 * Services never touch cookies: sign-up, sign-in and invite acceptance return the
 * user, and the calling page starts the session. Every function that takes an actor
 * reads and writes only rows whose org_id is actor.orgId; an id from another company
 * behaves exactly like an id that does not exist.
 */
import { and, asc, count, eq, gt, isNull } from "drizzle-orm";
import { getDb, type DbOrTx, type Tx } from "@/lib/db";
import { authTokens, orgs, sessions, users, type Org, type User } from "@/lib/db/schema";
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
  parseImageDataUrl,
} from "@/lib/validation";
import { ServiceError, type Actor, type RequestMeta } from "./context";
import { sendEmail } from "./email";
import { recordEvent, type EventActor } from "./events";
import { inviteEmail, passwordResetEmail } from "./email-templates";
import { clearRateLimit, describeWait, rateLimit } from "./rate-limit";

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
  createdAt: Date;
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
  emailError?: string;
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
} as const;

/** Paths of the pages that consume the emailed tokens. */
export const resetPasswordUrl = (token: string) => `${env.appUrl}/reset-password/${token}`;
export const inviteUrl = (token: string) => `${env.appUrl}/invite/${token}`;

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

/** Creates a company and its owner. The caller starts the session with user.id. */
export async function signUp(
  input: { orgName: unknown; name: unknown; email: unknown; password: unknown },
  meta?: RequestMeta,
): Promise<{ user: Member; org: Org }> {
  const raw = asRecord(input);
  const fields: Record<string, string> = {};
  const orgName = requiredText(raw.orgName, ACCOUNT_LIMITS.orgNameMax, "orgName", "your company name", fields);
  const name = requiredText(raw.name, ACCOUNT_LIMITS.nameMax, "name", "your name", fields);
  const email = normalizeEmail(raw.email);
  if (!isValidEmail(email)) fields.email = "Enter a valid email address, like name@example.com.";
  const pw = passwordProblem(raw.password);
  if (pw) fields.password = pw;
  if (Object.keys(fields).length > 0) throw invalid(fields);

  if (meta?.ip) {
    // Each sign-up costs a password hash and creates a tenant; cap what one address can do.
    const limit = await rateLimit(`signup:ip:${meta.ip}`, 10, 3600);
    if (!limit.ok) {
      throw new ServiceError("rate_limited", `Too many accounts were created from this network. Try again ${describeWait(limit.retryAfterSeconds)}.`);
    }
  }

  const db = await getDb();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) throw new ServiceError("conflict", DUPLICATE_EMAIL, { email: DUPLICATE_EMAIL });

  // Hashing is deliberately slow; keep it outside the transaction.
  const passwordHash = await hashPassword(raw.password as string);
  const base = slugify(orgName);

  return db.transaction(async (tx) => {
    let org: Org | undefined;
    // ON CONFLICT DO NOTHING rather than catching a unique violation: an error would
    // abort the transaction, and a pre-check would race with a concurrent sign-up.
    for (let attempt = 0; attempt < 8 && !org; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomString(attempt < 5 ? 4 : 12)}`;
      [org] = await tx.insert(orgs).values({ id: newId("org"), name: orgName, slug }).onConflictDoNothing().returning();
    }
    if (!org) throw new ServiceError("conflict", "We could not set up your company account. Try again.");

    const [user] = await tx
      .insert(users)
      .values({ id: newId("usr"), orgId: org.id, email, name, passwordHash, role: "owner" })
      .onConflictDoNothing()
      .returning();
    // Throwing rolls the org insert back, so a lost race never leaves an ownerless company.
    if (!user) throw new ServiceError("conflict", DUPLICATE_EMAIL, { email: DUPLICATE_EMAIL });

    await audit(tx, org.id, { type: "user", label: actorLabel(user) }, "org.created", { userId: user.id }, meta);
    return { user: toMember(user), org };
  });
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

  const emailKey = `login:email:${email}`;
  if (meta?.ip) {
    const byIp = await rateLimit(`login:ip:${meta.ip}`, 50, 900);
    if (!byIp.ok) throw new ServiceError("rate_limited", `Too many sign-in attempts from this network. Try again ${describeWait(byIp.retryAfterSeconds)}.`);
  }
  const byEmail = await rateLimit(emailKey, 10, 900);
  if (!byEmail.ok) {
    throw new ServiceError("rate_limited", `Too many sign-in attempts for this email. Try again ${describeWait(byEmail.retryAfterSeconds)}, or reset your password.`);
  }

  const db = await getDb();
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  // An over-long password cannot match anything; hash a short stand-in so the cost stays the same.
  const candidate = password.length > PASSWORD_MAX_LENGTH ? "x" : password;
  const fallback = await getDummyHash();
  const matches = await verifyPassword(candidate, user?.passwordHash ?? fallback);
  if (!user || !matches || password.length > PASSWORD_MAX_LENGTH) {
    throw new ServiceError("invalid", LOGIN_FAILED);
  }
  // Only said after the right password, so it cannot be used to probe which emails exist.
  if (user.disabledAt) {
    throw new ServiceError("forbidden", "This account has been turned off. Ask an owner of your company account to turn it back on.");
  }
  // Failed attempts are forgiven for the email only; the per-network counter keeps
  // counting so one valid login cannot be used to reset a guessing run.
  await clearRateLimit(emailKey);
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
    if (meta?.ip && !(await rateLimit(`reset:ip:${meta.ip}`, 20, 3600)).ok) return;
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
      .set({ passwordHash })
      .where(and(eq(users.id, used.userId), isNull(users.disabledAt)))
      .returning();
    if (!user) throw new ServiceError("gone", RESET_GONE);

    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    await audit(tx, user.orgId, { type: "user", label: actorLabel(user) }, "member.password_reset", { userId: user.id }, meta);
    return toMember(user);
  });
  // Someone locked out by failed attempts who then resets should be able to sign in straight away.
  // After the transaction on purpose: the limiter uses its own connection.
  await clearRateLimit(`login:email:${member.email}`);
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

  const [existing] = await db.select({ orgId: users.orgId }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    const message =
      existing.orgId === manager.orgId
        ? "This person is already on your team."
        : "This email already has an account with another company, so it cannot be invited. Ask them for a different email address.";
    throw new ServiceError("conflict", message, { email: message });
  }

  // Invites send email to arbitrary addresses on our domain's reputation.
  const limit = await rateLimit(`invite:org:${manager.orgId}`, 40, 3600);
  if (!limit.ok) {
    throw new ServiceError("rate_limited", `Your team has sent a lot of invitations. Try again ${describeWait(limit.retryAfterSeconds)}.`);
  }

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
  const sent = await safeSend({
    orgId: org.id,
    kind: "invite",
    to: email,
    fromName: org.name,
    ...inviteEmail({ orgName: org.name, inviterName: manager.name, url }),
  });
  return { invite: toPendingInvite(row), url, emailStatus: sent.status, emailError: sent.error };
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
    .select({ invite: authTokens, orgName: orgs.name })
    .from(authTokens)
    .innerJoin(orgs, eq(orgs.id, authTokens.orgId))
    .where(and(eq(authTokens.id, sha256Hex(token)), eq(authTokens.kind, "invite"), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())))
    .limit(1);
  if (!row || !row.invite.orgId) throw new ServiceError("gone", INVITE_GONE);
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

    const [user] = await tx
      .insert(users)
      .values({ id: newId("usr"), orgId: org.id, email: used.email, name, passwordHash, role: used.role === "admin" ? "admin" : "member" })
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
export async function changeMemberRole(actor: Actor, userId: unknown, role: unknown, meta?: RequestMeta): Promise<Member> {
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
    if (target.role === role) return toMember(target);

    const [updated] = await tx.update(users).set({ role }).where(and(eq(users.id, target.id), eq(users.orgId, org.id))).returning();
    await assertActiveOwnerRemains(tx, org.id);
    await audit(tx, org.id, { type: "user", label: actorLabel(manager) }, "member.role_changed", { userId: target.id, email: target.email, from: target.role, to: role }, meta);
    return toMember(updated);
  });
}

/** Turns a teammate's access off or back on. Turning it off signs them out everywhere. */
export async function setMemberDisabled(actor: Actor, userId: unknown, disabled: unknown, meta?: RequestMeta): Promise<Member> {
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
    if ((target.disabledAt !== null) === disabled) return toMember(target);

    const [updated] = await tx
      .update(users)
      .set({ disabledAt: disabled ? new Date() : null })
      .where(and(eq(users.id, target.id), eq(users.orgId, org.id)))
      .returning();
    if (disabled) {
      await assertActiveOwnerRemains(tx, org.id);
      await tx.delete(sessions).where(eq(sessions.userId, target.id));
      // A disabled person must not keep signing agreements on the company's behalf.
      await releaseCountersigner(tx, org, target.id, { keepAsManual: false });
    }
    await audit(tx, org.id, { type: "user", label: actorLabel(manager) }, disabled ? "member.disabled" : "member.enabled", { userId: target.id, email: target.email }, meta);
    return toMember(updated);
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
