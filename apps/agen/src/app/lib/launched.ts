/**
 * What a launch produced, written down.
 *
 * A build knows what it would deploy. Only the chain knows what it did deploy, and the
 * link between the two — this build is that token — exists nowhere until something
 * records it. Without it a creator signs a transaction, a market appears on chain, and
 * the page they are looking at goes on describing an unlaunched build forever.
 *
 * ## Why the receipt rather than the request
 *
 * The record is written from the transaction receipt, by reading the launch event out of
 * the logs, and it refuses anything not emitted by the configured factory. So the source
 * of every field is the chain's own account of what happened, not the browser's claim
 * about what it sent. A creator cannot register somebody else's token against their
 * build, and a failed launch writes nothing at all — a reverted transaction has no such
 * log.
 *
 * ## Two engines, two events, and no pretending they are one
 *
 * A generated market announces itself with `AgenFactory.MarketDeployed`; an engine-v1
 * market with `AgenEngineFactory.EngineMarketDeployed`. Different factories, different
 * fields, different registries afterwards — so which event is looked for is decided by
 * the job's `engineVersion` before any log is read, and neither decoder is ever pointed at
 * the other's event.
 *
 * That branch is the whole reason this file was wrong. It only knew `MarketDeployed`, so a
 * perfectly successful engine launch found no log it recognised, recorded nothing, and left
 * the build sitting at `phase: "ready"` for good — a market live and trading on chain and
 * absent from the product that made it. Nothing failed loudly, which is why it survived.
 *
 * ## Why a file beside the job rather than a field on it
 *
 * The job belongs to the pipeline: it is written by the build as it runs, and adding a
 * field that a completely different code path writes afterwards invites two writers onto
 * one document. A launch is also the point where a build stops being the authority — the
 * registry is, and the indexer reads it — so this store is deliberately small and
 * deliberately a cache: everything in it can be rebuilt from the chain.
 */

import "server-only";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { engineVersionOf, type EngineVersion } from "@verdant/market-compiler";
import { abi } from "@verdant/sdk";
import { decodeEventLog, getAddress, type Address, type Hex } from "viem";

import { AGEN_ADDRESSES } from "./chain";
import { GENERATED_ROOT, jobStore } from "./builds";
import { publicClient } from "./onchain";
import { engineAddressesOrNull, ENGINE_NOT_DEPLOYED } from "./programmable";

const ROOT = resolve(GENERATED_ROOT, "_launched");

/** What the chain said a launch produced. Every field comes from the receipt. */
export interface LaunchRecord {
  readonly jobId: string;
  /** The registry's index for this market, which is also its creation order. */
  readonly index: number;
  readonly token: Address;
  readonly hook: Address;
  readonly poolId: Hex;
  /** The contract holding the market's locked liquidity. */
  readonly locker: Address;
  readonly txHash: Hex;
  readonly blockNumber: string;
  /** Seconds, from the block the launch landed in. */
  readonly at: number;
  readonly creator: Address;
  /**
   * Which factory created this market, and therefore which registry describes it.
   *
   * Recorded rather than looked up again later, because the two engines write to two
   * different `AgenMarketRegistry` instances and a reader that guessed would read an
   * engine market out of the generated-market registry and find nothing. Every record
   * written before this field existed is an engine-0 record; `readLaunch` says so.
   */
  readonly engineVersion: EngineVersion;
  /**
   * The market's fee vault. Engine v1 only — a generated market's fee destination is
   * whatever its own contracts decided, and there is no single account to name.
   */
  readonly vault?: Address;
  /**
   * The commitments the chain recorded, for an engine market.
   *
   * Kept so that what the creator approved can be compared against what the factory
   * actually emitted without a second round trip. `recordLaunch` already refuses a
   * receipt whose commitment is not the approved one, so these are a record of that
   * check having passed rather than something a reader must re-verify.
   */
  readonly configHash?: Hex;
  readonly implementationHash?: Hex;
}

function pathFor(jobId: string): string {
  // The id is a uuid the server generated, but this builds a filesystem path out of it,
  // so it is checked rather than trusted. A job id with a slash in it would write
  // outside the directory.
  if (!/^[0-9a-fA-F-]{36}$/.test(jobId)) throw new Error("not a job id");
  return resolve(ROOT, `${jobId}.json`);
}

/** The record for a build, if it has been launched. */
export async function readLaunch(jobId: string): Promise<LaunchRecord | null> {
  try {
    const raw = await readFile(pathFor(jobId), "utf8");
    const record = JSON.parse(raw) as LaunchRecord;

    // Every record written before the engine existed is an engine-0 record. Defaulting
    // here rather than at each reader means no consumer has to know the field is optional
    // on disk, and none of them can forget which way an absent value reads.
    return { ...record, engineVersion: record.engineVersion === 1 ? 1 : 0 };
  } catch {
    return null;
  }
}

/** Every launch this server has recorded, newest first. */
export async function readLaunches(): Promise<readonly LaunchRecord[]> {
  const { readdir } = await import("node:fs/promises");

  const names = await readdir(ROOT).catch(() => [] as string[]);
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => readLaunch(name.slice(0, -".json".length))),
  );

  return records
    .filter((record): record is LaunchRecord => record !== null)
    .sort((left, right) => right.at - left.at);
}

export class LaunchRecordError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LaunchRecordError";
  }
}

/**
 * Record a launch from its transaction, having checked the chain agrees.
 *
 * Idempotent: recording the same transaction twice writes the same file twice, which is
 * what the launch screen does when a creator reloads it, and what a retry does when the
 * first request times out after the write.
 *
 * Which event is looked for is decided here, from the job, before any log is examined. A
 * job that does not exist reads as engine 0 — the same convention `isEngineBuild` uses —
 * which sends it into the generated path and straight into that path's own refusal.
 */
export async function recordLaunch(jobId: string, txHash: Hex): Promise<LaunchRecord> {
  const existing = await readLaunch(jobId);
  if (existing !== null && existing.txHash.toLowerCase() === txHash.toLowerCase()) {
    return existing;
  }

  const job = await jobStore()
    .read(jobId)
    .catch(() => null);

  return engineVersionOf(job ?? {}) === 1
    ? await recordEngineLaunch(jobId, txHash, job)
    : await recordGeneratedLaunch(jobId, txHash);
}

/** The receipt, checked for the two things that make it worth reading at all. */
async function confirmedReceipt(txHash: Hex) {
  const receipt = await publicClient()
    .getTransactionReceipt({ hash: txHash })
    .catch(() => null);

  if (receipt === null) {
    throw new LaunchRecordError("That transaction is not on this chain yet.", 404);
  }
  if (receipt.status !== "success") {
    throw new LaunchRecordError("That transaction failed, so no market was created.", 400);
  }

  return receipt;
}

async function persist(record: LaunchRecord): Promise<LaunchRecord> {
  await mkdir(ROOT, { recursive: true });
  await writeFile(pathFor(record.jobId), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

/** A generated market, from `AgenFactory.MarketDeployed`. Unchanged. */
async function recordGeneratedLaunch(jobId: string, txHash: Hex): Promise<LaunchRecord> {
  if (!AGEN_ADDRESSES.ok) {
    throw new LaunchRecordError("Agen's contracts are not configured on this deployment.", 503);
  }

  const receipt = await confirmedReceipt(txHash);
  const factory = AGEN_ADDRESSES.addresses.factory.toLowerCase();

  // The one log that matters, and only from the factory this deployment is configured
  // for. Anything else in the receipt belongs to the market's own contracts or to
  // Uniswap, and a `MarketDeployed` from another address is another Agen.
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== factory) continue;

    let decoded;
    try {
      decoded = decodeEventLog({ abi: abi.agenFactoryAbi, data: log.data, topics: log.topics });
    } catch {
      continue;
    }

    if (decoded.eventName !== "MarketDeployed") continue;

    const args = decoded.args as unknown as {
      readonly index: bigint;
      readonly token: Address;
      readonly hook: Address;
      readonly poolId: Hex;
      readonly locker: Address;
    };

    const block = await publicClient().getBlock({ blockNumber: receipt.blockNumber });

    return await persist({
      jobId,
      engineVersion: 0,
      index: Number(args.index),
      token: getAddress(args.token),
      hook: getAddress(args.hook),
      poolId: args.poolId,
      locker: getAddress(args.locker),
      txHash,
      blockNumber: receipt.blockNumber.toString(),
      at: Number(block.timestamp),
      creator: getAddress(receipt.from),
    });
  }

  throw new LaunchRecordError(
    "That transaction did not create an Agen market through this deployment's factory.",
    400,
  );
}

/**
 * An engine market, from `AgenEngineFactory.EngineMarketDeployed`.
 *
 * ## What it will not accept
 *
 * A log from any address other than the engine factory this deployment is configured for,
 * an event that is not `EngineMarketDeployed`, an `engineVersion` field that is not 1, a
 * commitment other than the one the creator approved, and a creator other than the wallet
 * that approved it.
 *
 * The first three keep another Agen's markets, or another engine's, out of this build's
 * record. The fourth is review-to-execution parity at the point where the two could still
 * be told apart: the factory recomputes the commitment from the rules it stored and refuses
 * a launch that does not match, so a receipt carrying a different commitment is a receipt
 * for a different market than the one on the screen. Recording it would leave a page
 * describing rules the chain does not run.
 *
 * The fifth is the one that is not obvious, and it exists because `deployMarket` is
 * permissionless by design and this endpoint takes nothing but a transaction hash. A
 * market's canonical configuration is public — it is on the review screen and in the build's
 * own record — so anybody can deploy a market with byte-identical economics and therefore a
 * byte-identical commitment. Without this check they could then hand that transaction to
 * this endpoint and have a build page point at *their* token: same rules, different market,
 * and the creator share going to them. `AgenEngineFactory` takes the creator from
 * `msg.sender` and emits it, and the approval names the wallet that signed, so requiring the
 * two to agree is what ties a launch record to the market its creator actually launched.
 * See `docs/engine-approval-model.md`.
 *
 * ## Where the hook comes from, since the event does not carry it
 *
 * The deployment. One shared hook serves every engine market, the factory holds it in an
 * immutable and checks that it points back, and the log above was required to come from
 * that factory — so there is exactly one hook this market can have and it is a constant of
 * the deployment rather than a per-launch fact. Reading it back over RPC would be a round
 * trip to be told the same thing.
 */
async function recordEngineLaunch(
  jobId: string,
  txHash: Hex,
  job: {
    readonly engine?: { readonly implementationHash?: Hex | null } | null;
    readonly approval?: { readonly approvedBy?: string } | null;
  } | null,
): Promise<LaunchRecord> {
  const addresses = engineAddressesOrNull();
  if (addresses === null) throw new LaunchRecordError(ENGINE_NOT_DEPLOYED, 503);

  const receipt = await confirmedReceipt(txHash);
  const factory = addresses.factory.toLowerCase();
  const approved = job?.engine?.implementationHash ?? null;
  const approvedBy = job?.approval?.approvedBy ?? null;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== factory) continue;

    let decoded;
    try {
      decoded = decodeEventLog({
        abi: abi.agenEngineFactoryAbi,
        data: log.data,
        topics: log.topics,
      });
    } catch {
      continue;
    }

    if (decoded.eventName !== "EngineMarketDeployed") continue;

    const args = decoded.args as unknown as {
      readonly index: bigint;
      readonly token: Address;
      readonly creator: Address;
      readonly poolId: Hex;
      readonly vault: Address;
      readonly locker: Address;
      readonly engineVersion: number;
      readonly configHash: Hex;
      readonly implementationHash: Hex;
    };

    // The factory only ever emits what the hook stored, so this is not expected to fail.
    // It is checked because "engine version 1" is what every reader downstream assumes,
    // and a future engine's launch must not be filed under this one's semantics.
    if (Number(args.engineVersion) !== 1) {
      throw new LaunchRecordError(
        `That transaction created an engine version ${String(args.engineVersion)} market, ` +
          "which this build is not.",
        400,
      );
    }

    if (approved !== null && args.implementationHash.toLowerCase() !== approved.toLowerCase()) {
      throw new LaunchRecordError(
        "That transaction created a market whose rules are not the ones approved for this " +
          "build, so it is not this build's market.",
        409,
      );
    }

    if (approvedBy !== null && args.creator.toLowerCase() !== approvedBy.toLowerCase()) {
      throw new LaunchRecordError(
        "That transaction created a market for a different wallet than the one that approved " +
          "this build, so it is not this build's market.",
        409,
      );
    }

    const block = await publicClient().getBlock({ blockNumber: receipt.blockNumber });

    return await persist({
      jobId,
      engineVersion: 1,
      index: Number(args.index),
      token: getAddress(args.token),
      hook: getAddress(addresses.hook),
      poolId: args.poolId,
      locker: getAddress(args.locker),
      vault: getAddress(args.vault),
      configHash: args.configHash,
      implementationHash: args.implementationHash,
      txHash,
      blockNumber: receipt.blockNumber.toString(),
      at: Number(block.timestamp),
      // From the event rather than from `receipt.from`, which is the account that paid for
      // the transaction. The factory takes the creator from `msg.sender` and emits it, so
      // a launch relayed through a router or a multicall still records the right creator.
      creator: getAddress(args.creator),
    });
  }

  throw new LaunchRecordError(
    "That transaction did not create a market through this deployment's engine factory.",
    400,
  );
}
