/**
 * M2 acceptance test 4 — the registry cannot fail a launch.
 *
 * Decision 5, asserted rather than intended. The attempt is written inside `prepareEngineLaunch`,
 * which is the last point before a wallet is asked for anything, and it is the newest and least
 * proven thing on that path. If it can throw, it can stop a creator launching a market that was
 * already built, already proved launchable and already approved — and it would do so for a reason
 * that has nothing to do with their market.
 *
 * The accepted cost is stated plainly: when every registry write fails, the launch completes, the
 * market exists, and the sweep picks it up afterwards with null lineage. A lost claim is a lost
 * label on a graph. A blocked launch is a creator who cannot use the product.
 *
 * Every failure mode below is a real one. An unconfigured build is the ordinary state of a local
 * checkout. A refused connection is a database that is down or a `REGISTRY_DATABASE_URL` pointing
 * somewhere wrong. A rejected insert is a migration that has not been applied. A hang is the one
 * that matters most, because it is the only one that would still be blocking if the others were
 * merely caught.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordLaunchAttempt, ATTEMPT_WRITE_TIMEOUT_MS } from "./attempt";
import type { LaunchAttemptDraft } from "./attempt";

const DRAFT: LaunchAttemptDraft = {
  jobId: "00000000-0000-4000-8000-000000000001",
  chainId: 4663,
  configHash: `0x${"1d".repeat(32)}`,
  implementationHash: `0x${"90".repeat(32)}`,
  encodedConfig: `0x${"00".repeat(64)}`,
  schemaVersion: 1,
  creator: `0x${"ed".repeat(20)}`,
  feeReceiver: `0x${"ed".repeat(20)}`,
  factory: `0x${"20".repeat(20)}`,
  predictedVault: `0x${"72".repeat(20)}`,
  calldata: `0x${"ab".repeat(100)}`,
  /*
   * `parentProgramId`, because this is the job's claim rather than the registry's row.
   *
   * The two spellings for these same 32 bytes are the reason the stored type is called
   * `AttemptLineageClaim` and not `LineageClaim`: this draft was written with the wrong one first, and
   * the only symptom was a `toLowerCase` on `undefined` several frames inside the writer. Named apart,
   * that is a type error at the boundary instead.
   */
  lineage: { parentProgramId: `0x${"73".repeat(32)}`, kind: "REVISION" },
};

const ORIGINAL = process.env["REGISTRY_DATABASE_URL"];

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env["REGISTRY_DATABASE_URL"];
  else process.env["REGISTRY_DATABASE_URL"] = ORIGINAL;
  vi.useRealTimers();
});

describe("acceptance test 4: a total registry outage does not reach the launch path", () => {
  it("resolves rather than throwing when the registry is not configured at all", async () => {
    delete process.env["REGISTRY_DATABASE_URL"];

    const outcome = await recordLaunchAttempt(DRAFT);

    expect(outcome).toEqual({ recorded: false, reason: "not-configured" });
  });

  it("resolves when opening a connection throws", async () => {
    process.env["REGISTRY_DATABASE_URL"] = "postgres://nobody@127.0.0.1:1/nothing";

    const outcome = await recordLaunchAttempt(DRAFT, {
      openClient: () => {
        throw new Error("ECONNREFUSED 127.0.0.1:1");
      },
    });

    expect(outcome).toEqual({ recorded: false, reason: "failed" });
  });

  it("resolves when the insert is rejected", async () => {
    process.env["REGISTRY_DATABASE_URL"] = "postgres://nobody@127.0.0.1:1/nothing";
    const closed = vi.fn(async () => {});

    const outcome = await recordLaunchAttempt(DRAFT, {
      openClient: () => ({
        db: {} as never,
        close: closed,
      }),
      write: async () => {
        throw new Error('relation "launch_attempts" does not exist');
      },
    });

    expect(outcome).toEqual({ recorded: false, reason: "failed" });

    // The pool is still returned. A launch path that leaked a connection on every failed write
    // would exhaust the database it could not reach.
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("resolves when the write hangs, rather than waiting on it", async () => {
    process.env["REGISTRY_DATABASE_URL"] = "postgres://nobody@127.0.0.1:1/nothing";

    /*
     * The failure that a try/catch does not cover, and the one worth a timeout of its own. A
     * Postgres whose host is silently dropping packets does not refuse a connection — it accepts
     * one and never answers, so the write neither resolves nor rejects. Without a bound here that
     * is a launch route that hangs until the platform's own request timeout kills it, and the
     * creator sees a spinner rather than a wallet.
     */
    vi.useFakeTimers();

    const outcome = recordLaunchAttempt(DRAFT, {
      openClient: () => ({ db: {} as never, close: async () => {} }),
      write: async () => new Promise<void>(() => {}),
    });

    await vi.advanceTimersByTimeAsync(ATTEMPT_WRITE_TIMEOUT_MS + 1);

    expect(await outcome).toEqual({ recorded: false, reason: "timed-out" });
  });

  it("records the attempt when the registry is healthy", async () => {
    /*
     * The control. Without it every assertion above is satisfied by a function that does nothing
     * at all, which would pass this suite and lose every lineage claim in production.
     */
    process.env["REGISTRY_DATABASE_URL"] = "postgres://nobody@127.0.0.1:1/nothing";
    const written: unknown[] = [];

    const outcome = await recordLaunchAttempt(DRAFT, {
      openClient: () => ({ db: {} as never, close: async () => {} }),
      write: async (_db, attempt) => {
        written.push(attempt);
      },
    });

    expect(outcome.recorded).toBe(true);
    expect(written).toHaveLength(1);
  });

  it("logs the failure it swallowed, so an outage is visible rather than silent", async () => {
    /*
     * Swallowing is correct and being quiet about it is not. Lineage going missing is exactly the
     * kind of loss nobody notices for weeks, and the only signal it leaves is this line.
     */
    process.env["REGISTRY_DATABASE_URL"] = "postgres://nobody@127.0.0.1:1/nothing";
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await recordLaunchAttempt(DRAFT, {
      openClient: () => {
        throw new Error("ECONNREFUSED");
      },
    });

    expect(logged).toHaveBeenCalled();
  });
});

describe("the attempt carries what reconciliation needs to match it", () => {
  it("hashes the calldata rather than storing it", async () => {
    process.env["REGISTRY_DATABASE_URL"] = "postgres://nobody@127.0.0.1:1/nothing";
    let seen: Record<string, unknown> | null = null;

    await recordLaunchAttempt(DRAFT, {
      openClient: () => ({ db: {} as never, close: async () => {} }),
      write: async (_db, attempt) => {
        seen = attempt as unknown as Record<string, unknown>;
      },
      observeBlock: async () => 44_363_749,
    });

    expect(seen).not.toBeNull();
    const attempt = seen as unknown as Record<string, unknown>;

    expect(attempt["calldataHash"]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(JSON.stringify(attempt)).not.toContain(DRAFT.calldata.slice(2, 40));
    expect(attempt["observedBlock"]).toBe(44_363_749);
    expect(attempt["creator"]).toBe(DRAFT.creator.toLowerCase());
  });

  it("does not record an attempt it could not put a block window on", async () => {
    /*
     * The window is how an attempt is matched to a market, per decision 7 — configHash and creator
     * and a bounded block range. An attempt with no origin block could only ever be matched on the
     * first two, and matching on economics and author alone is how one creator's second launch of
     * the same mechanic inherits the first one's claim. A row that cannot be matched safely is
     * worse than no row, so an RPC that will not answer costs this launch its lineage and nothing
     * else.
     */
    process.env["REGISTRY_DATABASE_URL"] = "postgres://nobody@127.0.0.1:1/nothing";
    const write = vi.fn(async () => {});

    const outcome = await recordLaunchAttempt(DRAFT, {
      openClient: () => ({ db: {} as never, close: async () => {} }),
      write,
      observeBlock: async () => null,
    });

    expect(outcome).toEqual({ recorded: false, reason: "no-block" });
    expect(write).not.toHaveBeenCalled();
  });
});
