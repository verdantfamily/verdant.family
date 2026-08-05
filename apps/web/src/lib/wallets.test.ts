/**
 * The wallet list, which has been wrong twice.
 *
 * Neither mistake was visible to whoever made it: one only appears on a device with no
 * extension, the other only on a device that has one. So the cases below are written
 * from the devices rather than from the code — a phone, a laptop with two wallets, a
 * laptop with an old wallet that does not announce itself, and a build with no
 * WalletConnect project id at all.
 */

import { describe, expect, it } from "vitest";

import { cannotReach, walletChoices } from "./wallets";

const ROBINHOOD = 4_663;

const INJECTED = { id: "injected" };
const WALLET_CONNECT = { id: "walletConnect" };
const METAMASK = { id: "io.metamask" };
const PHANTOM = { id: "app.phantom" };

describe("choosing which wallets to offer", () => {
  /*
   * The failure that started this. A mobile wallet is a separate application, so nothing
   * announces and nothing is injected — and the list was one entry named "Injected" that
   * raised a provider-not-found when tapped.
   */
  it("offers no local wallet on a phone, where none can exist", () => {
    const { installed } = walletChoices([INJECTED, WALLET_CONNECT], false);
    expect(installed).toEqual([]);
  });

  /*
   * And the failure introduced by fixing it. WalletConnect is not an extension, so
   * counting it as one concluded that a wallet had been found and suppressed the
   * generic fallback on every browser holding a non-announcing wallet.
   */
  it("still offers WalletConnect when there is nothing installed", () => {
    const { bridges } = walletChoices([INJECTED, WALLET_CONNECT], false);
    expect(bridges).toEqual([WALLET_CONNECT]);
  });

  it("offers WalletConnect alongside extensions rather than instead of them", () => {
    const { installed, bridges } = walletChoices(
      [INJECTED, WALLET_CONNECT, PHANTOM, METAMASK],
      true,
    );

    expect(installed).toEqual([PHANTOM, METAMASK]);
    expect(bridges).toEqual([WALLET_CONNECT]);
  });

  /*
   * Most extensions do both, and listing an extension twice under two names gives a
   * reader no way to tell that the two rows are one program.
   */
  it("drops the generic connector when a wallet announced itself", () => {
    const { installed } = walletChoices([INJECTED, METAMASK], true);
    expect(installed).toEqual([METAMASK]);
  });

  it("keeps the generic connector for a wallet that does not announce", () => {
    const { installed } = walletChoices([INJECTED, WALLET_CONNECT], true);
    expect(installed).toEqual([INJECTED]);
  });

  /** A clone with no project id configured: the connector is never created. */
  it("has no bridge when WalletConnect is not configured", () => {
    const { installed, bridges } = walletChoices([INJECTED, METAMASK], true);
    expect(bridges).toEqual([]);
    expect(installed).toEqual([METAMASK]);
  });

  it("preserves the order wagmi announced wallets in", () => {
    const { installed } = walletChoices([INJECTED, PHANTOM, METAMASK], true);
    expect(installed.map((entry) => entry.id)).toEqual(["app.phantom", "io.metamask"]);
  });
});

/*
 * The failure this describes cost an afternoon. Launching and trading both failed with
 * Phantom's own words — "There was an error attempting to sign the transaction" — while
 * every simulation of both, run against the real chain from outside the browser, said the
 * transactions were fine. They were: Phantom cannot reach chain 4663 and never could.
 */
describe("wallets that cannot reach the chain Verdant is on", () => {
  it("names Phantom on Robinhood Chain, which is not on its roster", () => {
    expect(cannotReach("app.phantom", ROBINHOOD)).toBe("Phantom");
  });

  it("says nothing about Phantom on a chain it does support", () => {
    expect(cannotReach("app.phantom", 1)).toBe(null);
    expect(cannotReach("app.phantom", 8_453)).toBe(null);
  });

  /*
   * Unknown means reachable. Almost every wallet will add a chain on request, so warning
   * about each one this file has not heard of would be a false alarm on nearly all of
   * them — and a false alarm on the wallet that does work is worse than no alarm at all.
   */
  it("says nothing about a wallet it has never heard of", () => {
    expect(cannotReach("io.metamask", ROBINHOOD)).toBe(null);
    expect(cannotReach("walletConnect", ROBINHOOD)).toBe(null);
    expect(cannotReach("injected", ROBINHOOD)).toBe(null);
    expect(cannotReach("xyz.unknown.wallet", ROBINHOOD)).toBe(null);
  });
});
