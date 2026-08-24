/**
 * `@verdant/market-engine` — the deterministic half of a programmable market.
 *
 * No model calls anywhere in this package. A prompt becomes an `AgenMarketSpec`
 * somewhere above it; everything from there to the encoded bytes is here, is pure, and
 * is testable without a network.
 *
 * The pipeline this package implements:
 *
 *   parseSpec      a model's answer, or every reason it is not a specification
 *   compile        validate, normalize, canonicalize, against the launch's binding
 *   encodeConfig   canonical bytes, the same ones Solidity will hash
 *   implementationHash   the commitment a creator signs
 *   evaluate       what one swap costs — the reference the Solidity is held to
 *   simulate       every boundary, generated from the configuration
 *   review         what the market does, in a creator's words
 *   executionGraph the same thing as a renderable graph
 *
 * Everything after `compile` reads `CanonicalConfig` and nothing else, which is what
 * makes it impossible for the review screen to describe one market while another one
 * deploys.
 */

export { MAX_RECIPIENTS, MAX_STAGES, MAX_TIERS_PER_SIDE, MAX_TIME_HORIZON_SECONDS, MIN_TIME_STAGE_GAP_SECONDS } from "./bounds.js";
export { compile, type CompileResult } from "./compile.js";
export {
  AGEN_ENGINE_CONFIG_V1_DOMAIN,
  AGEN_ENGINE_CONFIG_V2_DOMAIN,
  CONFIG_ABI,
  CONFIG_V2_ABI,
  configFields,
  configFieldsV2,
  configHash,
  decodeConfig,
  encodeConfig,
  implementationHash,
  type ConfigLabels,
  type EngineIdentity,
} from "./encode.js";
export {
  EngineError,
  outcomeOf,
  worstOutcome,
  type EngineProblem,
  type Outcome,
  type ProblemCode,
} from "./errors.js";
export {
  activeStageIndex,
  distribute,
  distributionIsWhole,
  evaluate,
  matchingTierIndex,
  maximumFeePpm,
  type Evaluation,
  type Payout,
  type SwapContext,
  type TradeBlock,
} from "./evaluate.js";
export { executionGraph, type ExecutionGraph, type GraphEdge, type GraphNode, type NodeKind } from "./graph.js";
export {
  chargeIn,
  feeCurrencyIsSpecified,
  sideOf,
  specifiedIsCurrency0,
  tokenKnownBeforeSwap,
  type PoolOrientation,
  type SwapShape,
} from "./orientation.js";
export {
  parseEnvelope,
  resolve,
  type Clarification,
  type InterpretationEnvelope,
  type InterpretationResult,
  type UnsupportedRequest,
} from "./interpret.js";
export { parseSpec, type ParseResult } from "./parse.js";
export { isNativeQuote, NO_V2_RULES } from "./spec.js";
export {
  engineSummary,
  review,
  type EngineSummary,
  type Review,
  type ReviewCard,
  type ReviewRow,
} from "./review.js";
export { simulate, type Simulation, type SimulationCase } from "./simulate.js";
export type {
  AgenMarketSpec,
  CanonicalConfig,
  CanonicalShare,
  CanonicalStage,
  CanonicalTier,
  DistributionShare,
  FeeCurrency,
  FeeLadder,
  LadderAxis,
  MarketBinding,
  MaxTradeSize,
  Operator,
  Protection,
  QuoteAssetBinding,
  Recipient,
  Side,
  SidedRate,
  SizeAmount,
  SizeMeasure,
  SizeTier,
  TimeStage,
  VolumeStage,
  WalletBuyLimit,
} from "./spec.js";
export {
  MAX_FEE_PPM,
  MIN_NON_ZERO_FEE_PPM,
  PPM_ONE,
  PPM_PER_PERCENT,
  feeOf,
  formatPercent,
  percentToPpm,
  ppmToPercent,
  shareOf,
  supplyPercentToTokens,
} from "./units.js";
