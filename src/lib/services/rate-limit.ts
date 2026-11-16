import { eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { rateLimits } from "@/lib/db/schema";
import { sha256Hex } from "@/lib/ids";

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the window resets; 0 when the call was allowed. */
  retryAfterSeconds: number;
}

const MAX_WINDOW_SECONDS = 30 * 86_400;
const MAX_KEY_LENGTH = 200;

function storedKey(key: string): string {
  // Keys embed user input (emails, IPs). Hashing long ones bounds the row size
  // without letting two different long keys share a counter.
  return key.length > MAX_KEY_LENGTH ? `h:${sha256Hex(key)}` : key;
}

/**
 * Fixed-window counter: allows `limit` calls per `windowSeconds` for `key`.
 *
 * The whole decision is one INSERT ... ON CONFLICT DO UPDATE, so two serverless
 * instances hitting the same key at the same moment cannot both read "4 of 5" and
 * both proceed. Window boundaries use the database clock, the one clock every
 * instance shares.
 *
 * Fails open if the database call itself fails: a broken counter must not lock
 * every customer out, and anything worth protecting needs the database anyway.
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const window = Math.min(MAX_WINDOW_SECONDS, Math.max(1, Math.floor(Number(windowSeconds)) || 1));
  const max = Math.floor(Number(limit));
  // A zero, negative or NaN limit means "never allowed", not "unlimited".
  if (!Number.isFinite(max) || max < 1) return { ok: false, retryAfterSeconds: window };

  try {
    const db = await getDb();
    const expired = sql`${rateLimits.resetAt} <= now()`;
    const [row] = await db
      .insert(rateLimits)
      .values({ key: storedKey(String(key)), count: 1, resetAt: sql`now() + ${window}::int * interval '1 second'` })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: {
          count: sql`case when ${expired} then 1 else ${rateLimits.count} + 1 end`,
          resetAt: sql`case when ${expired} then excluded.reset_at else ${rateLimits.resetAt} end`,
        },
      })
      .returning({
        count: rateLimits.count,
        retryAfter: sql<number>`ceil(extract(epoch from ${rateLimits.resetAt} - now()))::int`,
      });

    // Expired rows are only overwritten when the same key comes back; sweep the rest
    // now and then so one-off keys (random IPs) do not accumulate forever.
    if (Math.random() < 0.02) {
      await db.delete(rateLimits).where(lt(rateLimits.resetAt, sql`now() - interval '1 hour'`));
    }

    if (!row || row.count <= max) return { ok: true, retryAfterSeconds: 0 };
    return { ok: false, retryAfterSeconds: Math.max(1, Number(row.retryAfter) || 1) };
  } catch (err) {
    console.error("rateLimit: counter unavailable, allowing the request", err instanceof Error ? err.message : err);
    return { ok: true, retryAfterSeconds: 0 };
  }
}

/** Forgets a key, e.g. failed sign-in attempts once the right password is given. Never throws. */
export async function clearRateLimit(key: string): Promise<void> {
  try {
    const db = await getDb();
    await db.delete(rateLimits).where(eq(rateLimits.key, storedKey(String(key))));
  } catch {
    // Leaving a counter in place only makes the limit slightly stricter.
  }
}

/** "in 1 minute", "in 12 minutes": for rate-limit messages shown to people. */
export function describeWait(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes >= 120) return `in about ${Math.round(minutes / 60)} hours`;
  return minutes === 1 ? "in 1 minute" : `in ${minutes} minutes`;
}
