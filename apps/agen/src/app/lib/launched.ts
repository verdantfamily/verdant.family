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
 * The record is written from the transaction receipt, by reading `MarketDeployed` out of
 * the logs, and it refuses anything not emitted by the configured factory. So the source
 * of every field is the chain's own account of what happened, not the browser's claim
 * about what it sent. A creator cannot register somebody else's token against their
 * build, and a failed launch writes nothing at all — a reverted transaction has no such
 * log.
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

import { abi } from "@verdant/sdk";
import { decodeEventLog, getAddress, type Address, type Hex } from "viem";

import { AGEN_ADDRESSES } from "./chain";
import { GENERATED_ROOT } from "./builds";
import { publicClient } from "./onchain";

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
    return JSON.parse(raw) as LaunchRecord;
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
 */
export async function recordLaunch(jobId: string, txHash: Hex): Promise<LaunchRecord> {
  if (!AGEN_ADDRESSES.ok) {
    throw new LaunchRecordError("Agen's contracts are not configured on this deployment.", 503);
  }

  const existing = await readLaunch(jobId);
  if (existing !== null && existing.txHash.toLowerCase() === txHash.toLowerCase()) {
    return existing;
  }

  const receipt = await publicClient()
    .getTransactionReceipt({ hash: txHash })
    .catch(() => null);

  if (receipt === null) {
    throw new LaunchRecordError("That transaction is not on this chain yet.", 404);
  }
  if (receipt.status !== "success") {
    throw new LaunchRecordError("That transaction failed, so no market was created.", 400);
  }

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

    const record: LaunchRecord = {
      jobId,
      index: Number(args.index),
      token: getAddress(args.token),
      hook: getAddress(args.hook),
      poolId: args.poolId,
      locker: getAddress(args.locker),
      txHash,
      blockNumber: receipt.blockNumber.toString(),
      at: Number(block.timestamp),
      creator: getAddress(receipt.from),
    };

    await mkdir(ROOT, { recursive: true });
    await writeFile(pathFor(jobId), `${JSON.stringify(record, null, 2)}\n`, "utf8");

    return record;
  }

  throw new LaunchRecordError(
    "That transaction did not create an Agen market through this deployment's factory.",
    400,
  );
}
