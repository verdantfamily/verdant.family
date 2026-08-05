/**
 * Which wallets a reader is offered, and in what order.
 *
 * Pure, and out here rather than inside the popover, because the rule has been wrong
 * twice in ways that are invisible until somebody is standing in front of the failure.
 * The first version offered a connector that could not possibly work — an entry called
 * "Injected" on a phone, where nothing is on `window.ethereum` and nothing ever will be.
 * The second suppressed the real one, by sorting WalletConnect in with the announced
 * extensions and then concluding an extension had been found.
 *
 * Both are one-line mistakes in a filter, both look fine in review, and neither shows up
 * on the machine of whoever wrote it — which is a description of something that should
 * be a tested function rather than a comment.
 */

/** Only the field the sorting depends on, so the tests need no wagmi. */
export interface Offerable {
  readonly id: string;
}

/**
 * Wallets that can only ever reach a list of chains somebody else maintains.
 *
 * Most wallets implement EIP-3085 and will add whatever chain a page asks for, which is
 * why Verdant works in them without being on anybody's list. A few do not: they ship a
 * fixed roster and refuse everything outside it, with no way for a user to add one.
 *
 * On such a wallet Verdant is not degraded, it is impossible — every signature fails, and
 * the wallet reports it in its own words. Phantom's are "There was an error attempting to
 * sign the transaction", which names neither the chain nor the reason, so somebody hits
 * the identical failure launching and trading and has nothing to go on. Offering the
 * wallet as an ordinary choice is what makes that happen, so it is named here instead.
 *
 * Keyed by EIP-6963 `rdns`, which is what wagmi uses as a connector id for an announced
 * wallet. The rosters are the wallet's own published list and will go stale; a wallet that
 * adds a chain is a line to change here, and the cost of being wrong is a caution shown to
 * somebody it no longer applies to rather than a route closed off — nothing below prevents
 * a connection.
 */
const FIXED_ROSTER: Record<string, { readonly name: string; readonly chains: readonly number[] }> =
  {
    // docs.phantom.com/sdks/browser-sdk, "Supported EVM Networks", read 2026-08-05.
    "app.phantom": {
      name: "Phantom",
      chains: [1, 11_155_111, 137, 80_002, 8_453, 84_532, 42_161, 421_614, 143, 10_143],
    },
  };

/**
 * The wallet's name when it cannot reach this chain, and `null` when it can or when
 * nothing is known about it.
 *
 * Unknown means reachable, deliberately. The overwhelming majority of wallets will add a
 * chain on request, and warning about every one this file has not heard of would be a
 * false alarm on almost all of them.
 */
export function cannotReach(connectorId: string, chainId: number): string | null {
  const roster = FIXED_ROSTER[connectorId];
  if (roster === undefined) return null;
  return roster.chains.includes(chainId) ? null : roster.name;
}

export interface WalletChoices<T extends Offerable> {
  /**
   * Wallets on this machine: those that announced themselves over EIP-6963, or the
   * generic injected connector when nothing announced but something is on
   * `window.ethereum` anyway.
   */
  readonly installed: readonly T[];
  /**
   * The ways to reach a wallet that is somewhere else — WalletConnect, which deep-links
   * to a phone or shows a QR code. Always offered when configured, because its whole
   * purpose is the case where nothing is installed here.
   */
  readonly bridges: readonly T[];
}

/**
 * Split the connectors wagmi knows about into what to show and in what order.
 *
 * `injectedIsReal` is the caller's answer to "is anything actually on `window.ethereum`",
 * which cannot be read here: this runs during a server render too, where there is no
 * window to ask.
 *
 * Announced wallets win over the generic connector rather than joining it. A wallet that
 * both announces itself and occupies `window.ethereum` — which most extensions do — would
 * otherwise be listed twice under two different names, and nothing on screen would tell a
 * reader the two entries are the same program.
 */
export function walletChoices<T extends Offerable>(
  connectors: readonly T[],
  injectedIsReal: boolean,
): WalletChoices<T> {
  const bridges = connectors.filter((entry) => entry.id === "walletConnect");
  const announced = connectors.filter(
    (entry) => entry.id !== "injected" && entry.id !== "walletConnect",
  );
  const generic = connectors.filter((entry) => entry.id === "injected");

  return {
    installed: announced.length > 0 ? announced : injectedIsReal ? generic : [],
    bridges,
  };
}
