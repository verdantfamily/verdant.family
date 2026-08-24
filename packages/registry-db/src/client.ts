/**
 * The connection to the registry's own Postgres.
 *
 * `REGISTRY_DATABASE_URL`, and deliberately not `DATABASE_URL`. Ponder takes its connection from
 * `DATABASE_URL` and Railway sets one per service, so a deployment that shared the name could
 * point the registry at an indexer's database — where its migration would create four tables
 * inside a schema Ponder rebuilds from the start block on every reindex. The distinct name is
 * what makes decision 1's "separate from both Ponder databases" a property of the code rather
 * than something to remember. `boundaries.test.ts` asserts the other name never appears.
 *
 * The value is a secret and lives in `.env`, which is gitignored along with `.env.*`. Nothing
 * here logs it, and the errors below name the variable rather than its contents.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.js";
import type { RegistryDatabase } from "./programs.js";

export const REGISTRY_DATABASE_URL_VAR = "REGISTRY_DATABASE_URL";

/**
 * Whether this build has somewhere to store Programs.
 *
 * Exported so a caller can decide what to do about its absence once, at the edge, rather than
 * discovering it when a query throws. A route reads it and serves an empty list with a clear
 * status; the backfill reads it and refuses to start.
 */
export function registryConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[REGISTRY_DATABASE_URL_VAR] ?? "").trim() !== "";
}

export interface RegistryClient {
  readonly db: RegistryDatabase;
  readonly close: () => Promise<void>;
}

/**
 * Open a pool against the registry database.
 *
 * A pool rather than a single connection because the read route is served by a process handling
 * concurrent requests, and `pg` reuses connections across them. The backfill takes one connection
 * out of it for the length of its transaction, which is correct: the whole run is one transaction
 * and must not be spread across two connections.
 *
 * Throws rather than defaulting when the variable is unset. A registry silently pointed at a local
 * default would be a registry that appears to work and stores nothing.
 */
export function registryClient(env: NodeJS.ProcessEnv = process.env): RegistryClient {
  const url = (env[REGISTRY_DATABASE_URL_VAR] ?? "").trim();

  if (url === "") {
    throw new Error(
      `${REGISTRY_DATABASE_URL_VAR} is not set. The Program registry has its own Postgres, ` +
        `separate from both indexers, and there is no default worth guessing.`,
    );
  }

  const pool = new Pool({ connectionString: url });

  return {
    db: drizzle(pool, { schema }),
    close: async () => {
      await pool.end();
    },
  };
}
