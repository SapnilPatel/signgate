import "server-only";
import { headers } from "next/headers";
import type { Viewer } from "@/lib/auth/session";
import { assertViewer, requireViewer } from "@/lib/auth/session";
import type { Actor, RequestMeta } from "@/lib/services/context";

/** IP and user agent of the current request, for audit events and rate limits. */
export async function getRequestMeta(): Promise<RequestMeta> {
  const h = await headers();
  // On Vercel x-real-ip is set by the platform and cannot be spoofed by the client;
  // x-forwarded-for's first entry is the fallback for other hosts and local dev.
  const ip = h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return { ip: ip ? ip.slice(0, 64) : null, userAgent: h.get("user-agent")?.slice(0, 400) ?? null };
}

/** The same, from a route handler's Request. */
export function requestMetaFrom(request: Request): RequestMeta {
  const h = request.headers;
  const ip = h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return { ip: ip ? ip.slice(0, 64) : null, userAgent: h.get("user-agent")?.slice(0, 400) ?? null };
}

export function actorOf(viewer: Viewer): Actor {
  return {
    type: "user",
    orgId: viewer.org.id,
    userId: viewer.user.id,
    role: viewer.user.role,
    label: `${viewer.user.name} (${viewer.user.email})`,
  };
}

/** For pages: the signed-in viewer and their actor, or a redirect to sign-in. */
export async function requireActor(): Promise<{ viewer: Viewer; actor: Actor }> {
  const viewer = await requireViewer();
  return { viewer, actor: actorOf(viewer) };
}

/** For server actions and route handlers: throws AuthError when signed out. */
export async function assertActor(): Promise<{ viewer: Viewer; actor: Actor }> {
  const viewer = await assertViewer();
  return { viewer, actor: actorOf(viewer) };
}
