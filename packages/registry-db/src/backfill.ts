/**
 * Building the registry from markets that already exist.
 *
 * Two Programs, on one chain, from three engine markets of which two are engine-1. That is the
 * whole population, and it is why this is deliberately the simple version: no batching, no
 * concurrency, no checkpoint table, and a count as the only report. Decision 5.
 *
 * ## Atomic, and what "resumable" means here
 *
 * The whole run is one transaction. So a failure of any kind — the indexer refusing on the second
 * page, a market whose bytes do not match its hash, the process dying — leaves the database
 * exactly as it was. There is no state in which a Program exists without the version and market
 * rows that explain it.
 *
 * That makes resumability a consequence rather than a mechanism. There is nothing to resume *to*,
 * because a failed run left nothing; re-running converges because every write is
 * `onConflictDoNothing` keyed on the identity the chain gave it. A checkpoint table would be the
 * alternative, and at this size it would be more moving parts than the thing it protects: it
 * would need its own migration, its own correctness argument about partially-applied progress,
 * and it would still have to be idempotent.
 *
 * The property that actually matters is convergence, and it holds in both directions — from
 * empty, and from a database that already holds some of the answer because a market launched
 * since the last run. Both are tested.
 *
 * ## Nothing is inferred and nothing is skipped
 *
 * A market that cannot be turned into a Program stops the run. The two ways that happens are a
 * missing `encodedConfig` — the indexer stores null where the bytes it recovered did not hash to
 * the hook's own `configHash` — and bytes that are present but disagree with the stated hash.
 * Neither is a market to skip past: the first means the chain facts are incomplete, the second
 * means something is wrong that a registry publishing economics must not paper over.
 */

import { configHash as hashOf, decodeConfig } from "@verdant/market-engine";
import { dedupeKeyFor, deriveProgramIdentity } from "@verdant/registry";
import type { Hex, Program, ProgramVersion, SchemaVersion } from "@verdant/registry";

import type { IndexerClient, IndexerMarket } from "./indexer.js";
import { saveProgram, type RegistryDatabase } from "./programs.js";

/**
 * What a run did. A count, and nothing more.
 *
 * `programs` counts distinct identities and `markets` counts markets, so two markets sharing
 * economics report as one Program and two markets — which is the only interesting thing this
 * report can say, and the reason the two numbers are separate.
 */
export interface BackfillResult {
  readonly programs: number;
  readonly versions: number;
  readonly markets: number;
}

export interface BackfillOptions {
  readonly db: RegistryDatabase;
  readonly indexer: IndexerClient;
  /** Which chain the indexer is following. `MarketRef` is keyed by it. */
  readonly chainId: number;
}

/**
 * Labels the commitment deliberately does not carry.
 *
 * `decodeConfig` needs a token symbol and the quote asset's symbol and decimals to return a whole
 * `CanonicalConfig`, and none of the three is inside `configHash` — two markets differing only in
 * what their token is called are the same Program. So they are supplied as placeholders rather
 * than fetched: fetching them would imply they mattered, and a reader who needs a symbol should
 * ask the indexer for the market, not the registry for the Program.
 *
 * That the identity is unaffected by these values is not an assumption. `identity.test.ts` in
 * `@verdant/registry` decodes the same fixtures with deliberately wrong labels and still matches
 * the on-chain hash.
 */
const LABELS = {
  launchedTokenSymbol: "",
  quoteAssetSymbol: "",
  quoteAssetDecimals: 18,
} as const;

export async function backfillPrograms(options: BackfillOptions): Promise<BackfillResult> {
  const { db, indexer, chainId } = options;

  const identities = new Set<string>();
  let markets = 0;

  await db.transaction(async (tx) => {
    for await (const market of indexer.engineMarkets()) {
      const { program, version } = programOf(market, chainId);

      await saveProgram(tx, { program, version });

      identities.add(program.configHash);
      markets += 1;
    }
  });

  return { programs: identities.size, versions: identities.size, markets };
}

/**
 * One indexed market as a Program and its first version.
 *
 * The identity comes from `@verdant/registry`, which gets it from `@verdant/market-engine`. This
 * function derives nothing itself — it decodes, delegates, and checks the answer against what the
 * hook said.
 *
 * Exported for `reconcile.ts`, which must produce byte-identical rows for the same market. Two
 * derivations of "what is this market's Program row" would mean a market's identity depended on
 * which path observed it first, and `reconcile.test.ts` asserts the two agree by comparing full
 * table snapshots. Sharing the function is what makes that assertion cheap to keep true.
 */
export function programOf(
  market: IndexerMarket,
  chainId: number,
): { readonly program: Program; readonly version: ProgramVersion } {
  const encoded = market.engine.config;
  const stated = market.engine.hash;

  if (stated === null) {
    throw new BackfillError(
      `market ${market.poolId} is engine ${String(market.engine.version)} but the indexer has no ` +
        `configHash for it, so it has no identity to record`,
    );
  }

  if (encoded === null) {
    throw new BackfillError(
      `market ${market.poolId} has no canonical config bytes. The indexer stores null when the ` +
        `bytes it recovered did not hash to the hook's own configHash, and a Program cannot be ` +
        `derived from an absence`,
    );
  }

  const bytes = encoded as Hex;
  const config = decodeConfig(bytes, LABELS);

  // The bytes are re-hashed and compared rather than trusted. The indexer performs this check
  // too; performing it again here is what makes this package's identities independently correct
  // rather than correct-if-the-indexer-was.
  const derived = hashOf(config);
  if (derived.toLowerCase() !== stated.toLowerCase()) {
    throw new BackfillError(
      `market ${market.poolId} states configHash ${stated} but its bytes hash to ${derived}. ` +
        `A configuration that does not match its commitment is not this market's configuration`,
    );
  }

  const identity = deriveProgramIdentity(config);
  const launchedAt = market.createdAt;

  const marketRef = {
    chainId,
    poolId: market.poolId.toLowerCase() as Hex,
    token: market.token.toLowerCase() as Hex,
    // Per market, and not the same fact as `Program.author` below. That one is whoever was observed
    // first; this one is who launched *this* market, which is what the claim rule reads.
    creator: market.creator.toLowerCase() as Hex,
    marketIndex: market.index,
    engineVersion: market.engine.version as SchemaVersion,
    configHash: identity.configHash,
    implementationHash: market.implementationHash.toLowerCase() as Hex,
    launchTx: market.createdTx.toLowerCase() as Hex,
    launchBlock: Number(market.createdAtBlock),
    launchedAt,
  } as const;

  const program: Program = {
    configHash: identity.configHash,
    schemaVersion: identity.schemaVersion,
    dedupeKey: dedupeKeyFor(config),
    author: {
      // Lowercased so one deployer is one key. EIP-55 case is a checksum, not data.
      address: market.creator.toLowerCase() as Hex,
      handle: null,
      displayName: null,
    },
    name: null,
    firstObservedAt: launchedAt,
    firstObservedIn: marketRef,
    markets: [marketRef],
  };

  const version: ProgramVersion = {
    configHash: identity.configHash,
    // Its own root. A backfilled Program has no parent, and inventing one would be inventing
    // lineage — which is exactly what `program_lineage` ships empty rather than guess at.
    rootConfigHash: identity.configHash,
    schemaVersion: identity.schemaVersion,
    encodedConfig: bytes,
    ordinal: 0,
    createdAt: launchedAt,
  };

  return { program, version };
}

export class BackfillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackfillError";
  }
}
