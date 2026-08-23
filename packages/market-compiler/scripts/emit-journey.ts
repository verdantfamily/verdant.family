/**
 * Emit the full product path for two markets, as a fixture Foundry can execute.
 *
 * ## What this proves that nothing else does
 *
 * Every stage of the engine already has tests. The pipeline has them, the evaluator has them,
 * the hook has them, the factory has them, the app has them. What none of them prove is that
 * the stages are joined: that the calldata a creator's browser is handed, built from the
 * configuration the review screen described, executes on chain and produces the fee the
 * simulation promised.
 *
 * That seam is where the whole architecture's claim lives — "the market you were shown is the
 * market you get" — and it is the one thing a suite of per-layer tests structurally cannot
 * check. Each side can be perfectly correct about a different market.
 *
 * So this walks one market from a prompt to typed calldata using the real modules, and writes
 * down both the calldata and what the TypeScript expects to happen when it runs. `EngineJourney.t.sol`
 * then executes exactly those bytes against a real `PoolManager`, trades against the market
 * they create, and asserts the fee matches. Nothing in the Solidity is told the economics; it
 * is told the bytes and the expected outcome, and has to get from one to the other itself.
 *
 * ## Two markets, and why these two
 *
 * One ERC-20-quoted market with a size tier, and one native-ETH-quoted market without. Between
 * them they cover the fee currency derivation both ways: the tiered market collects in the
 * launched token (ADR-018), the native one collects in ETH. Those are the two settlement paths
 * through the hook and the vault, and they are the two a release has to be sure of.
 *
 * ## Why the model is scripted here
 *
 * Because this fixture must be reproducible, and a real model call is not. The real model is
 * exercised by `engine-benchmark.mjs`, which runs every prompt five times against the
 * configured provider and measures whether the interpretation is stable. That answers "does
 * the model produce this configuration"; this answers "given that configuration, does the rest
 * of the path carry it faithfully to the chain". Mixing the two questions would make a failure
 * in either look like a failure in both.
 *
 * The envelope below is a real one — the shape the model actually returns — and it goes
 * through the same strict parse and semantic resolution as a live answer. Nothing here skips
 * validation; only the network call is replaced.
 *
 * Run with `pnpm --filter @verdant/market-compiler journey:emit`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  configHash,
  encodeConfig,
  evaluate,
  implementationHash,
  resolve as resolveEnvelope,
  review,
  simulate,
} from "../../market-engine/dist/index.js";
import type { CanonicalConfig, MarketBinding, SwapContext } from "../../market-engine/dist/index.js";
import { engineApprovalMessage } from "../dist/approval.js";
import { prepareLaunch } from "../dist/engine/prepare.js";

const ONE_ETH = 10n ** 18n;
const SUPPLY = 1_000_000_000n * ONE_ETH;

/**
 * The addresses the fixture is built for.
 *
 * They are placeholders here and are replaced by the Solidity test with the ones its own
 * deployment produced — which is the point of `rebuild` below. A fixture pinning real
 * addresses would have to be regenerated every time the deployment moved, and would silently
 * describe a different market if it were not.
 */
const ADDRESSES = {
  chainId: 4663,
  factory: "0x00000000000000000000000000000000000f0001",
  hook: "0x00000000000000000000000000000000000038cc",
  deployer: "0x00000000000000000000000000000000000d0001",
  registry: "0x00000000000000000000000000000000000e0001",
} as const;

const CREATOR = "0x00000000000000000000000000000000000c0001";

interface Journey {
  readonly name: string;
  readonly prompt: string;
  /** What the model returned, before anything validated it. */
  readonly envelope: unknown;
  readonly binding: {
    readonly referenceSupply: string;
    readonly quoteAsset: { readonly address: string; readonly symbol: string; readonly decimals: number };
    readonly launchedTokenSymbol: string;
  };
  /** The authoritative artefact: what the commitment is taken over. */
  readonly encodedConfig: string;
  readonly configHash: string;
  readonly implementationHash: string;
  /** Exactly what a creator's wallet signs, character for character. */
  readonly approvalMessage: string;
  /** What the review screen states, so Solidity can be checked against the same words. */
  readonly review: { readonly maximumFee: string; readonly feeCurrencySymbol: string };
  /**
   * How many trades follow.
   *
   * Written out because Foundry's JSON reader has no way to ask an array its length without
   * parsing the whole array into a typed Solidity value, and these entries are mixed-type. A
   * count is one number and makes the Solidity loop over exactly what was emitted.
   */
  readonly tradeCount: number;
  /** The trades the Solidity test will make, and what the TypeScript says each one pays. */
  readonly trades: readonly {
    readonly what: string;
    readonly isBuy: boolean;
    readonly grossTokenAmount: string;
    readonly grossQuoteAmount: string;
    readonly expectedFeePpm: number;
    readonly expectedFeeAmount: string;
  }[];
}

/** A market's economics, as a model returns them. */
function envelopeFor(kind: "tiered" | "native"): unknown {
  if (kind === "tiered") {
    return {
      outcome: "SUPPORTED",
      spec: {
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
      },
      assumptions: [],
      unsupported: [],
      clarifications: [],
    };
  }

  return {
    outcome: "SUPPORTED",
    spec: {
      engineVersion: 1,
      baseRate: { buy: "1", sell: "2" },
      ladder: null,
      sizeTiers: [],
      distribution: [{ recipient: { kind: "CREATOR" }, share: "100" }],
      protections: [],
    },
    assumptions: [],
    unsupported: [],
    clarifications: [],
  };
}

function bindingFor(kind: "tiered" | "native"): MarketBinding {
  return {
    referenceSupply: SUPPLY,
    launchedTokenSymbol: kind === "tiered" ? "EXCT" : "FLOW",
    quoteAsset:
      kind === "tiered"
        ? { address: "0x1111111111111111111111111111111111111111", symbol: "NVDA", decimals: 18 }
        : { address: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18 },
  };
}

/**
 * The trades worth making on chain, chosen from the simulation rather than invented.
 *
 * A boundary triple where there is a tier — below, at, above — because that is where an
 * implementation disagrees if it is going to, and an ordinary trade on each side otherwise.
 * The expected fee comes from `evaluate`, so the Solidity is being held to the TypeScript's
 * answer rather than to a number somebody wrote down.
 */
function tradesFor(config: CanonicalConfig): Journey["trades"] {
  const ordinary = SUPPLY / 1_000_000n;
  const tier = config.sellTiers[0]?.thresholdTokens ?? null;

  const contexts: { what: string; context: SwapContext }[] = [
    {
      what: "an ordinary buy",
      context: {
        side: "BUY",
        grossTokenAmount: ordinary,
        grossQuoteAmount: ONE_ETH,
        elapsedSeconds: 0n,
        cumulativeQuoteVolume: 0n,
      },
    },
    {
      what: "an ordinary sell",
      context: {
        side: "SELL",
        grossTokenAmount: ordinary,
        grossQuoteAmount: ONE_ETH,
        elapsedSeconds: 0n,
        cumulativeQuoteVolume: 0n,
      },
    },
  ];

  if (tier !== null) {
    for (const [what, amount] of [
      ["a sell one unit below the tier", tier - 1n],
      ["a sell exactly at the tier", tier],
      ["a sell one unit above the tier", tier + 1n],
    ] as const) {
      contexts.push({
        what,
        context: {
          side: "SELL",
          grossTokenAmount: amount,
          grossQuoteAmount: ONE_ETH,
          elapsedSeconds: 0n,
          cumulativeQuoteVolume: 0n,
        },
      });
    }
  }

  return contexts.map(({ what, context }) => {
    const evaluated = evaluate(config, context);

    return {
      what,
      isBuy: context.side === "BUY",
      grossTokenAmount: context.grossTokenAmount.toString(),
      grossQuoteAmount: context.grossQuoteAmount.toString(),
      expectedFeePpm: evaluated.effectiveFeePpm,
      expectedFeeAmount: evaluated.feeAmount.toString(),
    };
  });
}

function journeyFor(kind: "tiered" | "native", prompt: string): Journey {
  const binding = bindingFor(kind);
  const envelope = envelopeFor(kind);

  // The same strict parse and semantic resolution a live answer goes through. A fixture that
  // bypassed this would prove the path carries *something* faithfully, without establishing
  // that the something was ever validated.
  const resolved = resolveEnvelope(envelope, binding);
  if (resolved.outcome !== "SUPPORTED") {
    throw new Error(`the fixture envelope did not resolve: ${JSON.stringify(resolved)}`);
  }

  const config = resolved.config;

  // Run for their side effects: both throw on a configuration they cannot describe, so a
  // fixture that reaches the end has been through the whole review path rather than around it.
  simulate(config);
  const shown = review(config);
  const trades = tradesFor(config);

  const prepared = prepareLaunch({
    config,
    parameters: {
      name: kind === "tiered" ? "Exact Flow" : "Flow",
      symbol: binding.launchedTokenSymbol,
      supply: SUPPLY,
      metadataURI: "ipfs://journey",
      metadataMutable: false,
      initialTick: 92_200,
      feeReceiver: CREATOR,
      tokenSalt: `0x${"11".repeat(32)}`,
      specificationHash: configHash(config),
    },
    addresses: ADDRESSES,
  });

  return {
    name: kind,
    prompt,
    envelope,
    binding: {
      referenceSupply: binding.referenceSupply.toString(),
      quoteAsset: binding.quoteAsset,
      launchedTokenSymbol: binding.launchedTokenSymbol,
    },
    encodedConfig: encodeConfig(config),
    configHash: configHash(config),
    implementationHash: prepared.implementationHash,
    approvalMessage: engineApprovalMessage({
      jobId: `journey-${kind}`,
      engineVersion: 1,
      configHash: configHash(config),
      implementationHash: prepared.implementationHash,
      creator: CREATOR,
    }),
    review: { maximumFee: shown.maximumFee, feeCurrencySymbol: shown.feeCurrencySymbol },
    tradeCount: trades.length,
    trades,
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../market-engine/journey");

mkdirSync(OUT, { recursive: true });

const journeys = [
  journeyFor(
    "tiered",
    "Launch Exact Flow, ticker EXCT. Charge 0.5% on every buy and every sell. When a sell is " +
      "at least 1% of total supply, charge 4% instead. Send 80% of every fee to me and 20% to " +
      "the Agen treasury.",
  ),
  journeyFor("native", "Launch Flow, ticker FLOW. Charge 1% to buy and 2% to sell, all to me."),
];

for (const journey of journeys) {
  writeFileSync(resolve(OUT, `${journey.name}.json`), `${JSON.stringify(journey, null, 2)}\n`);
}

// Emitted last so a Solidity test can discover the set without knowing the names, matching how
// the rule vectors are indexed.
writeFileSync(
  resolve(OUT, "index.json"),
  `${JSON.stringify({ journeys: journeys.map((one) => one.name) }, null, 2)}\n`,
);

process.stdout.write(`wrote ${String(journeys.length)} journeys to ${OUT}\n`);
for (const journey of journeys) {
  process.stdout.write(
    `  ${journey.name.padEnd(8)} ${journey.trades.length} trades  fee in ${journey.review.feeCurrencySymbol}` +
      `  max ${journey.review.maximumFee}\n`,
  );
}
