/**
 * That no suite pins itself to a migration number.
 *
 * This is the guard for a defect that had already happened and was invisible until a schema change
 * tripped over it. `roundtrip.test.ts` and `backfill.test.ts` each set their database up by calling
 * `upSql()` — migration `0000`, by name — which was correct when it was the only migration and
 * became wrong the moment there was a second. Nothing failed at the time, because `0001` added a
 * table those suites do not read.
 *
 * It surfaced on the third migration, and not as anything resembling its cause: eight assertions in
 * two suites failed with `column "slug" of relation "programs" does not exist`, in tests about
 * round-tripping a Program and about backfilling one, neither of which had any business knowing what
 * a slug is. The tests were right and their setup was a schema version behind.
 *
 * So the rule is that setup uses `applyMigrations`, which reads drizzle's own journal, and a suite
 * may name a migration only if that migration is its subject. Two suites qualify: `migrate.test.ts`
 * and `attempts-migrate.test.ts` exist to apply one migration alone and reverse it alone.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MIGRATION_TAGS } from "./migrate.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The suites whose subject is one migration.
 *
 * Listed rather than inferred from the filename, so adding `0002`'s own migration suite is a
 * deliberate line here rather than something a naming convention lets through.
 */
const MAY_NAME_A_MIGRATION = new Set([
  "migrate.test.ts",
  "attempts-migrate.test.ts",
  "migration-pinning.test.ts",
]);

function testFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const suites = testFiles(here).map((path) => ({
  name: relative(here, path),
  source: readFileSync(path, "utf8"),
}));

const checked = suites.filter(({ name }) => !MAY_NAME_A_MIGRATION.has(name));

describe("no suite pins itself to a migration", () => {
  it("finds suites to check, so the assertions below are not vacuous", () => {
    expect(suites.length).toBeGreaterThan(0);
    expect(checked.length).toBeGreaterThan(0);
  });

  it("uses no per-migration accessor for setup", () => {
    const offenders = checked
      .filter(({ source }) => /\b(upSql|downSql|attemptsUpSql|attemptsDownSql)\s*\(/.test(source))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it("names no migration tag", () => {
    const offenders = checked.flatMap((suite) =>
      MIGRATION_TAGS.filter((tag) => suite.source.includes(tag)).map(
        (tag) => `${suite.name} names "${tag}"`,
      ),
    );

    expect(offenders).toEqual([]);
  });

  it("applies every migration the journal lists, not a prefix of them", () => {
    /*
     * The property the helper exists for, checked against the files on disk rather than against a
     * count kept here. A migration whose SQL is committed but whose journal entry is missing would
     * otherwise never be applied by anything, and would fail only in production.
     */
    const generated = readdirSync(join(here, "../drizzle"))
      .filter((file) => file.endsWith(".sql") && !file.endsWith(".down.sql"))
      .map((file) => file.slice(0, -".sql".length))
      .sort();

    expect([...MIGRATION_TAGS].sort()).toEqual(generated);
  });

  it("has a hand-written reverse for every migration", () => {
    const missing = MIGRATION_TAGS.filter((tag) => {
      try {
        readFileSync(join(here, `../drizzle/${tag}.down.sql`), "utf8");
        return false;
      } catch {
        return true;
      }
    });

    expect(missing).toEqual([]);
  });
});
