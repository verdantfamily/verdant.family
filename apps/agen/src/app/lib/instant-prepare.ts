/**
 * An Instant launch, encoded for somebody else's wallet to sign.
 *
 * ## Why this exists
 *
 * There are two ways to launch on this deployment and they differ only in who holds the
 * key. A browser signs with the creator's wallet (`launch/instant/preview.tsx`); an agent
 * signs with its own treasury (`lib/agents/instant.ts`). An external caller — an MCP
 * client, a bot, a script — has a third position: it can build a transaction but must not
 * be given a key, and Agen must not be given one either.
 *
 * So this returns unsigned calldata and nothing else. It is the same answer
 * `POST /api/markets/[id]/launch` gives for a Programmable launch, for the same stated
 * reason: the decision to spend gas belongs to the wallet, and the server holds no key.
 *
 * ## What it does not decide
 *
 * The supply, the opening tick, the quote asset and the fee are constants of
 * `InstantFactory` and appear nowhere below. The draft becomes values through `derive`, is
 * checked by `validate`, and becomes the factory's argument through `instantParams` —
 * the three functions the browser uses, unchanged. The only thing assembled here is the
 * order those run in.
 *
 * ## The transaction must be sent by `signer`
 *
 * `InstantFactory.create` namespaces the salt by `msg.sender` and records it as the
 * creator, so the token address returned below is the address this launch lands on *only*
 * when this exact calldata is sent from `signer`. Sent from anywhere else it still
 * launches, at a different address, with the sender as creator. That is stated in the
 * result rather than assumed.
 */

import { instant as instantSdk, launch as launchSdk } from "@verdant/sdk";
import { isAddress, type Address, type Hex } from "viem";

import { AgentError } from "./agents/errors";
import { BOOST_ADDRESSES, CHAIN_ID, INSTANT_ADDRESSES } from "./chain";
import {
  INSTANT_SUPPLY_TOKENS,
  absoluteUrl,
  derive,
  emptyDraft,
  instantParams,
  siteOriginProblem,
  validate,
  type InstantDraft,
} from "./instant";
import { storeMetadata } from "./metadata";
import { publicClient } from "./onchain";

export interface InstantPrepareRequest {
  readonly name: string;
  readonly symbol: string;
  readonly imageUrl: string;
  /** The address that will send the returned transaction. */
  readonly signer: Address;
  readonly description?: string | undefined;
  readonly initialBuy?: string | undefined;
  readonly feeReceiver?: string | undefined;
  readonly boostCapable?: boolean | undefined;
  readonly linkX?: string | undefined;
  readonly website?: string | undefined;
  readonly telegram?: string | undefined;
}

export interface UnsignedTransaction {
  readonly to: Address;
  readonly data: Hex;
  /** Wei, as a decimal string. */
  readonly value: string;
  readonly chainId: number;
}

export interface InstantPrepared {
  readonly chainId: number;
  readonly signer: Address;

  /** The launch itself. Send this from `signer`. */
  readonly transaction: UnsignedTransaction;

  /**
   * A one-off escrow deployment that must land first, or null.
   *
   * Only ever present for a creator's first Boost-capable launch. `InstantFeeVault` makes
   * the recipient immutable, so naming an escrow that does not exist yet would produce a
   * market whose fees are permanently unreachable — which is why this is a separate
   * transaction rather than something folded into the launch.
   */
  readonly escrowTransaction: UnsignedTransaction | null;

  /** Where the token lands, provided the launch is sent from `signer`. */
  readonly token: Address;
  readonly salt: Hex;
  readonly metadataURI: string;

  /** The address the vault is built with, after any escrow is resolved. */
  readonly feeRecipient: Address;
  /** The address the creator named, which the escrow pays. */
  readonly feePayoutAddress: Address;

  readonly name: string;
  readonly symbol: string;
  readonly supplyTokens: string;
  readonly initialBuyWei: string;
}

export async function prepareInstantLaunch(
  request: InstantPrepareRequest,
): Promise<InstantPrepared> {
  if (INSTANT_ADDRESSES === null) {
    throw new AgentError("CONFIG_MISSING", "Instant is not configured on this deployment.");
  }

  const origin = siteOriginProblem();
  if (origin !== null) throw new AgentError("CONFIG_MISSING", origin);

  const named = request.feeReceiver?.trim() ?? "";
  if (named !== "" && !isAddress(named, { strict: false })) {
    throw new AgentError("VALIDATION_FAILED", "The fee receiver is not an address.");
  }

  const draft: InstantDraft = {
    ...emptyDraft(),
    name: request.name,
    symbol: request.symbol,
    imageUrl: request.imageUrl,
    description: request.description ?? "",
    feeReceiver: named,
    useConnectedWallet: named === "",
    initialBuy: request.initialBuy ?? "",
    boostCapable: request.boostCapable ?? true,
    linkX: request.linkX ?? "",
    website: request.website ?? "",
    telegram: request.telegram ?? "",
  };

  const problems = validate(draft, request.signer);
  if (problems.length > 0) {
    throw new AgentError("VALIDATION_FAILED", problems[0]!, { details: { problems } });
  }

  const derived = derive(draft, request.signer);
  if (derived === null || derived.image === null || derived.feeRecipient === null) {
    throw new AgentError("VALIDATION_FAILED", "That Instant draft could not be derived.");
  }

  // The document first, because its address is a constructor argument of the token and so
  // decides the address the salt is mined against.
  const stored = await storeMetadata({
    name: derived.name,
    symbol: derived.symbol,
    description: draft.description,
    image: derived.image,
    links: derived.links,
  });

  const metadataURI = absoluteUrl(stored.url);
  if (metadataURI === null) {
    throw new AgentError("CONFIG_MISSING", "The metadata document has no public address.");
  }

  const client = publicClient();

  const initCodeHash = await launchSdk.readTokenInitCodeHash(client, {
    deployer: INSTANT_ADDRESSES.deployer,
    name: derived.name,
    symbol: derived.symbol,
    supplyTokens: derived.supplyTokens,
    metadataURI,
    metadataMutable: false,
    creator: request.signer,
  });

  const mined = launchSdk.mineTokenSalt({
    deployer: INSTANT_ADDRESSES.deployer,
    creator: request.signer,
    initCodeHash,
    above: "0x0000000000000000000000000000000000000000",
  });

  const payout = derived.feeRecipient;
  let feeRecipient: Address = payout;
  let escrowTransaction: UnsignedTransaction | null = null;

  if (derived.boostCapable && BOOST_ADDRESSES !== null) {
    const escrow = await instantSdk.readEscrowAddress(client, {
      escrowFactory: BOOST_ADDRESSES.escrowFactory,
      owner: payout,
    });
    feeRecipient = escrow.escrow;

    if (!escrow.deployed) {
      const deploy = instantSdk.buildDeployEscrow({
        escrowFactory: BOOST_ADDRESSES.escrowFactory,
        owner: payout,
      });
      escrowTransaction = unsigned(deploy);
    }
  }

  const call = instantSdk.buildInstantCreate({
    factory: INSTANT_ADDRESSES.factory,
    params: instantParams({ derived, metadataURI, salt: mined.salt, feeRecipient }),
  });

  return {
    chainId: CHAIN_ID,
    signer: request.signer,
    transaction: unsigned(call),
    escrowTransaction,
    token: mined.token,
    salt: mined.salt,
    metadataURI,
    feeRecipient,
    feePayoutAddress: payout,
    name: derived.name,
    symbol: derived.symbol,
    supplyTokens: INSTANT_SUPPLY_TOKENS.toString(),
    initialBuyWei: derived.initialBuyWei.toString(),
  };
}

function unsigned(call: { readonly to: Address; readonly data: Hex; readonly value: bigint }): UnsignedTransaction {
  return { to: call.to, data: call.data, value: call.value.toString(), chainId: CHAIN_ID };
}
