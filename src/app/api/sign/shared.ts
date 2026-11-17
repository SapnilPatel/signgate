/**
 * Shared by the public signing endpoints. These are authenticated by the secret in
 * the path, not by a cookie, so there is no ambient credential for another site to
 * ride on and no same-origin check: whoever holds the link may use it, which is the
 * whole point of a signing link. Limits and state checks live in the service.
 */
import "server-only";
import { errorResponse } from "@/lib/route";

export type SignRouteContext = { params: Promise<{ token: string }> };

const NO_INDEX = "noindex, nofollow";

/** Adds the headers every signing response carries: never indexed, never sent on as a referrer. */
export function sealed(response: Response): Response {
  response.headers.set("X-Robots-Tag", NO_INDEX);
  response.headers.set("Referrer-Policy", "no-referrer");
  if (!response.headers.has("Cache-Control")) response.headers.set("Cache-Control", "private, no-store");
  return response;
}

/** The service's own explanation as JSON, for requests made by the signing page's script. */
export function failure(err: unknown): Response {
  return sealed(errorResponse(err));
}

/**
 * For a document link a person followed directly: instead of a page of JSON, send
 * them to the signing page, which explains the link's state in plain words.
 * Requests from the page's own script (the PDF viewer) still get the JSON error.
 */
export function failureForDocument(request: Request, token: string, err: unknown): Response {
  const navigating = request.headers.get("sec-fetch-mode") === "navigate" || (request.headers.get("accept") ?? "").includes("text/html");
  if (!navigating) return failure(err);
  // Logged here because the redirect hides the error from the person; the token is never logged.
  if (!(err instanceof Error) || err.name !== "ServiceError") console.error("[sign] document request failed", err instanceof Error ? err.message : err);
  const target = new URL(`/sign/${encodeURIComponent(token)}`, request.url);
  return sealed(new Response(null, { status: 303, headers: { Location: `${target.pathname}`, "Cache-Control": "no-store" } }));
}
