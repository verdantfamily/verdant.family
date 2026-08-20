import "server-only";

/**
 * Where an X user's fees live before they have a wallet.
 *
 * The problem this solves is narrow and hard. `InstantFeeVault.creator` is immutable, set
 * from `params.feeRecipient` when the market is created, so the launch has to name the final
 * destination of the creator's 1.00% at the moment it happens — and at that moment the
 * creator is a numeric X id with no address in the world.
 *
 * So the market names a `CreatorSeat` instead: an address derived from that X id, deployed
 * before the launch, occupied by Agen's opener until the person proves who they are. The
 * vault still pays one immutable address forever. That address just has an occupant, and the
 * occupant can change. See `packages/sdk/src/instant/seat.ts` and ADR-016.
 *
 * ## The label is a hash, not the id
 *
 * `seatOf(opener, label)` derives the address from a 32-byte label, and this module always
 * passes `keccak256("agen.x.v1:" + xUserId)`. Two reasons, and both matter.
 *
 * A raw id padded into 32 bytes would put the X user id on chain in plain sight, permanently,
 * for every launch — and the person launching a token from a reply did not agree to publish
 * a durable link between their X account and an address. The hash is a one-way function of an
 * identifier X hands out publicly, so it is not privacy in the cryptographic sense, but it
 * stops the mapping being *readable* rather than merely derivable.
 *
 * The prefix is a domain tag. Without it, the same 32 bytes could be produced by a different
 * Agen subsystem numbering something else, and two subsystems that collide on a label collide
 * on a seat — which means one user's fees paying another's. The version in it is what lets a
 * future scheme exist without either colliding with this one or migrating it.
 *
 * ## The custody position, stated plainly
 *
 * Between the launch and the handover, Agen's opener occupies the seat. `collect` pays the
 * occupant, so during that window Agen *could* take a creator's fees. It does not: nothing in
 * this codebase calls `collect` for an unclaimed seat, the claim path offers the seat before
 * anything is collected, and the opener key is refused any selector but `offer` and
 * `withdrawOffer` by `sponsor.ts` — so taking fees would require using that key outside this
 * system entirely. That is narrow, but it is still a policy rather than a proof: the alternative —
 * opening the seat to an address nobody controls — would make the first claim wait out the
 * steward timelock. The product decision was the faster handover; this comment exists so the
 * trade is written down where the code implements it rather than argued once and forgotten.
 */

import { getAddress, keccak256, toBytes, type Address, type Hex } from "viem";

import { instant as instantSdk } from "@verdant/sdk";

import { CREATOR_SEAT_FACTORY } from "../chain";
import { publicClient } from "../onchain";
import { XError } from "./errors";
import { seatOpenerAddress } from "./sponsor";

/**
 * The label for an X user id.
 *
 * A pure function, tested against fixed vectors, because it is the only thing standing
 * between a creator and their fees: the same id must derive the same label in every process,
 * forever, or a returning creator is offered a seat that no market pays.
 */
export function seatLabel(xUserId: string): Hex {
  if (!/^\d{1,25}$/.test(xUserId)) {
    throw new XError("VALIDATION_FAILED", "That is not an X user id.", {
      details: { xUserId },
    });
  }
  return keccak256(toBytes(`agen.x.v1:${xUserId}`));
}

export interface SeatFor {
  readonly seat: Address;
  readonly deployed: boolean;
  readonly opener: Address;
  readonly label: Hex;
}

/**
 * Where this X user's seat is, whether or not it exists yet.
 *
 * The opener is the dedicated seat-opener wallet — deliberately not the sponsor — and it is
 * part of the derivation. That is the whole reason the two keys are separate: the sponsor signs
 * constantly and should be rotatable on a bad afternoon, whereas a new opener address derives a
 * different population of seats and cannot move the existing ones. Markets launched before a
 * change of opener keep paying the seats the old address opened, and handing those over needs
 * the old key. So this address is effectively permanent, and rotating the sponsor is free.
 * `SEAT_OPENER_NOTE` in the deployment runbook is the same warning where an operator meets it.
 */
export async function seatFor(xUserId: string): Promise<SeatFor> {
  const seatFactory = CREATOR_SEAT_FACTORY;
  if (seatFactory === null) {
    throw new XError(
      "CONFIG_MISSING",
      "No CreatorSeat factory is configured, so a launch has nowhere to send creator fees.",
    );
  }

  const opener = seatOpenerAddress();
  const label = seatLabel(xUserId);
  const found = await instantSdk.readSeatAddress(publicClient(), { seatFactory, opener, label });

  return { seat: getAddress(found.seat), deployed: found.deployed, opener, label };
}

/**
 * Prove an address is the seat this X user's markets pay.
 *
 * Run before offering a seat to a wallet. The record in the database says which seat a launch
 * named, and a record is a claim about the past — this re-derives it from the X id and asks
 * the factory, so a corrupted or tampered row cannot cause the seat of one user to be offered
 * to another.
 */
export async function assertSeatBelongsTo(xUserId: string, seat: Address): Promise<void> {
  const derived = await seatFor(xUserId);
  if (derived.seat.toLowerCase() !== seat.toLowerCase()) {
    throw new XError("SEAT_MISMATCH", "That seat is not derived from this X account.", {
      details: { expected: derived.seat, found: seat },
    });
  }
}
