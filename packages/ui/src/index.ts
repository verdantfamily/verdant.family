/**
 * @verdant/ui — the formatting layer, and later the components.
 *
 * What is here now is arithmetic: turning the integers the chain deals in into strings
 * a person can read, without passing through `number` on the way. That constraint is
 * the reason this is a package rather than a file in the app — the same conversions
 * are needed by anything that displays a market, and a second implementation of them
 * is a second set of rounding decisions.
 *
 * Still to come: `TransactionButton`, which will be the only place transaction state is
 * rendered, so that there is one state machine rather than one per surface.
 */

export {
  formatAmount,
  formatBps,
  formatCompact,
  formatEther,
  formatFeeRate,
  WEI_PER_ETHER,
  type AmountOptions,
} from "./format/amount.js";

export {
  formatPrice,
  impliedValueInQuote,
  priceChangeBps,
  quotePerToken,
  tokensPerQuote,
  PRICE_PRECISION,
  Q96,
} from "./format/price.js";

export {
  MAX_SQRT_PRICE,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MIN_TICK,
  sqrtPriceAtTickOrNull,
  sqrtPriceX96AtTick,
} from "./format/tick.js";

export { formatAge, formatDuration, formatInstant, DAY, HOUR, MINUTE } from "./format/time.js";

export { shortenAddress, shortenHash } from "./format/address.js";
