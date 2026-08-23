/**
 * Emit the differential vectors that hold `AgenRuleLib.sol` to `evaluate.ts`.
 *
 * The mechanism `packages/sdk/scripts/generate-schedule-vectors.ts` established, applied to
 * the engine: the TypeScript is authoritative, the vectors are its answers, and Foundry
 * asserts the Solidity reproduces them exactly.
 *
 * Two things are proven at once, and the second is easy to miss. Each vector carries the
 * configuration as **ABI-encoded bytes** rather than as JSON fields, so a Solidity test that
 * can `abi.decode` them into `AgenRuleLib.Config` and reach the same answers has also
 * proven that `encode.ts` and `abi.encode` agree — which is what makes the commitment hash
 * verifiable on chain. Emitting the fields as JSON would have tested the evaluator and left
 * the encoding untested, and the encoding is the part a creator's signature commits to.
 *
 * Run with `pnpm --filter @verdant/market-engine vectors:emit`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Imported from `dist` rather than `src` because this runs under Node's type stripping,
// which resolves a `.js` specifier literally and will not compile a sibling `.ts` for it.
// `vectors:emit` builds the package first for exactly this reason.
import { compile } from "../dist/compile.js";
import { configHash, encodeConfig, implementationHash } from "../dist/encode.js";
import type { EngineIdentity } from "../dist/encode.js";
import { evaluate } from "../dist/evaluate.js";
import type { SwapContext } from "../dist/evaluate.js";
import { ETHER_QUOTE, EQUITY_QUOTE, REFERENCE_SUPPLY } from "../dist/fixtures.js";
import type { AgenMarketSpec, CanonicalConfig, MarketBinding, Side } from "../dist/spec.js";

const ONE_ETH = 10n ** 18n;
const ONE_PERCENT = REFERENCE_SUPPLY / 100n;
const TO_CREATOR = [{ recipient: { kind: "CREATOR" as const }, share: "100" }];

function spec(overrides: Partial<AgenMarketSpec>): AgenMarketSpec {
  return {
    engineVersion: 1,
    baseRate: { buy: "1", sell: "1" },
    ladder: null,
    sizeTiers: [],
    distribution: TO_CREATOR,
    protections: [],
    ...overrides,
  };
}

interface NamedSpec {
  readonly name: string;
  readonly spec: AgenMarketSpec;
  readonly binding: MarketBinding;
}

const ETHER: MarketBinding = { referenceSupply: REFERENCE_SUPPLY, quoteAsset: ETHER_QUOTE };
const EQUITY: MarketBinding = { referenceSupply: REFERENCE_SUPPLY, quoteAsset: EQUITY_QUOTE };

const SPECS: readonly NamedSpec[] = [
  { name: "flat 1% both ways", spec: spec({}), binding: ETHER },
  { name: "zero fee", spec: spec({ baseRate: { buy: "0", sell: "0" }, distribution: [] }), binding: ETHER },
  { name: "asymmetric 1% buy 2% sell", spec: spec({ baseRate: { buy: "1", sell: "2" } }), binding: ETHER },
  { name: "at the fee ceiling", spec: spec({ baseRate: { buy: "10", sell: "10" } }), binding: ETHER },
  {
    name: "one sell tier at 1% of supply",
    spec: spec({
      baseRate: { buy: "0.5", sell: "0.5" },
      sizeTiers: [
        { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" }, rate: "4" },
      ],
      distribution: [
        { recipient: { kind: "CREATOR" }, share: "80" },
        { recipient: { kind: "TREASURY" }, share: "20" },
      ],
    }),
    binding: ETHER,
  },
  {
    name: "exclusive sell tier",
    spec: spec({
      sizeTiers: [
        { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GT" }, rate: "4" },
      ],
    }),
    binding: ETHER,
  },
  {
    name: "four sell tiers",
    spec: spec({
      sizeTiers: [
        { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "0.5", operator: "GTE" }, rate: "2" },
        { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" }, rate: "3" },
        { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2", operator: "GTE" }, rate: "5" },
        { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "5", operator: "GTE" }, rate: "8" },
      ],
    }),
    binding: ETHER,
  },
  {
    name: "tiers on both sides",
    spec: spec({
      sizeTiers: [
        { side: "BUY", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" }, rate: "3" },
        { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2", operator: "GTE" }, rate: "6" },
      ],
    }),
    binding: ETHER,
  },
  {
    name: "descending tiers, a whale discount",
    spec: spec({
      sizeTiers: [
        { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "1", operator: "GTE" }, rate: "5" },
        { side: "SELL", measure: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2", operator: "GTE" }, rate: "2" },
      ],
    }),
    binding: ETHER,
  },
  {
    name: "two time stages",
    spec: spec({
      baseRate: { buy: "3", sell: "3" },
      ladder: {
        axis: "TIME",
        stages: [
          { afterSeconds: 3_600, rate: { buy: "2", sell: "2" } },
          { afterSeconds: 90_000, rate: { buy: "1", sell: "1" } },
        ],
      },
    }),
    binding: ETHER,
  },
  {
    name: "seven time stages",
    spec: spec({
      baseRate: { buy: "8", sell: "8" },
      ladder: {
        axis: "TIME",
        stages: Array.from({ length: 7 }, (_, index) => ({
          afterSeconds: (index + 1) * 3_600,
          rate: { buy: String(7 - index), sell: String(7 - index) },
        })),
      },
    }),
    binding: ETHER,
  },
  {
    name: "a volume ladder",
    spec: spec({
      baseRate: { buy: "2", sell: "2" },
      ladder: {
        axis: "QUOTE_VOLUME",
        stages: [{ afterQuoteAmount: (100n * ONE_ETH).toString(), rate: { buy: "1", sell: "1" } }],
      },
    }),
    binding: ETHER,
  },
  {
    name: "a ladder with asymmetric stages",
    spec: spec({
      baseRate: { buy: "1", sell: "4" },
      ladder: { axis: "TIME", stages: [{ afterSeconds: 3_600, rate: { buy: "0", sell: "2" } }] },
    }),
    binding: ETHER,
  },
  {
    name: "a ceiling on sells",
    spec: spec({
      protections: [
        { kind: "MAX_TRADE_SIZE", side: "SELL", amount: { kind: "PERCENT_REFERENCE_SUPPLY", percent: "2" } },
      ],
    }),
    binding: ETHER,
  },
  {
    name: "four recipients",
    spec: spec({
      distribution: [
        { recipient: { kind: "CREATOR" }, share: "40" },
        { recipient: { kind: "TREASURY" }, share: "30" },
        { recipient: { kind: "ADDRESS", address: "0x1111111111111111111111111111111111111111" }, share: "20" },
        { recipient: { kind: "ADDRESS", address: "0x2222222222222222222222222222222222222222" }, share: "10" },
      ],
    }),
    binding: ETHER,
  },
  {
    name: "thirds, where rounding leaves a remainder",
    spec: spec({
      distribution: [
        { recipient: { kind: "CREATOR" }, share: "33.3333" },
        { recipient: { kind: "TREASURY" }, share: "33.3333" },
        { recipient: { kind: "ADDRESS", address: "0x3333333333333333333333333333333333333333" }, share: "33.3334" },
      ],
    }),
    binding: ETHER,
  },
  { name: "an equity-quoted market", spec: spec({ baseRate: { buy: "1.5", sell: "1.5" } }), binding: EQUITY },
];

/** The swap contexts every configuration is evaluated at. */
function contextsFor(config: CanonicalConfig): readonly SwapContext[] {
  const contexts: SwapContext[] = [];
  const amounts = new Set<bigint>([0n, 1n, 1_000n, ONE_PERCENT, REFERENCE_SUPPLY / 2n]);

  // The boundary triple around every tier and every ceiling. This is where every
  // inclusive/exclusive mistake lives, in either language.
  for (const tier of [...config.buyTiers, ...config.sellTiers]) {
    amounts.add(tier.thresholdTokens - 1n);
    amounts.add(tier.thresholdTokens);
    amounts.add(tier.thresholdTokens + 1n);
  }
  for (const ceiling of [config.maxBuyTokens, config.maxSellTokens]) {
    if (ceiling === null) continue;
    amounts.add(ceiling);
    amounts.add(ceiling + 1n);
  }

  const progress = new Set<bigint>([0n]);
  for (const stage of config.stages) {
    if (stage.threshold === 0n) continue;
    progress.add(stage.threshold - 1n);
    progress.add(stage.threshold);
    progress.add(stage.threshold + 1n);
  }

  for (const side of ["BUY", "SELL"] as const) {
    for (const grossTokenAmount of amounts) {
      for (const step of progress) {
        contexts.push({
          side,
          grossTokenAmount,
          grossQuoteAmount: 7n * ONE_ETH + 13n,
          elapsedSeconds: config.ladderAxis === "TIME" ? step : 0n,
          cumulativeQuoteVolume: config.ladderAxis === "QUOTE_VOLUME" ? step : 0n,
        });
      }
    }
  }

  return contexts;
}

const SIDE_CODE: Record<Side, 0 | 1> = { BUY: 0, SELL: 1 };

/**
 * A fixed identity for the commitment vectors.
 *
 * Arbitrary values, deliberately — the point is that the TypeScript and the Solidity agree
 * on the preimage, not that these are the addresses anything will really use. Robinhood
 * Chain's id, so the vectors read as something plausible rather than as `chainId: 1`.
 */
const IDENTITY: EngineIdentity = {
  chainId: 4663,
  engine: "0x000000000000000000000000000000000000c0de",
  engineVersion: 1,
};

/*
 * Cases are emitted as parallel arrays rather than as an array of objects.
 *
 * Not a stylistic choice: Foundry's JSON reader resolves one path at a time, so an array of
 * 554 objects means several thousand individual `readUint` calls, each allocating a fresh
 * path string. The first version of this ran the test out of memory. Reading one array per
 * field is a handful of calls per configuration and costs nothing.
 *
 * Payouts are flattened with a stride of `shareCount`, since jagged arrays have no cheap
 * representation here and every case in a configuration has the same number of recipients.
 */
const vectors = SPECS.map((entry) => {
  const compiled = compile(entry.spec, entry.binding);
  if (!compiled.ok) {
    throw new Error(`${entry.name} did not compile: ${compiled.problems.map((p) => p.code).join(", ")}`);
  }
  const config = compiled.config;

  const contexts = contextsFor(config);
  const evaluations = contexts.map((context) => evaluate(config, context));

  const progressOf = (context: SwapContext): bigint =>
    config.ladderAxis === "TIME"
      ? context.elapsedSeconds
      : config.ladderAxis === "QUOTE_VOLUME"
        ? context.cumulativeQuoteVolume
        : 0n;

  return {
    name: entry.name,
    encoded: encodeConfig(config),
    configHash: configHash(config),
    // The commitment a creator signs, so the Solidity twin can be held to it.
    implementationHash: implementationHash(config, IDENTITY),
    feeCurrency: config.feeCurrency === "QUOTE" ? 0 : 1,
    // Explicit, because Foundry's JSON reader has no array-length primitive.
    caseCount: contexts.length,
    stageCount: config.stages.length,
    buyTierCount: config.buyTiers.length,
    sellTierCount: config.sellTiers.length,
    shareCount: config.distribution.length,

    sides: contexts.map((context) => SIDE_CODE[context.side]),
    tokenAmounts: contexts.map((context) => context.grossTokenAmount.toString()),
    quoteAmounts: contexts.map((context) => context.grossQuoteAmount.toString()),
    progresses: contexts.map((context) => progressOf(context).toString()),

    expectedFeePpms: evaluations.map((evaluation) => evaluation.effectiveFeePpm),
    expectedFeeAmounts: evaluations.map((evaluation) => evaluation.feeAmount.toString()),
    expectedBlocked: evaluations.map((evaluation) => evaluation.blocked !== null),
    expectedPayouts: evaluations.flatMap((evaluation) =>
      evaluation.payouts.map((payout) => payout.amount.toString()),
    ),
  };
});

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "vectors");
mkdirSync(out, { recursive: true });

/*
 * One file per configuration, plus an index.
 *
 * Foundry re-parses the whole file on every path read, so a single 134 KB document meant
 * seventeen configurations times eight array reads times the entire file — about eighteen
 * megabytes of EVM memory, and the test ran out before it asserted anything. Split, each
 * read touches roughly eight kilobytes.
 */
writeFileSync(
  resolve(out, "index.json"),
  `${JSON.stringify(
    {
      version: 1,
      count: vectors.length,
      // Carried so the Solidity can build the same preimage without hardcoding them twice.
      chainId: IDENTITY.chainId,
      engine: IDENTITY.engine,
      engineVersion: IDENTITY.engineVersion,
      names: vectors.map((vector) => vector.name),
    },
    null,
    2,
  )}\n`,
);

for (const [index, vector] of vectors.entries()) {
  const name = `${String(index).padStart(2, "0")}.json`;
  writeFileSync(resolve(out, name), `${JSON.stringify(vector, null, 2)}\n`);
}

const cases = vectors.reduce((sum, vector) => sum + vector.caseCount, 0);
process.stdout.write(
  `wrote ${String(vectors.length)} configurations and ${String(cases)} cases to ${out}\n`,
);
