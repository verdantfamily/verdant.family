/**
 * That the second migration applies and rolls back cleanly, on top of the first.
 *
 * The same argument `migrate.test.ts` makes for migration 0000: drizzle-kit generates forward
 * migrations only, so the reverse is hand-written, and hand-written SQL that nothing executes is SQL
 * that is wrong.
 *
 * What is different here, and is the reason this is a separate file rather than more cases in that
 * one, is that 0001 is applied to a database that already holds Programs. "Cleanly" therefore means
 * something stronger than "returns to empty": rolling back `launch_attempts` must leave every
 * Program row, index and constraint from 0000 exactly as it was. A reverse migration that took the
 * registry down with the record of intent would be worse than no reverse migration at all.
 */

import { describe, expect, it } from "vitest";

import { ALL_TABLES, ATTEMPT_TABLES, PROGRAM_TABLES, attemptsDownSql, attemptsUpSql, upSql } from "./migrate.js";
import { reserveAttempt } from "./attempts.js";
import { scratchDatabase, tableNames, type Scratch } from "./testing/scratch.js";
import { CSCD, attemptFor, countRows } from "./testing/attempt-fixtures.js";

async function withScratch(body: (scratch: Scratch) => Promise<void>): Promise<void> {
  const scratch = await scratchDatabase();
  try {
    await body(scratch);
  } finally {
    await scratch.close();
  }
}

describe("the launch_attempts migration", () => {
  it("adds exactly one table to the four the registry already has", async () => {
    await withScratch(async (scratch) => {
      await scratch.execute(upSql());
      expect(await tableNames(scratch)).toEqual([...PROGRAM_TABLES].sort());

      await scratch.execute(attemptsUpSql());

      expect(await tableNames(scratch)).toEqual([...ALL_TABLES].sort());
      expect(ATTEMPT_TABLES).toEqual(["launch_attempts"]);
    });
  });

  it("leaves the Program tables untouched on rollback", async () => {
    await withScratch(async (scratch) => {
      await scratch.execute(upSql());
      await scratch.execute(attemptsUpSql());
      await scratch.execute(attemptsDownSql());

      expect(await tableNames(scratch)).toEqual([...PROGRAM_TABLES].sort());
    });
  });

  it("leaves none of its own indexes behind on rollback", async () => {
    await withScratch(async (scratch) => {
      await scratch.execute(upSql());
      await scratch.execute(attemptsUpSql());
      await scratch.execute(attemptsDownSql());

      const indexes = await scratch.db.execute<{ indexname: string }>(
        `select indexname from pg_indexes where schemaname = 'public'`,
      );
      const constraints = await scratch.db.execute<{ conname: string }>(
        `select conname from pg_constraint c
         join pg_namespace n on n.oid = c.connamespace
         where n.nspname = 'public'`,
      );

      const leftovers = [
        ...indexes.rows.map((row) => row.indexname),
        ...constraints.rows.map((row) => row.conname),
      ].filter((name) => name.includes("launch_attempt"));

      expect(leftovers).toEqual([]);
    });
  });

  it("can be applied again after a rollback", async () => {
    await withScratch(async (scratch) => {
      await scratch.execute(upSql());
      await scratch.execute(attemptsUpSql());
      await scratch.execute(attemptsDownSql());
      await scratch.execute(attemptsUpSql());

      expect(await tableNames(scratch)).toEqual([...ALL_TABLES].sort());
      expect(await countRows(scratch, "launch_attempts")).toBe(0);
    });
  });

  it("ships launch_attempts empty but present", async () => {
    await withScratch(async (scratch) => {
      await scratch.execute(upSql());
      await scratch.execute(attemptsUpSql());

      expect(await countRows(scratch, "launch_attempts")).toBe(0);
    });
  });

  it("does not reference programs in either direction", async () => {
    /*
     * The absence that makes decision 5 possible. An attempt is written before the Program it will
     * create exists, so a foreign key into `programs` would make every first launch of a new
     * configuration fail — which is every launch that matters. Asserted against the catalogue rather
     * than trusted from `schema.ts`, because this is the constraint most likely to look like an
     * oversight to somebody tidying the schema later.
     */
    await withScratch(async (scratch) => {
      await scratch.execute(upSql());
      await scratch.execute(attemptsUpSql());

      const keys = await scratch.db.execute<{ conname: string; definition: string }>(
        `select c.conname, pg_get_constraintdef(c.oid) as definition
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = c.connamespace
         where n.nspname = 'public' and c.contype = 'f'
           and (t.relname = 'launch_attempts' or pg_get_constraintdef(c.oid) like '%launch_attempts%')`,
      );

      expect(keys.rows).toEqual([]);
    });
  });

  it("does not constrain which engine version an attempt may be", async () => {
    // Decision D1 from M1, still standing: a market's engine version is data, and a
    // `check (schema_version = 1)` would be correct today and need migrating away when v2 ships.
    await withScratch(async (scratch) => {
      await scratch.execute(upSql());
      await scratch.execute(attemptsUpSql());

      const checks = await scratch.db.execute<{ definition: string }>(
        `select pg_get_constraintdef(c.oid) as definition
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = c.connamespace
         where n.nspname = 'public' and c.contype = 'c' and t.relname = 'launch_attempts'`,
      );

      for (const { definition } of checks.rows) {
        expect(definition).not.toMatch(/schema_version|engine_version/);
      }
    });
  });
});

describe("the constraints the attempt table does carry", () => {
  it("refuses a status outside the X path's vocabulary", async () => {
    await withScratch(async (scratch) => {
      await scratch.execute(upSql());
      await scratch.execute(attemptsUpSql());
      await reserveAttempt(scratch.db, attemptFor(CSCD));

      await expect(
        scratch.db.execute(`update launch_attempts set status = 'abandoned'`),
      ).rejects.toThrow();
    });
  });

  it("refuses half a lineage claim", async () => {
    await withScratch(async (scratch) => {
      await scratch.execute(upSql());
      await scratch.execute(attemptsUpSql());
      await reserveAttempt(scratch.db, attemptFor(CSCD));

      // A parent with no kind. Not a partial claim to be tolerated — a claim whose kind was lost is
      // a claim that would be written as the wrong sort of edge.
      await expect(
        scratch.db.execute(
          `update launch_attempts set lineage_parent_config_hash = '0x${"55".repeat(32)}'`,
        ),
      ).rejects.toThrow();

      await expect(
        scratch.db.execute(`update launch_attempts set lineage_kind = 'REVISION'`),
      ).rejects.toThrow();
    });
  });

  it("refuses a lineage kind that is not one of the two", async () => {
    await withScratch(async (scratch) => {
      await scratch.execute(upSql());
      await scratch.execute(attemptsUpSql());
      await reserveAttempt(scratch.db, attemptFor(CSCD));

      await expect(
        scratch.db.execute(
          `update launch_attempts
           set lineage_parent_config_hash = '0x${"55".repeat(32)}', lineage_kind = 'DERIVED'`,
        ),
      ).rejects.toThrow();
    });
  });

  it("accepts a complete claim", async () => {
    await withScratch(async (scratch) => {
      await scratch.execute(upSql());
      await scratch.execute(attemptsUpSql());

      // The control for the three refusals above, which a table that rejected every update would
      // satisfy without expressing any of the intended rules.
      await reserveAttempt(
        scratch.db,
        attemptFor(CSCD, {
          lineage: { parentConfigHash: `0x${"55".repeat(32)}`, kind: "FORK" },
        }),
      );

      expect(await countRows(scratch, "launch_attempts")).toBe(1);
    });
  });
});
