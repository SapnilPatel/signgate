/** The error vocabulary of the public API. Kept free of imports so every other module here can use it. */

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; fields?: Record<string, string> };
}

/** Every `error.code` the API can answer with. The docs page lists these from here. */
export const API_ERROR_CODES = {
  unauthenticated: { status: 401, meaning: "The API key is missing, malformed, unknown or revoked." },
  forbidden: { status: 403, meaning: "The key is valid but this action is not open to API keys." },
  not_found: { status: 404, meaning: "Nothing with that id exists in your company. Ids from another company look exactly the same." },
  conflict: { status: 409, meaning: "The request is valid but does not fit the current state, for example sending when an agreement is already out." },
  not_ready: { status: 409, meaning: "Something has to be set up or finished first, for example no agreement is active, or the signed copy does not exist yet." },
  idempotency_key_reused: { status: 409, meaning: "This Idempotency-Key was already used and the first result cannot be replayed, or it was used with a different body." },
  gone: { status: 410, meaning: "The thing you asked for existed but is no longer available." },
  payload_too_large: { status: 413, meaning: "The request body is over the size limit." },
  unsupported_media_type: { status: 415, meaning: "The body was not sent as application/json." },
  invalid: { status: 422, meaning: "The body or query string failed validation. `fields` says which parts." },
  rate_limited: { status: 429, meaning: "Too many requests, or a sending limit was reached. Wait for the number of seconds in Retry-After." },
  internal: { status: 500, meaning: "Something went wrong on our side. The request may be retried." },
} as const satisfies Record<string, { status: number; meaning: string }>;

export type ApiErrorCode = keyof typeof API_ERROR_CODES;

/** An error a route raises on purpose. Anything else that is thrown is a bug and becomes a 500. */
export class ApiError extends Error {
  constructor(
    public code: ApiErrorCode,
    message: string,
    public fields?: Record<string, string>,
    public headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
