/**
 * Test doubles, built from M0's fixture.
 *
 * The fixture is `packages/registry/src/fixtures/mainnet-engine-markets.json` — the two live
 * engine markets, whose `configHash`es were recovered from their launch calldata and checked
 * against the hook's own derivation. It is imported by path rather than copied, so there is one
 * record of what the chain said and these doubles cannot drift from it.
 */

import { decodeConfig } from "@verdant/market-engine";
import { dedupeKeyFor, deriveProgramIdentity } from "@verdant/registry";
import type { Hex, Program, ProgramVersion } from "@verdant/registry";

import type { IndexerClient, IndexerMarket } from "../indexer.js";
import type { Scratch } from "./scratch.js";
import mainnet from "../../../registry/src/fixtures/mainnet-engine-markets.json" with {
  type: "json",
};

type FixtureMarket = (typeof mainnet.markets)[number];

const LABELS = {
  launchedTokenSymbol: "",
  quoteAssetSymbol: "",
  quoteAssetDecimals: 18,
} as const;

/**
 * A launch timestamp, derived from the block rather than recorded.
 *
 * The fixture captured what identifies a market and not when it was mined, because M0 needed only
 * the hashes. Robinhood Chain produces a block roughly every hundred milliseconds, so this is not
 * the real time and is not used as one — it exists so that `firstObservedAt` and `launchedAt` have
 * a deterministic value, which is what the byte-identical and round-trip assertions need.
 */
function launchedAt(market: FixtureMarket): number {
  return 1_756_000_000 + Math.floor(market.launchBlock / 10);
}

/** One fixture market as the indexer's route would report it. */
function asIndexerMarket(market: FixtureMarket): IndexerMarket {
  return {
    poolId: market.poolId,
    index: market.marketIndex,
    token: market.token,
    creator: market.creator,
    implementationHash: market.implementationHash,
    createdAt: launchedAt(market),
    createdAtBlock: String(market.launchBlock),
    createdTx: market.launchTx,
    engine: {
      version: market.engineVersion,
      hash: market.configHash,
      config: market.encodedConfig,
    },
  };
}

export interface FakeIndexerOptions {
  /** Serve only the first N markets, to stand in for a registry that has grown since. */
  readonly only?: number;
  /** Blank the config bytes on one market, as the indexer does when it cannot prove them. */
  readonly blankConfigAt?: number;
  /** Leave the bytes intact but state a hash they do not produce. */
  readonly corruptHashAt?: number;
  /** How many markets a page holds. One, so a page boundary falls between the two. */
  readonly pageSize?: number;
}

/**
 * The indexer, without a network.
 *
 * Pages like the real client so the backfill is exercised across a page boundary, which is what
 * makes a mid-run failure expressible.
 */
export function fakeIndexer(options: FakeIndexerOptions = {}): IndexerClient {
  const rows = mainnet.markets
    .slice(0, options.only ?? mainnet.markets.length)
    .map((market, at) => {
      const row = asIndexerMarket(market);
      if (options.blankConfigAt === at) {
        return { ...row, engine: { ...row.engine, config: null } };
      }
      if (options.corruptHashAt === at) {
        return { ...row, engine: { ...row.engine, hash: `0x${"ab".repeat(32)}` } };
      }
      return row;
    });

  return {
    async *engineMarkets(): AsyncIterable<IndexerMarket> {
      for (const row of rows) {
        yield row;
      }
    },
  };
}

export interface FailingIndexerOptions {
  /** Which page to fail on, counting from 1. Earlier pages are served normally. */
  readonly failOnPage: number;
  readonly message?: string;
  /** Markets per page. One by default, so failing on page 2 means one market was written. */
  readonly pageSize?: number;
}

/**
 * An indexer that serves some markets and then fails.
 *
 * The point of the whole atomicity argument: by the time this throws, the backfill has already
 * written a Program inside its transaction. A test that failed on the first page would prove
 * nothing, because there would have been nothing to roll back.
 */
export interface FailingIndexer extends IndexerClient {
  /**
   * How many markets were handed over before it failed.
   *
   * Read by the test so the atomicity claim is checked rather than inferred: if this is zero, the
   * transaction had nothing in it and "no rows afterwards" would prove nothing at all.
   */
  readonly yielded: () => number;
}

export function failingIndexer(options: FailingIndexerOptions): FailingIndexer {
  const pageSize = options.pageSize ?? 1;
  const message = options.message ?? "the indexer could not be reached";
  const served = (options.failOnPage - 1) * pageSize;
  let count = 0;

  return {
    yielded: () => count,
    async *engineMarkets(): AsyncIterable<IndexerMarket> {
      for (const market of mainnet.markets) {
        if (count >= served) throw new Error(message);
        yield asIndexerMarket(market);
        count += 1;
      }

      if (count >= served) throw new Error(message);
    },
  };
}

/** One fixture market as the `Program` and `ProgramVersion` the backfill would derive. */
export function programFromFixture(market: FixtureMarket): {
  readonly program: Program;
  readonly version: ProgramVersion;
} {
  const bytes = market.encodedConfig as Hex;
  const config = decodeConfig(bytes, LABELS);
  const identity = deriveProgramIdentity(config);
  const at = launchedAt(market);

  const marketRef = {
    chainId: mainnet.chainId,
    poolId: market.poolId.toLowerCase() as Hex,
    token: market.token.toLowerCase() as Hex,
    marketIndex: market.marketIndex,
    engineVersion: identity.schemaVersion,
    configHash: identity.configHash,
    implementationHash: market.implementationHash.toLowerCase() as Hex,
    launchTx: market.launchTx.toLowerCase() as Hex,
    launchBlock: market.launchBlock,
    launchedAt: at,
  } as const;

  return {
    program: {
      configHash: identity.configHash,
      schemaVersion: identity.schemaVersion,
      dedupeKey: dedupeKeyFor(config),
      author: {
        address: market.creator.toLowerCase() as Hex,
        handle: null,
        displayName: null,
      },
      name: null,
      firstObservedAt: at,
      firstObservedIn: marketRef,
      markets: [marketRef],
    },
    version: {
      configHash: identity.configHash,
      rootConfigHash: identity.configHash,
      schemaVersion: identity.schemaVersion,
      encodedConfig: bytes,
      ordinal: 0,
      createdAt: at,
    },
  };
}

/**
 * Every row in every registry table, as one deterministic string.
 *
 * "Byte-identical table state" needs a comparison that cannot pass by accident, so this reads all
 * four tables — including `program_lineage`, which must stay empty — with an explicit column list
 * and an explicit order. Selecting `*` would make the comparison depend on column order, and
 * omitting the order would make it depend on whatever the planner returned.
 */
export async function snapshot(scratch: Scratch): Promise<string> {
  const queries: readonly (readonly [string, string])[] = [
    [
      "programs",
      `select config_hash, schema_version, dedupe_key, author_address, name, description,
              first_observed_at, first_observed_chain_id, first_observed_pool_id
       from programs order by config_hash`,
    ],
    [
      "program_versions",
      `select config_hash, root_config_hash, schema_version, encoded_config, ordinal, created_at
       from program_versions order by config_hash`,
    ],
    [
      "program_markets",
      `select chain_id, pool_id, config_hash, token, market_index, engine_version,
              implementation_hash, launch_tx, launch_block, launched_at
       from program_markets order by chain_id, pool_id`,
    ],
    [
      "program_lineage",
      `select parent_config_hash, child_config_hash, kind, author_address, created_at
       from program_lineage order by parent_config_hash, child_config_hash`,
    ],
  ];

  const parts: string[] = [];

  for (const [table, sql] of queries) {
    const result = await scratch.db.execute<Record<string, unknown>>(sql);
    parts.push(`${table}: ${JSON.stringify(result.rows)}`);
  }

  return parts.join("\n");
}
