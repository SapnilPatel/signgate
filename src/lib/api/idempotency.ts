/**
 * Idempotency-Key support for POST requests.
 *
 * What this guarantees: a request that repeats a key is never carried out a second
 * time. The first request to arrive with a key claims it for 24 hours in one atomic
 * database statement, so two copies racing on different serverless instances cannot
 * both win.
 *
 * What it does not do: store the first response and play it back. There is no table
 * for that yet, so a repeat is answered from the current state of whatever the first
 * request acted on (see `replay` in apiRoute). The claim itself is kept in the shared
 * rate-limit counters, which already give exactly the "first caller wins" primitive
 * needed and are swept by the scheduled jobs when they lapse.
 */
import "server-only";
import { sha256Hex } from "@/lib/ids";
import { clearRateLimit, rateLimit } from "@/lib/services/rate-limit";
import { ApiError } from "./errors";

export const IDEMPOTENCY_WINDOW_SECONDS = 24 * 3600;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

export interface IdempotentRequest {
  /**
   * - first: nobody has used this key on this endpoint in the last 24 hours; carry the request out.
   * - repeat: the same request was already received; do not carry it out again.
   * - different_body: the key was used before with other contents, which is a caller bug.
   */
  state: "first" | "repeat" | "different_body";
  /** Give the key back, for a first request that was refused and so changed nothing. Never throws. */
  release(): Promise<void>;
}

/**
 * Claims `key` for one API key, method and path. Returns null when no key was sent.
 * Keys are scoped to the endpoint, so the same value on two different URLs is two
 * independent requests.
 */
export async function beginIdempotentRequest(apiKeyId: string, method: string, path: string, key: string | null, bodyText: string): Promise<IdempotentRequest | null> {
  if (key === null) return null;
  const value = key.trim();
  if (!value || value.length > IDEMPOTENCY_KEY_MAX_LENGTH || !/^[\x21-\x7e]+$/.test(value)) {
    throw new ApiError("invalid", `Idempotency-Key must be 1 to ${IDEMPOTENCY_KEY_MAX_LENGTH} printable characters with no spaces, for example a UUID.`, {
      "Idempotency-Key": "Use a unique value per request, such as a UUID.",
    });
  }
  // Hashed: the stored counter name must not grow with what the caller sends, and the key need not be readable later.
  const claim = `idem:${apiKeyId}:${sha256Hex(`${method} ${path}\n${value}`)}`;
  const contents = `${claim}:${sha256Hex(bodyText).slice(0, 32)}`;
  const release = async () => {
    await clearRateLimit(claim);
    await clearRateLimit(contents);
  };

  const first = await rateLimit(claim, 1, IDEMPOTENCY_WINDOW_SECONDS);
  if (first.ok) {
    // Remember what the request contained, so the same key with other contents can be told apart from a retry.
    await rateLimit(contents, 1, IDEMPOTENCY_WINDOW_SECONDS);
    return { state: "first", release };
  }
  const sameContents = await rateLimit(contents, 1, IDEMPOTENCY_WINDOW_SECONDS);
  if (sameContents.ok) {
    // Counting it just created a marker for contents the first request never had; take it back out.
    await clearRateLimit(contents);
    return { state: "different_body", release: async () => undefined };
  }
  return { state: "repeat", release: async () => undefined };
}
