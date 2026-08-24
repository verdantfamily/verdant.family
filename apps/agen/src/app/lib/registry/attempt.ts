/**
 * Recording that a launch was prepared, without ever being able to stop one.
 *
 * ## Where this is called from, and why there
 *
 * From `prepareEngineLaunch`, immediately before it returns. That is the only point in the engine-v1
 * path where the job id, the creator, the fee receiver, the configuration hash, the commitment, the
 * predicted vault, the factory and the calldata are all known at once — and it is upstream of every
 * signature, because what the function returns is unsigned calldata that the creator's own wallet
 * decides what to do with.
 *
 * Anywhere earlier and the creator is not known: `AgenEngineFactory` resolves the creator from
 * `msg.sender`, so a build has no creator until a wallet connects. Anywhere later and the record is
 * conditional on the launch working, which defeats the purpose — a launch that was signed and lost is
 * precisely the case the record exists to survive.
 *
 * ## Nothing in here can reach the launch path
 *
 * Decision 5, and it is absolute: if every registry write fails, the launch still completes, the market
 * still exists, and the sweep still registers it afterwards with null lineage. The accepted cost is a
 * lost lineage claim, which is a missing label on a graph. The alternative cost is a creator who
 * cannot launch a market they already built, proved and approved, for a reason that has nothing to do
 * with their market.
 *
 * So this function resolves rather than rejects, always, and it is written so that the compiler agrees:
 * the return type has no error channel, every await is inside the try, and the timeout below covers the
 * one failure a try/catch does not. A Postgres whose host is dropping packets accepts a connection and
 * never answers, so the write neither resolves nor rejects — and without a bound, the launch route
 * would hang until the platform killed it and the creator would see a spinner instead of a wallet.
 *
 * ## What it deliberately refuses to record
 *
 * An attempt with no origin block. Matching is on economics *and* creator *and* a bounded block window,
 * and an attempt with no window could only ever be matched on the first two — which is how one
 * creator's second launch of the same mechanic inherits the first one's claim. A row that cannot be
 * matched safely is worse than no row, so an RPC that will not answer costs this launch its lineage and
 * nothing else.
 */

import "server-only";

import { keccak256, type Hex } from "viem";
import {
  registryClient,
  registryConfigured,
  reserveAttempt,
  type NewLaunchAttempt,
  type RegistryClient,
  type RegistryDatabase,
} from "@verdant/registry-db";
import type { LineageClaim } from "@verdant/market-compiler";
import type { SchemaVersion } from "@verdant/registry";

import { publicClient } from "../onchain";

/**
 * How long the whole write is given before the launch stops waiting for it.
 *
 * Two seconds. Long enough for a healthy Postgres in the same region several times over, and short
 * enough that a creator does not notice it in a request that has already spent longer than that
 * mining a salt. It bounds the entire operation — connecting, the block read and the insert — rather
 * than each step, because what matters to the launch is the total.
 */
export const ATTEMPT_WRITE_TIMEOUT_MS = 2_000;

/** What `prepareEngineLaunch` knows, in the shape this module needs it. */
export interface LaunchAttemptDraft {
  readonly jobId: string;
  readonly chainId: number;
  readonly configHash: Hex;
  readonly implementationHash: Hex;
  readonly encodedConfig: Hex;
  readonly schemaVersion: SchemaVersion;
  readonly creator: Hex;
  readonly feeReceiver: Hex;
  readonly factory: Hex;
  readonly predictedVault: Hex | null;
  /** The transaction's data. Hashed and discarded; never stored. */
  readonly calldata: Hex;
  /** What the build carried from its creation. Null when nothing was claimed. */
  readonly lineage: LineageClaim | null;
}

/**
 * Why an attempt was not recorded.
 *
 * Named rather than boolean because these are logged and counted, and the four mean different things
 * to an operator. `not-configured` is the ordinary state of a local checkout. `no-block` is an RPC
 * problem. `failed` and `timed-out` are the registry itself, and the second is the one that suggests a
 * network rather than a database.
 */
export type AttemptSkipReason = "not-configured" | "no-block" | "failed" | "timed-out";

export type AttemptOutcome =
  | { readonly recorded: true; readonly id: string }
  | { readonly recorded: false; readonly reason: AttemptSkipReason };

/** Seams, so the failure modes above are testable without a database or a chain. */
export interface AttemptDependencies {
  readonly openClient?: () => RegistryClient;
  readonly write?: (db: RegistryDatabase, attempt: NewLaunchAttempt) => Promise<void>;
  /** The chain head, or null if it could not be read. Never throws past this boundary. */
  readonly observeBlock?: () => Promise<number | null>;
  readonly now?: () => number;
  readonly newId?: () => string;
}

/** The chain head, best effort. A failure here is a missing window, not a failed launch. */
async function currentBlock(): Promise<number | null> {
  try {
    return Number(await publicClient().getBlockNumber());
  } catch {
    return null;
  }
}

/**
 * Write the attempt, or give up quietly and say why.
 *
 * The `Promise.race` is the timeout and the reason this cannot hang. `body()` never rejects — it
 * catches its own failures and returns an outcome — so the race resolves either way and there is no
 * unhandled rejection left behind when the timeout wins.
 */
export async function recordLaunchAttempt(
  draft: LaunchAttemptDraft,
  dependencies: AttemptDependencies = {},
): Promise<AttemptOutcome> {
  if (!registryConfigured()) return { recorded: false, reason: "not-configured" };

  const open = dependencies.openClient ?? (() => registryClient());
  const write = dependencies.write ?? reserveAttempt;
  const observeBlock = dependencies.observeBlock ?? currentBlock;
  const now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  const newId = dependencies.newId ?? (() => crypto.randomUUID());

  const body = async (): Promise<AttemptOutcome> => {
    let client: RegistryClient | null = null;

    try {
      const observedBlock = await observeBlock();

      // No window, no row. See the note at the top of the file: an attempt matched on economics and
      // creator alone would be worse than one that was never written.
      if (observedBlock === null) return { recorded: false, reason: "no-block" };

      client = open();

      const id = newId();
      const at = now();

      await write(client.db, {
        id,
        jobId: draft.jobId,
        chainId: draft.chainId,
        configHash: draft.configHash.toLowerCase() as Hex,
        implementationHash: draft.implementationHash.toLowerCase() as Hex,
        encodedConfig: draft.encodedConfig.toLowerCase() as Hex,
        schemaVersion: draft.schemaVersion,
        creator: draft.creator.toLowerCase() as Hex,
        feeReceiver: draft.feeReceiver.toLowerCase() as Hex,
        factory: draft.factory.toLowerCase() as Hex,
        predictedVault:
          draft.predictedVault === null ? null : (draft.predictedVault.toLowerCase() as Hex),
        // The calldata's hash, not the calldata. The bytes are recoverable from `encodedConfig` and
        // the launch parameters, so storing them would store a derived value twice; the hash is what
        // ties this row to the exact transaction a wallet was asked to sign.
        calldataHash: keccak256(draft.calldata),
        observedBlock,
        lineage:
          draft.lineage === null
            ? null
            : {
                // `parentProgramId` on the job, `parentConfigHash` in the registry. The same 32 bytes
                // under two names: a Program *is* its configHash, and the job's field is named for
                // what a creator picked rather than for how it is stored.
                parentConfigHash: draft.lineage.parentProgramId.toLowerCase() as Hex,
                kind: draft.lineage.kind,
              },
        preparedAt: at,
      });

      return { recorded: true, id };
    } catch (error) {
      /*
       * Swallowed, and said out loud.
       *
       * Being quiet here would be the real defect. Lineage going missing is exactly the kind of loss
       * nobody notices for weeks — every market still launches, every page still renders, and the
       * graph is simply emptier than it should be — so this line is the only signal that it happened.
       */
      console.error(
        `[agen] could not record the launch attempt for build ${draft.jobId}. The launch is ` +
          `unaffected; its lineage claim is lost and the market will be registered without one:`,
        error,
      );

      return { recorded: false, reason: "failed" };
    } finally {
      if (client !== null) {
        // Returned even on the failure paths. A launch route that leaked a connection every time the
        // registry misbehaved would exhaust the database it could not reach.
        await client.close().catch(() => {});
      }
    }
  };

  const timeout = new Promise<AttemptOutcome>((resolve) => {
    const timer = setTimeout(() => {
      console.error(
        `[agen] recording the launch attempt for build ${draft.jobId} took longer than ` +
          `${String(ATTEMPT_WRITE_TIMEOUT_MS)}ms and was abandoned. The launch is unaffected.`,
      );
      resolve({ recorded: false, reason: "timed-out" });
    }, ATTEMPT_WRITE_TIMEOUT_MS);

    // Nothing else waits on this promise, so the timer must not hold the process open on its own.
    if (typeof timer.unref === "function") timer.unref();
  });

  return await Promise.race([body(), timeout]);
}
