#!/usr/bin/env node
/**
 * Emits packages/config/generated/bounds.json.
 *
 * Why this file exists: the bounds have to reach Solidity, and Solidity cannot
 * import TypeScript. The alternatives were to retype every bound in a Solidity
 * constants file — which is the duplication the whole parameter register exists
 * to prevent — or to hand the numbers across as data. This is the data.
 *
 * Two consumers:
 *   1. `ModelRegistry`'s deployment script, which seeds the on-chain bounds.
 *   2. `packages/contracts/test/BoundsParity.t.sol`, which asserts that what a
 *      deployed ModelRegistry returns equals what this file says.
 *
 * The same shape lesson as the schedule vectors applies: flat, index-aligned
 * arrays, because `vm.parseJson` re-parses the whole document on every call and a
 * nested shape costs one parse per field.
 *
 * Usage: pnpm bounds:emit
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BOUNDS,
  MARKET_MODELS,
  MAX_USABLE_TICK,
  MIN_USABLE_TICK,
  MODEL_BOUNDS,
  QUOTE_ASSET_CHAIN_ID,
  QUOTE_ASSETS,
  TICK_SPACING,
  // From the build output rather than from src, because Node's type-stripping
  // does not rewrite module specifiers: `../src/index.js` would not resolve to
  // `../src/index.ts`. `pnpm bounds:emit` builds first.
} from "../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, "../generated/bounds.json");

const document = {
  $comment: [
    "GENERATED FILE - do not edit by hand. Regenerate with `pnpm bounds:emit`.",
    "The parameter register, as data, for the consumers that cannot import",
    "TypeScript. packages/config/src/bounds.ts is the source; this is a",
    "projection of it. Model arrays are index-aligned and their order IS the",
    "on-chain model discriminant.",
  ].join(" "),

  schedule: {
    minStages: BOUNDS.schedule.stageCount.min,
    maxStages: BOUNDS.schedule.stageCount.max,
    minFeePpm: BOUNDS.schedule.feePpm.min,
    maxFeePpm: BOUNDS.schedule.feePpm.max,
    defaultFeePpm: BOUNDS.schedule.feePpm.default,
    minStageGap: BOUNDS.schedule.minStageGap,
    maxHorizon: BOUNDS.schedule.startOffset.max,
  },

  splits: {
    total: BOUNDS.splits.total,
    minProtocolBps: BOUNDS.splits.protocolBps.min,
    maxProtocolBps: BOUNDS.splits.protocolBps.max,
    defaultProtocolBps: BOUNDS.splits.protocolBps.default,
    minReserveBps: BOUNDS.splits.reserveBps.min,
    maxReserveBps: BOUNDS.splits.reserveBps.max,
  },

  token: {
    decimals: BOUNDS.token.decimals,
    minSupplyTokens: BOUNDS.token.totalSupplyTokens.min.toString(),
    maxSupplyTokens: BOUNDS.token.totalSupplyTokens.max.toString(),
    minCreatorAllocationBps: BOUNDS.token.creatorAllocationBps.min,
    maxCreatorAllocationBps: BOUNDS.token.creatorAllocationBps.max,
    maxNameLength: BOUNDS.token.nameLength.max,
    maxSymbolLength: BOUNDS.token.symbolLength.max,
    maxMetadataUriLength: BOUNDS.token.metadataUriLength.max,
  },

  vesting: {
    minDuration: BOUNDS.vesting.duration.min,
    maxDuration: BOUNDS.vesting.duration.max,
  },

  liquidity: {
    tickSpacing: TICK_SPACING,
    minUsableTick: MIN_USABLE_TICK,
    maxUsableTick: MAX_USABLE_TICK,
    minLockDuration: BOUNDS.liquidity.lockDuration.min,
    minTokenShareBps: BOUNDS.liquidity.tokenShareBps.min,
    maxTokenShareBps: BOUNDS.liquidity.tokenShareBps.max,
  },

  // Index-aligned. The position of a model in these arrays is its on-chain
  // discriminant, which is why the order comes from MARKET_MODELS rather than
  // from Object.keys on MODEL_BOUNDS.
  modelCount: MARKET_MODELS.length,
  modelNames: MARKET_MODELS.map((m) => m),
  modelEnabled: MARKET_MODELS.map((m) => MODEL_BOUNDS[m].enabled),
  modelMinStages: MARKET_MODELS.map((m) => MODEL_BOUNDS[m].minStages),
  modelMaxStages: MARKET_MODELS.map((m) => MODEL_BOUNDS[m].maxStages),
  modelMinReserveBps: MARKET_MODELS.map((m) => MODEL_BOUNDS[m].reserveBps.min),
  modelMaxReserveBps: MARKET_MODELS.map((m) => MODEL_BOUNDS[m].reserveBps.max),

  // The reviewed quote assets, which `ModelRegistry` is seeded with so that the
  // allowlist is a contract's answer rather than an interface's. Index-aligned
  // with the symbols for the sake of a deployment log that can be read.
  //
  // These addresses exist on exactly one chain, and the chain id says which. A
  // deployment elsewhere would be admitting addresses that hold no code, so the
  // deploy script logs the mismatch rather than pretending the list applies.
  quoteAssetChainId: QUOTE_ASSET_CHAIN_ID,
  quoteAssetCount: QUOTE_ASSETS.length,
  quoteAssetSymbols: QUOTE_ASSETS.map((asset) => asset.symbol),
  quoteAssets: QUOTE_ASSETS.map((asset) => asset.address),
} as const;

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(document, null, 2)}\n`, "utf8");

console.log(`wrote ${OUT_PATH}`);
console.log(`  ${document.modelCount} models: ${document.modelNames.join(", ")}`);
console.log(
  `  ${document.quoteAssetCount} quote assets on chain ${document.quoteAssetChainId}: ` +
    `${document.quoteAssetSymbols.join(", ")}`,
);
