/**
 * `/instant/metrics`, computed from live data, for looking at the page before deploying.
 *
 * The app and the indexer deploy separately, so a build of the site is routinely newer than
 * the feed answering it — which is the case for the whole window between adding this route to
 * the indexer and shipping it. This serves the route so the page can be seen in the meantime:
 *
 *   node scripts/metrics-preview.mjs 4599
 *   AGEN_INSTANT_FEED_URL=http://127.0.0.1:4599 pnpm start
 *
 * ## It reads real data, and that is the whole point of it
 *
 * The first version of this served hand-written figures, and they were mistaken for the
 * platform's real numbers — reasonably, since nothing on the rendered page says where a
 * number came from. A preview that invents its data is a screenshot generator that looks
 * like a staging environment. So every figure here is fetched:
 *
 *   - volume, trades and launches from the deployed indexer's `/instant/markets` and
 *     `/instant/markets/:id/stats`, which are already live;
 *   - fees read straight off each market's `InstantFeeVault` over RPC, since the columns
 *     that will carry them are not deployed yet.
 *
 * That last part earns its cost twice. `creatorAccrued` and `platformAccrued` are the same
 * quantities the new `Accrued` handler accumulates, arrived at by a completely different
 * route — contract state rather than summed events — so agreement between this and the
 * indexer after it deploys is a real check on the handler, not a restatement of it.
 */

import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 4599);
const FEED = process.env.INSTANT_FEED_URL ?? "https://instant-indexer-production-069f.up.railway.app";
const RPC = process.env.VERDANT_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const DAY = 86_400;

/**
 * `creatorAccrued()` and `platformAccrued()`, as four-byte selectors.
 *
 * Literal so this script has no dependency to install and can be run against production from a
 * bare checkout. Checkable with `cast sig 'creatorAccrued()'`.
 */
const CREATOR_ACCRUED = "0x1d35d994";
const PLATFORM_ACCRUED = "0xb57f4d9c";

async function readUint(address, selector) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: address, data: selector }, "latest"],
    }),
  });

  const body = await response.json();
  if (typeof body.result !== "string" || body.result === "0x") return 0n;
  return BigInt(body.result);
}

async function collect() {
  const listing = await fetch(`${FEED}/instant/markets?limit=200`).then((r) => r.json());
  const markets = listing.markets ?? [];

  const at = Math.floor(Date.now() / 1000);
  let volume = 0n;
  let trades = 0;
  let boostVolume = 0n;
  let boostSpent = 0n;
  let boostSunk = 0n;
  let boostCount = 0;
  let boostEnabled = 0;
  let creatorFees = 0n;
  let platformFees = 0n;
  let dayVolume = 0n;
  let dayBoostVolume = 0n;
  let dayTrades = 0;
  let lastLaunchAt = null;

  for (const market of markets) {
    volume += BigInt(market.volumeQuote ?? 0);
    trades += Number(market.swapCount ?? 0);
    boostVolume += BigInt(market.boostVolumeQuote ?? 0);
    boostSpent += BigInt(market.boostSpentQuote ?? 0);
    boostSunk += BigInt(market.boostSunkToken ?? 0);
    boostCount += Number(market.boostCount ?? 0);
    if (market.boostEnabled === true) boostEnabled += 1;
    if (lastLaunchAt === null || market.createdAt > lastLaunchAt) lastLaunchAt = market.createdAt;

    // Fees from contract state, because the columns carrying them are not deployed yet.
    if (typeof market.vault === "string") {
      const [creator, platform] = await Promise.all([
        readUint(market.vault, CREATOR_ACCRUED),
        readUint(market.vault, PLATFORM_ACCRUED),
      ]);
      creatorFees += creator;
      platformFees += platform;
    }

    const stats = await fetch(`${FEED}/instant/markets/${market.poolId}/stats`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    if (stats !== null) {
      dayVolume += BigInt(stats.day.volumeQuote ?? 0);
      dayBoostVolume += BigInt(stats.day.boostVolumeQuote ?? 0);
      dayTrades += Number(stats.day.trades ?? 0);
    }
  }

  const creators = new Set(markets.map((market) => market.creator)).size;
  const notBelowZero = (total, part) => (total > part ? total - part : 0n);

  return {
    at,
    markets: markets.length,
    creators,
    trades,
    volume: {
      quote: volume.toString(),
      token: "0",
      boostQuote: boostVolume.toString(),
      boostToken: "0",
      organicQuote: notBelowZero(volume, boostVolume).toString(),
      organicToken: "0",
    },
    fees: {
      etherLeg: volume.toString(),
      creator: creatorFees.toString(),
      platform: platformFees.toString(),
      total: (creatorFees + platformFees).toString(),
    },
    boost: {
      marketsEnabled: boostEnabled,
      spentQuote: boostSpent.toString(),
      sunkToken: boostSunk.toString(),
      buybacks: boostCount,
    },
    day: {
      since: at - DAY,
      volumeQuote: dayVolume.toString(),
      boostVolumeQuote: dayBoostVolume.toString(),
      organicVolumeQuote: notBelowZero(dayVolume, dayBoostVolume).toString(),
      trades: dayTrades,
      boostBuybacks: 0,
    },
    lastLaunchAt,
  };
}

/**
 * The last answer, and when it was computed.
 *
 * Collecting takes a couple of dozen sequential requests, which is well past the four-second
 * timeout the app gives a feed — so an uncached preview times out on every render and the page
 * shows its no-feed state, which is the one thing this script exists to avoid looking at. The
 * deployed route it stands in for answers from one SQL query and needs none of this.
 */
let cached = null;
const CACHE_MS = 30_000;

async function answer() {
  if (cached !== null && Date.now() - cached.at < CACHE_MS) return cached.metrics;

  const metrics = await collect();
  cached = { at: Date.now(), metrics };
  return metrics;
}

createServer((request, response) => {
  const path = (request.url ?? "").split("?")[0];

  if (path !== "/instant/metrics") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not this preview's route" }));
    return;
  }

  answer().then(
    (metrics) => {
      console.log(
        `[preview] ${String(metrics.markets)} markets, ` +
          `${(Number(metrics.volume.quote) / 1e18).toFixed(3)} ETH volume, ` +
          `${(Number(metrics.fees.total) / 1e18).toFixed(4)} ETH fees`,
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(metrics));
    },
    (error) => {
      console.error("[preview] failed:", error.message);
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error.message) }));
    },
  );
}).listen(port, "127.0.0.1", () => {
  console.log(`[preview] /instant/metrics on http://127.0.0.1:${String(port)}, from ${FEED}`);
});
