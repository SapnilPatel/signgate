import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";

const sent: { kind: string; to: string; subject: string; html: string; text: string; orgId?: string | null }[] = [];
let emailBehaviour: "sent" | "failed" | "skipped" | "throw" = "sent";

vi.mock("@/lib/services/email", () => ({
  sendEmail: vi.fn(async (msg: (typeof sent)[number]) => {
    if (emailBehaviour === "throw") throw new Error("provider exploded");
    if (emailBehaviour === "sent") sent.push(msg);
    return emailBehaviour === "failed" ? { status: "failed", error: "Mailbox unavailable" } : { status: emailBehaviour };
  }),
}));
vi.mock("@/lib/services/email-templates", () => ({
  passwordResetEmail: (p: { name: string; url: string }) => ({ subject: "Reset your password", html: `<a href="${p.url}">reset</a>`, text: p.url }),
  inviteEmail: (p: { orgName: string; inviterName: string; url: string }) => ({
    subject: `${p.inviterName} invited you to ${p.orgName}`,
    html: `<a href="${p.url}">join</a>`,
    text: p.url,
  }),
}));

import { getDb } from "@/lib/db";
import { authTokens, events, orgs, rateLimits, sessions, users } from "@/lib/db/schema";
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

async function newOrg(orgName = `Test Co ${++seq}`) {
  const { user, org } = await signUp({ orgName, name: "Olive Owner", email: uniqueEmail("owner"), password: PASSWORD });
  return { owner: user, org, actor: actorOf(user) };
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

  it("locks an email after repeated failures, even with the right password, then recovers", async () => {
    const { owner } = await newOrg();
    for (let i = 0; i < 10; i++) expect((await failure(() => logIn({ email: owner.email, password: "nope nope" }))).code).toBe("invalid");
    const locked = await failure(() => logIn({ email: owner.email, password: PASSWORD }));
    expect(locked.code).toBe("rate_limited");
    expect(locked.message).toMatch(/Try again in \d+ minutes?/);

    const db = await getDb();
    await db.update(rateLimits).set({ resetAt: new Date(Date.now() - 1000) }).where(eq(rateLimits.key, `login:email:${owner.email}`));
    expect((await logIn({ email: owner.email, password: PASSWORD })).id).toBe(owner.id);
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
    const [row] = await db.select().from(authTokens).where(eq(authTokens.userId, owner.id));
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

  it("lets someone locked out by failed sign-ins back in after a reset", async () => {
    const { owner } = await newOrg();
    for (let i = 0; i < 11; i++) await failure(() => logIn({ email: owner.email, password: "nope nope" }));
    await requestPasswordReset(owner.email);
    await resetPassword(tokenFrom(sent[0].text), "a brand new password");
    expect((await logIn({ email: owner.email, password: "a brand new password" })).id).toBe(owner.id);
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

  it("refuses to invite someone who already has an account, here or elsewhere", async () => {
    const a = await newOrg();
    const b = await newOrg();
    const here = await failure(() => inviteMember(a.actor, { email: a.owner.email, role: "member" }));
    expect(here.code).toBe("conflict");
    expect(here.message).toMatch(/already on your team/);
    const elsewhere = await failure(() => inviteMember(a.actor, { email: b.owner.email.toUpperCase(), role: "member" }));
    expect(elsewhere.code).toBe("conflict");
    expect(elsewhere.fields).toHaveProperty("email");
    expect(sent).toHaveLength(0);
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
