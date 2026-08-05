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
