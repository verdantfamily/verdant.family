import "server-only";

/**
 * What an ether is worth in dollars.
 *
 * ## Why this exists, having been argued against
 *
 * Every market Agen creates is quoted in ether, and this repository used to write every
 * figure in ether for a stated reason: there is no oracle on 4663 worth trusting, and a
 * dollar number is a fact plus somebody's exchange rate presented as one number.
 *
 * That reasoning is sound about *provenance* and wrong about *readers*. A market cap
 * exists to be compared — against other tokens, against what somebody is about to spend,
 * against a sense of whether this is a small thing or a large one — and almost nobody
 * holds that intuition in ether. "7.7 ETH" is precise and tells most people nothing;
 * "$14.7k" is approximate and tells them what they came to find out.
 *
 * So the rate is fetched rather than asserted, and the honesty is kept in a different
 * place: this returns `null` when it cannot get a number it believes, and every caller
 * falls back to the ether figure rather than to a stale or invented one. A dollar sign on
 * this site always means a rate was actually obtained within the last few minutes.
 *
 * ## Two sources, in order
 *
 * Coinbase first, CoinGecko second. Not for redundancy theatre — a single free endpoint
 * that rate-limits is a single endpoint that will eventually rate-limit, and the failure
 * mode is every market cap on the site silently reverting to ether at the same moment.
 * The second source makes that a much rarer event, and costs one request only when the
 * first has already failed.
 */

/** How long a rate is trusted. Long enough to be cheap, short enough to be current. */
const TTL_MS = 120_000;

/**
 * Bounds, because a malformed answer is more likely than a real move through them.
 *
 * A source returning `0`, a string, or a number in the wrong units is the case this
 * guards. The band is deliberately wide — it is a sanity check on the shape of the
 * answer, not a view about the price.
 */
const LOWEST = 10;
const HIGHEST = 100_000;

interface Cached {
  readonly at: number;
  readonly usd: number | null;
}

/**
 * Module scope, so one process makes one request every two minutes rather than one per
 * rendered card. A cached failure is cached too, and for the same duration: a source
 * that is down stays down for longer than a page render, and hammering it on every
 * request would turn a missing dollar sign into an outage of our own making.
 */
let cache: Cached | null = null;

/** A request in flight, so a burst of renders shares one rather than starting twenty. */
let inFlight: Promise<number | null> | null = null;

function believable(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > LOWEST && value < HIGHEST;
}

async function fromCoinbase(): Promise<number | null> {
  const response = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", {
    signal: AbortSignal.timeout(3_000),
    cache: "no-store",
  });
  if (!response.ok) return null;

  const body = (await response.json()) as { data?: { amount?: string } };
  const parsed = Number(body.data?.amount);
  return believable(parsed) ? parsed : null;
}

async function fromCoinGecko(): Promise<number | null> {
  const response = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    { signal: AbortSignal.timeout(3_000), cache: "no-store" },
  );
  if (!response.ok) return null;

  const body = (await response.json()) as { ethereum?: { usd?: number } };
  const parsed = body.ethereum?.usd;
  return believable(parsed) ? parsed : null;
}

async function ask(): Promise<number | null> {
  for (const source of [fromCoinbase, fromCoinGecko]) {
    try {
      const found = await source();
      if (found !== null) return found;
    } catch {
      // Try the next one. A source being unreachable is not an error this page reports;
      // it is the reason the page shows ether instead.
    }
  }
  return null;
}

/**
 * The current rate, or `null`.
 *
 * Never throws. A page that could not price a market in dollars still has a market to
 * render, so the failure is a value the formatters already know how to handle.
 *
 * `AGEN_ETH_USD` overrides everything, for a fork or a test where reaching out to the
 * internet from a render is the wrong behaviour.
 */
export async function ethUsd(): Promise<number | null> {
  const override = Number(process.env["AGEN_ETH_USD"]);
  if (believable(override)) return override;

  const now = Date.now();
  if (cache !== null && now - cache.at < TTL_MS) return cache.usd;

  inFlight ??= ask()
    .then((usd) => {
      cache = { at: Date.now(), usd };
      return usd;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
