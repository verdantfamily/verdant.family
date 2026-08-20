import "server-only";

/**
 * A sponsored Instant launch.
 *
 * Not a second Instant implementation, and worth being precise about what that means, because
 * the brief forbids one and a file called `launch.ts` invites suspicion. The draft is
 * `InstantDraft`. The values come from `derive`. The document is `storeMetadata`. The salt is
 * mined by `@verdant/sdk` against Instant's own deployer. The transaction is
 * `instant.buildInstantCreate`, encoded from `instantParams`. Every one of those is the same
 * function the launch form calls, and this module contains no encoding of its own.
 *
 * Two things are different, and only two.
 *
 * The sponsor wallet signs, so `msg.sender` is Agen — which matters to the salt, since the
 * token's address is derived from the creator that deploys it, and mining against the wrong
 * one produces a salt the factory rejects.
 *
 * The fee recipient is a `CreatorSeat` rather than a wallet, because the creator is an X id
 * with no address yet. `instantParams` takes the submitted recipient as an explicit argument
 * for exactly this reason.
 */

import { parseEventLogs, type Address, type Hex } from "viem";

import { abi, instant as instantSdk, launch as launchSdk } from "@verdant/sdk";

import { CREATOR_SEAT_FACTORY, INSTANT_ADDRESSES } from "../chain";
import { absoluteUrl, instantParams, siteOriginProblem } from "../instant";
import { storeMetadata } from "../metadata";
import { publicClient } from "../onchain";
import { XError } from "./errors";
import type { PreparedLaunch } from "./generate";
import {
  seatOpenerAddress,
  sendSponsored,
  sponsorAddress,
  type OnHash,
  type SponsoredSend,
} from "./sponsor";

export interface SponsoredLaunch {
  readonly token: Address;
  readonly poolId: Hex;
  /** The market's `InstantFeeVault`. Read from the event, not from a later registry lookup. */
  readonly vault: Address;
  readonly txHash: Hex;
  /** The seat the market pays. Immutable on the vault from this moment. */
  readonly seat: Address;
  /** Gas the platform spent, across every transaction this launch needed. */
  readonly gasWei: bigint;
}

/**
 * Make sure the seat exists before a market names it.
 *
 * Idempotent on chain and cheap to skip, so the deployed check is a read rather than an
 * assumption. Ordering matters: the vault's `creator` is immutable from the moment the market
 * is created, so a market that names a seat address is committed to it whether or not anything
 * is ever deployed there. Deploying first means the address is occupied code rather than a
 * promise about a future deployment that a changed factory could invalidate.
 *
 * Two wallets appear here and they are not the same one. The sponsor pays for this transaction;
 * the dedicated opener is its `opener` argument and therefore the seat's initial occupant. The
 * factory allows that split — `deploy` is permissionless and derives the seat from its argument
 * rather than from `msg.sender` — which is what lets the paying key stay rotatable while the
 * occupying key stays fixed.
 */
export async function ensureSeat(
  seat: Address,
  label: Hex,
  deployed: boolean,
): Promise<SponsoredSend | null> {
  if (deployed) return null;

  const seatFactory = CREATOR_SEAT_FACTORY;
  if (seatFactory === null) {
    throw new XError("CONFIG_MISSING", "No CreatorSeat factory is configured.");
  }

  const opener = seatOpenerAddress();
  const call = instantSdk.buildDeploySeat({ seatFactory, opener, label });
  const sent = await sendSponsored(call);

  const now = await instantSdk.readSeatAddress(publicClient(), {
    seatFactory,
    opener,
    label,
  });
  if (!now.deployed || now.seat.toLowerCase() !== seat.toLowerCase()) {
    throw new XError("SEAT_MISMATCH", "The seat did not deploy where it was expected.", {
      details: { expected: seat, found: now.seat },
    });
  }

  return sent;
}

/**
 * Create the market.
 *
 * The one call in this feature that spends money irreversibly, kept as short as it can be so
 * that everything before it — the guards, the model, the validation, the seat — has already
 * happened by the time it runs. `onSent` is invoked with the hash the instant it is known and
 * before the receipt is waited for, which is what lets the caller record that a transaction
 * exists before it can learn whether it worked. See `engine.ts`: that record is the difference
 * between a lost launch and a duplicated one.
 */
export async function executeSponsoredLaunch(
  prepared: PreparedLaunch,
  seat: Address,
  onHash?: OnHash,
): Promise<SponsoredLaunch> {
  if (INSTANT_ADDRESSES === null) {
    throw new XError("CONFIG_MISSING", "Instant is not configured on this deployment.");
  }

  const origin = siteOriginProblem();
  if (origin !== null) throw new XError("CONFIG_MISSING", origin);

  const derived = prepared.derived;
  if (derived.image === null) {
    throw new XError("GENERATION_FAILED", "That token has no logo to record.");
  }

  const stored = await storeMetadata({
    name: derived.name,
    symbol: derived.symbol,
    description: prepared.description,
    image: derived.image,
    links: derived.links,
  });

  const metadataURI = absoluteUrl(stored.url);
  if (metadataURI === null) {
    throw new XError("CONFIG_MISSING", "The metadata document has no public address.");
  }

  const client = publicClient();
  // The sponsor, because this name means `msg.sender` to the salt derivation and the sponsor is
  // what submits this transaction. It is not who the fees belong to: that is the seat, passed as
  // `feeRecipient` below, and occupied by the opener until its creator claims it.
  const creator = sponsorAddress();

  const initCodeHash = await launchSdk.readTokenInitCodeHash(client, {
    deployer: INSTANT_ADDRESSES.deployer,
    name: derived.name,
    symbol: derived.symbol,
    supplyTokens: derived.supplyTokens,
    metadataURI,
    metadataMutable: false,
    creator,
  });

  const mined = launchSdk.mineTokenSalt({
    deployer: INSTANT_ADDRESSES.deployer,
    creator,
    initCodeHash,
    above: "0x0000000000000000000000000000000000000000",
  });

  const call = instantSdk.buildInstantCreate({
    factory: INSTANT_ADDRESSES.factory,
    params: instantParams({ derived, metadataURI, salt: mined.salt, feeRecipient: seat }),
  });

  const sent = await sendSponsored(call, onHash);

  const [event] = parseEventLogs({
    abi: abi.instantFactoryAbi,
    eventName: "MarketCreated",
    logs: sent.receipt.logs,
  });

  if (event === undefined) {
    // A successful receipt with no market in it should be impossible. It is checked because
    // the alternative is recording a launch with no token address and telling somebody their
    // market is live.
    throw new XError("LAUNCH_REVERTED", "The transaction went through but did not create a market.", {
      details: { hash: sent.hash },
    });
  }

  return {
    token: event.args.token,
    poolId: event.args.poolId,
    vault: event.args.vault,
    txHash: sent.hash,
    seat,
    gasWei: sent.gasWei,
  };
}
