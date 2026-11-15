import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, lt } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { sessions, users, orgs, type User, type Org } from "@/lib/db/schema";
import { newSecret, sha256Hex } from "@/lib/ids";
import { env } from "@/lib/env";

const COOKIE = "sg_session";
const SESSION_DAYS = 30;

export interface Viewer {
  user: User;
  org: Org;
}

/** Creates a session for the user and sets the cookie. Call from a server action or route handler. */
export async function startSession(userId: string): Promise<void> {
  const db = await getDb();
  const token = newSecret();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.insert(sessions).values({ id: sha256Hex(token), userId, expiresAt });
  // Opportunistic cleanup of expired sessions; cheap and keeps the table small.
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProduction,
    path: "/",
    expires: expiresAt,
  });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) {
    const db = await getDb();
    await db.delete(sessions).where(eq(sessions.id, sha256Hex(token)));
  }
  jar.delete(COOKIE);
}

/** Ends every session for a user, e.g. after a password change. */
export async function endAllSessions(userId: string): Promise<void> {
  const db = await getDb();
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** The signed-in user and their org, or null. Deduplicated per request. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const db = await getDb();
  const rows = await db
    .select({ user: users, org: orgs })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(orgs, eq(orgs.id, users.orgId))
    .where(and(eq(sessions.id, sha256Hex(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row || row.user.disabledAt) return null;
  return row;
});

/** For pages: returns the viewer or redirects to sign-in. */
export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  return viewer;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public status: 401 | 403 = 401,
  ) {
    super(message);
  }
}

/** For server actions and route handlers: returns the viewer or throws AuthError. */
export async function assertViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) throw new AuthError("You are signed out. Sign in and try again.");
  return viewer;
}

/** Owners and admins manage settings, team, agreements, API keys and webhooks. */
export function canManage(user: Pick<User, "role">): boolean {
  return user.role === "owner" || user.role === "admin";
}

export async function assertManager(): Promise<Viewer> {
  const viewer = await assertViewer();
  if (!canManage(viewer.user)) throw new AuthError("Only an owner or admin can do that.", 403);
  return viewer;
}
