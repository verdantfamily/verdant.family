import type { Market } from "./feed";

/**
 * Whether anybody may create a market yet.
 *
 * One constant rather than a feature-flag service, because this is a decision taken once
 * about a product that has not opened, not a dial anybody expects to turn per request.
 * Flipping it to `true` re-opens the forms, the header button and the model chooser
 * together — there is no second place to remember.
 *
 * What it deliberately does not do is disable anything on chain. `VerdantFactory` has no
 * pause and no owner switch, which is the whole proposition, so a market created directly
 * against the contracts today would still work and would still be indexed. This closes an
 * interface, and saying so plainly is more honest than implying the protocol is gated.
 */
export const LAUNCHING_OPEN = false;

/**
 * Markets kept out of the listing.
 *
 * These are the launches made while building the thing — TEST, TEST2, TESTVERDANT — and a
 * launchpad whose front page is three tokens called TEST is advertising that nobody has
 * used it. They are hidden rather than deleted, because they cannot be deleted: they are
 * pools on a public chain, their pages still resolve, and anybody holding one can still
 * trade it. This is an editorial decision about a listing, which is the only thing an
 * interface is entitled to make.
 *
 * A denylist rather than "hide everything until launch opens", so that the first real
 * market appears the moment it exists without anybody having to remember this file.
 *
 * Keyed by token address, lowercased on both sides at the comparison.
 */
const HIDDEN_TOKENS: ReadonlySet<string> = new Set([
  "0xc2ba182641643c8e1a892d5f548dbe5be477949e", // TEST
  "0x14db4a36025e93fd38c320d31a10c9749b46781f", // TEST2
  "0x8ab6550e488fc0b9216d549c255864c8f87a4765", // TESTVERDANT
]);

export function isHiddenMarket(token: string): boolean {
  return HIDDEN_TOKENS.has(token.toLowerCase());
}

/** The listing, without the markets that were only ever tests. */
export function listable(markets: readonly Market[]): readonly Market[] {
  return markets.filter((market) => !isHiddenMarket(market.token));
}
