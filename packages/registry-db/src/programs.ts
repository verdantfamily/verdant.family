/**
 * Reading and writing Programs.
 *
 * Plain functions over a drizzle handle, and deliberately not an interface. `JobStore` is the
 * repository's one persistence seam and it exists because the compiler pipeline has two
 * legitimate backings — a map for tests, files for a single process — and must not know which.
 * A Program registry has one backing, so a second seam would be indirection with nothing behind
 * it, and the milestone's instruction not to introduce a second persistence abstraction is the
 * right call.
 *
 * The types crossing this boundary are `@verdant/registry`'s, unchanged. Nothing here defines a
 * row shape of its own for callers to convert to and from: a `Program` goes in and a `Program`
 * comes out, which is what makes the round-trip test meaningful rather than a test of two
 * mappings agreeing with each other.
 */

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Hex, MarketRef, Program, ProgramVersion, SchemaVersion } from "@verdant/registry";

import { programMarkets, programVersions, programs } from "./schema.js";
import * as schema from "./schema.js";

/**
 * Anything that can run these queries.
 *
 * `PgTransaction` extends `PgDatabase`, so one type covers both a connection and a transaction
 * and the write functions below do not need to care which they were handed. The backfill hands
 * them a transaction; a caller writing one Program can hand them the database.
 */
export type RegistryDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface ProgramWrite {
  readonly program: Program;
  readonly version: ProgramVersion;
}

/**
 * Store a Program, its first version, and the market it was observed in.
 *
 * Idempotent, and the shape of that idempotence is the registry's central rule: **the first
 * observed hash owns the identity.** A second sighting of the same economics does nothing to the
 * `programs` row — not even to its `firstObservedAt` — and adds a row to `program_markets`. So
 * running this twice with the same input is a no-op, and running it for a second market that
 * happens to share economics attaches that market to the Program that already exists.
 *
 * `onConflictDoNothing` rather than an upsert, for that reason. An upsert would rewrite
 * `first_observed_at` and `author_address` to whichever launch was processed last, which would
 * make "who first published these economics" depend on iteration order.
 */
export async function saveProgram(db: RegistryDatabase, write: ProgramWrite): Promise<void> {
  const { program, version } = write;

  await db
    .insert(programs)
    .values({
      configHash: program.configHash,
      schemaVersion: program.schemaVersion,
      dedupeKey: program.dedupeKey,
      authorAddress: program.author.address,
      // Nullable and unpopulated by decision: names are outside the commitment and there is
      // nowhere to get one from yet.
      name: program.name,
      description: null,
      firstObservedAt: program.firstObservedAt,
      firstObservedChainId: program.firstObservedIn.chainId,
      firstObservedPoolId: program.firstObservedIn.poolId,
    })
    .onConflictDoNothing({ target: programs.configHash });

  await db
    .insert(programVersions)
    .values({
      configHash: version.configHash,
      rootConfigHash: version.rootConfigHash,
      schemaVersion: version.schemaVersion,
      encodedConfig: version.encodedConfig,
      ordinal: version.ordinal,
      createdAt: version.createdAt,
    })
    .onConflictDoNothing({ target: programVersions.configHash });

  for (const market of program.markets) {
    await db
      .insert(programMarkets)
      .values({
        chainId: market.chainId,
        poolId: market.poolId,
        configHash: market.configHash,
        token: market.token,
        // Absent on a `MarketRef` built before this field existed, and null is the right record of
        // that: an unknown author makes a claim undeterminable, which `claims.ts` refuses rather
        // than resolves.
        creator: market.creator ?? null,
        marketIndex: market.marketIndex,
        engineVersion: market.engineVersion,
        implementationHash: market.implementationHash,
        launchTx: market.launchTx,
        launchBlock: market.launchBlock,
        launchedAt: market.launchedAt,
      })
      .onConflictDoNothing({
        target: [programMarkets.chainId, programMarkets.poolId],
      });
  }
}

/** One Program by its identity, with every market known to run it, or null. */
export async function readProgram(
  db: RegistryDatabase,
  configHash: Hex,
): Promise<Program | null> {
  const rows = await db.select().from(programs).where(eq(programs.configHash, configHash)).limit(1);
  const row = rows[0];
  if (row === undefined) return null;

  const markets = await marketsFor(db, [row.configHash]);
  return assemble(row, markets.get(row.configHash) ?? []);
}

export interface ListOptions {
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Programs, newest first, each with its markets.
 *
 * Two queries rather than a join, and then assembled in memory. A join returns one row per
 * market and leaves the caller to group, which is the step that goes wrong; at two Programs the
 * cost of a second round trip is not worth reasoning about, and decision 5 is explicit that this
 * is not the milestone to optimise.
 */
export async function listPrograms(
  db: RegistryDatabase,
  options: ListOptions = {},
): Promise<readonly Program[]> {
  const rows = await db
    .select()
    .from(programs)
    .orderBy(desc(programs.firstObservedAt), asc(programs.configHash))
    .limit(options.limit ?? 100)
    .offset(options.offset ?? 0);

  if (rows.length === 0) return [];

  const markets = await marketsFor(
    db,
    rows.map((row) => row.configHash),
  );

  return rows.map((row) => assemble(row, markets.get(row.configHash) ?? []));
}

/** How many Programs exist. For a paged response's total, not for a page. */
export async function countPrograms(db: RegistryDatabase): Promise<number> {
  const rows = await db.select({ configHash: programs.configHash }).from(programs);
  return rows.length;
}

async function marketsFor(
  db: RegistryDatabase,
  configHashes: readonly string[],
): Promise<Map<string, MarketRef[]>> {
  const rows = await db
    .select()
    .from(programMarkets)
    .where(inArray(programMarkets.configHash, [...configHashes]))
    .orderBy(asc(programMarkets.launchBlock), asc(programMarkets.poolId));

  const byProgram = new Map<string, MarketRef[]>();

  for (const row of rows) {
    const refs = byProgram.get(row.configHash) ?? [];
    refs.push({
      chainId: row.chainId,
      poolId: row.poolId as Hex,
      token: row.token as Hex,
      /*
       * Spread rather than set, so a null column reads back as an absent field.
       *
       * `MarketRef.creator` is optional, and a row that has no creator must round-trip to a
       * `MarketRef` that has no creator — not to one carrying an explicit `null`, which is a
       * different value and would fail the equality M1's round-trip test asserts.
       */
      ...(row.creator === null ? {} : { creator: row.creator as Hex }),
      marketIndex: row.marketIndex,
      engineVersion: row.engineVersion as SchemaVersion,
      configHash: row.configHash as Hex,
      implementationHash: row.implementationHash as Hex,
      launchTx: row.launchTx as Hex,
      launchBlock: row.launchBlock,
      launchedAt: row.launchedAt,
    });
    byProgram.set(row.configHash, refs);
  }

  return byProgram;
}

/**
 * A row and its markets, as `@verdant/registry`'s `Program`.
 *
 * `firstObservedIn` is resolved out of `markets` rather than stored twice. The row keeps the
 * chain and pool that created the identity, and the full record is the market with that key —
 * which must exist, because the same write that created the Program created it. If it does not,
 * something deleted a market row without deleting its Program, and that is worth an error rather
 * than a fabricated reference.
 */
function assemble(
  row: typeof programs.$inferSelect,
  markets: readonly MarketRef[],
): Program {
  const firstObservedIn = markets.find(
    (market) =>
      market.chainId === row.firstObservedChainId && market.poolId === row.firstObservedPoolId,
  );

  if (firstObservedIn === undefined) {
    throw new Error(
      `program ${row.configHash} names ${row.firstObservedPoolId} on chain ` +
        `${String(row.firstObservedChainId)} as where it was first observed, but no such market ` +
        `row exists`,
    );
  }

  return {
    configHash: row.configHash as Hex,
    schemaVersion: row.schemaVersion as SchemaVersion,
    dedupeKey: row.dedupeKey,
    author: {
      address: row.authorAddress as Hex,
      // Null by decision, not by omission: handles and profiles are a later milestone, and there
      // is no on-chain fact behind either.
      handle: null,
      displayName: null,
    },
    name: row.name,
    firstObservedAt: row.firstObservedAt,
    firstObservedIn,
    markets,
  };
}

/** Re-exported so a caller can filter markets by chain without importing drizzle. */
export async function readProgramOnChain(
  db: RegistryDatabase,
  configHash: Hex,
  chainId: number,
): Promise<readonly MarketRef[]> {
  const program = await readProgram(db, configHash);
  if (program === null) return [];
  return program.markets.filter((market) => market.chainId === chainId);
}

/** Whether a set of economics has been seen before, under any spelling. See `dedupeKeyFor`. */
export async function findByDedupeKey(
  db: RegistryDatabase,
  dedupeKey: string,
): Promise<readonly Hex[]> {
  const rows = await db
    .select({ configHash: programs.configHash })
    .from(programs)
    .where(and(eq(programs.dedupeKey, dedupeKey)));

  return rows.map((row) => row.configHash as Hex);
}
