/**
 * A creator fee that can change hands: reading a seat, and the calls that move it.
 *
 * ## What a seat is for
 *
 * `InstantFeeVault.creator` is an immutable set from `params.feeRecipient` at launch, so
 * whoever a market names is paid forever and no contract in this repository can move it.
 * That is correct — a fee destination a third party can rewrite is one a compromised third
 * party can steal — and it is also the reason a market cannot be launched *on behalf of*
 * somebody who has no wallet yet.
 *
 * A seat resolves that without weakening the vault. The vault still pays one immutable
 * address forever; that address is a contract with an occupant rather than a wallet.
 * `CreatorSeat.collect(vault)` claims the market's creator share and forwards it to whoever
 * currently holds the seat, and handing the seat over changes nothing about the market, the
 * pool, the token or the liquidity lock. See ADR-016.
 *
 * ## Addresses are derived, which is what makes it usable before a launch
 *
 * `seatOf(opener, label)` is a CREATE2 derivation, so a seat's address is known before it
 * exists and one `(opener, label)` pair always resolves to the same seat. A launch can name
 * it, and the same seat can serve every market that names it. `deploy` is idempotent on
 * chain, so a caller may send it without first checking.
 *
 * The `label` is the caller's own namespace and this module takes no view on it. A caller
 * that derives labels from an off-chain identity must hash that identity rather than pass
 * it — see `apps/agen/src/app/lib/x/seat.ts`, which does exactly that with an X user id.
 *
 * ## Verifying one
 *
 * {@link readSeatIsGenuine} is the check that matters on any path where an address arrived
 * from outside. A seat is only a seat if the factory derives it, and a contract of somebody
 * else's writing at an address they nominated is not one — so a claim flow proves the
 * derivation rather than trusting the address it was handed.
 *
 * Nothing here signs or sends. The reads take a client; the writes return calldata.
 */

import type { Address, Hex, PublicClient } from "viem";
import { encodeFunctionData } from "viem";

import { creatorSeatAbi, creatorSeatFactoryAbi } from "../abi/index.js";
import type { UnsignedCall } from "../launch/create.js";

/** Where a seat is, and whether it is there yet. A pure function of its two inputs. */
export interface SeatAddress {
  readonly seat: Address;
  readonly deployed: boolean;
}

/**
 * Who holds a seat, and what is in flight around it.
 *
 * Every field is chain state. Nothing is inferred from an indexer, because the question a
 * caller is asking — is this fee mine yet — has exactly one authoritative answer.
 */
export interface SeatState {
  /** Who the seat pays. Everything it touches ends up here. */
  readonly beneficiary: Address;
  /** Who the occupant has invited, or the zero address when nobody has been. */
  readonly offered: Address;
  /** Who the steward has proposed, or the zero address. */
  readonly proposed: Address;
  /** When a steward proposal may be accepted. Zero when none is open. */
  readonly executableAt: number;
  /**
   * Whether the steward may still propose a successor.
   *
   * False after the occupant has renounced arbitration, which is one-way and is the
   * on-chain form of "not even Agen can touch this".
   */
  readonly arbitrable: boolean;
  /** The address currently allowed to propose, or the zero address if nobody is. */
  readonly steward: Address;
}

export async function readSeatAddress(
  client: PublicClient,
  {
    seatFactory,
    opener,
    label,
  }: {
    readonly seatFactory: Address;
    readonly opener: Address;
    readonly label: Hex;
  },
): Promise<SeatAddress> {
  const [seat, deployed] = await Promise.all([
    client.readContract({
      address: seatFactory,
      abi: creatorSeatFactoryAbi,
      functionName: "seatOf",
      args: [opener, label],
    }),
    client.readContract({
      address: seatFactory,
      abi: creatorSeatFactoryAbi,
      functionName: "isDeployed",
      args: [opener, label],
    }),
  ]);

  return { seat, deployed };
}

/**
 * Whether the factory really derives this seat from this opener and label.
 *
 * The check to run before treating an address as a seat on any path where it did not come
 * from {@link readSeatAddress} in the same process. A CREATE2 derivation rather than a
 * list, so it cannot be satisfied by a contract somebody wrote to look like one.
 */
export async function readSeatIsGenuine(
  client: PublicClient,
  {
    seatFactory,
    opener,
    label,
    seat,
  }: {
    readonly seatFactory: Address;
    readonly opener: Address;
    readonly label: Hex;
    readonly seat: Address;
  },
): Promise<boolean> {
  return client.readContract({
    address: seatFactory,
    abi: creatorSeatFactoryAbi,
    functionName: "isGenuine",
    args: [opener, label, seat],
  });
}

export async function readSeatState(
  client: PublicClient,
  { seat }: { readonly seat: Address },
): Promise<SeatState> {
  const [beneficiary, offered, proposed, executableAt, arbitrable, steward] = await Promise.all([
    client.readContract({ address: seat, abi: creatorSeatAbi, functionName: "beneficiary" }),
    client.readContract({ address: seat, abi: creatorSeatAbi, functionName: "offered" }),
    client.readContract({ address: seat, abi: creatorSeatAbi, functionName: "proposed" }),
    client.readContract({ address: seat, abi: creatorSeatAbi, functionName: "executableAt" }),
    client.readContract({ address: seat, abi: creatorSeatAbi, functionName: "arbitrable" }),
    client.readContract({ address: seat, abi: creatorSeatAbi, functionName: "steward" }),
  ]);

  return {
    beneficiary,
    offered,
    proposed,
    executableAt: Number(executableAt),
    arbitrable,
    steward,
  };
}

/** What this seat could take out of that vault right now, in wei. */
export async function readSeatClaimable(
  client: PublicClient,
  { seat, vault }: { readonly seat: Address; readonly vault: Address },
): Promise<bigint> {
  return client.readContract({
    address: seat,
    abi: creatorSeatAbi,
    functionName: "claimableFrom",
    args: [vault],
  });
}

/** Whether that vault actually pays this seat. The vault is the authority, not a record. */
export async function readSeatedAt(
  client: PublicClient,
  { seat, vault }: { readonly seat: Address; readonly vault: Address },
): Promise<boolean> {
  return client.readContract({
    address: seat,
    abi: creatorSeatAbi,
    functionName: "seatedAt",
    args: [vault],
  });
}

// --- the calls ---------------------------------------------------------------

/**
 * Deploy this seat, or return the existing one.
 *
 * Idempotent on chain, so a launch flow may send it without checking first. Must happen
 * *before* the launch that names it, for the reason the vault makes unavoidable: the
 * address is immutable once a market is created, so a launch naming a seat that is never
 * deployed pays an address nobody can ever occupy.
 */
export function buildDeploySeat({
  seatFactory,
  opener,
  label,
}: {
  readonly seatFactory: Address;
  readonly opener: Address;
  readonly label: Hex;
}): UnsignedCall {
  return {
    to: seatFactory,
    data: encodeFunctionData({
      abi: creatorSeatFactoryAbi,
      functionName: "deploy",
      args: [opener, label],
    }),
    value: 0n,
  };
}

/**
 * Invite `next` to take the seat. Occupant only.
 *
 * Half of the handover that needs nobody else's signature, and the half Agen sends when a
 * creator has proved who they are. It moves nothing on its own — {@link buildSeatTake} is
 * what moves the seat, and it has to be signed by the address named here. A mistyped
 * address is therefore an open invitation rather than a fee stream sent nowhere.
 */
export function buildSeatOffer({
  seat,
  next,
}: {
  readonly seat: Address;
  readonly next: Address;
}): UnsignedCall {
  return {
    to: seat,
    data: encodeFunctionData({ abi: creatorSeatAbi, functionName: "offer", args: [next] }),
    value: 0n,
  };
}

/** Withdraw an open invitation. Occupant only. */
export function buildSeatWithdrawOffer({ seat }: { readonly seat: Address }): UnsignedCall {
  return {
    to: seat,
    data: encodeFunctionData({ abi: creatorSeatAbi, functionName: "withdrawOffer" }),
    value: 0n,
  };
}

/**
 * Take the seat. Signed by the invited address and nobody else.
 *
 * The transaction that ends "launch first, account later": after it the fee stream is the
 * caller's, and Agen has no further part in it.
 */
export function buildSeatTake({ seat }: { readonly seat: Address }): UnsignedCall {
  return {
    to: seat,
    data: encodeFunctionData({ abi: creatorSeatAbi, functionName: "take" }),
    value: 0n,
  };
}

/**
 * Claim a market's creator fee out of its vault and pass it to the occupant.
 *
 * Permissionless, because it can pay nowhere else — which is what lets Agen cover the gas
 * for a creator who would rather not, and what stops a caller redirecting anything.
 *
 * Reverts when the vault owes nothing, so read {@link readSeatClaimable} first rather than
 * offering a button that spends gas to fail.
 */
export function buildSeatCollect({
  seat,
  vault,
}: {
  readonly seat: Address;
  readonly vault: Address;
}): UnsignedCall {
  return {
    to: seat,
    data: encodeFunctionData({ abi: creatorSeatAbi, functionName: "collect", args: [vault] }),
    value: 0n,
  };
}

/** Send a seat's balance of `asset` to the occupant. The zero address means ether. */
export function buildSeatSweep({
  seat,
  asset,
}: {
  readonly seat: Address;
  readonly asset: Address;
}): UnsignedCall {
  return {
    to: seat,
    data: encodeFunctionData({ abi: creatorSeatAbi, functionName: "sweep", args: [asset] }),
    value: 0n,
  };
}
