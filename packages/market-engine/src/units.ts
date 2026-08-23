/**
 * The engine's units, and the only places they are converted.
 *
 * ## The canonical fee unit is ppm
 *
 * Not a preference — it is what Uniswap v4 itself counts in. `PoolKey.fee` and the
 * `uint24` a hook returns from `beforeSwap` are both "hundredths of a basis point",
 * which `packages/config/src/bounds.ts` has called ppm since the first Verdant market.
 * `MAX_LP_FEE_PPM` is 1_000_000, `ScheduleLib.MAX_FEE_PPM` is 100_000, and the engine
 * is the third consumer of the same unit rather than a fourth spelling of it.
 *
 * The rule this module exists to enforce: **a percentage becomes a number exactly once,
 * here, and becomes a string again exactly once, here.** Every other module in the
 * engine takes ppm and returns ppm. The failure this prevents is the one the old
 * pipeline kept having — a rate parsed in `requirements.ts`, re-derived in
 * `threshold.ts`, re-derived again by a model writing Solidity, and three answers to
 * "what does this market charge" that agreed until they did not.
 *
 * ## Percentages arrive as strings
 *
 * `percentToPpm` takes a string, not a number, and that is deliberate. `0.5` reaches
 * this function having already been through the model's JSON and JavaScript's binary
 * floats; `2.675 * 10_000` is 26749.999999999996, and `Math.round` hides that until
 * some other rate rounds the other way. Parsing the decimal digits directly means the
 * conversion is exact for every input a person can write, and inputs finer than one ppm
 * are refused rather than silently rounded into a rate nobody chose.
 */

/** Uniswap's own unit: hundredths of a basis point. 10_000 ppm is 1%. */
export const PPM_PER_PERCENT = 10_000;

/** One whole, in ppm. Used for shares as well as rates. */
export const PPM_ONE = 1_000_000;

/**
 * The highest fee the engine will encode, in ppm. 100_000 is 10%.
 *
 * Matches `ScheduleLib.MAX_FEE_PPM` rather than v4's `MAX_LP_FEE_PPM` of 1_000_000.
 * The engine takes its fee as a swap delta rather than as an LP fee, so v4's ceiling
 * does not bind it and some ceiling has to be chosen deliberately. 10% is the one this
 * repository already defends on chain, it is an order of magnitude above anything a
 * real market has asked for, and a prompt above it is far more likely to be a
 * misunderstanding than an intention.
 *
 * Nothing clamps to this. A configuration above it is `INVALID_FEE`.
 */
export const MAX_FEE_PPM = 100_000;

/** The lowest non-zero fee worth encoding. Zero itself is always allowed. */
export const MIN_NON_ZERO_FEE_PPM = 1;

/**
 * A percentage, exactly, as ppm — or `null` where the text is not a percentage this
 * can represent without rounding.
 *
 * Accepts an optional sign-free decimal: `2`, `0.5`, `1.25`, `0.0001`. Refuses
 * anything with more than four decimal places, because the fifth would be finer than
 * one ppm and rounding it is inventing a rate.
 */
export function percentToPpm(percent: string): number | null {
  const text = percent.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) return null;

  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";

  // Four decimal places of a percent is exactly one ppm: 0.0001% = 1 ppm.
  if (fraction.length > 4) return null;

  const padded = fraction.padEnd(4, "0");
  const ppm = Number(whole) * PPM_PER_PERCENT + Number(padded);

  return Number.isSafeInteger(ppm) ? ppm : null;
}

/**
 * ppm as a percentage string, for a person.
 *
 * The inverse of `percentToPpm` and the only formatter. Trailing zeros are trimmed so
 * 20_000 reads "2%" rather than "2.0000%", but a rate that genuinely needs decimals
 * keeps them: 5_000 is "0.5%", 1 is "0.0001%".
 */
export function ppmToPercent(ppm: number): string {
  const whole = Math.trunc(ppm / PPM_PER_PERCENT);
  const fraction = ppm % PPM_PER_PERCENT;
  if (fraction === 0) return String(whole);

  const digits = String(fraction).padStart(4, "0").replace(/0+$/, "");
  return `${String(whole)}.${digits}`;
}

/** `ppmToPercent` with the sign, which is what a card or a graph label wants. */
export function formatPercent(ppm: number): string {
  return `${ppmToPercent(ppm)}%`;
}

/**
 * A share of a whole, applied to an integer amount, rounding down.
 *
 * Rounding is stated rather than left to the reader: every share rounds **down**, and
 * the remainder left by rounding is dealt with by the caller that owns the whole —
 * `distribute` in `evaluate.ts` gives it to the first recipient in canonical order. The
 * alternative, rounding each share to nearest, can pay out more than was collected,
 * which is the one arithmetic mistake a fee splitter must not be able to make.
 */
export function shareOf(amount: bigint, sharePpm: number): bigint {
  return (amount * BigInt(sharePpm)) / BigInt(PPM_ONE);
}

/**
 * A fee taken out of an amount, rounding down.
 *
 * Down, so the fee is never larger than the rate states. A trader who is charged one
 * wei more than the published rate has been charged a rate that was not published.
 */
export function feeOf(amount: bigint, feePpm: number): bigint {
  return (amount * BigInt(feePpm)) / BigInt(PPM_ONE);
}

/**
 * A percentage of the reference supply, as an absolute token amount, rounding down.
 *
 * The engine's size thresholds are stated as a percentage of supply and stored as token
 * amounts, and this is the one place that conversion happens. Rounding down means "at
 * least 1% of supply" admits the exact 1% trade, which is the boundary every prompt
 * that mentions a percentage is really asking about.
 */
export function supplyPercentToTokens(referenceSupply: bigint, percentPpm: number): bigint {
  return (referenceSupply * BigInt(percentPpm)) / BigInt(PPM_ONE);
}
