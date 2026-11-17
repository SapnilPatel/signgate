/**
 * Helpers for route handlers under src/app/api/app/**, the endpoints the signed-in
 * product calls from the browser (uploads, PDF downloads, anything a server action
 * cannot return). They are authenticated by the session cookie, so every one that
 * changes something must prove the request came from our own pages: a cookie is
 * sent by the browser no matter which site made the request.
 */
import "server-only";
import { AuthError, assertViewer, canManage, type Viewer } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { actorOf, requestMetaFrom } from "@/lib/request";
import { ServiceError, type Actor, type RequestMeta } from "@/lib/services/context";

export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string> };
}

/** Responses here are about one signed-in person's data; no cache may keep or share them. */
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } as const;

export function jsonError(code: string, message: string, status: number, fields?: Record<string, string>): Response {
  const body: ApiErrorBody = { error: { code, message, ...(fields && Object.keys(fields).length > 0 ? { fields } : {}) } };
  return Response.json(body, { status, headers: PRIVATE_HEADERS });
}

/** A JSON success response with the same privacy headers as the errors. */
export function jsonOk(data: unknown, status = 200): Response {
  return Response.json(data ?? { ok: true }, { status, headers: PRIVATE_HEADERS });
}

// ---------------------------------------------------------------------------
// Same-origin check
// ---------------------------------------------------------------------------

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    // `host` keeps a non-default port and drops a default one, for both sides alike.
    return new URL(value.includes("://") ? value : `http://${value}`).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Hosts this deployment answers on, as the browser names them. */
function ownHosts(request: Request): Set<string> {
  const hosts = new Set<string>();
  const add = (value: string | null | undefined) => {
    const host = hostOf(value);
    if (host) hosts.add(host);
  };
  // Behind the platform's proxy the public name arrives as x-forwarded-host; the
  // framework's own server-action check trusts the same header.
  add(request.headers.get("x-forwarded-host")?.split(",")[0]?.trim());
  add(request.headers.get("host"));
  // Only an explicitly configured address: the localhost fallback would wrongly allow
  // a page served from the developer's machine to call a deployed app.
  if (process.env.APP_URL?.trim()) add(env.appUrl);
  return hosts;
}

/**
 * True when a request that changes something came from one of our own pages.
 *
 * Browsers attach Origin to every cross-site POST, PUT, PATCH and DELETE, so an
 * Origin that names another host is a forged request and is refused. When Origin
 * is absent (some browsers omit it on same-origin requests), the request must say
 * so itself with Sec-Fetch-Site: same-origin, a header page scripts cannot set.
 * A caller with neither, such as a script holding a stolen cookie, is refused too.
 * GET, HEAD and OPTIONS are not checked: they must never change anything.
 */
export function isSameOrigin(request: Request): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
  const origin = request.headers.get("origin");
  if (origin !== null) {
    // "null" is what sandboxed frames and some redirects send; it is never ours.
    const originHost = origin === "null" ? null : hostOf(origin);
    return originHost !== null && ownHosts(request).has(originHost);
  }
  return request.headers.get("sec-fetch-site")?.trim().toLowerCase() === "same-origin";
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/** redirect() and notFound() work by throwing; the framework must receive those untouched. */
function isFrameworkSignal(err: unknown): boolean {
  return err instanceof Error && "digest" in err && typeof err.digest === "string" && err.digest.startsWith("NEXT_");
}

/**
 * Turns whatever a handler threw into the JSON error every client of these routes
 * can rely on. Expected failures keep their message; anything else is a bug, so it
 * is logged and reported generically without leaking internals.
 */
export function errorResponse(err: unknown): Response {
  if (err instanceof ServiceError) return jsonError(err.code, err.message, err.status, err.fields);
  if (err instanceof AuthError) return jsonError(err.status === 403 ? "forbidden" : "unauthenticated", err.message, err.status);
  console.error("route handler failed", err);
  return jsonError("internal", "Something went wrong on our side. Try again; if it keeps happening, contact support.", 500);
}

// ---------------------------------------------------------------------------
// withActor
// ---------------------------------------------------------------------------

export interface ActorRouteContext<P> {
  actor: Actor;
  viewer: Viewer;
  meta: RequestMeta;
  request: Request;
  params: P;
}

type RouteParams = Record<string, string | string[] | undefined>;

/**
 * Wraps a session-authenticated route handler:
 *
 *   export const POST = withActor<{ id: string }>(async ({ actor, params, request, meta }) => {
 *     return jsonOk(await doSomething(actor, params.id, await readJson(request), meta));
 *   }, { manage: true });
 *
 * Signed out is a 401 and, with `manage`, anyone but an owner or admin is a 403. The
 * handler may return a Response, or plain data to be sent as JSON. Services still do
 * their own permission checks against the stored row; `manage` only saves the trip.
 */
export function withActor<P extends RouteParams = Record<string, never>>(
  handler: (ctx: ActorRouteContext<P>) => Promise<unknown> | unknown,
  opts: { manage?: boolean } = {},
): (request: Request, context: { params: Promise<P> }) => Promise<Response> {
  return async (request, context) => {
    try {
      // Before the session is even read: a forged request learns nothing about who is signed in.
      if (!isSameOrigin(request)) {
        return jsonError("cross_origin", "This request did not come from this site, so it was refused. Reload the page and try again.", 403);
      }
      const viewer = await assertViewer();
      if (opts.manage && !canManage(viewer.user)) {
        throw new AuthError("Only an owner or admin can do that. Ask one of them to make this change.", 403);
      }
      const params = ((await context?.params) ?? {}) as P;
      const result = await handler({ actor: actorOf(viewer), viewer, meta: requestMetaFrom(request), request, params });
      return result instanceof Response ? result : jsonOk(result);
    } catch (err) {
      if (isFrameworkSignal(err)) throw err;
      return errorResponse(err);
    }
  };
}

/**
 * The JSON body of a request as a plain object. Throws a ServiceError the wrapper
 * turns into a 422, so a handler never has to deal with a body that is not JSON.
 */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ServiceError("invalid", "The request could not be read. Reload the page and try again.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ServiceError("invalid", "The request could not be read. Reload the page and try again.");
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// PDF responses
// ---------------------------------------------------------------------------

/**
 * Content-Disposition with both forms of the filename: a plain ASCII one every
 * client understands, and the RFC 5987 `filename*` that carries the real name for
 * clients that support it. Nothing from the name can break out of the header.
 */
export function contentDisposition(filename: string, inline = false): string {
  const cleaned =
    String(filename ?? "")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/[\\/]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 150) || "document.pdf";
  const ascii =
    cleaned
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/["%;]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "document.pdf";
  // encodeURIComponent leaves ' ( ) * unescaped, which RFC 5987 does not allow in the value.
  const encoded = encodeURIComponent(cleaned).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** A PDF for download, or with `inline` for display in the browser's viewer. Never cached: agreements are private. */
export function pdfResponse(bytes: Uint8Array, filename: string, opts: { inline?: boolean } = {}): Response {
  const name = /\.pdf$/i.test(filename) ? filename : `${filename || "document"}.pdf`;
  // A copy with its own exact-size buffer: a Buffer can be a window onto a larger shared pool.
  const body = new Uint8Array(bytes);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(body.byteLength),
      "Content-Disposition": contentDisposition(name, opts.inline === true),
      ...PRIVATE_HEADERS,
    },
  });
}
