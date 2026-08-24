/**
 * Phase 2 acceptance: the prompts a real creator writes, and what the engine does with them.
 *
 * Each case is the envelope a correctly-behaving interpretation layer would return for the
 * prompt, driven through `resolve`. That is the right thing to test deterministically —
 * whether the *model* produces these envelopes is Phase 4's benchmark and needs a
 * network; whether the engine reaches the right verdict given them is decidable here, and
 * it is where every classification bug would live.
 *
 * No Solidity is generated anywhere in this file, which is the point of the refactor.
 */

import { describe, expect, it } from "vitest";

import { configHash } from "./encode.js";
import { evaluate } from "./evaluate.js";
import { BINDING, ONE_PERCENT_OF_SUPPLY, REFERENCE_SUPPLY } from "./fixtures.js";
import type { InterpretationEnvelope } from "./interpret.js";
import { resolve } from "./interpret.js";
import type { AgenMarketSpec, SizeTier } from "./spec.js";

const ONE_ETH = 10n ** 18n;
const TO_CREATOR = [{ recipient: { kind: "CREATOR" as const }, share: "100" }];

/** A supported envelope carrying a specification. */
function supported(spec: AgenMarketSpec, assumptions: readonly string[] = []): InterpretationEnvelope {
  return { outcome: "SUPPORTED", spec, unsupported: [], clarifications: [], assumptions };
}

/** An envelope reporting something engine v1 cannot express. */
function cannot(request: string, why: string): InterpretationEnvelope {
  return { outcome: "UNSUPPORTED", spec: null, unsupported: [{ request, why }], clarifications: [], assumptions: [] };
}

/** An envelope asking for a number the prompt did not state. */
function asks(id: string, question: string, because: string): InterpretationEnvelope {
  return {
    outcome: "NEEDS_CLARIFICATION",
    spec: null,
    unsupported: [],
    clarifications: [{ id, question, because }],
    assumptions: [],
  };
}

function base(buy: string, sell: string): AgenMarketSpec {
  return {
    engineVersion: 1,
    baseRate: { buy, sell },
    ladder: null,
    sizeTiers: [],
    distribution: TO_CREATOR,
    protections: [],
  };
}

function tier(side: "BUY" | "SELL", percent: string, rate: string, operator: "GT" | "GTE" = "GTE"): SizeTier {
  return { side, measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent, operator }, rate };
}

/** Every case, so the suite reads as the report the benchmark has to produce. */
interface Case {
  readonly n: number;
  readonly prompt: string;
  readonly envelope: InterpretationEnvelope;
  readonly expect: "SUPPORTED" | "NEEDS_CLARIFICATION" | "UNSUPPORTED" | "INTERPRETATION_ERROR";
}

const CASES: readonly Case[] = [
  {
    n: 1,
    prompt: "Launch DOG with a plain 2% fee.",
    envelope: supported(base("2", "2"), ["fees go to the creator, which the prompt did not state"]),
    expect: "SUPPORTED",
  },
  {
    n: 2,
    prompt: "Charge 1% on buys and 2% on sells.",
    envelope: supported(base("1", "2")),
    expect: "SUPPORTED",
  },
  {
    n: 3,
    prompt: "1% base. A sell of at least 1% of total supply pays 4%.",
    envelope: supported({ ...base("1", "1"), sizeTiers: [tier("SELL", "1", "4")] }),
    expect: "SUPPORTED",
  },
  {
    n: 4,
    prompt: "1% base. Sells over 1% of supply pay 3%, over 2% pay 5%, over 5% pay 8%.",
    envelope: supported({
      ...base("1", "1"),
      sizeTiers: [tier("SELL", "1", "3", "GT"), tier("SELL", "2", "5", "GT"), tier("SELL", "5", "8", "GT")],
    }),
    expect: "SUPPORTED",
  },
  {
    n: 5,
    prompt: "1% base. Buys of at least 0.5% of supply pay 2%, at least 1% pay 3%.",
    envelope: supported({
      ...base("1", "1"),
      sizeTiers: [tier("BUY", "0.5", "2"), tier("BUY", "1", "3")],
    }),
    expect: "SUPPORTED",
  },
  {
    n: 6,
    prompt: "A sell of exactly 1% of supply must pay 4%, not the base 0.5%, and not both added together.",
    envelope: supported({ ...base("0.5", "0.5"), sizeTiers: [tier("SELL", "1", "4", "GTE")] }),
    expect: "SUPPORTED",
  },
  {
    n: 7,
    prompt: "Sells strictly larger than 1% of supply pay 4%. A sell of exactly 1% pays the base rate.",
    envelope: supported({ ...base("0.5", "0.5"), sizeTiers: [tier("SELL", "1", "4", "GT")] }),
    expect: "SUPPORTED",
  },
  {
    n: 8,
    prompt: "2% for the first 24 hours, then 1%.",
    envelope: supported({
      ...base("2", "2"),
      ladder: { axis: "TIME", stages: [{ afterSeconds: 86_400, rate: { buy: "1", sell: "1" } }] },
    }),
    expect: "SUPPORTED",
  },
  {
    n: 9,
    prompt: "3% for the first hour, 2% for the next day, 1% after that.",
    envelope: supported({
      ...base("3", "3"),
      ladder: {
        axis: "TIME",
        stages: [
          { afterSeconds: 3_600, rate: { buy: "2", sell: "2" } },
          { afterSeconds: 90_000, rate: { buy: "1", sell: "1" } },
        ],
      },
    }),
    expect: "SUPPORTED",
  },
  {
    n: 10,
    prompt: "2% base, dropping to 1% after 100 ETH of cumulative volume.",
    envelope: supported({
      ...base("2", "2"),
      ladder: {
        axis: "QUOTE_VOLUME",
        stages: [{ afterQuoteAmount: (100n * ONE_ETH).toString(), rate: { buy: "1", sell: "1" } }],
      },
    }),
    expect: "SUPPORTED",
  },
  {
    n: 11,
    prompt: "1% base, and charge a higher fee on large sells.",
    envelope: asks(
      "large-sell",
      "How large is a large sell, as a share of total supply, and what should it pay?",
      "charge a higher fee on large sells",
    ),
    expect: "NEEDS_CLARIFICATION",
  },
  {
    n: 12,
    prompt: "1% base, but make whales pay more.",
    envelope: asks(
      "whale-threshold",
      "What size of trade counts as a whale, as a share of total supply, and what should it pay?",
      "make whales pay more",
    ),
    expect: "NEEDS_CLARIFICATION",
  },
  {
    n: 13,
    prompt: "1% fee, and a wallet can only sell once every 10 minutes.",
    envelope: cannot(
      "a wallet can only sell once every 10 minutes",
      "A per-wallet cooldown needs the trader's identity, and Uniswap reports the router rather than the person. " +
        "Agen can only learn the real trader through its own router, so the limit would bind trades routed " +
        "through Agen and be bypassed by a direct swap — a promise on the review screen that does not hold.",
    ),
    expect: "UNSUPPORTED",
  },
  {
    n: 14,
    prompt: "1% fee, but the first buyer of each wallet pays nothing.",
    envelope: cannot(
      "the first buyer of each wallet pays nothing",
      "A per-wallet rate needs the trader's identity, which Uniswap does not give a hook reliably.",
    ),
    expect: "UNSUPPORTED",
  },
  {
    n: 15,
    prompt: "2% base, dropping to 1% after $1m of volume. Quoted in ETH.",
    envelope: asks(
      "volume-denomination",
      "Volume is counted in ETH, the asset this market is quoted in, and there is no price feed on this chain " +
        "to convert dollars. How much ETH of cumulative volume should the rate drop at?",
      "after $1m of volume",
    ),
    expect: "NEEDS_CLARIFICATION",
  },
  {
    n: 16,
    prompt: "2% base, dropping to 1% after 500,000 USDG of volume. Quoted in USDG.",
    envelope: supported({
      ...base("2", "2"),
      ladder: {
        axis: "QUOTE_VOLUME",
        stages: [{ afterQuoteAmount: (500_000n * ONE_ETH).toString(), rate: { buy: "1", sell: "1" } }],
      },
    }),
    expect: "SUPPORTED",
  },
  {
    n: 17,
    prompt: "Charge 40% on every sell.",
    envelope: supported(base("1", "40")),
    expect: "UNSUPPORTED",
  },
  {
    n: 18,
    prompt: "Sells at or above 1% of supply pay 4%. Sells at or above 1% of supply pay 6%.",
    envelope: supported({
      ...base("1", "1"),
      sizeTiers: [tier("SELL", "1", "4"), tier("SELL", "1", "6")],
    }),
    expect: "UNSUPPORTED",
  },
  {
    n: 19,
    prompt: "1% fee, and after 10 consecutive buys with no sell, the next buy is free.",
    envelope: cannot(
      "after 10 consecutive buys with no sell, the next buy is free",
      "A streak counter is state the engine does not keep in v1. Engine v1 evaluates a trade from its size, " +
        "the time, and cumulative volume — never from the sequence of trades before it.",
    ),
    expect: "UNSUPPORTED",
  },
  {
    n: 20,
    prompt: "Launch a token called Rock, ticker ROCK. Nothing fancy.",
    envelope: supported(base("0.3", "0.3"), [
      "no fee was stated, so the market opens at 0.3% — the rate most Uniswap pools charge",
    ]),
    expect: "SUPPORTED",
  },
  {
    n: 21,
    prompt: "Sells pay 2%. Also sells pay nothing.",
    envelope: asks(
      "sell-rate",
      "The prompt states two different sell rates, 2% and nothing. Which is it?",
      "Sells pay 2%. Also sells pay nothing.",
    ),
    expect: "NEEDS_CLARIFICATION",
  },
  {
    n: 22,
    prompt: "Send 20% of fees to the treasury and 80% to me. Sells over 2% of supply pay 5%; base is 1%.",
    envelope: supported({
      engineVersion: 1,
      baseRate: { buy: "1", sell: "1" },
      ladder: null,
      sizeTiers: [tier("SELL", "2", "5", "GT")],
      distribution: [
        { recipient: { kind: "TREASURY" }, share: "20" },
        { recipient: { kind: "CREATOR" }, share: "80" },
      ],
      protections: [],
    }),
    expect: "SUPPORTED",
  },
  {
    n: 23,
    prompt:
      "Every hour the largest holder receives 50% of the fees. The remaining 50% is used for " +
      "buyback which is triggered after every large sell. Do not let anyone buy more than 2% " +
      "of the supply in the first 12hrs of trading.",
    envelope: supported(
      {
        engineVersion: 2,
        baseRate: { buy: "0.3", sell: "0.3" },
        ladder: null,
        sizeTiers: [],
        distribution: [
          { recipient: { kind: "LARGEST_HOLDER", periodSeconds: 3600 }, share: "50" },
          {
            recipient: {
              kind: "BUYBACK",
              trigger: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1" },
            },
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
      },
      [
        "no fee was stated, so the market opens at 0.3% — the rate most Uniswap pools charge",
        "a large sell is read as 1% of supply",
      ],
    ),
    expect: "SUPPORTED",
  },
];

describe("Phase 2 acceptance: 23 realistic prompts", () => {
  for (const testCase of CASES) {
    it(`${String(testCase.n).padStart(2, "0")} ${testCase.expect} — ${testCase.prompt}`, () => {
      const result = resolve(testCase.envelope, BINDING);
      expect(result.outcome).toBe(testCase.expect);

      if (testCase.expect === "SUPPORTED") {
        expect(result.config).not.toBeNull();
      } else {
        expect(result.config).toBeNull();
        // Nothing is ever refused without saying why.
        expect(result.problems.length).toBeGreaterThan(0);
      }
    });
  }

  it("classifies every case, with no silent passes", () => {
    const classified = CASES.map((testCase) => resolve(testCase.envelope, BINDING).outcome);
    expect(classified).toHaveLength(23);
    expect(classified.every((outcome) => outcome !== undefined)).toBe(true);
  });
});

describe("the supported prompts produce the economics they asked for", () => {
  function configFor(n: number) {
    const found = CASES.find((testCase) => testCase.n === n);
    if (found === undefined) throw new Error(`no case ${String(n)}`);
    const result = resolve(found.envelope, BINDING);
    if (result.config === null) throw new Error(`case ${String(n)} did not compile`);
    return result.config;
  }

  it("01 charges 2% both ways and nothing else", () => {
    const config = configFor(1);
    for (const side of ["BUY", "SELL"] as const) {
      const evaluation = evaluate(config, {
        side,
        grossTokenAmount: REFERENCE_SUPPLY / 2n,
        grossQuoteAmount: ONE_ETH,
        elapsedSeconds: 10n ** 9n,
        cumulativeQuoteVolume: 10n ** 27n,
      });
      expect(evaluation.effectiveFeePpm).toBe(20_000);
    }
  });

  it("02 keeps the two directions apart", () => {
    const config = configFor(2);
    const at = (side: "BUY" | "SELL"): number =>
      evaluate(config, {
        side,
        grossTokenAmount: 1n,
        grossQuoteAmount: ONE_ETH,
        elapsedSeconds: 0n,
        cumulativeQuoteVolume: 0n,
      }).effectiveFeePpm;

    expect(at("BUY")).toBe(10_000);
    expect(at("SELL")).toBe(20_000);
  });

  it("06 pays the tier at exactly the threshold, and does not add the rates", () => {
    // The sentence the original Exact Flow build shipped with no test for.
    const config = configFor(6);
    const at = (grossTokenAmount: bigint): number =>
      evaluate(config, {
        side: "SELL",
        grossTokenAmount,
        grossQuoteAmount: ONE_ETH,
        elapsedSeconds: 0n,
        cumulativeQuoteVolume: 0n,
      }).effectiveFeePpm;

    expect(at(ONE_PERCENT_OF_SUPPLY - 1n)).toBe(5_000);
    expect(at(ONE_PERCENT_OF_SUPPLY)).toBe(40_000);
    expect(at(ONE_PERCENT_OF_SUPPLY + 1n)).toBe(40_000);
  });

  it("07 excludes the exact threshold, which is the opposite of 06", () => {
    const config = configFor(7);
    const at = (grossTokenAmount: bigint): number =>
      evaluate(config, {
        side: "SELL",
        grossTokenAmount,
        grossQuoteAmount: ONE_ETH,
        elapsedSeconds: 0n,
        cumulativeQuoteVolume: 0n,
      }).effectiveFeePpm;

    expect(at(ONE_PERCENT_OF_SUPPLY)).toBe(5_000);
    expect(at(ONE_PERCENT_OF_SUPPLY + 1n)).toBe(40_000);
  });

  it("04 picks the highest matching tier of three", () => {
    const config = configFor(4);
    const at = (percentOfSupply: bigint): number =>
      evaluate(config, {
        side: "SELL",
        grossTokenAmount: (REFERENCE_SUPPLY * percentOfSupply) / 100n,
        grossQuoteAmount: ONE_ETH,
        elapsedSeconds: 0n,
        cumulativeQuoteVolume: 0n,
      }).effectiveFeePpm;

    expect(at(1n)).toBe(10_000);
    expect(at(2n)).toBe(30_000);
    expect(at(3n)).toBe(50_000);
    expect(at(6n)).toBe(80_000);
  });

  it("08 changes rate exactly on the hour boundary", () => {
    const config = configFor(8);
    const at = (elapsedSeconds: bigint): number =>
      evaluate(config, {
        side: "BUY",
        grossTokenAmount: 1n,
        grossQuoteAmount: ONE_ETH,
        elapsedSeconds,
        cumulativeQuoteVolume: 0n,
      }).effectiveFeePpm;

    expect(at(86_399n)).toBe(20_000);
    expect(at(86_400n)).toBe(10_000);
  });

  it("22 splits the fee exactly as asked", () => {
    const config = configFor(22);
    const grossTokenAmount = (REFERENCE_SUPPLY * 3n) / 100n;
    const evaluation = evaluate(config, {
      side: "SELL",
      grossTokenAmount,
      grossQuoteAmount: 100n * ONE_ETH,
      elapsedSeconds: 0n,
      cumulativeQuoteVolume: 0n,
    });

    expect(evaluation.effectiveFeePpm).toBe(50_000);
    // This market has a sell tier, so it collects in the launched token.
    expect(evaluation.feeCurrency).toBe("TOKEN");
    expect(evaluation.feeAmount).toBe(grossTokenAmount / 20n);

    const creator = evaluation.payouts.find((payout) => payout.recipient.kind === "CREATOR");
    const treasury = evaluation.payouts.find((payout) => payout.recipient.kind === "TREASURY");
    expect(creator?.amount).toBe((evaluation.feeAmount * 80n) / 100n);
    expect(treasury?.amount).toBe((evaluation.feeAmount * 20n) / 100n);
    expect((creator?.amount ?? 0n) + (treasury?.amount ?? 0n)).toBe(evaluation.feeAmount);
  });
});

describe("a reordered prompt is the same market", () => {
  it("hashes identically however the model ordered the rules", () => {
    const forwards = resolve(
      supported({
        engineVersion: 1,
        baseRate: { buy: "1", sell: "1" },
        ladder: null,
        sizeTiers: [tier("SELL", "2", "5", "GT")],
        distribution: [
          { recipient: { kind: "TREASURY" }, share: "20" },
          { recipient: { kind: "CREATOR" }, share: "80" },
        ],
        protections: [],
      }),
      BINDING,
    );

    const backwards = resolve(
      supported({
        engineVersion: 1,
        baseRate: { buy: "1", sell: "1" },
        ladder: null,
        sizeTiers: [tier("SELL", "2", "5", "GT")],
        distribution: [
          { recipient: { kind: "CREATOR" }, share: "80" },
          { recipient: { kind: "TREASURY" }, share: "20" },
        ],
        protections: [],
      }),
      BINDING,
    );

    expect(forwards.config).not.toBeNull();
    expect(backwards.config).not.toBeNull();
    expect(configHash(backwards.config!)).toBe(configHash(forwards.config!));
  });
});

describe("the engine does not trust the model's claim", () => {
  it("overrides SUPPORTED when the compiler refuses the specification", () => {
    // Case 17: the model believed 40% was fine. The compiler decides, not the claim.
    const result = resolve(supported(base("1", "40")), BINDING);
    expect(result.outcome).toBe("UNSUPPORTED");
    expect(result.problems.map((problem) => problem.code)).toContain("INVALID_FEE");
  });

  /*
   * The specific failure this ordering prevents: a model that notices it cannot express
   * part of the prompt, reports it, and *also* attaches a specification for the rest.
   * Launching that would deploy a market missing a requirement the model itself flagged —
   * unsupported behaviour quietly lowered into supported behaviour.
   */
  it("refuses a market that drops a requirement the model itself flagged", () => {
    const result = resolve(
      {
        outcome: "SUPPORTED",
        spec: base("1", "1"),
        unsupported: [{ request: "a wallet cooldown", why: "needs trader identity" }],
        clarifications: [],
        assumptions: [],
      },
      BINDING,
    );

    expect(result.outcome).toBe("UNSUPPORTED");
    expect(result.config).toBeNull();
  });

  it("refuses an unsupported claim that names nothing", () => {
    const result = resolve(
      { outcome: "UNSUPPORTED", spec: null, unsupported: [], clarifications: [], assumptions: [] },
      BINDING,
    );
    expect(result.outcome).toBe("INTERPRETATION_ERROR");
  });

  it("refuses a clarification that asks nothing", () => {
    const result = resolve(
      { outcome: "NEEDS_CLARIFICATION", spec: null, unsupported: [], clarifications: [], assumptions: [] },
      BINDING,
    );
    expect(result.outcome).toBe("INTERPRETATION_ERROR");
  });

  it("refuses a supported claim with no specification attached", () => {
    const result = resolve(
      { outcome: "SUPPORTED", spec: null, unsupported: [], clarifications: [], assumptions: [] },
      BINDING,
    );
    expect(result.outcome).toBe("INTERPRETATION_ERROR");
  });

  it("treats an invented envelope field as a system failure", () => {
    const result = resolve(
      { outcome: "SUPPORTED", spec: base("1", "1"), unsupported: [], clarifications: [], assumptions: [], customHook: "0x00" },
      BINDING,
    );
    expect(result.outcome).toBe("INTERPRETATION_ERROR");
  });

  it("will not let the model claim INTERPRETATION_ERROR about itself", () => {
    // That judgement is about the answer rather than about the market, and is not the
    // model's to make.
    const result = resolve(
      { outcome: "INTERPRETATION_ERROR", spec: null, unsupported: [], clarifications: [], assumptions: [] },
      BINDING,
    );
    expect(result.outcome).toBe("INTERPRETATION_ERROR");
    expect(result.problems.map((problem) => problem.code)).toContain("UNKNOWN_VARIANT");
  });
});
