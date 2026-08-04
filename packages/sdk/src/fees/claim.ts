/**
 * Reading and claiming a market's fees.
 *
 * ## The path a fee takes
 *
 * A swap pays the pool's LP fee, and **all of it** accrues inside the locked position —
 * the hook sets the rate and never touches the split (ADR-005). Nothing is owed to
 * anybody until that fee is realised, which is what `PositionLocker.collect()` does: it
 * decreases the position's liquidity by zero, which in Uniswap v4 sweeps the accrued fees
 * without touching the principal, and sends both currencies to the market's `FeeSplitter`.
 * Only then does the splitter divide what arrived and let a recipient take their share.
 *
 * Two consequences shape every function here.
 *
 * **`claimable` is not "what you have earned".** It is what is sitting in the splitter and
 * has not been taken yet. Fees still inside the position are earned and invisible to it,
 * so a market that has traded all day reports zero until somebody collects. An interface
 * that showed `claimable` alone and called it earnings would tell a creator they had made
 * nothing.
 *
 * **Collecting is not claiming.** They are different contracts, different transactions,
 * and different permissions: anyone may call `collect`, only a recipient may `claim`. A
 * creator starting from an uncollected market needs both, in that order.
 *
 * Nothing here signs or sends. The reads take a client; the writes return calldata, and
 * the decision to spend gas stays with the caller.
 */

import type { Address, PublicClient } from "viem";
import { encodeFunctionData } from "viem";

import { feeSplitterAbi, positionLockerAbi } from "../abi/index.js";
import type { UnsignedCall } from "../launch/create.js";

/**
 * What a recipient could take right now, in both of a market's currencies.
 *
 * Fees accrue on whichever side of the pool a swap crossed, so a market that has been
 * bought and sold owes its creator some of each — the quote asset and the launch token —
 * and `claim` pays both in one transaction. Reporting only the quote side would hide half
 * of what a market has earned.
 */
export interface Claimable {
  /** Base units of the market's quote asset: wei for ether, the equity's units otherwise. */
  readonly quote: bigint;
  /** Base units of the launch token. */
  readonly token: bigint;
}

/**
 * What `recipient` may claim from this splitter.
 *
 * Returns zeroes for an address that is neither the fee recipient nor the treasury, which
 * is the contract's own answer rather than an error — so this is safe to call for any
 * address without first checking whether it is entitled to anything.
 */
export async function readClaimable(
  client: PublicClient,
  {
    splitter,
    recipient,
  }: {
    readonly splitter: Address;
    readonly recipient: Address;
  },
): Promise<Claimable> {
  const [quote, token] = await client.readContract({
    address: splitter,
    abi: feeSplitterAbi,
    functionName: "claimable",
    args: [recipient],
  });

  return { quote, token };
}

/**
 * What a claim would actually pay right now, and whether it needs a collection first.
 *
 * `readClaimable` alone is the wrong number to show a creator. It reports the splitter's
 * balance, and fees live in the Uniswap position until somebody realises them — so a
 * market that has traded all week reports zero, which reads as "you have earned nothing"
 * rather than "nothing has been swept yet". Showing that figure under the word "fees" is
 * how you tell a creator their market made no money.
 *
 * The honest figure is what a claim would pay if it were made now, and it is obtained by
 * asking the chain to try: `eth_simulateV1` runs `collect()` and then reads `claimable`
 * against the state that collection produced, without either transaction existing. Both
 * are free and neither is signed.
 *
 * A node that does not implement `eth_simulateV1` falls back to what is already in the
 * splitter. That understates the total, which is the safe direction — a button that
 * promises less than it pays is better than one that promises more.
 */
export interface ClaimOutlook {
  /** Already in the splitter. Claimable with one transaction. */
  readonly waiting: Claimable;
  /** Everything a claim would pay, including fees still sitting in the position. */
  readonly total: Claimable;
  /** Whether reaching `total` requires calling `collect()` first. */
  readonly needsCollect: boolean;
}

export async function readClaimOutlook(
  client: PublicClient,
  {
    locker,
    splitter,
    recipient,
  }: {
    readonly locker: Address;
    readonly splitter: Address;
    readonly recipient: Address;
  },
): Promise<ClaimOutlook> {
  const waiting = await readClaimable(client, { splitter, recipient });

  let total = waiting;
  try {
    const { results } = await client.simulateCalls({
      // From the recipient, because `claimable` is asked about them — though neither call
      // moves anything, so this costs nothing and needs no balance.
      account: recipient,
      calls: [
        { to: locker, abi: positionLockerAbi, functionName: "collect" },
        { to: splitter, abi: feeSplitterAbi, functionName: "claimable", args: [recipient] },
      ],
    });

    const answer = results[1];
    if (answer?.status === "success" && Array.isArray(answer.result)) {
      const [quote, token] = answer.result as readonly [bigint, bigint];
      total = { quote, token };
    }
  } catch {
    // No `eth_simulateV1` on this node, or the simulation was refused. `waiting` stands.
  }

  return {
    waiting,
    total,
    needsCollect: total.quote > waiting.quote || total.token > waiting.token,
  };
}

/**
 * Who this market's creator share belongs to.
 *
 * **Not** the address that launched the market. The factory passes `params.feeRecipient`
 * into the splitter, and a creator may name a treasury, a multisig or a partner instead of
 * themselves — so the registry's `creator`, which is whoever sent the launch transaction,
 * is the wrong address to authorise a claim against. The splitter is the authority on who
 * it pays, and it is the only one, because `claim` has no argument for whom to pay.
 */
export async function readFeeRecipient(
  client: PublicClient,
  { splitter }: { readonly splitter: Address },
): Promise<Address> {
  return client.readContract({
    address: splitter,
    abi: feeSplitterAbi,
    functionName: "creator",
  });
}

/**
 * Realise the position's fees and send them to the splitter.
 *
 * Callable by anyone — a creator, a holder, a bot — because there is nothing to protect:
 * the destination is fixed at deployment and the caller gains nothing by paying for it.
 * Collecting a market with no fees accrued is harmless and not an error, so this needs no
 * check before it is sent.
 */
export function buildCollect({ locker }: { readonly locker: Address }): UnsignedCall {
  return {
    to: locker,
    data: encodeFunctionData({ abi: positionLockerAbi, functionName: "collect" }),
    value: 0n,
  };
}

/**
 * Take everything the splitter owes the sender, in both currencies.
 *
 * There is no recipient argument, deliberately: the contract pays `msg.sender` and refuses
 * anybody who is neither the fee recipient nor the treasury, so this transaction cannot be
 * aimed at somebody else's share. It **reverts** with `NothingToClaim` when both sides are
 * zero, which is why a caller should read `readClaimable` first rather than offering a
 * button that spends gas to fail.
 */
export function buildClaim({ splitter }: { readonly splitter: Address }): UnsignedCall {
  return {
    to: splitter,
    data: encodeFunctionData({ abi: feeSplitterAbi, functionName: "claim" }),
    value: 0n,
  };
}

/**
 * The creator's share of a fee, in the same hundredths of a basis point the fee is in.
 *
 * A creator who sets a 3% fee does not receive 3%. The whole fee reaches the position, and
 * the splitter then takes the protocol's share off the top — so at the default split of
 * 90/10 a 3% fee earns the creator 2.7% of the volume that paid it, and the treasury 0.3%.
 * The launch form states this before a market is created; this is the same arithmetic, for
 * the surfaces that state it afterwards.
 */
export function creatorShareOfFee(feePpm: number, creatorBps: number): number {
  return Math.round((feePpm * creatorBps) / 10_000);
}
