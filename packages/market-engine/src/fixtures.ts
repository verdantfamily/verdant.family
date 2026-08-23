/**
 * Fixtures for the engine's own tests, and for anything downstream that needs a market.
 *
 * A real binding rather than a convenient one: 1e9 tokens at 18 decimals is what
 * `tokenSource()` in the compiler actually deploys, and ether at 18 decimals is what most
 * Agen markets are quoted in. Testing against a round 100-token supply hides every
 * precision question that matters.
 */

import type { AgenMarketSpec, MarketBinding, QuoteAssetBinding } from "./spec.js";

/** Ether, as Agen's pools carry it. */
export const ETHER_QUOTE: QuoteAssetBinding = {
  address: "0x0000000000000000000000000000000000000000",
  symbol: "ETH",
  decimals: 18,
};

/** A first-party equity token, to exercise a non-ether quote. */
export const EQUITY_QUOTE: QuoteAssetBinding = {
  address: "0x1111111111111111111111111111111111111111",
  symbol: "NVDA",
  decimals: 18,
};

/** One billion tokens at eighteen decimals — what an Agen launch mints. */
export const REFERENCE_SUPPLY = 1_000_000_000n * 10n ** 18n;

export const BINDING: MarketBinding = {
  referenceSupply: REFERENCE_SUPPLY,
  quoteAsset: ETHER_QUOTE,
  launchedTokenSymbol: "CNPY",
};

/** One percent of the reference supply, in token base units. */
export const ONE_PERCENT_OF_SUPPLY = REFERENCE_SUPPLY / 100n;

/** The smallest specification that compiles: one rate, one recipient. */
export function flat(percent: string): AgenMarketSpec {
  return {
    engineVersion: 1,
    baseRate: { buy: percent, sell: percent },
    ladder: null,
    sizeTiers: [],
    distribution: [{ recipient: { kind: "CREATOR" }, share: "100" }],
    protections: [],
  };
}

/**
 * The Exact Flow shape, minus the parts engine v1 does not have.
 *
 * The prompt that started the refactor asked for 0.5% both ways, 4% on sells at or above
 * 1% of supply, and an 80/20 split. It also asked for a consecutive-buy streak, which is
 * a wallet-independent counter but still state the engine does not keep in v1 — so this
 * fixture is the supported subset, and the streak is a documented `UNSUPPORTED`.
 */
export function exactFlow(): AgenMarketSpec {
  return {
    engineVersion: 1,
    baseRate: { buy: "0.5", sell: "0.5" },
    ladder: null,
    sizeTiers: [
      {
        side: "SELL",
        measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" },
        rate: "4",
      },
    ],
    distribution: [
      { recipient: { kind: "CREATOR" }, share: "80" },
      { recipient: { kind: "TREASURY" }, share: "20" },
    ],
    protections: [],
  };
}
