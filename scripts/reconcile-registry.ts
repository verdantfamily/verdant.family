#!/usr/bin/env node
/**
 * Reconcile the Program registry against the chain, and end the launches that never landed.
 *
 * The second of reconciliation's two required sources, and the complete one. The receipt route in the
 * app is faster and depends on a browser tab still being open; this depends on nothing but the indexer,
 * which is why it is the one that catches the launches the app lost — a creator who signed and closed
 * the window, a receipt request that failed, a serverless instance frozen mid-handler.
 *
 * Safe to run repeatedly and safe to run alongside the app. Every write is keyed on the identity the
 * chain gave it and every status change is guarded on the statuses it may move from, so two runs
 * converge on the same rows rather than duplicating anything. `reconcile.test.ts` asserts that as
 * byte-identical table state across two runs.
 *
 * Usage:
 *   node scripts/reconcile-registry.ts
 *   node scripts/reconcile-registry.ts --dry-run
 *
 * Environment:
 *   REGISTRY_DATABASE_URL   the registry's own Postgres. Never an indexer's; see `client.ts`.
 *   AGEN_FEED_URL           the indexer's base URL, read over HTTP and never as tables.
 *   NEXT_PUBLIC_CHAIN_ID    which chain the indexer is following. Defaults to Robinhood mainnet.
 *
 * Exits non-zero on any failure, and deliberately does not swallow one. This is the opposite posture
 * from the launch path, where the registry must never be able to fail anything: here the registry *is*
 * the job, and a run that reported success while the indexer was unreachable would leave the registry
 * quietly falling behind — which is the failure nobody notices until a market's lineage is already
 * unrecoverable.
 */

import {
  httpIndexer,
  reconcileLaunches,
  registryClient,
  registryConfigured,
  REGISTRY_DATABASE_URL_VAR,
} from "@verdant/registry-db";
import { ROBINHOOD_MAINNET_ID } from "@verdant/config";

/** Read here rather than imported from the app, which is a Next module and pulls in the world. */
function chainId(): number {
  const raw = (process.env["NEXT_PUBLIC_CHAIN_ID"] ?? "").trim();
  if (raw === "") return ROBINHOOD_MAINNET_ID;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`NEXT_PUBLIC_CHAIN_ID must be a positive integer; it is "${raw}".`);
  }

  return parsed;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  if (!registryConfigured()) {
    throw new Error(
      `${REGISTRY_DATABASE_URL_VAR} is not set, so there is nowhere to reconcile launches into.`,
    );
  }

  const baseUrl = (process.env["AGEN_FEED_URL"] ?? "").trim();
  if (baseUrl === "") {
    throw new Error("AGEN_FEED_URL is not set, so there is no indexer to read markets from.");
  }

  const chain = chainId();
  const now = Math.floor(Date.now() / 1000);
  const client = registryClient();

  console.log(`[reconcile] chain ${String(chain)}, indexer ${baseUrl}`);

  try {
    /*
     * A dry run is a real run inside a transaction that is then rolled back.
     *
     * Not a second code path that reports what it "would" do — that would be a second implementation of
     * the matching rules, and the one thing worth checking before a first production run is the real
     * ones. The whole of `reconcileLaunches` is already one transaction, so throwing from inside a
     * wrapping transaction discards every write it made while still having made them.
     */
    const result = dryRun
      ? await client.db
          .transaction(async (tx) => {
            const outcome = await reconcileLaunches({
              db: tx,
              indexer: httpIndexer({ baseUrl }),
              chainId: chain,
              now,
            });

            throw new DryRun(outcome);
          })
          .catch((error: unknown) => {
            if (error instanceof DryRun) return error.result;
            throw error;
          })
      : await reconcileLaunches({
          db: client.db,
          indexer: httpIndexer({ baseUrl }),
          chainId: chain,
          now,
        });

    console.log(
      [
        `[reconcile] ${dryRun ? "would record" : "recorded"} ${String(result.markets)} markets ` +
          `across ${String(result.programs)} programs`,
        `[reconcile] attempts settled: ${String(result.matched)}; ` +
          `markets with no attempt: ${String(result.unmatched)}`,
        `[reconcile] lineage edges written: ${String(result.lineage)}; ` +
          `claims that could not be resolved: ${String(result.unresolvedClaims)}`,
        `[reconcile] expired: ${String(result.expiredFailed)} never sent, ` +
          `${String(result.expiredIndeterminate)} sent with no market found`,
      ].join("\n"),
    );

    /*
     * Said out loud rather than left in a count.
     *
     * An unresolved claim is the only line of this report that asks somebody to do something: it means a
     * creator named a parent this registry does not hold, which usually means the parent's own market has
     * not been indexed yet and the next run will write the edge. If it persists, the claim named
     * something that does not exist, and the edge never will.
     */
    if (result.unresolvedClaims > 0) {
      console.warn(
        `[reconcile] ${String(result.unresolvedClaims)} lineage claim(s) named a program this ` +
          `registry does not hold. Their markets are registered; the edges are not. If this does not ` +
          `clear on the next run, the claimed parent does not exist here.`,
      );
    }
  } finally {
    await client.close();
  }
}

/** Carries a dry run's result out through the rollback that discards its writes. */
class DryRun extends Error {
  constructor(readonly result: Awaited<ReturnType<typeof reconcileLaunches>>) {
    super("dry run");
    this.name = "DryRun";
  }
}

await main().catch((error: unknown) => {
  console.error("[reconcile] failed:", error);
  process.exitCode = 1;
});
