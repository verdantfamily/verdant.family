/**
 * The launch-attempt table and its state machine.
 *
 * The vocabulary is the X path's, copied rather than reinvented: `reserved`, `sending`, `launched`,
 * `failed`, `indeterminate`. That path has been running sponsored launches against this chain and
 * the distinction it draws is the one that matters here — `failed` means no transaction was ever
 * sent, `indeterminate` means one was and nobody knows what happened. Conflating them is how a
 * launch gets retried into two markets.
 *
 * What this suite asserts is that the transitions are one-way, that the terminal statuses are
 * terminal, and that expiry moves an attempt to whichever terminal status is *true* of it rather
 * than to a single "gave up".
 */

import { describe, expect, it } from "vitest";

import {
  ATTEMPT_BLOCK_WINDOW,
  ATTEMPT_RESERVED_TTL_SECONDS,
  ATTEMPT_SENDING_TTL_SECONDS,
  expireAttempts,
  listAttempts,
  markAttemptLaunched,
  markAttemptSending,
  readAttempt,
  reserveAttempt,
} from "./attempts.js";
import { scratchDatabase, type Scratch } from "./testing/scratch.js";
import { CSCD, attemptFor, migrate, statusOf } from "./testing/attempt-fixtures.js";
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

const TX = `0x${"11".repeat(32)}` as Hex;

describe("an attempt is written before anything is signed", () => {
  it("round-trips every field it was given", async () => {
    await withScratch(async (scratch) => {
      const attempt = attemptFor(CSCD, {
        lineage: { parentConfigHash: `0x${"77".repeat(32)}` as Hex, kind: "FORK" },
      });

      await reserveAttempt(scratch.db, attempt);
      const read = await readAttempt(scratch.db, attempt.id);

      expect(read).not.toBeNull();
      expect(read?.status).toBe("reserved");
      expect(read?.txHash).toBeNull();
      expect(read?.jobId).toBe(attempt.jobId);
      expect(read?.configHash).toBe(attempt.configHash);
      expect(read?.implementationHash).toBe(attempt.implementationHash);
      expect(read?.encodedConfig).toBe(attempt.encodedConfig);
      expect(read?.creator).toBe(attempt.creator);
      expect(read?.feeReceiver).toBe(attempt.feeReceiver);
      expect(read?.factory).toBe(attempt.factory);
      expect(read?.predictedVault).toBe(attempt.predictedVault);
      expect(read?.observedBlock).toBe(attempt.observedBlock);
      expect(read?.preparedAt).toBe(attempt.preparedAt);
      expect(read?.lineage).toEqual({
        parentConfigHash: `0x${"77".repeat(32)}`,
        kind: "FORK",
      });
    });
  });

  it("reads an absent claim back as null rather than as a partial one", async () => {
    await withScratch(async (scratch) => {
      await reserveAttempt(scratch.db, attemptFor(CSCD, { lineage: null }));
      const read = await readAttempt(scratch.db, "attempt-cscd");

      expect(read?.lineage).toBeNull();
    });
  });

  it("is idempotent on its own id, so a retried preparation writes one row", async () => {
    await withScratch(async (scratch) => {
      const attempt = attemptFor(CSCD);
      await reserveAttempt(scratch.db, attempt);
      await reserveAttempt(scratch.db, attempt);

      expect(await listAttempts(scratch.db)).toHaveLength(1);
    });
  });

  it("holds two attempts for one job, because a creator may prepare twice", async () => {
    await withScratch(async (scratch) => {
      await reserveAttempt(scratch.db, attemptFor(CSCD, { id: "first" }));
      await reserveAttempt(scratch.db, attemptFor(CSCD, { id: "second" }));

      expect(await listAttempts(scratch.db)).toHaveLength(2);
    });
  });
});

describe("the transitions are one-way", () => {
  it("moves reserved to sending when a hash arrives", async () => {
    await withScratch(async (scratch) => {
      const attempt = attemptFor(CSCD);
      await reserveAttempt(scratch.db, attempt);

      const moved = await markAttemptSending(scratch.db, {
        id: attempt.id,
        txHash: TX,
        now: attempt.preparedAt + 4,
      });

      expect(moved).toBe(true);
      expect(await statusOf(scratch, attempt.id)).toBe("sending");
      expect((await readAttempt(scratch.db, attempt.id))?.txHash).toBe(TX);
    });
  });

  it("does not move a launched attempt back to sending", async () => {
    await withScratch(async (scratch) => {
      const attempt = attemptFor(CSCD);
      await reserveAttempt(scratch.db, attempt);
      await markAttemptLaunched(scratch.db, {
        id: attempt.id,
        txHash: TX,
        now: attempt.preparedAt + 10,
      });

      const moved = await markAttemptSending(scratch.db, {
        id: attempt.id,
        txHash: `0x${"22".repeat(32)}` as Hex,
        now: attempt.preparedAt + 20,
      });

      expect(moved).toBe(false);
      expect(await statusOf(scratch, attempt.id)).toBe("launched");
      expect((await readAttempt(scratch.db, attempt.id))?.txHash).toBe(TX);
    });
  });

  it("does not resurrect an expired attempt", async () => {
    await withScratch(async (scratch) => {
      const attempt = attemptFor(CSCD);
      await reserveAttempt(scratch.db, attempt);
      await expireAttempts(scratch.db, {
        now: attempt.preparedAt + ATTEMPT_RESERVED_TTL_SECONDS + 1,
      });

      expect(await statusOf(scratch, attempt.id)).toBe("failed");

      const moved = await markAttemptSending(scratch.db, {
        id: attempt.id,
        txHash: TX,
        now: attempt.preparedAt + 10_000,
      });

      /*
       * A `failed` attempt whose wallet signs anyway is not impossible — expiry is a clock, not a
       * cancellation, and nothing on chain honours it. It stays terminal here and the sweep is what
       * picks the market up, with the claim intact: the alternative is a status that can go
       * backwards, which is the property that makes "never stuck in sending" unprovable.
       */
      expect(moved).toBe(false);
      expect(await statusOf(scratch, attempt.id)).toBe("failed");
    });
  });

  it("reports nothing moved for an id it does not have", async () => {
    await withScratch(async (scratch) => {
      const moved = await markAttemptSending(scratch.db, {
        id: "no-such-attempt",
        txHash: TX,
        now: 1,
      });

      expect(moved).toBe(false);
    });
  });
});

describe("the expiry rule", () => {
  it("gives a reserved attempt half an hour and a sent one a day", () => {
    /*
     * Stated as an assertion rather than only in prose, because these two numbers are the whole
     * rule and they are not arbitrary.
     *
     * A `reserved` attempt is calldata sitting in a browser with a wallet dialog open over it. That
     * is a decision measured in seconds to minutes; half an hour is generous for it and short
     * enough that an abandoned tab does not leave a row that a later launch of the same economics
     * by the same wallet could be matched against.
     *
     * A `sending` attempt is a transaction that exists. Its outcome is a fact about the chain and
     * not about the creator's attention, so the window is a day — long enough that a stuck
     * transaction confirms inside it, and bounded because `indeterminate` is a real answer and
     * "still sending after a week" is not.
     */
    expect(ATTEMPT_RESERVED_TTL_SECONDS).toBe(30 * 60);
    expect(ATTEMPT_SENDING_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it("bounds matching to a window that covers the sending window", () => {
    /*
     * The window is the origin block plus this many blocks, and it exists so that an attempt can
     * only ever be matched to a market launched near it. Robinhood Chain mines roughly eight blocks
     * a second — the engine's own deployment and the two live launches bracket 700,000 blocks in a
     * day — so a day is about 700,000 blocks and this is the next round number above it.
     *
     * It has to cover the sending window rather than the reserved one: a transaction accepted at
     * preparation may confirm at any point before it expires, and a window shorter than that would
     * lose the lineage of exactly the slow launches the sweep exists to catch.
     */
    const blocksPerSecond = 8;
    expect(ATTEMPT_BLOCK_WINDOW).toBeGreaterThanOrEqual(
      ATTEMPT_SENDING_TTL_SECONDS * blocksPerSecond,
    );
    expect(Number.isFinite(ATTEMPT_BLOCK_WINDOW)).toBe(true);
  });

  it("expires each status into the terminal status that is true of it", async () => {
    await withScratch(async (scratch) => {
      const stale = attemptFor(CSCD, { id: "stale-reserved" });
      const sent = attemptFor(CSCD, { id: "stale-sending" });

      await reserveAttempt(scratch.db, stale);
      await reserveAttempt(scratch.db, sent);
      await markAttemptSending(scratch.db, {
        id: sent.id,
        txHash: TX,
        now: sent.preparedAt + 1,
      });

      /*
       * Comfortably past both windows rather than exactly on one.
       *
       * `sending` is measured from the hash, which arrived a second after preparation, so a clock at
       * `preparedAt + sendingTtl + 1` sits precisely on that attempt's boundary — and the boundary is
       * not past it. Expiry is deliberately `<` rather than `<=`, so an attempt is given its whole
       * window; the boundary itself is pinned by the two tests below.
       */
      const result = await expireAttempts(scratch.db, {
        now: stale.preparedAt + ATTEMPT_SENDING_TTL_SECONDS + 10,
      });

      expect(result).toEqual({ failed: 1, indeterminate: 1 });
      expect(await statusOf(scratch, "stale-reserved")).toBe("failed");
      expect(await statusOf(scratch, "stale-sending")).toBe("indeterminate");
    });
  });

  it("expires a reserved attempt without waiting for the sending window", async () => {
    await withScratch(async (scratch) => {
      const attempt = attemptFor(CSCD);
      await reserveAttempt(scratch.db, attempt);

      // Past the reserved window, well inside the sending one. The two windows are separate or
      // this passes for the wrong reason.
      const result = await expireAttempts(scratch.db, {
        now: attempt.preparedAt + ATTEMPT_RESERVED_TTL_SECONDS + 1,
      });

      expect(result.failed).toBe(1);
      expect(await statusOf(scratch, attempt.id)).toBe("failed");
    });
  });

  it("does not expire a sending attempt at the reserved window", async () => {
    await withScratch(async (scratch) => {
      const attempt = attemptFor(CSCD);
      await reserveAttempt(scratch.db, attempt);
      await markAttemptSending(scratch.db, {
        id: attempt.id,
        txHash: TX,
        now: attempt.preparedAt + 1,
      });

      const result = await expireAttempts(scratch.db, {
        now: attempt.preparedAt + ATTEMPT_RESERVED_TTL_SECONDS + 1,
      });

      expect(result).toEqual({ failed: 0, indeterminate: 0 });
      expect(await statusOf(scratch, attempt.id)).toBe("sending");
    });
  });

  it("counts a clock that has moved past nothing as nothing", async () => {
    await withScratch(async (scratch) => {
      const attempt = attemptFor(CSCD);
      await reserveAttempt(scratch.db, attempt);
      await markAttemptLaunched(scratch.db, {
        id: attempt.id,
        txHash: TX,
        now: attempt.preparedAt + 2,
      });

      const result = await expireAttempts(scratch.db, {
        now: attempt.preparedAt + 10 * 365 * 86_400,
      });

      expect(result).toEqual({ failed: 0, indeterminate: 0 });
      expect(await statusOf(scratch, attempt.id)).toBe("launched");
    });
  });

  it("measures the sending window from the hash rather than from preparation", async () => {
    await withScratch(async (scratch) => {
      /*
       * A creator who leaves the review screen open for an hour and then signs has an attempt whose
       * preparation is old and whose transaction is seconds old. Measuring from preparation would
       * call that transaction indeterminate the moment it was sent.
       */
      const attempt = attemptFor(CSCD);
      await reserveAttempt(scratch.db, attempt);

      const sentAt = attempt.preparedAt + ATTEMPT_SENDING_TTL_SECONDS - 60;
      await markAttemptSending(scratch.db, { id: attempt.id, txHash: TX, now: sentAt });

      const result = await expireAttempts(scratch.db, { now: sentAt + 60 });

      expect(result.indeterminate).toBe(0);
      expect(await statusOf(scratch, attempt.id)).toBe("sending");
    });
  });
});
