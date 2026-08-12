/**
 * Launching a generated market.
 *
 * Agen's factory is separate from Verdant's and shares nothing with it but the
 * PoolManager: `VerdantFactory.create` launches a market whose shape is known — one
 * token, one schedule, one hook fixed at the factory's own construction — and
 * `AgenFactory.deployMarket` launches however many contracts a generated mechanic needs.
 * The two live side by side here for the same reason they do on chain, and `../launch`
 * is the other one.
 *
 * What this module holds is the last step of a build: a manifest whose addresses were
 * all predicted off-chain, turned into calldata, plus the arithmetic that lets a creator
 * choose a starting valuation instead of a tick.
 */

export {
  buildDeployMarket,
  encodeDeployMarket,
  type Manifest,
  type ManifestComponent,
  type ManifestWiringCall,
} from "./manifest.js";

export {
  initialTickForValuation,
  valuationAtTick,
  MAX_INITIAL_TICK,
  MIN_INITIAL_TICK,
  TICK_SPACING,
  type ValuationInput,
} from "./valuation.js";

export {
  agenPoolKeyFor,
  agenPoolKeyOf,
  isAgenMarket,
  poolKeyMatches,
  readAgenComponents,
  readAgenMarketByToken,
  readAgenMarketCount,
  readAgenMarketPage,
  readPoolState,
  resolveAgenPoolKey,
  AGEN_TICK_SPACING,
  NATIVE_CURRENCY,
  type AgenComponent,
  type AgenMarketRecord,
  type PoolState,
} from "./market.js";

export { priceFromSqrt, quoteAgenTrade, type AgenQuote } from "./trade.js";
