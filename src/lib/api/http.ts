/**
 * The plumbing every /api/v1 route shares: API-key authentication, the per-key rate
 * limit, body and query validation, idempotency, and one JSON error shape.
 *
 * These routes are called by other companies' servers, not by our pages. There is no
 * cookie involved, so there is no same-origin check, and no CORS headers are sent: a
 * browser on another site cannot read these responses, which is intended.
 */
import "server-only";
import { z } from "zod";
import type { Org } from "@/lib/db/schema";
import { requestMetaFrom } from "@/lib/request";
import { authenticateApiKey } from "@/lib/services/api-keys";
import { ServiceError, type Actor, type RequestMeta } from "@/lib/services/context";
import { rateLimit } from "@/lib/services/rate-limit";
import { beginIdempotentRequest, type IdempotentRequest } from "./idempotency";
import { tickAfterResponse } from "./tick";
import { API_ERROR_CODES, ApiError, type ApiErrorBody, type ApiErrorCode } from "./errors";

export { API_ERROR_CODES, ApiError, type ApiErrorBody, type ApiErrorCode };

/** Requests one key may make per window. Sending has its own, lower limits in the services. */
export const API_RATE_LIMIT = { requests: 300, windowSeconds: 60 } as const;
/** Largest JSON body accepted. A file with every field at its maximum is under 40 KB. */
export const MAX_BODY_BYTES = 64 * 1024;
export const WWW_AUTHENTICATE = 'Bearer realm="Signgate API"';

/** Per-company data: no cache between us and the caller may keep it. */
const BASE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

export function apiJson(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function apiError(code: ApiErrorCode, message: string, fields?: Record<string, string>, headers: Record<string, string> = {}): Response {
  const body: ApiErrorBody = { error: { code, message, ...(fields && Object.keys(fields).length > 0 ? { fields } : {}) } };
  return apiJson(body, API_ERROR_CODES[code].status, headers);
}

// ---------------------------------------------------------------------------
// Translating service errors
// ---------------------------------------------------------------------------

/** clientEmail -> client_email. Services name fields the way the forms do; the API is snake_case throughout. */
export function snakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * A service says how long to wait in words ("Try again in 12 minutes"). Retry-After
 * needs seconds, so the number is read back out; when the wording does not match,
 * one minute is a safe floor for a client to back off by.
 */
function retryAfterFrom(message: string): number {
  const minutes = /\bin (\d+) minutes?\b/.exec(message);
  if (minutes) return Number(minutes[1]) * 60;
  const hours = /\bin about (\d+) hours?\b/.exec(message);
  if (hours) return Number(hours[1]) * 3600;
  return 60;
}

function serviceFields(err: ServiceError): Record<string, string> | undefined {
  if (!err.fields || err.code === "rate_limited") return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(err.fields)) {
    // { confirm: "includeSigned" } is how a service asks its caller to confirm something
    // destructive. For the API that means: repeat the request with that flag set to true.
    if (key === "confirm") out[snakeCase(String(value))] = "Send true to confirm, then repeat the request.";
    else out[snakeCase(key)] = String(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function errorToResponse(err: unknown): Response {
  if (err instanceof ApiError) return apiError(err.code, err.message, err.fields, err.headers);
  if (err instanceof ServiceError) {
    const headers: Record<string, string> = err.code === "rate_limited" ? { "Retry-After": String(retryAfterFrom(err.message)) } : {};
    return apiError(err.code, err.message, serviceFields(err), headers);
  }
  console.error("[api] request failed", err);
  return apiError("internal", "Something went wrong on our side. Try the request again; if it keeps failing, contact support.");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const squash = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/** "clientName" was almost certainly meant as "client_name": say so instead of only refusing. */
function unknownKeyMessage(key: string, allowed: readonly string[]): string {
  const close = allowed.find((name) => squash(name) === squash(key));
  if (close) return `Unknown field. Did you mean "${close}"?`;
  return `Unknown field. Allowed here: ${allowed.join(", ")}.`;
}

/**
 * Checks `value` against a strict zod object and returns the parsed result, or throws
 * a 422 whose `fields` names every problem. `what` is "body" or "query string".
 */
export function validate<S extends z.ZodObject>(schema: S, value: unknown, what: "body" | "query string"): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const allowed = Object.keys(schema.shape);
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) fields[key.slice(0, 80)] = unknownKeyMessage(key, allowed);
      continue;
    }
    const path = issue.path.map(String).join(".") || what.replace(" ", "_");
    if (!(path in fields)) fields[path] = issue.message;
  }
  const names = Object.keys(fields);
  const message =
    names.length === 1 ? `The ${what} has a problem with "${names[0]}": ${fields[names[0]]}` : `The ${what} has ${names.length} problems. See "fields" for each one, fix them and send the request again.`;
  throw new ApiError("invalid", message, fields);
}

/**
 * Reads a request body as text, refusing anything over the limit before and after
 * reading: Content-Length can be absent or wrong, so the bytes are counted as well.
 */
async function readBodyText(request: Request): Promise<string> {
  const tooLarge = () => new ApiError("payload_too_large", `The request body is larger than ${MAX_BODY_BYTES / 1024} KB. Send less data in one request.`);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw tooLarge();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonObject(text: string, contentType: string | null): Record<string, unknown> {
  // Several endpoints take no required fields; an empty body means "all defaults".
  if (text.trim() === "") return {};
  if (!contentType || !/\bjson\b/i.test(contentType)) {
    throw new ApiError("unsupported_media_type", 'Send the body as JSON with the header "Content-Type: application/json".');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError("invalid", "The body is not valid JSON. Check for a missing quote, comma or bracket and send it again.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError("invalid", 'The body must be a JSON object, for example {"client_name": "Jane Doe"}.');
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The route wrapper
// ---------------------------------------------------------------------------

type RouteParams = Record<string, string | string[] | undefined>;

export interface ApiContext<P> {
  /** The API key as a service actor. Its `orgId` is the only tenant identity a handler may use. */
  actor: Extract<Actor, { type: "api" }>;
  org: Org;
  request: Request;
  url: URL;
  params: P;
  meta: RequestMeta;
  /** The JSON body checked against a strict schema. An empty body is treated as {}. */
  body<S extends z.ZodObject>(schema: S): z.infer<S>;
  /** The query string checked against a strict schema. A repeated parameter keeps its last value. */
  query<S extends z.ZodObject>(schema: S): z.infer<S>;
}

type Handler<P> = (ctx: ApiContext<P>) => Promise<Response> | Response;

export interface ApiRouteOptions<P> {
  /**
   * What to answer when a POST repeats an Idempotency-Key that was already carried out.
   * It must not change anything a second time: return the current state of what the
   * first request acted on. "rerun" is for handlers that are already no-ops when
   * repeated. Without it, a repeat is answered with 409 idempotency_key_reused.
   */
  replay?: Handler<P> | "rerun";
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Wraps an /api/v1 handler:
 *
 *   export const POST = apiRoute<{ id: string }>(async ({ actor, params, body, meta }) => {
 *     const input = body(SendSchema);
 *     return apiJson(await doSomething(actor, params.id, input, meta));
 *   });
 */
export function apiRoute<P extends RouteParams = Record<string, never>>(
  handler: Handler<P>,
  opts: ApiRouteOptions<P> = {},
): (request: Request, context: { params: Promise<P> }) => Promise<Response> {
  return async (request, context) => {
    let idempotent: IdempotentRequest | null = null;
    try {
      const auth = await authenticateApiKey(request.headers.get("authorization"));
      if (!auth || auth.actor.type !== "api") {
        // One answer for every way a key can be wrong, so keys cannot be probed.
        throw new ApiError(
          "unauthenticated",
          'A valid API key is required. Send it as "Authorization: Bearer sg_live_...". Keys are created under Settings, API keys; a revoked key stops working at once.',
          undefined,
          { "WWW-Authenticate": WWW_AUTHENTICATE },
        );
      }
      const actor = auth.actor;

      const limit = await rateLimit(`api:${actor.keyId}`, API_RATE_LIMIT.requests, API_RATE_LIMIT.windowSeconds);
      if (!limit.ok) {
        throw new ApiError(
          "rate_limited",
          `This key has made more than ${API_RATE_LIMIT.requests} requests in ${API_RATE_LIMIT.windowSeconds} seconds. Wait ${limit.retryAfterSeconds} seconds, then continue.`,
          undefined,
          { "Retry-After": String(limit.retryAfterSeconds) },
        );
      }

      // Ids are short printable strings. Anything else cannot match a row, and a NUL byte
      // makes Postgres reject the whole query, which would be reported as our failure.
      const params = ((await context?.params) ?? {}) as P;
      for (const value of Object.values(params).flat()) {
        if (typeof value === "string" && (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value))) {
          throw new ApiError("not_found", "Nothing was found at this address. Check the id in the path and send the request again.");
        }
      }

      const method = request.method.toUpperCase();
      const url = new URL(request.url);
      const bodyText = WRITE_METHODS.has(method) ? await readBodyText(request) : "";
      let parsedBody: Record<string, unknown> | null = null;
      const ctx: ApiContext<P> = {
        actor,
        org: auth.org,
        request,
        url,
        params,
        meta: requestMetaFrom(request),
        body: (schema) => validate(schema, (parsedBody ??= parseJsonObject(bodyText, request.headers.get("content-type"))), "body"),
        query: (schema) => validate(schema, Object.fromEntries(url.searchParams), "query string"),
      };

      // Reminders, expiry and webhook retries are owed whether or not the host's cron
      // runs often; busy integrations keep them moving. Costs this request nothing.
      tickAfterResponse();

      if (method === "POST") {
        idempotent = await beginIdempotentRequest(actor.keyId, method, url.pathname, request.headers.get("idempotency-key"), bodyText);
        if (idempotent?.state === "different_body") {
          throw new ApiError(
            "idempotency_key_reused",
            "This Idempotency-Key was already used with a different request body. Use a new key for a new request, or repeat the first request exactly.",
          );
        }
        if (idempotent?.state === "repeat") {
          if (!opts.replay) {
            throw new ApiError(
              "idempotency_key_reused",
              "A request with this Idempotency-Key was already received, so it was not carried out again. Its result cannot be replayed here; look up what it created, or send external_id so that a repeat returns the same file.",
            );
          }
          const replayed = await (opts.replay === "rerun" ? handler : opts.replay)(ctx);
          replayed.headers.set("Idempotent-Replayed", "true");
          return replayed;
        }
      }

      const response = await handler(ctx);
      // A request that was refused changed nothing, so its key is free to be used again
      // once the caller has fixed the problem. After a 5xx the outcome is unknown and the
      // key stays taken: a repeat is answered from the current state, never by acting twice.
      if (idempotent && response.status >= 400 && response.status < 500) await idempotent.release();
      return response;
    } catch (err) {
      const response = errorToResponse(err);
      if (idempotent?.state === "first" && response.status >= 400 && response.status < 500) await idempotent.release();
      return response;
    }
  };
}

/** For paths under /api/v1 that no route answers: JSON, like everything else. */
export function notFoundResponse(): Response {
  return apiError("not_found", "There is no API endpoint at this address. Check the path against the reference at /docs/api.");
}

/** A PDF as an attachment. `sha256` lets the caller check the bytes it stored against the audit certificate. */
export function apiPdf(bytes: Uint8Array, filename: string, sha256: string): Response {
  // A copy with its own exact-size buffer: a Buffer can be a window onto a larger shared pool.
  const body = new Uint8Array(bytes);
  const ascii = filename.replace(/[^\x20-\x7e]/g, "").replace(/["\\;%]/g, "").trim() || "agreement.pdf";
  return new Response(body, {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "application/pdf",
      "Content-Length": String(body.byteLength),
      "Content-Disposition": `attachment; filename="${ascii}"`,
      "X-Signgate-Sha256": sha256,
    },
  });
}
