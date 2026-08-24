/**
 * Engine v2: the prompt that v1 refused, compiled end to end.
 */

import { describe, expect, it } from "vitest";

import { compile } from "./compile.js";
import { decodeConfig, encodeConfig } from "./encode.js";
import { BINDING, REFERENCE_SUPPLY } from "./fixtures.js";
import { review } from "./review.js";
import type { AgenMarketSpec } from "./spec.js";

const FEATURED: AgenMarketSpec = {
  engineVersion: 2,
  baseRate: { buy: "0.3", sell: "0.3" },
  ladder: null,
  sizeTiers: [],
  distribution: [
    { recipient: { kind: "LARGEST_HOLDER", periodSeconds: 3600 }, share: "50" },
    {
      recipient: { kind: "BUYBACK", trigger: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1" } },
      share: "50",
    },
  ],
  protections: [
    {
      kind: "WALLET_BUY_LIMIT",
      amount: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2" },
      windowSeconds: 12 * 60 * 60,
    },
  ],
};

describe("the featured v2 prompt", () => {
  it("compiles to a wallet cap, an hourly largest-holder pot, and a buyback trigger", () => {
    const result = compile(FEATURED, BINDING);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.config.engineVersion).toBe(2);
    expect(result.config.walletMaxBuyTokens).toBe(REFERENCE_SUPPLY / 50n);
    expect(result.config.walletWindowSeconds).toBe(12 * 60 * 60);
    expect(result.config.epochPeriodSeconds).toBe(3600);
    expect(result.config.buybackTriggerTokens).toBe(REFERENCE_SUPPLY / 100n);
  });

  it("round-trips through the v2 encoding", () => {
    const compiled = compile(FEATURED, BINDING);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const again = decodeConfig(encodeConfig(compiled.config), {
      launchedTokenSymbol: BINDING.launchedTokenSymbol,
      quoteAssetSymbol: BINDING.quoteAsset.symbol,
      quoteAssetDecimals: BINDING.quoteAsset.decimals,
    });

    expect(again.engineVersion).toBe(2);
    expect(again.walletMaxBuyTokens).toBe(compiled.config.walletMaxBuyTokens);
    expect(again.epochPeriodSeconds).toBe(3600);
    expect(again.buybackTriggerTokens).toBe(compiled.config.buybackTriggerTokens);
  });

  it("states the three costs on the review", () => {
    const compiled = compile(FEATURED, BINDING);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const cards = review(compiled.config).cards.map((card) => card.heading);
    expect(cards).toContain("Per-wallet buy limit");
    expect(cards).toContain("Buybacks");
    expect(cards).toContain("Where the fees go");
  });

  it("refuses the same economics claimed as engine v1", () => {
    const result = compile({ ...FEATURED, engineVersion: 1 }, BINDING);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.some((problem) => problem.code === "UNSUPPORTED_ENGINE_VERSION")).toBe(true);
  });
});
