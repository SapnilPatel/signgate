/** Who may run the scheduled jobs over HTTP. */
import "server-only";
import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { sha256Hex } from "@/lib/ids";

export interface CronRefusal {
  status: 401 | 503;
  code: "unauthenticated" | "not_configured";
  message: string;
  headers: Record<string, string>;
}

/**
 * Returns null when the caller may run the jobs, or the refusal to answer with.
 *
 * - CRON_SECRET set: only "Authorization: Bearer <CRON_SECRET>" is accepted, which is
 *   exactly what Vercel Cron sends.
 * - CRON_SECRET unset in production: refused. An open endpoint that sends email and
 *   retries webhooks is not something to leave to chance on a public deployment.
 * - CRON_SECRET unset elsewhere: allowed, so the jobs can be run by hand while developing.
 */
export function authorizeCron(authorization: string | null): CronRefusal | null {
  const secret = env.cronSecret;
  if (!secret) {
    if (!env.isProduction) return null;
    return {
      status: 503,
      code: "not_configured",
      message: "Scheduled jobs are switched off because CRON_SECRET is not set. Set it in the deployment's environment variables and redeploy.",
      headers: {},
    };
  }
  const sent = /^\s*Bearer\s+(\S+)\s*$/i.exec(authorization ?? "")?.[1] ?? "";
  // Hashed first so both sides have the same length, which timingSafeEqual requires.
  const same = timingSafeEqual(Buffer.from(sha256Hex(sent), "hex"), Buffer.from(sha256Hex(secret), "hex"));
  if (same) return null;
  return {
    status: 401,
    code: "unauthenticated",
    message: "This endpoint runs scheduled jobs and needs the deployment's cron secret.",
    headers: { "WWW-Authenticate": 'Bearer realm="Signgate cron"' },
  };
}
