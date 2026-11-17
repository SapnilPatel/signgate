import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";

const sent: { kind: string; to: string; subject: string; html: string; text: string; orgId?: string | null; holdReason?: string }[] = [];
let emailBehaviour: "sent" | "failed" | "skipped" | "throw" = "sent";

vi.mock("@/lib/services/email", () => ({
  sendEmail: vi.fn(async (msg: (typeof sent)[number]) => {
    if (emailBehaviour === "throw") throw new Error("provider exploded");
    // A held message is logged as skipped and never sent, as in the real module.
    if (msg.holdReason) return { status: "skipped", error: msg.holdReason };
    if (emailBehaviour === "sent") sent.push(msg);
    return emailBehaviour === "failed" ? { status: "failed", error: "Mailbox unavailable" } : { status: emailBehaviour };
  }),
  // "skipped" is how the real module answers when no provider is set up.
  emailIsConfigured: () => emailBehaviour !== "skipped",
}));
vi.mock("@/lib/services/email-templates", async (importOriginal) => ({
  // The signing services reach this module too; everything not overridden below stays real.
  ...(await importOriginal<typeof import("@/lib/services/email-templates")>()),
  verifyEmailEmail: (p: { name: string; orgName: string; url: string }) => ({ subject: "Confirm your email address", html: `<a href="${p.url}">confirm</a>`, text: p.url }),
  passwordResetEmail: (p: { name: string; url: string }) => ({ subject: "Reset your password", html: `<a href="${p.url}">reset</a>`, text: p.url }),
  inviteEmail: (p: { orgName: string; inviterName: string; url: string }) => ({
    subject: `${p.inviterName} invited you to ${p.orgName}`,
    html: `<a href="${p.url}">join</a>`,
    text: p.url,
  }),
  inviteExistingAccountEmail: (p: { orgName: string; inviterName: string; resetUrl: string }) => ({
    subject: `${p.inviterName} tried to invite you to ${p.orgName}`,
    html: `<a href="${p.resetUrl}">existing account</a>`,
    text: p.resetUrl,
  }),
  signInAlertEmail: (p: { name: string; resetUrl: string }) => ({ subject: "Many failed sign-in attempts", html: `<a href="${p.resetUrl}">alert</a>`, text: p.resetUrl }),
}));

import { getDb } from "@/lib/db";
import { apiKeys, authTokens, events, orgs, rateLimits, sessions, users } from "@/lib/db/schema";
import { authenticateApiKey, createApiKey, listApiKeys } from "@/lib/services/api-keys";
import { sha256Hex, newSecret } from "@/lib/ids";
import { LIMITS } from "@/lib/types";
import { ServiceError, type Actor } from "@/lib/services/context";
import {
  signUp,
  logIn,
  requestPasswordReset,
  resetPassword,
  isPasswordResetTokenValid,
  inviteMember,
  getInvite,
  acceptInvite,
  listMembers,
  listPendingInvites,
  revokeInvite,
  changeMemberRole,
  setMemberDisabled,
  transferOwnership,
  updateProfile,
  changePassword,
  saveSignature,
  clearSignature,
  getOwnSignature,
  updateOrg,
  resolveSettings,
  type Member,
} from "@/lib/services/accounts";

const PASSWORD = "correct horse battery";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PNG_URL = `data:image/png;base64,${PNG.toString("base64")}`;
const JPEG_URL = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]).toString("base64")}`;

let seq = 0;
const uniqueEmail = (label = "user") => `${label}${++seq}@example.com`;

const actorOf = (m: Member): Actor => ({ type: "user", orgId: m.orgId, userId: m.id, role: m.role, label: m.name });

/** A company whose owner has confirmed their address, which is the normal state; `verified: false` leaves it as sign-up does. */
async function newOrg(orgName = `Test Co ${++seq}`, opts: { verified?: boolean } = {}) {
  const { user, org } = await signUp({ orgName, name: "Olive Owner", email: uniqueEmail("owner"), password: PASSWORD });
  if (opts.verified !== false) {
    const db = await getDb();
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, user.id));
  }
  // The confirmation email every sign-up sends is not what these tests are about.
  sent.length = 0;
  return { owner: { ...user, emailVerified: opts.verified !== false }, org, actor: actorOf(user) };
}

/** Invites and accepts, returning the new member. */
async function addMember(by: Actor, role: "admin" | "member", name = "Terry Teammate"): Promise<Member> {
  const email = uniqueEmail(role);
  const { url } = await inviteMember(by, { email, role });
  const { user } = await acceptInvite(tokenFrom(url), { name, password: PASSWORD });
  return user;
}

const tokenFrom = (url: string) => url.split("/").pop() as string;

/** Runs fn and returns the ServiceError it throws; fails the test if it does not throw one. */
async function failure(fn: () => Promise<unknown>): Promise<ServiceError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ServiceError) return err;
    throw err;
  }
  throw new Error("Expected a ServiceError, but the call succeeded");
}

async function startFakeSession(userId: string): Promise<string> {
  const db = await getDb();
  const id = sha256Hex(newSecret());
  await db.insert(sessions).values({ id, userId, expiresAt: new Date(Date.now() + 86_400_000) });
  return id;
}

async function sessionCount(userId: string): Promise<number> {
  const db = await getDb();
  return (await db.select().from(sessions).where(eq(sessions.userId, userId))).length;
}

async function reloadOrg(orgId: string) {
  const db = await getDb();
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  return org;
}

beforeEach(() => {
  sent.length = 0;
  emailBehaviour = "sent";
});

// ---------------------------------------------------------------------------

describe("signUp", () => {
  it("creates a company and its owner with cleaned values", async () => {
    const { user, org } = await signUp({ orgName: "  Harbour   Legal LLP ", name: " Ada\tLovelace ", email: "  ADA.Signup@Example.com ", password: PASSWORD });
    expect(org.name).toBe("Harbour Legal LLP");
    expect(org.slug).toBe("harbour-legal-llp");
    expect(org.settings).toEqual({});
    expect(user).toMatchObject({ orgId: org.id, name: "Ada Lovelace", email: "ada.signup@example.com", role: "owner", disabled: false, hasSignature: false });
    // The public shape never carries secrets.
    expect(Object.keys(user)).not.toContain("passwordHash");
    expect(Object.keys(user)).not.toContain("savedSignature");

    const db = await getDb();
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row.passwordHash.startsWith("scrypt$")).toBe(true);
    expect(row.passwordHash).not.toContain(PASSWORD);
  });

  it("gives companies with the same or unusable names distinct slugs", async () => {
    const a = await newOrg("Twin Peaks Co");
    const b = await newOrg("Twin Peaks Co");
    const c = await newOrg("twin  peaks, co!");
    expect(a.org.slug).toBe("twin-peaks-co");
    expect(new Set([a.org.slug, b.org.slug, c.org.slug]).size).toBe(3);
    expect(b.org.slug).toMatch(/^twin-peaks-co-[0-9a-z]{4}$/);

    const cjk = await newOrg(String.fromCodePoint(0x6cd5, 0x5f8b, 0x4e8b, 0x52a1, 0x6240));
    const symbols = await newOrg("!!! ???");
    expect(cjk.org.slug).toMatch(/^company/);
    expect(symbols.org.slug).toMatch(/^company-/);
    const accented = await newOrg("Café Zürich & Søn");
    expect(accented.org.slug).toMatch(/^cafe-zurich-s/);
    const long = await newOrg("A".repeat(100));
    expect(long.org.slug.length).toBeLessThanOrEqual(60);
  });

  it("rejects a duplicate email clearly and leaves no orphan company behind", async () => {
    const email = uniqueEmail("dup");
    await signUp({ orgName: "First Co", name: "A", email, password: PASSWORD });
    const db = await getDb();
    const before = (await db.select().from(orgs)).length;
    const err = await failure(() => signUp({ orgName: "Second Co", name: "B", email: `  ${email.toUpperCase()} `, password: PASSWORD }));
    expect(err.code).toBe("conflict");
    expect(err.fields?.email).toMatch(/already exists/);
    expect((await db.select().from(orgs)).length).toBe(before);
  });

  it("lets only one of two simultaneous sign-ups with the same email win", async () => {
    const email = uniqueEmail("race");
    const db = await getDb();
    const before = (await db.select().from(orgs)).length;
    const results = await Promise.allSettled([
      signUp({ orgName: "Race A", name: "A", email, password: PASSWORD }),
      signUp({ orgName: "Race B", name: "B", email, password: PASSWORD }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ServiceError);
    expect(rejected.reason.code).toBe("conflict");
    expect((await db.select().from(orgs)).length).toBe(before + 1);
  });

  it("reports every bad field at once, whatever the input type", async () => {
    const err = await failure(() => signUp({ orgName: "   ", name: 42 as unknown, email: "not-an-email", password: "short" }));
    expect(err.code).toBe("invalid");
    expect(Object.keys(err.fields ?? {}).sort()).toEqual(["email", "orgName", "password"]);

    for (const junk of [undefined, null, "string", 7, [], { orgName: {}, name: [], email: {}, password: 12345678 }]) {
      const e = await failure(() => signUp(junk as never));
      expect(e.code).toBe("invalid");
      expect(Object.keys(e.fields ?? {}).sort()).toEqual(["email", "name", "orgName", "password"]);
    }
  });

  it("enforces name and password length limits", async () => {
    const base = { orgName: "Limits Co", name: "Lee", email: uniqueEmail(), password: PASSWORD };
    expect((await failure(() => signUp({ ...base, password: "1234567" }))).fields?.password).toMatch(/at least 8/);
    expect((await failure(() => signUp({ ...base, password: "x".repeat(201) }))).fields?.password).toMatch(/200/);
    expect((await failure(() => signUp({ ...base, name: "n".repeat(101) }))).fields?.name).toMatch(/100/);
    expect((await failure(() => signUp({ ...base, orgName: "o".repeat(101) }))).fields?.orgName).toMatch(/100/);
    const ok = await signUp({ ...base, password: "x".repeat(200), name: "n".repeat(100) });
    expect(ok.user.name).toHaveLength(100);
  });

  it("limits how many companies one network address can create", async () => {
    const meta = { ip: "203.0.113.77" };
    for (let i = 0; i < 10; i++) await signUp({ orgName: "Bulk", name: "B", email: uniqueEmail("bulk"), password: PASSWORD }, meta);
    const err = await failure(() => signUp({ orgName: "Bulk", name: "B", email: uniqueEmail("bulk"), password: PASSWORD }, meta));
    expect(err.code).toBe("rate_limited");
    expect(err.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------

describe("logIn", () => {
  it("signs in with the right password, ignoring email case and spacing", async () => {
    const { owner } = await newOrg();
    const user = await logIn({ email: `  ${owner.email.toUpperCase()}  `, password: PASSWORD });
    expect(user.id).toBe(owner.id);
  });

  it("gives the same answer for an unknown email and a wrong password", async () => {
    const { owner } = await newOrg();
    const wrong = await failure(() => logIn({ email: owner.email, password: "wrong password" }));
    const unknown = await failure(() => logIn({ email: uniqueEmail("ghost"), password: "wrong password" }));
    const tooLong = await failure(() => logIn({ email: owner.email, password: "p".repeat(5000) }));
    expect(wrong.code).toBe("invalid");
    expect(unknown.code).toBe(wrong.code);
    expect(unknown.message).toBe(wrong.message);
    expect(unknown.fields).toEqual(wrong.fields);
    expect(tooLong.message).toBe(wrong.message);
  });

  it("asks for missing values without touching the limiter", async () => {
    expect((await failure(() => logIn({ email: "", password: "" }))).fields).toHaveProperty("email");
    expect((await failure(() => logIn({ email: "a@example.com", password: 12345678 as unknown }))).fields).toHaveProperty("password");
    expect((await failure(() => logIn(null as never))).code).toBe("invalid");
  });

  it("rejects a disabled account, but only once the password is right", async () => {
    const { actor } = await newOrg();
    const member = await addMember(actor, "member");
    await setMemberDisabled(actor, member.id, true);
    const right = await failure(() => logIn({ email: member.email, password: PASSWORD }));
    expect(right.code).toBe("forbidden");
    expect(right.message).toMatch(/turned off/);
    const wrong = await failure(() => logIn({ email: member.email, password: "not the password" }));
    expect(wrong.code).toBe("invalid");

    await setMemberDisabled(actor, member.id, false);
    expect((await logIn({ email: member.email, password: PASSWORD })).id).toBe(member.id);
  });

  it("stops one network guessing at an email after ten tries, even with the right password, then recovers", async () => {
    const { owner } = await newOrg();
    const meta = { ip: "203.0.113.40" };
    for (let i = 0; i < 10; i++) expect((await failure(() => logIn({ email: owner.email, password: "nope nope" }, meta))).code).toBe("invalid");
    const locked = await failure(() => logIn({ email: owner.email, password: PASSWORD }, meta));
    expect(locked.code).toBe("rate_limited");
    expect(locked.message).toMatch(/from your network\. Try again in \d+ minutes?, or reset your password/);

    const db = await getDb();
    const windows = (await db.select().from(rateLimits)).filter((r) => r.key.startsWith("login:src:") && r.key.endsWith(":203.0.113.40"));
    expect(windows).toHaveLength(1);
    // The stored key never spells out the address being guessed at.
    expect(windows[0].key).not.toContain(owner.email);
    await db.update(rateLimits).set({ resetAt: new Date(Date.now() - 1000) }).where(eq(rateLimits.key, windows[0].key));
    expect((await logIn({ email: owner.email, password: PASSWORD }, meta)).id).toBe(owner.id);
  });

  it("cannot be used to lock someone else out: wrong guesses from other networks do not block the right password", async () => {
    const { owner } = await newOrg();
    // One guess from each of ten addresses, then a whole run from each of three more.
    for (let i = 0; i < 10; i++) await failure(() => logIn({ email: owner.email, password: "nope nope" }, { ip: `198.51.100.${100 + i}` }));
    for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) {
      for (let i = 0; i < 12; i++) await failure(() => logIn({ email: owner.email, password: "nope nope" }, { ip }));
    }
    expect((await logIn({ email: owner.email, password: PASSWORD }, { ip: "203.0.113.77" })).id).toBe(owner.id);
    // The attacking address itself stays blocked, right password or not.
    expect((await failure(() => logIn({ email: owner.email, password: PASSWORD }, { ip: "192.0.2.1" }))).code).toBe("rate_limited");
    expect(sent).toHaveLength(0);
  });

  it("treats odd network values as one source each without throwing", async () => {
    const { owner } = await newOrg();
    for (const ip of ["", "   ", null, "x".repeat(5000), "2001:DB8::1", "%_'; drop table rate_limits; --"]) {
      expect((await logIn({ email: owner.email, password: PASSWORD }, { ip })).id).toBe(owner.id);
    }
  });

  it("emails the account holder once when failures pile up across networks, without locking the account", async () => {
    const { owner } = await newOrg();
    const db = await getDb();
    // Stand in for 100 earlier failures from many networks rather than hashing 100 passwords.
    await db.insert(rateLimits).values({ key: `login:email:${owner.email}`, count: 100, resetAt: new Date(Date.now() + 3_600_000) });
    await failure(() => logIn({ email: owner.email, password: "nope nope" }, { ip: "192.0.2.50" }));
    await failure(() => logIn({ email: owner.email, password: "nope nope" }, { ip: "192.0.2.51" }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "sign_in_alert", to: owner.email });
    expect(sent[0].text).toContain("/forgot-password");
    expect((await logIn({ email: owner.email, password: PASSWORD }, { ip: "192.0.2.52" })).id).toBe(owner.id);

    // Nobody is emailed about an address with no account, and a broken provider changes nothing.
    const ghost = uniqueEmail("ghost");
    await db.insert(rateLimits).values({ key: `login:email:${ghost}`, count: 100, resetAt: new Date(Date.now() + 3_600_000) });
    const unknown = await failure(() => logIn({ email: ghost, password: "nope nope" }));
    expect(unknown.code).toBe("invalid");
    expect(sent).toHaveLength(1);

    const other = await newOrg();
    emailBehaviour = "throw";
    await db.insert(rateLimits).values({ key: `login:email:${other.owner.email}`, count: 100, resetAt: new Date(Date.now() + 3_600_000) });
    expect((await failure(() => logIn({ email: other.owner.email, password: "nope nope" }))).code).toBe("invalid");
  });

  it("forgets earlier failures after a successful sign-in", async () => {
    const { owner } = await newOrg();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 8; i++) await failure(() => logIn({ email: owner.email, password: "nope nope" }));
      expect((await logIn({ email: owner.email, password: PASSWORD })).id).toBe(owner.id);
    }
  });

  it("limits attempts per network address across different emails", async () => {
    const meta = { ip: "198.51.100.9" };
    for (let i = 0; i < 50; i++) await failure(() => logIn({ email: uniqueEmail("spray"), password: "guess" }, meta));
    const { owner } = await newOrg();
    const err = await failure(() => logIn({ email: owner.email, password: PASSWORD }, meta));
    expect(err.code).toBe("rate_limited");
    // Another address is unaffected.
    expect((await logIn({ email: owner.email, password: PASSWORD }, { ip: "198.51.100.10" })).id).toBe(owner.id);
  });
});

// ---------------------------------------------------------------------------

describe("password reset", () => {
  it("resolves the same way for unknown, malformed and disabled accounts, sending nothing", async () => {
    const { actor } = await newOrg();
    const member = await addMember(actor, "member");
    await setMemberDisabled(actor, member.id, true);
    sent.length = 0;
    for (const input of [uniqueEmail("nobody"), "not an email", "", undefined, null, 42, {}, member.email]) {
      await expect(requestPasswordReset(input)).resolves.toBeUndefined();
    }
    expect(sent).toHaveLength(0);
    const db = await getDb();
    expect(await db.select().from(authTokens).where(eq(authTokens.kind, "password_reset"))).toHaveLength(0);
  });

  it("resolves quietly even when the email provider throws", async () => {
    const { owner } = await newOrg();
    emailBehaviour = "throw";
    await expect(requestPasswordReset(owner.email)).resolves.toBeUndefined();
  });

  it("emails a single-use link, stores only its hash, and ends every session on use", async () => {
    const { owner } = await newOrg();
    await startFakeSession(owner.id);
    await startFakeSession(owner.id);

    await requestPasswordReset(`  ${owner.email.toUpperCase()} `);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "password_reset", to: owner.email, orgId: owner.orgId });
    const token = tokenFrom(sent[0].text);
    expect(token).toMatch(/^[0-9a-z]{32}$/);
    expect(sent[0].text).toContain("/reset-password/");

    const db = await getDb();
    const [row] = await db.select().from(authTokens).where(and(eq(authTokens.userId, owner.id), eq(authTokens.kind, "password_reset")));
    expect(row.id).toBe(sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const lifetime = row.expiresAt.getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(59 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(60 * 60_000);

    expect(await isPasswordResetTokenValid(token)).toBe(true);
    // A password that is too short does not use the link up.
    expect((await failure(() => resetPassword(token, "short"))).fields).toHaveProperty("password");
    expect(await isPasswordResetTokenValid(token)).toBe(true);

    const user = await resetPassword(token, "a brand new password");
    expect(user.id).toBe(owner.id);
    expect(await sessionCount(owner.id)).toBe(0);
    expect((await logIn({ email: owner.email, password: "a brand new password" })).id).toBe(owner.id);
    expect((await failure(() => logIn({ email: owner.email, password: PASSWORD }))).code).toBe("invalid");

    expect(await isPasswordResetTokenValid(token)).toBe(false);
    const again = await failure(() => resetPassword(token, "yet another password"));
    expect(again.code).toBe("gone");
    expect((await logIn({ email: owner.email, password: "a brand new password" })).id).toBe(owner.id);
  });

  it("accepts only one of two simultaneous uses of the same link", async () => {
    const { owner } = await newOrg();
    await requestPasswordReset(owner.email);
    const token = tokenFrom(sent[0].text);
    const results = await Promise.allSettled([resetPassword(token, "first new password"), resetPassword(token, "second new password")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason.code).toBe("gone");
  });

  it("rejects expired, replaced, malformed and wrong-kind tokens", async () => {
    const { owner, actor } = await newOrg();
    await requestPasswordReset(owner.email);
    const first = tokenFrom(sent[0].text);
    await requestPasswordReset(owner.email);
    const second = tokenFrom(sent[1].text);
    expect(second).not.toBe(first);
    // Requesting again retires the earlier link.
    expect((await failure(() => resetPassword(first, "a brand new password"))).code).toBe("gone");

    const db = await getDb();
    await db.update(authTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(authTokens.id, sha256Hex(second)));
    expect((await failure(() => resetPassword(second, "a brand new password"))).code).toBe("gone");

    for (const junk of ["", "x", "a".repeat(32), "A".repeat(32), "'; drop table users; --", undefined, null, 5, {}]) {
      expect((await failure(() => resetPassword(junk, "a brand new password"))).code).toBe("gone");
    }
    // An invite link is not a reset link.
    const { url } = await inviteMember(actor, { email: uniqueEmail("kind"), role: "member" });
    expect((await failure(() => resetPassword(tokenFrom(url), "a brand new password"))).code).toBe("gone");
    expect((await logIn({ email: owner.email, password: PASSWORD })).id).toBe(owner.id);
  });

  it("stops sending after three requests an hour for one email, still without saying so", async () => {
    const { owner } = await newOrg();
    for (let i = 0; i < 6; i++) await expect(requestPasswordReset(owner.email)).resolves.toBeUndefined();
    expect(sent).toHaveLength(3);
  });

  it("lets someone locked out by failed sign-ins back in after a reset, from every network", async () => {
    const { owner } = await newOrg();
    const sources = [undefined, { ip: "203.0.113.60" }, { ip: "203.0.113.61" }];
    for (const meta of sources) {
      for (let i = 0; i < 11; i++) await failure(() => logIn({ email: owner.email, password: "nope nope" }, meta));
      expect((await failure(() => logIn({ email: owner.email, password: PASSWORD }, meta))).code).toBe("rate_limited");
    }
    // Someone else's counters are not swept up with them.
    const bystander = await newOrg();
    for (let i = 0; i < 11; i++) await failure(() => logIn({ email: bystander.owner.email, password: "nope nope" }));

    await requestPasswordReset(owner.email);
    await resetPassword(tokenFrom(sent[0].text), "a brand new password");
    for (const meta of sources) expect((await logIn({ email: owner.email, password: "a brand new password" }, meta)).id).toBe(owner.id);
    expect((await failure(() => logIn({ email: bystander.owner.email, password: PASSWORD }))).code).toBe("rate_limited");
  });
});

// ---------------------------------------------------------------------------

describe("invitations", () => {
  it("invites by email, and the invited person joins with the chosen role", async () => {
    const { actor, org, owner } = await newOrg("Invite Co");
    const email = uniqueEmail("invitee");
    const result = await inviteMember(actor, { email: ` ${email.toUpperCase()} `, role: "admin" });
    expect(result.emailStatus).toBe("sent");
    expect(result.invite).toMatchObject({ email, role: "admin", expired: false });
    expect(result.url).toContain("/invite/");
    expect(sent[0]).toMatchObject({ kind: "invite", to: email, orgId: org.id });
    expect(sent[0].subject).toContain(owner.name);
    const days = (result.invite.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);

    const token = tokenFrom(result.url);
    const db = await getDb();
    const [row] = await db.select().from(authTokens).where(eq(authTokens.email, email));
    expect(row.id).toBe(sha256Hex(token));
    expect(result.invite.id).not.toBe(token);

    expect(await getInvite(token)).toMatchObject({ email, role: "admin", orgId: org.id, orgName: "Invite Co" });
    const joined = await acceptInvite(token, { name: "  Ivy   Invitee ", password: PASSWORD });
    expect(joined.user).toMatchObject({ email, name: "Ivy Invitee", role: "admin", orgId: org.id });
    expect(joined.org.id).toBe(org.id);
    expect((await logIn({ email, password: PASSWORD })).id).toBe(joined.user.id);

    expect((await failure(() => getInvite(token))).code).toBe("gone");
    expect((await failure(() => acceptInvite(token, { name: "Again", password: PASSWORD }))).code).toBe("gone");
    expect(await listPendingInvites(actor)).toHaveLength(0);
    expect((await listMembers(actor)).map((m) => m.email)).toEqual([owner.email, email]);
  });

  it("is for owners and admins only", async () => {
    const { actor } = await newOrg();
    const member = await addMember(actor, "member");
    const admin = await addMember(actor, "admin");
    expect((await failure(() => inviteMember(actorOf(member), { email: uniqueEmail(), role: "member" }))).code).toBe("forbidden");
    expect((await failure(() => listPendingInvites(actorOf(member)))).code).toBe("forbidden");
    expect((await inviteMember(actorOf(admin), { email: uniqueEmail(), role: "member" })).emailStatus).toBe("sent");
    // A stale session that still claims a manager role is checked against the stored role.
    expect((await failure(() => inviteMember({ ...actorOf(member), role: "owner" } as Actor, { email: uniqueEmail(), role: "member" }))).code).toBe("forbidden");
    for (const other of [{ type: "api", orgId: actor.orgId, keyId: "key_x", label: "Key" }, { type: "system", orgId: actor.orgId, label: "System" }] as Actor[]) {
      expect((await failure(() => inviteMember(other, { email: uniqueEmail(), role: "member" }))).code).toBe("forbidden");
    }
  });

  it("validates the email and role", async () => {
    const { actor } = await newOrg();
    expect((await failure(() => inviteMember(actor, { email: "nope", role: "member" }))).fields).toHaveProperty("email");
    for (const role of ["owner", "superuser", "", undefined, null, 1]) {
      expect((await failure(() => inviteMember(actor, { email: uniqueEmail(), role }))).fields).toHaveProperty("role");
    }
    expect((await failure(() => inviteMember(actor, undefined as never))).code).toBe("invalid");
    expect(sent).toHaveLength(0);
  });

  it("replaces the earlier invite when the same person is invited again", async () => {
    const { actor } = await newOrg();
    const email = uniqueEmail("again");
    const first = await inviteMember(actor, { email, role: "member" });
    const second = await inviteMember(actor, { email, role: "admin" });
    expect((await failure(() => getInvite(tokenFrom(first.url)))).code).toBe("gone");
    expect((await getInvite(tokenFrom(second.url))).role).toBe("admin");
    const pending = await listPendingInvites(actor);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ email, role: "admin" });
  });

  it("refuses to invite someone who is already on the team", async () => {
    const a = await newOrg();
    const here = await failure(() => inviteMember(a.actor, { email: a.owner.email, role: "member" }));
    expect(here.code).toBe("conflict");
    expect(here.message).toMatch(/already on your team/);
    expect(sent).toHaveLength(0);
  });

  it("does not reveal that an address has an account with another company", async () => {
    const a = await newOrg("Asking Co");
    const b = await newOrg();
    const taken = await inviteMember(a.actor, { email: b.owner.email.toUpperCase(), role: "member" });
    const fresh = await inviteMember(a.actor, { email: uniqueEmail("fresh"), role: "member" });

    // Same shape and status either way: nothing for the inviter to tell them apart by.
    expect(Object.keys(taken).sort()).toEqual(Object.keys(fresh).sort());
    expect(taken.emailStatus).toBe(fresh.emailStatus);
    expect(taken.invite).toMatchObject({ email: b.owner.email, role: "member", expired: false });
    expect(taken.url).toMatch(/\/invite\/[^/]+$/);
    expect((await listPendingInvites(a.actor)).map((i) => i.email).sort()).toEqual([taken.invite.email, fresh.invite.email].sort());

    // The mailbox owner is told instead, without a join link they could never use.
    const toTaken = sent.find((m) => m.to === b.owner.email);
    expect(toTaken).toMatchObject({ kind: "invite", orgId: a.org.id });
    expect(toTaken?.subject).toMatch(/tried to invite you to Asking Co/);
    expect(toTaken?.text).toContain("/forgot-password");
    expect(toTaken?.text).not.toContain("/invite/");

    // The existing account is untouched and the invite can never create a second one.
    const err = await failure(() => acceptInvite(tokenFrom(taken.url), { name: "Impostor", password: PASSWORD }));
    expect(err.code).toBe("conflict");
    expect((await logIn({ email: b.owner.email, password: PASSWORD })).orgId).toBe(b.org.id);
    await revokeInvite(a.actor, taken.invite.id);

    emailBehaviour = "failed";
    const failedTaken = await inviteMember(a.actor, { email: b.owner.email, role: "admin" });
    const failedFresh = await inviteMember(a.actor, { email: uniqueEmail("fresh"), role: "admin" });
    expect({ status: failedTaken.emailStatus, error: failedTaken.emailError }).toEqual({ status: failedFresh.emailStatus, error: failedFresh.emailError });
  });

  it("counts every invite attempt against the hourly limit, including ones that are refused", async () => {
    const a = await newOrg();
    const db = await getDb();
    await db.insert(rateLimits).values({ key: `invite:org:${a.org.id}`, count: 39, resetAt: new Date(Date.now() + 3_600_000) });
    expect((await failure(() => inviteMember(a.actor, { email: a.owner.email, role: "member" }))).code).toBe("conflict");
    const limited = await failure(() => inviteMember(a.actor, { email: a.owner.email, role: "member" }));
    expect(limited.code).toBe("rate_limited");
    expect(limited.message).toMatch(/Try again in/);
  });

  it("still creates the invite and returns the link when email fails, is off, or throws", async () => {
    const { actor } = await newOrg();
    for (const behaviour of ["failed", "skipped", "throw"] as const) {
      emailBehaviour = behaviour;
      const result = await inviteMember(actor, { email: uniqueEmail(behaviour), role: "member" });
      expect(result.emailStatus).toBe(behaviour === "throw" ? "failed" : behaviour);
      if (behaviour !== "skipped") expect(result.emailError).toBeTruthy();
      expect((await getInvite(tokenFrom(result.url))).role).toBe("member");
    }
    expect(await listPendingInvites(actor)).toHaveLength(3);
  });

  it("rejects expired, revoked and malformed invite links", async () => {
    const { actor } = await newOrg();
    const expired = await inviteMember(actor, { email: uniqueEmail("exp"), role: "member" });
    const db = await getDb();
    await db.update(authTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(authTokens.id, expired.invite.id));
    expect((await failure(() => getInvite(tokenFrom(expired.url)))).code).toBe("gone");
    expect((await failure(() => acceptInvite(tokenFrom(expired.url), { name: "Late", password: PASSWORD }))).code).toBe("gone");
    const listed = await listPendingInvites(actor);
    expect(listed.find((i) => i.id === expired.invite.id)?.expired).toBe(true);

    const revoked = await inviteMember(actor, { email: uniqueEmail("rev"), role: "member" });
    await revokeInvite(actor, revoked.invite.id);
    expect((await failure(() => getInvite(tokenFrom(revoked.url)))).code).toBe("gone");
    expect((await failure(() => revokeInvite(actor, revoked.invite.id))).code).toBe("not_found");

    for (const junk of ["", "nope", "a".repeat(32), undefined, null, 9, {}]) {
      expect((await failure(() => getInvite(junk))).code).toBe("gone");
      expect((await failure(() => acceptInvite(junk, { name: "X", password: PASSWORD }))).code).toBe("gone");
    }
    for (const junk of [undefined, null, 9, {}, "", "nope"]) expect((await failure(() => revokeInvite(actor, junk))).code).toBe("not_found");
  });

  it("keeps the invite usable when the join form has mistakes", async () => {
    const { actor } = await newOrg();
    const { url } = await inviteMember(actor, { email: uniqueEmail("form"), role: "member" });
    const token = tokenFrom(url);
    const err = await failure(() => acceptInvite(token, { name: "  ", password: "short" }));
    expect(Object.keys(err.fields ?? {}).sort()).toEqual(["name", "password"]);
    expect((await failure(() => acceptInvite(token, null as never))).code).toBe("invalid");
    expect((await acceptInvite(token, { name: "Fixed", password: PASSWORD })).user.name).toBe("Fixed");
  });

  it("creates one account when the same invite is accepted twice at once", async () => {
    const { actor } = await newOrg();
    const email = uniqueEmail("double");
    const { url } = await inviteMember(actor, { email, role: "member" });
    const token = tokenFrom(url);
    const results = await Promise.allSettled([
      acceptInvite(token, { name: "One", password: PASSWORD }),
      acceptInvite(token, { name: "Two", password: PASSWORD }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const db = await getDb();
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(1);
  });

  it("does not consume the invite if the email got an account in the meantime", async () => {
    const { actor } = await newOrg();
    const email = uniqueEmail("meantime");
    const { url, invite } = await inviteMember(actor, { email, role: "member" });
    await signUp({ orgName: "Own Co", name: "Own", email, password: PASSWORD });
    const err = await failure(() => acceptInvite(tokenFrom(url), { name: "Late", password: PASSWORD }));
    expect(err.code).toBe("conflict");
    const db = await getDb();
    const [row] = await db.select().from(authTokens).where(eq(authTokens.id, invite.id));
    expect(row.usedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("roles and access", () => {
  it("lets managers change roles, but never their own", async () => {
    const { actor, owner } = await newOrg();
    const member = await addMember(actor, "member");
    const admin = await addMember(actor, "admin");

    expect((await changeMemberRole(actor, member.id, "admin")).role).toBe("admin");
    expect((await changeMemberRole(actorOf(admin), member.id, "member")).role).toBe("member");
    // No-op changes succeed quietly.
    expect((await changeMemberRole(actor, member.id, "member")).role).toBe("member");

    expect((await failure(() => changeMemberRole(actor, owner.id, "admin"))).code).toBe("forbidden");
    expect((await failure(() => changeMemberRole(actorOf(admin), admin.id, "owner"))).code).toBe("forbidden");
    expect((await failure(() => changeMemberRole(actorOf(member), admin.id, "member"))).code).toBe("forbidden");
    for (const role of ["root", "", undefined, null, 3]) {
      expect((await failure(() => changeMemberRole(actor, member.id, role))).fields).toHaveProperty("role");
    }
    for (const id of ["usr_doesnotexist0000", "", undefined, null, {}, 12]) {
      expect((await failure(() => changeMemberRole(actor, id, "admin"))).code).toBe("not_found");
    }
  });

  it("reserves owner changes for owners", async () => {
    const { actor, owner } = await newOrg();
    const admin = await addMember(actor, "admin");
    const member = await addMember(actor, "member");
    expect((await failure(() => changeMemberRole(actorOf(admin), owner.id, "member"))).code).toBe("forbidden");
    expect((await failure(() => changeMemberRole(actorOf(admin), member.id, "owner"))).code).toBe("forbidden");
    expect((await failure(() => setMemberDisabled(actorOf(admin), owner.id, true))).code).toBe("forbidden");

    // Two owners: either may demote the other, and one always remains.
    const second = await changeMemberRole(actor, admin.id, "owner");
    expect(second.role).toBe("owner");
    expect((await changeMemberRole(actorOf(second), owner.id, "admin")).role).toBe("admin");
    const members = await listMembers(actorOf(second));
    expect(members.filter((m) => m.role === "owner" && !m.disabled)).toHaveLength(1);
    // The demoted owner can no longer touch the remaining owner.
    expect((await failure(() => changeMemberRole(actor, second.id, "member"))).code).toBe("forbidden");
    expect((await failure(() => setMemberDisabled(actor, second.id, true))).code).toBe("forbidden");
  });

  it("never leaves a company without an active owner, even if the data is already odd", async () => {
    const { actor, owner } = await newOrg();
    const other = await changeMemberRole(actor, (await addMember(actor, "admin")).id, "owner");
    const db = await getDb();
    // Simulate the acting owner having been disabled by a direct database edit while
    // their session is still being used: the stored row wins.
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, owner.id));
    expect((await failure(() => changeMemberRole(actor, other.id, "member"))).code).toBe("forbidden");
    await db.update(users).set({ disabledAt: null }).where(eq(users.id, owner.id));

    // Two simultaneous demotions of each other: at most one may win.
    const results = await Promise.allSettled([changeMemberRole(actor, other.id, "admin"), changeMemberRole(actorOf(other), owner.id, "admin")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const owners = (await db.select().from(users).where(and(eq(users.orgId, owner.orgId), eq(users.role, "owner")))).filter((u) => !u.disabledAt);
    expect(owners).toHaveLength(1);
  });

  it("turns access off and on, signing the person out and never the actor themselves", async () => {
    const { actor, owner } = await newOrg();
    const member = await addMember(actor, "member");
    await startFakeSession(member.id);
    await startFakeSession(owner.id);

    expect((await failure(() => setMemberDisabled(actor, owner.id, true))).code).toBe("forbidden");
    for (const flag of ["true", 1, null, undefined]) expect((await failure(() => setMemberDisabled(actor, member.id, flag))).code).toBe("invalid");

    const off = await setMemberDisabled(actor, member.id, true);
    expect(off.disabled).toBe(true);
    expect(await sessionCount(member.id)).toBe(0);
    expect(await sessionCount(owner.id)).toBe(1);
    // A disabled person's old session cannot act.
    expect((await failure(() => updateProfile(actorOf(member), { name: "Ghost" }))).code).toBe("forbidden");
    expect((await failure(() => listMembers(actorOf(member)))).code).toBe("forbidden");
    expect((await setMemberDisabled(actor, member.id, true)).disabled).toBe(true);

    const on = await setMemberDisabled(actor, member.id, false);
    expect(on.disabled).toBe(false);
    expect((await updateProfile(actorOf(member), { name: "Back Again" })).name).toBe("Back Again");
  });

  it("leaves a disabled admin no way back in: their open invites and API keys stop working", async () => {
    const { actor, org } = await newOrg();
    const admin = await addMember(actor, "admin", "Ada Admin");
    const other = await addMember(actor, "admin", "Otto Other");
    const backdoor = await inviteMember(actorOf(admin), { email: "admin-personal@elsewhere.test", role: "admin" });
    const second = await inviteMember(actorOf(admin), { email: uniqueEmail("friend"), role: "member" });
    const kept = await inviteMember(actorOf(other), { email: uniqueEmail("kept"), role: "member" });
    const theirs = await createApiKey(actorOf(admin), "Ada's script");
    const alreadyRevoked = await createApiKey(actorOf(admin), "Old script");
    const db = await getDb();
    const earlier = new Date("2026-01-01T00:00:00Z");
    await db.update(apiKeys).set({ revokedAt: earlier }).where(eq(apiKeys.id, alreadyRevoked.row.id));
    const others = await createApiKey(actorOf(other), "CRM");
    expect(await authenticateApiKey(`Bearer ${theirs.key}`)).not.toBeNull();

    const off = await setMemberDisabled(actor, admin.id, true, { ip: "203.0.113.5" });
    expect(off.disabled).toBe(true);
    expect(off.cancelledInvites.sort()).toEqual([backdoor.invite.email, second.invite.email].sort());
    expect(off.revokedApiKeys).toEqual([{ id: theirs.row.id, name: "Ada's script" }]);

    expect(await authenticateApiKey(`Bearer ${theirs.key}`)).toBeNull();
    expect(await authenticateApiKey(`Bearer ${others.key}`)).not.toBeNull();
    const keys = await listApiKeys(actor);
    expect(keys.find((k) => k.id === alreadyRevoked.row.id)?.revokedAt).toEqual(earlier);

    for (const url of [backdoor.url, second.url]) {
      expect((await failure(() => getInvite(tokenFrom(url)))).code).toBe("gone");
      expect((await failure(() => acceptInvite(tokenFrom(url), { name: "Ada Again", password: PASSWORD }))).code).toBe("gone");
    }
    expect((await listMembers(actor)).map((m) => m.email)).not.toContain("admin-personal@elsewhere.test");
    expect((await listPendingInvites(actor)).map((i) => i.email)).toEqual([kept.invite.email]);
    expect((await getInvite(tokenFrom(kept.url))).email).toBe(kept.invite.email);

    const trail = await db.select().from(events).where(eq(events.orgId, org.id));
    const disabledEvent = trail.find((e) => e.type === "member.disabled");
    expect(disabledEvent?.data).toMatchObject({
      userId: admin.id,
      revokedKeys: [{ id: theirs.row.id, name: "Ada's script" }],
    });
    expect((disabledEvent?.data as { cancelledInvites: string[] }).cancelledInvites).toHaveLength(2);
    const keyEvents = trail.filter((e) => e.type === "api_key.revoked");
    expect(keyEvents).toHaveLength(1);
    expect(keyEvents[0].data).toMatchObject({ keyId: theirs.row.id, reason: "creator_disabled" });
    expect(JSON.stringify(trail)).not.toContain(theirs.key);

    // Turning the account back on restores the sign-in, not what was cancelled.
    const on = await setMemberDisabled(actor, admin.id, false);
    expect(on).toMatchObject({ disabled: false, cancelledInvites: [], revokedApiKeys: [] });
    expect(await authenticateApiKey(`Bearer ${theirs.key}`)).toBeNull();
    expect((await failure(() => getInvite(tokenFrom(backdoor.url)))).code).toBe("gone");
  });

  it("rejects an invite whose sender has since lost the right to invite, even if the row survived", async () => {
    const { actor, org } = await newOrg();
    const admin = await addMember(actor, "admin");
    const db = await getDb();
    const plant = async (userId: string | null, orgId = org.id) => {
      const token = newSecret();
      await db.insert(authTokens).values({ id: sha256Hex(token), kind: "invite", orgId, userId, email: uniqueEmail("planted"), role: "admin", expiresAt: new Date(Date.now() + 86_400_000) });
      return token;
    };
    const join = { name: "Late Joiner", password: PASSWORD };

    // Rows left behind by a disable or demotion done directly in the database.
    const fromDisabled = await plant(admin.id);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, admin.id));
    expect((await failure(() => getInvite(fromDisabled))).code).toBe("gone");
    expect((await failure(() => acceptInvite(fromDisabled, join))).code).toBe("gone");

    await db.update(users).set({ disabledAt: null, role: "member" }).where(eq(users.id, admin.id));
    expect((await failure(() => acceptInvite(fromDisabled, join))).code).toBe("gone");

    // No sender on record, or a sender who belongs to a different company.
    const noSender = await plant(null);
    expect((await failure(() => acceptInvite(noSender, join))).code).toBe("gone");
    const elsewhere = await newOrg();
    const crossOrg = await plant(elsewhere.owner.id);
    expect((await failure(() => getInvite(crossOrg))).code).toBe("gone");
    expect((await failure(() => acceptInvite(crossOrg, join))).code).toBe("gone");

    // A refused attempt does not burn the link: it works again once the sender is a manager again.
    await db.update(users).set({ role: "admin" }).where(eq(users.id, admin.id));
    expect((await acceptInvite(fromDisabled, join)).user.role).toBe("admin");
    expect((await listMembers(actor)).filter((m) => m.name === "Late Joiner")).toHaveLength(1);
  });

  it("cancels the invites of someone demoted to member, and keeps them through other role changes", async () => {
    const { actor, org } = await newOrg();
    const admin = await addMember(actor, "admin");
    const first = await inviteMember(actorOf(admin), { email: uniqueEmail("first"), role: "admin" });

    const promoted = await changeMemberRole(actor, admin.id, "owner");
    expect(promoted.cancelledInvites).toEqual([]);
    expect((await getInvite(tokenFrom(first.url))).email).toBe(first.invite.email);
    await changeMemberRole(actor, admin.id, "admin");
    expect((await getInvite(tokenFrom(first.url))).email).toBe(first.invite.email);
    const key = await createApiKey(actorOf(admin), "Reporting");

    const demoted = await changeMemberRole(actor, admin.id, "member");
    expect(demoted).toMatchObject({ role: "member", cancelledInvites: [first.invite.email], revokedApiKeys: [] });
    expect((await failure(() => acceptInvite(tokenFrom(first.url), { name: "Friend", password: PASSWORD }))).code).toBe("gone");
    expect(await listPendingInvites(actor)).toHaveLength(0);
    // Still a colleague: the integration they set up keeps running.
    expect(await authenticateApiKey(`Bearer ${key.key}`)).not.toBeNull();

    const db = await getDb();
    const changes = (await db.select().from(events).where(eq(events.orgId, org.id))).filter((e) => e.type === "member.role_changed");
    expect(changes.map((e) => (e.data as { cancelledInvites?: string[] }).cancelledInvites)).toContainEqual([first.invite.email]);
  });

  it("stops using a disabled person as the countersigner", async () => {
    const { actor, org } = await newOrg();
    const admin = await addMember(actor, "admin");
    await saveSignature(actorOf(admin), PNG_URL);
    await updateOrg(actor, { settings: { countersignerUserId: admin.id, countersignMode: "auto" } });
    await setMemberDisabled(actor, admin.id, true);
    const settings = resolveSettings(await reloadOrg(org.id));
    expect(settings.countersignerUserId).toBeUndefined();
    expect(settings.countersignMode).toBe("manual");
  });

  it("transfers ownership in one step", async () => {
    const { actor, owner } = await newOrg();
    const admin = await addMember(actor, "admin");
    const member = await addMember(actor, "member");
    expect((await failure(() => transferOwnership(actorOf(admin), member.id))).code).toBe("forbidden");
    expect((await failure(() => transferOwnership(actor, owner.id))).code).toBe("invalid");
    expect((await failure(() => transferOwnership(actor, "usr_missing000000000"))).code).toBe("not_found");
    await setMemberDisabled(actor, member.id, true);
    expect((await failure(() => transferOwnership(actor, member.id))).code).toBe("conflict");
    expect((await failure(() => changeMemberRole(actor, member.id, "owner"))).code).toBe("conflict");

    const result = await transferOwnership(actor, admin.id);
    expect(result.newOwner).toMatchObject({ id: admin.id, role: "owner" });
    expect(result.previousOwner).toMatchObject({ id: owner.id, role: "admin" });
    expect((await failure(() => transferOwnership(actor, member.id))).code).toBe("forbidden");
  });

  it("records team changes in the audit trail without secrets", async () => {
    const { actor, org } = await newOrg();
    const member = await addMember(actor, "member");
    await changeMemberRole(actor, member.id, "admin", { ip: "203.0.113.5", userAgent: "UA" + String.fromCharCode(0) + "x" });
    await setMemberDisabled(actor, member.id, true);
    const db = await getDb();
    const rows = await db.select().from(events).where(eq(events.orgId, org.id));
    const types = rows.map((r) => r.type);
    for (const type of ["org.created", "member.invited", "member.joined", "member.role_changed", "member.disabled"]) expect(types).toContain(type);
    const change = rows.find((r) => r.type === "member.role_changed");
    expect(change?.data).toMatchObject({ userId: member.id, from: "member", to: "admin" });
    expect(change?.ip).toBe("203.0.113.5");
    expect(JSON.stringify(rows)).not.toContain("scrypt$");
  });
});

// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  it("treats another company's people and invites as if they did not exist", async () => {
    const a = await newOrg("Tenant A");
    const b = await newOrg("Tenant B");
    const bMember = await addMember(b.actor, "member");
    const bInvite = await inviteMember(b.actor, { email: uniqueEmail("b-invite"), role: "member" });

    expect((await failure(() => changeMemberRole(a.actor, bMember.id, "admin"))).code).toBe("not_found");
    expect((await failure(() => setMemberDisabled(a.actor, bMember.id, true))).code).toBe("not_found");
    expect((await failure(() => setMemberDisabled(a.actor, b.owner.id, true))).code).toBe("not_found");
    expect((await failure(() => transferOwnership(a.actor, bMember.id))).code).toBe("not_found");
    expect((await failure(() => revokeInvite(a.actor, bInvite.invite.id))).code).toBe("not_found");
    expect((await failure(() => updateOrg(a.actor, { settings: { countersignerUserId: bMember.id } }))).fields).toHaveProperty("countersignerUserId");

    expect((await listMembers(a.actor)).map((m) => m.id)).toEqual([a.owner.id]);
    expect(await listPendingInvites(a.actor)).toHaveLength(0);
    expect((await listMembers(b.actor)).map((m) => m.id).sort()).toEqual([b.owner.id, bMember.id].sort());
    expect(await listPendingInvites(b.actor)).toHaveLength(1);

    // Nothing in B changed.
    const db = await getDb();
    const [row] = await db.select().from(users).where(eq(users.id, bMember.id));
    expect(row).toMatchObject({ role: "member", disabledAt: null });
    expect((await getInvite(tokenFrom(bInvite.url))).orgId).toBe(b.org.id);
  });

  it("rejects an actor whose user does not belong to the org it claims", async () => {
    const a = await newOrg();
    const b = await newOrg();
    const forged: Actor = { ...a.actor, orgId: b.org.id } as Actor;
    expect((await failure(() => listMembers(forged))).code).toBe("forbidden");
    expect((await failure(() => inviteMember(forged, { email: uniqueEmail(), role: "admin" }))).code).toBe("forbidden");
    expect((await failure(() => updateOrg(forged, { name: "Hijacked" }))).code).toBe("forbidden");
    expect((await failure(() => changeMemberRole(forged, b.owner.id, "member"))).code).toBe("forbidden");
    expect((await failure(() => updateProfile(forged, { name: "Hijacked" }))).code).toBe("forbidden");
    expect((await failure(() => saveSignature(forged, PNG_URL))).code).toBe("forbidden");
    expect((await failure(() => updateOrg({ ...a.actor, orgId: "org_doesnotexist000" } as Actor, { name: "X" }))).code).toBe("not_found");
    expect((await reloadOrg(b.org.id)).name).toBe(b.org.name);
  });

  it("scopes list calls for API and system actors to their org", async () => {
    const a = await newOrg();
    const b = await newOrg();
    const list = await listMembers({ type: "api", orgId: a.org.id, keyId: "key_test", label: "Key" });
    expect(list.map((m) => m.id)).toEqual([a.owner.id]);
    expect(list.some((m) => m.id === b.owner.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("profile", () => {
  it("updates name and title, leaving unspecified fields alone", async () => {
    const { actor } = await newOrg();
    expect(await updateProfile(actor, { name: "  New   Name ", title: " Managing  Partner " })).toMatchObject({ name: "New Name", title: "Managing Partner" });
    expect(await updateProfile(actor, { title: "" })).toMatchObject({ name: "New Name", title: null });
    expect(await updateProfile(actor, {})).toMatchObject({ name: "New Name" });
    expect(await updateProfile(actor, null as never)).toMatchObject({ name: "New Name" });
    expect((await failure(() => updateProfile(actor, { name: "   " }))).fields).toHaveProperty("name");
    expect((await failure(() => updateProfile(actor, { name: {} }))).fields).toHaveProperty("name");
    expect((await failure(() => updateProfile(actor, { title: "t".repeat(101) }))).fields).toHaveProperty("title");
    expect((await failure(() => updateProfile({ type: "system", orgId: actor.orgId, label: "System" }, { name: "X" }))).code).toBe("forbidden");
  });

  it("changes the password only with the current one, and ends every session", async () => {
    const { actor, owner } = await newOrg();
    await startFakeSession(owner.id);
    await startFakeSession(owner.id);

    const wrong = await failure(() => changePassword(actor, "not my password", "a brand new password"));
    expect(wrong.fields).toHaveProperty("current");
    expect((await failure(() => changePassword(actor, PASSWORD, "short"))).fields).toHaveProperty("next");
    expect((await failure(() => changePassword(actor, PASSWORD, PASSWORD))).fields).toHaveProperty("next");
    expect((await failure(() => changePassword(actor, undefined, undefined))).fields).toMatchObject({ current: expect.any(String), next: expect.any(String) });
    expect(await sessionCount(owner.id)).toBe(2);

    await requestPasswordReset(owner.email);
    const staleReset = tokenFrom(sent[0].text);

    const user = await changePassword(actor, PASSWORD, "a brand new password");
    expect(user.id).toBe(owner.id);
    expect(await sessionCount(owner.id)).toBe(0);
    expect((await logIn({ email: owner.email, password: "a brand new password" })).id).toBe(owner.id);
    expect((await failure(() => logIn({ email: owner.email, password: PASSWORD }))).code).toBe("invalid");
    // A reset link issued before the change no longer works.
    expect((await failure(() => resetPassword(staleReset, "sneaky new password"))).code).toBe("gone");
  });

  it("limits guesses at the current password", async () => {
    const { actor } = await newOrg();
    for (let i = 0; i < 10; i++) expect((await failure(() => changePassword(actor, "guess number " + i, "a brand new password"))).code).toBe("invalid");
    expect((await failure(() => changePassword(actor, PASSWORD, "a brand new password"))).code).toBe("rate_limited");
  });

  it("saves a PNG signature and refuses everything else", async () => {
    const { actor } = await newOrg();
    expect((await saveSignature(actor, PNG_URL)).hasSignature).toBe(true);
    expect(await getOwnSignature(actor)).toBe(PNG_URL);

    const svg = `data:image/svg+xml;base64,${Buffer.from("<svg onload='alert(1)'/>").toString("base64")}`;
    const fakePng = `data:image/png;base64,${Buffer.from("<svg onload='alert(1)'/>").toString("base64")}`;
    const big = Buffer.concat([PNG, Buffer.alloc(LIMITS.maxSignatureBytes)]);
    const cases: [unknown, RegExp][] = [
      [svg, /must be a PNG/],
      [JPEG_URL, /must be a PNG/],
      [fakePng, /could not be read/],
      [`data:image/png;base64,${big.toString("base64")}`, /larger than 300 KB/],
      ["data:image/png;base64,", /could not be read/],
      ["hello", /must be a PNG/],
      ["", /must be a PNG/],
      [undefined, /must be a PNG/],
      [null, /must be a PNG/],
      [{ dataUrl: PNG_URL }, /must be a PNG/],
      ["x".repeat(3_000_000), /must be a PNG/],
    ];
    for (const [input, message] of cases) {
      const err = await failure(() => saveSignature(actor, input));
      expect(err.code).toBe("invalid");
      expect(err.fields?.signature).toMatch(message);
    }
    // Failed attempts leave the saved signature untouched.
    expect(await getOwnSignature(actor)).toBe(PNG_URL);

    // Exactly at the limit is accepted.
    const atLimit = Buffer.concat([PNG, Buffer.alloc(LIMITS.maxSignatureBytes - PNG.length)]);
    expect((await saveSignature(actor, `data:image/png;base64,${atLimit.toString("base64")}`)).hasSignature).toBe(true);

    expect((await clearSignature(actor)).hasSignature).toBe(false);
    expect(await getOwnSignature(actor)).toBeNull();
  });

  it("falls back to manual countersigning when the auto countersigner clears their signature", async () => {
    const { actor, owner, org } = await newOrg();
    await saveSignature(actor, PNG_URL);
    await updateOrg(actor, { settings: { countersignerUserId: owner.id, countersignMode: "auto" } });
    await clearSignature(actor);
    const settings = resolveSettings(await reloadOrg(org.id));
    expect(settings.countersignMode).toBe("manual");
    expect(settings.countersignerUserId).toBe(owner.id);
  });
});

// ---------------------------------------------------------------------------

describe("company settings", () => {
  it("fills in defaults for anything not set", () => {
    expect(resolveSettings({ settings: {} })).toEqual({
      brandColor: "#1f3a5f",
      reminderEveryDays: 2,
      maxReminders: 5,
      expireAfterDays: 30,
      autoSendOnFileCreate: true,
      countersignMode: "manual",
      fileReferencePrefix: "F",
    });
    const custom = resolveSettings({ settings: { reminderEveryDays: 0, autoSendOnFileCreate: false, replyToEmail: "a@example.com" } });
    // Falsy values that were chosen on purpose are kept.
    expect(custom.reminderEveryDays).toBe(0);
    expect(custom.autoSendOnFileCreate).toBe(false);
    expect(custom.replyToEmail).toBe("a@example.com");
    expect(custom.maxReminders).toBe(5);
    for (const odd of [null, undefined, {}, { settings: null }, { settings: undefined }, { settings: [] as never }, { settings: { brandColor: null, maxReminders: undefined } as never }]) {
      expect(resolveSettings(odd).brandColor).toBe("#1f3a5f");
      expect(resolveSettings(odd).maxReminders).toBe(5);
    }
  });

  it("is managed by owners and admins only", async () => {
    const { actor, org } = await newOrg();
    const member = await addMember(actor, "member");
    const admin = await addMember(actor, "admin");
    expect((await failure(() => updateOrg(actorOf(member), { name: "Nope" }))).code).toBe("forbidden");
    // Permission is reported before validation detail.
    expect((await failure(() => updateOrg(actorOf(member), { settings: { brandColor: "bad" } }))).code).toBe("forbidden");
    expect((await updateOrg(actorOf(admin), { name: "  Renamed   Co " })).name).toBe("Renamed Co");
    // The slug is an identifier and stays put.
    expect((await reloadOrg(org.id)).slug).toBe(org.slug);
  });

  it("saves a full valid set, normalizing values and accepting form strings", async () => {
    const { actor, owner } = await newOrg();
    await saveSignature(actor, PNG_URL);
    const updated = await updateOrg(actor, {
      name: "Harbour Legal",
      legalName: " Harbour  Legal LLP ",
      settings: {
        brandColor: "#ABC",
        logo: PNG_URL,
        replyToEmail: " Office@Example.com ",
        reminderEveryDays: "3",
        maxReminders: 0,
        expireAfterDays: "365",
        autoSendOnFileCreate: "false",
        countersignerUserId: owner.id,
        countersignMode: "auto",
        fileReferencePrefix: " HL-2 ",
        emailMessage: "  Welcome.\r\n\r\n\r\n\r\nPlease   sign.  ",
      },
    });
    expect(updated.name).toBe("Harbour Legal");
    expect(updated.legalName).toBe("Harbour Legal LLP");
    expect(updated.settings).toEqual({
      brandColor: "#aabbcc",
      logo: PNG_URL,
      replyToEmail: "office@example.com",
      reminderEveryDays: 3,
      maxReminders: 0,
      expireAfterDays: 365,
      autoSendOnFileCreate: false,
      countersignerUserId: owner.id,
      countersignMode: "auto",
      fileReferencePrefix: "HL-2",
      emailMessage: "Welcome.\n\nPlease sign.",
    });
    expect((await updateOrg(actor, { settings: { logo: JPEG_URL } })).settings.logo).toBe(JPEG_URL);
  });

  it("changes only the keys supplied, and null or blank restores the default", async () => {
    const { actor, org } = await newOrg();
    await updateOrg(actor, { legalName: "Legal Name Ltd", settings: { brandColor: "#112233", maxReminders: 9, emailMessage: "Hi" } });
    const next = await updateOrg(actor, { settings: { maxReminders: null, emailMessage: "   ", reminderEveryDays: 7 } });
    expect(next.settings).toEqual({ brandColor: "#112233", reminderEveryDays: 7 });
    expect(next.legalName).toBe("Legal Name Ltd");
    expect(next.name).toBe(org.name);
    expect(resolveSettings(next).maxReminders).toBe(5);
    expect((await updateOrg(actor, { legalName: "" })).legalName).toBeNull();
    expect((await updateOrg(actor, {})).settings).toEqual(next.settings);
    expect((await updateOrg(actor, null as never)).settings).toEqual(next.settings);
    expect((await updateOrg(actor, { settings: null })).settings).toEqual(next.settings);
  });

  it("rejects every kind of bad value with a message per setting, saving nothing", async () => {
    const { actor, org } = await newOrg();
    const svg = `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}`;
    const bigLogo = `data:image/png;base64,${Buffer.concat([PNG, Buffer.alloc(200 * 1024)]).toString("base64")}`;
    const bad: [string, unknown][] = [
      ["brandColor", "blue"],
      ["brandColor", "#12345"],
      ["brandColor", "#fff;background:url(//evil.example)"],
      ["brandColor", 255],
      ["logo", svg],
      ["logo", bigLogo],
      ["logo", "https://example.com/logo.png"],
      ["logo", `data:image/png;base64,${Buffer.from("<svg/>").toString("base64")}`],
      ["logo", 12],
      ["replyToEmail", "not-an-email"],
      ["replyToEmail", "a@example.com\nBcc: x@example.org"],
      ["replyToEmail", ["a@example.com"]],
      ["reminderEveryDays", 31],
      ["reminderEveryDays", -1],
      ["reminderEveryDays", 1.5],
      ["reminderEveryDays", "soon"],
      ["reminderEveryDays", Number.NaN],
      ["reminderEveryDays", true],
      ["maxReminders", 21],
      ["maxReminders", "1e1"],
      ["maxReminders", Number.POSITIVE_INFINITY],
      ["expireAfterDays", 366],
      ["expireAfterDays", "-5"],
      ["expireAfterDays", {}],
      ["autoSendOnFileCreate", "maybe"],
      ["autoSendOnFileCreate", 2],
      ["countersignMode", "automatic"],
      ["countersignMode", true],
      ["countersignerUserId", "usr_doesnotexist0000"],
      ["countersignerUserId", 5],
      ["countersignerUserId", "x".repeat(500)],
      ["fileReferencePrefix", "has space"],
      ["fileReferencePrefix", "-F"],
      ["fileReferencePrefix", "ABCDEFGHIJK"],
      ["fileReferencePrefix", "F/../x"],
      ["emailMessage", "m".repeat(2001)],
      ["emailMessage", 12],
      ["notASetting", "x"],
      ["__proto__x", "x"],
    ];
    for (const [key, value] of bad) {
      const err = await failure(() => updateOrg(actor, { settings: { [key]: value } }));
      expect(err.code, `${key}=${String(value).slice(0, 30)}`).toBe("invalid");
      expect(err.fields, `${key}=${String(value).slice(0, 30)}`).toHaveProperty(key);
      expect(err.message.length).toBeGreaterThan(10);
    }
    for (const settings of ["a string", 7, ["brandColor"], true]) {
      expect((await failure(() => updateOrg(actor, { settings: settings as never }))).fields).toHaveProperty("settings");
    }
    expect((await failure(() => updateOrg(actor, { name: "" }))).fields).toHaveProperty("name");
    expect((await failure(() => updateOrg(actor, { name: "n".repeat(101) }))).fields).toHaveProperty("name");
    expect((await failure(() => updateOrg(actor, { legalName: "n".repeat(201) }))).fields).toHaveProperty("legalName");

    // One bad key blocks the whole save, good keys included.
    const mixed = await failure(() => updateOrg(actor, { name: "Should Not Stick", settings: { maxReminders: 3, brandColor: "nope" } }));
    expect(Object.keys(mixed.fields ?? {})).toEqual(["brandColor"]);
    const after = await reloadOrg(org.id);
    expect(after.name).toBe(org.name);
    expect(after.settings).toEqual({});
  });

  it("accepts the edges of each numeric range", async () => {
    const { actor } = await newOrg();
    const low = await updateOrg(actor, { settings: { reminderEveryDays: 0, maxReminders: 0, expireAfterDays: 0 } });
    expect(low.settings).toEqual({ reminderEveryDays: 0, maxReminders: 0, expireAfterDays: 0 });
    const high = await updateOrg(actor, { settings: { reminderEveryDays: 30, maxReminders: 20, expireAfterDays: 365 } });
    expect(high.settings).toEqual({ reminderEveryDays: 30, maxReminders: 20, expireAfterDays: 365 });
    const maxMessage = await updateOrg(actor, { settings: { emailMessage: "m".repeat(2000) } });
    expect(maxMessage.settings.emailMessage).toHaveLength(2000);
  });

  it("only allows automatic countersigning with an active countersigner who has a saved signature", async () => {
    const { actor, owner } = await newOrg();
    const admin = await addMember(actor, "admin");

    expect((await failure(() => updateOrg(actor, { settings: { countersignMode: "auto" } }))).fields?.countersignMode).toMatch(/needs a countersigner/);
    const noSignature = await failure(() => updateOrg(actor, { settings: { countersignMode: "auto", countersignerUserId: admin.id } }));
    expect(noSignature.fields?.countersignMode).toMatch(/saved signature/);

    // Manual mode needs no signature.
    expect((await updateOrg(actor, { settings: { countersignerUserId: admin.id } })).settings.countersignerUserId).toBe(admin.id);
    // Switching to auto later is checked against the countersigner already stored.
    expect((await failure(() => updateOrg(actor, { settings: { countersignMode: "auto" } }))).fields).toHaveProperty("countersignMode");
    await saveSignature(actorOf(admin), PNG_URL);
    expect((await updateOrg(actor, { settings: { countersignMode: "auto" } })).settings.countersignMode).toBe("auto");

    // Swapping to a countersigner without a signature, or removing them, is refused while auto is on.
    expect((await failure(() => updateOrg(actor, { settings: { countersignerUserId: owner.id } }))).fields).toHaveProperty("countersignMode");
    expect((await failure(() => updateOrg(actor, { settings: { countersignerUserId: null } }))).fields).toHaveProperty("countersignMode");
    expect((await updateOrg(actor, { settings: { countersignerUserId: null, countersignMode: "manual" } })).settings).toEqual({ countersignMode: "manual" });

    const member = await addMember(actor, "member");
    await setMemberDisabled(actor, member.id, true);
    expect((await failure(() => updateOrg(actor, { settings: { countersignerUserId: member.id } }))).fields?.countersignerUserId).toMatch(/active member/);
  });
});

// ---------------------------------------------------------------------------

import { verifyEmail, resendVerification, getEmailSendingStatus, externalEmailHold, verifyEmailUrl, EMAIL_UNVERIFIED_REASON, ACCOUNT_LIMITS } from "@/lib/services/accounts";

describe("email verification", () => {
  it("sign-up starts unverified and emails a single-use 48 hour link, storing only its hash", async () => {
    const email = uniqueEmail("founder");
    const { user, org, verificationEmail } = await signUp({ orgName: "Verify Co", name: "Fran Founder", email, password: PASSWORD });
    expect(user.emailVerified).toBe(false);
    expect(verificationEmail).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "verify_email", to: email, orgId: org.id });
    const token = tokenFrom(sent[0].text);
    expect(token).toMatch(/^[0-9a-z]{32}$/);
    expect(sent[0].text).toBe(verifyEmailUrl(token));
    expect(sent[0].text).toContain("/verify-email/");

    const db = await getDb();
    const [row] = await db.select().from(authTokens).where(and(eq(authTokens.userId, user.id), eq(authTokens.kind, "email_verify")));
    expect(row.id).toBe(sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const hours = (row.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(ACCOUNT_LIMITS.verifyEmailHours - 0.1);
    expect(hours).toBeLessThanOrEqual(ACCOUNT_LIMITS.verifyEmailHours);

    const verified = await verifyEmail(token, { ip: "203.0.113.7" });
    expect(verified).toMatchObject({ alreadyVerified: false, user: { id: user.id, emailVerified: true } });
    const [stored] = await db.select().from(users).where(eq(users.id, user.id));
    expect(stored.emailVerifiedAt).toBeInstanceOf(Date);
    const trail = await db.select().from(events).where(and(eq(events.orgId, org.id), eq(events.type, "member.email_verified")));
    expect(trail).toHaveLength(1);

    // Opening the same link again (a mail scanner, a double click) says so and changes nothing.
    expect(await verifyEmail(token)).toMatchObject({ alreadyVerified: true, user: { emailVerified: true } });
    expect(await db.select().from(events).where(and(eq(events.orgId, org.id), eq(events.type, "member.email_verified")))).toHaveLength(1);
  });

  it("still creates the account when the confirmation email fails, is off, or throws", async () => {
    for (const behaviour of ["failed", "skipped", "throw"] as const) {
      emailBehaviour = behaviour;
      const result = await signUp({ orgName: "Any Co", name: "Any", email: uniqueEmail("anyv"), password: PASSWORD });
      expect(result.verificationEmail).toBe(behaviour === "skipped" ? "skipped" : "failed");
      expect(result.user.emailVerified).toBe(false);
    }
  });

  it("verifies exactly once when the link is opened twice at the same moment", async () => {
    const { user, org } = await signUp({ orgName: "Race Verify", name: "R", email: uniqueEmail("racev"), password: PASSWORD });
    const token = tokenFrom(sent[0].text);
    const results = await Promise.all([verifyEmail(token), verifyEmail(token)]);
    expect(results.every((r) => r.user.id === user.id && r.user.emailVerified)).toBe(true);
    expect(results.filter((r) => !r.alreadyVerified)).toHaveLength(1);
    const db = await getDb();
    expect(await db.select().from(events).where(and(eq(events.orgId, org.id), eq(events.type, "member.email_verified")))).toHaveLength(1);
  });

  it("rejects expired, unknown, malformed and wrong-kind links, and a link for a disabled account", async () => {
    const db = await getDb();
    const { user } = await signUp({ orgName: "Expired Verify", name: "E", email: uniqueEmail("expv"), password: PASSWORD });
    const token = tokenFrom(sent[0].text);
    await db.update(authTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(authTokens.id, sha256Hex(token)));
    const expired = await failure(() => verifyEmail(token));
    expect(expired.code).toBe("gone");
    expect(expired.message).toMatch(/expired or was already used/);
    for (const junk of [newSecret(), "", "short", null, undefined, 42, { token }, `${token}x`]) {
      expect((await failure(() => verifyEmail(junk))).code).toBe("gone");
    }
    // A password reset link is not a confirmation link.
    sent.length = 0;
    await requestPasswordReset(user.email);
    expect((await failure(() => verifyEmail(tokenFrom(sent[0].text)))).code).toBe("gone");
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].emailVerifiedAt).toBeNull();

    const other = await signUp({ orgName: "Off Verify", name: "O", email: uniqueEmail("offv"), password: PASSWORD });
    const offToken = tokenFrom(sent.at(-1)!.text);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, other.user.id));
    expect((await failure(() => verifyEmail(offToken))).code).toBe("gone");
  });

  it("sends a fresh link on request, killing the earlier one, a few times an hour at most", async () => {
    const { owner, actor } = await newOrg("Resend Co", { verified: false });
    const db = await getDb();
    const [first] = await db.select().from(authTokens).where(and(eq(authTokens.userId, owner.id), eq(authTokens.kind, "email_verify")));

    expect(await resendVerification(actor)).toEqual({ status: "sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "verify_email", to: owner.email });
    const tokens = await db.select().from(authTokens).where(and(eq(authTokens.userId, owner.id), eq(authTokens.kind, "email_verify")));
    expect(tokens).toHaveLength(1);
    expect(tokens[0].id).not.toBe(first.id);

    await resendVerification(actor);
    await resendVerification(actor);
    const limited = await failure(() => resendVerification(actor));
    expect(limited.code).toBe("rate_limited");
    expect(limited.message).toContain(owner.email);
    expect(sent).toHaveLength(3);

    // Only the newest link works.
    expect((await verifyEmail(tokenFrom(sent[2].text))).alreadyVerified).toBe(false);
    expect((await failure(() => verifyEmail(tokenFrom(sent[0].text)))).code).toBe("gone");
    // Nothing more to send once verified, and no limit is consumed finding that out.
    expect(await resendVerification(actor)).toEqual({ status: "already_verified" });
    expect(sent).toHaveLength(3);
  });

  it("reports a failed resend with the reason, and is only for signed-in people", async () => {
    const { actor, org } = await newOrg("Fail Resend", { verified: false });
    emailBehaviour = "failed";
    expect(await resendVerification(actor)).toEqual({ status: "failed", error: "Mailbox unavailable" });
    expect((await failure(() => resendVerification({ type: "api", orgId: org.id, keyId: "key_x", label: "API" }))).code).toBe("forbidden");
  });

  it("accepting an invitation or completing a password reset proves the mailbox too", async () => {
    const { actor, owner } = await newOrg();
    const member = await addMember(actor, "member");
    expect(member.emailVerified).toBe(true);
    expect((await listMembers(actor)).find((m) => m.id === member.id)?.emailVerified).toBe(true);

    const fresh = await newOrg("Reset Verifies", { verified: false });
    expect((await listMembers(fresh.actor))[0].emailVerified).toBe(false);
    await requestPasswordReset(fresh.owner.email);
    const reset = await resetPassword(tokenFrom(sent.at(-1)!.text), "a brand new password");
    expect(reset.emailVerified).toBe(true);

    // A reset does not move the date of someone already verified.
    const db = await getDb();
    const [before] = await db.select().from(users).where(eq(users.id, owner.id));
    sent.length = 0;
    await requestPasswordReset(owner.email);
    await resetPassword(tokenFrom(sent[0].text), "another new password");
    const [after] = await db.select().from(users).where(eq(users.id, owner.id));
    expect(after.emailVerifiedAt?.getTime()).toBe(before.emailVerifiedAt?.getTime());
  });

  it("holds email to people outside the company until an owner is verified, and never email to teammates", async () => {
    const { actor, owner, org } = await newOrg("Hold Co", { verified: false });
    const db = await getDb();
    expect(await externalEmailHold(db, org.id, "client@client.test")).toBe(EMAIL_UNVERIFIED_REASON);
    expect(await externalEmailHold(db, org.id, owner.email)).toBeNull();
    expect(await externalEmailHold(db, org.id, `  ${owner.email.toUpperCase()} `)).toBeNull();
    expect(await getEmailSendingStatus(actor)).toEqual({ emailConfigured: true, canEmailOutside: false, viewerVerified: false, viewerIsOwner: true, reason: EMAIL_UNVERIFIED_REASON });

    // An invitation goes to an address outside the company, so it is held; the link is still handed over.
    const invite = await inviteMember(actor, { email: uniqueEmail("held"), role: "member" });
    expect(invite).toMatchObject({ emailStatus: "skipped", emailError: EMAIL_UNVERIFIED_REASON, emailUnverified: true });
    expect(invite.url).toContain("/invite/");
    expect(sent).toHaveLength(0);
    // The invited person can still join with the link, and joining does not lift the hold: they are not an owner.
    const { user: joined } = await acceptInvite(tokenFrom(invite.url), { name: "Jo Joined", password: PASSWORD });
    expect(joined.emailVerified).toBe(true);
    expect(await externalEmailHold(db, org.id, "client@client.test")).toBe(EMAIL_UNVERIFIED_REASON);
    expect(await getEmailSendingStatus(actorOf(joined))).toMatchObject({ canEmailOutside: false, viewerVerified: true, viewerIsOwner: false });

    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, owner.id));
    expect(await externalEmailHold(db, org.id, "client@client.test")).toBeNull();
    expect(await getEmailSendingStatus(actor)).toEqual({ emailConfigured: true, canEmailOutside: true, viewerVerified: true, viewerIsOwner: true, reason: null });
    expect((await inviteMember(actor, { email: uniqueEmail("free"), role: "member" })).emailStatus).toBe("sent");

    // A verified owner whose account is turned off no longer counts.
    const second = await addMember(actor, "admin", "Second Owner");
    await transferOwnership(actor, second.id);
    await db.update(users).set({ emailVerifiedAt: null }).where(eq(users.id, second.id));
    expect(await externalEmailHold(db, org.id, "client@client.test")).toBe(EMAIL_UNVERIFIED_REASON);
  });

  it("requires nothing when email is not set up at all", async () => {
    const { actor, org } = await newOrg("No Mail Co", { verified: false });
    emailBehaviour = "skipped";
    const db = await getDb();
    expect(await externalEmailHold(db, org.id, "client@client.test")).toBeNull();
    expect(await getEmailSendingStatus(actor)).toEqual({ emailConfigured: false, canEmailOutside: false, viewerVerified: false, viewerIsOwner: true, reason: null });
    const invite = await inviteMember(actor, { email: uniqueEmail("nomail"), role: "member" });
    expect(invite.emailStatus).toBe("skipped");
    expect(invite.emailUnverified).toBeUndefined();
    expect(invite.emailError).toBeUndefined();
  });
});

describe("company time zone", () => {
  it("stores a valid browser zone at sign-up and quietly ignores anything else", async () => {
    const good = await signUp({ orgName: "Zone Co", name: "Z", email: uniqueEmail("zone"), password: PASSWORD, timeZone: "America/Toronto" });
    expect(good.org.settings).toEqual({ timeZone: "America/Toronto" });
    expect(resolveSettings(good.org).timeZone).toBe("America/Toronto");
    for (const timeZone of ["Mars/Olympus_Mons", "", 42, null, undefined, "x".repeat(500), "America/Toronto; drop table orgs"]) {
      const { org } = await signUp({ orgName: "Zone Co", name: "Z", email: uniqueEmail("zone"), password: PASSWORD, timeZone });
      expect(org.settings, String(timeZone).slice(0, 30)).toEqual({});
    }
  });

  it("is a setting managers can change, validated against the zones the runtime knows", async () => {
    const { actor } = await newOrg();
    expect((await updateOrg(actor, { settings: { timeZone: "Europe/London" } })).settings.timeZone).toBe("Europe/London");
    // Letter case is corrected to the canonical name.
    expect((await updateOrg(actor, { settings: { timeZone: "america/new_york" } })).settings.timeZone).toBe("America/New_York");
    for (const bad of ["Not/AZone", "Toronto", 5, "Europe/London\nX"]) {
      const err = await failure(() => updateOrg(actor, { settings: { timeZone: bad } }));
      expect(err.fields?.timeZone, String(bad)).toMatch(/time zone/);
    }
    expect((await updateOrg(actor, { settings: { timeZone: "" } })).settings).not.toHaveProperty("timeZone");
  });
});

describe("callers without a network address share one limit instead of having none", () => {
  const unknownCount = async (action: string) => {
    const db = await getDb();
    const [row] = await db.select().from(rateLimits).where(eq(rateLimits.key, `${action}:ip:unknown`));
    return row?.count ?? 0;
  };

  it("counts sign-ups, sign-ins and reset requests with no address against a shared bucket", async () => {
    const before = { signup: await unknownCount("signup"), login: await unknownCount("login"), reset: await unknownCount("reset") };
    const email = uniqueEmail("noip");
    await signUp({ orgName: "No Ip", name: "N", email, password: PASSWORD });
    await signUp({ orgName: "No Ip", name: "N", email: uniqueEmail("noip"), password: PASSWORD }, { ip: null });
    await logIn({ email, password: PASSWORD });
    await logIn({ email, password: PASSWORD }, { ip: "   " });
    await requestPasswordReset(email);
    await requestPasswordReset(email, {});
    expect(await unknownCount("signup")).toBe(before.signup + 2);
    expect(await unknownCount("login")).toBe(before.login + 2);
    expect(await unknownCount("reset")).toBe(before.reset + 2);
  });

  it("stops every such caller once the shared bucket is full, without touching callers who have an address", async () => {
    const db = await getDb();
    const full = { resetAt: new Date(Date.now() + 3_600_000) };
    await db.insert(rateLimits).values({ key: "signup:ip:unknown", count: 100, ...full }).onConflictDoUpdate({ target: rateLimits.key, set: { count: 100, ...full } });
    await db.insert(rateLimits).values({ key: "login:ip:unknown", count: 500, ...full }).onConflictDoUpdate({ target: rateLimits.key, set: { count: 500, ...full } });
    await db.insert(rateLimits).values({ key: "reset:ip:unknown", count: 200, ...full }).onConflictDoUpdate({ target: rateLimits.key, set: { count: 200, ...full } });
    try {
      const email = uniqueEmail("fullbucket");
      expect((await failure(() => signUp({ orgName: "Full", name: "F", email, password: PASSWORD }))).code).toBe("rate_limited");
      const { user } = await signUp({ orgName: "Full", name: "F", email, password: PASSWORD }, { ip: "203.0.113.201" });
      expect((await failure(() => logIn({ email, password: PASSWORD }))).code).toBe("rate_limited");
      expect((await logIn({ email, password: PASSWORD }, { ip: "203.0.113.201" })).id).toBe(user.id);
      sent.length = 0;
      await requestPasswordReset(email);
      expect(sent).toHaveLength(0);
      await requestPasswordReset(email, { ip: "203.0.113.201" });
      expect(sent).toHaveLength(1);
    } finally {
      // Other tests in this file sign up and sign in without an address.
      await db.delete(rateLimits).where(eq(rateLimits.key, "signup:ip:unknown"));
      await db.delete(rateLimits).where(eq(rateLimits.key, "login:ip:unknown"));
      await db.delete(rateLimits).where(eq(rateLimits.key, "reset:ip:unknown"));
    }
  });
});

describe("a saved signature must be one the document engine can draw", () => {
  it("refuses a small file that claims enormous dimensions", async () => {
    const { actor } = await newOrg();
    const huge = Buffer.from(PNG);
    // Width and height live in the IHDR chunk; 6000 x 6000 is far past what a signature may be.
    huge.writeUInt32BE(6000, 16);
    huge.writeUInt32BE(6000, 20);
    const err = await failure(() => saveSignature(actor, `data:image/png;base64,${huge.toString("base64")}`));
    expect(err.code).toBe("invalid");
    expect(err.fields?.signature).toMatch(/too many pixels/);
    expect(await getOwnSignature(actor)).toBeNull();
    expect((await saveSignature(actor, PNG_URL)).hasSignature).toBe(true);
  });
});
