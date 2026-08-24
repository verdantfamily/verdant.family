/**
 * Test doubles for launch attempts, built from M0's fixture.
 *
 * Beside `fixtures.ts` rather than inside it. That module is M1's and is imported by M1's suites,
 * so extending it would mean editing a file whose current behaviour other tests depend on; a
 * second module composes with it instead — `snapshotWithAttempts` calls M1's `snapshot` rather
 * than restating its queries, so the two cannot disagree about the four Program tables.
 *
 * Everything here derives from `packages/registry/src/fixtures/mainnet-engine-markets.json`, the
 * two live engine markets whose `configHash`es were recovered from their launch calldata and
 * checked against the hook's own derivation. Nothing is invented except where a case the chain
 * does not contain has to be constructed, and each of those says so.
 */

import { decodeConfig } from "@verdant/market-engine";
import { deriveProgramIdentity } from "@verdant/registry";
import type { Hex } from "@verdant/registry";

import type { LaunchAttemptStatus, NewLaunchAttempt } from "../attempts.js";
import type { IndexerClient, IndexerMarket } from "../indexer.js";
import { snapshot } from "./fixtures.js";
import { applyMigrations, type Scratch } from "./scratch.js";
import mainnet from "../../../registry/src/fixtures/mainnet-engine-markets.json" with {
  type: "json",
};

type FixtureMarket = (typeof mainnet.markets)[number];

const LABELS = {
  launchedTokenSymbol: "",
  quoteAssetSymbol: "",
  quoteAssetDecimals: 18,
} as const;

export const CHAIN_ID = mainnet.chainId;
export const ENGINE_FACTORY = mainnet.engineFactory as Hex;

/** The two real markets, by symbol, so a test can say which one it means. */
export const CSCD = mainnet.markets[0] as FixtureMarket;
export const TAX = mainnet.markets[1] as FixtureMarket;

/**
 * A launch timestamp, derived from the block rather than recorded.
 *
 * The same derivation M1's `fixtures.ts` uses, and it has to be: a reconciliation asserted against
 * rows M1's helpers built would otherwise differ in `launched_at` alone. Robinhood Chain produces
 * a block roughly every hundred milliseconds, so this is not the real time and is never used as
 * one — it exists so the byte-identical assertions have a deterministic value to compare.
 */
export function launchedAt(market: FixtureMarket): number {
  return 1_756_000_000 + Math.floor(market.launchBlock / 10);
}

/** One fixture market as the indexer's route would report it. */
export function asIndexerMarket(market: FixtureMarket): IndexerMarket {
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

/**
 * The same economics, launched by somebody else.
 *
 * Constructed rather than taken from the fixture, because the chain does not contain this case:
 * both live markets have different economics and the same creator, and the case that matters for
 * the registry's central rule is the opposite one. `deployMarket` is permissionless and a
 * market's canonical configuration is public, so two people launching byte-identical economics is
 * expected rather than exceptional — decision 7 — and it must produce one Program with two
 * markets, each keeping its own lineage claim.
 *
 * Only the facts that are per-market are changed: the pool, the token, the creator, the
 * transaction and the block. The configuration bytes, the `configHash` and the
 * `implementationHash` are the original's, which is the whole point — a different
 * `implementationHash` would be a different engine or a different chain rather than a second
 * launch of the same Program.
 */
export function sameEconomicsOtherCreator(
  market: FixtureMarket,
  options: {
    readonly creator: Hex;
    readonly poolId?: Hex;
    readonly token?: Hex;
    readonly launchTx?: Hex;
    readonly launchBlock?: number;
  },
): IndexerMarket {
  const block = options.launchBlock ?? market.launchBlock + 5_000;
  const base = asIndexerMarket(market);

  return {
    ...base,
    poolId: options.poolId ?? (`0x${"c1".repeat(32)}` as Hex),
    token: options.token ?? (`0x${"c2".repeat(20)}` as Hex),
    creator: options.creator,
    index: market.marketIndex + 100,
    createdTx: options.launchTx ?? (`0x${"c3".repeat(32)}` as Hex),
    createdAtBlock: String(block),
    createdAt: 1_756_000_000 + Math.floor(block / 10),
  };
}

/** An indexer over exactly the markets a test names, in that order. */
export function indexerOver(markets: readonly IndexerMarket[]): IndexerClient {
  return {
    async *engineMarkets(): AsyncIterable<IndexerMarket> {
      for (const market of markets) {
        yield market;
      }
    },
  };
}

/** An indexer that has seen nothing, for the case where an attempt never landed. */
export function emptyIndexer(): IndexerClient {
  return indexerOver([]);
}

/**
 * The attempt `prepareEngineLaunch` would have written for one fixture market.
 *
 * `observedBlock` sits a hundred blocks below the launch, which is what the real thing records:
 * the chain head at the moment the calldata was prepared, which is necessarily at or before the
 * block the launch lands in. It is the origin of the bounded window decision 7 requires, and a
 * test that set it equal to the launch block would not be exercising the window at all.
 */
export function attemptFor(
  market: FixtureMarket,
  overrides: Partial<NewLaunchAttempt> = {},
): NewLaunchAttempt {
  const bytes = market.encodedConfig as Hex;
  const config = decodeConfig(bytes, LABELS);
  const identity = deriveProgramIdentity(config);

  return {
    id: `attempt-${market.symbol.toLowerCase()}`,
    jobId: `00000000-0000-4000-8000-0000000000${String(market.marketIndex).padStart(2, "0")}`,
    chainId: CHAIN_ID,
    configHash: identity.configHash,
    implementationHash: market.implementationHash.toLowerCase() as Hex,
    encodedConfig: bytes,
    schemaVersion: identity.schemaVersion,
    creator: market.creator.toLowerCase() as Hex,
    feeReceiver: market.creator.toLowerCase() as Hex,
    factory: ENGINE_FACTORY.toLowerCase() as Hex,
    predictedVault: market.vault.toLowerCase() as Hex,
    calldataHash: `0x${"dd".repeat(32)}` as Hex,
    observedBlock: market.launchBlock - 100,
    lineage: null,
    preparedAt: launchedAt(market) - 60,
    ...overrides,
  };
}

/**
 * The current schema, against an empty scratch database.
 *
 * Delegates rather than naming migrations, which is the whole point of `applyMigrations`: this
 * helper used to apply `0000` and `0001` by name and would have silently stopped covering the
 * schema the moment a third existed.
 */
export async function migrate(scratch: Scratch): Promise<void> {
  await applyMigrations(scratch);
}

/**
 * Every row in all five tables, as one deterministic string.
 *
 * M1's `snapshot` for the four Program tables, unchanged and delegated to rather than reimplemented,
 * plus `launch_attempts` with an explicit column list and an explicit order. `updated_at` is
 * included deliberately: an idempotent second run must not touch a row it has already settled, and
 * a snapshot that omitted the column would not notice if it did.
 */
export async function snapshotWithAttempts(scratch: Scratch): Promise<string> {
  const programs = await snapshot(scratch);

  const attempts = await scratch.db.execute<Record<string, unknown>>(
    `select id, job_id, chain_id, config_hash, implementation_hash, encoded_config,
            schema_version, creator, fee_receiver, factory, predicted_vault,
            calldata_hash, observed_block, lineage_parent_config_hash, lineage_kind,
            status, tx_hash, prepared_at, sent_at, updated_at, error
     from launch_attempts order by id`,
  );

  return `${programs}\nlaunch_attempts: ${JSON.stringify(attempts.rows)}`;
}

/** The status of one attempt, for a test that cares only about where it ended up. */
export async function statusOf(scratch: Scratch, id: string): Promise<LaunchAttemptStatus | null> {
  const rows = await scratch.db.execute<{ status: string }>(
    `select status from launch_attempts where id = '${id}'`,
  );

  const status = rows.rows[0]?.status;
  return status === undefined ? null : (status as LaunchAttemptStatus);
}

/** How many rows one table holds, for the assertions that are about absence. */
export async function countRows(scratch: Scratch, table: string): Promise<number> {
  const rows = await scratch.db.execute<{ count: string }>(
    `select count(*)::text as count from ${table}`,
  );

  return Number(rows.rows[0]?.count ?? "0");
}
