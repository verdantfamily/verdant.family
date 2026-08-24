/**
 * Acceptance tests 6 and 7 — that the boundary between this package and Ponder holds, and that
 * M0's purity is untouched.
 *
 * The boundary is the point of the whole arrangement. Ponder owns the chain observations and
 * owns its own schema: it renames a column, adds a table, or re-keys one when a shared hook
 * turns out not to identify a market — all of which have happened in this repository. If the
 * registry read those tables, any of those changes would break it, and the failure would be a
 * query returning nothing rather than an error, which is the kind that ships.
 *
 * So chain facts arrive over HTTP, through a response shape the indexer publishes deliberately,
 * and this test asserts that no shortcut has been taken since.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

/**
 * A file's code, with its comments removed.
 *
 * The checks below are about what this package *does*, not what it talks about. `schema.ts`
 * explains the separation from Ponder by naming `agen_component` and the re-keying that motivated
 * it, and `client.ts` explains the variable name by naming Ponder's — both are the most useful
 * sentences in those files, and a substring check over raw text would force them to be deleted to
 * stay green. That would trade real documentation for an easier assertion.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const files = sourceFiles(root).map((path) => ({
  name: relative(root, path),
  source: readFileSync(path, "utf8"),
  code: code(readFileSync(path, "utf8")),
}));

/**
 * Everything except this file.
 *
 * A test that checks for forbidden names has to contain them, in `PONDER_TABLES` below, as real
 * code rather than as a comment. Excluding one file by name rather than excluding every test file,
 * so a genuine Ponder read in some other suite would still be caught.
 */
const checked = files.filter(({ name }) => name !== "boundaries.test.ts");

/**
 * Every table Ponder owns, in both indexers.
 *
 * Listed here rather than imported from `apps/indexer/ponder.schema.ts`, because importing it
 * would be the very coupling this test exists to forbid. The cost is that a table added to
 * Ponder is not automatically added here — acceptable, because the check is against *this*
 * package's source and a new Ponder table it has never heard of is not a name it can contain.
 */
const PONDER_TABLES = [
  "pool_init",
  "market_contract",
  "fee_collection",
  "vesting_release",
  "agent_contract",
  "agent_service",
  "agent_revenue",
  "agent_treasury_asset",
  "agent_activity",
  "agen_market",
  "agen_swap",
  "agen_pending_fee",
  "agen_component",
  "instant_market",
  "instant_swap",
  "boost_buyback",
] as const;

/**
 * The Ponder table names that are ordinary English words.
 *
 * `market`, `swap`, `claim`, `holder` and `agent` are all table names and all words that appear
 * legitimately in prose and in identifiers — `marketCount`, `markets`, `MarketRef`. Matching them
 * as bare substrings would fail on this package's own documentation. They are matched as SQL
 * identifiers instead: quoted, or following a `from`/`join`/`into`/`update`.
 */
const AMBIGUOUS_PONDER_TABLES = ["market", "swap", "claim", "holder", "agent"] as const;

describe("acceptance test 6: no reference to Ponder's tables or its database", () => {
  it("finds source to check, so the assertions below are not vacuous", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("names none of Ponder's tables in code", () => {
    const offenders = checked.flatMap((file) =>
      PONDER_TABLES.filter((table) => file.code.includes(table)).map(
        (table) => `${file.name} references "${table}"`,
      ),
    );

    expect(offenders).toEqual([]);
  });

  it("does not query Ponder's tables whose names are ordinary words", () => {
    const offenders = checked.flatMap((file) =>
      AMBIGUOUS_PONDER_TABLES.filter((table) =>
        // Only in a SQL clause position, optionally quoted. A bare quoted word is not enough:
        // `market ${poolId} has no...` is an error message, and `it(\`market 0 (CSCD)\`)` is a
        // test name. Reading one of Ponder's tables through drizzle would need its table object
        // imported, which the import check above already forbids.
        new RegExp(
          `\\b(?:from|join|into|update)\\s+["'\`]?${table}\\b`,
          "i",
        ).test(file.code),
      ).map((table) => `${file.name} queries "${table}"`),
    );

    expect(offenders).toEqual([]);
  });

  it("does not read Ponder's own connection variable", () => {
    /*
     * Ponder takes its connection from the unprefixed variable and Railway sets one per service.
     * This package reads `REGISTRY_DATABASE_URL`, so a deployment cannot accidentally point the
     * registry at an indexer's database — decision 1's "separate from both Ponder databases" is
     * enforced by the variable name rather than by remembering.
     */
    const offenders = checked
      .filter((file) => /(?<!REGISTRY_)DATABASE_URL/.test(file.code))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it("imports nothing from an app, and no ponder virtual module", () => {
    const specifiers = checked.flatMap((file) =>
      [...file.code.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => ({
        name: file.name,
        from: match[1] ?? "",
      })),
    );

    const offenders = specifiers.filter(
      ({ from }) =>
        from.includes("apps/") ||
        from.startsWith("ponder:") ||
        from === "ponder" ||
        /^@verdant\/(agen|web|landing|indexer|instant-indexer)\b/.test(from),
    );

    expect(offenders).toEqual([]);
  });

  it("reaches the indexer only over HTTP", () => {
    const client = files.find(({ name }) => name === "indexer.ts");
    expect(client, "indexer.ts should exist and own the HTTP boundary").toBeDefined();
    expect(client?.source).toMatch(/fetch/);
  });
});

describe("acceptance test 7: M0's registry stays pure", () => {
  /**
   * Asserted from here as well as from M0's own suite, because the failure mode is this
   * package: the temptation once a database exists is to reach back into `packages/registry` and
   * give it a query helper. M0's `boundaries.test.ts` would catch it, and so will this.
   */
  const registrySource = sourceFiles(join(root, "../../registry/src")).map((path) => ({
    name: relative(join(root, "../../registry"), path),
    source: readFileSync(path, "utf8"),
  }));

  const FORBIDDEN = [
    "drizzle-orm",
    "drizzle-kit",
    "ponder",
    "pg",
    "postgres",
    "@electric-sql/pglite",
    "kysely",
    "prisma",
  ] as const;

  it("finds M0's source to check", () => {
    expect(registrySource.length).toBeGreaterThan(0);
  });

  it("has no database import", () => {
    const offenders = registrySource.flatMap(({ name, source }) =>
      [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)]
        .map((match) => match[1] ?? "")
        .filter((from) => FORBIDDEN.some((dep) => from === dep || from.startsWith(`${dep}/`)))
        .map((from) => `${name} imports ${from}`),
    );

    expect(offenders).toEqual([]);
  });

  it("does not import this package", () => {
    const offenders = registrySource
      .filter(({ source }) => source.includes("@verdant/registry-db"))
      .map(({ name }) => name);

    expect(offenders).toEqual([]);
  });

  it("declares no database dependency", () => {
    const manifest = JSON.parse(
      readFileSync(join(root, "../../registry/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@verdant/market-engine"]);
  });
});
