/**
 * The dollar price of ether, and the compact form a market cap is read in.
 *
 * Everything this app derives from a pool stays in that pool's own units: the fee, the
 * price and the implied value are all denominated in whatever the market is quoted in, and
 * `@verdant/ui` keeps them in base units so no rounding creeps into money. A dollar figure
 * cannot be derived that way — chain 4663 has no price oracle this app can read — so it is
 * fetched from an exchange, cached briefly, and used for exactly one thing: showing a
 * market cap in the unit people actually think in.
 *
 * Two consequences worth stating rather than hiding. The number is only as good as a
 * third party's spot price, and it is a conversion of an implied value — the pool's price
 * times supply — not what that supply would fetch if it were sold. And when the request
 * fails the caller falls back to the quote asset, which is always correct if less familiar.
 */

const SPOT = "https://api.coinbase.com/v2/prices/ETH-USD/spot";

/** Seconds a quote may be reused. A market cap does not have to be tick-accurate. */
const REVALIDATE_SECONDS = 60;

/** Dollars per ether, or `null` when no price could be had. Never throws. */
export async function fetchUsdPerEth(): Promise<number | null> {
  try {
    const response = await fetch(SPOT, { next: { revalidate: REVALIDATE_SECONDS } });
    if (!response.ok) return null;

    const body: unknown = await response.json();
    const amount =
      typeof body === "object" && body !== null && "data" in body
        ? (body as { data?: { amount?: unknown } }).data?.amount
        : undefined;

    const price = typeof amount === "string" ? Number(amount) : Number.NaN;
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    // A price feed being unreachable is not a reason to fail a page.
    return null;
  }
}

/**
 * A quote-asset amount in base units, in dollars — or `null` when it cannot be known.
 *
 * Only an ether-quoted market can be converted, because ether is the one asset a rate was
 * fetched for. A market quoted in a tokenized equity keeps its own unit rather than being
 * run through a price this app does not have.
 */
export function usdValueOf(
  amount: bigint,
  { decimals, isNative }: { readonly decimals: number; readonly isNative: boolean },
  usdPerEth: number | null,
): number | null {
  if (!isNative || usdPerEth === null) return null;
  return (Number(amount) / 10 ** decimals) * usdPerEth;
}

/**
 * A 36-decimal fixed-point price — quote asset per whole token, as `quotePerToken`
 * returns it — in dollars. `null` when there is no rate to convert through.
 *
 * The bigint is converted through a double here, which it is not anywhere money is
 * computed. It is safe for exactly this: a double carries about sixteen significant
 * digits and this figure is displayed with four.
 */
export function usdPriceOf(
  quotePerToken: bigint,
  { isNative }: { readonly isNative: boolean },
  usdPerEth: number | null,
): number | null {
  if (!isNative || usdPerEth === null) return null;
  return (Number(quotePerToken) / 1e36) * usdPerEth;
}

/**
 * A per-token price in dollars, compact enough never to wrap onto a second line.
 *
 * A launch price is genuinely tiny — a market opening around 2×10⁻⁹ ether per token is a
 * small fraction of a cent — and writing that out in dollars costs a dozen characters of
 * leading zeros. So once the zeros outnumber what is worth reading they collapse into a
 * subscript count, the convention every token screener uses: `$0.0₈4213` is
 * `$0.000000004213`.
 */
export function formatUsdPrice(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value === 0) return "$0";
  if (value >= 1_000) return formatUsd(value);
  if (value >= 1) return `$${value.toFixed(2)}`;

  // Four significant digits, and the exponent says how many zeros precede them.
  const [mantissa = "", exponent = "0"] = value.toExponential(3).split("e");
  const zeros = -Number(exponent) - 1;
  const digits = mantissa.replace(".", "").replace(/0+$/, "") || "0";

  // Few enough zeros to write plainly; a subscript would cost more than it saves.
  if (zeros < 4) return `$0.${"0".repeat(zeros)}${digits}`;

  return `$0.0${subscriptOf(zeros)}${digits}`;
}

/** A count as subscript digits, so `8` reads as `₈`. */
function subscriptOf(count: number): string {
  return String(count)
    .split("")
    .map((digit) => "₀₁₂₃₄₅₆₇₈₉"[Number(digit)] ?? digit)
    .join("");
}

/** `$16K`, `$4.2M`, `$940`, `$0.42` — the compact form a market cap is read in. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  // Spelled out rather than falling through to four decimal places, which would render a
  // market with no trades as "$0.0000" and read as a rounding artefact instead of a zero.
  if (value === 0) return "$0";
  if (value >= 1_000_000_000) return `$${compact(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `$${compact(value / 1_000_000)}M`;
  if (value >= 1_000) return `$${compact(value / 1_000)}K`;
  if (value >= 100) return `$${value.toFixed(0)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

/** One decimal, dropped when it would only ever be a zero: `4.2`, `16`, `234`. */
function compact(value: number): string {
  const text = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/**
 * A dollar figure carrying a given number of significant digits, compactly.
 *
 * For a chart axis, where `formatUsd` is actively wrong. That function rounds to about two
 * significant digits, which is right for a stat in a strip and useless for a column of
 * gridlines: a market moving between $3 870 and $3 910 has every line on its axis labelled
 * "$3.9K", so the axis says the same thing four times and none of them locate the line.
 *
 * How many digits it takes to tell one line from the next depends on how narrow the range
 * is, which is a question only the caller can answer — `axisScaleFor` answers it — so the
 * count is a parameter. Trailing zeros come off afterwards, so a wide range still reads
 * "$400K" rather than "$400.0K".
 */
export function formatUsdSignificant(value: number, significant: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value === 0) return "$0";

  const digits = Math.min(Math.max(Math.round(significant), 2), 12);
  const rounded = Number(value.toPrecision(digits));

  const [divisor, suffix] =
    rounded >= 1_000_000_000
      ? [1_000_000_000, "B"]
      : rounded >= 1_000_000
        ? [1_000_000, "M"]
        : rounded >= 1_000
          ? [1_000, "K"]
          : [1, ""];

  const scaled = rounded / divisor;
  // Significance is a property of the number, not of the units it is written in, so the
  // decimals are whatever is left after the digits in front of the point.
  const before = Math.floor(Math.log10(Math.abs(scaled))) + 1;
  const decimals = Math.min(Math.max(digits - before, 0), 6);

  const text = scaled.toFixed(decimals);
  return `$${decimals === 0 ? text : text.replace(/\.?0+$/, "")}${suffix}`;
}

/**
 * `$328.99K` — the same magnitudes as `formatUsd`, with the digits kept.
 *
 * For the one figure on a page that is set large enough to be read rather than scanned.
 * `formatUsd` rounds to about two significant digits, which is right for a stat in a strip
 * of four and wrong for a headline: at that size "$329K" sitting above a chart whose line
 * visibly moved is a number that appears not to have noticed. Two decimals is enough that
 * a single trade changes a digit somebody can see.
 */
export function formatUsdPrecise(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value === 0) return "$0";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  // Below a dollar this is a market cap of pennies; the compact form's four decimals say
  // more than two zeros would.
  return formatUsd(value);
}
