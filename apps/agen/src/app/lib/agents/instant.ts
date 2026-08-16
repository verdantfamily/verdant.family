/**
 * Instant launches for an agent, through the production Instant path.
 *
 * This is not a second Instant implementation. The draft is the same `InstantDraft`,
 * the values are `derive` / `validate` / `instantParams`, the document is
 * `storeMetadata`, the salt is mined by `@verdant/sdk` against Instant's deployer,
 * and the transaction is `instant.buildInstantCreate`. The only new work is that
 * the agent wallet signs instead of a browser wallet.
 */

import { parseEventLogs, type Address, type Hex } from "viem";

import { abi, instant as instantSdk, launch as launchSdk } from "@verdant/sdk";

import { BOOST_ADDRESSES, INSTANT_ADDRESSES } from "../chain";
import {
  absoluteUrl,
  derive,
  emptyDraft,
  instantParams,
  siteOriginProblem,
  validate,
  type InstantDraft,
} from "../instant";
import { storeMetadata } from "../metadata";
import { publicClient } from "../onchain";
import { AgentError } from "./errors";
import { assertMainnetSigning } from "./mainnet";
import { sendApproved, type SendResult } from "./signer";
import type { AgentStore } from "./store";
import type { AgentRecord } from "./types";

export interface AgentInstantRequest {
  readonly name: string;
  readonly symbol: string;
  readonly imageUrl: string;
  readonly description?: string;
  readonly initialBuy?: string;
  readonly boostCapable?: boolean;
  readonly linkX?: string;
  readonly website?: string;
  readonly telegram?: string;
}

export interface InstantLaunchResult {
  readonly token: Address;
  readonly poolId: Hex;
  readonly txHash: Hex;
  readonly feeRecipient: Address;
  readonly spendWei: bigint;
}

export function draftFromRequest(body: AgentInstantRequest, wallet: Address): InstantDraft {
  return {
    ...emptyDraft(),
    name: body.name,
    symbol: body.symbol,
    imageUrl: body.imageUrl,
    description: body.description ?? "",
    feeReceiver: wallet,
    useConnectedWallet: true,
    initialBuy: body.initialBuy ?? "",
    boostCapable: body.boostCapable ?? true,
    linkX: body.linkX ?? "",
    website: body.website ?? "",
    telegram: body.telegram ?? "",
  };
}

export function spendWeiOf(draft: InstantDraft, wallet: Address): bigint {
  const derived = derive(draft, wallet);
  return derived?.initialBuyWei ?? 0n;
}

export async function executeInstantLaunch(
  store: AgentStore,
  agent: AgentRecord,
  body: AgentInstantRequest,
  send: typeof sendApproved = sendApproved,
): Promise<InstantLaunchResult> {
  assertMainnetSigning();
  if (INSTANT_ADDRESSES === null) {
    throw new AgentError("CONFIG_MISSING", "Instant is not configured on this deployment.");
  }

  const origin = siteOriginProblem();
  if (origin !== null) throw new AgentError("CONFIG_MISSING", origin);

  const draft = draftFromRequest(body, agent.walletAddress);
  const problems = validate(draft, agent.walletAddress);
  if (problems.length > 0) {
    throw new AgentError("VALIDATION_FAILED", problems[0]!, { details: { problems } });
  }

  const derived = derive(draft, agent.walletAddress);
  if (derived === null || derived.image === null || derived.feeRecipient === null) {
    throw new AgentError("VALIDATION_FAILED", "That Instant draft could not be derived.");
  }

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
  const identity = {
    name: derived.name,
    symbol: derived.symbol,
    supplyTokens: derived.supplyTokens,
    metadataURI,
    metadataMutable: false as const,
    creator: agent.walletAddress,
  };

  const initCodeHash = await launchSdk.readTokenInitCodeHash(client, {
    deployer: INSTANT_ADDRESSES.deployer,
    ...identity,
  });

  const mined = launchSdk.mineTokenSalt({
    deployer: INSTANT_ADDRESSES.deployer,
    creator: agent.walletAddress,
    initCodeHash,
    above: "0x0000000000000000000000000000000000000000",
  });

  let feeRecipient = derived.feeRecipient;
  if (derived.boostCapable && BOOST_ADDRESSES !== null) {
    const escrow = await instantSdk.readEscrowAddress(client, {
      escrowFactory: BOOST_ADDRESSES.escrowFactory,
      owner: derived.feeRecipient,
    });
    feeRecipient = escrow.escrow;
    if (!escrow.deployed) {
      const deploy = instantSdk.buildDeployEscrow({
        escrowFactory: BOOST_ADDRESSES.escrowFactory,
        owner: derived.feeRecipient,
      });
      await send(store, agent.id, deploy);
    }
  }

  const call = instantSdk.buildInstantCreate({
    factory: INSTANT_ADDRESSES.factory,
    params: instantParams({
      derived,
      metadataURI,
      salt: mined.salt,
      feeRecipient,
    }),
  });

  const sent: SendResult = await send(store, agent.id, call);

  const [event] = parseEventLogs({
    abi: abi.instantFactoryAbi,
    eventName: "MarketCreated",
    logs: sent.receipt.logs,
  });

  if (event === undefined) {
    throw new AgentError("VALIDATION_FAILED", "The transaction went through but did not create a market.");
  }

  return {
    token: event.args.token,
    poolId: event.args.poolId,
    txHash: sent.hash,
    feeRecipient,
    spendWei: derived.initialBuyWei,
  };
}
