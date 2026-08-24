/**
 * Turning launches into Programs, and claims into lineage.
 *
 * The backfill's job is to describe markets that already exist. This one's is to close the gap
 * between a launch being prepared and a market being indexed — and to carry across that gap the one
 * fact nothing on chain records, which is what the creator said their market came from.
 *
 * ## Two sources, both required
 *
 * The receipt route is the fast one: the browser reports its transaction, `recordLaunch` verifies it
 * against the chain, and this runs. It is not sufficient, because it depends on the creator's tab
 * still being open. A creator who signs and closes the browser has a market on chain and an attempt
 * stuck in `sending`, and nothing in the app will ever hear about it.
 *
 * The sweep is the complete one: it walks every engine market the indexer knows and reconciles what
 * it finds. It is not sufficient either, because it runs on a schedule rather than on a launch, and a
 * registry that is minutes behind the chain is a registry that shows a creator nothing after they
 * launch. So both exist, they are the same function, and running them in either order or both at once
 * converges on the same rows.
 *
 * ## Matching, and why it is never on economics alone
 *
 * `deployMarket` is permissionless and a market's canonical configuration is public — it is on the
 * review screen and in the build's own record. So two people launching byte-identical economics is
 * expected rather than exceptional, and they produce byte-identical `configHash`es and
 * `implementationHash`es. Matching an attempt to a market on the hash alone would hand one creator's
 * lineage claim to another creator's market.
 *
 * An attempt therefore matches a market only on all three of: the same `configHash`, the same
 * creator, and a launch block inside the window that starts where the attempt was prepared. Where
 * more than one attempt still fits, the one whose transaction hash the market actually carries wins —
 * which is evidence rather than a tie-break, and is what makes a creator's second attempt at the same
 * market resolve to the launch that really happened.
 *
 * ## Nothing here can guess a parent
 *
 * A market with no matching attempt is registered with null lineage. Not "with a parent worked out
 * from the closest configuration", not "with the same parent as the author's last Program" — with
 * nothing. That is the whole point of capturing a claim at build time, and it is asserted as a
 * property of this file's source in `no-inference.test.ts` rather than only of its output.
 */

import type { Hex } from "@verdant/registry";

import {
  ATTEMPT_BLOCK_WINDOW,
  attemptsFor,
  expireAttempts,
  markAttemptLaunched,
  type LaunchAttempt,
} from "./attempts.js";
import { programOf } from "./backfill.js";
import { saveLineage } from "./lineage.js";
import { saveProgram, type RegistryDatabase } from "./programs.js";
import type { IndexerClient, IndexerMarket } from "./indexer.js";

export interface ReconcileOptions {
  readonly db: RegistryDatabase;
  readonly indexer: IndexerClient;
  /** Which chain the indexer is following. `MarketRef` is keyed by it. */
  readonly chainId: number;
  /** Unix seconds. Supplied rather than read, so expiry is testable to the second. */
  readonly now: number;
  readonly blockWindow?: number;
  readonly reservedTtlSeconds?: number;
  readonly sendingTtlSeconds?: number;
}

/**
 * What a run did.
 *
 * A report rather than a health signal, and two of the counts need reading carefully. `unmatched`
 * counts markets that had no attempt still in flight *on this run*, which includes every market
 * already reconciled by an earlier one — so a steady state has `unmatched` equal to the whole
 * population and that is correct rather than alarming. `unresolvedClaims` is the one worth watching:
 * it counts claims that named a parent this registry does not hold, which may become writable later.
 */
export interface ReconcileResult {
  readonly programs: number;
  readonly versions: number;
  readonly markets: number;
  /** Attempts settled as `launched` by this run. */
  readonly matched: number;
  /** Markets with no in-flight attempt. Registered with null lineage. */
  readonly unmatched: number;
  /** Lineage edges written by this run. */
  readonly lineage: number;
  /** Claims that could not become an edge: an unknown parent, or a self-edge. */
  readonly unresolvedClaims: number;
  readonly expiredFailed: number;
  readonly expiredIndeterminate: number;
}

/** Whether a launch could have come from this attempt, by block. */
function withinWindow(attempt: LaunchAttempt, launchBlock: number, blockWindow: number): boolean {
  return (
    launchBlock >= attempt.observedBlock && launchBlock <= attempt.observedBlock + blockWindow
  );
}

/**
 * The attempt this market is the launch of, or null.
 *
 * All three conditions from decision 7, in the order that narrows fastest: the query applies the
 * economics and the creator, and the window is applied here against the market in hand.
 *
 * Where several attempts survive all three — a creator who prepared the same launch twice — the one
 * whose transaction hash the market carries is chosen. That is the only signal in the set that is
 * evidence about which attempt actually became this market; falling back to the earliest is a
 * convention, and it is reached only when no attempt reported a hash at all.
 */
async function matchingAttempt(
  db: RegistryDatabase,
  market: IndexerMarket,
  configHash: Hex,
  chainId: number,
  blockWindow: number,
): Promise<LaunchAttempt | null> {
  const candidates = await attemptsFor(db, {
    chainId,
    configHash,
    creator: market.creator as Hex,
  });

  const launchBlock = Number(market.createdAtBlock);
  const fits = candidates.filter((attempt) => withinWindow(attempt, launchBlock, blockWindow));
  if (fits.length === 0) return null;

  const launchTx = market.createdTx.toLowerCase();
  const byTransaction = fits.find((attempt) => attempt.txHash === launchTx);

  return byTransaction ?? fits[0] ?? null;
}

/**
 * Reconcile every engine market the indexer knows, then expire what never landed.
 *
 * One transaction for the whole run, as the backfill is, and for the same reason: a failure of any
 * kind leaves the database exactly as it was, so there is no state in which a Program exists without
 * the version and market rows that explain it, or a lineage edge exists for an attempt that was never
 * settled. Resumability is a consequence rather than a mechanism — a failed run left nothing to
 * resume to, and re-running converges because every write is keyed on the identity the chain gave it
 * and every status change is guarded on the statuses it may move from.
 *
 * Expiry runs last, inside the same transaction. That order matters: an attempt whose market is in
 * this very batch must be settled as `launched` before the clock is allowed to call it abandoned.
 * Doing it the other way round would mark a successful launch `indeterminate` whenever the indexer
 * was more than a day behind.
 *
 * No batching, no concurrency and no checkpoint table. Decision 5 stands from M1: the whole
 * population is two markets, and machinery for scale here would be more moving parts than the thing
 * it protects.
 */
export async function reconcileLaunches(options: ReconcileOptions): Promise<ReconcileResult> {
  const { db, indexer, chainId, now } = options;
  const blockWindow = options.blockWindow ?? ATTEMPT_BLOCK_WINDOW;

  const identities = new Set<string>();
  let markets = 0;
  let matched = 0;
  let unmatched = 0;
  let lineage = 0;
  let unresolvedClaims = 0;
  let expiredFailed = 0;
  let expiredIndeterminate = 0;

  await db.transaction(async (tx) => {
    for await (const market of indexer.engineMarkets()) {
      // The same derivation the backfill uses, imported rather than restated. A market's Program row
      // must not depend on which path first observed it.
      const { program, version } = programOf(market, chainId);
      await saveProgram(tx, { program, version });

      identities.add(program.configHash);
      markets += 1;

      const attempt = await matchingAttempt(tx, market, program.configHash, chainId, blockWindow);

      if (attempt === null) {
        // A market nobody claimed anything about. The two that already exist are permanently in this
        // case, and so is any launch made against the factory directly. Registered, with no edge.
        unmatched += 1;
        continue;
      }

      matched += 1;
      await markAttemptLaunched(tx, {
        id: attempt.id,
        txHash: market.createdTx as Hex,
        now,
      });

      if (attempt.lineage === null) continue;

      const outcome = await saveLineage(tx, {
        parentConfigHash: attempt.lineage.parentConfigHash,
        childConfigHash: program.configHash,
        kind: attempt.lineage.kind,
        // The creator of the market, which is the wallet that made the edit. Taken from the chain's
        // account of the launch rather than from the attempt, so an edge's author is a fact.
        authorAddress: market.creator.toLowerCase() as Hex,
        /*
         * The launch's own timestamp, never `now`.
         *
         * An edge dated by when reconciliation happened to run would differ between a launch
         * reconciled by the receipt route and the same launch picked up by the sweep an hour later,
         * which would make two runs produce different rows for one launch. Dating it from the chain
         * makes the row a function of the launch alone, which is what the byte-identical assertion in
         * `reconcile.test.ts` rests on.
         */
        createdAt: market.createdAt,
      });

      if (outcome === "written") lineage += 1;
      else if (outcome !== "duplicate") unresolvedClaims += 1;
    }

    const expiry = await expireAttempts(tx, {
      now,
      ...(options.reservedTtlSeconds === undefined
        ? {}
        : { reservedTtlSeconds: options.reservedTtlSeconds }),
      ...(options.sendingTtlSeconds === undefined
        ? {}
        : { sendingTtlSeconds: options.sendingTtlSeconds }),
    });

    expiredFailed = expiry.failed;
    expiredIndeterminate = expiry.indeterminate;
  });

  return {
    programs: identities.size,
    versions: identities.size,
    markets,
    matched,
    unmatched,
    lineage,
    unresolvedClaims,
    expiredFailed,
    expiredIndeterminate,
  };
}
