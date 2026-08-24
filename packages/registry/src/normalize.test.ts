/**
 * Acceptance test 2 — that a Program is recognised as one Program however it was written
 * down.
 *
 * The distinction this suite draws is the reason `normalizeForDedupe` exists separately
 * from `deriveProgramIdentity`. `configHash` is exact and chain-matching: it hashes the
 * fields in the order the array holds them, because the engine does. Dedupe is a broader
 * question — "have we seen this market before, under any spelling" — and it has to hold
 * for two answers that listed the same rules in a different order, or expressed the same
 * rate in a different unit.
 */

import { describe, expect, it } from "vitest";
import { decodeConfig } from "@verdant/market-engine";
import type { CanonicalConfig } from "@verdant/market-engine";

import { dedupeKeyFor, normalizeForDedupe } from "./normalize.js";
import { deriveProgramIdentity } from "./identity.js";
import mainnet from "./fixtures/mainnet-engine-markets.json" with { type: "json" };

const LABELS = {
  launchedTokenSymbol: "T",
  quoteAssetSymbol: "ETH",
  quoteAssetDecimals: 18,
} as const;

const base = decodeConfig(mainnet.markets[0]?.encodedConfig as `0x${string}`, LABELS);

describe("acceptance test 2: key ordering does not change identity", () => {
  it("a config whose object keys were written in reverse dedupes identically", () => {
    /*
     * Rebuilt key by key in reverse insertion order. This is a real hazard rather than a
     * theoretical one: anything that reaches a Program through `JSON.parse` holds its keys
     * in whatever order the producer serialised them, and a dedupe key built by walking
     * `Object.entries` would differ for two identical markets.
     */
     const reversed = Object.fromEntries(
      Object.entries(base as unknown as Record<string, unknown>).reverse(),
    ) as unknown as CanonicalConfig;

    expect(Object.keys(reversed)).not.toEqual(Object.keys(base));
    expect(dedupeKeyFor(reversed)).toBe(dedupeKeyFor(base));
  });

  it("nested objects with reordered keys dedupe identically", () => {
    const reorderedQuote: CanonicalConfig = {
      ...base,
      quoteAsset: {
        decimals: base.quoteAsset.decimals,
        symbol: base.quoteAsset.symbol,
        address: base.quoteAsset.address,
      },
      stages: base.stages.map((stage) => ({
        sellFeePpm: stage.sellFeePpm,
        buyFeePpm: stage.buyFeePpm,
        threshold: stage.threshold,
      })),
    };

    expect(dedupeKeyFor(reorderedQuote)).toBe(dedupeKeyFor(base));
  });
});

describe("acceptance test 2: parameter ordering does not change identity", () => {
  it("stages listed in reverse dedupe identically", () => {
    const shuffled: CanonicalConfig = { ...base, stages: [...base.stages].reverse() };

    // Guard: a single-stage market would make this assertion vacuous.
    expect(base.stages.length).toBeGreaterThan(1);
    expect(dedupeKeyFor(shuffled)).toBe(dedupeKeyFor(base));
  });

  it("a reordered distribution dedupes identically", () => {
    const withTwoShares: CanonicalConfig = {
      ...base,
      distribution: [
        { recipient: { kind: "CREATOR" }, sharePpm: 700_000 },
        { recipient: { kind: "TREASURY" }, sharePpm: 300_000 },
      ],
    };
    const reversed: CanonicalConfig = {
      ...withTwoShares,
      distribution: [...withTwoShares.distribution].reverse(),
    };

    expect(dedupeKeyFor(reversed)).toBe(dedupeKeyFor(withTwoShares));
  });

  it("reordered tiers dedupe identically", () => {
    const tiered: CanonicalConfig = {
      ...base,
      sellTiers: [
        { thresholdTokens: 1_000n, feePpm: 10_000 },
        { thresholdTokens: 5_000n, feePpm: 20_000 },
      ],
    };
    const reversed: CanonicalConfig = { ...tiered, sellTiers: [...tiered.sellTiers].reverse() };

    expect(dedupeKeyFor(reversed)).toBe(dedupeKeyFor(tiered));
  });
});

describe("acceptance test 2: numeric formatting does not change identity", () => {
  /*
   * "2 vs 2.00 vs 200bps" is a question about how a rate arrived, and by the time a
   * configuration is canonical all three have already become one integer — 20 000 ppm. What
   * survives into this package is the *representation* of that integer, and there are three
   * ways to hold it: a `bigint`, a `number`, and the decimal string that a JSON round-trip
   * turns a `bigint` into. All three have to dedupe alike, because all three genuinely occur.
   */
  it("a threshold as bigint, number and string dedupe identically", () => {
    const asBigint: CanonicalConfig = {
      ...base,
      stages: [{ threshold: 0n, buyFeePpm: 20_000, sellFeePpm: 20_000 }],
    };
    const asNumber = {
      ...asBigint,
      stages: [{ threshold: 0, buyFeePpm: 20_000, sellFeePpm: 20_000 }],
    } as unknown as CanonicalConfig;
    const asString = {
      ...asBigint,
      stages: [{ threshold: "0", buyFeePpm: "20000", sellFeePpm: "20000" }],
    } as unknown as CanonicalConfig;

    expect(dedupeKeyFor(asNumber)).toBe(dedupeKeyFor(asBigint));
    expect(dedupeKeyFor(asString)).toBe(dedupeKeyFor(asBigint));
  });

  it("a trailing-zero decimal dedupes as the integer it is", () => {
    const plain = { ...base, referenceSupply: 1_000_000n } as CanonicalConfig;
    const decimalised = { ...base, referenceSupply: "1000000.00" } as unknown as CanonicalConfig;
    const exponential = { ...base, referenceSupply: "1e6" } as unknown as CanonicalConfig;

    expect(dedupeKeyFor(decimalised)).toBe(dedupeKeyFor(plain));
    expect(dedupeKeyFor(exponential)).toBe(dedupeKeyFor(plain));
  });

  it("a percent share written as 2, 2.00 and 200 bps dedupes identically", () => {
    const shares = [20_000, "20000", "20000.00"] as const;
    const keys = shares.map((sharePpm) =>
      dedupeKeyFor({
        ...base,
        distribution: [
          { recipient: { kind: "CREATOR" }, sharePpm: 980_000 },
          { recipient: { kind: "TREASURY" }, sharePpm },
        ],
      } as unknown as CanonicalConfig),
    );

    expect(new Set(keys).size).toBe(1);
  });

  it("an address in mixed case dedupes as the same address", () => {
    const lower: CanonicalConfig = {
      ...base,
      quoteAsset: { ...base.quoteAsset, address: "0x00000000000000000000000000000000000000ab" },
    };
    const upper: CanonicalConfig = {
      ...base,
      quoteAsset: { ...base.quoteAsset, address: "0x00000000000000000000000000000000000000AB" },
    };

    expect(dedupeKeyFor(upper)).toBe(dedupeKeyFor(lower));
  });
});

describe("normalization drops what is not economics, and nothing else", () => {
  it("labels do not affect the dedupe key", () => {
    const relabelled = decodeConfig(mainnet.markets[0]?.encodedConfig as `0x${string}`, {
      launchedTokenSymbol: "DIFFERENT",
      quoteAssetSymbol: "ALSO-DIFFERENT",
      quoteAssetDecimals: 6,
    });

    expect(dedupeKeyFor(relabelled)).toBe(dedupeKeyFor(base));
  });

  it("a differing parameter still produces a differing dedupe key", () => {
    const changed: CanonicalConfig = { ...base, referenceSupply: base.referenceSupply + 1n };
    expect(dedupeKeyFor(changed)).not.toBe(dedupeKeyFor(base));
  });

  it("the two live mainnet markets do not dedupe together", () => {
    const other = decodeConfig(mainnet.markets[1]?.encodedConfig as `0x${string}`, LABELS);
    expect(dedupeKeyFor(other)).not.toBe(dedupeKeyFor(base));
  });

  it("is idempotent: normalizing a normalized config is a fixed point", () => {
    const once = normalizeForDedupe(base);
    expect(JSON.stringify(normalizeForDedupe(base))).toBe(JSON.stringify(once));
  });

  it("agrees with the chain-exact identity on a config the chain produced", () => {
    /*
     * On an already-canonical configuration — one the engine itself ordered — dedupe must
     * not disagree with `configHash` about whether two markets are the same. This is what
     * ties the broader question back to the exact one.
     */
    const other = decodeConfig(mainnet.markets[1]?.encodedConfig as `0x${string}`, LABELS);

    const sameByHash = deriveProgramIdentity(base).configHash === deriveProgramIdentity(other).configHash;
    const sameByDedupe = dedupeKeyFor(base) === dedupeKeyFor(other);

    expect(sameByDedupe).toBe(sameByHash);
  });
});
