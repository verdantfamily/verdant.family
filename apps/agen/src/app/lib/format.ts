/**
 * How numbers are written on the trading surfaces.
 *
 * One module because a launchpad shows the same six quantities on every screen, and a
 * market cap formatted one way on a card and another way on the token page reads as two
 * different numbers to anybody scanning between them.
 *
 * ## The em dash is a value
 *
 * Every formatter here takes `number | null | undefined` and returns `—` for the empty
 * case, rather than the caller deciding. No Agen market is trading yet, so most figures
 * on most screens are genuinely absent — and the difference between "—" and "$0" is the
 * difference between "nobody has measured this" and "this was measured and it is
 * nothing". Only one of those is true today, and it must stay easy to say.
 */

const DASH = "—";

function absent(value: number | null | undefined): value is null | undefined {
  return value === null || value === undefined || !Number.isFinite(value);
}

/**
 * An amount of the quote asset, which on this chain is ether.
 *
 * Not dollars, and the symbol says so. Every market Agen creates is priced in ether and
 * there is no ether price on 4663 this repository is willing to assert, so a market cap
 * is written in the unit it was measured in. `12.4 ETH` is a fact; `$41,203` would be a
 * fact plus somebody's exchange rate, presented as one number.
 *
 * Compact above a thousand, three significant figures below one, because a token that
 * has just launched is priced in the ninth decimal place and `0.00 ETH` is not a price.
 */
export function eth(value: number | null | undefined): string {
  if (absent(value)) return DASH;
  if (value === 0) return "0 ETH";

  if (value >= 1_000) {
    return `${new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value)} ETH`;
  }

  if (value < 0.001) return `${value.toPrecision(3)} ETH`;

  return `${value.toLocaleString("en-US", { maximumFractionDigits: 4 })} ETH`;
}

/**
 * A market capitalisation in dollars: `$14.7k`, `$591.4k`, `$1.92M`.
 *
 * The one figure on this site that is always money, because it is the one figure that
 * exists to be compared — against other tokens and against what somebody is about to
 * spend, neither of which most readers hold an intuition for in ether.
 *
 * A lowercase `k` and an uppercase `M`, which is what a trading interface uses and not
 * what `Intl` produces. More precision above a million than below it: the step between
 * `$1.9M` and `$2.0M` is a hundred thousand dollars, and hiding it to save one character
 * makes the largest markets the least legible.
 *
 * Takes the rate rather than reading one, so a component cannot render a dollar figure
 * without a caller having obtained a rate — and `null` falls back to ether at the call
 * site rather than to a guess here.
 */
export function marketCapUsd(
  ethValue: number | null | undefined,
  usdPerEth: number | null,
): string | null {
  if (absent(ethValue) || usdPerEth === null) return null;

  const value = ethValue * usdPerEth;
  if (value === 0) return "$0";

  // Below a dollar the compact notation has nothing to shorten and rounding flattens
  // every young market to the same string.
  if (value < 1) return `$${value.toPrecision(2)}`;
  if (value < 1_000) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

  const compact = new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: value < 1_000_000 ? 1 : 2,
  }).format(value);

  return `$${compact.replace("K", "k")}`;
}

/** Compact money, as a trader reads it: `$18.4K`, `$1.2M`. */
export function usdCompact(value: number | null | undefined): string {
  if (absent(value)) return DASH;
  if (value === 0) return "$0";

  const formatted = new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: value < 1_000 ? 2 : 1,
  }).format(value);

  return `$${formatted}`;
}

/** Full money, for a headline figure where precision is the point. */
export function usd(value: number | null | undefined): string {
  if (absent(value)) return DASH;

  // Below a cent a launch price is all leading zeros, and rounding it to two places
  // renders every new token as "$0.00". Significant digits keep it a number.
  if (value > 0 && value < 0.01) {
    return `$${value.toPrecision(3)}`;
  }

  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A signed percentage. The sign is carried in the string, the colour by the caller. */
export function percent(value: number | null | undefined): string {
  if (absent(value)) return DASH;
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

/** Whole counts: trades, holders. */
export function count(value: number | null | undefined): string {
  if (absent(value)) return DASH;
  return value.toLocaleString("en-US");
}

/**
 * How long ago, in the shortest form that is still true.
 *
 * `now` is passed in rather than read, so a server-rendered list and the client that
 * hydrates it cannot disagree about the current second and trip a hydration warning.
 */
export function age(unixSeconds: number, now: number = Math.floor(Date.now() / 1000)): string {
  const seconds = Math.max(0, now - unixSeconds);

  if (seconds < 60) return `${String(seconds)}s`;
  if (seconds < 3_600) return `${String(Math.floor(seconds / 60))}m`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3_600))}h`;
  return `${String(Math.floor(seconds / 86_400))}d`;
}

/**
 * How long ago a token launched, as a card says it.
 *
 * Coarser than `age` and phrased rather than abbreviated, because it appears on a shelf of
 * tokens where the question is "is this new?" and not "how old exactly?". Minutes and hours
 * stay lowercase; days and weeks go uppercase, which is the convention every exchange uses
 * to stop `1d` and `1D` from being read as the same span at different precisions.
 *
 * Weeks are the last unit. A market old enough for months is old enough that its exact age
 * has stopped being the interesting thing about it.
 *
 * `now` is passed in rather than read, so a server-rendered shelf and the client that
 * hydrates it cannot disagree about the current second and trip a hydration warning.
 */
export function sinceLaunch(unixSeconds: number, now: number): string {
  const seconds = Math.max(0, now - unixSeconds);

  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${String(Math.floor(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3_600))}h ago`;
  if (seconds < 604_800) return `${String(Math.floor(seconds / 86_400))}D ago`;
  return `${String(Math.floor(seconds / 604_800))}W ago`;
}

/** A token amount, compact above a thousand and precise below it. */
export function tokens(value: number | null | undefined): string {
  if (absent(value)) return DASH;

  return value >= 1_000
    ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value)
    : value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** Hundredths of a basis point, as a percentage. `10_000` ppm is 1%. */
export function feeRate(ppm: number | null | undefined): string {
  if (absent(ppm)) return DASH;
  return `${(ppm / 10_000).toFixed(ppm % 10_000 === 0 ? 0 : 2)}%`;
}

export { DASH };
