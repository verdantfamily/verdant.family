/**
 * Turning integers into something a person can read.
 *
 * Everything here takes `bigint` and returns `string`. No step passes through
 * `number`, and that is the whole design constraint rather than a stylistic
 * preference: a token supply of 10^27 wei exceeds `Number.MAX_SAFE_INTEGER` by nine
 * orders of magnitude, so `Number(supply)` silently returns a value that is close to
 * the truth and not equal to it. A market's supply displayed as
 * 1,000,000,000.0000001 tokens is the kind of error nobody reports and everybody
 * notices.
 *
 * So division is done on integers, and the decimal point is inserted into the digit
 * string afterwards.
 */

/** Wei per ether, and per whole unit of any 18-decimal token. */
const WEI_PER_ETHER = 10n ** 18n;

/**
 * Splits a fixed-point integer into its whole and fractional digits.
 *
 * The fraction is returned zero-padded to `decimals` places, because "1 wei" and
 * "1 ether" both have a fractional part of `1` before padding and mean very
 * different things.
 */
function split(value: bigint, decimals: number): { whole: bigint; fraction: string } {
  const scale = 10n ** BigInt(decimals);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;

  return {
    whole: negative ? -(magnitude / scale) : magnitude / scale,
    fraction: (magnitude % scale).toString().padStart(decimals, "0"),
  };
}

/** Thousands separators, applied to a digit string rather than to a number. */
function groupDigits(digits: string): string {
  const negative = digits.startsWith("-");
  const body = negative ? digits.slice(1) : digits;
  const grouped = body.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}

/**
 * Trims a fraction to at most `places`, then drops trailing zeros.
 *
 * Rounding is deliberately absent: this truncates. A balance rounded up reads as
 * more money than the holder has, and the difference — a fraction of the last
 * displayed digit — is never worth that.
 */
function trimFraction(fraction: string, places: number): string {
  return fraction.slice(0, places).replace(/0+$/, "");
}

export interface AmountOptions {
  /** Fixed-point places in the input. 18 for ether and for every Verdant token. */
  readonly decimals?: number;
  /** How many fractional digits to show at most. */
  readonly places?: number;
}

/**
 * A whole-unit amount: `"1,234.56"`.
 *
 * For amounts a reader might compare or add up. Below the visible precision this
 * returns `"0"` rather than a string of zeros, so a dust balance reads as nothing
 * rather than as a suspiciously precise nothing.
 */
export function formatAmount(value: bigint, options: AmountOptions = {}): string {
  const { decimals = 18, places = 4 } = options;
  const { whole, fraction } = split(value, decimals);
  const trimmed = trimFraction(fraction, places);

  return trimmed === "" ? groupDigits(whole.toString()) : `${groupDigits(whole.toString())}.${trimmed}`;
}

/**
 * An ether amount, with more precision than a token amount gets.
 *
 * Six places rather than four, because ether amounts in a launchpad are routinely
 * small — a 0.05 ETH buy is a normal trade — and 0.05 rendered to two significant
 * figures is fine while 0.000123 rendered to four places is not.
 */
export function formatEther(value: bigint, places = 6): string {
  return formatAmount(value, { decimals: 18, places });
}

/**
 * A large amount, abbreviated: `"1.2B"`, `"45.6M"`, `"12.3K"`.
 *
 * For supplies and volumes, where the magnitude is the message and the exact digits
 * are noise. Below a thousand this falls through to `formatAmount`, since "0.9K" is
 * harder to read than "900".
 */
export function formatCompact(value: bigint, decimals = 18): string {
  const { whole } = split(value, decimals);
  const magnitude = whole < 0n ? -whole : whole;
  const sign = whole < 0n ? "-" : "";

  const tiers = [
    { threshold: 10n ** 12n, suffix: "T" },
    { threshold: 10n ** 9n, suffix: "B" },
    { threshold: 10n ** 6n, suffix: "M" },
    { threshold: 10n ** 3n, suffix: "K" },
  ] as const;

  for (const tier of tiers) {
    if (magnitude >= tier.threshold) {
      // One decimal place, kept in integer arithmetic: multiply before dividing.
      const tenths = (magnitude * 10n) / tier.threshold;
      const units = tenths / 10n;
      const remainder = tenths % 10n;
      const body = remainder === 0n ? `${units}` : `${units}.${remainder}`;
      return `${sign}${body}${tier.suffix}`;
    }
  }

  return formatAmount(value, { decimals, places: 2 });
}

/**
 * A fee rate, from hundredths of a basis point: `10_000` becomes `"1%"`.
 *
 * The unit the contracts use, because it is the unit v4 uses. Two decimal places is
 * enough for every rate the bounds allow — 100 ppm, the floor, is 0.01%.
 */
export function formatFeeRate(ppm: number): string {
  const hundredths = Math.round(ppm / 100);
  const whole = Math.trunc(hundredths / 100);
  const fraction = Math.abs(hundredths % 100)
    .toString()
    .padStart(2, "0")
    .replace(/0+$/, "");

  return fraction === "" ? `${whole}%` : `${whole}.${fraction}%`;
}

/**
 * A share of something, from basis points: `9_000` becomes `"90%"`.
 *
 * Separate from `formatFeeRate` despite the similar arithmetic, because the units
 * differ by a factor of a hundred and the two are easy to confuse at a call site.
 * A creator's 90% share and a 90% fee are not remotely the same claim.
 */
export function formatBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = Math.abs(bps % 100)
    .toString()
    .padStart(2, "0")
    .replace(/0+$/, "");

  return fraction === "" ? `${whole}%` : `${whole}.${fraction}%`;
}

export { WEI_PER_ETHER };
