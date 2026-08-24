/**
 * Acceptance test 1 — that the first migration applies and rolls back cleanly.
 *
 * Rollback is asserted rather than assumed because drizzle-kit does not generate a down
 * migration, so the reverse is hand-written and hand-written SQL that nothing executes is SQL
 * that is wrong. "Cleanly" is taken to mean the database is returned to the state it was in
 * before the migration ran — no tables, no leftover types, no orphaned indexes — and that
 * applying it again afterwards works, which is what makes the reverse usable in an incident
 * rather than only in a test.
 */

import { describe, expect, it } from "vitest";

import { PROGRAM_TABLES, downSql, upSql } from "./migrate.js";
import { scratchDatabase, tableNames, type Scratch } from "./testing/scratch.js";

async function withScratch(body: (scratch: Scratch) => Promise<void>): Promise<void> {
  const scratch = await scratchDatabase();
  try {
    await body(scratch);
  } finally {
    await scratch.close();
  }
}

describe("acceptance test 1: the first migration applies and rolls back cleanly", () => {
  it("creates exactly the four registry tables", async () => {
    await withScratch(async (scratch) => {
      expect(await tableNames(scratch)).toEqual([]);

      await scratch.execute(upSql());

      expect(await tableNames(scratch)).toEqual([...PROGRAM_TABLES].sort());
    });
  });

  it("returns the database to empty on rollback", async () => {
    await withScratch(async (scratch) => {
      await scratch.execute(upSql());
      await scratch.execute(downSql());

      expect(await tableNames(scratch)).toEqual([]);
    });
  });

  it("leaves no indexes or constraints behind after rollback", async () => {
    await withScratch(async (scratch) => {
      await scratch.execute(upSql());
      await scratch.execute(downSql());

      const indexes = await scratch.db.execute<{ indexname: string }>(
        `select indexname from pg_indexes where schemaname = 'public'`,
      );
      const constraints = await scratch.db.execute<{ conname: string }>(
        `select conname from pg_constraint c
         join pg_namespace n on n.oid = c.connamespace
         where n.nspname = 'public'`,
      );

      expect(indexes.rows).toEqual([]);
      expect(constraints.rows).toEqual([]);
    });
  });

  it("can be applied again after a rollback", async () => {
    await withScratch(async (scratch) => {
      await scratch.execute(upSql());
      await scratch.execute(downSql());
      await scratch.execute(upSql());

      expect(await tableNames(scratch)).toEqual([...PROGRAM_TABLES].sort());
    });
  });

  it("ships program_lineage empty but present", async () => {
    await withScratch(async (scratch) => {
      await scratch.execute(upSql());

      const rows = await scratch.db.execute<{ count: string }>(
        `select count(*)::text as count from program_lineage`,
      );

      expect(PROGRAM_TABLES).toContain("program_lineage");
      expect(rows.rows[0]?.count).toBe("0");
    });
  });

  it("does not constrain which engine version a Program may be", async () => {
    /*
     * Decision 7. A `check (schema_version = 1)` would be correct today and would have to be
     * migrated away the day engine v2 ships, so its absence is asserted rather than left to
     * whoever writes the next migration to notice.
     */
    await withScratch(async (scratch) => {
      await scratch.execute(upSql());

      const checks = await scratch.db.execute<{ definition: string }>(
        `select pg_get_constraintdef(c.oid) as definition
         from pg_constraint c
         join pg_namespace n on n.oid = c.connamespace
         where n.nspname = 'public' and c.contype = 'c'`,
      );

      for (const { definition } of checks.rows) {
        expect(definition).not.toMatch(/schema_version|engine_version/);
      }
    });
  });
});
