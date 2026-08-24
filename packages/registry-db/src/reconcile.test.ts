/**
 * M2 acceptance tests 1, 2, 5, 6, 7, 8 and 9 — reconciliation, and what it refuses to invent.
 *
 * Reconciliation is where a launch attempt becomes a Program, and where the one fact that cannot
 * be recovered later is written down: which Program this one came from. Everything asserted here
 * is about that write being *claimed* rather than derived — a launch with no claim gets no edge,
 * and there is no input to this function from which a parent could be guessed.
 *
 * The other half is that the registry is allowed to be behind and never allowed to be wrong. A
 * market can reach the chain with no attempt at all (the two that already exist, and any launch
 * made against the factory directly), and an attempt can be signed and then lost. Both are
 * ordinary and both are covered here.
 */

import { describe, expect, it } from "vitest";

import {
  ATTEMPT_BLOCK_WINDOW,
  markAttemptSending,
  readAttempt,
  reserveAttempt,
} from "./attempts.js";
import { reconcileLaunches } from "./reconcile.js";
import { scratchDatabase, type Scratch } from "./testing/scratch.js";
import {
  CHAIN_ID,
  CSCD,
  TAX,
  asIndexerMarket,
  attemptFor,
  countRows,
  emptyIndexer,
  indexerOver,
  launchedAt,
  migrate,
  sameEconomicsOtherCreator,
  snapshotWithAttempts,
  statusOf,
} from "./testing/attempt-fixtures.js";
import type { Hex } from "@verdant/registry";

async function withScratch(body: (scratch: Scratch) => Promise<void>): Promise<void> {
  const scratch = await scratchDatabase();
  try {
    await migrate(scratch);
    await body(scratch);
  } finally {
    await scratch.close();
  }
}

/** A parent Program that a claim can point at. A claim naming nothing is a claim about nothing. */
async function seedParent(scratch: Scratch, market: typeof CSCD): Promise<Hex> {
  await reconcileLaunches({
    db: scratch.db,
    indexer: indexerOver([asIndexerMarket(market)]),
    chainId: CHAIN_ID,
    now: launchedAt(market) + 1,
  });

  return market.configHash.toLowerCase() as Hex;
}

describe("acceptance test 1: a claimed launch yields exactly one lineage row", () => {
  it("writes the claimed parent and kind, and nothing else", async () => {
    await withScratch(async (scratch) => {
      // TAX is the parent; CSCD is launched claiming to be a revision of it. Which way round is
      // arbitrary — what matters is that the edge recorded is the one that was claimed.
      const parent = await seedParent(scratch, TAX);

      await reserveAttempt(
        scratch.db,
        attemptFor(CSCD, { lineage: { parentConfigHash: parent, kind: "REVISION" } }),
      );

      const result = await reconcileLaunches({
        db: scratch.db,
        indexer: indexerOver([asIndexerMarket(CSCD)]),
        chainId: CHAIN_ID,
        now: launchedAt(CSCD) + 1,
      });

      expect(result.lineage).toBe(1);
      expect(result.matched).toBe(1);

      const edges = await scratch.db.execute<{
        parent_config_hash: string;
        child_config_hash: string;
        kind: string;
        author_address: string;
      }>(
        `select parent_config_hash, child_config_hash, kind, author_address
         from program_lineage`,
      );

      expect(edges.rows).toEqual([
        {
          parent_config_hash: parent,
          child_config_hash: CSCD.configHash.toLowerCase(),
          kind: "REVISION",
          author_address: CSCD.creator.toLowerCase(),
        },
      ]);
    });
  });

  it("records a FORK as a fork, because the kind is claimed and not computed", async () => {
    await withScratch(async (scratch) => {
      const parent = await seedParent(scratch, TAX);

      await reserveAttempt(
        scratch.db,
        attemptFor(CSCD, { lineage: { parentConfigHash: parent, kind: "FORK" } }),
      );

      await reconcileLaunches({
        db: scratch.db,
        indexer: indexerOver([asIndexerMarket(CSCD)]),
        chainId: CHAIN_ID,
        now: launchedAt(CSCD) + 1,
      });

      const kinds = await scratch.db.execute<{ kind: string }>(
        `select kind from program_lineage`,
      );

      expect(kinds.rows).toEqual([{ kind: "FORK" }]);
    });
  });

  it("settles the attempt as launched", async () => {
    await withScratch(async (scratch) => {
      const parent = await seedParent(scratch, TAX);
      const attempt = attemptFor(CSCD, {
        lineage: { parentConfigHash: parent, kind: "REVISION" },
      });

      await reserveAttempt(scratch.db, attempt);
      await reconcileLaunches({
        db: scratch.db,
        indexer: indexerOver([asIndexerMarket(CSCD)]),
        chainId: CHAIN_ID,
        now: launchedAt(CSCD) + 1,
      });

      expect(await statusOf(scratch, attempt.id)).toBe("launched");
    });
  });
});

describe("acceptance test 2: an unclaimed launch yields no lineage row", () => {
  it("writes zero edges when the attempt carried no claim", async () => {
    await withScratch(async (scratch) => {
      // A parent exists, and its economics are in the database. There is therefore something a
      // heuristic *could* have reached for, which is what makes the assertion meaningful.
      await seedParent(scratch, TAX);
      await reserveAttempt(scratch.db, attemptFor(CSCD, { lineage: null }));

      const result = await reconcileLaunches({
        db: scratch.db,
        indexer: indexerOver([asIndexerMarket(CSCD)]),
        chainId: CHAIN_ID,
        now: launchedAt(CSCD) + 1,
      });

      expect(result.lineage).toBe(0);
      expect(result.matched).toBe(1);
      expect(await countRows(scratch, "program_lineage")).toBe(0);
    });
  });

  it("still registers the Program, the version and the market", async () => {
    await withScratch(async (scratch) => {
      await reserveAttempt(scratch.db, attemptFor(CSCD, { lineage: null }));

      await reconcileLaunches({
        db: scratch.db,
        indexer: indexerOver([asIndexerMarket(CSCD)]),
        chainId: CHAIN_ID,
        now: launchedAt(CSCD) + 1,
      });

      expect(await countRows(scratch, "programs")).toBe(1);
      expect(await countRows(scratch, "program_versions")).toBe(1);
      expect(await countRows(scratch, "program_markets")).toBe(1);
      expect(await countRows(scratch, "program_lineage")).toBe(0);
    });
  });
});

describe("acceptance test 5: reconciliation is idempotent", () => {
  it("produces byte-identical table state when run twice", async () => {
    await withScratch(async (scratch) => {
      const parent = await seedParent(scratch, TAX);
      await reserveAttempt(
        scratch.db,
        attemptFor(CSCD, { lineage: { parentConfigHash: parent, kind: "REVISION" } }),
      );

      const indexer = indexerOver([asIndexerMarket(TAX), asIndexerMarket(CSCD)]);
      const now = launchedAt(CSCD) + 1;

      await reconcileLaunches({ db: scratch.db, indexer, chainId: CHAIN_ID, now });
      const first = await snapshotWithAttempts(scratch);

      // A later clock on the second run, which is the case that would expose a timestamp taken
      // from `now` rather than from the chain.
      await reconcileLaunches({
        db: scratch.db,
        indexer,
        chainId: CHAIN_ID,
        now: now + 3_600,
      });
      const second = await snapshotWithAttempts(scratch);

      expect(second).toBe(first);
    });
  });

  it("does not duplicate a lineage edge on a second run", async () => {
    await withScratch(async (scratch) => {
      const parent = await seedParent(scratch, TAX);
      await reserveAttempt(
        scratch.db,
        attemptFor(CSCD, { lineage: { parentConfigHash: parent, kind: "REVISION" } }),
      );

      const indexer = indexerOver([asIndexerMarket(CSCD)]);
      const now = launchedAt(CSCD) + 1;

      await reconcileLaunches({ db: scratch.db, indexer, chainId: CHAIN_ID, now });
      const again = await reconcileLaunches({ db: scratch.db, indexer, chainId: CHAIN_ID, now });

      expect(again.lineage).toBe(0);
      expect(await countRows(scratch, "program_lineage")).toBe(1);
    });
  });
});

describe("acceptance test 6: one Program, two creators, two claims", () => {
  it("attaches both markets to one Program and keeps each claim", async () => {
    await withScratch(async (scratch) => {
      const parent = await seedParent(scratch, TAX);

      const other = `0x${"ab".repeat(20)}` as Hex;
      const second = sameEconomicsOtherCreator(CSCD, { creator: other });

      // Two attempts, same economics, different creators. One claims a revision of TAX; the other
      // claims a fork of it. Matching on `configHash` alone could not tell them apart, which is
      // exactly why decision 7 requires the creator and the window as well.
      await reserveAttempt(
        scratch.db,
        attemptFor(CSCD, {
          id: "attempt-first",
          lineage: { parentConfigHash: parent, kind: "REVISION" },
        }),
      );
      await reserveAttempt(
        scratch.db,
        attemptFor(CSCD, {
          id: "attempt-second",
          jobId: "00000000-0000-4000-8000-0000000000ff",
          creator: other,
          feeReceiver: other,
          observedBlock: Number(second.createdAtBlock) - 100,
          lineage: { parentConfigHash: parent, kind: "FORK" },
        }),
      );

      const result = await reconcileLaunches({
        db: scratch.db,
        indexer: indexerOver([asIndexerMarket(CSCD), second]),
        chainId: CHAIN_ID,
        now: second.createdAt + 1,
      });

      expect(result.matched).toBe(2);
      expect(result.lineage).toBe(1);

      // One Program, because the economics are identical and a Program is its configHash.
      const programs = await scratch.db.execute<{ config_hash: string }>(
        `select config_hash from programs where config_hash = '${CSCD.configHash.toLowerCase()}'`,
      );
      expect(programs.rows).toHaveLength(1);

      // Two markets under it.
      const markets = await scratch.db.execute<{ pool_id: string; token: string }>(
        `select pool_id, token from program_markets
         where config_hash = '${CSCD.configHash.toLowerCase()}' order by pool_id`,
      );
      expect(markets.rows).toHaveLength(2);

      /*
       * One edge, and this is the subtle part rather than a weaker assertion.
       *
       * `program_lineage` is keyed by (parent, child) and both attempts name the same parent and
       * produce the same child, because the child *is* the shared `configHash`. So the second
       * claim is genuinely the same edge as the first and collapses into it — the table cannot
       * express "this edge, twice, for different reasons", and inventing a surrogate key so that
       * it could would be inventing two Programs where there is one.
       *
       * What each attempt keeps is its own claim, on its own row, which is what the next
       * assertion checks. The edge is a fact about Programs; the claim is a fact about a launch.
       */
      const edges = await scratch.db.execute<{ kind: string }>(
        `select kind from program_lineage`,
      );
      expect(edges.rows).toHaveLength(1);

      const first = await readAttempt(scratch.db, "attempt-first");
      const other2 = await readAttempt(scratch.db, "attempt-second");

      expect(first?.status).toBe("launched");
      expect(other2?.status).toBe("launched");
      expect(first?.lineage).toEqual({ parentConfigHash: parent, kind: "REVISION" });
      expect(other2?.lineage).toEqual({ parentConfigHash: parent, kind: "FORK" });
    });
  });

  it("does not match an attempt to another creator's market", async () => {
    await withScratch(async (scratch) => {
      const other = `0x${"ab".repeat(20)}` as Hex;
      const second = sameEconomicsOtherCreator(CSCD, { creator: other });

      // Only the second creator's market is on chain, and only the first creator has an attempt.
      // Identical economics, so `configHash` alone would match them. The creator must not.
      await reserveAttempt(scratch.db, attemptFor(CSCD, { lineage: null }));

      const result = await reconcileLaunches({
        db: scratch.db,
        indexer: indexerOver([second]),
        chainId: CHAIN_ID,
        now: second.createdAt + 1,
      });

      expect(result.matched).toBe(0);
      expect(result.unmatched).toBe(1);
      expect(await statusOf(scratch, "attempt-cscd")).toBe("reserved");
    });
  });

  it("does not match an attempt to a market outside its block window", async () => {
    await withScratch(async (scratch) => {
      /*
       * The attempt is recent by the clock and stale by the chain: its origin block sits one block
       * further back than the window allows, so the market cannot be its launch even though the
       * economics and the creator both agree. Keeping `preparedAt` recent is deliberate — an attempt
       * that had also expired would fail this for the wrong reason, and the assertion is about the
       * window rather than the clock.
       */
      await reserveAttempt(
        scratch.db,
        attemptFor(CSCD, {
          lineage: null,
          observedBlock: CSCD.launchBlock - (ATTEMPT_BLOCK_WINDOW + 1),
        }),
      );

      const result = await reconcileLaunches({
        db: scratch.db,
        indexer: indexerOver([asIndexerMarket(CSCD)]),
        chainId: CHAIN_ID,
        now: launchedAt(CSCD) + 1,
      });

      expect(result.matched).toBe(0);
      expect(result.unmatched).toBe(1);
      expect(await statusOf(scratch, "attempt-cscd")).toBe("reserved");
    });
  });

  it("matches an attempt at the far edge of its window", async () => {
    await withScratch(async (scratch) => {
      // One block inside where the previous test is one block outside, so the boundary is pinned
      // from both sides rather than only asserted to exist somewhere.
      await reserveAttempt(
        scratch.db,
        attemptFor(CSCD, {
          lineage: null,
          observedBlock: CSCD.launchBlock - ATTEMPT_BLOCK_WINDOW,
        }),
      );

      const result = await reconcileLaunches({
        db: scratch.db,
        indexer: indexerOver([asIndexerMarket(CSCD)]),
        chainId: CHAIN_ID,
        now: launchedAt(CSCD) + 1,
      });

      expect(result.matched).toBe(1);
      expect(await statusOf(scratch, "attempt-cscd")).toBe("launched");
    });
  });

  it("does not match a market mined before the attempt was prepared", async () => {
    await withScratch(async (scratch) => {
      // The window is one-sided on purpose: a market that existed before the calldata was built
      // cannot be that calldata's launch, however well everything else lines up.
      await reserveAttempt(
        scratch.db,
        attemptFor(CSCD, { lineage: null, observedBlock: CSCD.launchBlock + 1 }),
      );

      const result = await reconcileLaunches({
        db: scratch.db,
        indexer: indexerOver([asIndexerMarket(CSCD)]),
        chainId: CHAIN_ID,
        now: launchedAt(CSCD) + 1,
      });

      expect(result.matched).toBe(0);
      expect(await statusOf(scratch, "attempt-cscd")).toBe("reserved");
    });
  });
});

describe("acceptance test 7: an attempt that never lands expires into a terminal status", () => {
  it("fails a reserved attempt that was never signed, and writes no rows", async () => {
    await withScratch(async (scratch) => {
      const attempt = attemptFor(CSCD, { lineage: null });
      await reserveAttempt(scratch.db, attempt);

      const result = await reconcileLaunches({
        db: scratch.db,
        indexer: emptyIndexer(),
        chainId: CHAIN_ID,
        // Well past the reserved window. Nothing was ever sent, so there is no transaction whose
        // outcome could be unknown — this is a refusal, not an ambiguity.
        now: attempt.preparedAt + 86_400,
      });

      expect(result.expiredFailed).toBe(1);
      expect(result.expiredIndeterminate).toBe(0);
      expect(await statusOf(scratch, attempt.id)).toBe("failed");

      expect(await countRows(scratch, "programs")).toBe(0);
      expect(await countRows(scratch, "program_versions")).toBe(0);
      expect(await countRows(scratch, "program_markets")).toBe(0);
      expect(await countRows(scratch, "program_lineage")).toBe(0);
    });
  });

  it("marks a sent-but-unconfirmed attempt indeterminate rather than failed", async () => {
    await withScratch(async (scratch) => {
      const attempt = attemptFor(CSCD, { lineage: null });
      await reserveAttempt(scratch.db, attempt);
      await markAttemptSending(scratch.db, {
        id: attempt.id,
        txHash: CSCD.launchTx as Hex,
        now: attempt.preparedAt + 5,
      });

      const result = await reconcileLaunches({
        db: scratch.db,
        indexer: emptyIndexer(),
        chainId: CHAIN_ID,
        now: attempt.preparedAt + 30 * 86_400,
      });

      expect(result.expiredIndeterminate).toBe(1);
      expect(result.expiredFailed).toBe(0);
      expect(await statusOf(scratch, attempt.id)).toBe("indeterminate");
      expect(await countRows(scratch, "program_markets")).toBe(0);
    });
  });

  it("never leaves an attempt in sending once its window has passed", async () => {
    await withScratch(async (scratch) => {
      const attempt = attemptFor(CSCD, { lineage: null });
      await reserveAttempt(scratch.db, attempt);
      await markAttemptSending(scratch.db, {
        id: attempt.id,
        txHash: CSCD.launchTx as Hex,
        now: attempt.preparedAt + 5,
      });

      await reconcileLaunches({
        db: scratch.db,
        indexer: emptyIndexer(),
        chainId: CHAIN_ID,
        now: attempt.preparedAt + 365 * 86_400,
      });

      const stuck = await scratch.db.execute<{ count: string }>(
        `select count(*)::text as count from launch_attempts
         where status in ('reserved', 'sending')`,
      );

      expect(stuck.rows[0]?.count).toBe("0");
    });
  });

  it("leaves an attempt inside its window alone", async () => {
    await withScratch(async (scratch) => {
      const attempt = attemptFor(CSCD, { lineage: null });
      await reserveAttempt(scratch.db, attempt);

      const result = await reconcileLaunches({
        db: scratch.db,
        indexer: emptyIndexer(),
        chainId: CHAIN_ID,
        // Seconds after preparation. A creator reading a wallet dialog is the ordinary case and
        // must not have their attempt expired underneath them.
        now: attempt.preparedAt + 30,
      });

      expect(result.expiredFailed).toBe(0);
      expect(await statusOf(scratch, attempt.id)).toBe("reserved");
    });
  });
});

describe("acceptance test 8: a market with no attempt registers with null lineage", () => {
  it("registers both live markets from an empty attempts table", async () => {
    await withScratch(async (scratch) => {
      // The two markets that already exist. Both predate this milestone, so neither can ever have
      // an attempt, and INVENTORY.md records their lineage as unrecoverable.
      const result = await reconcileLaunches({
        db: scratch.db,
        indexer: indexerOver([asIndexerMarket(CSCD), asIndexerMarket(TAX)]),
        chainId: CHAIN_ID,
        now: launchedAt(TAX) + 1,
      });

      expect(result.markets).toBe(2);
      expect(result.programs).toBe(2);
      expect(result.matched).toBe(0);
      expect(result.unmatched).toBe(2);
      expect(result.lineage).toBe(0);

      expect(await countRows(scratch, "program_markets")).toBe(2);
      expect(await countRows(scratch, "program_lineage")).toBe(0);
    });
  });

  it("agrees with the backfill about what those rows are", async () => {
    /*
     * The registry must not have two answers to "what is this market's Program row". A launch that
     * reconciled and a market that was backfilled have to produce the same rows, or a market's
     * identity would depend on which path first observed it.
     */
    const viaBackfill = await (async () => {
      const scratch = await scratchDatabase();
      try {
        await migrate(scratch);
        const { backfillPrograms } = await import("./backfill.js");
        await backfillPrograms({
          db: scratch.db,
          indexer: indexerOver([asIndexerMarket(CSCD), asIndexerMarket(TAX)]),
          chainId: CHAIN_ID,
        });
        return await snapshotWithAttempts(scratch);
      } finally {
        await scratch.close();
      }
    })();

    const viaReconcile = await (async () => {
      const scratch = await scratchDatabase();
      try {
        await migrate(scratch);
        await reconcileLaunches({
          db: scratch.db,
          indexer: indexerOver([asIndexerMarket(CSCD), asIndexerMarket(TAX)]),
          chainId: CHAIN_ID,
          now: launchedAt(TAX) + 1,
        });
        return await snapshotWithAttempts(scratch);
      } finally {
        await scratch.close();
      }
    })();

    expect(viaReconcile).toBe(viaBackfill);
  });
});

describe("acceptance test 9: a signed launch whose receipt was never seen is still reconciled", () => {
  it("promotes an attempt left in sending when the sweep finds its market", async () => {
    await withScratch(async (scratch) => {
      const parent = await seedParent(scratch, TAX);
      const attempt = attemptFor(CSCD, {
        lineage: { parentConfigHash: parent, kind: "REVISION" },
      });

      await reserveAttempt(scratch.db, attempt);

      /*
       * The hash is known and the receipt is not. This is the state the app is left in when the
       * creator closes the tab between signing and confirmation, or when the receipt request
       * fails — the transaction is on its way and nothing in the app will ever hear how it went.
       * The indexer will, which is why the sweep is a required second source and not a fallback.
       */
      await markAttemptSending(scratch.db, {
        id: attempt.id,
        txHash: CSCD.launchTx as Hex,
        now: attempt.preparedAt + 5,
      });

      const result = await reconcileLaunches({
        db: scratch.db,
        indexer: indexerOver([asIndexerMarket(CSCD)]),
        chainId: CHAIN_ID,
        now: attempt.preparedAt + 600,
      });

      expect(result.matched).toBe(1);
      expect(result.lineage).toBe(1);
      expect(await statusOf(scratch, attempt.id)).toBe("launched");

      // The market this run registered, named rather than counted: the parent Program was seeded by
      // a launch of its own, so a bare count here would be asserting against both.
      const registered = await scratch.db.execute<{ launch_tx: string }>(
        `select launch_tx from program_markets
         where pool_id = '${CSCD.poolId.toLowerCase()}'`,
      );
      expect(registered.rows).toEqual([{ launch_tx: CSCD.launchTx.toLowerCase() }]);
    });
  });

  it("prefers the attempt whose transaction hash the market carries", async () => {
    await withScratch(async (scratch) => {
      const parent = await seedParent(scratch, TAX);

      // Two attempts by the same creator for the same economics, both inside the window. One of
      // them is the launch that landed, and it is identified by its transaction rather than by
      // being first: the other is a second attempt the creator made and abandoned.
      await reserveAttempt(
        scratch.db,
        attemptFor(CSCD, {
          id: "attempt-abandoned",
          lineage: { parentConfigHash: parent, kind: "FORK" },
        }),
      );
      await reserveAttempt(
        scratch.db,
        attemptFor(CSCD, {
          id: "attempt-landed",
          jobId: "00000000-0000-4000-8000-0000000000ee",
          lineage: { parentConfigHash: parent, kind: "REVISION" },
        }),
      );
      await markAttemptSending(scratch.db, {
        id: "attempt-landed",
        txHash: CSCD.launchTx as Hex,
        now: launchedAt(CSCD) - 10,
      });

      await reconcileLaunches({
        db: scratch.db,
        indexer: indexerOver([asIndexerMarket(CSCD)]),
        chainId: CHAIN_ID,
        now: launchedAt(CSCD) + 1,
      });

      expect(await statusOf(scratch, "attempt-landed")).toBe("launched");
      expect(await statusOf(scratch, "attempt-abandoned")).toBe("reserved");

      const kinds = await scratch.db.execute<{ kind: string }>(
        `select kind from program_lineage`,
      );
      expect(kinds.rows).toEqual([{ kind: "REVISION" }]);
    });
  });
});

describe("a claim naming a Program the registry does not have", () => {
  it("registers the market and records no edge, rather than failing the run", async () => {
    await withScratch(async (scratch) => {
      /*
       * The foreign keys on `program_lineage` mean an edge to an unknown parent cannot be written
       * at all. That is the right constraint and the wrong moment to enforce it loudly: the market
       * is on chain either way, and refusing to register it would mean one unresolvable claim kept
       * a real market out of the registry for good. So the edge is dropped, counted, and the
       * Program is written.
       */
      await reserveAttempt(
        scratch.db,
        attemptFor(CSCD, {
          lineage: { parentConfigHash: `0x${"99".repeat(32)}` as Hex, kind: "REVISION" },
        }),
      );

      const result = await reconcileLaunches({
        db: scratch.db,
        indexer: indexerOver([asIndexerMarket(CSCD)]),
        chainId: CHAIN_ID,
        now: launchedAt(CSCD) + 1,
      });

      expect(result.markets).toBe(1);
      expect(result.lineage).toBe(0);
      expect(result.unresolvedClaims).toBe(1);
      expect(await countRows(scratch, "program_lineage")).toBe(0);
      expect(await statusOf(scratch, "attempt-cscd")).toBe("launched");
    });
  });

  it("refuses a claim that a Program is its own parent", async () => {
    await withScratch(async (scratch) => {
      // The child's hash is not knowable when the claim is made, so a creator editing a Program
      // into economics identical to its parent produces this. The check constraint forbids the
      // edge; it must not take the market down with it.
      await reserveAttempt(
        scratch.db,
        attemptFor(CSCD, {
          lineage: {
            parentConfigHash: CSCD.configHash.toLowerCase() as Hex,
            kind: "REVISION",
          },
        }),
      );

      const result = await reconcileLaunches({
        db: scratch.db,
        indexer: indexerOver([asIndexerMarket(CSCD)]),
        chainId: CHAIN_ID,
        now: launchedAt(CSCD) + 1,
      });

      expect(result.markets).toBe(1);
      expect(result.lineage).toBe(0);
      expect(await countRows(scratch, "program_lineage")).toBe(0);
    });
  });
});
