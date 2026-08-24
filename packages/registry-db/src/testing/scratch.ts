/**
 * A scratch database, for tests only.
 *
 * PGlite rather than a server: it is Postgres compiled to WebAssembly, so the migration under
 * test is parsed and executed by the real Postgres engine — `jsonb`, `numeric`, foreign keys,
 * `on conflict` and transactional DDL all behave as they will in production — while needing no
 * service, no container and no connection string. CI runs `turbo run test` with no `services:`
 * block, and a migration test that silently skipped when Postgres was absent would be a gate
 * that never fired.
 *
 * It is not a claim that PGlite and a Postgres server are interchangeable for everything.
 * Concurrency is the obvious difference — PGlite is single-connection — so nothing here tests
 * contention between two writers. What it does test is the schema, the migration and the
 * queries, which is what this package contains.
 *
 * Deliberately under `src/testing` and excluded from the package's exports: it imports a
 * devDependency, so anything shipping it to a consumer would be shipping a broken import.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { allUpSql } from "../migrate.js";
import * as schema from "../schema.js";

export interface Scratch {
  readonly db: ReturnType<typeof drizzle<typeof schema>>;
  /** For the migration test, which executes SQL files rather than typed queries. */
  readonly execute: (sql: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

export async function scratchDatabase(): Promise<Scratch> {
  const client = new PGlite();
  await client.waitReady;

  return {
    db: drizzle(client, { schema }),
    execute: async (sql) => {
      await client.exec(sql);
    },
    close: async () => {
      await client.close();
    },
  };
}

/**
 * Bring a scratch database up to the current schema.
 *
 * Every migration in drizzle's journal, in order — never a named one. A suite that applies a
 * specific migration is pinned to the schema as it was on the day it was written, and the failure
 * that produces arrives later, in a different test, as a missing column nobody was asking about.
 *
 * The two migration suites are the deliberate exception and do not use this: applying one migration
 * alone, and reversing it alone, is what they are testing.
 */
export async function applyMigrations(scratch: Scratch): Promise<void> {
  for (const sql of allUpSql()) {
    await scratch.execute(sql);
  }
}

/** A scratch database at the current schema, which is what almost every suite wants. */
export async function migratedDatabase(): Promise<Scratch> {
  const scratch = await scratchDatabase();
  await applyMigrations(scratch);
  return scratch;
}

/**
 * Every table in the registry's own schema, and nothing else.
 *
 * Read from the catalogue rather than from a list kept here, so a table added to the schema
 * without a migration — or dropped by a migration that was supposed to be reversible — shows up
 * as a difference rather than as a list somebody forgot to update.
 */
export async function tableNames(scratch: Scratch): Promise<readonly string[]> {
  const result = await scratch.db.execute<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name`,
  );

  return result.rows.map((row) => row.table_name);
}
