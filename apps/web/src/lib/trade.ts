/**
 * The arithmetic and the preconditions of a swap.
 *
 * Everything here is a pure function of numbers the panel already has, kept out of the
 * component for the usual reason: this is the part where being wrong costs money, and
 * a floor on what a trade may return should be checkable without rendering anything.
 *
 * The quote itself is not here. It comes from Uniswap's `V4Quoter`, which is the only
 * correct source for a Verdant pool — the pool's stored fee is written once at
 * initialisation and never updated, because the fee is a `beforeSwap` override, so
 * anything deriving a price from stored state would quote the opening stage forever.
 */

import { NATIVE_CURRENCY } from "@verdant/config";
import type { Address } from "viem";

export type Side = "buy" | "sell";

/**
 * Which currency a trade spends.
 *
 * A buy spends the quote asset and a sell spends the launch token, which in the pool's
 * own terms is `zeroForOne: true` and `false` respectively — the launch token is always
 * `currency1` (ADR-008), so the direction and the side are the same fact.
 */
export function inputAsset({
  side,
  token,
  quoteAsset,
}: {
  readonly side: Side;
  readonly token: Address;
  readonly quoteAsset: Address;
}): Address {
  return side === "buy" ? quoteAsset : token;
}

/** `zeroForOne`, in the pool's terms. */
export function zeroForOne(side: Side): boolean {
  return side === "buy";
}

/**
 * Whether the input is ether, which is the whole of what decides if approvals apply.
 *
 * v4 holds ether directly rather than wrapping it, so an ether input is paid by the
 * transaction's `value` and there is nothing to approve. Every other input is an ERC-20
 * the Universal Router has to pull through Permit2.
 */
export function isNativeInput(asset: Address): boolean {
  return asset.toLowerCase() === NATIVE_CURRENCY;
}

/**
 * The floor a swap is sent with.
 *
 * Two reductions, and they are different things. Slippage is the reader's tolerance for
 * the price moving between now and the block this lands in. The fee adjustment is not a
 * tolerance at all: inside the window around a stage transition the swap may execute
 * under either fee, and the quoter answered under one of them, so the floor is
 * recomputed as though the worse fee had applied. Without it a trade submitted seconds
 * before a fee rise would be quoted at the old rate and reverted by its own minimum.
 *
 * Both are applied to integers and truncate downwards, which is the safe direction: a
 * floor rounded up is a floor that fails.
 */
export function minimumReceived({
  amountOut,
  slippageBps,
  quotedFeePpm,
  worstFeePpm,
}: {
  readonly amountOut: bigint;
  readonly slippageBps: number;
  /** The fee in force when the quote was taken. */
  readonly quotedFeePpm: number;
  /** The worse of the fees this swap could execute under. Equal, away from a boundary. */
  readonly worstFeePpm: number;
}): bigint {
  if (amountOut <= 0n) return 0n;

  const quoted = BigInt(1_000_000 - quotedFeePpm);
  const worst = BigInt(1_000_000 - worstFeePpm);
  const afterFee = worst >= quoted ? amountOut : (amountOut * worst) / quoted;

  return (afterFee * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * Permit2's record of what the router may take, as this app needs to read it.
 *
 * A structural type rather than the SDK's `Permit2Allowance`, so that the rule below
 * can be tested without constructing one and so a caller may pass the extra fields
 * `readPermit2Allowance` returns.
 */
export interface Allowances {
  /** What the token's own `approve` has granted **Permit2**. */
  readonly erc20ToPermit2: bigint;
  /** What Permit2's `approve` has granted **the router**, and when it lapses. */
  readonly permit2ToRouter: { readonly amount: bigint; readonly expiration: number };
}

/** Which of the two approvals a swap still needs. */
export interface ApprovalsNeeded {
  /** `token.approve(PERMIT2, …)`. One standing approval per token. */
  readonly erc20: boolean;
  /** `permit2.approve(router, …)`. Carries an amount and an expiry. */
  readonly permit2: boolean;
}

export const NO_APPROVALS_NEEDED: ApprovalsNeeded = { erc20: false, permit2: false };

/**
 * What must be signed before this swap can settle.
 *
 * The Universal Router holds no allowances of its own; it pulls an ERC-20 input through
 * Permit2, so an ERC-20 input needs two approvals and they are not interchangeable. A
 * trader who does only the first gets a revert deep inside `SETTLE_ALL`, at the moment
 * the router tries to pull the input, which reads as a broken market rather than as a
 * missing approval.
 *
 * An expiry in the past is exactly as spent as an amount of zero, and the two are
 * indistinguishable from the amount alone — so both are checked. An expiry equal to the
 * chain time this was read at counts as lapsed, because the swap executes in a later
 * block than the one that answered.
 */
export function approvalsNeeded({
  input,
  amountIn,
  allowances,
  at,
}: {
  readonly input: Address;
  readonly amountIn: bigint;
  readonly allowances: Allowances | null;
  /** Chain time, in seconds. Not the reader's clock; see `../lib/feed.ts`. */
  readonly at: number;
}): ApprovalsNeeded {
  if (isNativeInput(input) || amountIn <= 0n) return NO_APPROVALS_NEEDED;

  // Nothing has been read yet. Reporting "none needed" would offer a swap that reverts;
  // reporting both needed is the safe direction, and the panel shows it as a step to
  // take rather than as a failure.
  if (allowances === null) return { erc20: true, permit2: true };

  return {
    erc20: allowances.erc20ToPermit2 < amountIn,
    permit2:
      allowances.permit2ToRouter.amount < amountIn ||
      allowances.permit2ToRouter.expiration <= at,
  };
}

export function anyApprovalNeeded(needed: ApprovalsNeeded): boolean {
  return needed.erc20 || needed.permit2;
}

/**
 * How long a Permit2 approval is granted for.
 *
 * Thirty days from the chain's clock, not the reader's. Permit2 reads an expiration of
 * zero as "this block only", so there is no safe default to omit, and the only clock
 * this app may use is the one the chain reported — on an Orbit chain the sequencer's
 * time is not the reader's (V6 in docs/verification.md).
 */
export const PERMIT2_APPROVAL_SECONDS = 30 * 24 * 60 * 60;

export function permit2Expiration(chainTime: number): number {
  return chainTime + PERMIT2_APPROVAL_SECONDS;
}
