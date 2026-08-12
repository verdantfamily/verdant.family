import { describe, expect, it } from "vitest";

import type { Assumption, MarketSpecification, Suggestion } from "./spec.js";
import {
  acceptDefault,
  acceptedSuggestions,
  acceptSuggestion,
  assess,
  confirmAssumption,
  decideAll,
  declineSuggestion,
  derivedNow,
  isSelfContained,
  outstanding,
  materialAssumptions,
  openSuggestions,
  overrideAssumption,
  promoteForConfirmation,
  PROTOCOL_MAX_FEE_PPM,
  requestEdit,
  resolveAmbiguity,
  rulesAreStale,
  validateSpecification,
} from "./spec.js";

/**
 * The specification the first vertical slice has to survive, written out by hand here
 * so the validator can be tested without a model. It is the CNPY prompt: a base fee, a
 * size-triggered surcharge split between two sinks, a consecutive-buy streak that
 * waives a fee, and a permanent fee reduction at a volume milestone.
 */
function cnpy(): MarketSpecification {
  return {
    version: 1,
    name: "Canopy",
    symbol: "CNPY",
    summary: "Large sells pay 2% to buybacks; every 10th buy streak trades free",
    baseFeePpm: 5_000,
    maxFeePpm: 25_000,
    phases: [
      { name: "launch", description: "From creation until the volume milestone", transitionsTo: ["mature"] },
      { name: "mature", description: "After $1M cumulative volume", terminal: true },
    ],
    state: [
      { name: "consecutiveBuys", type: "counter", description: "Buys since the last sell", initial: 0 },
      { name: "buybackReserve", type: "accumulator", description: "Quote asset held for buybacks" },
      { name: "jackpot", type: "accumulator", description: "Quote asset held for the jackpot" },
      { name: "cumulativeVolume", type: "accumulator", description: "Lifetime quote volume" },
      {
        name: "baseFeeReduced",
        type: "boolean",
        description: "Set once the milestone permanently lowers the base fee",
        initial: false,
        writeOnce: true,
      },
    ],
    rules: [
      {
        id: "large-sell-surcharge",
        title: "LARGE SELL SURCHARGE",
        when: { kind: "sell", description: "Somebody sells into the pool" },
        conditions: [
          {
            kind: "tradeSizeVsLiquidity",
            description: "The sell is larger than 1% of current pool liquidity",
            parameters: { operator: ">", percent: 1 },
          },
        ],
        then: [
          {
            kind: "extraFee",
            description: "Charge an additional 2% on the sell",
            parameters: { feePpm: 20_000 },
          },
          {
            kind: "routeFee",
            description: "Send the surcharge to the buyback reserve",
            parameters: { destination: "buybackReserve", share: 100 },
            writes: ["buybackReserve"],
          },
        ],
      },
      {
        id: "buy-streak",
        title: "BUY STREAK",
        when: { kind: "buy", description: "Somebody buys from the pool" },
        conditions: [
          {
            kind: "consecutiveCount",
            description: "Ten buys have happened with no sell between them",
            parameters: { state: "consecutiveBuys", operator: ">=", value: 10 },
          },
        ],
        then: [
          { kind: "waiveFee", description: "The trade pays no hook fee" },
          {
            kind: "resetCounter",
            description: "Start the streak again",
            parameters: { state: "consecutiveBuys" },
            writes: ["consecutiveBuys"],
          },
        ],
      },
      {
        id: "volume-milestone",
        title: "VOLUME MILESTONE",
        when: {
          kind: "volumeThreshold",
          description: "Cumulative volume reaches $1M",
          parameters: { amountUsd: 1_000_000 },
        },
        conditions: [],
        onceOnly: true,
        then: [
          {
            kind: "setFee",
            description: "Permanently reduce the base fee to 0.25%",
            parameters: { feePpm: 2_500 },
            writes: ["baseFeeReduced"],
          },
          {
            kind: "transitionPhase",
            description: "Enter the mature phase",
            parameters: { phase: "mature" },
          },
        ],
      },
    ],
    invariants: [
      {
        id: "fee-ceiling",
        statement: "The total hook-imposed fee never exceeds 3%",
        expression: "hookFeePpm <= 30000",
      },
      {
        id: "reserves-conserved",
        statement: "Every unit routed to a sink is accounted for in that sink's balance",
      },
    ],
    externalDependencies: [],
    assumptions: [
      // Confirmed, because a hand-written fixture stands for a specification that has
      // already been through the conversation. Without that the two high-impact readings
      // would be promoted back into questions, which is the correct behaviour for a fresh
      // interpretation and the wrong one for a market that is settled.
      {
        id: "large-sell",
        term: "large sell",
        interpretation: "A sell larger than 1% of the pool's current liquidity",
        why: "The prompt says large without saying large compared to what.",
        parameters: { percent: 1 },
        importance: "high",
        confirmed: true,
      },
      {
        id: "volume-currency",
        term: "$1M volume",
        interpretation: "Cumulative quote-asset volume valued at launch price",
        why: "A dollar figure needs something on chain to measure it in.",
        importance: "high",
        confirmed: true,
      },
      {
        id: "streak-counting",
        term: "consecutive buys",
        interpretation: "Any sell resets the count to zero",
        why: "Consecutive means uninterrupted, and a sell is the interruption.",
        importance: "low",
      },
    ],
    ambiguities: [],
    suggestions: [],
    unsupported: [],
  };
}

describe("a coherent specification", () => {
  it("accepts the first slice's market", () => {
    expect(validateSpecification(cnpy())).toEqual([]);
  });

  it("knows it needs nothing outside the pool", () => {
    expect(isSelfContained(cnpy())).toBe(true);
  });

  it("surfaces only the assumptions that change behaviour", () => {
    const shown = materialAssumptions(cnpy()).map((assumption) => assumption.term);
    expect(shown).toEqual(["large sell", "$1M volume"]);
    expect(shown).not.toContain("consecutive buys");
  });
});

describe("internal coherence", () => {
  it("tolerates an effect naming state that is not declared, because it is annotation", () => {
    const spec = cnpy();
    const problems = validateSpecification({
      ...spec,
      rules: [
        {
          ...spec.rules[0]!,
          then: [
            {
              kind: "accumulate",
              description: "Add to a pot that was never declared",
              parameters: {},
              writes: ["mysteryPot"],
            },
          ],
        },
        ...spec.rules.slice(1),
      ],
    });

    // `writes` never reaches a contract, and three live builds died at interpretation
    // over a model describing a fee change in it. Loose names are dropped during
    // interpretation rather than failing the build.
    expect(problems.filter((entry) => entry.path.endsWith(".writes"))).toEqual([]);
  });

  it("catches a transition to a phase that does not exist", () => {
    const spec = cnpy();
    const problems = validateSpecification({
      ...spec,
      rules: [
        {
          ...spec.rules[2]!,
          then: [
            {
              kind: "transitionPhase",
              description: "Enter a phase nobody defined",
              parameters: { phase: "endgame" },
            },
          ],
        },
      ],
    });

    expect(problems.some((problem) => problem.detail.includes('no such phase: "endgame"'))).toBe(true);
  });

  it("catches a rule that can charge more than the market disclosed", () => {
    const spec = cnpy();
    const problems = validateSpecification({
      ...spec,
      rules: [
        {
          ...spec.rules[0]!,
          then: [
            {
              kind: "extraFee",
              description: "Charge 40%",
              parameters: { feePpm: 400_000 },
            },
          ],
        },
      ],
    });

    expect(
      problems.some(
        (problem) =>
          problem.path === "rules[0].then[0].parameters.feePpm" &&
          problem.detail.includes("declared maximum fee"),
      ),
    ).toBe(true);
  });

  it("allows unusual economics when the market discloses them", () => {
    // 40% on a sell is a strange market, not an illegitimate one. Agen's job is to make
    // the number impossible to miss, not impossible to choose.
    const spec = cnpy();
    const problems = validateSpecification({
      ...spec,
      maxFeePpm: 400_000,
      rules: [
        {
          ...spec.rules[0]!,
          then: [
            { kind: "extraFee", description: "Charge 40%", parameters: { feePpm: 400_000 } },
          ],
        },
      ],
    });

    expect(problems).toEqual([]);
  });

  it("refuses a fee the protocol itself cannot express", () => {
    const problems = validateSpecification({ ...cnpy(), maxFeePpm: PROTOCOL_MAX_FEE_PPM + 1 });
    expect(problems.some((problem) => problem.path === "maxFeePpm")).toBe(true);
  });

  it("refuses a base fee above the market's own ceiling", () => {
    const problems = validateSpecification({ ...cnpy(), baseFeePpm: 30_000, maxFeePpm: 25_000 });
    expect(problems.some((problem) => problem.detail.includes("above this market's declared ceiling"))).toBe(
      true,
    );
  });

  it("does not police write-once against an advisory field", () => {
    const spec = cnpy();
    const milestone = spec.rules[2]!;
    const problems = validateSpecification({
      ...spec,
      // Same rule, minus the promise that it only ever happens once.
      rules: [{ ...milestone, onceOnly: false }],
    });

    // This check used to exist and blocked three live builds without once being right.
    // `writes` is annotation; whether the contract assigns a variable twice is a
    // question about the Solidity, not about the specification.
    expect(problems).toEqual([]);
  });

  it("catches a terminal phase that claims to lead somewhere", () => {
    const spec = cnpy();
    const problems = validateSpecification({
      ...spec,
      phases: [
        { name: "launch", description: "start", transitionsTo: ["mature"] },
        { name: "mature", description: "end", terminal: true, transitionsTo: ["launch"] },
      ],
    });

    expect(problems.some((problem) => problem.path === "phases[1]")).toBe(true);
  });

  it("catches a rule that does nothing", () => {
    const spec = cnpy();
    const problems = validateSpecification({
      ...spec,
      rules: [{ ...spec.rules[0]!, then: [] }],
    });

    expect(problems).toContainEqual({
      path: "rules[0].then",
      detail: "a rule that does nothing is not a rule",
    });
  });

  it("catches duplicate rule ids and state names", () => {
    const spec = cnpy();
    const problems = validateSpecification({
      ...spec,
      rules: [spec.rules[0]!, { ...spec.rules[1]!, id: spec.rules[0]!.id }],
      state: [...spec.state, spec.state[0]!],
    });

    expect(problems.some((problem) => problem.detail.startsWith("duplicate rule id"))).toBe(true);
    expect(problems.some((problem) => problem.detail.startsWith("duplicate state variable"))).toBe(
      true,
    );
  });

  it("requires an external dependency to say what happens when it fails", () => {
    const spec = cnpy();
    const problems = validateSpecification({
      ...spec,
      externalDependencies: [
        { kind: "priceOracle", description: "ETH/USD", failureBehaviour: "  " },
      ],
    });

    expect(problems.some((problem) => problem.path === "externalDependencies")).toBe(true);
    expect(isSelfContained({ ...spec, externalDependencies: [
      { kind: "priceOracle", description: "ETH/USD", failureBehaviour: "hold the last fee" },
    ] })).toBe(false);
  });
});

describe("the vocabulary is open", () => {
  it("accepts a mechanic nobody anticipated", () => {
    const spec = cnpy();

    // Deliberately not in any register: a trigger, a condition and an effect that no
    // enumeration in this codebase mentions. If this ever starts failing, the product
    // promise has been quietly narrowed to a template list.
    const problems = validateSpecification({
      ...spec,
      state: [
        ...spec.state,
        { name: "reversalCredit", type: "priceImpactLedger", description: "Impact each buyer reversed" },
      ],
      rules: [
        {
          id: "recovery-auction",
          title: "RECOVERY AUCTION",
          when: {
            kind: "accumulatorReachedThreshold",
            description: "The stranded sell fees reach one ether",
            parameters: { state: "jackpot", amountWei: 1_000_000_000_000_000_000n },
          },
          conditions: [
            {
              kind: "priceImpactReversed",
              description: "The buyer reversed part of the preceding sell's impact",
              parameters: { minimumBps: 10 },
            },
          ],
          then: [
            {
              kind: "openCompetitiveWindow",
              description: "Buyers compete for ten minutes on impact reversed",
              parameters: { durationSeconds: 600 },
              writes: ["reversalCredit"],
            },
          ],
        },
      ],
    });

    expect(problems).toEqual([]);
  });
});

describe("the clarification loop", () => {
  /** A question with a defensible default, which is most of them. */
  function soft(id: string) {
    return {
      id,
      question: "Should the buyback execute immediately or accumulate?",
      why: "It changes when value leaves the reserve and how large each buy is.",
      otherwise: "Accumulate and execute on the first buy after each 10-minute interval.",
      options: ["immediately", "accumulate"],
      blocking: false,
    } as const;
  }

  function hard(id: string) {
    return { ...soft(id), blocking: true } as const;
  }

  it("builds without asking when every question has a defensible default", () => {
    const spec = { ...cnpy(), ambiguities: [soft("buyback-timing")] };
    expect(assess(spec).status).toBe("ready");
  });

  it("stops before generating anything when a question would change the market", () => {
    const spec = { ...cnpy(), ambiguities: [hard("buyback-timing")] };
    const assessment = assess(spec);

    expect(assessment.status).toBe("needs_clarification");
    expect(assessment.blocking.map((entry) => entry.id)).toEqual(["buyback-timing"]);
  });

  it("refuses outright only when it cannot offer an alternative", () => {
    const withAlternative = {
      ...cnpy(),
      unsupported: [
        {
          request: "run exactly at noon with nobody touching it",
          reason: "a contract cannot wake itself up",
          suggestion: "settle on the first trade after noon",
        },
      ],
    };
    expect(assess(withAlternative).status).not.toBe("impossible");

    const without = {
      ...cnpy(),
      unsupported: [{ request: "read the weather", reason: "no oracle is configured" }],
    };
    expect(assess(without).status).toBe("impossible");
  });

  it("asks for confirmation rather than refusing when the economics are extreme", () => {
    // 90% on a sell is a strange market, not an illegitimate one. Agen builds it, but
    // not silently — see the note on maxFeePpm.
    const spec = { ...cnpy(), maxFeePpm: 900_000 };
    const assessment = assess(spec);

    expect(assessment.status).toBe("unsafe_without_change");
    expect(assessment.concerns.join(" ")).toMatch(/90\.00%/);
  });

  it("discloses an external dependency as a concern rather than a blocker", () => {
    const spec = {
      ...cnpy(),
      externalDependencies: [
        {
          kind: "priceOracle",
          description: "ETH/USD for the volume milestone",
          failureBehaviour: "the milestone does not fire and the fee stays where it is",
        },
      ],
    };

    const assessment = assess(spec);
    expect(assessment.status).toBe("unsafe_without_change");
    expect(assessment.concerns.join(" ")).toMatch(/priceOracle/);
  });

  it("turns an answer into an assumption and removes the question", () => {
    const spec = { ...cnpy(), ambiguities: [hard("buyback-timing")] };
    const answered = resolveAmbiguity(spec, "buyback-timing", "1% of pool liquidity");

    expect(assess(answered).status).toBe("ready");
    expect(answered.ambiguities).toHaveLength(0);

    // The answer survives as the same shape every other resolved decision has, so the
    // review screen shows it and the generated tests can be held against it.
    const recorded = answered.assumptions.find((entry) => entry.id === "answered-buyback-timing");
    expect(recorded?.interpretation).toBe("1% of pool liquidity");
    expect(recorded?.importance).toBe("high");

    // And it is settled, not merely recorded. A high-importance reading is promoted back
    // into a question on every pass, so an answer that did not mark itself confirmed
    // would be asked again on the next turn, for ever.
    expect(promoteForConfirmation(answered).ambiguities).toEqual([]);

    // A deployed market pins exactly one specification, and this is not the same one.
    expect(answered.version).toBe(spec.version + 1);
  });

  it("lets a creator who does not care take the default", () => {
    const spec = { ...cnpy(), ambiguities: [hard("buyback-timing")] };
    const answered = acceptDefault(spec, "buyback-timing");

    expect(assess(answered).status).toBe("ready");
    expect(answered.assumptions.at(-1)?.interpretation).toBe(
      "Accumulate and execute on the first buy after each 10-minute interval.",
    );
  });

  it("ignores an answer to a question that was not asked", () => {
    const spec = cnpy();
    expect(resolveAmbiguity(spec, "no-such-question", "yes")).toBe(spec);
  });

  it("answers one question at a time without disturbing the others", () => {
    const spec = { ...cnpy(), ambiguities: [hard("first"), hard("second")] };
    const answered = resolveAmbiguity(spec, "first", "immediately");

    expect(assess(answered).status).toBe("needs_clarification");
    expect(answered.ambiguities.map((entry) => entry.id)).toEqual(["second"]);
  });
});

// --- assumptions and suggestions --------------------------------------------
//
// Four markets, written out as the interpreter would produce them, small enough to read
// in one screen. They are the prompts the loop is judged on: the first two are cases
// where Agen should decide for itself, the third is a case where it must not, and the
// fourth is a market with nothing to say about it — which is the answer that is hardest
// to get out of a model and the most important one to preserve.

/** Everything a specification needs, so a fixture can say only what makes it different. */
function market(over: Partial<MarketSpecification>): MarketSpecification {
  return {
    version: 1,
    name: "Test",
    symbol: "TEST",
    summary: "A market",
    baseFeePpm: 3_000,
    maxFeePpm: 30_000,
    phases: [],
    state: [],
    rules: [],
    invariants: [],
    externalDependencies: [],
    assumptions: [],
    ambiguities: [],
    suggestions: [],
    unsupported: [],
    ...over,
  };
}

/** A: "Charge 1% on sells." */
function sellFee(): MarketSpecification {
  return market({
    name: "Shield",
    symbol: "SHLD",
    summary: "Sells pay an extra 1%",
    rules: [
      {
        id: "sell-fee",
        title: "SELL FEE",
        when: { kind: "sell", description: "Somebody sells into the pool" },
        conditions: [],
        then: [
          { kind: "extraFee", description: "Charge 1% on the sell", parameters: { feePpm: 10_000 } },
        ],
      },
    ],
    assumptions: [
      {
        id: "buys-free",
        term: "buys",
        interpretation: "Buys pay no hook fee, only the base LP fee",
        why: "You asked about sells and said nothing about buys.",
        importance: "low",
      },
    ],
  });
}

/** B: "Every 100th trade wins all accumulated fees." */
function jackpot(): MarketSpecification {
  return market({
    name: "Century",
    symbol: "CENT",
    summary: "Every 100th trade takes the pot",
    state: [
      { name: "tradeCount", type: "counter", description: "Trades since launch", initial: 0 },
      { name: "pot", type: "accumulator", description: "Fees waiting to be won" },
    ],
    rules: [
      {
        id: "jackpot",
        title: "JACKPOT",
        when: { kind: "swap", description: "Any trade" },
        conditions: [
          {
            kind: "rollingCount",
            description: "This is the hundredth trade",
            parameters: { state: "tradeCount", every: 100 },
          },
        ],
        then: [
          {
            kind: "rewardWallet",
            description: "Pay the whole pot to the trader",
            parameters: { share: 100 },
            writes: ["pot"],
          },
        ],
      },
    ],
    suggestions: [
      {
        id: "roll-forward",
        title: "Roll part of the jackpot forward",
        reason:
          "Paying the entire pot at trade 100 leaves nothing to play for at trade 101, so " +
          "the incentive resets completely each round.",
        proposedChange: "Pay out 80% of the pot and carry the remaining 20% into the next round.",
        category: "economics",
      },
    ],
  });
}

/** C: "Every large sell triggers a buyback." */
function buyback(): MarketSpecification {
  return market({
    name: "Rebound",
    symbol: "RBND",
    summary: "Large sells are met with a buyback",
    state: [{ name: "reserve", type: "accumulator", description: "Quote held for buybacks" }],
    rules: [
      {
        id: "buyback",
        title: "BUYBACK",
        when: { kind: "sell", description: "Somebody sells into the pool" },
        conditions: [
          {
            kind: "tradeSizeVsLiquidity",
            description: "The sell is large relative to the pool",
            parameters: { percent: 1 },
          },
        ],
        then: [{ kind: "buyback", description: "Spend the reserve buying back", writes: ["reserve"] }],
      },
    ],
    assumptions: [
      {
        id: "large-sell",
        term: "large sell",
        interpretation: "A sell worth more than 1% of the pool's liquidity",
        why: "You said large without saying large compared to what.",
        importance: "high",
      },
    ],
  });
}

/** D: "After 10 consecutive buys, make the next trade free. A sell resets the streak." */
function streak(): MarketSpecification {
  return market({
    name: "Run",
    symbol: "RUN",
    summary: "Ten buys in a row and the next trade is free",
    state: [{ name: "buyStreak", type: "counter", description: "Buys since the last sell", initial: 0 }],
    rules: [
      {
        id: "free-trade",
        title: "FREE TRADE",
        when: { kind: "buy", description: "Somebody buys" },
        conditions: [
          {
            kind: "consecutiveCount",
            description: "Ten buys with no sell between them",
            parameters: { state: "buyStreak", operator: ">=", value: 10 },
          },
        ],
        then: [
          { kind: "waiveFee", description: "This trade pays no hook fee" },
          {
            kind: "resetCounter",
            description: "Start the streak again",
            parameters: { state: "buyStreak" },
            writes: ["buyStreak"],
          },
        ],
      },
    ],
    assumptions: [
      {
        id: "streak-resets",
        term: "the streak",
        interpretation: "The counter returns to zero after the free trade is taken",
        why: "You said the next trade, singular.",
        importance: "low",
      },
    ],
  });
}

describe("deciding for the creator, and deciding not to", () => {
  it("asks nothing about a market that only left the obvious unsaid", () => {
    // "Charge 1% on sells" is not ambiguous. Asking whether buys should pay too is not
    // diligence, it is an interview with a foregone conclusion.
    const spec = sellFee();

    expect(validateSpecification(spec)).toEqual([]);
    expect(assess(spec).status).toBe("ready");
    expect(promoteForConfirmation(spec).ambiguities).toEqual([]);
  });

  it("records the low-risk reading instead, where it can be seen", () => {
    const assumed = sellFee().assumptions[0]!;

    expect(assumed.interpretation).toContain("no hook fee");
    // Stated rather than implied: a reading whose origin cannot be given is a guess.
    expect(assumed.why).not.toBe("");
    expect(assumed.importance).toBe("low");
  });

  it("turns a reading the economics depend on into a question rather than keeping it", () => {
    // What "large" means decides whether the buyback fires on every trade or on none,
    // and there is no defensible default — so Agen may not simply pick one, whichever
    // field the interpreter happened to file it under.
    const asked = promoteForConfirmation(buyback());

    expect(assess(asked).status).toBe("needs_clarification");
    expect(asked.assumptions).toEqual([]);

    const question = asked.ambiguities[0]!;
    expect(question.blocking).toBe(true);
    expect(question.question).toContain("large sell");
    // Still answerable by shrugging: the reading Agen took becomes the default, so a
    // creator who does not care is never stranded.
    expect(question.otherwise).toBe("A sell worth more than 1% of the pool's liquidity");
  });

  it("leaves a market alone when it has nothing worth saying about it", () => {
    // The answer that is hardest to get out of a model. A market this clear should
    // produce no questions, no suggestions, and one reading nobody needs to look at.
    const spec = streak();

    expect(assess(spec).status).toBe("ready");
    expect(spec.suggestions).toEqual([]);
    expect(materialAssumptions(spec)).toEqual([]);
    expect(promoteForConfirmation(spec)).toBe(spec);
  });

  it("accepts an interpretation that found nothing to say at all", () => {
    const silent = market({ rules: sellFee().rules });

    expect(validateSpecification(silent)).toEqual([]);
    expect(assess(silent).status).toBe("ready");
    expect(openSuggestions(silent)).toEqual([]);
  });
});

describe("suggestions", () => {
  it("does not change the market by existing", () => {
    // The property that makes an observation safe to offer: until it is accepted it is
    // inert. The creator asked for the whole pot to be paid out and that is still what
    // this market does, the build is not held up, and the version a deployment pins has
    // not moved.
    const offered = jackpot();

    expect(assess(offered).status).toBe("ready");
    expect(offered.version).toBe(1);
    expect(offered.rules[0]!.then[0]!.parameters).toEqual({ share: 100 });
    expect(acceptedSuggestions(offered)).toEqual([]);
  });

  it("changes the specification once it is accepted", () => {
    const spec = jackpot();
    const accepted = acceptSuggestion(spec, "roll-forward");

    expect(accepted.version).toBe(spec.version + 1);
    expect(openSuggestions(accepted)).toEqual([]);
    expect(acceptedSuggestions(accepted)).toEqual([
      "Pay out 80% of the pot and carry the remaining 20% into the next round.",
    ]);
  });

  it("takes the creator's wording when they edit it before accepting", () => {
    const accepted = acceptSuggestion(jackpot(), "roll-forward", "Carry half the pot forward.");
    expect(acceptedSuggestions(accepted)).toEqual(["Carry half the pot forward."]);
  });

  it("leaves the market exactly as it was when one is turned down", () => {
    const spec = jackpot();
    const declined = declineSuggestion(spec, "roll-forward");

    // Nothing was applied, so nothing can be unapplied: not the rules, not the fees, and
    // not the version, which is what a deployment pins.
    expect(declined.version).toBe(spec.version);
    expect(declined.rules).toEqual(spec.rules);
    expect(declined.baseFeePpm).toBe(spec.baseFeePpm);
    expect(acceptedSuggestions(declined)).toEqual([]);

    // Remembered rather than deleted, so the next turn does not offer it again.
    expect(openSuggestions(declined)).toEqual([]);
    expect(declined.suggestions[0]!.decision).toBe("declined");
  });
});

describe("assumptions the creator has looked at", () => {
  it("stops asking once a reading is agreed to, without changing the market", () => {
    const spec = buyback();
    const agreed = confirmAssumption(spec, "large-sell");

    expect(agreed.version).toBe(spec.version);
    expect(promoteForConfirmation(agreed).ambiguities).toEqual([]);
    expect(assess(agreed).status).toBe("ready");
  });

  it("changes the market when a reading is overridden", () => {
    const spec = buyback();
    const corrected = overrideAssumption(spec, "large-sell", "A sell of more than 5 ETH");

    expect(corrected.version).toBe(spec.version + 1);

    const reading = corrected.assumptions[0]!;
    expect(reading.interpretation).toBe("A sell of more than 5 ETH");
    expect(reading.confirmed).toBe(true);

    // And it is not asked about again, having just been settled by the person who would
    // have been asked.
    expect(promoteForConfirmation(corrected).ambiguities).toEqual([]);
  });

  it("drops parameters derived from the reading that was replaced", () => {
    // The prose and the number have to agree, and the number is the half that reaches a
    // contract. Keeping "percent: 1" beside "more than 5 ETH" is worse than keeping
    // nothing, because something downstream will compute with it.
    const spec = market({
      assumptions: [
        {
          id: "large-sell",
          term: "large sell",
          interpretation: "More than 1% of liquidity",
          why: "You said large.",
          parameters: { percent: 1 },
          importance: "medium",
        },
      ],
    });

    const corrected = overrideAssumption(spec, "large-sell", "More than 5 ETH");
    expect(corrected.assumptions[0]!.parameters).toBeUndefined();
  });

  it("ignores a decision about something that is not there", () => {
    const spec = buyback();

    expect(confirmAssumption(spec, "nothing")).toBe(spec);
    expect(overrideAssumption(spec, "nothing", "anything")).toBe(spec);
    expect(acceptSuggestion(spec, "nothing")).toBe(spec);
    expect(declineSuggestion(spec, "nothing")).toBe(spec);
    // An empty override is a form submitted by accident, not an instruction to erase the
    // reading Agen took.
    expect(overrideAssumption(spec, "large-sell", "   ")).toBe(spec);
  });
});

describe("a conversation, rather than a form", () => {
  it("carries every earlier decision through the turns that follow", () => {
    // Four turns against one specification: a question answered, a reading corrected, an
    // improvement taken and another declined. What is being tested is that turn four
    // still holds what turn one settled — the specification is the memory, and if it is
    // not, then the conversation is.
    const start: MarketSpecification = {
      ...jackpot(),
      assumptions: [...buyback().assumptions],
      ambiguities: [
        {
          id: "pot-source",
          question: "Which fees go into the pot?",
          why: "It decides how fast the pot grows and who is paying for it.",
          otherwise: "Every hook fee, from buys and sells alike.",
          blocking: true,
        },
      ],
      suggestions: [
        ...jackpot().suggestions,
        {
          id: "cap-the-pot",
          title: "Cap the pot",
          reason: "An uncapped pot invites a wallet to wait for trade 99.",
          proposedChange: "Stop growing the pot once it reaches 10 ETH.",
          category: "economics",
        },
      ],
    };

    expect(assess(start).status).toBe("needs_clarification");

    const settled = decideAll(start, [
      { kind: "answer", id: "pot-source", answer: "Only the fees paid by sells." },
      { kind: "override", id: "large-sell", interpretation: "A sell of more than 5 ETH" },
      { kind: "accept", id: "roll-forward" },
      { kind: "decline", id: "cap-the-pot" },
    ]);

    // Nothing is outstanding, and nothing needs asking again.
    expect(assess(settled).status).toBe("ready");
    expect(promoteForConfirmation(settled).ambiguities).toEqual([]);
    expect(openSuggestions(settled)).toEqual([]);

    // Every decision is still legible, which is what "what did I actually agree to"
    // needs an answer from.
    const answered = settled.assumptions.find((entry) => entry.id === "answered-pot-source");
    expect(answered?.interpretation).toBe("Only the fees paid by sells.");
    expect(settled.assumptions.find((entry) => entry.id === "large-sell")?.interpretation).toBe(
      "A sell of more than 5 ETH",
    );
    expect(acceptedSuggestions(settled)).toEqual([
      "Pay out 80% of the pot and carry the remaining 20% into the next round.",
    ]);

    // A fifth turn about something else leaves all four alone.
    const later = decideAll(settled, [{ kind: "decline", id: "roll-forward" }]);
    expect(later.assumptions.map((entry) => entry.id)).toEqual(
      settled.assumptions.map((entry) => entry.id),
    );

    // Three of the four decisions changed what would be built, and each one moved the
    // version exactly once.
    expect(settled.version).toBe(start.version + 3);
  });

  it("still validates after every decision has been folded in", () => {
    const settled = decideAll(buyback(), [
      { kind: "override", id: "large-sell", interpretation: "A sell of more than 5 ETH" },
    ]);

    expect(validateSpecification(settled)).toEqual([]);
  });
});

describe("keeping the rules level with the decisions", () => {
  /** A market whose rules are up to date with everything decided about it. */
  function current(): MarketSpecification {
    return { ...jackpot(), rulesDerivedAtVersion: 1 };
  }

  it("knows the rules are current until something changes the market", () => {
    expect(rulesAreStale(current())).toBe(false);

    // Neither of these changes what would be built, so neither puts the rules behind.
    expect(rulesAreStale(declineSuggestion(current(), "roll-forward"))).toBe(false);
    expect(rulesAreStale(confirmAssumption(current(), "nothing"))).toBe(false);
  });

  it("knows the rules are behind as soon as one is accepted", () => {
    const accepted = acceptSuggestion(current(), "roll-forward");

    expect(rulesAreStale(accepted)).toBe(true);
    expect(outstanding(accepted).accepted).toEqual([
      "Pay out 80% of the pot and carry the remaining 20% into the next round.",
    ]);
  });

  it("asks for nothing when the rules are already level", () => {
    // Not merely empty — the question is not asked at all. A build resumed for an
    // unrelated reason must not pay for a revision it does not need.
    expect(outstanding(current())).toEqual({ accepted: [], settled: [], edits: [] });
  });

  it("does not hand the same change to a second revision", () => {
    // The failure this prevents is arithmetic: a change applied twice takes 20% of the
    // pot forward and then 20% of what is left, which is not what anybody agreed to.
    const derived = derivedNow(acceptSuggestion(current(), "roll-forward"));

    expect(rulesAreStale(derived)).toBe(false);
    expect(outstanding(derived).accepted).toEqual([]);
    expect(derived.suggestions[0]!.applied).toBe(true);

    // And the record survives being applied: the creator can still see what they took.
    expect(acceptedSuggestions(derived)).toHaveLength(1);
  });

  it("carries only the newest decision into the next revision", () => {
    const settled = derivedNow(acceptSuggestion(current(), "roll-forward"));

    const later = acceptSuggestion(
      {
        ...settled,
        suggestions: [
          ...settled.suggestions,
          {
            id: "cap-the-pot",
            title: "Cap the pot",
            reason: "An uncapped pot invites a wallet to wait for trade 99.",
            proposedChange: "Stop growing the pot once it reaches 10 ETH.",
            category: "economics",
          },
        ],
      },
      "cap-the-pot",
    );

    // Turn two is told about turn two. Re-litigating turn one is how an agreement made
    // earlier quietly comes undone.
    expect(outstanding(later).accepted).toEqual(["Stop growing the pot once it reaches 10 ETH."]);
  });

  it("stops resending a reading once the rules honour it", () => {
    // A live three-turn conversation is what found this. Settled readings were sent to
    // every later revision, so turn three arrived carrying turn two's agreement and was
    // invited to reconsider it while implementing something else.
    const corrected = overrideAssumption(
      { ...current(), assumptions: buyback().assumptions },
      "large-sell",
      "A sell of more than 5 ETH",
    );

    expect(outstanding(corrected).settled.map((entry) => entry.interpretation)).toEqual([
      "A sell of more than 5 ETH",
    ]);

    const derived = derivedNow(corrected);
    expect(outstanding(derived).settled).toEqual([]);

    // Still on the record, still visible to the creator — just not sent again.
    expect(derived.assumptions[0]!.interpretation).toBe("A sell of more than 5 ETH");
  });

  it("takes a change asked for in the creator's own words", () => {
    // The decision a creator reaches for most after reading their market, and the only
    // one that is not about something Agen raised.
    const asked = requestEdit(current(), "Make the sell fee 1% instead");

    expect(asked.version).toBe(current().version + 1);
    expect(rulesAreStale(asked)).toBe(true);
    expect(outstanding(asked).edits).toEqual(["Make the sell fee 1% instead"]);

    // Recorded under a stable id, so an interface can refer to it and a person reading
    // the record can see the order they asked for things in.
    expect(asked.edits?.[0]?.id).toBe("edit-1");
    expect(requestEdit(asked, "And make the timer 30 minutes").edits?.[1]?.id).toBe("edit-2");
  });

  it("ignores an empty edit rather than bumping the version for nothing", () => {
    const spec = current();
    expect(requestEdit(spec, "   ")).toBe(spec);
  });

  it("stops resending an edit once the rules have made it", () => {
    const derived = derivedNow(requestEdit(current(), "Make the sell fee 1% instead"));

    expect(outstanding(derived).edits).toEqual([]);
    expect(rulesAreStale(derived)).toBe(false);

    // Still on the record: "what did I change" has an answer after four rounds of edits.
    expect(derived.edits?.[0]?.instruction).toBe("Make the sell fee 1% instead");
  });

  it("reads a specification written before any of this as current", () => {
    const { rulesDerivedAtVersion: absent, ...old } = current();
    void absent;

    expect(rulesAreStale(old)).toBe(false);
  });
});

describe("what a suggestion has to carry", () => {
  it("rejects one nobody could act on", () => {
    const vague: Suggestion = {
      id: "vague",
      title: "Consider making the token engaging",
      reason: "Engagement is good",
      proposedChange: "  ",
      category: "ux",
    };

    const problems = validateSpecification(market({ suggestions: [vague] }));
    expect(problems.some((problem) => problem.path === "suggestions[0].proposedChange")).toBe(true);
  });

  it("rejects a category the interface could not file", () => {
    const problems = validateSpecification(
      market({
        suggestions: [
          {
            ...jackpot().suggestions[0]!,
            category: "vibes" as Suggestion["category"],
          },
        ],
      }),
    );

    expect(problems.some((problem) => problem.path === "suggestions[0].category")).toBe(true);
  });

  it("rejects two suggestions sharing an id, which a decision could not tell apart", () => {
    const one = jackpot().suggestions[0]!;
    const problems = validateSpecification(market({ suggestions: [one, { ...one }] }));

    expect(problems.some((problem) => problem.path === "suggestions[1].id")).toBe(true);
  });
});

describe("assumptions a stored specification predates", () => {
  it("shows a reading that has no importance rather than hiding it", () => {
    // Specifications are persisted as JSON and read back. One written before importance
    // existed has no such field, and the safe direction to be wrong in is showing the
    // creator one reading too many.
    const old = market({
      assumptions: [
        { id: "old", term: "whale", interpretation: "1% of supply", why: "" } as Assumption,
      ],
    });

    expect(materialAssumptions(old)).toHaveLength(1);
  });
});
