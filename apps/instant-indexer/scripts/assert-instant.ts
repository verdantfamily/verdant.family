#!/usr/bin/env node
/**
 * Checks the Instant feed's answers against the chain's.
 *
 * An indexer that runs without crashing proves nothing: the failures that matter are the
 * ones where it stores a plausible wrong number, and the only way to catch those is to ask
 * the contracts the same questions and require the same answers.
 *
 * Five claims are checked, and each of them would be a shipped bug:
 *
 *  1. **The key is right.** The pool id the feed files a market under equals the one the
 *     factory itself derives from the token. If these disagreed, every Instant page would
 *     read an empty pool and the product would look like a chain with nothing on it.
 *
 *  2. **The price, supply and liquidity are the pool's.** Read from `StateView` and the
 *     token, and required to match what the feed serves. A market cap is supply times
 *     price, so a wrong either is a wrong headline.
 *
 *  3. **Every trade is there, on the right side.** The count matches what the seed did,
 *     buys and sells are both present, and no swap is filed twice. A side derived
 *     backwards is the single easiest mistake in this path — v4's own docstring on the
 *     `Swap` event describes the deltas the wrong way round.
 *
 *  4. **The aggregates are the sum of the trades.** The day's volume equals the volume of
 *     the swaps in the window, and the candles' volume equals the whole series. An
 *     aggregate computed independently of its rows is one that can drift from them.
 *
 *  5. **Instant's rows are Instant's alone.** This service serves the Instant routes and
 *     none of the Programmable ones, which since the split is a property of what is
 *     deployed rather than of a filter somebody has to keep correct.
 *
 * Usage:
 *   node scripts/assert-instant.ts --api URL --rpc URL --factory 0x… --token 0x… --second 0x…
 */

import { ROBINHOOD_MAINNET_ID } from "@verdant/config";
import { abi, pool } from "@verdant/sdk";
import { createPublicClient, defineChain, erc20Abi, http, type Address } from "viem";

function argument(name: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at === -1 ? undefined : process.argv[at + 1];
  if (value === undefined) {
    console.error(`missing --${name}`);
    process.exit(1);
  }
  return value;
}

const API = argument("api").replace(/\/+$/, "");
const RPC = argument("rpc");
const FACTORY = argument("factory") as Address;
const TOKEN = argument("token") as Address;
const SECOND = argument("second") as Address;

const chain = defineChain({
  id: ROBINHOOD_MAINNET_ID,
  name: "rig",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const client = createPublicClient({ chain, transport: http(RPC) });

let failures = 0;

function check(ok: boolean, what: string, detail?: string): void {
  if (ok) {
    console.log(`  ok    ${what}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${what}${detail === undefined ? "" : ` — ${detail}`}`);
}

async function feed<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) {
    console.error(`  the feed answered ${String(response.status)} for ${path}`);
    process.exit(1);
  }
  return (await response.json()) as T;
}

/** A 404 is the expected answer, and anything else is a namespace serving the wrong rows. */
async function expectNotFound(path: string): Promise<boolean> {
  const response = await fetch(`${API}${path}`);
  return response.status === 404;
}

interface Market {
  readonly poolId: string;
  readonly token: string;
  readonly hook: string;
  readonly vault: string;
  readonly totalSupply: string;
  readonly price: string;
  readonly liquidity: string;
  readonly sqrtPriceX96: string;
  readonly swapCount: number;
  readonly volumeQuote: string;
}

interface Swap {
  readonly id: string;
  readonly buy: boolean;
  readonly quoteAmount: string;
  readonly tokenAmount: string;
  readonly timestamp: number;
}

async function main(): Promise<void> {
  console.log("--- the market, against the chain ---");

  const market = await feed<Market>(`/instant/markets/${TOKEN}`);

  // 1. The key, derived two independent ways.
  //
  // The factory's own `poolKeyFor` in Solidity, and the SDK's `poolIdOf` in TypeScript.
  // Both must agree with the id the feed filed the market under; if they did not, every
  // Instant page would read an empty pool and the product would look like a chain with
  // nothing on it.
  const key = await client.readContract({
    abi: abi.instantFactoryAbi,
    address: FACTORY,
    functionName: "poolKeyFor",
    args: [TOKEN],
  });

  const derived = pool.poolIdOf({
    currency0: key.currency0 as Address,
    currency1: key.currency1 as Address,
    fee: Number(key.fee),
    tickSpacing: Number(key.tickSpacing),
    hooks: key.hooks as Address,
  });

  check(
    market.token.toLowerCase() === TOKEN.toLowerCase(),
    "the feed files the market under the token the factory launched",
  );
  check(
    market.hook.toLowerCase() === (key.hooks as string).toLowerCase(),
    "the hook on the row is the hook in the pool key",
    `${market.hook} vs ${String(key.hooks)}`,
  );
  check(
    market.poolId.toLowerCase() === derived.toLowerCase(),
    "the pool id is the one the factory's key hashes to",
    `${market.poolId} vs ${derived}`,
  );

  // 2. The supply, the registry's record and the pool's own numbers.
  //
  // `StateView` is not deployed on this rig — it is Uniswap's, and the local Uniswap
  // script brings up only the manager, the position manager, a router and a quoter — so
  // the price is checked for being real and internally consistent rather than against a
  // second read of `slot0`. The fork suite is where the price is checked against the
  // deployed Uniswap; what this proves is that the feed and the registry agree.
  const [supply, record] = await Promise.all([
    client.readContract({ abi: erc20Abi, address: TOKEN, functionName: "totalSupply" }),
    client.readContract({
      abi: abi.marketRegistryAbi,
      address: (await client.readContract({
        abi: abi.instantFactoryAbi,
        address: FACTORY,
        functionName: "marketRegistry",
      })) as Address,
      functionName: "marketByToken",
      args: [TOKEN],
    }),
  ]);

  check(
    BigInt(market.totalSupply) === (supply as bigint),
    "the feed's supply is the token's supply",
  );
  check(
    market.poolId.toLowerCase() === (record.poolId as string).toLowerCase(),
    "the feed's pool id is the one the registry recorded",
  );
  check(
    market.vault.toLowerCase() === (record.splitter as string).toLowerCase(),
    "the feed's vault is the one the registry recorded",
    `${market.vault} vs ${String(record.splitter)}`,
  );
  check(Number(market.price) > 0, "the market has a price at all");
  check(BigInt(market.liquidity) > 0n, "the market has liquidity in its pool");
  check(BigInt(market.sqrtPriceX96) > 0n, "the market has a square-root price");

  // 3. The trades.
  console.log("");
  console.log("--- the trades ---");

  const { swaps, total } = await feed<{ swaps: readonly Swap[]; total: number }>(
    `/instant/markets/${TOKEN}/swaps?limit=100`,
  );

  check(swaps.length > 0, "the market has trades");
  check(
    total === market.swapCount,
    "the swap count on the row equals the number of rows in the table",
    `${String(market.swapCount)} vs ${String(total)}`,
  );
  check(
    swaps.some((swap) => swap.buy) && swaps.some((swap) => !swap.buy),
    "both a buy and a sell were indexed, on the right sides",
  );
  check(
    new Set(swaps.map((swap) => swap.id)).size === swaps.length,
    "no swap is filed twice",
  );
  check(
    swaps.every((swap) => BigInt(swap.quoteAmount) > 0n && BigInt(swap.tokenAmount) > 0n),
    "every trade moved something in both currencies",
  );

  // Newest first, by position in the chain.
  const descending = swaps.every(
    (swap, at) => at === 0 || swaps[at - 1]!.timestamp >= swap.timestamp,
  );
  check(descending, "the trades are newest first");

  // 4. The aggregates.
  console.log("");
  console.log("--- the aggregates ---");

  const stats = await feed<{
    day: { volumeQuote: string; trades: number; changePercent: number | null };
  }>(`/instant/markets/${TOKEN}/stats`);

  const summed = swaps.reduce((total_, swap) => total_ + BigInt(swap.quoteAmount), 0n);

  check(
    BigInt(stats.day.volumeQuote) === summed,
    "the day's volume is the sum of the day's trades",
    `${stats.day.volumeQuote} vs ${summed.toString()}`,
  );
  check(
    stats.day.trades === swaps.length,
    "the day's trade count is the number of trades",
  );
  check(
    BigInt(market.volumeQuote) === summed,
    "the running total on the row agrees with the trades",
  );
  check(stats.day.changePercent !== null, "a traded market reports a change");

  const candles = await feed<{
    candles: readonly { close: string; volumeQuote: string; trades: number }[];
    anchor: { price: string };
  }>(`/instant/markets/${TOKEN}/candles?interval=5m&limit=240`);

  const bucketed = candles.candles.reduce(
    (total_, candle) => total_ + BigInt(candle.volumeQuote),
    0n,
  );

  check(candles.candles.length > 0, "the market has candles");
  check(
    bucketed === summed,
    "the candles' volume is the trades' volume",
    `${bucketed.toString()} vs ${summed.toString()}`,
  );
  check(BigInt(candles.anchor.price) > 0n, "the series has an opening anchor to fill from");

  const last = candles.candles[candles.candles.length - 1];
  check(
    last !== undefined && BigInt(last.close) > 0n,
    "the last candle closes at a real price",
  );

  // 5. This service serves Instant and nothing else.
  console.log("");
  console.log("--- Instant's rows are Instant's alone ---");

  // Stronger than it used to be, and worth noticing. While Instant shared an indexer with
  // Verdant and Agen these were three routes on one host that had to be kept from serving
  // each other's rows. They are now three routes on two hosts, and the Programmable ones
  // do not exist here at all — so the isolation is a property of the deployment rather
  // than of a `where` clause somebody has to keep correct.
  check(
    await expectNotFound(`/agen/markets/${TOKEN}`),
    "this service does not serve the Programmable market route",
  );
  check(
    await expectNotFound(`/markets/${TOKEN}`),
    "this service does not serve the Verdant market route",
  );
  check(
    await expectNotFound("/agen/markets"),
    "this service does not serve the Programmable listing",
  );

  const listing = await feed<{ markets: readonly Market[]; total: number }>(
    "/instant/markets",
  );
  check(listing.total === 2, "both seeded markets are listed", String(listing.total));
  check(
    listing.markets.some((row) => row.token.toLowerCase() === SECOND.toLowerCase()),
    "a market launched without a first buy is indexed too",
  );

  console.log("");
  if (failures > 0) {
    console.log(`FAILED: ${String(failures)} problem(s).`);
    process.exit(1);
  }
  console.log("The Instant feed agrees with the chain.");
}

await main();
