/**
 * What to say when somebody asks Agen to manage their money today.
 *
 * The decision engine in this folder is complete and tested, and so are the contracts that would hold the
 * money — `CapitalVault` and `CapitalMandate` in `packages/contracts/src/capital`. Neither is deployed.
 *
 * What is missing is anywhere for the capital to go. Robinhood Chain has no lending venue, and every Agen
 * pool refuses outside liquidity in its hook: `beforeAddLiquidity` reverts unless the initiator is the
 * factory. Two further details decide which venue is worth building for. An Instant pool overrides its LP
 * fee to zero on every swap, so outside liquidity there would carry full divergence exposure and earn
 * nothing — permitting it would be offering people a way to lose money. A Verdant pool charges a real
 * scheduled fee, so outside liquidity there would genuinely earn. The venue path therefore runs through
 * Verdant markets and a hook that admits outside liquidity, not through Instant.
 *
 * So this module exists to make the honest answer easy to give and hard to avoid. A feature that accepted
 * deposits into a hot wallet and reported a balance would look finished and would be custody with extra
 * steps; a feature that quietly did nothing would be worse. Asked to put money to work, Agen says what
 * the situation is.
 *
 * When a venue and a vault exist, {@link capitalAvailability} starts returning `available` and the reply
 * text below stops being reachable. That is the only change this file should need.
 */

import type { CapitalCommand } from "./objective";

export type Availability =
  | { readonly state: "available" }
  | { readonly state: "unavailable"; readonly reason: string };

/**
 * Whether capital management can actually accept money.
 *
 * Both conditions are required and neither is currently met. They are parameters rather than constants so
 * a test can describe a deployment where they are met, and so turning this on is a configuration change
 * with one obvious place to make it rather than an edit to a hardcoded `false`.
 */
export function capitalAvailability({
  vaultDeployed = false,
  venueCount = 0,
}: {
  /** A vault that can hold a deposit under a mandate the holder can revoke. */
  readonly vaultDeployed?: boolean;
  /** Eligible venues, excluding cash. Cash alone is not somewhere to put money to work. */
  readonly venueCount?: number;
} = {}): Availability {
  if (!vaultDeployed) {
    return {
      state: "unavailable",
      reason: "there is no vault deployed that could hold your money under rules you control",
    };
  }

  if (venueCount === 0) {
    return {
      state: "unavailable",
      reason: "there is nowhere on this chain to earn a yield yet",
    };
  }

  return { state: "available" };
}

/**
 * The reply to a capital command while the feature cannot accept deposits.
 *
 * Written in Agen's voice — lower case, first person, no hedging — because it goes straight out as a reply
 * and a paragraph of apology would be worse than the refusal. It says what is missing and what would
 * change it, and it never implies that a deposit would be held safely in the meantime.
 */
export function unavailableReply(command: CapitalCommand, reason: string): string {
  switch (command) {
    case "manage":
    case "policy":
      return (
        `i can't yet — ${reason}. this chain has no lending market and every agen pool refuses outside ` +
        `liquidity at the contract level, so there is genuinely nothing to put it in. i'd rather tell you ` +
        `that than take a deposit and sit on it.`
      );
    case "status":
    case "earnings":
      return `nothing to report — i'm not managing any money yet. ${reason}.`;
    case "pause":
      return "nothing to pause, i'm not managing anything for you.";
    case "withdraw":
      return "there's nothing of yours to send back — i never took a deposit.";
  }
}
