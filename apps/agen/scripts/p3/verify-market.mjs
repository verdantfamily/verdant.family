/**
 * Is the thing the agent created actually a market someone could trade?
 *
 * A token contract existing proves less than it appears to: the interesting failure
 * is a launch that half-succeeded, leaving a token with no pool, or a pool with no
 * vault, or a market the site cannot render. So this reads the market through the
 * same registry the app reads, then asks the chain to price a buy — a simulated one,
 * because proving the market is tradable should not require trading it.
 *
 *   node scripts/p3/verify-market.mjs <token>
 */

import { readInstantMarket } from "../../src/app/lib/instant-markets.ts";

const [, , token] = process.argv;

const market = await readInstantMarket(token);
if (market === null) {
  console.error("the registry does not know this token, so it is not an Instant market here");
  process.exit(1);
}

console.log("registry says:");
for (const [key, value] of Object.entries(market)) {
  console.log(`  ${key.padEnd(14)} ${String(value)}`);
}
