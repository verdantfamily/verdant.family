/**
 * The app's two doors into reconciliation, and the hash-on-callback step between them.
 *
 * Decision 7 requires two sources and both are here, calling the same function in
 * `@verdant/registry-db`:
 *
 *  - **The receipt route.** `POST /api/markets/[id]/launched` verifies a transaction against the chain
 *    and then runs this. Fast, and insufficient on its own: it depends on the creator's tab still
 *    being open, and a creator who signs and closes the browser leaves a market on chain that nothing
 *    in the app will ever hear about.
 *  - **The sweep.** `scripts/reconcile-registry.ts`, on a schedule. Complete, and insufficient on its
 *    own: a registry that is minutes behind shows a creator nothing in the minute after they launch.
 *
 * Running them in either order, or both at once, converges on the same rows — every write is keyed on
 * the identity the chain gave it and every status change is guarded on the statuses it may move from.
 *
 * ## Everything here is failure-isolated, for the same reason the attempt write is
 *
 * The receipt route's job is to tell a creator their market exists. A registry that could make that
 * route fail would turn a successful launch into an error message about a database, so `reconcileAfter`
 * resolves whatever happens and logs what it swallowed. The sweep is the opposite: it is a job whose
 * only purpose is this, so it lets failures out and exits non-zero.
 */

import "server-only";

import {
  markAttemptSentForJob,
  reconcileLaunches,
  registryClient,
  registryConfigured,
  httpIndexer,
  type ReconcileResult,
} from "@verdant/registry-db";
import type { Hex } from "viem";

import { CHAIN_ID } from "../chain";

/** Where the indexer is. The same variable the market pages read; see `lib/feed.ts`. */
function feedUrl(): string {
  return (process.env["AGEN_FEED_URL"] ?? "").trim();
}

/** Whether this deployment can reconcile at all: a registry to write to and an indexer to read. */
export function reconciliationConfigured(): boolean {
  return registryConfigured() && feedUrl() !== "";
}

export interface SweepOptions {
  /** Unix seconds. Supplied by the sweep so a run's expiry decisions are reproducible. */
  readonly now?: number;
}

/**
 * Reconcile every engine market the indexer knows, and expire what never landed.
 *
 * Lets its failures out. Called by the sweep, whose whole purpose is this — a sweep that swallowed an
 * unreachable indexer would report success while the registry silently stopped being updated, which is
 * the failure mode the HTTP boundary in `@verdant/registry-db` exists to convert into a loud one.
 */
export async function sweepRegistry(options: SweepOptions = {}): Promise<ReconcileResult> {
  if (!registryConfigured()) {
    throw new Error(
      "REGISTRY_DATABASE_URL is not set, so there is nowhere to reconcile launches into.",
    );
  }

  const base = feedUrl();
  if (base === "") {
    throw new Error("AGEN_FEED_URL is not set, so there is no indexer to read markets from.");
  }

  const client = registryClient();

  try {
    return await reconcileLaunches({
      db: client.db,
      indexer: httpIndexer({ baseUrl: base }),
      chainId: CHAIN_ID,
      now: options.now ?? Math.floor(Date.now() / 1000),
    });
  } finally {
    await client.close();
  }
}

/**
 * Reconcile after a receipt, without being able to affect the response.
 *
 * The whole population is two markets, so this runs the full sweep rather than a query for one — the
 * same call decision 5 permits and M1's decision 5 already took for the backfill. What it buys is that
 * there is one reconciliation function with one behaviour, rather than a fast path that could drift
 * from the complete one and be wrong in exactly the case nobody tests.
 *
 * Resolves always. A creator whose market is on chain must be told so, whatever the registry is doing.
 */
export async function reconcileAfterReceipt(jobId: string): Promise<void> {
  if (!reconciliationConfigured()) return;

  try {
    await sweepRegistry();
  } catch (error) {
    console.error(
      `[agen] could not reconcile the registry after the launch of build ${jobId}. The market is ` +
        `unaffected and the next sweep will pick it up:`,
      error,
    );
  }
}

/**
 * Record that a build's launch has a transaction, before anybody knows whether it worked.
 *
 * The step that makes `indeterminate` reachable rather than theoretical, and the reason the sweep can
 * finish a launch the app lost. Nothing on this path signs on a creator's behalf, so the server never
 * observes a send — the browser reports it, on the way to waiting for a receipt it may never see.
 *
 * Resolves always, and returns nothing. The browser is mid-launch and there is no answer it could act
 * on: a hash that could not be recorded costs this launch's lineage claim and no more, because the
 * sweep will still find the market and still match it on economics, creator and block window.
 */
export async function recordLaunchSent(jobId: string, txHash: Hex): Promise<void> {
  if (!registryConfigured()) return;

  const client = registryClient();

  try {
    await markAttemptSentForJob(client.db, {
      jobId,
      txHash,
      now: Math.floor(Date.now() / 1000),
    });
  } catch (error) {
    console.error(
      `[agen] could not record the transaction for build ${jobId}'s launch attempt. The launch is ` +
        `unaffected:`,
      error,
    );
  } finally {
    await client.close().catch(() => {});
  }
}
