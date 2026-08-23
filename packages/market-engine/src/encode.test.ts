import { describe, expect, it } from "vitest";

import { compile } from "./compile.js";
import {
  AGEN_ENGINE_CONFIG_V1_DOMAIN,
  type EngineIdentity,
  configHash,
  encodeConfig,
  implementationHash,
} from "./encode.js";
import { BINDING, EQUITY_QUOTE, exactFlow, flat } from "./fixtures.js";
import type { AgenMarketSpec, CanonicalConfig, MarketBinding } from "./spec.js";

function configOf(spec: AgenMarketSpec, binding: MarketBinding = BINDING): CanonicalConfig {
  const result = compile(spec, binding);
  if (!result.ok) throw new Error(result.problems.map((p) => `${p.code} ${p.detail}`).join("; "));
  return result.config;
}

const IDENTITY: EngineIdentity = {
  chainId: 4663,
  engine: "0x00000000000000000000000000000000000038cc",
  engineVersion: 1,
};

describe("encodeConfig", () => {
  it("is deterministic", () => {
    expect(encodeConfig(configOf(exactFlow()))).toBe(encodeConfig(configOf(exactFlow())));
  });

  /*
   * The property that makes the commitment meaningful. A model asked the same question
   * twice will list rules in whatever order it happens to; if that changed the hash, a
   * creator's approval would be invalidated by a retry that produced the identical
   * market. Canonicalization is what makes these equal, and this is where it is proven.
   */
  it("does not depend on the order the model listed the rules", () => {
    const forwards: AgenMarketSpec = {
      ...flat("1"),
      sizeTiers: [
        { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" }, rate: "3" },
        { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2", operator: "GTE" }, rate: "5" },
      ],
      distribution: [
        { recipient: { kind: "CREATOR" }, share: "80" },
        { recipient: { kind: "TREASURY" }, share: "20" },
      ],
    };

    const backwards: AgenMarketSpec = {
      ...forwards,
      sizeTiers: [forwards.sizeTiers[1]!, forwards.sizeTiers[0]!],
      distribution: [forwards.distribution[1]!, forwards.distribution[0]!],
    };

    expect(configHash(configOf(backwards))).toBe(configHash(configOf(forwards)));
  });

  it("gives the same hash to two spellings of the same split", () => {
    // [creator 50, creator 50] and [creator 100] are the same market.
    const split = configOf({
      ...flat("1"),
      distribution: [
        { recipient: { kind: "CREATOR" }, share: "50" },
        { recipient: { kind: "CREATOR" }, share: "50" },
      ],
    });
    const whole = configOf({ ...flat("1"), distribution: [{ recipient: { kind: "CREATOR" }, share: "100" }] });

    expect(configHash(split)).toBe(configHash(whole));
  });

  it("gives the same hash to GT and GTE spellings that admit the same trades", () => {
    // `> 1% - 1 base unit` and `>= 1%` are the same rule. Both normalize to the same
    // inclusive threshold, so both must hash the same.
    const supply = BINDING.referenceSupply;
    const onePercent = supply / 100n;

    const inclusive = configOf({
      ...flat("1"),
      sizeTiers: [
        { side: "SELL", measure: { kind: "ABSOLUTE_TOKENS", tokens: onePercent.toString(), operator: "GTE" }, rate: "4" },
      ],
    });
    const exclusive = configOf({
      ...flat("1"),
      sizeTiers: [
        {
          side: "SELL",
          measure: { kind: "ABSOLUTE_TOKENS", tokens: (onePercent - 1n).toString(), operator: "GT" },
          rate: "4",
        },
      ],
    });

    expect(configHash(exclusive)).toBe(configHash(inclusive));
  });

  describe("every economically relevant field changes the hash", () => {
    const baseline = configHash(configOf(exactFlow()));

    it("the base rate", () => {
      expect(configHash(configOf({ ...exactFlow(), baseRate: { buy: "0.5", sell: "0.6" } }))).not.toBe(baseline);
    });

    it("a tier's threshold", () => {
      const moved = exactFlow();
      expect(
        configHash(
          configOf({
            ...moved,
            sizeTiers: [
              { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2", operator: "GTE" }, rate: "4" },
            ],
          }),
        ),
      ).not.toBe(baseline);
    });

    it("a tier's rate", () => {
      expect(
        configHash(
          configOf({
            ...exactFlow(),
            sizeTiers: [
              { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" }, rate: "5" },
            ],
          }),
        ),
      ).not.toBe(baseline);
    });

    it("a tier's side", () => {
      expect(
        configHash(
          configOf({
            ...exactFlow(),
            sizeTiers: [
              { side: "BUY", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" }, rate: "4" },
            ],
          }),
        ),
      ).not.toBe(baseline);
    });

    it("the operator, where it admits a different set of trades", () => {
      expect(
        configHash(
          configOf({
            ...exactFlow(),
            sizeTiers: [
              { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GT" }, rate: "4" },
            ],
          }),
        ),
      ).not.toBe(baseline);
    });

    it("the split", () => {
      expect(
        configHash(
          configOf({
            ...exactFlow(),
            distribution: [
              { recipient: { kind: "CREATOR" }, share: "70" },
              { recipient: { kind: "TREASURY" }, share: "30" },
            ],
          }),
        ),
      ).not.toBe(baseline);
    });

    it("who receives it", () => {
      expect(
        configHash(
          configOf({
            ...exactFlow(),
            distribution: [
              { recipient: { kind: "ADDRESS", address: "0x4444444444444444444444444444444444444444" }, share: "80" },
              { recipient: { kind: "TREASURY" }, share: "20" },
            ],
          }),
        ),
      ).not.toBe(baseline);
    });

    it("the quote asset", () => {
      // A volume threshold means something different in NVDA than in ETH, and so does the
      // asset the creator is paid in.
      expect(configHash(configOf(exactFlow(), { ...BINDING, quoteAsset: EQUITY_QUOTE }))).not.toBe(baseline);
    });

    it("the reference supply", () => {
      // Every percentage threshold is measured against it.
      expect(
        configHash(configOf(exactFlow(), { ...BINDING, referenceSupply: BINDING.referenceSupply * 2n })),
      ).not.toBe(baseline);
    });

    it("a ceiling", () => {
      expect(
        configHash(
          configOf({
            ...exactFlow(),
            protections: [
              { kind: "MAX_TRADE_SIZE", side: "SELL", amount: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "5" } },
            ],
          }),
        ),
      ).not.toBe(baseline);
    });

    it("adding a ladder", () => {
      expect(
        configHash(
          configOf({
            ...exactFlow(),
            ladder: { axis: "TIME", stages: [{ afterSeconds: 3_600, rate: { buy: "1", sell: "1" } }] },
          }),
        ),
      ).not.toBe(baseline);
    });
  });

  it("distinguishes a single-stage market from a laddered one with the same rates", () => {
    // A one-stage ladder encodes axis 0; a TIME ladder whose only later stage repeats the
    // base rate encodes axis 1 and two stages. The economics are the same today and the
    // configurations are not, so the hashes must differ.
    const flatMarket = configOf(flat("1"));
    const laddered = configOf({
      ...flat("1"),
      ladder: { axis: "TIME", stages: [{ afterSeconds: 3_600, rate: { buy: "1", sell: "1" } }] },
    });

    expect(configHash(laddered)).not.toBe(configHash(flatMarket));
  });
});

describe("implementationHash", () => {
  it("is domain separated", () => {
    // The field it occupies in AgenMarketRegistry is the same one engine-0 markets use for
    // the hash of their generated Solidity. Two preimages sharing one field is exactly
    // where a verifier checks the wrong thing and finds it matches.
    expect(AGEN_ENGINE_CONFIG_V1_DOMAIN).toMatch(/^0x[0-9a-f]{64}$/);
    expect(implementationHash(configOf(exactFlow()), IDENTITY)).not.toBe(configHash(configOf(exactFlow())));
  });

  it("binds the chain", () => {
    expect(implementationHash(configOf(exactFlow()), { ...IDENTITY, chainId: 46630 })).not.toBe(
      implementationHash(configOf(exactFlow()), IDENTITY),
    );
  });

  it("binds the engine that will execute it", () => {
    // The engine is the code that decides what the configuration means, so the same
    // economics pointed at a different engine is a different commitment.
    expect(
      implementationHash(configOf(exactFlow()), {
        ...IDENTITY,
        engine: "0x00000000000000000000000000000000000038cd",
      }),
    ).not.toBe(implementationHash(configOf(exactFlow()), IDENTITY));
  });

  it("changes whenever the economics change", () => {
    expect(implementationHash(configOf(flat("2")), IDENTITY)).not.toBe(
      implementationHash(configOf(flat("1")), IDENTITY),
    );
  });

  it("is stable across runs", () => {
    expect(implementationHash(configOf(exactFlow()), IDENTITY)).toBe(
      implementationHash(configOf(exactFlow()), IDENTITY),
    );
  });

  /*
   * Golden vectors.
   *
   * Pinned so that a change to the encoding layout, the domain string, the field order or
   * the recipient discriminants is a failing test rather than a hash that silently stops
   * matching every commitment ever issued. `encoding.vectors.t.sol` asserts the Solidity
   * produces these same bytes.
   */
  describe("golden vectors", () => {
    it("a flat 2% market to the creator", () => {
      expect(configHash(configOf(flat("2")))).toMatchInlineSnapshot(`"0x225b540b46871d6e78cfe081b38e0ca40706400967ee3d6e9aad6a816a85129f"`);
    });

    it("the Exact Flow shape", () => {
      expect(configHash(configOf(exactFlow()))).toMatchInlineSnapshot(`"0xffee9714820fcf36691dccb85c662676825e723b263052f53f218a575d4fb713"`);
    });

    it("the domain separator", () => {
      expect(AGEN_ENGINE_CONFIG_V1_DOMAIN).toMatchInlineSnapshot(`"0xcbb080ad81595a7c4dc0e488922e8519b387f35df29ca8ad31e3de2057928ca3"`);
    });

    it("a full engine-v1 commitment", () => {
      expect(implementationHash(configOf(exactFlow()), IDENTITY)).toMatchInlineSnapshot(`"0x8ea72e5081ef5dac76dc1af25fbd015775e82922c073965065e711647b4fd255"`);
    });
  });
});
