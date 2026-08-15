/**
 * Agen Boost: reading a market's Boost state, and the calls that change it.
 *
 * ## What Boost is, mechanically
 *
 * Boost captures **both** of an Instant market's fee streams, by two different routes, because the
 * two destinations are set in two different ways.
 *
 * The creator's 1.00% is paid to `InstantFeeVault.creator`, which the factory sets from
 * `params.feeRecipient` at launch. That is a per-launch argument, so a creator can name a
 * `BoostEscrow`, and `claimCreator()` — permissionless, taking no argument — delivers their fees
 * into it forever.
 *
 * The platform's 0.50% is paid to `InstantFeeVault.treasury`, which comes from
 * `InstantFactory.treasury`. That is an immutable of the *factory* rather than a per-launch
 * argument, so there is exactly one way to route it: be that address. `BoostTreasury` is that
 * address, and an Instant deployment whose `TREASURY` is it has every one of its markets' platform
 * fees delivered there.
 *
 * With Boost on, both go into buybacks — the whole 1.50% the trader paid. The trader's fee does not
 * change and Boost is not an additional charge; only the destination of the two existing shares
 * moves.
 *
 * ## Which markets can be Boosted
 *
 * Only markets that named an escrow at launch. That is not a policy choice, it is the consequence
 * of `vault.creator` being immutable: a market that named a wallet pays that wallet forever, and no
 * contract can intercept an EOA's future receipts. Use {@link readBoostCapability} to ask — the
 * answer for every market launched before Boost existed is no.
 *
 * There is a second, coarser condition for the platform half: the market's Instant deployment must
 * pay its platform fee to a `BoostTreasury`. That is fixed per deployment rather than per market,
 * so `BoostState.platformBoosted` says which kind a market is — and an interface must read it
 * before claiming "all 1.50%", because for a market whose deployment pays an ordinary address Boost
 * is the creator's 1.00% and saying otherwise would be false.
 *
 * ## The cutoff
 *
 * A vault pays out everything accrued since the last claim as one lump, so neither contract can
 * tell which part of an arriving amount was earned before a toggle. Neither has to: `enableBoost`
 * and `disableBoost` claim **both streams** before they flip either flag, so the cutoff is the
 * toggle transaction itself.
 *
 * Enabling never takes fees earned while Boost was off — not the creator's and not Agen's.
 * Disabling never releases fees earned while it was on, again neither. That symmetry matters more
 * now than when only the creator's share was involved: if disabling handed Agen back the platform
 * fees accrued under Boost, "all 1.50% was recycled" would be false in retrospect for trades that
 * had already happened under it.
 *
 * Nothing here signs or sends. The reads take a client; the writes return calldata.
 */

import type { Address, PublicClient } from "viem";
import { encodeFunctionData } from "viem";

import { INSTANT_FEES } from "@verdant/config";

import { boostEscrowAbi, boostEscrowFactoryAbi, instantFeeVaultAbi } from "../abi/index.js";
import type { UnsignedCall } from "../launch/create.js";

/** Where bought-back tokens go. A constant of the escrow, not a setting. */
export const BOOST_DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD" as const;

/**
 * Everything one market's Boost is doing, as the escrow reports it.
 *
 * Every field is read from chain state or from an event the chain emitted. Nothing here is
 * inferred from an indexer or projected forward.
 */
export interface BoostState {
  /** The market's `InstantFeeVault`. */
  readonly vault: Address;
  /** Whether this escrow is this market's fee recipient. False means Boost is impossible. */
  readonly enrolled: boolean;
  readonly enabled: boolean;
  /** Permanently on. There is no counterpart to the function that sets this. */
  readonly locked: boolean;
  /** Wei committed to buybacks and already in the escrow. Not withdrawable by the creator. */
  readonly pending: bigint;
  /**
   * Whether this market's platform 0.50% is captured too.
   *
   * True means Boost is the full 1.50% of trading fees; false means it is the creator's 1.00%. A
   * property of the Instant deployment the market was created by, and fixed for its life. **Read
   * this before stating a total** — "100% of trading fees" is only true of the first.
   */
  readonly platformBoosted: boolean;
  /**
   * Agen's 0.50% waiting at the `BoostTreasury` for this market, committed and not yet spent.
   *
   * Part of what the next cycle will spend, so an interface showing what is queued adds this to
   * `pending`. Zero when `platformBoosted` is false.
   */
  readonly platformPending: bigint;
  /** Cumulative wei of Agen's 0.50% routed into this market's buybacks by the fee architecture. */
  readonly platformRouted: bigint;
  /**
   * Where this market's platform fee is paid, or the zero address.
   *
   * Read from the market's own vault at enrolment rather than configured, which is what lets one
   * escrow serve markets from different Instant deployments and get each one right. Zero means the
   * market's deployment pays an ordinary address and the platform share cannot be captured.
   */
  readonly boostTreasury: Address;
  /**
   * Wei this market owes the creator, waiting in the escrow.
   *
   * Fees the market earned while Boost was off. Per market rather than pooled, so a profile
   * listing a row per market has a figure per row instead of the same money on all of them.
   * No path in the escrow moves a wei between this and `pending`.
   */
  readonly creatorPending: bigint;
  /**
   * Wei still in the vault that a settle would move.
   *
   * With Boost on it becomes Boost money; with Boost off it becomes the creator's. This is
   * why a profile must not show it as claimable income while Boost is on.
   */
  readonly vaultClaimable: bigint;
  /** Cumulative wei contributed from outside the creator's fee stream — Agen's top-ups. */
  readonly agenContributed: bigint;
  /** Cumulative wei spent on buybacks. */
  readonly spent: bigint;
  /** Cumulative tokens the buybacks returned. */
  readonly bought: bigint;
  /** Cumulative tokens this escrow sent to the dead address. */
  readonly sunk: bigint;
  /**
   * The dead address's actual balance of this token.
   *
   * Read from the token rather than from `sunk`, because tokens reach that address by routes
   * the escrow knows nothing about. This is the number a circulating supply must subtract —
   * `totalSupply()` does **not** decrease, because Instant tokens have no burn function.
   */
  readonly deadBalance: bigint;
  /** Unix seconds, or zero if no cycle has ever run. */
  readonly lastBoostAt: number;
  /** The earliest a next cycle could run. Not a promise that one will. */
  readonly nextBoostAt: number;
  readonly boostCount: number;
  /** Whether a cycle would succeed right now: enough committed, and the interval elapsed. */
  readonly ready: boolean;
}

/** The escrow's own bounds, so an interface states the contract's numbers and not its own. */
export interface BoostLimits {
  /** The least wei worth a buyback's gas. */
  readonly minBoostWei: bigint;
  /** Seconds between cycles for one market. */
  readonly intervalSeconds: number;
  /** How far below spot a buyback may settle, in basis points. */
  readonly maxSlippageBps: number;
}

export async function readBoostState(
  client: PublicClient,
  { escrow, token }: { readonly escrow: Address; readonly token: Address },
): Promise<BoostState> {
  const state = await client.readContract({
    address: escrow,
    abi: boostEscrowAbi,
    functionName: "boostStateOf",
    args: [token],
  });

  return {
    vault: state.vault,
    enrolled: state.enrolled,
    enabled: state.enabled,
    locked: state.locked,
    pending: state.pending,
    creatorPending: state.creatorPending,
    platformBoosted: state.platformBoosted,
    platformPending: state.platformPending,
    platformRouted: state.platformRouted,
    boostTreasury: state.boostTreasury,
    vaultClaimable: state.vaultClaimable,
    agenContributed: state.agenContributed,
    spent: state.spent,
    bought: state.bought,
    sunk: state.sunk,
    deadBalance: state.deadBalance,
    lastBoostAt: Number(state.lastBoostAt),
    nextBoostAt: Number(state.nextBoostAt),
    boostCount: Number(state.boostCount),
    ready: state.ready,
  };
}

export async function readBoostLimits(
  client: PublicClient,
  { escrow }: { readonly escrow: Address },
): Promise<BoostLimits> {
  const [minBoostWei, interval, slippage] = await Promise.all([
    client.readContract({ address: escrow, abi: boostEscrowAbi, functionName: "MIN_BOOST_WEI" }),
    client.readContract({ address: escrow, abi: boostEscrowAbi, functionName: "BOOST_INTERVAL" }),
    client.readContract({ address: escrow, abi: boostEscrowAbi, functionName: "MAX_SLIPPAGE_BPS" }),
  ]);

  return {
    minBoostWei,
    intervalSeconds: Number(interval),
    maxSlippageBps: Number(slippage),
  };
}

/**
 * Whether this market can be Boosted at all, and by whom.
 *
 * The question is answered from the vault, which is the authority: its `creator` is the
 * address that will be paid, immutably, and Boost is possible exactly when that address is a
 * genuine escrow from the factory. `isGenuine` is a CREATE2 derivation rather than a list, so
 * a creator cannot pass off a contract of their own writing as an escrow.
 *
 * @param owner The address whose escrow to check for — the market's creator.
 */
export async function readBoostCapability(
  client: PublicClient,
  {
    escrowFactory,
    vault,
    owner,
  }: {
    readonly escrowFactory: Address;
    readonly vault: Address;
    readonly owner: Address;
  },
): Promise<{ readonly capable: boolean; readonly escrow: Address | null; readonly paysTo: Address }> {
  const paysTo = await client.readContract({
    address: vault,
    abi: instantFeeVaultAbi,
    functionName: "creator",
  });

  const genuine = await client.readContract({
    address: escrowFactory,
    abi: boostEscrowFactoryAbi,
    functionName: "isGenuine",
    args: [owner, paysTo],
  });

  return { capable: genuine, escrow: genuine ? paysTo : null, paysTo };
}

/** Where this owner's escrow is, deployed or not. A pure function of the address. */
export async function readEscrowAddress(
  client: PublicClient,
  { escrowFactory, owner }: { readonly escrowFactory: Address; readonly owner: Address },
): Promise<{ readonly escrow: Address; readonly deployed: boolean }> {
  const [escrow, deployed] = await Promise.all([
    client.readContract({
      address: escrowFactory,
      abi: boostEscrowFactoryAbi,
      functionName: "escrowOf",
      args: [owner],
    }),
    client.readContract({
      address: escrowFactory,
      abi: boostEscrowFactoryAbi,
      functionName: "isDeployed",
      args: [owner],
    }),
  ]);

  return { escrow, deployed };
}

/**
 * The least output the escrow will accept for spending this much on this token, right now.
 *
 * Derived from the pool's own `sqrtPriceX96`, net of the 1.50% the hook takes on the way in.
 * A keeper should quote at least this; `boost` refuses anything looser, which is what makes it
 * safe to leave permissionless.
 */
export async function readBoostSlippageFloor(
  client: PublicClient,
  {
    escrow,
    token,
    amountIn,
  }: {
    readonly escrow: Address;
    readonly token: Address;
    readonly amountIn: bigint;
  },
): Promise<bigint> {
  return client.readContract({
    address: escrow,
    abi: boostEscrowAbi,
    functionName: "slippageFloor",
    args: [token, amountIn],
  });
}

/** Every market enrolled in an escrow, in enrolment order. What a keeper iterates. */
export async function readEnrolledTokens(
  client: PublicClient,
  { escrow }: { readonly escrow: Address },
): Promise<readonly Address[]> {
  return client.readContract({
    address: escrow,
    abi: boostEscrowAbi,
    functionName: "enrolledTokens",
  });
}

// --- the calls ---------------------------------------------------------------

/**
 * Deploy this creator's escrow, or return the existing one.
 *
 * Idempotent on chain, so a launch flow may send it without first checking. Must happen
 * *before* the launch it is for, because the launch has to name the address and the vault
 * makes it immutable.
 */
export function buildDeployEscrow({
  escrowFactory,
  owner,
}: {
  readonly escrowFactory: Address;
  readonly owner: Address;
}): UnsignedCall {
  return {
    to: escrowFactory,
    data: encodeFunctionData({
      abi: boostEscrowFactoryAbi,
      functionName: "deploy",
      args: [owner],
    }),
    value: 0n,
  };
}

/**
 * Attach a launched market to the escrow that receives its fees.
 *
 * Permissionless, and everything is derived: the registry says which vault the token has and
 * the vault says who it pays, so a market whose fees go elsewhere cannot be attached. Needed
 * once per market, after the launch, and harmless to repeat.
 */
export function buildEnrollMarket({
  escrow,
  token,
}: {
  readonly escrow: Address;
  readonly token: Address;
}): UnsignedCall {
  return {
    to: escrow,
    data: encodeFunctionData({ abi: boostEscrowAbi, functionName: "enroll", args: [token] }),
    value: 0n,
  };
}

/**
 * Turn Boost on. Creator only.
 *
 * Settles first, so everything earned up to this transaction stays the creator's and is
 * withdrawable as usual. Everything after it buys the token back.
 */
export function buildEnableBoost({
  escrow,
  token,
}: {
  readonly escrow: Address;
  readonly token: Address;
}): UnsignedCall {
  return {
    to: escrow,
    data: encodeFunctionData({ abi: boostEscrowAbi, functionName: "enableBoost", args: [token] }),
    value: 0n,
  };
}

/**
 * Turn Boost off. Creator only, and refused once locked.
 *
 * Settles first, so everything earned while Boost was on is committed before the switch flips
 * and still gets spent on buybacks. A creator cannot watch a large trade land and then switch
 * off to pocket it.
 */
export function buildDisableBoost({
  escrow,
  token,
}: {
  readonly escrow: Address;
  readonly token: Address;
}): UnsignedCall {
  return {
    to: escrow,
    data: encodeFunctionData({ abi: boostEscrowAbi, functionName: "disableBoost", args: [token] }),
    value: 0n,
  };
}

/** Give up the ability to ever turn Boost off. One way, and there is no counterpart. */
export function buildLockBoostForever({
  escrow,
  token,
}: {
  readonly escrow: Address;
  readonly token: Address;
}): UnsignedCall {
  return {
    to: escrow,
    data: encodeFunctionData({
      abi: boostEscrowAbi,
      functionName: "lockBoostForever",
      args: [token],
    }),
    value: 0n,
  };
}

/**
 * Claim a market's fees out of its vault and pay out whatever of them is the creator's.
 *
 * What the profile's claim button sends for a Boost-capable market. With Boost off this is
 * one signature and the ether lands in the creator's wallet, which is what a claim was before
 * Boost existed. With Boost on it commits the fees and pays nothing, which is the point.
 */
export function buildBoostPull({
  escrow,
  token,
}: {
  readonly escrow: Address;
  readonly token: Address;
}): UnsignedCall {
  return {
    to: escrow,
    data: encodeFunctionData({ abi: boostEscrowAbi, functionName: "pull", args: [token] }),
    value: 0n,
  };
}

/**
 * Pay out only what this market already owes the creator, without claiming from the vault.
 *
 * `buildBoostPull` is almost always the right call — it does both. This exists for the case
 * where the vault has nothing outstanding but the escrow is still holding a balance, so a claim
 * would revert on the first half and never reach the second.
 */
export function buildBoostWithdraw({
  escrow,
  token,
}: {
  readonly escrow: Address;
  readonly token: Address;
}): UnsignedCall {
  return {
    to: escrow,
    data: encodeFunctionData({ abi: boostEscrowAbi, functionName: "withdraw", args: [token] }),
    value: 0n,
  };
}

/**
 * Run one buyback cycle: claim, buy, and send every token bought to the dead address.
 *
 * Permissionless. `minTokensOut` must be at least {@link readBoostSlippageFloor}, so a caller
 * cannot arrange a bad price, and the pool and the destination are both derived inside the
 * contract rather than taken as arguments.
 */
export function buildBoostExecute({
  escrow,
  token,
  minTokensOut,
}: {
  readonly escrow: Address;
  readonly token: Address;
  readonly minTokensOut: bigint;
}): UnsignedCall {
  return {
    to: escrow,
    data: encodeFunctionData({
      abi: boostEscrowAbi,
      functionName: "boost",
      args: [token, minTokensOut],
    }),
    value: 0n,
  };
}

/**
 * Contribute ether to a market's buybacks from outside its fee stream.
 *
 * A voluntary top-up from outside both fee streams, and **not** how Agen's 0.50% reaches Boost —
 * that is `BoostTreasury`, enforced by the fee architecture. This exists for a market whose Instant
 * deployment pays an ordinary address, where the platform share cannot be routed by code at all,
 * and for anybody who simply wants to fund a burn. Tracked in `agenContributed`, separately from
 * `platformRouted`, so an interface can never present a discretionary gift as the fee split.
 */
export function buildBoostContribute({
  escrow,
  token,
  amountWei,
}: {
  readonly escrow: Address;
  readonly token: Address;
  readonly amountWei: bigint;
}): UnsignedCall {
  return {
    to: escrow,
    data: encodeFunctionData({ abi: boostEscrowAbi, functionName: "contribute", args: [token] }),
    value: amountWei,
  };
}

/**
 * The circulating supply of a token whose Boost has sunk some of it.
 *
 * Instant tokens are `VerdantToken`, which has no `burn` — so `totalSupply()` stays at its
 * launch value forever and a market cap computed from it would ignore every token Boost has
 * taken out of circulation. Subtracting the dead address's balance is the correction, and it
 * is the only honest one available.
 */
/**
 * What the next cycle will spend: both streams, wherever they currently sit.
 *
 * The escrow's own commitment, the platform's commitment at the treasury, and — when Boost is on —
 * the creator's share still in the vault, which a settle will move. A figure that summed only the
 * first would understate a Boosted market's queue by a third.
 */
export function queuedForBoost(state: BoostState): bigint {
  return state.pending + state.platformPending + (state.enabled ? state.vaultClaimable : 0n);
}

/**
 * The two contributions and their total, as percentages of traded volume.
 *
 * Derived from `INSTANT_FEES` rather than written out, so a change to the split cannot leave this
 * disagreeing with what the chain charges. `platform` is zero for a market whose deployment does
 * not route the platform share, which is what keeps `total` honest for those.
 */
export function boostContributions(state: BoostState): {
  readonly creator: number;
  readonly platform: number;
  readonly total: number;
} {
  const creator = INSTANT_FEES.creatorPpm / 10_000;
  const platform = state.platformBoosted ? INSTANT_FEES.platformPpm / 10_000 : 0;
  return { creator, platform, total: creator + platform };
}

export function circulatingSupply({
  totalSupply,
  deadBalance,
}: {
  readonly totalSupply: bigint;
  readonly deadBalance: bigint;
}): bigint {
  const sunk = deadBalance > totalSupply ? totalSupply : deadBalance;
  return totalSupply - sunk;
}
