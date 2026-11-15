/**
 * Who is performing a service call. Built from the session, an API key or a
 * signing link by the caller; services never read cookies or headers themselves.
 * `orgId` here is the only source of tenant identity a service may trust.
 */
export type Actor =
  | { type: "user"; orgId: string; userId: string; role: "owner" | "admin" | "member"; label: string }
  | { type: "api"; orgId: string; keyId: string; label: string }
  | { type: "system"; orgId: string; label: "System" };

/** Request metadata recorded on audit events. */
export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export function systemActor(orgId: string): Actor {
  return { type: "system", orgId, label: "System" };
}

/**
 * An expected failure with a message that is safe and useful to show to the person
 * who triggered it. Anything else that throws is a bug and is reported generically.
 */
export class ServiceError extends Error {
  constructor(
    public code:
      | "not_found"
      | "invalid"
      | "conflict"
      | "forbidden"
      | "rate_limited"
      | "gone"
      | "not_ready",
    message: string,
    /** Field name -> problem, for forms. */
    public fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ServiceError";
  }

  /** HTTP status for API responses. */
  get status(): number {
    return { not_found: 404, invalid: 422, conflict: 409, forbidden: 403, rate_limited: 429, gone: 410, not_ready: 409 }[this.code];
  }
}
