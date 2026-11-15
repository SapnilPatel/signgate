import path from "node:path";
import { mkdirSync } from "node:fs";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

/**
 * One database handle type for the whole app. In production this is node-postgres
 * against Neon; with no DATABASE_URL it is PGlite (Postgres compiled to WASM), so
 * the app and its tests run with zero setup. Both speak the same SQL dialect and
 * expose the same Drizzle API, so the PGlite handle is safely viewed as this type.
 */
export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Accepted by helpers that work both inside and outside a transaction. */
export type DbOrTx = Db | Tx;

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

type Cache = { promise?: Promise<Db> };
const globalCache = globalThis as unknown as { __signgateDb?: Cache };
const cache: Cache = (globalCache.__signgateDb ??= {});

async function connect(): Promise<Db> {
  const url = process.env.DATABASE_URL;

  if (url) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({
      connectionString: url,
      // Serverless instances each hold their own pool; keep it small and let the
      // provider's pooler (Neon pgbouncer) do the multiplexing.
      max: Number(process.env.DATABASE_POOL_MAX ?? 5),
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 10_000,
    });
    // Migrations for hosted Postgres run in the build step (npm run db:migrate),
    // never at request time.
    return drizzle(pool, { schema });
  }

  if (process.env.VERCEL) {
    throw new Error("DATABASE_URL is not set. Add a Postgres connection string to the deployment.");
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");

  // Tests get a private in-memory database; local dev persists to .data/.
  const inMemory = process.env.NODE_ENV === "test" || process.env.PGLITE_MEMORY === "1";
  let client;
  if (inMemory) {
    client = new PGlite();
  } else {
    const dir = path.join(process.cwd(), ".data", "pglite");
    mkdirSync(dir, { recursive: true });
    client = new PGlite(dir);
  }
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db as unknown as Db;
}

/** Returns the shared database handle, connecting (and, for PGlite, migrating) on first use. */
export function getDb(): Promise<Db> {
  if (!cache.promise) {
    cache.promise = connect().catch((err) => {
      cache.promise = undefined;
      throw err;
    });
  }
  return cache.promise;
}

/** Test helper: drop the cached handle so the next getDb() starts a fresh in-memory database. */
export function resetDbForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("resetDbForTests is only for tests");
  cache.promise = undefined;
}

export { schema };
