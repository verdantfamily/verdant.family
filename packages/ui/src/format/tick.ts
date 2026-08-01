/**
 * Tick to price, exactly as the pool computes it.
 *
 * A launch form has to answer "what will this cost at the open" before a pool exists, and
 * the only honest way to do that is with the arithmetic the pool itself will use. The
 * obvious shortcut — `1.0001 ** tick` in double precision — is wrong in the last places
 * for large ticks, and a launch price is exactly where a creator is entitled to expect
 * the interface and the chain to agree to the digit.
 *
 * So this is Uniswap's `TickMath.getSqrtPriceAtTick`, transliterated: the same nineteen
 * magic constants, the same Q128.128 accumulation, the same rounding-up shift into Q64.96.
 * It is verified against the four values the library itself pins — the price at tick zero
 * and at each extreme — in `tick.test.ts`.
 */

import { MAX_TICK_ABSOLUTE } from "@verdant/config";

/**
 * The tick bounds Uniswap enforces. Outside these, a pool cannot exist.
 *
 * Taken from `@verdant/config` rather than written here. The number is Uniswap's, not
 * ours, but ADR-001 holds regardless of provenance: one definition per language, so a
 * bound cannot be corrected in one file and left stale in another.
 */
export const MIN_TICK = -MAX_TICK_ABSOLUTE;
export const MAX_TICK = MAX_TICK_ABSOLUTE;

/** `getSqrtPriceAtTick(MIN_TICK)` and `getSqrtPriceAtTick(MAX_TICK)`. */
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

const Q128 = 1n << 128n;
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * The multiplier for each bit of |tick|.
 *
 * Entry `i` is `1.0001 ** -(2 ** i)` in Q128.128. Multiplying the ones selected by the
 * set bits of |tick| composes `1.0001 ** -|tick|` with a bounded error, which is why the
 * loop below never evaluates a power.
 */
const RATIOS: readonly bigint[] = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

/**
 * The square root of the price at `tick`, in Q64.96 — the form the pool stores.
 *
 * Throws outside the tick bounds rather than clamping. A tick out of range is a bug in the
 * caller, and a clamped price would be a plausible-looking wrong answer.
 */
export function sqrtPriceX96AtTick(tick: number): bigint {
  if (!Number.isInteger(tick)) throw new RangeError(`tick ${tick} is not an integer`);
  if (tick < MIN_TICK || tick > MAX_TICK) throw new RangeError(`tick ${tick} is out of range`);

  const absolute = BigInt(Math.abs(tick));

  // Bit zero is folded into the seed so the accumulator starts at 1.0 in Q128.128 when
  // it is clear, and at the first multiplier when it is set.
  let ratio = (absolute & 1n) !== 0n ? RATIOS[0]! : Q128;

  for (let bit = 1; bit < RATIOS.length; bit += 1) {
    if ((absolute & (1n << BigInt(bit))) !== 0n) {
      ratio = (ratio * RATIOS[bit]!) >> 128n;
    }
  }

  // The constants describe negative ticks; a positive tick is the reciprocal.
  if (tick > 0) ratio = MAX_UINT256 / ratio;

  // Q128.128 to Q64.96, rounding up so the result never understates the price — the same
  // direction Uniswap rounds, which is what keeps a boundary tick from landing one wei of
  // price below the pool's own value.
  const shifted = ratio >> 32n;
  return (ratio & 0xffffffffn) === 0n ? shifted : shifted + 1n;
}

/**
 * The tokens-per-ether price a market opens at, given the tick it is created with.
 *
 * Higher tick means more of the launched token per ether, so a cheaper token: the tick is
 * the launch price control, and this is the sentence that makes it legible in a form.
 */
export function sqrtPriceAtTickOrNull(tick: number): bigint | null {
  try {
    return sqrtPriceX96AtTick(tick);
  } catch {
    return null;
  }
}
