/**
 * That a stored configuration comes back as the market it describes.
 *
 * `decodeConfig` is what makes the encoding worth persisting. An indexer keeps the bytes and a
 * market page, a verifier or an interface that never saw the launch recovers the exact
 * economics from them — no model, no prompt, no second implementation of what the rules mean.
 * That only holds if the round trip is exact, and "exact" here has a precise boundary: every
 * field inside the commitment survives, and the labels outside it do not, because they were
 * never encoded.
 *
 * The tests are arranged around what would go wrong if it were merely nearly exact. A dropped
 * tier is a market that stops charging more for large sells. A recipient decoded as the wrong
 * kind pays a stranger. A zero read as a limit rather than as its absence blocks every trade.
 */

import { describe, expect, it } from "vitest";

import { compile } from "./compile.js";
import { configHash, decodeConfig, encodeConfig, type ConfigLabels } from "./encode.js";
import { BINDING, EQUITY_QUOTE, exactFlow, flat } from "./fixtures.js";
import type { AgenMarketSpec, CanonicalConfig, MarketBinding } from "./spec.js";

const EQUITY: MarketBinding = { ...BINDING, quoteAsset: EQUITY_QUOTE };

/**
 * A laddered market, which no shared fixture provides.
 *
 * Here rather than in `fixtures.ts` because the axis is the one field with a code that decodes
 * to `null` — `NONE` is 0 and an absent ladder is not an axis — so a decoder that treated the
 * enum uniformly would give a flat market a ladder called "NONE". Nothing else in the suite
 * would notice.
 */
function laddered(): AgenMarketSpec {
  return {
    engineVersion: 1,
    baseRate: { buy: "2", sell: "2" },
    ladder: {
      axis: "TIME",
      stages: [{ afterSeconds: 86_400, rate: { buy: "1", sell: "1" } }],
    },
    sizeTiers: [],
    distribution: [{ recipient: { kind: "CREATOR" }, share: "100" }],
    protections: [],
  };
}

function configOf(spec: AgenMarketSpec, binding: MarketBinding): CanonicalConfig {
  const result = compile(spec, binding);
  if (result.config === null) {
    throw new Error(`the fixture did not compile: ${JSON.stringify(result.problems)}`);
  }

  return result.config;
}

function labelsOf(config: CanonicalConfig): ConfigLabels {
  return {
    launchedTokenSymbol: config.launchedTokenSymbol,
    quoteAssetSymbol: config.quoteAsset.symbol,
    quoteAssetDecimals: config.quoteAsset.decimals,
  };
}

/** The fixtures, spanning flat, tiered, laddered and a non-native quote asset. */
const MARKETS: readonly (readonly [string, AgenMarketSpec, MarketBinding])[] = [
  ["a flat market", flat("1"), BINDING],
  ["the Exact Flow market", exactFlow(), BINDING],
  ["a time-laddered market", laddered(), BINDING],
  ["a market quoted in an equity", flat("2.5"), EQUITY],
  ["a tiered market quoted in an equity", exactFlow(), EQUITY],
];

describe("decoding a stored configuration", () => {
  for (const [what, spec, binding] of MARKETS) {
    it(`returns ${what} unchanged`, () => {
      const config = configOf(spec, binding);
      const decoded = decodeConfig(encodeConfig(config), labelsOf(config));

      expect(decoded).toEqual(config);
    });

    /*
     * The property that actually matters to a verifier: the recovered configuration commits to
     * the same thing. Equality of the objects implies it, and this states it separately because
     * it is the claim a consumer relies on and the one that must not quietly weaken.
     */
    it(`recommits identically for ${what}`, () => {
      const config = configOf(spec, binding);
      const decoded = decodeConfig(encodeConfig(config), labelsOf(config));

      expect(configHash(decoded)).toBe(configHash(config));
      expect(encodeConfig(decoded)).toBe(encodeConfig(config));
    });
  }

  /*
   * Labels are outside the commitment by design — two markets differing only in what their
   * token is called are the same market to the engine — so they come from the caller. This
   * asserts the boundary is where it is claimed to be: change the labels and nothing about the
   * economics or the commitment moves.
   */
  it("takes the labels from the caller and the economics from the bytes", () => {
    const config = configOf(exactFlow(), BINDING);
    const encoded = encodeConfig(config);

    const relabelled = decodeConfig(encoded, {
      launchedTokenSymbol: "OTHER",
      quoteAssetSymbol: "WHATEVER",
      quoteAssetDecimals: 6,
    });

    expect(relabelled.launchedTokenSymbol).toBe("OTHER");
    expect(relabelled.quoteAsset.symbol).toBe("WHATEVER");
    expect(relabelled.quoteAsset.decimals).toBe(6);

    expect(configHash(relabelled)).toBe(configHash(config));
    expect(relabelled.sellTiers).toEqual(config.sellTiers);
    expect(relabelled.distribution).toEqual(config.distribution);
  });

  /*
   * Zero encodes "no limit". Read as a limit it would be a market that refuses every trade,
   * which is the most consequential possible misreading of a single field — and the reason
   * `compile.ts` refuses a maximum of zero, so the two readings can never both be reachable.
   */
  it("reads an absent trade limit as absent rather than as zero", () => {
    const config = configOf(flat("1"), BINDING);
    expect(config.maxBuyTokens).toBeNull();

    const decoded = decodeConfig(encodeConfig(config), labelsOf(config));

    expect(decoded.maxBuyTokens).toBeNull();
    expect(decoded.maxSellTokens).toBeNull();
  });

  it("keeps every tier, in order", () => {
    const config = configOf(exactFlow(), BINDING);
    const decoded = decodeConfig(encodeConfig(config), labelsOf(config));

    expect(decoded.sellTiers.length).toBe(config.sellTiers.length);
    expect(decoded.sellTiers.map((tier) => tier.thresholdTokens)).toEqual(
      config.sellTiers.map((tier) => tier.thresholdTokens),
    );
    expect(decoded.sellTiers.map((tier) => tier.feePpm)).toEqual(
      config.sellTiers.map((tier) => tier.feePpm),
    );
  });

  /*
   * `CREATOR` and `TREASURY` both encode the zero address, so the kind is the only thing
   * distinguishing them and a decoder that leaned on the address would turn both into an
   * `ADDRESS` recipient of nobody — a market paying its fees into the zero address.
   */
  it("distinguishes recipient roles that share the zero address", () => {
    const config = configOf(exactFlow(), BINDING);
    const decoded = decodeConfig(encodeConfig(config), labelsOf(config));

    expect(decoded.distribution.map((share) => share.recipient)).toEqual(
      config.distribution.map((share) => share.recipient),
    );
  });
});

describe("refusing what it does not understand", () => {
  /*
   * A configuration written for a later engine must not be reinterpreted under this one. The
   * fields might still decode; what they mean would be this build's guess, and a market page
   * confidently describing rules it does not implement is worse than one that says nothing.
   */
  it("refuses a configuration from a newer engine", () => {
    const config = configOf(flat("1"), BINDING);
    const encoded = encodeConfig(config);

    // The tuple is dynamic, so the first word is its offset and `engineVersion` is the second —
    // a left-padded uint8 whose value is the last character of that word.
    const bumped = `${encoded.slice(0, 129)}3${encoded.slice(130)}` as `0x${string}`;

    expect(() => decodeConfig(bumped, labelsOf(config))).toThrow(/engine version 3/);
  });

  it("refuses bytes that are not a configuration", () => {
    expect(() => decodeConfig("0xdeadbeef", labelsOf(configOf(flat("1"), BINDING)))).toThrow();
  });
});
