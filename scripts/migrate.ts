/**
 * Applies pending SQL migrations to the hosted database. Runs in the build step
 * so a deployment never serves code against an older schema.
 */
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

async function main() {
  // Prefer a direct (non-pooled) connection for DDL when the host provides one.
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) {
    console.log("migrate: DATABASE_URL not set, skipping (local PGlite migrates on startup)");
    return;
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: path.join(process.cwd(), "drizzle") });
    console.log("migrate: database is up to date");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("migrate: failed", err);
  process.exit(1);
});
