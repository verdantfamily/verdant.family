/**
 * Emit the exact bytes a creator's wallet signs, for every shape of engine-v1 market.
 *
 * ## What these vectors are for
 *
 * The approval message is the one artefact that has to be produced identically in two
 * places at once. The browser builds it so the wallet's dialog can be read against the
 * review screen behind it; the server rebuilds it to verify the signature that comes back.
 * If the two ever disagree by a single character, every approval fails verification — and
 * fails invisibly, because a signature that does not recover looks exactly like the wrong
 * wallet being connected.
 *
 * There is now one builder rather than two, so agreement is structural. What these vectors
 * add is the other half: that the one builder's output does not move without somebody
 * seeing it. A reworded sentence still breaks every wallet signature already gathered, and
 * a diff to this file is what makes that a decision rather than an accident.
 *
 * ## Why the hashes are computed rather than invented
 *
 * A vector whose `configHash` is `0x1111…` proves the message renders a hash it was given.
 * It does not prove the message renders *this market's* hash. So every case below compiles
 * a real specification through the engine and takes the real commitment over it, which
 * means the vectors also pin the thing a creator is actually being asked to compare
 * against the screen: the identity of the economics.
 *
 * ## The nine cases
 *
 * One per axis the message could plausibly be sensitive to and must not silently be:
 * a flat market, a size-tiered one, a time ladder, a volume ladder, a native-ETH quote, an
 * ERC-20 quote, a different creator, a different configuration and a different commitment.
 * The last three are the same market with one field moved, which is what proves consent is
 * to a specific market rather than to a template.
 *
 * Run with `pnpm --filter @verdant/market-compiler approval:emit`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compile, configHash, implementationHash } from "../../market-engine/dist/index.js";
import type {
  AgenMarketSpec,
  MarketBinding,
  QuoteAssetBinding,
} from "../../market-engine/dist/index.js";
import { engineApprovalMessage } from "../dist/approval.js";

const SUPPLY = 1_000_000_000n * 10n ** 18n;

const NATIVE: QuoteAssetBinding = {
  address: "0x0000000000000000000000000000000000000000",
  symbol: "ETH",
  decimals: 18,
};

/** A first-party ERC-20 quote, so the non-native settlement path is covered too. */
const ERC20: QuoteAssetBinding = {
  address: "0x1111111111111111111111111111111111111111",
  symbol: "NVDA",
  decimals: 18,
};

/**
 * The engine identity the commitment is taken over.
 *
 * Fixed rather than read from a deployment record, because these vectors are about the
 * message and not about where the engine happens to live. A real launch takes the identity
 * from the configured addresses, and `implementationHash` moving when the engine or the
 * chain moves is proved by the engine's own tests rather than restated here.
 */
const IDENTITY = {
  chainId: 4663,
  engine: "0x00000000000000000000000000000000000038cc",
  engineVersion: 1,
} as const;

const CREATOR = "0x00000000000000000000000000000000000C0001";
const OTHER_CREATOR = "0x000000000000000000000000000000000000dEaD";

function flat(): AgenMarketSpec {
  return {
    engineVersion: 1,
    baseRate: { buy: "1", sell: "2" },
    ladder: null,
    sizeTiers: [],
    distribution: [{ recipient: { kind: "CREATOR" }, share: "100" }],
    protections: [],
  };
}

function tiered(): AgenMarketSpec {
  return {
    ...flat(),
    baseRate: { buy: "0.5", sell: "0.5" },
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
  };
}

/**
 * A rate that steps down with elapsed time.
 *
 * The opening rate is the base rate — the engine makes stage 0 the base and refuses a stage
 * at zero seconds rather than accepting two names for the same thing — so the stages here
 * start strictly after the pool opens.
 */
function timeLadder(): AgenMarketSpec {
  return {
    ...flat(),
    baseRate: { buy: "5", sell: "5" },
    ladder: {
      axis: "TIME",
      stages: [
        { afterSeconds: 3600, rate: { buy: "2", sell: "2" } },
        { afterSeconds: 86_400, rate: { buy: "1", sell: "1" } },
      ],
    },
  };
}

function volumeLadder(): AgenMarketSpec {
  return {
    ...flat(),
    baseRate: { buy: "5", sell: "5" },
    ladder: {
      axis: "QUOTE_VOLUME",
      stages: [
        { afterQuoteAmount: "10000000000000000000", rate: { buy: "2", sell: "2" } },
        { afterQuoteAmount: "100000000000000000000", rate: { buy: "1", sell: "1" } },
      ],
    },
  };
}

interface Vector {
  readonly name: string;
  /** Why this case is in the set, so a failing vector explains itself. */
  readonly covers: string;
  readonly jobId: string;
  readonly engineVersion: number;
  readonly configHash: string;
  readonly implementationHash: string;
  readonly creator: string;
  /** Exactly what a wallet signs, character for character. */
  readonly approvalMessage: string;
}

function commitments(
  spec: AgenMarketSpec,
  quoteAsset: QuoteAssetBinding,
): { readonly configHash: string; readonly implementationHash: string } {
  const binding: MarketBinding = {
    referenceSupply: SUPPLY,
    quoteAsset,
    launchedTokenSymbol: "FLOW",
  };

  const compiled = compile(spec, binding);
  if (!compiled.ok) {
    throw new Error(
      `a vector's specification does not compile: ${compiled.problems
        .map((problem) => `${problem.code} at ${problem.path}`)
        .join(", ")}`,
    );
  }

  return {
    configHash: configHash(compiled.config),
    implementationHash: implementationHash(compiled.config, IDENTITY),
  };
}

function vector(
  name: string,
  covers: string,
  jobId: string,
  spec: AgenMarketSpec,
  quoteAsset: QuoteAssetBinding,
  creator: string = CREATOR,
  overrides: { readonly configHash?: string; readonly implementationHash?: string } = {},
): Vector {
  const derived = commitments(spec, quoteAsset);

  const configHashValue = (overrides.configHash ?? derived.configHash) as `0x${string}`;
  const implementationHashValue = (overrides.implementationHash ??
    derived.implementationHash) as `0x${string}`;

  return {
    name,
    covers,
    jobId,
    engineVersion: 1,
    configHash: configHashValue,
    implementationHash: implementationHashValue,
    creator,
    approvalMessage: engineApprovalMessage({
      jobId,
      engineVersion: 1,
      configHash: configHashValue,
      implementationHash: implementationHashValue,
      creator,
    }),
  };
}

const FLAT = commitments(flat(), NATIVE);

const VECTORS: readonly Vector[] = [
  vector("flat", "one rate forever, the simplest market that launches", "vector-flat", flat(), NATIVE),
  vector(
    "tiered",
    "a size-gated sell rate, which settles in the launched token per ADR-018",
    "vector-tiered",
    tiered(),
    NATIVE,
  ),
  vector("time-ladder", "a rate that steps down with elapsed time", "vector-time", timeLadder(), NATIVE),
  vector(
    "volume-ladder",
    "a rate that steps down with cumulative quote volume",
    "vector-volume",
    volumeLadder(),
    NATIVE,
  ),
  vector(
    "native-quote",
    "native Robinhood Chain ETH as the quote asset, unwrapped",
    "vector-native",
    tiered(),
    NATIVE,
  ),
  vector(
    "erc20-quote",
    "an ERC-20 quote asset, which changes the economics and so the commitment",
    "vector-erc20",
    tiered(),
    ERC20,
  ),
  vector(
    "different-creator",
    "the same market approved by somebody else: one signer's consent is not another's",
    "vector-flat",
    flat(),
    NATIVE,
    OTHER_CREATOR,
  ),
  vector(
    "different-config-hash",
    "the same build with different economics: consent must not carry over",
    "vector-flat",
    flat(),
    NATIVE,
    CREATOR,
    { configHash: `0x${"33".repeat(32)}` },
  ),
  vector(
    "different-implementation-hash",
    "the same economics committed to a different engine or chain",
    "vector-flat",
    flat(),
    NATIVE,
    CREATOR,
    { implementationHash: `0x${"44".repeat(32)}` },
  ),
];

// Every case must be a distinct signable message. Two vectors with the same preimage would
// mean one of the axes above is not actually covered, and the suite would still pass.
const seen = new Set<string>();
for (const entry of VECTORS) {
  if (seen.has(entry.approvalMessage)) {
    throw new Error(`two vectors produce the same signed message: ${entry.name}`);
  }
  seen.add(entry.approvalMessage);
}

if (FLAT.configHash === commitments(tiered(), NATIVE).configHash) {
  throw new Error("the flat and tiered fixtures compile to the same configuration");
}

const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../market-engine/approval/engine-v1.vectors.json",
);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify({ vectors: VECTORS }, null, 2)}\n`, "utf8");

console.log(`wrote ${String(VECTORS.length)} approval vectors to ${OUT}`);
