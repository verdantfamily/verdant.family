/**
 * Acceptance tests 2, 3, 4 and 5 — that the backfill is idempotent, atomic, and derives the
 * identities the chain already gave these markets.
 *
 * The fixture is M0's, imported by path rather than copied. There is deliberately no second
 * table of expected hashes in this package: the two live markets' `configHash`es were recovered
 * from their launch calldata and checked against the hook's own derivation once, and anything
 * that wants to assert against them reads that file.
 */

import { describe, expect, it } from "vitest";

import { backfillPrograms } from "./backfill.js";
import { listPrograms } from "./programs.js";
import { applyMigrations, scratchDatabase, type Scratch } from "./testing/scratch.js";
import { fakeIndexer, failingIndexer, snapshot } from "./testing/fixtures.js";
import mainnet from "../../registry/src/fixtures/mainnet-engine-markets.json" with { type: "json" };

const CHAIN_ID = mainnet.chainId;

async function migrated(): Promise<Scratch> {
  const scratch = await scratchDatabase();
  await applyMigrations(scratch);
  return scratch;
}

async function withDatabase(body: (scratch: Scratch) => Promise<void>): Promise<void> {
  const scratch = await migrated();
  try {
    await body(scratch);
  } finally {
    await scratch.close();
  }
}

describe("acceptance test 3: backfilled identities are the chain-verified ones", () => {
  it("produces exactly the two Programs the fixture records", async () => {
    await withDatabase(async ({ db }) => {
      const result = await backfillPrograms({
        db,
        indexer: fakeIndexer(),
        chainId: CHAIN_ID,
      });

      expect(result.programs).toBe(2);
      expect(result.markets).toBe(2);
      expect(result.versions).toBe(2);
    });
  });

  it("stores each Program under the configHash the hook derived", async () => {
    await withDatabase(async ({ db }) => {
      await backfillPrograms({ db, indexer: fakeIndexer(), chainId: CHAIN_ID });

      const programs = await listPrograms(db);
      const stored = programs.map((program) => program.configHash).sort();
      const expected = mainnet.markets.map((market) => market.configHash).sort();

      expect(stored).toEqual(expected);
    });
  });

  it("carries each market's engineVersion as data rather than assuming one", async () => {
    await withDatabase(async ({ db }) => {
      await backfillPrograms({ db, indexer: fakeIndexer(), chainId: CHAIN_ID });

      for (const program of await listPrograms(db)) {
        const fixture = mainnet.markets.find((m) => m.configHash === program.configHash);
        expect(fixture).toBeDefined();
        expect(program.schemaVersion).toBe(fixture?.engineVersion);
        expect(program.markets[0]?.engineVersion).toBe(fixture?.engineVersion);
      }
    });
  });

  it("records the deployer address as the author and nothing else", async () => {
    await withDatabase(async ({ db }) => {
      await backfillPrograms({ db, indexer: fakeIndexer(), chainId: CHAIN_ID });

      for (const program of await listPrograms(db)) {
        const fixture = mainnet.markets.find((m) => m.configHash === program.configHash);
        expect(program.author.address).toBe(fixture?.creator.toLowerCase());
        expect(program.author.handle).toBeNull();
        expect(program.author.displayName).toBeNull();
        expect(program.name).toBeNull();
      }
    });
  });
});

describe("acceptance test 2: running the backfill twice changes nothing", () => {
  it("produces byte-identical table state on a second run", async () => {
    await withDatabase(async (scratch) => {
      await backfillPrograms({ db: scratch.db, indexer: fakeIndexer(), chainId: CHAIN_ID });
      const first = await snapshot(scratch);

      await backfillPrograms({ db: scratch.db, indexer: fakeIndexer(), chainId: CHAIN_ID });
      const second = await snapshot(scratch);

      expect(second).toBe(first);
    });
  });

  it("reports the same counts on the second run", async () => {
    await withDatabase(async ({ db }) => {
      const first = await backfillPrograms({ db, indexer: fakeIndexer(), chainId: CHAIN_ID });
      const second = await backfillPrograms({ db, indexer: fakeIndexer(), chainId: CHAIN_ID });

      expect(second).toEqual(first);
    });
  });

  it("does not move firstObservedAt on a re-run", async () => {
    /*
     * The rule the whole registry rests on: first observed hash owns the identity. A second
     * sighting of the same economics is a market under the existing Program, never a new
     * Program and never a reason to rewrite when it was first seen.
     */
    await withDatabase(async ({ db }) => {
      await backfillPrograms({ db, indexer: fakeIndexer(), chainId: CHAIN_ID });
      const before = (await listPrograms(db)).map((p) => p.firstObservedAt);

      await backfillPrograms({ db, indexer: fakeIndexer(), chainId: CHAIN_ID });
      const after = (await listPrograms(db)).map((p) => p.firstObservedAt);

      expect(after).toEqual(before);
    });
  });
});

describe("acceptance test 4: an interrupted backfill resumes to the same state", () => {
  it("equals a clean run after a mid-run failure and a retry", async () => {
    const clean = await migrated();
    try {
      await backfillPrograms({ db: clean.db, indexer: fakeIndexer(), chainId: CHAIN_ID });
      const expected = await snapshot(clean);

      const interrupted = await migrated();
      try {
        // Fails while fetching the second page, after the first market has been written.
        await expect(
          backfillPrograms({
            db: interrupted.db,
            indexer: failingIndexer({ failOnPage: 2 }),
            chainId: CHAIN_ID,
          }),
        ).rejects.toThrow();

        await backfillPrograms({
          db: interrupted.db,
          indexer: fakeIndexer(),
          chainId: CHAIN_ID,
        });

        expect(await snapshot(interrupted)).toBe(expected);
      } finally {
        await interrupted.close();
      }
    } finally {
      await clean.close();
    }
  });

  it("converges when one Program is already present", async () => {
    /*
     * The other shape of "resume": a database that already holds part of the answer, because a
     * previous run succeeded and a market has launched since. Convergence has to hold there too,
     * and it is the case a whole-run transaction alone would not exercise.
     */
    const clean = await migrated();
    try {
      await backfillPrograms({ db: clean.db, indexer: fakeIndexer(), chainId: CHAIN_ID });
      const expected = await snapshot(clean);

      const partial = await migrated();
      try {
        await backfillPrograms({
          db: partial.db,
          indexer: fakeIndexer({ only: 1 }),
          chainId: CHAIN_ID,
        });
        expect((await listPrograms(partial.db)).length).toBe(1);

        await backfillPrograms({ db: partial.db, indexer: fakeIndexer(), chainId: CHAIN_ID });

        expect(await snapshot(partial)).toBe(expected);
      } finally {
        await partial.close();
      }
    } finally {
      await clean.close();
    }
  });
});

describe("acceptance test 5: an indexer failure writes nothing and is not swallowed", () => {
  it("leaves no Program rows when the indexer fails mid-run", async () => {
    await withDatabase(async (scratch) => {
      const indexer = failingIndexer({ failOnPage: 2 });

      await expect(
        backfillPrograms({ db: scratch.db, indexer, chainId: CHAIN_ID }),
      ).rejects.toThrow();

      /*
       * The assertion that makes the next two meaningful. One market was handed over and written
       * before the failure, so there was something in the transaction to lose — without this, an
       * empty table afterwards would be equally consistent with a backfill that never started.
       */
      expect(indexer.yielded()).toBe(1);

      expect(await listPrograms(scratch.db)).toEqual([]);
      expect(await snapshot(scratch)).toBe(await emptySnapshot());
    });
  });

  it("surfaces the indexer's own error rather than a substitute", async () => {
    await withDatabase(async ({ db }) => {
      await expect(
        backfillPrograms({
          db,
          indexer: failingIndexer({ failOnPage: 2, message: "indexer returned 503" }),
          chainId: CHAIN_ID,
        }),
      ).rejects.toThrow(/indexer returned 503/);
    });
  });

  it("refuses a market whose configuration bytes are missing rather than storing a guess", async () => {
    /*
     * The indexer stores `encodedConfig` as null when the bytes recovered from a launch did not
     * hash to the hook's `configHash`. A Program cannot be derived from that, and inventing one
     * would publish economics no chain agreed to — so it is a refusal, not a skip.
     */
    await withDatabase(async (scratch) => {
      await expect(
        backfillPrograms({
          db: scratch.db,
          indexer: fakeIndexer({ blankConfigAt: 0 }),
          chainId: CHAIN_ID,
        }),
      ).rejects.toThrow(/config/i);

      expect(await listPrograms(scratch.db)).toEqual([]);
    });
  });

  it("refuses a market whose bytes disagree with its stated configHash", async () => {
    await withDatabase(async (scratch) => {
      await expect(
        backfillPrograms({
          db: scratch.db,
          indexer: fakeIndexer({ corruptHashAt: 0 }),
          chainId: CHAIN_ID,
        }),
      ).rejects.toThrow(/configHash|does not hash/i);

      expect(await listPrograms(scratch.db)).toEqual([]);
    });
  });
});

/** The snapshot of a migrated database with nothing in it, for comparison after a rollback. */
async function emptySnapshot(): Promise<string> {
  const scratch = await migrated();
  try {
    return await snapshot(scratch);
  } finally {
    await scratch.close();
  }
}
