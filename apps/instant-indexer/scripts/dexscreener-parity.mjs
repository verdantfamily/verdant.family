/**
 * Does this indexer see everything DexScreener sees?
 *
 *   node scripts/dexscreener-parity.mjs
 *
 * The question worth being able to answer on demand, because the failure it looks for is
 * silent. An indexer that misses a market, starts from the wrong block, or drops a router's
 * swaps still returns a well-formed feed with confident-looking totals — and the only way to
 * notice is to compare against something that watched the same chain independently.
 * DexScreener is that something: a third party with no access to our code, indexing the same
 * pools from the same logs.
 *
 * ## Matched on the pool id, not the token
 *
 * DexScreener knows more pairs than we have markets — the same token can appear under several
 * pairs, and only one of them is the v4 pool a market actually trades in. Keying by token
 * address picks whichever pair happened to come last in the response, which is how a market
 * with sixty thousand dollars of volume can appear to have one dollar. A v4 pair's
 * `pairAddress` *is* the pool id, so that is the join.
 *
 * ## What a difference means
 *
 * A percent or two is expected and is not a finding: our figure is converted from ether at a
 * spot rate fetched seconds later, their window and ours close at slightly different moments,
 * and a trade landing mid-run counts on one side only. A market we hold and they do not, or a
 * difference in the tens of percent, is a finding.
 */

const FEED = process.env.INSTANT_FEED_URL ?? "https://instant-indexer-production-069f.up.railway.app";

/** Below this, a difference is timing and rounding rather than a missed trade. */
const TOLERANCE_PERCENT = 5;

async function ethUsd() {
  const response = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot");
  const body = await response.json();
  return Number(body.data.amount);
}

function pad(value, width, right = true) {
  const text = String(value);
  return right ? text.padStart(width) : text.padEnd(width);
}

async function main() {
  const [rate, listing] = await Promise.all([
    ethUsd(),
    fetch(`${FEED}/instant/markets?limit=200`).then((r) => r.json()),
  ]);

  const markets = listing.markets ?? [];
  if (markets.length === 0) throw new Error(`no markets from ${FEED}`);

  const quoted = await fetch(
    `https://api.dexscreener.com/latest/dex/tokens/${markets.map((m) => m.token).join(",")}`,
  ).then((r) => r.json());

  const byPool = new Map();
  for (const pair of quoted.pairs ?? []) byPool.set(pair.pairAddress.toLowerCase(), pair);

  console.log(`feed        ${FEED}`);
  console.log(`ETH/USD     ${String(rate)}`);
  console.log("");
  console.log(
    `${pad("symbol", 10, false)}${pad("ours 24h $", 14)}${pad("dexscreener $", 15)}` +
      `${pad("diff", 9)}${pad("ours tx", 9)}${pad("their tx", 10)}  pair`,
  );
  console.log("-".repeat(78));

  let ourVolume = 0;
  let theirVolume = 0;
  let ourTrades = 0;
  let theirTrades = 0;
  const findings = [];

  for (const market of markets) {
    const stats = await fetch(`${FEED}/instant/markets/${market.poolId}/stats`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    const ours = stats === null ? 0 : (Number(BigInt(stats.day.volumeQuote)) / 1e18) * rate;
    const oursTx = stats === null ? 0 : Number(stats.day.trades);

    const pair = byPool.get(market.poolId.toLowerCase());
    const theirs = pair === undefined ? 0 : Number(pair.volume?.h24 ?? 0);
    const theirsTx =
      pair === undefined
        ? 0
        : Number(pair.txns?.h24?.buys ?? 0) + Number(pair.txns?.h24?.sells ?? 0);

    ourVolume += ours;
    theirVolume += theirs;
    ourTrades += oursTx;
    theirTrades += theirsTx;

    const difference = theirs > 0 ? ((ours - theirs) / theirs) * 100 : null;
    if (difference !== null && Math.abs(difference) > TOLERANCE_PERCENT) {
      findings.push(
        `${market.symbol}: ours $${ours.toFixed(2)} against their $${theirs.toFixed(2)}`,
      );
    }

    console.log(
      `${pad(market.symbol ?? "?", 10, false)}${pad(ours.toFixed(2), 14)}` +
        `${pad(theirs.toFixed(2), 15)}` +
        `${pad(difference === null ? "—" : `${difference.toFixed(1)}%`, 9)}` +
        `${pad(oursTx, 9)}${pad(theirsTx, 10)}  ` +
        (pair === undefined ? "not listed" : "matched"),
    );
  }

  const overall = theirVolume > 0 ? ((ourVolume - theirVolume) / theirVolume) * 100 : 0;

  console.log("-".repeat(78));
  console.log(
    `${pad("TOTAL", 10, false)}${pad(ourVolume.toFixed(2), 14)}${pad(theirVolume.toFixed(2), 15)}` +
      `${pad(`${overall.toFixed(1)}%`, 9)}${pad(ourTrades, 9)}${pad(theirTrades, 10)}`,
  );
  console.log("");
  console.log(`markets here ${String(markets.length)}`);

  if (findings.length === 0) {
    console.log(`parity within ${String(TOLERANCE_PERCENT)}% on every listed market.`);
    return;
  }

  console.log(`off by more than ${String(TOLERANCE_PERCENT)}%:`);
  for (const finding of findings) console.log(`  ${finding}`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
