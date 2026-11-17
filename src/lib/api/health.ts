/** What /api/health reports. Booleans only: this is readable by anyone. */
import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { env } from "@/lib/env";

export interface Health {
  ok: boolean;
  database: boolean;
  integrations: {
    /** Signing requests are emailed. When false, links are shown for sharing by hand. */
    email: boolean;
    /** Fields are found with the AI model as well as the built-in rules. */
    ai_field_detection: boolean;
    /** The scheduled-jobs endpoint has its secret. */
    cron: boolean;
  };
}

const DATABASE_TIMEOUT_MS = 5_000;

async function databaseReachable(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A health check that hangs with the database is no use to a monitor.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), DATABASE_TIMEOUT_MS);
    });
    const probe = (async () => {
      const db = await getDb();
      await db.execute(sql`select 1`);
    })();
    await Promise.race([probe, timeout]);
    return true;
  } catch (err) {
    console.error("[health] database check failed", err instanceof Error ? err.message : err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkHealth(): Promise<Health> {
  const database = await databaseReachable();
  return {
    ok: database,
    database,
    integrations: {
      email: env.emailConfigured,
      ai_field_detection: Boolean(env.anthropicApiKey),
      cron: Boolean(env.cronSecret),
    },
  };
}
