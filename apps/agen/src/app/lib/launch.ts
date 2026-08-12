/**
 * Turning a cleared build into the one transaction a creator signs.
 *
 * The build already proved this market can be deployed — the pipeline assembles the
 * whole bundle before it calls a job ready, and fails the build if it cannot. What it
 * could not do is produce the bytes, because every address in an Agen bundle depends on
 * the creator's own address: their salt is mixed into each component's, and the hook is
 * mined from creation code that contains the addresses that produces. So the manifest is
 * built here, once a wallet is connected, from artefacts the build left on disk.
 *
 * ## Why this is on the server
 *
 * Not for secrecy — there is nothing secret in a manifest, and the same code would run
 * in a browser. It is because the inputs are: the compiled artefacts are a few megabytes
 * of creation code sitting in the job's directory, and shipping them to the browser to
 * be reassembled there would move the slowest part of a launch onto the creator's
 * connection for no gain.
 *
 * The parts that decide anything are still checked where they can be seen. The response
 * names the addresses the market will land on and the valuation it will really open at,
 * and the screen shows both before the wallet is asked for anything.
 *
 * ## Nothing here sends a transaction
 *
 * This returns unsigned calldata. The decision to spend gas belongs to the wallet, and
 * the server holds no key and has no way to launch anything on a creator's behalf.
 */

import "server-only";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { BuildArtifacts, DeployableManifest, GenerationJob } from "@verdant/market-compiler";
import {
  assembleManifest,
  initialTickProblem,
  ManifestError,
  marketSaltFor,
  NATIVE_QUOTE,
  toFactoryArguments,
} from "@verdant/market-compiler";
import { agen } from "@verdant/sdk";
import { getAddress, isAddress, type Address, type Hex } from "viem";

import { AGEN_ADDRESSES, EXTERNAL } from "./chain";
import { GENERATED_ROOT, jobStore } from "./builds";

/** Whole tokens to base units. Every generated token has eighteen decimals. */
const TOKEN_SCALE = 10n ** 18n;

export interface LaunchRequest {
  readonly jobId: string;
  /** The connected wallet. Receives the market, and is mixed into every salt. */
  readonly creator: string;
  /** What the market should be worth when it opens, in wei. */
  readonly valuationWei: bigint;
  /** Where trading fees are paid for the life of the market. */
  readonly feeReceiver: string;
  /** Spent on the market inside the launch. Zero, or absent, buys nothing. */
  readonly devBuyWei?: bigint;
  readonly metadataURI?: string;
}

/** What the launch screen shows, and what the wallet is asked to sign. */
export interface PreparedLaunch {
  readonly transaction: {
    readonly to: Address;
    readonly data: Hex;
    /** Wei. Carried as a string because a route hands this to JSON. */
    readonly value: string;
  };
  readonly market: {
    readonly token: Address;
    readonly hook: Address;
    readonly initialTick: number;
    /** What the market will actually be worth at the opening tick, in wei. */
    readonly valuationWei: string;
    readonly contracts: number;
  };
}

export class LaunchError extends Error {
  constructor(
    message: string,
    /** What the route should answer with. 400 for a creator's input, 409 for a build. */
    readonly status: number,
  ) {
    super(message);
    this.name = "LaunchError";
  }
}

function address(value: string, what: string): Address {
  if (!isAddress(value, { strict: false })) {
    throw new LaunchError(`${what} is not an address.`, 400);
  }
  return getAddress(value);
}

/**
 * The compiled bundle, as the build left it.
 *
 * Read from the job's own directory rather than from the job record: creation code for
 * every contract in a market is far too large to carry in a document the build screen
 * polls twice a second.
 */
async function artefactsFor(jobId: string): Promise<BuildArtifacts> {
  const path = resolve(GENERATED_ROOT, jobId, "artifacts", "build.json");

  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) {
    throw new LaunchError(
      "This build's compiled contracts are no longer on disk, so it cannot be launched. " +
        "Building the market again will produce them.",
      409,
    );
  }

  return JSON.parse(raw) as BuildArtifacts;
}

/**
 * Build the manifest for this creator and encode the launch.
 *
 * Every refusal here is one the chain would also make, and making it first is the whole
 * point: a launch that reverts costs a creator gas and leaves them with no market and no
 * explanation beyond a custom error thrown three frames inside a swap.
 */
export async function prepareLaunch(request: LaunchRequest): Promise<PreparedLaunch> {
  if (!AGEN_ADDRESSES.ok) {
    throw new LaunchError(
      "Agen's contracts are not configured on this deployment, so there is nothing to " +
        "launch through. " +
        AGEN_ADDRESSES.problems.map((problem) => `${problem.label} (${problem.variable})`).join(", "),
      503,
    );
  }

  const job: GenerationJob | null = await jobStore()
    .read(request.jobId)
    .catch(() => null);

  if (job === null) throw new LaunchError("No such build.", 404);

  // Both conditions, though the pipeline makes the second follow from the first. Read
  // separately because this is the last place either can be checked, and a ready job
  // with no manifest would mean the build lied about being ready.
  if (job.stage !== "deployment_ready") {
    throw new LaunchError("This build was not cleared for deployment.", 409);
  }
  if (job.manifest === null) {
    throw new LaunchError(
      "This build is marked ready but carries no manifest, which should not be possible. " +
        "It cannot be launched.",
      409,
    );
  }
  if (job.plan === null) {
    throw new LaunchError("This build has no architecture to deploy.", 409);
  }

  const creator = address(request.creator, "The connected wallet");
  const feeReceiver = address(request.feeReceiver, "The fee receiver");

  const devBuyAmount = request.devBuyWei ?? 0n;
  if (devBuyAmount < 0n) throw new LaunchError("A launch buy cannot be negative.", 400);

  // Refused here as well as in the manifest builder, so the message a creator sees is
  // the one written for them rather than the one written for a stack trace.
  if (devBuyAmount > 0n && !job.manifest.supportsAtomicDevBuy) {
    throw new LaunchError(
      job.manifest.devBuyUnavailableReason ??
        "This market cannot be bought from during its own launch.",
      400,
    );
  }

  const supply = job.manifest.supplyTokens * TOKEN_SCALE;

  let initialTick: number;
  try {
    initialTick = agen.initialTickForValuation({ supply, valuation: request.valuationWei });
  } catch (error) {
    throw new LaunchError(
      `That starting valuation cannot be expressed as an opening price. ${
        error instanceof Error ? error.message : ""
      }`,
      400,
    );
  }

  // The grid is `AgenCurve`'s and the factory reverts off it, so this is a second check
  // on arithmetic that has already rounded. Cheap, and the failure it catches is one a
  // creator would otherwise pay gas to discover.
  const offGrid = initialTickProblem(initialTick);
  if (offGrid !== null) throw new LaunchError(offGrid, 400);

  const artefacts = await artefactsFor(request.jobId);

  let manifest: DeployableManifest;
  try {
    manifest = assembleManifest({
      plan: job.plan,
      artifacts: artefacts.contracts,
      environment: {
        poolManager: EXTERNAL.poolManager,
        installer: AGEN_ADDRESSES.addresses.factory,
        creator,
        // The creator's choice, and a real one: a component that takes a fee receiver
        // holds it in an immutable, so this is the address that market pays for as long
        // as it trades. It defaults to the creator's wallet on the launch screen.
        feeReceiver,
        name: job.name,
        symbol: job.symbol,
        supplyTokens: job.manifest.supplyTokens,
      },
      specificationHash: artefacts.specificationHash,
      implementationHash: artefacts.implementationHash,
      quoteAsset: NATIVE_QUOTE,
      // The build read this off the hook and failed if it could not. Taken from the
      // manifest rather than recomputed, so the pool this opens is the one the build
      // cleared — and never a default that the market's own rules would reject.
      lpFee: job.manifest.lpFee,
      initialTick,
      feeReceiver,
      devBuyAmount,
      // No floor on what the launch buy delivers. The creator is buying from liquidity
      // this same transaction created, at a price they chose, with nobody able to get
      // in front of them — the three things a slippage bound protects against are all
      // absent, and a bound set here would be a number the interface invented.
      devBuyMinTokens: 0n,
      atomicDevBuySupported: job.manifest.supportsAtomicDevBuy,
      ...(request.metadataURI === undefined ? {} : { metadataURI: request.metadataURI }),
      marketSalt: marketSaltFor(job.id),
      deployerAddress: AGEN_ADDRESSES.addresses.deployer,
    });
  } catch (error) {
    // A build that reached `deployment_ready` assembled once already, against probe
    // addresses. Reaching this means something that depends on the real ones failed —
    // most plausibly the token not sorting above the quote asset for this creator — and
    // it is not the creator's mistake to explain away.
    throw new LaunchError(
      error instanceof ManifestError
        ? `This market cannot be launched from this wallet. ${error.message}`
        : "This market could not be prepared for launch.",
      409,
    );
  }

  // The SDK owns the encoding. The struct is thirteen fields deep and positional, and a
  // second copy of its field order maintained in an interface is a launch nobody asked
  // for, one transposition later.
  const [factoryManifest] = toFactoryArguments(manifest);
  const call = agen.buildDeployMarket({
    factory: AGEN_ADDRESSES.addresses.factory,
    manifest: factoryManifest,
  });

  return {
    transaction: { to: call.to, data: call.data, value: call.value.toString() },
    market: {
      token: manifest.components[manifest.tokenIndex]!.expected,
      hook: manifest.components[manifest.hookIndex]!.expected,
      initialTick,
      valuationWei: agen.valuationAtTick({ supply, tick: initialTick }).toString(),
      contracts: manifest.components.length,
    },
  };
}
