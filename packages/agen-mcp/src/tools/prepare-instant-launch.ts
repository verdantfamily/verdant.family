/**
 * `prepare_instant_launch` — calldata for a launch, and nothing else.
 *
 * ## It cannot launch anything
 *
 * This calls `POST /api/v1/instant/prepare`, which stores the metadata document, mines the
 * salt and encodes `InstantFactory.create` with the same encoder the browser uses. It answers
 * with a transaction. It does not sign one, does not send one, and cannot: this process holds
 * no key, and the route it calls has no signer either.
 *
 * That is why the fee receiver may be any address here. The wallet that pays for the
 * transaction is the wallet that names the destination, so there is nobody else's money to
 * misdirect — the property that made the old combined tool's fee-receiver handling delicate is
 * simply absent once the two paths are separate tools.
 *
 * The answer says so three times over — `execution_status: "prepared"`, `requires_signature`,
 * `requires_broadcast` — because "here is a transaction" is genuinely ambiguous about whose
 * turn it is, and an agent that guesses either signs nothing or signs twice.
 *
 * ## Not retried
 *
 * See `clients/http.ts`. This stores a document and mines a salt, so a timeout means find out
 * what happened rather than ask again.
 */

import type { InstantPrepareResponse } from "../clients/agen.js";
import { explorerUrl, marketUrl, runTool, type ToolContext, type ToolResult } from "./context.js";

export interface PrepareInstantLaunchInput {
  readonly name: string;
  readonly symbol: string;
  readonly imageUrl: string;
  readonly signer?: string | undefined;
  readonly feeReceiver?: string | undefined;
  readonly initialBuyEth?: string | undefined;
  readonly totalSupply?: string | undefined;
  readonly description?: string | undefined;
  readonly boostCapable?: boolean | undefined;
  readonly linkX?: string | undefined;
  readonly website?: string | undefined;
  readonly telegram?: string | undefined;
}

export function prepareInstantLaunch(
  context: ToolContext,
  input: PrepareInstantLaunchInput,
): Promise<ToolResult> {
  return runTool({ name: "prepare_instant_launch", context, input }, async ({ requestId }) => {
    const prepared: InstantPrepareResponse = await context.agen.prepare(
      {
        name: input.name,
        symbol: input.symbol,
        imageUrl: input.imageUrl,
        ...(input.signer === undefined ? {} : { signer: input.signer }),
        ...(input.feeReceiver === undefined ? {} : { feeReceiver: input.feeReceiver }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.initialBuyEth === undefined ? {} : { initialBuy: input.initialBuyEth }),
        ...(input.boostCapable === undefined ? {} : { boostCapable: input.boostCapable }),
        ...(input.linkX === undefined ? {} : { linkX: input.linkX }),
        ...(input.website === undefined ? {} : { website: input.website }),
        ...(input.telegram === undefined ? {} : { telegram: input.telegram }),
      },
      requestId,
    );

    return {
      execution_status: "prepared",
      requires_signature: true,
      requires_broadcast: true,
      signedBy: "caller_wallet",

      chainId: prepared.chainId,
      token: prepared.token,
      tokenAddressIsPredicted: true,
      pool: null,
      txHash: null,
      launchId: null,
      creator: prepared.signer,
      feeReceiver: prepared.feeRecipient,
      feePayoutAddress: prepared.feePayoutAddress,
      name: prepared.name,
      symbol: prepared.symbol,
      supplyTokens: prepared.supplyTokens,
      initialBuyWei: prepared.initialBuyWei,
      transaction: prepared.transaction,
      escrowTransaction: prepared.escrowTransaction,
      metadataURI: prepared.metadataURI,
      preparedAt: Math.floor(Date.now() / 1000),
      urls: {
        market: marketUrl(context.env, prepared.token),
        explorerTx: null,
        explorerToken: explorerUrl(context.env, "address", prepared.token),
      },
      nextStep:
        prepared.escrowTransaction === null
          ? `Sign and send transaction from ${prepared.signer}. Nothing has been signed or spent yet. Then call get_launch_status with the resulting txHash.`
          : `Sign and send escrowTransaction first and wait for it to confirm, then send transaction — both from ${prepared.signer}. Nothing has been signed or spent yet.`,
    };
  });
}
