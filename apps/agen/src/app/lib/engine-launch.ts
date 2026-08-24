/**
 * The launch transaction for an approved engine-v1 build, prepared for one wallet.
 *
 * ## Why the calldata is built again here rather than served from the job
 *
 * Because the calldata the build produced was for nobody. A launch needs a creator, and a
 * creator is not known when a market is built: `AgenEngineFactory` resolves the creator from
 * `msg.sender`, and the launch's fee receiver — who collects the *liquidity* position's fees,
 * as distinct from the programmable ones the configuration names — is an argument. The build
 * used a stand-in for both so that its launchability proof executed a real transaction, and the
 * stand-in must not reach a wallet.
 *
 * What is emphatically *not* rebuilt is the economics. `encodedConfig` is read back from the
 * job and passed through unchanged, and the commitment recomputed from it is checked against
 * the one the creator signed. So this function can change who signs and who receives liquidity
 * fees, and cannot change a single rate, threshold or recipient — an attempt to would produce a
 * different commitment and be refused before any calldata is returned.
 *
 * ## What it refuses
 *
 * The same three things the engine-0 path refuses, in the same order: a build that never
 * reached preparation, an approval that is missing or belongs to a different wallet, and an
 * approval whose signature does not verify against what is stored now. The third is what makes
 * a rebuild invalidate consent rather than silently inherit it.
 */

import "server-only";

import { engineApprovalMessage, prepareLaunch } from "@verdant/market-compiler";
import type { GenerationJob, PreparedLaunch } from "@verdant/market-compiler";
import { decodeConfig } from "@verdant/market-engine";
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from "viem";

import { jobStore } from "./builds";
import { CHAIN_ID } from "./chain";
import { AGEN_LAUNCH } from "@verdant/config";
import { absoluteUrl } from "./instant";
import { engineAddressesOrNull, engineTokenSalt, ENGINE_NOT_DEPLOYED } from "./programmable";
import { recordLaunchAttempt } from "./registry/attempt";

export class EngineLaunchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EngineLaunchError";
  }
}

function address(value: string, field: string): Address {
  if (!isAddress(value, { strict: false })) {
    throw new EngineLaunchError(`${field} is not an address.`, 400);
  }

  return getAddress(value);
}

/**
 * What a wallet needs, and nothing it does not.
 *
 * The commitment and the configuration hash travel with it so the browser can show what it is
 * about to sign, and so anything replaying this response can check it against the chain. The
 * encoded configuration does not: it is already inside `data`, and returning it twice invites a
 * consumer to read the copy rather than the calldata.
 */
export interface PreparedEngineLaunch {
  readonly engineVersion: 1;
  readonly chainId: number;
  readonly to: Address;
  readonly data: Hex;
  readonly value: "0";
  readonly configHash: Hex;
  readonly implementationHash: Hex;
  /** Where the fee vault will land, now that the creator is known. */
  readonly vault: Address | null;
  readonly quoteAsset: Address;
  readonly quoteIsNative: boolean;
}

export interface EngineLaunchRequest {
  readonly jobId: string;
  /** The connected wallet. Becomes `msg.sender`, and therefore the market's creator. */
  readonly creator: string;
  /** Who collects the locked liquidity's fees. Not the programmable fee recipients. */
  readonly feeReceiver: string;
}

export async function prepareEngineLaunch(
  request: EngineLaunchRequest,
): Promise<PreparedEngineLaunch> {
  const job = await jobStore().read(request.jobId);
  if (job === null) throw new EngineLaunchError("There is no build with that id.", 404);

  const engine = job.engine;
  if (
    job.stage !== "deployment_ready" ||
    engine === null ||
    engine.encodedConfig === null ||
    engine.configHash === null ||
    engine.implementationHash === null
  ) {
    throw new EngineLaunchError("This build is not ready to launch.", 409);
  }

  const addresses = engineAddressesOrNull();
  if (addresses === null) throw new EngineLaunchError(ENGINE_NOT_DEPLOYED, 503);

  const creator = address(request.creator, "The connected wallet");
  const feeReceiver = address(request.feeReceiver, "The fee receiver");

  await requireApproval(job, creator, engine.configHash, engine.implementationHash);

  /*
   * Back to a configuration, from the bytes the commitment was taken over.
   *
   * The labels are display-only and outside the commitment, so they are supplied from the job
   * rather than recovered — which is exactly the boundary `decodeConfig` documents. Getting one
   * wrong would change a symbol on a screen and nothing about the market.
   */
  const config = decodeConfig(engine.encodedConfig, {
    launchedTokenSymbol: job.symbol,
    quoteAssetSymbol: "ETH",
    quoteAssetDecimals: 18,
  });

  const prepared: PreparedLaunch = prepareLaunch({
    config,
    parameters: {
      name: job.name,
      symbol: job.symbol,
      supply: config.referenceSupply,
      metadataURI: absoluteUrl(`/api/metadata/${job.id}.json`) ?? `/api/metadata/${job.id}.json`,
      metadataMutable: false,
      initialTick: AGEN_LAUNCH.initialTick,
      feeReceiver,
      tokenSalt: engineTokenSalt(job.id),
      specificationHash: engine.configHash,
    },
    addresses: { chainId: CHAIN_ID, ...addresses },
  });

  /*
   * The check that makes everything above safe.
   *
   * A creator signed a commitment. This recomputes it from the configuration that just produced
   * this calldata and refuses unless it is the same value. Any drift — a changed rate, a
   * different engine address, the wrong chain, a decoder that lost a tier — lands here rather
   * than on chain, and lands before the wallet is asked for anything.
   */
  if (prepared.implementationHash !== engine.implementationHash) {
    throw new EngineLaunchError(
      "This build's rules no longer produce the commitment that was approved, so the approval " +
        "does not cover it. Reviewing and approving the market again produces a launch that " +
        "matches what you see.",
      409,
    );
  }

  /*
   * The launch, written down before it can happen.
   *
   * Here and nowhere else, for two reasons that both point at this line. Everything the registry needs
   * is known: the job, the creator, the fee receiver, both hashes, the predicted vault, the factory and
   * the calldata. And nothing has been signed — what this function returns is unsigned calldata, and the
   * decision to spend gas belongs to the wallet — so this is upstream of every signature rather than
   * conditional on one.
   *
   * It is the last such point. After the return, the creator's lineage claim exists only on the job, and
   * the market that appears on chain carries no trace of it: no event, no registry field, nothing.
   * Reconciliation can find the market and match it to this row; it could never reconstruct the claim.
   *
   * Awaited and ignored. `recordLaunchAttempt` has no error channel — it resolves with an outcome
   * whatever happens, bounds itself with its own timeout, and logs what it swallowed — so awaiting it
   * cannot throw and cannot hang, and reading the outcome here would only invite a future edit to branch
   * on it. Decision 5: the registry must never be able to fail a launch, and the shape of the call is
   * where that is enforced rather than remembered.
   */
  await recordLaunchAttempt({
    jobId: job.id,
    chainId: CHAIN_ID,
    configHash: engine.configHash,
    implementationHash: engine.implementationHash,
    encodedConfig: engine.encodedConfig,
    schemaVersion: 1,
    creator,
    feeReceiver,
    factory: addresses.factory,
    predictedVault: prepared.predicted.vault,
    calldata: prepared.call.data,
    // Whatever the build was started with, unchanged. Absent on a build nobody claimed a parent for,
    // which is most of them, and absent is what produces null lineage rather than a guessed edge.
    lineage: job.lineage ?? null,
  });

  return {
    engineVersion: 1,
    chainId: prepared.chainId,
    to: prepared.call.to,
    data: prepared.call.data,
    value: "0",
    configHash: prepared.configHash,
    implementationHash: prepared.implementationHash,
    vault: prepared.predicted.vault,
    quoteAsset: prepared.quoteAsset,
    quoteIsNative: prepared.quoteIsNative,
  };
}

/** Consent, verified against what is stored now rather than against what was stored then. */
async function requireApproval(
  job: GenerationJob,
  creator: Address,
  configHash: Hex,
  implementationHash: Hex,
): Promise<void> {
  const approval = job.approval;

  const matches =
    approval !== null &&
    approval !== undefined &&
    approval.implementationHash === implementationHash &&
    approval.specificationHash === configHash &&
    approval.approvedBy.toLowerCase() === creator.toLowerCase();

  if (!matches) {
    throw new EngineLaunchError(
      "Review and approve these exact market rules with the connected wallet before launching.",
      409,
    );
  }

  const verified = await verifyMessage({
    address: creator,
    message: engineApprovalMessage({
      jobId: job.id,
      engineVersion: 1,
      configHash,
      implementationHash,
      creator,
    }),
    signature: approval.signature,
  }).catch(() => false);

  if (!verified) {
    throw new EngineLaunchError(
      "The stored approval does not verify for these exact market rules.",
      409,
    );
  }
}
