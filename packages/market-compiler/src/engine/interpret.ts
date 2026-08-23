/**
 * Engine v1's only model call.
 *
 * One call, one schema, one answer. Engine 0 makes between six and a dozen — behaviours,
 * batched rules, effect repairs, a frame, a critique, an architecture match, a design, a
 * contract per component, a test suite, and however many repairs each of those needs. Every
 * one of them was a chance for the market to drift from the prompt, and most of them existed
 * to recover from the ones before.
 *
 * Here the model is asked for a configuration and nothing else. It cannot write Solidity,
 * cannot name a rule kind, cannot invent a field, and cannot decide whether its own answer
 * is acceptable — `resolve` in `@verdant/market-engine` re-derives that from the
 * configuration itself.
 *
 * ## The schema is the prompt
 *
 * Most of the instruction below is not describing a task, it is describing a vocabulary: the
 * closed set of things engine v1 can express, and the requirement that anything outside it be
 * named rather than approximated. That is deliberate. A model told "produce a market" invents
 * structure; a model told "here are eleven fields and here is what to do when the prompt
 * needs a twelfth" reports the twelfth.
 */

import { MAX_FEE_PPM, MAX_RECIPIENTS, MAX_STAGES, MAX_TIERS_PER_SIDE, formatPercent } from "@verdant/market-engine";

import type { JsonSchema, ModelProvider } from "./../model.js";

/** The envelope shape the model must answer in. Closed, and `additionalProperties: false`. */
export const ENVELOPE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "spec", "unsupported", "clarifications", "assumptions"],
  properties: {
    outcome: { type: "string", enum: ["SUPPORTED", "NEEDS_CLARIFICATION", "UNSUPPORTED"] },
    spec: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["engineVersion", "baseRate", "ladder", "sizeTiers", "distribution", "protections"],
          properties: {
            engineVersion: { type: "integer", enum: [1] },
            baseRate: {
              type: "object",
              additionalProperties: false,
              required: ["buy", "sell"],
              properties: { buy: { type: "string" }, sell: { type: "string" } },
            },
            ladder: {
              anyOf: [
                { type: "null" },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["axis", "stages"],
                  properties: {
                    axis: { type: "string", enum: ["TIME", "QUOTE_VOLUME"] },
                    /*
                     * Both axes' fields are present and both are required, with the unused one
                     * nulled rather than omitted.
                     *
                     * A stage is one axis or the other, so the natural schema lists both
                     * properties and requires neither. That is valid JSON Schema and it is
                     * rejected by OpenAI's structured outputs, which insists `required` name
                     * every key in `properties`. The whole request comes back 400, which is
                     * why this had never worked there — and OpenAI is the failover, so the
                     * engine had one vendor and a spare that could not answer.
                     *
                     * Nullable-and-required is the shape that satisfies both: the model fills
                     * the field its axis uses and sends `null` for the other. `parse.ts`
                     * already treats a null the same as an absent field, because a discriminated
                     * union is decided by `axis`, so nothing downstream changes.
                     */
                    stages: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["afterSeconds", "afterQuoteAmount", "rate"],
                        properties: {
                          afterSeconds: { type: ["integer", "null"] },
                          afterQuoteAmount: { type: ["string", "null"] },
                          rate: {
                            type: "object",
                            additionalProperties: false,
                            required: ["buy", "sell"],
                            properties: { buy: { type: "string" }, sell: { type: "string" } },
                          },
                        },
                      },
                    },
                  },
                },
              ],
            },
            sizeTiers: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["side", "measure", "rate"],
                properties: {
                  side: { type: "string", enum: ["BUY", "SELL"] },
                  /*
                   * Percentages only, and `percent` required.
                   *
                   * `ABSOLUTE_TOKENS` exists in the canonical schema and the compiler reads it
                   * as base units, which is the right unit for a machine and a trap for a
                   * model: the instructions never named a unit, so a model writing a million
                   * tokens as "1000000" would have produced a threshold of 10^-12 of a token
                   * — a tier firing on every trade in the market, describing itself on the
                   * review screen as "0% of supply". Nothing rejected it, because it is a
                   * perfectly valid threshold; it simply was not the one anyone asked for.
                   *
                   * So the model cannot reach for it. It is given the supply instead and
                   * converts, which is arithmetic it can check and a percentage the compiler
                   * resolves back to the amount the creator named.
                   */
                  measure: {
                    type: "object",
                    additionalProperties: false,
                    required: ["kind", "percent", "operator"],
                    properties: {
                      kind: { type: "string", enum: ["PERCENT_REFERENCE_SUPPLY"] },
                      percent: { type: "string" },
                      operator: { type: "string", enum: ["GT", "GTE"] },
                    },
                  },
                  rate: { type: "string" },
                },
              },
            },
            distribution: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["recipient", "share"],
                properties: {
                  /*
                   * `address` is required and nullable, for the reason given on the ladder's
                   * stages: OpenAI's strict mode forbids optional fields outright. CREATOR and
                   * TREASURY send null; only ADDRESS carries one.
                   *
                   * The parser refuses a null address on an ADDRESS recipient exactly as it
                   * refuses a missing one, so nothing about validation is loosened — an
                   * unnamed destination is still an unnamed destination.
                   */
                  recipient: {
                    type: "object",
                    additionalProperties: false,
                    required: ["kind", "address"],
                    properties: {
                      kind: { type: "string", enum: ["CREATOR", "TREASURY", "ADDRESS"] },
                      address: { type: ["string", "null"] },
                    },
                  },
                  share: { type: "string" },
                },
              },
            },
            protections: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["kind", "side", "amount"],
                properties: {
                  kind: { type: "string", enum: ["MAX_TRADE_SIZE"] },
                  side: { type: "string", enum: ["BUY", "SELL", "BOTH"] },
                  // Percentages only, for the reason given on `measure` above.
                  amount: {
                    type: "object",
                    additionalProperties: false,
                    required: ["kind", "percent"],
                    properties: {
                      kind: { type: "string", enum: ["PERCENT_REFERENCE_SUPPLY"] },
                      percent: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    },
    unsupported: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["request", "why"],
        properties: { request: { type: "string" }, why: { type: "string" } },
      },
    },
    clarifications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "question", "because"],
        properties: { id: { type: "string" }, question: { type: "string" }, because: { type: "string" } },
      },
    },
    assumptions: { type: "array", items: { type: "string" } },
  },
};

/**
 * What engine v1 cannot express, named so the model reports rather than approximates.
 *
 * Every entry here is a real request a creator has made, and the reason it is refused is a
 * property of the engine rather than of the prompt. A model that quietly dropped one would
 * produce a market missing a requirement its creator asked for and believed they had.
 */
const UNSUPPORTED_MECHANICS = [
  "anything about a specific wallet or trader — cooldowns, per-wallet limits, per-wallet " +
    "rates, first-buyer discounts. Uniswap reports the router rather than the person, so a " +
    "rule like this binds trades routed through Agen and is bypassed by a direct swap.",
  "anything that depends on the sequence of earlier trades — consecutive-buy streaks, " +
    "'every tenth trade', 'if the last trade was a sell'. The engine decides a rate from " +
    "trade size, elapsed time and cumulative volume, never from history.",
  "burning fees, buying back the token with fees, or paying fees to liquidity providers as " +
    "an incentive. The engine credits recipients and never swaps or destroys.",
  "a size tier that is only live during part of the market's life. Tiers apply at all times.",
  "dollar-denominated anything. There is no price feed on this chain, so a volume threshold " +
    "has to be stated in the quote asset.",
  "both a time ladder and a volume ladder in one market. One axis per market.",
] as const;

export interface InterpretRequest {
  readonly prompt: string;
  readonly name: string;
  readonly symbol: string;
  /** `ETH`, `NVDA` — so the model can denominate a volume threshold correctly. */
  readonly quoteAssetSymbol: string;
  /** Whether that quote asset is native Robinhood Chain ETH. */
  readonly quoteIsNative: boolean;
  /**
   * The launched token's whole supply, in whole tokens.
   *
   * Supplied so that a creator writing "sells over a million tokens" gets the tier they asked
   * for. Every size threshold the engine measures is a share of this number, and without it
   * the model could not convert a token count into one — so a common, completely expressible
   * request had no way through, and the schema's absolute-token escape hatch was a trap: its
   * units were never stated, so a model reaching for it would have written a threshold twelve
   * orders of magnitude below what it meant.
   */
  readonly referenceSupplyTokens: bigint;
  /** What the creator answered, when this is a second attempt after a clarification. */
  readonly answers?: readonly { readonly id: string; readonly answer: string }[];
  readonly timeoutMs?: number;
}

/** A whole number with thousands separators, so a supply reads as a quantity. */
function grouped(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * A token count as a share of supply, to four decimal places, for the worked example.
 *
 * Worked rather than described because an instruction to convert is easy to acknowledge and
 * easy to get wrong by a factor of a hundred. Showing the model this market's own arithmetic
 * gives it the magnitude to check itself against.
 */
function sharePercent(tokens: bigint, supply: bigint): string {
  if (supply <= 0n) return "0";

  const ppm = (tokens * 1_000_000n) / supply;
  return formatPercent(Number(ppm)).replace("%", "");
}

function instructions(request: InterpretRequest): string {
  const quote = request.quoteIsNative
    ? `native ETH on Robinhood Chain (referred to as ETH; it is not WETH and not a token)`
    : request.quoteAssetSymbol;

  return [
    "Read a creator's description of a programmable market and return its economics as a " +
      "configuration. You are not writing code and there is no code to write: Agen has one " +
      "audited Uniswap v4 hook that executes configurations, and your answer is the " +
      "configuration it will execute.",
    "",
    "## The three answers",
    "",
    "SUPPORTED — every economic requirement in the prompt fits the fields below. Attach the " +
      "specification.",
    "",
    "NEEDS_CLARIFICATION — the prompt describes something the engine can do but leaves out a " +
      "number it depends on. 'Charge more on large sells' is this: 'large' is not a size and " +
      "'more' is not a rate. Ask one question per missing thing, quote the creator's own words " +
      "in `because`, and attach no specification. Never choose the number yourself.",
    "",
    "Only a missing **number** is a clarification. A wording you have to interpret is not: if " +
      "the prompt says a thing and you have to decide what it means, decide. Asking a creator " +
      "to restate something they already wrote is worse than a wrong reading, because it reads " +
      "as not having been read at all — and every question costs them a round trip.",
    "",
    "UNSUPPORTED — the prompt asks for a mechanic the engine does not have. List each one in " +
      "`unsupported`, quoting the creator's words in `request` and saying plainly why in `why`. " +
      "Attach no specification.",
    "",
    "If part of a prompt is unsupported, the whole market is unsupported. Do not return a " +
      "specification for the rest: a market missing a requirement its creator asked for is not " +
      "a smaller version of what they wanted, it is a different market they did not agree to.",
    "",
    "## What the engine cannot do",
    "",
    ...UNSUPPORTED_MECHANICS.map((entry) => `  - ${entry}`),
    "",
    "## Units",
    "",
    "Every rate and share is a decimal percentage written as a string, exactly as a person " +
      `writes it: "2", "0.5", "1.25". Never a number, never with a percent sign. The finest ` +
      `rate is "0.0001" and the highest is "${formatPercent(MAX_FEE_PPM)}".`,
    "",
    "Shares of the collected fee must total exactly 100. If the creator did not say where fees " +
      "go, use one share of 100 to CREATOR and record that in `assumptions` — the review screen " +
      "shows it, so an assumption is disclosed rather than hidden.",
    "",
    `A volume threshold is an amount of ${quote}, in its smallest unit, as a decimal string. ` +
      "Eighteen decimals, so one whole unit is \"1000000000000000000\". If the creator gave a " +
      "dollar figure, that is NEEDS_CLARIFICATION — there is no price feed to convert it.",
    "",
    "A size threshold is a share of the launched token's fixed supply, measured on the token " +
      "leg of the trade. Always `PERCENT_REFERENCE_SUPPLY`, with a percentage.",
    "",
    `This market's supply is ${grouped(request.referenceSupplyTokens)} ${request.symbol}. If ` +
      "the creator stated a size in tokens rather than a percentage, convert it: a threshold " +
      `of 1,000,000 ${request.symbol} is ` +
      `"${sharePercent(1_000_000n, request.referenceSupplyTokens)}". Convert exactly and do ` +
      "not round to something tidier — the number you write is the number the market compares " +
      "against. If the conversion needs more than four decimal places to be exact, that size " +
      "cannot be expressed and the answer is UNSUPPORTED.",
    "",
    "## Choosing the operator is reading, not asking",
    "",
    "**The operator is never a clarification.** It is a reading of the words the creator " +
      "already used, and you must choose one. A prompt that names a size and a rate has " +
      "specified its tier completely; asking which comparison was meant tells a creator you " +
      "did not read the sentence they wrote.",
    "",
    "  - `GTE` — 'at least', 'or more', 'or above', 'from', 'minimum of', '>=', and any " +
      "sentence saying that a trade **of** that size pays the rate. 'A sell of exactly 1% " +
      "must pay 4%' is `GTE`: the 1% trade is stated to pay 4%, so the threshold includes it. " +
      "So is 'a sell of 1% pays 4%'.",
    "  - `GT` — 'more than', 'over', 'above', 'greater than', 'larger than', 'bigger than', " +
      "'exceeds', 'beyond', '>'.",
    "",
    "When the wording genuinely fits neither list — a bare 'sells of 1% supply pay 4%' with no " +
      "comparison word at all — choose `GTE`. It is the reading that admits the trade the " +
      "creator named, which is what somebody writing that sentence means.",
    "",
    "The only thing that makes a size tier NEEDS_CLARIFICATION is a missing **number**: no " +
      "size ('large sells'), or no rate ('pay more'). Never the comparison.",
    "",
    "## Structure",
    "",
    "`baseRate` is what a trade pays before any stage or tier. It is required: never omit it " +
      "and never default it. If the creator named no fee at all, use \"0.3\" and say so in " +
      "`assumptions` — that is what most Uniswap pools charge.",
    "",
    "`ladder` is how the base rate changes, along one axis: TIME, in seconds after launch, or " +
      "QUOTE_VOLUME, in cumulative quote. Give only the later stages; the base rate is the " +
      `opening one. At most ${String(MAX_STAGES - 1)} later stages, and time stages must be at ` +
      "least five minutes apart.",
    "",
    `\`sizeTiers\` are rates that replace the base for larger trades. At most ` +
      `${String(MAX_TIERS_PER_SIDE)} per side. A tier replaces the base rate — it is never ` +
      "added to it, so '4% instead' and '4%' are the same instruction and 'an additional 4%' " +
      "is a rate of base-plus-four that you should compute and state as one number.",
    "",
    `\`distribution\` has at most ${String(MAX_RECIPIENTS)} entries. CREATOR is whoever ` +
      "launches. TREASURY is Agen. ADDRESS is a specific address the creator gave.",
    "",
    "`protections` currently holds only MAX_TRADE_SIZE, a ceiling above which a trade reverts. " +
      "Only include one if the creator asked for a hard cap.",
    "",
    "## What not to do",
    "",
    "Do not add a mechanic the creator did not write. Do not add a pool fee, a default tier or " +
      "a protection nobody asked for. Do not invent a threshold, a rate, a recipient or a " +
      "duration. Do not return a field that is not in the schema — if you find yourself " +
      "wanting one, that is an UNSUPPORTED answer.",
  ].join("\n");
}

/**
 * Ask the model for one market.
 *
 * Returns the raw answer. Judging it is `resolve`'s job, in the engine package, which
 * re-derives the outcome from the configuration rather than believing the claim — so a
 * model that says SUPPORTED and attaches something the compiler refuses gets the
 * compiler's answer.
 */
export async function interpretForEngine(
  provider: ModelProvider,
  request: InterpretRequest,
): Promise<{ readonly answer: unknown; readonly raw: string }> {
  const answered = await provider.generate<unknown>({
    stage: "interpreting",
    instructions: instructions(request),
    input: [
      `Token name: ${request.name}`,
      `Token symbol: ${request.symbol}`,
      `Quote asset: ${request.quoteIsNative ? "native ETH on Robinhood Chain" : request.quoteAssetSymbol}`,
      "",
      "The creator wrote:",
      "```",
      request.prompt,
      "```",
      ...(request.answers === undefined || request.answers.length === 0
        ? []
        : [
            "",
            "They have since answered:",
            ...request.answers.map((entry) => `  - ${entry.id}: ${entry.answer}`),
          ]),
    ].join("\n"),
    schemaName: "agen_market_interpretation",
    schema: ENVELOPE_SCHEMA,
    // Three minutes, matching engine 0's interpretation budget. One call rather than a
    // dozen, so the whole stage costs about what one of theirs did.
    timeoutMs: request.timeoutMs ?? 180_000,
  });

  return { answer: answered.value, raw: answered.raw };
}
