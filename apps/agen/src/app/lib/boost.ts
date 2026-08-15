/**
 * Agen Boost, as the interface needs to talk about it.
 *
 * ## What Boost is, in one paragraph
 *
 * An Instant market pays its creator fee to `InstantFeeVault.creator`, an address fixed at
 * launch and immutable afterwards. Boost is what happens when that address is a `BoostEscrow`
 * rather than a wallet: `claimCreator()` is permissionless, so anybody can push the market's
 * fees into the escrow, and the escrow decides — from a switch only the creator can throw —
 * whether they pass through to the creator or buy the token back and send it to the dead
 * address.
 *
 * ## Why some markets can never have it
 *
 * Because that address is immutable. A market launched naming a wallet pays that wallet
 * forever, and no contract can intercept an EOA's future receipts. So Boost is available to
 * markets launched with an escrow and to no others, and every market that existed before Boost
 * was deployed is permanently ineligible. That is a property of the contracts rather than a
 * migration nobody has run, which is why {@link boostCapabilityOf} answers by reading the vault
 * instead of by consulting a list.
 *
 * The interface must not offer a switch it cannot throw. A market that is not capable shows no
 * Boost surface at all — not a disabled one.
 *
 * ## The sentence that has to be exactly right
 *
 * `BOOST_PROMISE` is the claim the product makes, and it is deliberately about the creator's
 * fee alone. Agen's 0.50% is a separate, voluntary contribution that cannot be enforced by
 * code on the deployed Instant stack, so it is never folded into this sentence. See
 * {@link agenContributionNote}.
 */

import { formatEther, type Address, type PublicClient } from "viem";

import { instant as instantSdk } from "@verdant/sdk";

import { BOOST_ADDRESSES } from "./chain";
import { INSTANT_FEE_PERCENTS } from "./instant";

/** Re-exported through the namespace, since the SDK publishes one entry point. */
export type BoostState = instantSdk.BoostState;

/** Whether this build has Boost at all. */
export const BOOST_AVAILABLE = BOOST_ADDRESSES !== null;

/**
 * What Boost does, and the whole of what is promised.
 *
 * Deliberately about trading fees rather than about creator fees. When a market's Instant
 * deployment routes both shares, Boost spends the entire 1.50% a trader pays — the creator's 1.00%
 * and Agen's 0.50% — so describing it as "your creator fees" would now understate it and hide the
 * fact that Agen is giving up its platform revenue too.
 *
 * For a market whose deployment cannot route the platform share, {@link boostTotalLine} says 1.00%
 * instead. The promise sentence is deliberately not specific about the number so that one string
 * cannot be wrong for one kind of market; the number is always stated separately, from state.
 */
export const BOOST_PROMISE =
  "Trading fees from this market are automatically used to buy the token back and send it " +
  "permanently to the burn address.";

/**
 * The headline, and the one place a percentage appears in prose.
 *
 * Built from state rather than written out, because the honest number differs: 1.50% where both
 * fee streams are captured and 1.00% where only the creator's is. A hardcoded "1.50%" would be a
 * false claim on the second kind, and that is the one mistake this feature cannot make.
 */
export function boostTotalLine(state: BoostState): string {
  const { total } = instantSdk.boostContributions(state);
  return `All ${total.toFixed(2)}% of trading fees are automatically recycled into the token.`;
}

/** The commitment, stated as the absolute it is. Shown wherever Boost is on or being turned on. */
export function boostCommitment(state: BoostState): string {
  const { creator, platform, total } = instantSdk.boostContributions(state);

  return platform === 0
    ? `100% of your ${creator.toFixed(2)}% creator fee is used for automatic buybacks while ` +
        `Boost is active.`
    : `100% of the ${total.toFixed(2)}% trading fee is used for automatic buybacks while Boost ` +
        `is active — your ${creator.toFixed(2)}% and Agen's ${platform.toFixed(2)}%.`;
}

/**
 * The three-line breakdown, because Agen giving up its own revenue should be visible.
 *
 * Returned as data rather than as a sentence so the card can set it as a small table. The platform
 * row is omitted rather than shown as zero for a market that cannot route it: a "0.00%" line reads
 * as Agen declining to contribute rather than as the deployment being unable to.
 */
export function boostBreakdown(
  state: BoostState,
): readonly { readonly label: string; readonly percent: string }[] {
  const { creator, platform, total } = instantSdk.boostContributions(state);

  return [
    { label: "Creator contribution", percent: `${creator.toFixed(2)}%` },
    ...(platform === 0 ? [] : [{ label: "Agen contribution", percent: `${platform.toFixed(2)}%` }]),
    { label: "Total Boost", percent: `${total.toFixed(2)}%` },
  ];
}

/**
 * Why the dead address is not a burn, said plainly.
 *
 * Instant tokens are `VerdantToken`, which has no `burn` function — so `totalSupply()` never
 * decreases and a token sent to `0x…dEaD` is out of circulation without being destroyed. The
 * interface says so rather than implying a supply reduction the chain does not report.
 */
export const BOOST_SINK_NOTE =
  "Instant tokens have no burn function, so these tokens are sent to a dead address nobody " +
  "holds the key to. Total supply does not change; circulating supply does.";

/**
 * How Agen's own 0.50% relates to this market's Boost, said accurately for both kinds.
 *
 * Three cases, and the distinction between the second and third is the one that matters: routed
 * means the fee architecture sends it and Agen cannot stop it, contributed means Agen chose to send
 * ether from outside the fee split. Presenting the second as the first would be the overclaim; the
 * reverse would undersell a real guarantee.
 */
export function agenContributionNote(state: BoostState): string {
  const platform = INSTANT_FEE_PERCENTS.platform.toFixed(2);

  if (!state.platformBoosted) {
    return `Agen's ${platform}% platform fee is not part of Boost on this market.`;
  }

  const routed =
    `Agen's ${platform}% platform fee goes into this market's buybacks too, for as long as ` +
    `Boost is on` +
    (state.platformRouted === 0n ? "." : `: ${formatEther(state.platformRouted)} ETH so far.`);

  return state.agenContributed === 0n
    ? routed
    : `${routed} Agen has also contributed ${formatEther(state.agenContributed)} ETH from outside ` +
        `the fee split.`;
}

/**
 * Whether a market can be Boosted, and by which escrow.
 *
 * Reads the vault, which is the authority: its `creator` is the address that will be paid,
 * immutably. Capability is exactly "that address is a genuine escrow belonging to this
 * creator", and genuineness is a CREATE2 derivation rather than a list — so a creator cannot
 * pass off a contract of their own writing as an escrow and collect Agen's contributions into
 * it.
 *
 * Returns `null` for a build without Boost, which reads as "no Boost surface" rather than as
 * "not capable": the two are different and only the second is about this market.
 */
export async function boostCapabilityOf(
  client: PublicClient,
  { vault, creator }: { readonly vault: Address; readonly creator: Address },
): Promise<{ readonly escrow: Address; readonly paysTo: Address } | null> {
  if (BOOST_ADDRESSES === null) return null;

  try {
    const answer = await instantSdk.readBoostCapability(client, {
      escrowFactory: BOOST_ADDRESSES.escrowFactory,
      vault,
      owner: creator,
    });

    return answer.escrow === null ? null : { escrow: answer.escrow, paysTo: answer.paysTo };
  } catch {
    // A chain that did not answer is not a market that cannot be Boosted, but for rendering
    // purposes the two are the same: show nothing rather than a switch that may not work.
    return null;
  }
}

/** Everything about one market's Boost, or null where there is nothing to show. */
export async function boostStateOf(
  client: PublicClient,
  { escrow, token }: { readonly escrow: Address; readonly token: Address },
): Promise<instantSdk.BoostState | null> {
  try {
    return await instantSdk.readBoostState(client, { escrow, token });
  } catch {
    return null;
  }
}

/**
 * The supply actually in circulation, given what Boost has sunk.
 *
 * `totalSupply()` is unchanged by a transfer to the dead address, so a market cap computed
 * from it counts tokens nobody can ever sell. Subtracting the dead address's balance is the
 * only correction available and it is exact.
 *
 * Note this is the *reported* supply falling, not the token's own — which is why the interface
 * says "circulating" wherever this number is used and never "total".
 */
export function circulatingSupply({
  totalSupply,
  deadBalance,
}: {
  readonly totalSupply: bigint;
  readonly deadBalance: bigint;
}): bigint {
  return instantSdk.circulatingSupply({ totalSupply, deadBalance });
}

/**
 * What share of the supply Boost has taken out of circulation, as a percentage.
 *
 * Returns null rather than zero for a supply of zero, so a caller renders nothing instead of
 * "0.00% burned" for a market that has no supply to burn.
 */
export function sunkPercent({
  totalSupply,
  deadBalance,
}: {
  readonly totalSupply: bigint;
  readonly deadBalance: bigint;
}): number | null {
  if (totalSupply <= 0n) return null;

  const capped = deadBalance > totalSupply ? totalSupply : deadBalance;
  // Basis points in integer arithmetic first, so a 1e27 supply does not lose precision on its
  // way through a float.
  return Number((capped * 1_000_000n) / totalSupply) / 10_000;
}

/**
 * When the next cycle could run, as a phrase.
 *
 * "Ready now" rather than a past timestamp once the interval has elapsed, because a keeper runs
 * on its own schedule and a time that has already passed reads as a missed appointment rather
 * than as an eligible market. Nothing here promises a cycle *will* run — only that nothing is
 * stopping one.
 */
/** What the next cycle will spend: both streams, wherever they currently sit. */
export function queuedForBoost(state: BoostState): bigint {
  return instantSdk.queuedForBoost(state);
}

export function nextBoostLabel(
  state: instantSdk.BoostState,
  now: number = Math.floor(Date.now() / 1000),
): string {
  if (!state.enabled && state.pending === 0n) return "—";
  if (state.nextBoostAt === 0 || now >= state.nextBoostAt) {
    return state.ready ? "Ready now" : "When fees clear the minimum";
  }

  const seconds = state.nextBoostAt - now;
  if (seconds < 60) return "In under a minute";

  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "In about a minute" : `In about ${String(minutes)} minutes`;
}

/** The last cycle, as a phrase. "Never" is a real answer for a market that just turned Boost on. */
export function lastBoostLabel(
  state: instantSdk.BoostState,
  now: number = Math.floor(Date.now() / 1000),
): string {
  if (state.lastBoostAt === 0) return "Not yet";

  const seconds = Math.max(0, now - state.lastBoostAt);
  if (seconds < 90) return "Just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;

  return `${String(Math.round(hours / 24))}d ago`;
}

/**
 * The status line, which is the one place the three states are named.
 *
 * Locked is called out ahead of enabled because it is the stronger claim and the one a holder
 * cares about: a creator who can switch Boost off has made a decision, and one who cannot has
 * made a commitment.
 */
export function boostStatusLabel(state: instantSdk.BoostState): string {
  if (state.locked) return "Locked forever";
  if (state.enabled) return "Active";
  if (state.pending > 0n) return "Off — committed fees still buying back";
  return "Off";
}
